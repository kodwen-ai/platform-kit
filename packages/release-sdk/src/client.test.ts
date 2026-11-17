import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { DEFAULT_REVISION, type FetchLike, ReleaseApiError, ReleaseClient } from './client';
import { CreateReleaseInputSchema, ReleaseSchema, RolloutActionSchema } from './schemas';

const BASE = 'https://api.codai.ro/v1/releases';
const SHA = 'a'.repeat(64);
const release = {
  id: 'rel_1',
  app_id: 'app_1',
  version: '3.5.1',
  version_code: 14,
  channel: 'production',
  status: 'rolling_out',
  rollout_percent: 10,
  notes_i18n: { 'en-US': 'Fixes', ro: 'Reparații' },
  build: { artifact_sha256: SHA, sbom_url: 'https://cdn.codai.ro/sbom.json' },
  created_at: '2026-10-19T08:00:00Z',
};

interface Call {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: unknown;
}

function fake(responses: (Response | Error)[]): { fetch: FetchLike; calls: Call[] } {
  const calls: Call[] = [];
  const queue = [...responses];
  return {
    calls,
    fetch: async (url, init) => {
      const headers = (init?.headers ?? {}) as Record<string, string>;
      calls.push({
        method: init?.method ?? 'GET',
        url,
        headers,
        body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
      });
      const next = queue.shift();
      if (!next) throw new Error('unexpected request');
      if (next instanceof Error) throw next;
      return next;
    },
  };
}

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });

function client(
  responses: (Response | Error)[],
  extra: Partial<ConstructorParameters<typeof ReleaseClient>[0]> = {},
) {
  const f = fake(responses);
  const sleeps: number[] = [];
  const c = new ReleaseClient({
    token: 'tok',
    fetch: f.fetch,
    sleep: async (ms) => void sleeps.push(ms),
    ...extra,
  });
  return { c, f, sleeps };
}

