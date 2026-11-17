import { createLocalJWKSet, decodeProtectedHeader, jwtVerify, SignJWT } from 'jose';
import { describe, expect, it } from 'vitest';
import { AUDIENCE, fakeClock, ISSUER, makeFixture, type Fixture } from './__fixtures__/platform';
import { signAppJwt } from './appjwt';
import { OAuthError, PlatformError } from './errors';
import { generateSigningKeyPair, importPrivateKey } from './keys';
import { JWT_BEARER_ASSERTION, TOKEN_EXCHANGE_GRANT, TOKEN_TYPES } from './oauth';
import { assertPermission, createPlatformServer, parseRequirement } from './platform-server';
import { InstallationTokenClaimsSchema, UserToServerClaimsSchema } from './tokens';

async function appJwt(
  f: Fixture,
  over: { lifetimeSec?: number; now?: number; audience?: string } = {},
): Promise<string> {
  return signAppJwt({
    appId: 'app_1',
    privateKey: f.appKey.privateJwk,
    alg: f.appAlg,
    kid: 'app-key-1',
    audience: over.audience ?? f.server.tokenEndpoint,
    now: over.now ?? f.server.now(),
    ...(over.lifetimeSec ? { lifetimeSec: over.lifetimeSec } : {}),
  });
}

async function rejects(p: Promise<unknown>, code: string): Promise<void> {
  await expect(p).rejects.toMatchObject({ code });
}

describe.each([
  ['ES256', 'RS256'],
  ['RS256', 'ES256'],
] as const)('platform server (issuer %s, app %s)', (serverAlg, appAlg) => {
  it('verifies a valid app JWT and rejects expired, too-long, future, wrong-aud and unknown-app JWTs', async () => {
    const f = await makeFixture({ serverAlg, appAlg });
    expect((await f.server.verifyAppJwt(await appJwt(f))).app.id).toBe('app_1');
    await rejects(
      f.server.verifyAppJwt(await appJwt(f, { now: f.server.now() - 3600 })),
      'token_expired',
    );
    await rejects(f.server.verifyAppJwt(await appJwt(f, { lifetimeSec: 900 })), 'invalid_token');
    await rejects(
      f.server.verifyAppJwt(await appJwt(f, { now: f.server.now() + 600 })),
      'invalid_token',
    );
    await rejects(
      f.server.verifyAppJwt(await appJwt(f, { audience: 'https://elsewhere' })),
      'invalid_token',
    );
    await rejects(f.server.verifyAppJwt('not-a-jwt'), 'invalid_token');
    const other = await signAppJwt({
      appId: 'app_404',
      privateKey: f.appKey.privateJwk,
      alg: appAlg,
      audience: f.server.tokenEndpoint,
    });
    await rejects(f.server.verifyAppJwt(other), 'invalid_token');
  });

  it('accepts app JWTs within the 60 s clock skew', async () => {
    const f = await makeFixture({ serverAlg, appAlg });
    await expect(
      f.server.verifyAppJwt(
        await appJwt(f, { now: f.server.now() - 540 + 30 - 40, lifetimeSec: 540 }),
      ),
    ).resolves.toBeTruthy();
  });

  it('rejects an app JWT signed by a key the app did not register', async () => {
    const f = await makeFixture({ serverAlg, appAlg });
    const rogue = await generateSigningKeyPair(appAlg, 'rogue');
    const jwt = await signAppJwt({
      appId: 'app_1',
      privateKey: rogue.privateJwk,
      alg: appAlg,
      audience: f.server.tokenEndpoint,
    });
    await rejects(f.server.verifyAppJwt(jwt), 'invalid_token');
  });

  it('mints an RFC 9068 installation token verifiable against the JWKS', async () => {
    const f = await makeFixture({ serverAlg, appAlg });
    const m = await f.server.mintInstallationToken({
      appJwt: await appJwt(f),
      installationId: 'inst_1',
    });
    expect(decodeProtectedHeader(m.token)).toMatchObject({
      typ: 'at+jwt',
      alg: serverAlg,
      kid: 'srv-1',
    });
    const { payload } = await jwtVerify(m.token, createLocalJWKSet(await f.server.jwks()), {
      issuer: ISSUER,
      audience: AUDIENCE,
      typ: 'at+jwt',
      currentDate: f.clock.now(),
    });
    const c = InstallationTokenClaimsSchema.parse(payload);
    expect(c.sub).toBe('installation:inst_1');
    expect(c.client_id).toBe('cl_app_1');
    expect(c.exp - c.iat).toBe(3600);
    expect(c.scope).toBe('contacts:read invoices:write');
    expect(c.codai_installation.project_ids).toEqual(['p1', 'p2']);
    expect(f.store.issued).toHaveLength(1);
    expect((await f.server.verifyAccessToken(m.token, { audience: AUDIENCE })).jti).toBe(c.jti);
  });

  it('expires tokens with the fake clock and honours revocation', async () => {
    const f = await makeFixture({ serverAlg, appAlg });
    const m = await f.server.mintInstallationToken({
      appJwt: await appJwt(f),
      installationId: 'inst_1',
    });
    f.clock.advance(3600 + 61);
    await rejects(f.server.verifyAccessToken(m.token), 'token_expired');
    const m2 = await f.server.mintInstallationToken({
      appJwt: await appJwt(f),
      installationId: 'inst_1',
    });
    await f.server.revokeAccessToken(m2.token);
    await rejects(f.server.verifyAccessToken(m2.token), 'token_revoked');
  });
});

