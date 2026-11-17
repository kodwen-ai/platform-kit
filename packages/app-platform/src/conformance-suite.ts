/**
 * Runnable conformance suite (plain async checks, no test runner) for any `/platform/v1` implementation.
 */
import { createLocalJWKSet, jwtVerify, type JSONWebKeySet } from 'jose';
import { signAppJwt } from './appjwt';
import { ErrorEnvelopeSchema } from './errors';
import type { PrivateKeyInput, SigningAlg } from './keys';
import { PlatformClient, PlatformClientError } from './platform-client';
import { isSubset, PermissionsSchema, type Permissions } from './permissions';
import {
  AccessTokenResponseSchema,
  DiscoveryDocumentSchema,
  HookDeliveryListSchema,
  JwksSchema,
} from './rest';
import {
  ACCESS_TOKEN_MAX_LIFETIME_SEC,
  ACCESS_TOKEN_TYP,
  InstallationTokenClaimsSchema,
} from './tokens';
import { DEFAULT_BASE_PATH, DISCOVERY_PATH, PLATFORM_REVISION, REVISION_HEADER } from './version';

/** Options of {@link runConformance}. */
export interface ConformanceOptions {
  baseUrl: string;
  appId: string;
  privateKey: PrivateKeyInput;
  alg: SigningAlg;
  kid?: string;
  installationId: string;
  /** Audience the installation token should carry (also the `/installation/*` audience). */
  audience: string;
  basePath?: string;
  fetch?: typeof fetch;
  revision?: string;
}

/** One check result. */
export interface ConformanceResult {
  id: string;
  title: string;
  ok: boolean;
  detail: string;
}

/** Suite outcome. */
export interface ConformanceReport {
  passed: number;
  failed: number;
  results: ConformanceResult[];
}

interface Ctx {
  o: ConformanceOptions;
  client: PlatformClient;
  restBase: string;
  fetch: typeof fetch;
  jwks?: JSONWebKeySet;
  token?: string;
  permissions?: Permissions;
}

type Check = { id: string; title: string; run: (ctx: Ctx) => Promise<string> };

class CheckFailure extends Error {}

function expect(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new CheckFailure(msg);
}

async function status(
  ctx: Ctx,
  path: string,
  init: RequestInit = {},
): Promise<{ status: number; body: unknown; headers: Headers }> {
  const headers = new Headers(init.headers);
  if (!headers.has(REVISION_HEADER))
    headers.set(REVISION_HEADER, ctx.o.revision ?? PLATFORM_REVISION);
  const url = path.startsWith('/.well-known')
    ? ctx.o.baseUrl.replace(/\/$/, '') + path
    : ctx.restBase + path;
  const res = await ctx.fetch(url, { ...init, headers });
  const text = await res.text();
  let body: unknown = text;
  try {
    body = text ? (JSON.parse(text) as unknown) : null;
  } catch {
    /* non-JSON body is kept as text */
  }
  return { status: res.status, body, headers: res.headers };
}

function bearer(token: string): RequestInit {
  return { headers: { authorization: `Bearer ${token}` } };
}

function envelopeCode(body: unknown): string | undefined {
  const r = ErrorEnvelopeSchema.safeParse(body);
  return r.success ? r.data.error.code : undefined;
}

async function signedAppJwt(
  ctx: Ctx,
  over: { lifetimeSec?: number; now?: number },
): Promise<string> {
  return signAppJwt({
    appId: ctx.o.appId,
    privateKey: ctx.o.privateKey,
    alg: ctx.o.alg,
    kid: ctx.o.kid,
    audience: `${ctx.restBase}/oauth/token`,
    backdateSec: 0,
    ...over,
  });
}

async function mintToken(ctx: Ctx): Promise<string> {
  if (ctx.token) return ctx.token;
  const r = await ctx.client.createInstallationToken(ctx.o.installationId, {
    audience: ctx.o.audience,
  });
  ctx.token = r.token;
  ctx.permissions = r.permissions;
  return r.token;
}

