/**
 * Framework-agnostic platform core: app JWT verification, installation / user-to-server
 * token minting (RFC 9068 at+jwt or opaque), verification, revocation and RFC 8693 exchange.
 * jose docs: https://github.com/panva/jose/tree/main/docs
 */
import {
  createLocalJWKSet,
  decodeJwt,
  decodeProtectedHeader,
  jwtVerify,
  SignJWT,
  type JWK,
  type JWTPayload,
  type JWTVerifyOptions,
} from 'jose';
import { OAuthError, PlatformError } from './errors';
import { BASE_EVENT_CATALOG, type EventCatalog } from './events';
import { narrowProjects, type Installation, type ProjectScope } from './installation';
import {
  importPublicJwk,
  resolveSigningKey,
  SIGNING_ALGS,
  toPublicJwk,
  type SigningKey,
} from './keys';
import type { App } from './manifest';
import {
  ClientCredentialsRequestSchema,
  TOKEN_EXCHANGE_GRANT,
  TOKEN_TYPES,
  TokenExchangeRequestSchema,
  type TokenExchangeRequest,
  type TokenExchangeResponse,
} from './oauth';
import {
  generateOpaqueToken,
  hashOpaqueToken,
  looksLikeJwt,
  TOKEN_PREFIXES,
  type OpaqueTokenKind,
} from './opaque';
import {
  intersectPermissions,
  levelSatisfies,
  narrowPermissions,
  permissionsToScope,
  scopeToPermissions,
  type PermissionLevel,
  type Permissions,
} from './permissions';
import type { DiscoveryDocument } from './rest';
import type { PlatformStore } from './store';
import {
  ACCESS_TOKEN_MAX_LIFETIME_SEC,
  ACCESS_TOKEN_TYP,
  APP_JWT_MAX_LIFETIME_SEC,
  AppJwtClaimsSchema,
  InstallationTokenClaimsSchema,
  SESSION_TOKEN_LIFETIME_SEC,
  SESSION_TOKEN_TYP,
  SessionTokenClaimsSchema,
  UserToServerClaimsSchema,
  type AccessTokenClaims,
  type ActorClaim,
  type AppJwtClaims,
  type SessionTokenClaims,
} from './tokens';
import {
  DEFAULT_BASE_PATH,
  DISCOVERY_PATH,
  PLATFORM_VERSION,
  SUPPORTED_REVISIONS,
} from './version';

/** Options of {@link createPlatformServer}. */
export interface PlatformServerOptions {
  /** Issuer URL (`iss` of every platform token), e.g. `https://ai.codai.ro`. */
  issuer: string;
  signingKey: SigningKey;
  store: PlatformStore;
  /** Injectable clock (tests). */
  clock?: () => Date;
  /** Installation / user token lifetime, capped at 3600 s. */
  installationTokenTtlSec?: number;
  /** Max accepted app JWT lifetime, capped at 600 s. */
  appJwtMaxSec?: number;
  /** Accepted clock skew (default 60 s). */
  clockSkewSec?: number;
  /** REST base path (default `/platform/v1`). */
  basePath?: string;
  /** Public origin used to build endpoint URLs (default: issuer). */
  publicUrl?: string;
  /** Default `aud` of minted access tokens (default: issuer). */
  defaultAudience?: string;
  /** Accepted `aud` values of app JWTs (default: token endpoint, issuer, REST base URL). */
  appJwtAudiences?: string[];
  /** Previous public keys still served in the JWKS during rotation. */
  additionalPublicKeys?: JWK[];
  eventCatalog?: EventCatalog;
  /** Override opaque prefixes (e.g. Brivio's own). */
  opaquePrefixes?: Partial<Record<OpaqueTokenKind, string>>;
}

/** A verified app JWT. */
export interface VerifiedAppJwt {
  app: App;
  claims: AppJwtClaims;
}

/** Token format of a minted access token. */
export type TokenFormat = 'jwt' | 'opaque';

/** A freshly minted access token. */
export interface MintedToken {
  token: string;
  format: TokenFormat;
  expires_at: string;
  expires_in: number;
  permissions: Permissions;
  project_ids?: string[];
  claims: AccessTokenClaims;
}

/** Required permission: `{resource, level}` or `"resource:level"`. */
export type PermissionRequirement = { resource: string; level: PermissionLevel } | string;