describe('platform server narrowing and lifecycle', () => {
  it('narrows permissions and projects, and rejects over-asking', async () => {
    const f = await makeFixture();
    const jwt = await appJwt(f);
    const m = await f.server.mintInstallationToken({
      appJwt: jwt,
      installationId: 'inst_1',
      permissions: { invoices: 'read' },
      projectIds: ['p2'],
    });
    expect(m.permissions).toEqual({ invoices: 'read' });
    expect(m.project_ids).toEqual(['p2']);
    await rejects(
      f.server.mintInstallationToken({
        appJwt: jwt,
        installationId: 'inst_1',
        permissions: { invoices: 'admin' },
      }),
      'permissions_exceeded',
    );
    await rejects(
      f.server.mintInstallationToken({ appJwt: jwt, installationId: 'inst_1', projectIds: ['p3'] }),
      'projects_exceeded',
    );
    const all = await f.server.mintInstallationToken({ appJwt: jwt, installationId: 'inst_all' });
    expect(all.project_ids).toBeUndefined();
  });

  it('refuses foreign, missing, pending and suspended installations', async () => {
    const f = await makeFixture();
    const jwt = await appJwt(f);
    await rejects(
      f.server.mintInstallationToken({ appJwt: jwt, installationId: 'inst_other' }),
      'not_found',
    );
    await rejects(
      f.server.mintInstallationToken({ appJwt: jwt, installationId: 'nope' }),
      'not_found',
    );
    await rejects(
      f.server.mintInstallationToken({ appJwt: jwt, installationId: 'inst_pending' }),
      'installation_inactive',
    );
    const m = await f.server.mintInstallationToken({ appJwt: jwt, installationId: 'inst_1' });
    await f.store.setInstallationSuspended('inst_1', true, { kind: 'user', id: 'u1' });
    await rejects(
      f.server.mintInstallationToken({ appJwt: jwt, installationId: 'inst_1' }),
      'installation_suspended',
    );
    await rejects(f.server.verifyAccessToken(m.token), 'installation_suspended');
    await expect(
      f.server.verifyAccessToken(m.token, { checkInstallation: false }),
    ).resolves.toBeTruthy();
  });

  it('checks audience and permission requirements on verify', async () => {
    const f = await makeFixture();
    const m = await f.server.mintInstallationToken({
      appJwt: await appJwt(f),
      installationId: 'inst_1',
      permissions: { invoices: 'read' },
    });
    await rejects(
      f.server.verifyAccessToken(m.token, { audience: 'https://other' }),
      'invalid_token',
    );
    await rejects(
      f.server.verifyAccessToken(m.token, { permission: 'invoices:write' }),
      'insufficient_permissions',
    );
    await expect(
      f.server.verifyAccessToken(m.token, { permission: { resource: 'invoices', level: 'read' } }),
    ).resolves.toBeTruthy();
  });

  it('rejects tokens signed by another issuer key or with a wrong typ', async () => {
    const f = await makeFixture();
    const other = await makeFixture();
    const m = await other.server.mintInstallationToken({
      appJwt: await appJwt(other),
      installationId: 'inst_1',
    });
    await rejects(f.server.verifyAccessToken(m.token), 'invalid_token');
    const key = await importPrivateKey(f.serverKey.privateJwk, 'ES256');
    const wrongTyp = await new SignJWT({ sub: 'installation:inst_1' })
      .setProtectedHeader({ alg: 'ES256', kid: 'srv-1', typ: 'JWT' })
      .setIssuer(ISSUER)
      .setExpirationTime('1h')
      .sign(key);
    await rejects(f.server.verifyAccessToken(wrongTyp), 'invalid_token');
  });

  it('issues and verifies opaque tokens stored only as a hash', async () => {
    const f = await makeFixture();
    const m = await f.server.mintInstallationToken({
      appJwt: await appJwt(f),
      installationId: 'inst_1',
      format: 'opaque',
    });
    expect(m.token).toMatch(/^cpi_[0-9A-Za-z]{40}$/);
    expect([...f.store.opaque.keys()][0]).toMatch(/^[0-9a-f]{64}$/);
    expect((await f.server.verifyAccessToken(m.token, { audience: AUDIENCE })).sub).toBe(
      'installation:inst_1',
    );
    await rejects(f.server.verifyAccessToken(m.token, { audience: 'https://x' }), 'invalid_token');
    await rejects(f.server.verifyAccessToken('cpi_' + 'a'.repeat(40)), 'invalid_token');
    f.clock.advance(3700);
    await rejects(
      f.server.verifyAccessToken(m.token, { checkInstallation: false }),
      'token_expired',
    );
  });

  it('supports custom opaque prefixes (Brivio)', async () => {
    const f = await makeFixture();
    const s = createPlatformServer({
      issuer: ISSUER,
      signingKey: { kid: 'k', alg: 'ES256', privateKey: f.serverKey.privateJwk },
      store: f.store,
      opaquePrefixes: { installation: 'bri_' },
      defaultAudience: AUDIENCE,
    });
    const m = await s.mintInstallationToken({
      appJwt: await appJwt(f, { audience: s.tokenEndpoint }),
      installationId: 'inst_1',
      format: 'opaque',
    });
    expect(m.token.startsWith('bri_')).toBe(true);
  });

  it('serves a public-only JWKS including rotation keys and a valid discovery doc', async () => {
    const f = await makeFixture();
    const old = await generateSigningKeyPair('RS256', 'srv-0');
    const s = createPlatformServer({
      issuer: `${ISSUER}/`,
      signingKey: { kid: 'srv-1', alg: 'ES256', privateKey: f.serverKey.privateJwk },
      store: f.store,
      additionalPublicKeys: [old.privateJwk],
    });
    const { keys } = await s.jwks();
    expect(keys.map((k) => k.kid)).toEqual(['srv-1', 'srv-0']);
    expect(keys.some((k) => 'd' in k)).toBe(false);
    const d = s.discovery();
    expect(d.issuer).toBe(ISSUER);
    expect(d.token_endpoint).toBe(`${ISSUER}/platform/v1/oauth/token`);
    expect(d.events_supported).toContain('installation.created');
    expect(d.token_formats_supported).toEqual(['at+jwt', 'opaque']);
  });

  it('parses permission requirements', () => {
    expect(parseRequirement('invoices:write')).toEqual({ resource: 'invoices', level: 'write' });
    expect(() => parseRequirement('bad')).toThrow();
  });

  it('assertPermission throws PlatformError', () => {
    const claims = { codai_installation: { permissions: { a: 'read' } } } as unknown as Parameters<
      typeof assertPermission
    >[0];
    expect(() => assertPermission(claims, 'a:write')).toThrow(PlatformError);
  });
});

