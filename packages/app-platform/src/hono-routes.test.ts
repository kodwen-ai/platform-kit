import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import { AUDIENCE, ISSUER, makeFixture, type Fixture } from './__fixtures__/platform';
import { signAppJwt } from './appjwt';
import { ErrorEnvelopeSchema } from './errors';
import { requirePlatformToken, type PlatformEnv } from './hono-routes';
import { withPlatformToken } from './next-handler';
import { JWT_BEARER_ASSERTION } from './oauth';
import { DiscoveryDocumentSchema, HookDeliveryListSchema, InstallationListSchema } from './rest';
import { PLATFORM_REVISION, REVISION_HEADER } from './version';

const BASE = `${ISSUER}/platform/v1`;

async function jwt(f: Fixture): Promise<string> {
  return signAppJwt({
    appId: 'app_1',
    privateKey: f.appKey.privateJwk,
    alg: f.appAlg,
    audience: f.server.tokenEndpoint,
    now: f.server.now(),
  });
}

function req(f: Fixture, path: string, init: RequestInit & { token?: string } = {}) {
  const headers = new Headers(init.headers);
  if (init.token) headers.set('authorization', `Bearer ${init.token}`);
  return f.hono.request(path.startsWith('http') ? path : BASE + path, { ...init, headers });
}

async function mint(
  f: Fixture,
  body: unknown = {},
): Promise<{ status: number; json: Record<string, unknown> }> {
  const r = await req(f, '/app/installations/inst_1/access_tokens', {
    method: 'POST',
    token: await jwt(f),
    body: JSON.stringify(body),
    headers: { 'content-type': 'application/json' },
  });
  return { status: r.status, json: (await r.json()) as Record<string, unknown> };
}