/** Options of {@link PlatformServer.verifyAccessToken}. */
export interface VerifyAccessTokenOptions {
  /** Expected audience (string or any-of list); skipped when omitted. */
  audience?: string | string[] | undefined;
  permission?: PermissionRequirement | undefined;
  /** Reject tokens of non-active installations (default true). */
  checkInstallation?: boolean | undefined;
}

/** Options of {@link PlatformServer.mintInstallationToken}. */
export interface MintInstallationTokenOptions {
  appJwt: string;
  installationId: string;
  permissions?: Permissions | undefined;
  projectIds?: string[] | undefined;
  audience?: string | undefined;
  format?: TokenFormat | undefined;
}

/** Options of {@link PlatformServer.mintUserToServer}. */
export interface MintUserToServerOptions {
  installation: Installation;
  userId: string;
  userPermissions: Permissions;
  requestedPermissions?: Permissions | undefined;
  act?: ActorClaim | undefined;
  audience?: string | undefined;
  format?: TokenFormat | undefined;
}

/** The platform core returned by {@link createPlatformServer}. */
export interface PlatformServer {
  readonly issuer: string;
  readonly basePath: string;
  readonly tokenEndpoint: string;
  readonly defaultAudience: string;
  readonly eventCatalog: EventCatalog;
  readonly store: PlatformStore;
  /** Current time in seconds. */
  now(): number;
  verifyAppJwt(jwt: string): Promise<VerifiedAppJwt>;
  mintInstallationToken(o: MintInstallationTokenOptions): Promise<MintedToken>;
  /** Mint for an already-authenticated app (used by the token endpoint and routes). */
  issueInstallationToken(
    app: App,
    o: Omit<MintInstallationTokenOptions, 'appJwt'>,
  ): Promise<MintedToken>;
  verifyAccessToken(token: string, o?: VerifyAccessTokenOptions): Promise<AccessTokenClaims>;
  revokeAccessToken(token: string): Promise<AccessTokenClaims>;
  mintUserToServer(o: MintUserToServerOptions): Promise<MintedToken>;
  mintSessionToken(o: {
    installationId: string;
    userId: string;
    dest: string;
  }): Promise<{ token: string; expires_in: number }>;
  verifySessionToken(token: string, clientId: string): Promise<SessionTokenClaims>;
  exchangeToken(
    request: TokenExchangeRequest,
    ctx?: { clientAssertion?: string | undefined },
  ): Promise<TokenExchangeResponse>;
  /** RFC 6749 token endpoint over form fields (token-exchange or client_credentials). */
  handleTokenRequest(
    form: URLSearchParams | Record<string, string | string[]>,
  ): Promise<TokenExchangeResponse>;
  jwks(): Promise<{ keys: JWK[] }>;
  discovery(): DiscoveryDocument;
}

const JOSE_EXPIRED = 'ERR_JWT_EXPIRED';

function joseCode(e: unknown): string | undefined {
  return typeof e === 'object' && e !== null && 'code' in e && typeof e.code === 'string'
    ? e.code
    : undefined;
}

function trimSlash(s: string): string {
  return s.endsWith('/') ? s.slice(0, -1) : s;
}

/** Parse a requirement into resource + level. */
export function parseRequirement(p: PermissionRequirement): {
  resource: string;
  level: PermissionLevel;
} {
  if (typeof p !== 'string') return p;
  const parsed = scopeToPermissions(p);
  const entry = parsed ? Object.entries(parsed)[0] : undefined;
  if (!entry) throw new Error(`invalid permission requirement ${p}`);
  return { resource: entry[0], level: entry[1] };
}

/** Throw `insufficient_permissions` unless `claims` grant `p`. */
export function assertPermission(claims: AccessTokenClaims, p: PermissionRequirement): void {
  const req = parseRequirement(p);
  const have = claims.codai_installation.permissions[req.resource];
  if (!have || !levelSatisfies(have, req.level)) {
    throw new PlatformError(
      'insufficient_permissions',
      `token lacks ${req.resource}:${req.level}`,
      { required: req },
    );
  }
}

function formToObject(
  form: URLSearchParams | Record<string, string | string[]>,
): Record<string, string | string[]> {
  if (!(form instanceof URLSearchParams)) return form;
  const out: Record<string, string | string[]> = {};
  for (const key of new Set(form.keys())) {
    const all = form.getAll(key);
    out[key] = all.length === 1 ? (all[0] ?? '') : all;
  }
  return out;
}

