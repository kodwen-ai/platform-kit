/**
 * Hono adapter: mounts the `/platform/v1` REST surface backed by a {@link PlatformServer}.
 * Hono docs: https://hono.dev/docs/api/routing , https://hono.dev/docs/guides/middleware
 */
import { Hono, type Context, type MiddlewareHandler } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { OAuthError, PlatformError } from './errors';
import { bearerToken, errorToBody } from './http';
import type { App } from './manifest';
import type { PermissionRequirement, PlatformServer } from './platform-server';
import { AccessTokenRequestSchema, SuspendRequestSchema } from './rest';
import type { WebhookDeliveryPort } from './store';
import type { AccessTokenClaims } from './tokens';
import {
  DEFAULT_BASE_PATH,
  DISCOVERY_PATH,
  isSupportedRevision,
  PLATFORM_REVISION,
  REVISION_HEADER,
  SUPPORTED_REVISIONS,
} from './version';

/** Context variables set by the platform middleware. */
export interface PlatformVariables {
  platformClaims: AccessTokenClaims;
  platformApp: App;
  platformRevision: string;
  requestId: string;
}

/** Hono env of the platform routes. */
export type PlatformEnv = { Variables: PlatformVariables };

/** Options of {@link platformRoutes}. */
export interface PlatformRoutesOptions {
  basePath?: string;
  /** Webhook delivery log; without it the deliveries list is empty and redelivery 404s. */
  deliveries?: WebhookDeliveryPort;
  /** Audience accepted on `/installation/*` routes (default: server.defaultAudience). */
  audience?: string | string[];
}

type Ctx = Context<PlatformEnv>;

function send(c: Ctx, body: unknown, status: number): Response {
  return c.json(body as object, status as ContentfulStatusCode);
}

function fail(c: Ctx, e: unknown): Response {
  const { status, body } = errorToBody(e, c.get('requestId'));
  if (status === 401) c.header('www-authenticate', 'Bearer realm="codai-platform"');
  if (e instanceof OAuthError) c.header('cache-control', 'no-store');
  return send(c, body, status);
}

/** Middleware: negotiate the dated revision (reject unknown with 400, echo the chosen one) and assign a request id. */
export function revisionNegotiation(): MiddlewareHandler<PlatformEnv> {
  return async (c, next) => {
    const requestId = c.req.header('x-request-id') ?? globalThis.crypto.randomUUID();
    c.set('requestId', requestId);
    c.header('x-request-id', requestId);
    const asked = c.req.header(REVISION_HEADER);
    if (asked !== undefined && !isSupportedRevision(asked)) {
      c.header(REVISION_HEADER, PLATFORM_REVISION);
      return fail(
        c,
        new PlatformError(
          'unsupported_revision',
          `unsupported revision ${asked}; supported: ${SUPPORTED_REVISIONS.join(', ')}`,
        ),
      );
    }
    const revision = asked ?? PLATFORM_REVISION;
    c.set('platformRevision', revision);
    c.header(REVISION_HEADER, revision);
    await next();
    c.res.headers.set(REVISION_HEADER, revision);
  };
}

/** Middleware: require a valid platform access token (and optionally a permission); sets `c.var.platformClaims`. */
export function requirePlatformToken(
  server: PlatformServer,
  o: { audience?: string | string[]; permission?: PermissionRequirement } = {},
): MiddlewareHandler<PlatformEnv> {
  return async (c, next) => {
    const token = bearerToken(c.req.header('authorization'));
    if (!token) return fail(c, new PlatformError('unauthenticated', 'missing bearer token'));
    try {
      c.set(
        'platformClaims',
        await server.verifyAccessToken(token, { audience: o.audience, permission: o.permission }),
      );
    } catch (e) {
      return fail(c, e);
    }
    await next();
  };
}

/** Middleware: require a valid app JWT; sets `c.var.platformApp`. */
export function requireAppJwt(server: PlatformServer): MiddlewareHandler<PlatformEnv> {
  return async (c, next) => {
    const token = bearerToken(c.req.header('authorization'));
    if (!token) return fail(c, new PlatformError('unauthenticated', 'missing app JWT'));
    try {
      c.set('platformApp', (await server.verifyAppJwt(token)).app);
    } catch (e) {
      return fail(c, e);
    }
    await next();
  };
}

async function jsonBody(c: Ctx): Promise<unknown> {
  const text = await c.req.text();
  if (text.trim() === '') return {};
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new PlatformError('bad_request', 'body is not valid JSON');
  }
}

function pageOpts(c: Ctx): { cursor?: string; limit?: number } {
  const cursor = c.req.query('cursor');
  const perPage = Number.parseInt(c.req.query('per_page') ?? '', 10);
  return { ...(cursor ? { cursor } : {}), ...(Number.isFinite(perPage) ? { limit: perPage } : {}) };
}

function validationError(issues: { message: string }[]): PlatformError {
  return new PlatformError('validation_failed', issues[0]?.message ?? 'invalid body');
}

