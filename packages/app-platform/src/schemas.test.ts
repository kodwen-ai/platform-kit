import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  allowedEvents,
  AppJwtClaimsSchema,
  AppManifestSchema,
  BASE_EVENT_CATALOG,
  buildPath,
  ClientCredentialsRequestSchema,
  createAppManifestSchema,
  defineEventCatalog,
  ErrorEnvelopeSchema,
  generateOpaqueToken,
  hashOpaqueToken,
  InstallationSchema,
  InstallationTokenClaimsSchema,
  isOpaqueToken,
  isSupportedRevision,
  JWT_BEARER_ASSERTION,
  looksLikeJwt,
  narrowProjects,
  OAuthErrorResponseSchema,
  PLATFORM_REVISION,
  PLATFORM_VERSION,
  PlatformError,
  SessionTokenClaimsSchema,
  timingSafeEqualHex,
  TOKEN_EXCHANGE_GRANT,
  TOKEN_PREFIXES,
  TOKEN_TYPES,
  TokenExchangeRequestSchema,
  UserToServerClaimsSchema,
} from './index';

const manifest = {
  name: 'Invoice Sync',
  slug: 'invoice-sync',
  url: 'https://example.ro',
  owner: { kind: 'org', id: 'org_1' },
  callback_urls: ['https://example.ro/cb'],
  default_permissions: { invoices: 'write' },
  default_events: ['installation.created', 'invoice.paid'],
} as const;

describe('version', () => {
  it('exposes path major and dated revision', () => {
    expect(PLATFORM_VERSION).toBe('v1');
    expect(PLATFORM_REVISION).toBe('2026-10-19');
    expect(isSupportedRevision('2026-10-19')).toBe(true);
    expect(isSupportedRevision('2020-01-01')).toBe(false);
  });
});

describe('event catalog', () => {
  const catalog = defineEventCatalog({ 'invoice.paid': { resource: 'invoices', level: 'read' } });

  it('extends the base catalog', () => {
    expect(catalog['invoice.paid']).toEqual({ resource: 'invoices', level: 'read' });
    expect(catalog['installation.created']).toBeNull();
    expect(Object.keys(BASE_EVENT_CATALOG)).toContain('ping');
  });

  it('refuses to redefine a base event or a malformed name', () => {
    expect(() => defineEventCatalog({ ping: null })).toThrow(/already defined/);
    expect(() => defineEventCatalog({ 'Bad Event': null })).toThrow();
  });

  it('filters events not allowed by permissions', () => {
    expect(allowedEvents(['invoice.paid', 'ping', 'nope'], {}, catalog)).toEqual(['ping']);
    expect(allowedEvents(['invoice.paid'], { invoices: 'admin' }, catalog)).toEqual([
      'invoice.paid',
    ]);
  });
});

describe('AppManifestSchema', () => {
  const schema = createAppManifestSchema(
    defineEventCatalog({ 'invoice.paid': { resource: 'invoices', level: 'read' } }),
  );

  it('accepts a manifest whose events are covered by permissions and applies defaults', () => {
    const m = schema.parse(manifest);
    expect(m.public).toBe(false);
    expect(m.conformance_revision).toBe(PLATFORM_REVISION);
  });

  it('rejects an event the permissions do not allow', () => {
    const r = schema.safeParse({ ...manifest, default_permissions: {} });
    expect(r.success).toBe(false);
    expect(r.error?.issues[0]?.message).toMatch(/needs invoices:read/);
  });

  it('rejects unknown events in the base catalog', () => {
    expect(AppManifestSchema.safeParse(manifest).success).toBe(false);
  });

  it('rejects paid plans without amount/currency and OAuth-on-install without callback', () => {
    expect(
      schema.safeParse({ ...manifest, pricing: [{ id: 'pro', name: 'Pro', model: 'flat' }] })
        .success,
    ).toBe(false);
    expect(
      schema.safeParse({
        ...manifest,
        pricing: [{ id: 'pro', name: 'Pro', model: 'flat', amount_minor: 900, currency: 'EUR' }],
      }).success,
    ).toBe(true);
    expect(
      schema.safeParse({ ...manifest, callback_urls: [], request_oauth_on_install: true }).success,
    ).toBe(false);
  });

  it('validates webhook events and hosted runtime', () => {
    expect(
      schema.safeParse({
        ...manifest,
        webhook: { url: 'https://example.ro/h', events: ['unknown.x'] },
      }).success,
    ).toBe(false);
    expect(
      schema.safeParse({
        ...manifest,
        hosted: { runtime: 'codai-sandbox-v2', egress: ['api.example.ro'] },
      }).success,
    ).toBe(true);
    expect(
      schema.safeParse({ ...manifest, hosted: { runtime: 'docker', egress: [] } }).success,
    ).toBe(false);
  });
});