const CHECKS: Check[] = [
  {
    id: 'discovery',
    title: 'discovery document is valid',
    run: async (ctx) => {
      const r = await status(ctx, DISCOVERY_PATH);
      expect(r.status === 200, `status ${r.status}`);
      const d = DiscoveryDocumentSchema.safeParse(r.body);
      expect(d.success, `schema: ${d.success ? '' : d.error.issues[0]?.message}`);
      expect(
        d.data.revisions_supported.includes(ctx.o.revision ?? PLATFORM_REVISION),
        'revision not supported',
      );
      return `issuer ${d.data.issuer}`;
    },
  },
  {
    id: 'jwks',
    title: 'JWKS reachable and keys importable',
    run: async (ctx) => {
      const r = await status(ctx, '/jwks.json');
      expect(r.status === 200, `status ${r.status}`);
      const j = JwksSchema.safeParse(r.body);
      expect(j.success, 'JWKS shape invalid');
      const priv = j.data.keys.find((k) => 'd' in k || 'p' in k);
      expect(!priv, 'JWKS exposes private key material');
      ctx.jwks = j.data as unknown as JSONWebKeySet;
      return `${j.data.keys.length} key(s)`;
    },
  },
  {
    id: 'app-jwt-accepted',
    title: 'app JWT accepted at GET /app',
    run: async (ctx) => {
      const app = await ctx.client.getApp();
      expect(
        app.id === ctx.o.appId || app.client_id === ctx.o.appId,
        `GET /app returned ${app.id}`,
      );
      return `app ${app.slug}`;
    },
  },
  {
    id: 'app-jwt-expired',
    title: 'expired app JWT rejected (401)',
    run: async (ctx) => {
      const jwt = await signedAppJwt(ctx, {
        now: Math.floor(Date.now() / 1000) - 3600,
        lifetimeSec: 300,
      });
      const r = await status(ctx, '/app', bearer(jwt));
      expect(r.status === 401, `status ${r.status}`);
      return `code ${envelopeCode(r.body)}`;
    },
  },
  {
    id: 'app-jwt-too-long',
    title: 'app JWT with lifetime > 600 s rejected (401)',
    run: async (ctx) => {
      const jwt = await signedAppJwt(ctx, { lifetimeSec: 3600 });
      const r = await status(ctx, '/app', bearer(jwt));
      expect(r.status === 401, `status ${r.status}`);
      return `code ${envelopeCode(r.body)}`;
    },
  },
  {
    id: 'installation-token',
    title: 'installation token minted with RFC 9068 claims',
    run: async (ctx) => {
      expect(ctx.jwks, 'JWKS unavailable');
      const token = await mintToken(ctx);
      const { payload, protectedHeader } = await jwtVerify(token, createLocalJWKSet(ctx.jwks), {
        audience: ctx.o.audience,
        typ: ACCESS_TOKEN_TYP,
      });
      const c = InstallationTokenClaimsSchema.safeParse(payload);
      expect(c.success, `claims: ${c.success ? '' : c.error.issues[0]?.message}`);
      expect(c.data.sub === `installation:${ctx.o.installationId}`, `sub ${c.data.sub}`);
      expect(c.data.exp - c.data.iat <= ACCESS_TOKEN_MAX_LIFETIME_SEC, 'exp > 3600 s');
      expect(c.data.jti.length > 0, 'jti missing');
      return `typ ${protectedHeader.typ}, ttl ${c.data.exp - c.data.iat}s`;
    },
  },
  {
    id: 'narrowing',
    title: 'narrowing works and over-asking is rejected',
    run: async (ctx) => {
      await mintToken(ctx);
      const granted = ctx.permissions ?? {};
      const first = Object.entries(granted)[0];
      expect(first, 'installation has no permissions to narrow');
      const narrow = { [first[0]]: 'read' as const };
      const ok = AccessTokenResponseSchema.parse(
        await ctx.client.createInstallationToken(ctx.o.installationId, {
          permissions: narrow,
          audience: ctx.o.audience,
        }),
      );
      expect(
        isSubset(ok.permissions, narrow) && isSubset(narrow, ok.permissions),
        'narrowed permissions differ',
      );
      const over = PermissionsSchema.parse({ ...granted, conformance_probe_resource: 'admin' });
      try {
        await ctx.client.createInstallationToken(ctx.o.installationId, { permissions: over });
      } catch (e) {
        expect(
          e instanceof PlatformClientError && (e.status === 422 || e.status === 403),
          `over-ask status ${e instanceof PlatformClientError ? e.status : 'error'}`,
        );
        return `over-ask → ${e.status} ${e.code}`;
      }
      throw new CheckFailure('over-asking was accepted');
    },
  },
  {
    id: 'revocation',
    title: 'revoked token is rejected afterwards',
    run: async (ctx) => {
      const t = (
        await ctx.client.createInstallationToken(ctx.o.installationId, { audience: ctx.o.audience })
      ).token;
      const before = await status(ctx, '/installation/projects', bearer(t));
      expect(before.status === 200, `pre-revoke status ${before.status}`);
      const del = await status(ctx, '/installation/token', { ...bearer(t), method: 'DELETE' });
      expect(del.status === 204, `DELETE status ${del.status}`);
      const after = await status(ctx, '/installation/projects', bearer(t));
      expect(after.status === 401, `post-revoke status ${after.status}`);
      return `code ${envelopeCode(after.body)}`;
    },
  },
  {
    id: 'unknown-revision',
    title: 'unknown revision header → 400 unsupported_revision',
    run: async (ctx) => {
      const r = await status(ctx, '/app', {
        headers: {
          [REVISION_HEADER]: '1999-01-01',
          authorization: `Bearer ${await ctx.client.appJwt()}`,
        },
      });
      expect(r.status === 400, `status ${r.status}`);
      expect(envelopeCode(r.body) === 'unsupported_revision', `code ${envelopeCode(r.body)}`);
      return 'rejected';
    },
  },
  {
    id: 'error-envelope',
    title: 'errors use the { error: { code, message } } envelope',
    run: async (ctx) => {
      const r = await status(ctx, '/app');
      expect(r.status === 401, `status ${r.status}`);
      expect(ErrorEnvelopeSchema.safeParse(r.body).success, 'envelope shape invalid');
      const nf = await status(
        ctx,
        `/app/installations/${encodeURIComponent('conformance-missing-0')}`,
        bearer(await ctx.client.appJwt()),
      );
      expect(
        nf.status === 404 && ErrorEnvelopeSchema.safeParse(nf.body).success,
        `404 envelope (status ${nf.status})`,
      );
      return `codes ${envelopeCode(r.body)}, ${envelopeCode(nf.body)}`;
    },
  },
  {
    id: 'deliveries',
    title: 'webhook deliveries list has the documented shape',
    run: async (ctx) => {
      const d = HookDeliveryListSchema.safeParse(await ctx.client.listDeliveries());
      expect(d.success, `shape: ${d.success ? '' : d.error.issues[0]?.message}`);
      return `${d.data.deliveries.length} deliveries`;
    },
  },
];