async function ownedInstallation(server: PlatformServer, c: Ctx) {
  const inst = await server.store.getInstallation(c.req.param('id') ?? '');
  if (!inst || inst.app_id !== c.var.platformApp.id)
    throw new PlatformError('not_found', 'installation not found');
  return inst;
}

function appRoutes(server: PlatformServer, o: PlatformRoutesOptions): Hono<PlatformEnv> {
  const r = new Hono<PlatformEnv>();
  r.use('/app', requireAppJwt(server));
  r.use('/app/*', requireAppJwt(server));
  r.get('/app', (c) => send(c, c.var.platformApp, 200));
  r.get('/app/installations', async (c) => {
    const page = await server.store.listInstallations(c.var.platformApp.id, pageOpts(c));
    return send(c, { installations: page.items, next_cursor: page.next_cursor }, 200);
  });
  r.get('/app/installations/:id', async (c) => send(c, await ownedInstallation(server, c), 200));
  r.post('/app/installations/:id/access_tokens', async (c) => {
    const parsed = AccessTokenRequestSchema.safeParse(await jsonBody(c));
    if (!parsed.success) throw validationError(parsed.error.issues);
    const m = await server.issueInstallationToken(c.var.platformApp, {
      installationId: c.req.param('id'),
      permissions: parsed.data.permissions,
      projectIds: parsed.data.project_ids,
      audience: parsed.data.audience,
    });
    return send(
      c,
      {
        token: m.token,
        expires_at: m.expires_at,
        permissions: m.permissions,
        ...(m.project_ids ? { project_ids: m.project_ids } : {}),
      },
      201,
    );
  });
  r.patch('/app/installations/:id/suspended', async (c) => {
    const parsed = SuspendRequestSchema.safeParse(await jsonBody(c));
    if (!parsed.success) throw validationError(parsed.error.issues);
    const inst = await ownedInstallation(server, c);
    const next = await server.store.setInstallationSuspended(inst.id, parsed.data.suspended, {
      kind: 'app',
      id: c.var.platformApp.id,
    });
    return send(c, next, 200);
  });
  r.get('/app/hook/deliveries', async (c) => {
    if (!o.deliveries) return send(c, { deliveries: [], next_cursor: null }, 200);
    const page = await o.deliveries.listDeliveries(c.var.platformApp.id, pageOpts(c));
    return send(c, { deliveries: page.items, next_cursor: page.next_cursor }, 200);
  });
  r.post('/app/hook/deliveries/:id/attempts', async (c) => {
    const id = c.req.param('id');
    if (!o.deliveries || !(await o.deliveries.redeliver(c.var.platformApp.id, id)))
      throw new PlatformError('not_found', 'delivery not found');
    return send(c, { delivery_id: id, status: 'queued' }, 202);
  });
  return r;
}

function installationRoutes(server: PlatformServer, o: PlatformRoutesOptions): Hono<PlatformEnv> {
  const r = new Hono<PlatformEnv>();
  r.use(
    '/installation/*',
    requirePlatformToken(server, { audience: o.audience ?? server.defaultAudience }),
  );
  r.delete('/installation/token', async (c) => {
    await server.store.revokeJti(c.var.platformClaims.jti, c.var.platformClaims.exp);
    return c.body(null, 204);
  });
  r.get('/installation/projects', async (c) => {
    const claims = c.var.platformClaims.codai_installation;
    const projects = await server.store.listInstallationProjects(
      claims.id,
      claims.project_ids ?? null,
    );
    return send(c, { projects, total_count: projects.length }, 200);
  });
  return r;
}

/** Build the Hono app serving discovery, JWKS, token endpoint and the `/platform/v1` REST routes. */
export function platformRoutes(
  server: PlatformServer,
  o: PlatformRoutesOptions = {},
): Hono<PlatformEnv> {
  const basePath = o.basePath ?? server.basePath ?? DEFAULT_BASE_PATH;
  const app = new Hono<PlatformEnv>();
  app.onError((e, c) => fail(c, e));
  app.notFound((c) => fail(c, new PlatformError('not_found', 'route not found')));
  app.use('*', revisionNegotiation());
  app.get(DISCOVERY_PATH, (c) => send(c, server.discovery(), 200));
  app.get(`${basePath}/jwks.json`, async (c) => {
    c.header('cache-control', 'public, max-age=300');
    return send(c, await server.jwks(), 200);
  });
  app.post(`${basePath}/oauth/token`, async (c) => {
    c.header('cache-control', 'no-store');
    const isJson = (c.req.header('content-type') ?? '').includes('application/json');
    const form = isJson
      ? ((await jsonBody(c)) as Record<string, string>)
      : new URLSearchParams(await c.req.text());
    return send(c, await server.handleTokenRequest(form), 200);
  });
  app.route(basePath, installationRoutes(server, o));
  app.route(basePath, appRoutes(server, o));
  return app;
}