const installation = {
  id: 'inst_1',
  app_id: 'app_1',
  app_slug: 'invoice-sync',
  account: { kind: 'org', id: 'org_1' },
  target_type: 'org',
  project_selection: 'selected',
  project_ids: ['p1', 'p2'],
  permissions: { invoices: 'write' },
  events: [],
  status: 'active',
  created_at: '2026-10-19T00:00:00Z',
  updated_at: '2026-10-19T00:00:00Z',
  permissions_version: 1,
} as const;

describe('InstallationSchema + narrowProjects', () => {
  it('accepts a valid installation and enforces target/account consistency', () => {
    expect(InstallationSchema.safeParse(installation).success).toBe(true);
    expect(InstallationSchema.safeParse({ ...installation, target_type: 'user' }).success).toBe(
      false,
    );
    expect(
      InstallationSchema.safeParse({ ...installation, project_selection: 'all' }).success,
    ).toBe(false);
  });

  it('narrows project selection', () => {
    const sel = { project_selection: 'selected' as const, project_ids: ['p1', 'p2'] };
    expect(narrowProjects(sel)).toEqual({ ok: true, projectIds: ['p1', 'p2'] });
    expect(narrowProjects(sel, ['p2', 'p2'])).toEqual({ ok: true, projectIds: ['p2'] });
    expect(narrowProjects(sel, ['p3'])).toEqual({ ok: false, exceeded: ['p3'] });
    expect(narrowProjects({ project_selection: 'all', project_ids: [] })).toEqual({
      ok: true,
      projectIds: null,
    });
    expect(narrowProjects({ project_selection: 'all', project_ids: [] }, ['x'])).toEqual({
      ok: true,
      projectIds: ['x'],
    });
  });
});

describe('token claim schemas', () => {
  const base = {
    iss: 'https://ai.codai.ro',
    aud: 'https://api.brivio.ro',
    client_id: 'cl_1',
    iat: 1000,
    exp: 4600,
    jti: 'j1',
    scope: 'invoices:write',
    codai_installation: {
      id: 'inst_1',
      account: { kind: 'org', id: 'org_1' },
      permissions: { invoices: 'write' },
    },
  };

  it('app JWT lifetime must be ≤ 600 s', () => {
    expect(AppJwtClaimsSchema.safeParse({ iss: 'app', iat: 0, exp: 600, aud: 'x' }).success).toBe(
      true,
    );
    expect(AppJwtClaimsSchema.safeParse({ iss: 'app', iat: 0, exp: 601, aud: 'x' }).success).toBe(
      false,
    );
    expect(AppJwtClaimsSchema.safeParse({ iss: 'app', iat: 10, exp: 5, aud: 'x' }).success).toBe(
      false,
    );
  });

  it('installation token needs sub installation:<id> and ttl ≤ 3600', () => {
    expect(
      InstallationTokenClaimsSchema.safeParse({ ...base, sub: 'installation:inst_1' }).success,
    ).toBe(true);
    expect(InstallationTokenClaimsSchema.safeParse({ ...base, sub: 'user:1' }).success).toBe(false);
    expect(
      InstallationTokenClaimsSchema.safeParse({ ...base, sub: 'installation:inst_1', exp: 4601 })
        .success,
    ).toBe(false);
  });

  it('user-to-server token accepts nested act claims', () => {
    const r = UserToServerClaimsSchema.safeParse({
      ...base,
      sub: 'user:42',
      act: { sub: 'app:x', act: { sub: 'svc' } },
    });
    expect(r.success).toBe(true);
  });

  it('session token lifetime is short', () => {
    const s = {
      iss: 'i',
      sub: 'user:1',
      aud: 'cl',
      dest: 'https://x',
      iat: 0,
      exp: 60,
      jti: 'j',
      installation_id: 'inst',
    };
    expect(SessionTokenClaimsSchema.safeParse(s).success).toBe(true);
    expect(SessionTokenClaimsSchema.safeParse({ ...s, exp: 3600 }).success).toBe(false);
  });
});