function describeError(e: unknown): string {
  if (e instanceof CheckFailure) return e.message;
  if (e instanceof PlatformClientError) return `HTTP ${e.status} ${e.code ?? ''}`.trim();
  return e instanceof Error ? `${e.name}: ${e.message}` : 'unknown error';
}

/** Run every conformance check against a live (or in-process) platform implementation. */
export async function runConformance(o: ConformanceOptions): Promise<ConformanceReport> {
  const fetchImpl = o.fetch ?? ((...a: Parameters<typeof fetch>) => globalThis.fetch(...a));
  const basePath = o.basePath ?? DEFAULT_BASE_PATH;
  const client = new PlatformClient({
    baseUrl: o.baseUrl,
    appId: o.appId,
    privateKey: o.privateKey,
    alg: o.alg,
    basePath,
    fetch: fetchImpl,
    revision: o.revision ?? PLATFORM_REVISION,
    maxRetries: 1,
    ...(o.kid ? { kid: o.kid } : {}),
  });
  const ctx: Ctx = {
    o,
    client,
    restBase: o.baseUrl.replace(/\/$/, '') + basePath,
    fetch: fetchImpl,
  };
  const results: ConformanceResult[] = [];
  for (const c of CHECKS) {
    try {
      results.push({ id: c.id, title: c.title, ok: true, detail: await c.run(ctx) });
    } catch (e) {
      results.push({ id: c.id, title: c.title, ok: false, detail: describeError(e) });
    }
  }
  const passed = results.filter((r) => r.ok).length;
  return { passed, failed: results.length - passed, results };
}

/** Ids of every check, in run order. */
export const CONFORMANCE_CHECK_IDS: readonly string[] = CHECKS.map((c) => c.id);

/** Render a report as a fixed-width text table (no secrets are ever part of a report). */
export function formatConformanceReport(r: ConformanceReport): string {
  const w = Math.max(...r.results.map((x) => x.id.length), 2);
  const lines = r.results.map(
    (x) => `${x.ok ? 'PASS' : 'FAIL'}  ${x.id.padEnd(w)}  ${x.title} — ${x.detail}`,
  );
  return [...lines, '', `${r.passed} passed, ${r.failed} failed`].join('\n');
}