describe('platformRoutes', () => {
  it('serves discovery and JWKS with the revision header echoed', async () => {
    const f = await makeFixture();
    const d = await req(f, `${ISSUER}/.well-known/codai-platform`);
    expect(d.status).toBe(200);
    expect(d.headers.get(REVISION_HEADER)).toBe(PLATFORM_REVISION);
    expect(DiscoveryDocumentSchema.safeParse(await d.json()).success).toBe(true);
    const j = await req(f, '/jwks.json');
    expect(((await j.json()) as { keys: unknown[] }).keys).toHaveLength(1);
    expect(j.headers.get('cache-control')).toContain('max-age');
  });

  it('rejects an unknown revision with 400 unsupported_revision', async () => {
    const f = await makeFixture();
    const r = await req(f, '/app', {
      token: await jwt(f),
      headers: { [REVISION_HEADER]: '2001-01-01' },
    });
    expect(r.status).toBe(400);
    expect(((await r.json()) as { error: { code: string } }).error.code).toBe(
      'unsupported_revision',
    );
    const ok = await req(f, '/app', {
      token: await jwt(f),
      headers: { [REVISION_HEADER]: PLATFORM_REVISION },
    });
    expect(ok.status).toBe(200);
    expect(ok.headers.get(REVISION_HEADER)).toBe(PLATFORM_REVISION);
  });

  it('GET /app requires a valid app JWT', async () => {
    const f = await makeFixture();
    const none = await req(f, '/app');
    expect(none.status).toBe(401);
    expect(none.headers.get('www-authenticate')).toContain('Bearer');
    expect(ErrorEnvelopeSchema.safeParse(await none.json()).success).toBe(true);
    const ok = await req(f, '/app', { token: await jwt(f) });
    expect(((await ok.json()) as { id: string }).id).toBe('app_1');
  });

  it('lists and gets installations scoped to the app', async () => {
    const f = await makeFixture();
    const t = await jwt(f);
    const list = InstallationListSchema.parse(
      await (await req(f, '/app/installations?per_page=2', { token: t })).json(),
    );
    expect(list.installations).toHaveLength(2);
    expect(list.next_cursor).toBe('2');
    const page2 = InstallationListSchema.parse(
      await (await req(f, '/app/installations?cursor=2', { token: t })).json(),
    );
    expect(page2.installations.map((i) => i.id)).toEqual(['inst_pending']);
    expect((await req(f, '/app/installations/inst_1', { token: t })).status).toBe(200);
    expect((await req(f, '/app/installations/inst_other', { token: t })).status).toBe(404);
  });

  it('mints, narrows and refuses over-asking access tokens', async () => {
    const f = await makeFixture();
    const ok = await mint(f, { permissions: { invoices: 'read' }, project_ids: ['p1'] });
    expect(ok.status).toBe(201);
    expect(ok.json.permissions).toEqual({ invoices: 'read' });
    expect(ok.json.project_ids).toEqual(['p1']);
    const over = await mint(f, { permissions: { invoices: 'admin' } });
    expect(over.status).toBe(422);
    expect((over.json.error as { code: string }).code).toBe('permissions_exceeded');
    expect((await mint(f, { permissions: { invoices: 'owner' } })).status).toBe(422);
    const bad = await req(f, '/app/installations/inst_1/access_tokens', {
      method: 'POST',
      token: await jwt(f),
      body: '{oops',
    });
    expect(bad.status).toBe(400);
    expect((await mint(f)).status).toBe(201);
  });

  it('installation routes list projects within the token scope and revoke the token', async () => {
    const f = await makeFixture();
    const { json } = await mint(f, { project_ids: ['p2'] });
    const token = json.token as string;
    const p = await req(f, '/installation/projects', { token });
    expect(await p.json()).toEqual({
      projects: [{ id: 'p2', name: 'Two', account_id: 'org_1' }],
      total_count: 1,
    });
    expect((await req(f, '/installation/token', { method: 'DELETE', token })).status).toBe(204);
    const after = await req(f, '/installation/projects', { token });
    expect(after.status).toBe(401);
    expect(((await after.json()) as { error: { code: string } }).error.code).toBe('token_revoked');
  });

  it('rejects app JWTs on installation routes and access tokens on app routes', async () => {
    const f = await makeFixture();
    const { json } = await mint(f);
    expect((await req(f, '/installation/projects', { token: await jwt(f) })).status).toBe(401);
    expect((await req(f, '/app', { token: json.token as string })).status).toBe(401);
  });

  it('suspends and unsuspends an installation', async () => {
    const f = await makeFixture();
    const t = await jwt(f);
    const s = await req(f, '/app/installations/inst_1/suspended', {
      method: 'PATCH',
      token: t,
      body: JSON.stringify({ suspended: true }),
    });
    expect(((await s.json()) as { status: string }).status).toBe('suspended');
    expect((await mint(f)).status).toBe(403);
    await req(f, '/app/installations/inst_1/suspended', {
      method: 'PATCH',
      token: t,
      body: JSON.stringify({ suspended: false }),
    });
    expect((await mint(f)).status).toBe(201);
    expect(
      (
        await req(f, '/app/installations/inst_1/suspended', {
          method: 'PATCH',
          token: t,
          body: JSON.stringify({ suspended: 'yes' }),
        })
      ).status,
    ).toBe(422);
  });

  it('lists deliveries and queues redeliveries', async () => {
    const f = await makeFixture();
    const t = await jwt(f);
    const list = HookDeliveryListSchema.parse(
      await (await req(f, '/app/hook/deliveries', { token: t })).json(),
    );
    expect(list.deliveries[0]?.id).toBe('d1');
    const r = await req(f, '/app/hook/deliveries/d1/attempts', { method: 'POST', token: t });
    expect(r.status).toBe(202);
    expect(f.store.redeliveries).toEqual(['d1']);
    expect(
      (await req(f, '/app/hook/deliveries/zzz/attempts', { method: 'POST', token: t })).status,
    ).toBe(404);
  });

  it('token endpoint speaks RFC 6749 errors and form bodies', async () => {
    const f = await makeFixture();
    const form = new URLSearchParams({
      grant_type: 'client_credentials',
      client_assertion_type: JWT_BEARER_ASSERTION,
      client_assertion: await jwt(f),
      installation_id: 'inst_1',
    });
    const ok = await req(f, '/oauth/token', {
      method: 'POST',
      body: form,
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
    });
    expect(ok.status).toBe(200);
    expect(ok.headers.get('cache-control')).toBe('no-store');
    expect(((await ok.json()) as { token_type: string }).token_type).toBe('Bearer');
    const bad = await req(f, '/oauth/token', {
      method: 'POST',
      body: JSON.stringify({ grant_type: 'password' }),
      headers: { 'content-type': 'application/json' },
    });
    expect(bad.status).toBe(400);
    expect(await bad.json()).toMatchObject({ error: 'unsupported_grant_type' });
    const unauth = await req(f, '/oauth/token', {
      method: 'POST',
      body: new URLSearchParams({
        grant_type: 'client_credentials',
        client_assertion_type: JWT_BEARER_ASSERTION,
        client_assertion: 'x.y.z',
      }),
    });
    expect(unauth.status).toBe(401);
  });

  it('unknown routes return the error envelope', async () => {
    const f = await makeFixture();
    const r = await req(f, '/nope');
    expect(r.status).toBe(404);
    expect(ErrorEnvelopeSchema.safeParse(await r.json()).success).toBe(true);
  });

  it('requirePlatformToken middleware exposes claims and enforces permissions on host routes', async () => {
    const f = await makeFixture();
    const host = new Hono<PlatformEnv>();
    host.get(
      '/invoices',
      requirePlatformToken(f.server, { audience: AUDIENCE, permission: 'invoices:write' }),
      (c) => c.json({ sub: c.var.platformClaims.sub }),
    );
    const write = (await mint(f)).json.token as string;
    const read = (await mint(f, { permissions: { invoices: 'read' } })).json.token as string;
    expect(
      await (
        await host.request('/invoices', { headers: { authorization: `Bearer ${write}` } })
      ).json(),
    ).toEqual({ sub: 'installation:inst_1' });
    expect(
      (await host.request('/invoices', { headers: { authorization: `Bearer ${read}` } })).status,
    ).toBe(403);
    expect((await host.request('/invoices')).status).toBe(401);
  });
});