function firstAudience(r: {
  resource?: string | string[] | undefined;
  audience?: string | string[] | undefined;
}): string | undefined {
  const pick = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);
  return pick(r.resource) ?? pick(r.audience);
}

function audienceMatches(aud: string | string[], expected: string | string[]): boolean {
  const have = Array.isArray(aud) ? aud : [aud];
  const want = Array.isArray(expected) ? expected : [expected];
  return have.some((a) => want.includes(a));
}

/** Create the platform core. */
export function createPlatformServer(opts: PlatformServerOptions): PlatformServer {
  const issuer = trimSlash(opts.issuer);
  const publicUrl = trimSlash(opts.publicUrl ?? issuer);
  const basePath = opts.basePath ?? DEFAULT_BASE_PATH;
  const restBase = publicUrl + basePath;
  const tokenEndpoint = `${restBase}/oauth/token`;
  const defaultAudience = opts.defaultAudience ?? issuer;
  const appJwtAudiences = opts.appJwtAudiences ?? [tokenEndpoint, issuer, restBase];
  const ttl = Math.min(
    opts.installationTokenTtlSec ?? ACCESS_TOKEN_MAX_LIFETIME_SEC,
    ACCESS_TOKEN_MAX_LIFETIME_SEC,
  );
  const appJwtMax = Math.min(
    opts.appJwtMaxSec ?? APP_JWT_MAX_LIFETIME_SEC,
    APP_JWT_MAX_LIFETIME_SEC,
  );
  const skew = opts.clockSkewSec ?? 60;
  const clock = opts.clock ?? (() => new Date());
  const prefixes = { ...TOKEN_PREFIXES, ...opts.opaquePrefixes };
  const store = opts.store;
  const eventCatalog = opts.eventCatalog ?? BASE_EVENT_CATALOG;
  const keyP = resolveSigningKey(opts.signingKey);
  const now = () => Math.floor(clock().getTime() / 1000);

  const publicKeys = async (): Promise<JWK[]> => [
    (await keyP).publicJwk,
    ...(opts.additionalPublicKeys ?? []).map(toPublicJwk),
  ];

  const baseVerify = (): JWTVerifyOptions => ({
    currentDate: clock(),
    clockTolerance: skew,
    algorithms: [...SIGNING_ALGS],
  });

  function mapJoseError(e: unknown, what: string): PlatformError {
    if (e instanceof PlatformError) return e;
    if (joseCode(e) === JOSE_EXPIRED) return new PlatformError('token_expired', `${what} expired`);
    return new PlatformError(
      'invalid_token',
      `${what} invalid: ${e instanceof Error ? e.message : 'verification failed'}`,
    );
  }

  async function verifyWithKeys(
    jwt: string,
    keys: JWK[],
    o: JWTVerifyOptions,
    what: string,
  ): Promise<JWTPayload> {
    let header;
    try {
      header = decodeProtectedHeader(jwt);
    } catch {
      throw new PlatformError('invalid_token', `${what} malformed`);
    }
    const candidates = keys.filter((k) => !header.kid || !k.kid || k.kid === header.kid);
    let last: unknown = new Error('no matching key');
    for (const jwk of candidates) {
      try {
        const key = await importPublicJwk(jwk, header.alg);
        return (await jwtVerify(jwt, key, o)).payload;
      } catch (e) {
        last = e;
        if (joseCode(e) === JOSE_EXPIRED) break;
      }
    }
    throw mapJoseError(last, what);
  }

  async function verifyAppJwt(jwt: string): Promise<VerifiedAppJwt> {
    let iss: string | undefined;
    try {
      iss = decodeJwt(jwt).iss;
    } catch {
      throw new PlatformError('invalid_token', 'app JWT malformed');
    }
    if (!iss) throw new PlatformError('invalid_token', 'app JWT has no iss');
    const app = await store.getApp(iss);
    if (!app) throw new PlatformError('invalid_token', 'unknown app');
    const payload = await verifyWithKeys(
      jwt,
      await store.getAppPublicKeys(app.id),
      { ...baseVerify(), issuer: iss, audience: appJwtAudiences, requiredClaims: ['iat', 'exp'] },
      'app JWT',
    );
    const parsed = AppJwtClaimsSchema.safeParse(payload);
    if (!parsed.success)
      throw new PlatformError(
        'invalid_token',
        'app JWT lifetime exceeds 600 s or claims malformed',
      );
    const c = parsed.data;
    if (c.exp - c.iat > appJwtMax)
      throw new PlatformError('invalid_token', `app JWT lifetime exceeds ${appJwtMax} s`);
    if (c.iat > now() + skew)
      throw new PlatformError('invalid_token', 'app JWT issued in the future');
    return { app, claims: c };
  }

  async function signJwt(payload: JWTPayload, typ: string): Promise<string> {
    const { key } = await keyP;
    return new SignJWT(payload)
      .setProtectedHeader({ alg: opts.signingKey.alg, typ, kid: opts.signingKey.kid })
      .sign(key);
  }

  async function finishToken(
    claims: AccessTokenClaims,
    format: TokenFormat,
    appId: string,
    projectIds: ProjectScope,
    prefix: string,
  ): Promise<MintedToken> {
    let token: string;
    if (format === 'opaque') {
      if (!store.saveOpaqueToken)
        throw new PlatformError('internal', 'store does not support opaque tokens');
      token = generateOpaqueToken(prefix);
      await store.saveOpaqueToken(await hashOpaqueToken(token), claims);
    } else {
      token = await signJwt({ ...claims }, ACCESS_TOKEN_TYP);
    }
    await store.recordTokenIssued({
      jti: claims.jti,
      app_id: appId,
      installation_id: claims.codai_installation.id,
      sub: claims.sub,
      aud: claims.aud,
      format,
      permissions: claims.codai_installation.permissions,
      project_ids: projectIds,
      issued_at: claims.iat,
      expires_at: claims.exp,
    });
    return {
      token,
      format,
      expires_at: new Date(claims.exp * 1000).toISOString(),
      expires_in: claims.exp - claims.iat,
      permissions: claims.codai_installation.permissions,
      ...(projectIds ? { project_ids: projectIds } : {}),
      claims,
    };
  }

  function assertActive(inst: Installation): void {
    if (inst.status === 'suspended')
      throw new PlatformError('installation_suspended', 'installation is suspended');
    if (inst.status !== 'active')
      throw new PlatformError('installation_inactive', `installation is ${inst.status}`);
  }

  function baseClaims(
    app: App,
    inst: Installation,
    sub: string,
    perms: Permissions,
    projectIds: ProjectScope,
    audience: string | undefined,
  ) {
    const iat = now();
    return {
      iss: issuer,
      sub,
      aud: audience ?? defaultAudience,
      client_id: app.client_id,
      iat,
      exp: iat + ttl,
      jti: globalThis.crypto.randomUUID(),
      scope: permissionsToScope(perms),
      codai_installation: {
        id: inst.id,
        account: inst.account,
        permissions: perms,
        ...(projectIds ? { project_ids: projectIds } : {}),
      },
    };
  }

  async function loadOwnedInstallation(app: App, id: string): Promise<Installation> {
    const inst = await store.getInstallation(id);
    if (!inst || inst.app_id !== app.id)
      throw new PlatformError('not_found', 'installation not found');
    return inst;
  }

  function narrowAll(
    inst: Installation,
    permissions?: Permissions,
    projectIds?: string[],
  ): { perms: Permissions; projects: ProjectScope } {
    const np = narrowPermissions(inst.permissions, permissions);
    if (!np.ok)
      throw new PlatformError(
        'permissions_exceeded',
        'requested permissions exceed the installation',
        { exceeded: np.exceeded },
      );
    const nj = narrowProjects(inst, projectIds);
    if (!nj.ok)
      throw new PlatformError(
        'projects_exceeded',
        'requested projects are outside the installation',
        { exceeded: nj.exceeded },
      );
    return { perms: np.permissions, projects: nj.projectIds };
  }

  async function issueInstallationToken(
    app: App,
    o: Omit<MintInstallationTokenOptions, 'appJwt'>,
  ): Promise<MintedToken> {
    const inst = await loadOwnedInstallation(app, o.installationId);
    assertActive(inst);
    const { perms, projects } = narrowAll(inst, o.permissions, o.projectIds);
    const claims = InstallationTokenClaimsSchema.parse(
      baseClaims(app, inst, `installation:${inst.id}`, perms, projects, o.audience),
    );
    return finishToken(claims, o.format ?? 'jwt', app.id, projects, prefixes.installation);
  }

  async function mintInstallationToken(o: MintInstallationTokenOptions): Promise<MintedToken> {
    const { app } = await verifyAppJwt(o.appJwt);
    return issueInstallationToken(app, o);
  }

  function parseAccessClaims(payload: unknown): AccessTokenClaims {
    const sub =
      typeof payload === 'object' && payload !== null && 'sub' in payload ? payload.sub : undefined;
    const schema =
      typeof sub === 'string' && sub.startsWith('installation:')
        ? InstallationTokenClaimsSchema
        : UserToServerClaimsSchema;
    const r = schema.safeParse(payload);
    if (!r.success) throw new PlatformError('invalid_token', 'access token claims malformed');
    return r.data;
  }

  async function decodeOpaque(token: string): Promise<AccessTokenClaims> {
    if (!store.findOpaqueToken) throw new PlatformError('invalid_token', 'access token invalid');
    const claims = await store.findOpaqueToken(await hashOpaqueToken(token));
    if (!claims) throw new PlatformError('invalid_token', 'access token invalid');
    if (claims.exp + skew < now()) throw new PlatformError('token_expired', 'access token expired');
    return claims;
  }

  async function verifyAccessToken(
    token: string,
    o: VerifyAccessTokenOptions = {},
  ): Promise<AccessTokenClaims> {
    let claims: AccessTokenClaims;
    if (looksLikeJwt(token)) {
      const v: JWTVerifyOptions = {
        ...baseVerify(),
        issuer,
        typ: ACCESS_TOKEN_TYP,
        ...(o.audience ? { audience: o.audience } : {}),
      };
      try {
        const { payload } = await jwtVerify(
          token,
          createLocalJWKSet({ keys: await publicKeys() }),
          v,
        );
        claims = parseAccessClaims(payload);
      } catch (e) {
        throw mapJoseError(e, 'access token');
      }
    } else {
      claims = await decodeOpaque(token);
      if (o.audience && !audienceMatches(claims.aud, o.audience))
        throw new PlatformError('invalid_token', 'access token audience mismatch');
    }
    if (await store.isJtiRevoked(claims.jti))
      throw new PlatformError('token_revoked', 'access token revoked');
    if (o.checkInstallation !== false) {
      const inst = await store.getInstallation(claims.codai_installation.id);
      if (!inst) throw new PlatformError('invalid_token', 'installation no longer exists');
      assertActive(inst);
    }
    if (o.permission) assertPermission(claims, o.permission);
    return claims;
  }

  async function revokeAccessToken(token: string): Promise<AccessTokenClaims> {
    const claims = await verifyAccessToken(token, { checkInstallation: false });
    await store.revokeJti(claims.jti, claims.exp);
    return claims;
  }

  async function mintUserToServer(o: MintUserToServerOptions): Promise<MintedToken> {
    assertActive(o.installation);
    const app = await store.getApp(o.installation.app_id);
    if (!app) throw new PlatformError('not_found', 'app not found');
    const effective = intersectPermissions(o.installation.permissions, o.userPermissions);
    const np = narrowPermissions(effective, o.requestedPermissions);
    if (!np.ok)
      throw new PlatformError(
        'permissions_exceeded',
        'requested permissions exceed user ∩ installation',
        { exceeded: np.exceeded },
      );
    const nj = narrowProjects(o.installation);
    const projects = nj.ok ? nj.projectIds : null;
    const claims = UserToServerClaimsSchema.parse({
      ...baseClaims(app, o.installation, `user:${o.userId}`, np.permissions, projects, o.audience),
      ...(o.act ? { act: o.act } : {}),
    });
    return finishToken(claims, o.format ?? 'jwt', app.id, projects, prefixes.user);
  }

  async function mintSessionToken(o: {
    installationId: string;
    userId: string;
    dest: string;
  }): Promise<{ token: string; expires_in: number }> {
    const inst = await store.getInstallation(o.installationId);
    if (!inst) throw new PlatformError('not_found', 'installation not found');
    assertActive(inst);
    const app = await store.getApp(inst.app_id);
    if (!app) throw new PlatformError('not_found', 'app not found');
    const iat = now();
    const claims = SessionTokenClaimsSchema.parse({
      iss: issuer,
      sub: `user:${o.userId}`,
      aud: app.client_id,
      dest: o.dest,
      iat,
      nbf: iat,
      exp: iat + SESSION_TOKEN_LIFETIME_SEC,
      jti: globalThis.crypto.randomUUID(),
      installation_id: inst.id,
    });
    return {
      token: await signJwt({ ...claims }, SESSION_TOKEN_TYP),
      expires_in: SESSION_TOKEN_LIFETIME_SEC,
    };
  }

  async function verifySessionToken(token: string, clientId: string): Promise<SessionTokenClaims> {
    const payload = await verifyWithKeys(
      token,
      await publicKeys(),
      { ...baseVerify(), issuer, audience: clientId, typ: SESSION_TOKEN_TYP },
      'session token',
    );
    const r = SessionTokenClaimsSchema.safeParse(payload);
    if (!r.success) throw new PlatformError('invalid_token', 'session token claims malformed');
    return r.data;
  }

  async function authenticateClient(assertion: string | undefined): Promise<App> {
    if (!assertion) throw new OAuthError('invalid_client', 'client_assertion required');
    try {
      return (await verifyAppJwt(assertion)).app;
    } catch (e) {
      throw new OAuthError(
        'invalid_client',
        e instanceof Error ? e.message : 'client authentication failed',
      );
    }
  }

  function requestedScope(scope: string | undefined): Permissions | undefined {
    if (scope === undefined || scope === '') return undefined;
    const p = scopeToPermissions(scope);
    if (!p)
      throw new OAuthError('invalid_scope', 'scope must be space-separated resource:level pairs');
    return p;
  }

  async function asOAuth<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (e) {
      if (e instanceof OAuthError) throw e;
      if (e instanceof PlatformError) {
        const code =
          e.code === 'permissions_exceeded' || e.code === 'projects_exceeded'
            ? 'invalid_scope'
            : 'invalid_grant';
        throw new OAuthError(code, e.message);
      }
      throw e;
    }
  }

  function toResponse(m: MintedToken): TokenExchangeResponse {
    return {
      access_token: m.token,
      issued_token_type: TOKEN_TYPES.access,
      token_type: 'Bearer',
      expires_in: m.expires_in,
      scope: m.claims.scope,
    };
  }

  async function exchangeSession(app: App, r: TokenExchangeRequest): Promise<MintedToken> {
    const s = await verifySessionToken(r.subject_token, app.client_id);
    const inst = await store.getInstallation(s.installation_id);
    if (!inst || inst.app_id !== app.id)
      throw new OAuthError('invalid_grant', 'session token is for another app');
    const userId = s.sub.slice('user:'.length);
    const userPermissions = await store.getUserPermissions(userId, inst.account);
    return mintUserToServer({
      installation: inst,
      userId,
      userPermissions,
      requestedPermissions: requestedScope(r.scope),
      audience: firstAudience(r),
    });
  }

  async function verifyPeerToken(token: string): Promise<{ iss: string; payload: JWTPayload }> {
    let iss: string | undefined;
    try {
      iss = decodeJwt(token).iss;
    } catch {
      throw new OAuthError('invalid_grant', 'subject token malformed');
    }
    const peer =
      iss && iss !== issuer && store.getTrustedIssuer ? await store.getTrustedIssuer(iss) : null;
    if (!iss || !peer) throw new OAuthError('invalid_grant', 'subject token issuer is not trusted');
    const payload = await verifyWithKeys(
      token,
      peer.jwks,
      { ...baseVerify(), issuer: iss, audience: [issuer, publicUrl, tokenEndpoint] },
      'subject token',
    );
    return { iss, payload };
  }

  async function exchangeDelegation(app: App, r: TokenExchangeRequest): Promise<MintedToken> {
    if (!r.installation_id)
      throw new OAuthError('invalid_request', 'installation_id required for delegation');
    const { iss, payload } = await verifyPeerToken(r.subject_token);
    const sub = typeof payload.sub === 'string' ? payload.sub : '';
    if (!sub.startsWith('user:'))
      throw new OAuthError('invalid_grant', 'subject token must represent a user');
    const userId = store.resolveFederatedUser
      ? await store.resolveFederatedUser(iss, sub.slice('user:'.length))
      : null;
    if (!userId) throw new OAuthError('invalid_grant', 'federated user is not linked');
    const inst = await store.getInstallation(r.installation_id);
    if (!inst || inst.app_id !== app.id)
      throw new OAuthError('invalid_grant', 'installation does not belong to the client');
    const actorSub = r.actor_token
      ? (await verifyPeerToken(r.actor_token)).payload.sub
      : payload.client_id;
    const prior = payload.act as ActorClaim | undefined;
    const act: ActorClaim = {
      sub: typeof actorSub === 'string' ? actorSub : iss,
      iss,
      ...(prior ? { act: prior } : {}),
    };
    const userPermissions = await store.getUserPermissions(userId, inst.account);
    return mintUserToServer({
      installation: inst,
      userId,
      userPermissions,
      requestedPermissions: requestedScope(r.scope),
      act,
      audience: firstAudience(r),
    });
  }

  async function exchangeToken(
    r: TokenExchangeRequest,
    ctx: { clientAssertion?: string | undefined } = {},
  ): Promise<TokenExchangeResponse> {
    return asOAuth(async () => {
      const app = await authenticateClient(ctx.clientAssertion ?? r.client_assertion);
      if (r.requested_token_type !== TOKEN_TYPES.access)
        throw new OAuthError('invalid_request', 'only access tokens can be requested');
      if (r.subject_token_type === TOKEN_TYPES.session)
        return toResponse(await exchangeSession(app, r));
      if (r.subject_token_type === TOKEN_TYPES.access || r.subject_token_type === TOKEN_TYPES.jwt)
        return toResponse(await exchangeDelegation(app, r));
      throw new OAuthError('invalid_request', 'unsupported subject_token_type');
    });
  }

  async function handleTokenRequest(
    form: URLSearchParams | Record<string, string | string[]>,
  ): Promise<TokenExchangeResponse> {
    const body = formToObject(form);
    if (body.grant_type === TOKEN_EXCHANGE_GRANT) {
      const r = TokenExchangeRequestSchema.safeParse(body);
      if (!r.success)
        throw new OAuthError('invalid_request', r.error.issues[0]?.message ?? 'invalid request');
      return exchangeToken(r.data);
    }
    if (body.grant_type === 'client_credentials') {
      const r = ClientCredentialsRequestSchema.safeParse(body);
      if (!r.success)
        throw new OAuthError('invalid_request', r.error.issues[0]?.message ?? 'invalid request');
      const req = r.data;
      return asOAuth(async () => {
        const app = await authenticateClient(req.client_assertion);
        if (!req.installation_id)
          throw new OAuthError('invalid_request', 'installation_id required');
        const m = await issueInstallationToken(app, {
          installationId: req.installation_id,
          permissions: requestedScope(req.scope),
          audience: firstAudience(req),
        });
        return toResponse(m);
      });
    }
    throw new OAuthError(
      'unsupported_grant_type',
      'grant_type must be token-exchange or client_credentials',
    );
  }

  function discovery(): DiscoveryDocument {
    return {
      issuer,
      platform_version: PLATFORM_VERSION,
      revisions_supported: [...SUPPORTED_REVISIONS],
      token_endpoint: tokenEndpoint,
      jwks_uri: `${restBase}/jwks.json`,
      installations_url: `${restBase}/app/installations`,
      manifest_conversion_url: `${restBase}/app-manifests/{code}/conversions`,
      events_supported: Object.keys(eventCatalog).sort(),
      token_formats_supported: store.saveOpaqueToken ? ['at+jwt', 'opaque'] : ['at+jwt'],
      signing_alg_values_supported: [...SIGNING_ALGS],
    };
  }

  return {
    issuer,
    basePath,
    tokenEndpoint,
    defaultAudience,
    eventCatalog,
    store,
    now,
    verifyAppJwt,
    mintInstallationToken,
    issueInstallationToken,
    verifyAccessToken,
    revokeAccessToken,
    mintUserToServer,
    mintSessionToken,
    verifySessionToken,
    exchangeToken,
    handleTokenRequest,
    jwks: async () => ({ keys: await publicKeys() }),
    discovery,
  };
}

/** Public URL of the discovery document for an issuer origin. */
export function discoveryUrl(origin: string): string {
  return trimSlash(origin) + DISCOVERY_PATH;
}
