import { describe, expect, it } from 'vitest';
import { AUDIENCE, ISSUER, makeFixture, type Fixture } from './__fixtures__/platform';
import { PlatformClient, PlatformClientError } from './platform-client';
import { REVISION_HEADER } from './version';

function client(f: Fixture, over: Partial<ConstructorParameters<typeof PlatformClient>[0]> = {}) {
  return new PlatformClient({
    baseUrl: ISSUER,
    appId: 'app_1',
    privateKey: f.appKey.privateJwk,
    alg: f.appAlg,
    kid: 'app-key-1',
    fetch: f.fetch,
    now: f.clock.ms,
    sleep: async () => {},
    ...over,
  });
}

describe('PlatformClient', () => {
  it('calls every app route against the Hono server', async () => {
    const f = await makeFixture();
    const c = client(f);
    expect((await c.discovery()).issuer).toBe(ISSUER);
    expect((await c.jwks()).keys).toHaveLength(1);
    expect((await c.getApp()).id).toBe('app_1');
    expect((await c.listInstallations({ per_page: 1 })).next_cursor).toBe('1');
    expect((await c.getInstallation('inst_1')).id).toBe('inst_1');
    expect((await c.setSuspended('inst_1', true, 'maintenance')).status).toBe('suspended');
    expect((await c.setSuspended('inst_1', false)).status).toBe('active');
    expect((await c.listDeliveries()).deliveries).toHaveLength(1);
    expect(await c.redeliver('d1')).toEqual({ delivery_id: 'd1', status: 'queued' });
  });

  it('caches installation tokens until 5 min before expiry', async () => {
    const f = await makeFixture();
    const c = client(f);
    const a = await c.installationToken('inst_1', { audience: AUDIENCE });
    expect(await c.installationToken('inst_1', { audience: AUDIENCE })).toBe(a);
    expect(f.store.issued).toHaveLength(1);
    f.clock.advance(3600 - 299);
    const b = await c.installationToken('inst_1', { audience: AUDIENCE });
    expect(b).not.toBe(a);
    expect(f.store.issued).toHaveLength(2);
  });

  it('re-signs the app JWT before it expires', async () => {
    const f = await makeFixture();
    const c = client(f);
    const j1 = await c.appJwt();
    expect(await c.appJwt()).toBe(j1);
    f.clock.advance(500);
    expect(await c.appJwt()).not.toBe(j1);
    expect((await c.getApp()).id).toBe('app_1');
  });

  it('asInstallation sends Bearer + revision, lists projects and revokes', async () => {
    const f = await makeFixture();
    const c = client(f);
    const inst = c.asInstallation('inst_1', { audience: AUDIENCE, project_ids: ['p1'] });
    expect((await inst.listProjects()).projects.map((p) => p.id)).toEqual(['p1']);
    const raw = await inst('/installation/projects');
    expect(raw.headers.get(REVISION_HEADER)).toBeTruthy();
    await inst.revoke();
    expect(f.store.revoked.size).toBe(1);
    expect((await inst.listProjects()).total_count).toBe(1);
    expect(f.store.issued).toHaveLength(2);
  });

  it('surfaces error envelopes as PlatformClientError', async () => {
    const f = await makeFixture();
    const c = client(f);
    const e = await c
      .createInstallationToken('inst_1', { permissions: { invoices: 'admin' } })
      .catch((x: unknown) => x);
    expect(e).toBeInstanceOf(PlatformClientError);
    expect((e as PlatformClientError).status).toBe(422);
    expect((e as PlatformClientError).code).toBe('permissions_exceeded');
    const wrongKey = client(f, { appId: 'app_2' });
    await expect(wrongKey.getApp()).rejects.toMatchObject({ status: 401 });
  });

  it('retries 429/5xx with backoff up to maxRetries', async () => {
    const f = await makeFixture();
    const sleeps: number[] = [];
    let calls = 0;
    const flaky: typeof fetch = async (input, init) => {
      calls++;
      if (calls === 1) return new Response('{}', { status: 429, headers: { 'retry-after': '2' } });
      if (calls === 2) return new Response('{}', { status: 503 });
      if (calls === 3) throw new TypeError('network down');
      return f.fetch(input, init);
    };
    const c = client(f, { fetch: flaky, sleep: async (ms) => void sleeps.push(ms) });
    expect((await c.getApp()).id).toBe('app_1');
    expect(calls).toBe(4);
    expect(sleeps).toEqual([2000, 500, 1000]);

    let n = 0;
    const always500: typeof fetch = async () => (
      n++,
      new Response('{"error":{"code":"internal","message":"x"}}', { status: 500 })
    );
    await expect(client(f, { fetch: always500 }).getApp()).rejects.toMatchObject({
      status: 500,
      code: 'internal',
    });
    expect(n).toBe(4);
    const down: typeof fetch = async () => {
      throw new TypeError('offline');
    };
    await expect(client(f, { fetch: down, maxRetries: 1 }).getApp()).rejects.toThrow('offline');
  });

  it('does not retry 4xx and tolerates non-JSON error bodies', async () => {
    const f = await makeFixture();
    let calls = 0;
    const html: typeof fetch = async () => (calls++, new Response('<html>', { status: 404 }));
    const e = (await client(f, { fetch: html })
      .getApp()
      .catch((x: unknown) => x)) as PlatformClientError;
    expect(e.status).toBe(404);
    expect(e.code).toBeUndefined();
    expect(calls).toBe(1);
  });
});