describe('ReleaseClient', () => {
  it('sends bearer + Codai-Platform-Version and parses a page of products', async () => {
    const { c, f } = client([
      json({ data: [{ id: 'p1', slug: 'codai', name: 'codai' }], next_cursor: 'n2' }),
    ]);
    const page = await c.listProducts({ limit: 20 });
    expect(page).toEqual({ data: [{ id: 'p1', slug: 'codai', name: 'codai' }], next_cursor: 'n2' });
    expect(f.calls[0]).toMatchObject({ method: 'GET', url: `${BASE}/products?limit=20` });
    expect(f.calls[0]?.headers).toMatchObject({
      authorization: 'Bearer tok',
      'codai-platform-version': DEFAULT_REVISION,
    });
  });

  it('covers every route with the right method, path and body', async () => {
    const app = {
      id: 'app_1',
      product_id: 'p1',
      store: 'google_play',
      identifier: 'ro.codai.phone',
      store_connection_id: 'sc_1',
    };
    const { c, f } = client([
      json({ id: 'p2', slug: 'brivio', name: 'Brivio' }),
      json({ data: [app] }),
      json({ data: [release], next_cursor: null }),
      json(release),
      json(release),
      json({ ...release, rollout_percent: 25 }),
      json({ ...release, status: 'halted' }),
      json(release),
      json({ ...release, status: 'completed', rollout_percent: 100 }),
    ]);
    await c.createProduct({ slug: 'brivio', name: 'Brivio' });
    const apps = await c.listApps({ productId: 'p1' });
    expect(apps.next_cursor).toBeNull();
    await c.listReleases('app_1', { cursor: 'c1' });
    await c.getRelease('rel/1');
    await c.createRelease(
      {
        app_id: 'app_1',
        version: '3.5.1',
        version_code: 14,
        channel: 'production',
        build: { artifact_sha256: SHA },
      },
      { idempotencyKey: 'k-1' },
    );
    await c.rollout('rel_1', { action: 'set', percent: 25 });
    await c.halt('rel_1');
    await c.resume('rel_1', 50);
    const done = await c.complete('rel_1');
    expect(done.status).toBe('completed');
    expect(f.calls.map((x) => `${x.method} ${x.url}`)).toEqual([
      `POST ${BASE}/products`,
      `GET ${BASE}/apps?product_id=p1`,
      `GET ${BASE}/apps/app_1/releases?cursor=c1`,
      `GET ${BASE}/releases/rel%2F1`,
      `POST ${BASE}/releases`,
      `POST ${BASE}/releases/rel_1/rollout`,
      `POST ${BASE}/releases/rel_1/rollout`,
      `POST ${BASE}/releases/rel_1/rollout`,
      `POST ${BASE}/releases/rel_1/rollout`,
    ]);
    expect(f.calls[4]?.body).toEqual({
      app_id: 'app_1',
      version: '3.5.1',
      version_code: 14,
      channel: 'production',
      notes_i18n: {},
      build: { artifact_sha256: SHA },
    });
    expect(f.calls[4]?.headers['idempotency-key']).toBe('k-1');
    expect(f.calls.slice(5).map((x) => x.body)).toEqual([
      { action: 'set', percent: 25 },
      { action: 'halt' },
      { action: 'resume', percent: 50 },
      { action: 'complete' },
    ]);
    expect(f.calls[0]?.headers['idempotency-key']).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('retries 429/5xx with backoff (Retry-After honoured) and keeps the idempotency key', async () => {
    const { c, f, sleeps } = client([
      json({}, 503),
      json({}, 429, { 'retry-after': '2' }),
      json(release),
    ]);
    await c.halt('rel_1');
    expect(f.calls).toHaveLength(3);
    expect(sleeps).toEqual([250, 2000]);
    const keys = new Set(f.calls.map((x) => x.headers['idempotency-key']));
    expect(keys.size).toBe(1);
  });

  it('gives up after 3 retries and surfaces the API error code', async () => {
    const err = {
      error: { code: 'upstream_unavailable', message: 'Play down', request_id: 'req_9' },
    };
    const { c, f } = client([json(err, 502), json(err, 502), json(err, 502), json(err, 502)]);
    const e = await c.getRelease('rel_1').catch((x: unknown) => x);
    expect(e).toBeInstanceOf(ReleaseApiError);
    expect(e).toMatchObject({ code: 'upstream_unavailable', status: 502, requestId: 'req_9' });
    expect(f.calls).toHaveLength(4);
  });

  it('does not retry 4xx and maps non-JSON / contract-breaking responses', async () => {
    const { c, f } = client([
      json({ error: { code: 'invalid_state', message: 'not rolling out' } }, 409),
      new Response('<html>bad gateway</html>', { status: 404 }),
      json({ ...release, status: 'teleporting' }),
    ]);
    await expect(c.halt('rel_1')).rejects.toMatchObject({ code: 'invalid_state', status: 409 });
    await expect(c.getRelease('x')).rejects.toMatchObject({ code: 'http_error', status: 404 });
    await expect(c.getRelease('y')).rejects.toMatchObject({
      code: 'invalid_response',
      status: 200,
    });
    expect(f.calls).toHaveLength(3);
  });

  it('retries network errors then raises network_error', async () => {
    const { c } = client([new Error('ECONNRESET'), new Error('ECONNRESET')], { maxRetries: 1 });
    await expect(c.getRelease('x')).rejects.toMatchObject({ code: 'network_error', status: 0 });
  });

  it('uses getToken per request, custom base url and revision', async () => {
    let n = 0;
    const f = fake([json({ data: [] }), json({ data: [] })]);
    const c = new ReleaseClient({
      getToken: async () => `t${++n}`,
      fetch: f.fetch,
      baseUrl: 'http://localhost:8787/v1/releases/',
      revision: '2027-01-01',
    });
    await c.listProducts();
    await c.listProducts();
    expect(f.calls.map((x) => x.headers.authorization)).toEqual(['Bearer t1', 'Bearer t2']);
    expect(f.calls[0]?.url).toBe('http://localhost:8787/v1/releases/products');
    expect(f.calls[0]?.headers['codai-platform-version']).toBe('2027-01-01');
  });

  it('validates input before sending', async () => {
    const { c, f } = client([]);
    await expect(c.rollout('r', { action: 'set' })).rejects.toThrow(/percent/);
    await expect(c.createProduct({ slug: 'Bad Slug', name: 'x' })).rejects.toThrow();
    expect(f.calls).toHaveLength(0);
    expect(() => new ReleaseClient({})).toThrow(TypeError);
    expect(() => new ReleaseClient({ token: 'a', getToken: async () => 'b' })).toThrow(TypeError);
  });
});

describe('schemas', () => {
  it('release round-trips through JSON', () => {
    const r = ReleaseSchema.parse(release);
    expect(ReleaseSchema.parse(JSON.parse(JSON.stringify(r)))).toEqual(r);
  });

  it('rollout percent bounds hold for any value', () => {
    fc.assert(
      fc.property(fc.double({ noNaN: true, min: -1000, max: 1000 }), (p) => {
        expect(RolloutActionSchema.safeParse({ action: 'set', percent: p }).success).toBe(
          p > 0 && p <= 100,
        );
      }),
    );
  });

  it('release input rejects a bad artifact hash', () => {
    expect(
      CreateReleaseInputSchema.safeParse({
        app_id: 'a',
        version: '1',
        channel: 'beta',
        build: { artifact_sha256: 'xyz' },
      }).success,
    ).toBe(false);
  });
});