describe('withPlatformToken (Next adapter)', () => {
  it('passes claims to the handler and returns envelopes on failure', async () => {
    const f = await makeFixture();
    const handler = withPlatformToken<{ params: Promise<{ id: string }> }>(
      async (_req, ctx) => Response.json({ sub: ctx.claims.sub, id: (await ctx.params).id }),
      {
        server: f.server,
        audience: AUDIENCE,
        permission: 'contacts:read',
      },
    );
    const token = (await mint(f)).json.token as string;
    const ok = await handler(
      new Request('https://x/api', { headers: { authorization: `Bearer ${token}` } }),
      { params: Promise.resolve({ id: '7' }) },
    );
    expect(await ok.json()).toEqual({ sub: 'installation:inst_1', id: '7' });
    const none = await handler(new Request('https://x/api', { headers: { 'x-request-id': 'r1' } }));
    expect(none.status).toBe(401);
    expect(await none.json()).toMatchObject({
      error: { code: 'unauthenticated', request_id: 'r1' },
    });
    expect(none.headers.get(REVISION_HEADER)).toBe(PLATFORM_REVISION);
    const bad = await handler(
      new Request('https://x/api', { headers: { authorization: 'Bearer nope' } }),
    );
    expect(bad.status).toBe(401);
    const narrow = (await mint(f, { permissions: { invoices: 'read' } })).json.token as string;
    expect(
      (
        await handler(
          new Request('https://x/api', { headers: { authorization: `Bearer ${narrow}` } }),
        )
      ).status,
    ).toBe(403);
  });
});