describe('user-to-server and token exchange', () => {
  it('mints user-to-server tokens with intersected permissions', async () => {
    const f = await makeFixture();
    const inst = (await f.store.getInstallation('inst_1'))!;
    const m = await f.server.mintUserToServer({
      installation: inst,
      userId: 'u1',
      userPermissions: { invoices: 'read', contacts: 'admin', billing: 'admin' },
    });
    expect(m.permissions).toEqual({ contacts: 'read', invoices: 'read' });
    const c = UserToServerClaimsSchema.parse(await f.server.verifyAccessToken(m.token));
    expect(c.sub).toBe('user:u1');
    await rejects(
      f.server.mintUserToServer({
        installation: inst,
        userId: 'u1',
        userPermissions: {},
        requestedPermissions: { invoices: 'read' },
      }),
      'permissions_exceeded',
    );
    const op = await f.server.mintUserToServer({
      installation: inst,
      userId: 'u1',
      userPermissions: { invoices: 'read' },
      format: 'opaque',
    });
    expect(op.token.startsWith('cpu_')).toBe(true);
  });

  it('exchanges a UI session token for a user-scoped installation token', async () => {
    const f = await makeFixture();
    const s = await f.server.mintSessionToken({
      installationId: 'inst_1',
      userId: 'u1',
      dest: 'https://codai.ro/org/acme',
    });
    expect(s.expires_in).toBe(60);
    const verified = await f.server.verifySessionToken(s.token, 'cl_app_1');
    expect(verified.dest).toBe('https://codai.ro/org/acme');
    const res = await f.server.exchangeToken(
      {
        grant_type: TOKEN_EXCHANGE_GRANT,
        subject_token: s.token,
        subject_token_type: TOKEN_TYPES.session,
        requested_token_type: TOKEN_TYPES.access,
        scope: 'invoices:read',
      },
      { clientAssertion: await appJwt(f) },
    );
    expect(res.token_type).toBe('Bearer');
    expect(res.scope).toBe('invoices:read');
    const c = await f.server.verifyAccessToken(res.access_token);
    expect(c.sub).toBe('user:u1');
    f.clock.advance(121);
    await expect(f.server.verifySessionToken(s.token, 'cl_app_1')).rejects.toBeInstanceOf(
      PlatformError,
    );
  });

  it('rejects exchange without client auth, for another app, or with an unsupported type', async () => {
    const f = await makeFixture();
    const s = await f.server.mintSessionToken({
      installationId: 'inst_1',
      userId: 'u1',
      dest: 'https://x',
    });
    const req = {
      grant_type: TOKEN_EXCHANGE_GRANT,
      subject_token: s.token,
      subject_token_type: TOKEN_TYPES.session,
      requested_token_type: TOKEN_TYPES.access,
    } as const;
    await expect(f.server.exchangeToken(req)).rejects.toMatchObject({ error: 'invalid_client' });
    await expect(
      f.server.exchangeToken(
        { ...req, subject_token_type: TOKEN_TYPES.id },
        { clientAssertion: await appJwt(f) },
      ),
    ).rejects.toMatchObject({ error: 'invalid_request' });
    await expect(
      f.server.exchangeToken(
        { ...req, requested_token_type: TOKEN_TYPES.jwt },
        { clientAssertion: await appJwt(f) },
      ),
    ).rejects.toMatchObject({ error: 'invalid_request' });
    await expect(
      f.server.exchangeToken(
        { ...req, scope: 'billing:admin' },
        { clientAssertion: await appJwt(f) },
      ),
    ).rejects.toMatchObject({ error: 'invalid_scope' });
  });

  it('performs cross-platform delegation with an act claim from a trusted peer issuer', async () => {
    const f = await makeFixture();
    const peerKey = await generateSigningKeyPair('ES256', 'peer-1');
    f.store.trustedIssuers.set('https://brivio.test', {
      issuer: 'https://brivio.test',
      jwks: [peerKey.publicJwk],
    });
    f.store.federatedUsers.set('https://brivio.test 99', 'u1');
    const key = await importPrivateKey(peerKey.privateJwk, 'ES256');
    const subject = await new SignJWT({ client_id: 'brivio-app', act: { sub: 'svc:mailer' } })
      .setProtectedHeader({ alg: 'ES256', kid: 'peer-1', typ: 'at+jwt' })
      .setIssuer('https://brivio.test')
      .setSubject('user:99')
      .setAudience(ISSUER)
      .setIssuedAt(f.server.now())
      .setExpirationTime(f.server.now() + 300)
      .sign(key);
    const res = await f.server.handleTokenRequest(
      new URLSearchParams({
        grant_type: TOKEN_EXCHANGE_GRANT,
        subject_token: subject,
        subject_token_type: TOKEN_TYPES.access,
        installation_id: 'inst_1',
        client_assertion_type: JWT_BEARER_ASSERTION,
        client_assertion: await appJwt(f),
      }),
    );
    const c = UserToServerClaimsSchema.parse(await f.server.verifyAccessToken(res.access_token));
    expect(c.act).toEqual({
      sub: 'brivio-app',
      iss: 'https://brivio.test',
      act: { sub: 'svc:mailer' },
    });
    expect(c.sub).toBe('user:u1');

    f.store.trustedIssuers.clear();
    await expect(
      f.server.exchangeToken(
        {
          grant_type: TOKEN_EXCHANGE_GRANT,
          subject_token: subject,
          subject_token_type: TOKEN_TYPES.access,
          requested_token_type: TOKEN_TYPES.access,
          installation_id: 'inst_1',
        },
        { clientAssertion: await appJwt(f) },
      ),
    ).rejects.toMatchObject({ error: 'invalid_grant' });
  });

  it('handles client_credentials and rejects unknown grants', async () => {
    const f = await makeFixture();
    const res = await f.server.handleTokenRequest({
      grant_type: 'client_credentials',
      client_assertion_type: JWT_BEARER_ASSERTION,
      client_assertion: await appJwt(f),
      installation_id: 'inst_1',
      scope: 'contacts:read',
    });
    expect(res.scope).toBe('contacts:read');
    await expect(f.server.handleTokenRequest({ grant_type: 'password' })).rejects.toBeInstanceOf(
      OAuthError,
    );
    await expect(
      f.server.handleTokenRequest({
        grant_type: 'client_credentials',
        client_assertion_type: JWT_BEARER_ASSERTION,
        client_assertion: await appJwt(f),
      }),
    ).rejects.toMatchObject({ error: 'invalid_request' });
    await expect(
      f.server.handleTokenRequest({ grant_type: 'client_credentials' }),
    ).rejects.toMatchObject({ error: 'invalid_request' });
    await expect(
      f.server.handleTokenRequest({ grant_type: TOKEN_EXCHANGE_GRANT }),
    ).rejects.toMatchObject({ error: 'invalid_request' });
  });

  it('caps configured lifetimes at the protocol maximums', async () => {
    const f = await makeFixture({ clock: fakeClock() });
    const s = createPlatformServer({
      issuer: ISSUER,
      signingKey: { kid: 'k', alg: 'ES256', privateKey: f.serverKey.privateJwk },
      store: f.store,
      installationTokenTtlSec: 99999,
    });
    const m = await s.mintInstallationToken({
      appJwt: await appJwt(f, { audience: s.tokenEndpoint }),
      installationId: 'inst_1',
    });
    expect(m.expires_in).toBe(3600);
  });
});