describe('OAuth schemas', () => {
  it('parses a token-exchange request and defaults requested_token_type', () => {
    const r = TokenExchangeRequestSchema.parse({
      grant_type: TOKEN_EXCHANGE_GRANT,
      subject_token: 't',
      subject_token_type: TOKEN_TYPES.session,
    });
    expect(r.requested_token_type).toBe(TOKEN_TYPES.access);
  });

  it('requires actor_token_type with actor_token', () => {
    const r = TokenExchangeRequestSchema.safeParse({
      grant_type: TOKEN_EXCHANGE_GRANT,
      subject_token: 't',
      subject_token_type: TOKEN_TYPES.jwt,
      actor_token: 'a',
    });
    expect(r.success).toBe(false);
  });

  it('parses client_credentials with an RFC 7523 assertion', () => {
    expect(
      ClientCredentialsRequestSchema.safeParse({
        grant_type: 'client_credentials',
        client_assertion_type: JWT_BEARER_ASSERTION,
        client_assertion: 'x',
      }).success,
    ).toBe(true);
    expect(
      ClientCredentialsRequestSchema.safeParse({
        grant_type: 'client_credentials',
        client_assertion_type: 'other',
        client_assertion: 'x',
      }).success,
    ).toBe(false);
  });

  it('validates RFC 6749 error responses', () => {
    expect(OAuthErrorResponseSchema.safeParse({ error: 'invalid_grant' }).success).toBe(true);
    expect(OAuthErrorResponseSchema.safeParse({ error: 'nope' }).success).toBe(false);
  });
});

describe('opaque tokens', () => {
  it('generates prefixed 40-char base62 tokens', () => {
    const t = generateOpaqueToken(TOKEN_PREFIXES.installation);
    expect(t).toMatch(/^cpi_[0-9A-Za-z]{40}$/);
    expect(isOpaqueToken(t, 'cpi_')).toBe(true);
    expect(isOpaqueToken(t, 'cpu_')).toBe(false);
    expect(looksLikeJwt(t)).toBe(false);
    expect(generateOpaqueToken('brv_')).toMatch(/^brv_/);
  });

  it('rejects malformed prefixes', () => {
    expect(() => generateOpaqueToken('CPI')).toThrow();
  });

  it('tokens are unique', () => {
    const set = new Set(Array.from({ length: 200 }, () => generateOpaqueToken('cpi_')));
    expect(set.size).toBe(200);
  });

  it('hashes with sha256 (known vector)', async () => {
    expect(await hashOpaqueToken('abc')).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
  });

  it('constant-time hex compare matches equality', async () => {
    await fc.assert(
      fc.asyncProperty(fc.string(), fc.string(), async (a, b) => {
        expect(timingSafeEqualHex(await hashOpaqueToken(a), await hashOpaqueToken(b))).toBe(
          a === b,
        );
      }),
      { numRuns: 50 },
    );
    expect(timingSafeEqualHex('ab', 'abc')).toBe(false);
  });
});

describe('errors + rest helpers', () => {
  it('PlatformError serialises to the envelope', () => {
    const e = new PlatformError('permissions_exceeded', 'too much', { exceeded: ['a'] });
    expect(e.status).toBe(422);
    const env = e.toEnvelope('req-1');
    expect(ErrorEnvelopeSchema.safeParse(env).success).toBe(true);
    expect(env.error.request_id).toBe('req-1');
  });

  it('buildPath encodes params and fails on missing ones', () => {
    expect(buildPath('/app/installations/{id}', { id: 'a/b' })).toBe('/app/installations/a%2Fb');
    expect(() => buildPath('/x/{id}')).toThrow(/missing path param/);
  });
});
