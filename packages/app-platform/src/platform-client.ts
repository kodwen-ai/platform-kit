import { signAppJwt } from './appjwt';
import { ErrorEnvelopeSchema, type ErrorEnvelope } from './errors';
import type { Installation } from './installation';
import type { PrivateKeyInput, SigningAlg } from './keys';
import type { App } from './manifest';
import type { Permissions } from './permissions';
import {
  buildPath,
  PLATFORM_ROUTES,
  type AccessTokenRequest,
  type AccessTokenResponse,
  type DiscoveryDocument,
  type HookDelivery,
  type Project,
} from './rest';
import { DEFAULT_BASE_PATH, DISCOVERY_PATH, PLATFORM_REVISION, REVISION_HEADER } from './version';

/** Options of {@link PlatformClient}. */
export interface PlatformClientOptions {
  /** Issuer origin, e.g. `https://ai.codai.ro`. */
  baseUrl: string;
  appId: string;
  privateKey: PrivateKeyInput;
  alg: SigningAlg;
  kid?: string;
  basePath?: string;
  fetch?: typeof fetch;
  revision?: string;
  /** App JWT `aud` (default: `<baseUrl><basePath>/oauth/token`). */
  appJwtAudience?: string;
  /** Max retries on 429/5xx/network errors (default 3). */
  maxRetries?: number;
  /** Injectable sleep (tests). */
  sleep?: (ms: number) => Promise<void>;
  /** Injectable clock in ms (tests). */
  now?: () => number;
}

/** Non-2xx response from the platform. */
export class PlatformClientError extends Error {
  readonly status: number;
  readonly envelope: ErrorEnvelope | null;
  readonly body: unknown;

  constructor(status: number, body: unknown) {
    const env = ErrorEnvelopeSchema.safeParse(body);
    super(
      env.success
        ? `${env.data.error.code}: ${env.data.error.message}`
        : `platform request failed with ${status}`,
    );
    this.name = 'PlatformClientError';
    this.status = status;
    this.envelope = env.success ? env.data : null;
    this.body = body;
  }

  /** Error code from the envelope, if any. */
  get code(): string | undefined {
    return this.envelope?.error.code;
  }
}

/** Options of a token request that also key the installation-token cache. */
export interface InstallationTokenOptions {
  permissions?: Permissions;
  project_ids?: string[];
  audience?: string;
}

const REFRESH_MARGIN_MS = 5 * 60 * 1000;
const APP_JWT_LIFETIME_SEC = 540;
const RETRYABLE = new Set([429, 500, 502, 503, 504]);

function defaultSleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function retryAfterMs(res: Response, attempt: number): number {
  const ra = res.headers.get('retry-after');
  const sec = ra ? Number.parseInt(ra, 10) : Number.NaN;
  if (Number.isFinite(sec) && sec >= 0) return Math.min(sec * 1000, 30_000);
  return Math.min(250 * 2 ** attempt, 8_000);
}

async function readBody(res: Response): Promise<unknown> {
  if (res.status === 204) return null;
  const text = await res.text();
  if (!text) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

/** Typed client for the `/platform/v1` REST surface, acting as an app. */
export class PlatformClient {
  private readonly o: Required<Omit<PlatformClientOptions, 'kid' | 'appJwtAudience'>> & {
    kid?: string;
    appJwtAudience: string;
  };
  private appJwtCache: { jwt: string; exp: number } | null = null;
  private readonly tokenCache = new Map<string, AccessTokenResponse>();

  constructor(opts: PlatformClientOptions) {
    const baseUrl = opts.baseUrl.replace(/\/$/, '');
    const basePath = opts.basePath ?? DEFAULT_BASE_PATH;
    this.o = {
      ...opts,
      baseUrl,
      basePath,
      fetch: opts.fetch ?? ((...a) => globalThis.fetch(...a)),
      revision: opts.revision ?? PLATFORM_REVISION,
      appJwtAudience: opts.appJwtAudience ?? `${baseUrl}${basePath}/oauth/token`,
      maxRetries: opts.maxRetries ?? 3,
      sleep: opts.sleep ?? defaultSleep,
      now: opts.now ?? (() => Date.now()),
    };
  }

  /** Base URL of the REST surface (`<baseUrl><basePath>`). */
  get restBase(): string {
    return this.o.baseUrl + this.o.basePath;
  }

  /** A fresh-enough app JWT (≤ 9 min lifetime, re-signed one minute before expiry). */
  async appJwt(): Promise<string> {
    const nowSec = Math.floor(this.o.now() / 1000);
    if (this.appJwtCache && this.appJwtCache.exp - 60 > nowSec) return this.appJwtCache.jwt;
    const jwt = await signAppJwt({
      appId: this.o.appId,
      privateKey: this.o.privateKey,
      alg: this.o.alg,
      kid: this.o.kid,
      audience: this.o.appJwtAudience,
      now: nowSec,
      lifetimeSec: APP_JWT_LIFETIME_SEC,
    });
    this.appJwtCache = { jwt, exp: nowSec - 30 + APP_JWT_LIFETIME_SEC };
    return jwt;
  }

  /** Fetch with revision header and retries on 429/5xx/network errors. */
  async rawFetch(url: string, init: RequestInit = {}): Promise<Response> {
    const headers = new Headers(init.headers);
    if (!headers.has(REVISION_HEADER)) headers.set(REVISION_HEADER, this.o.revision);
    headers.set('accept', 'application/json');
    for (let attempt = 0; ; attempt++) {
      let res: Response;
      try {
        res = await this.o.fetch(url, { ...init, headers });
      } catch (e) {
        if (attempt >= this.o.maxRetries) throw e;
        await this.o.sleep(Math.min(250 * 2 ** attempt, 8_000));
        continue;
      }
      if (!RETRYABLE.has(res.status) || attempt >= this.o.maxRetries) return res;
      await this.o.sleep(retryAfterMs(res, attempt));
    }
  }

  private async request<T>(
    method: string,
    path: string,
    auth: string | null,
    body?: unknown,
    params: Record<string, string> = {},
  ): Promise<T> {
    const headers: Record<string, string> = {};
    if (auth) headers.authorization = `Bearer ${auth}`;
    if (body !== undefined) headers['content-type'] = 'application/json';
    const url =
      path === DISCOVERY_PATH ? this.o.baseUrl + path : this.restBase + buildPath(path, params);
    const res = await this.rawFetch(url, {
      method,
      headers,
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    const data = await readBody(res);
    if (!res.ok) throw new PlatformClientError(res.status, data);
    return data as T;
  }

  private async asApp<T>(
    route: keyof typeof PLATFORM_ROUTES,
    params?: Record<string, string>,
    body?: unknown,
    query = '',
  ): Promise<T> {
    const r = PLATFORM_ROUTES[route];
    return this.request<T>(r.method, r.path + query, await this.appJwt(), body, params);
  }

  /** `GET /.well-known/codai-platform`. */
  discovery(): Promise<DiscoveryDocument> {
    return this.request('GET', DISCOVERY_PATH, null);
  }

  /** `GET /jwks.json`. */
  jwks(): Promise<{ keys: Record<string, unknown>[] }> {
    return this.request('GET', PLATFORM_ROUTES.jwks.path, null);
  }

  /** `GET /app` as the app. */
  getApp(): Promise<App> {
    return this.asApp('app');
  }

  /** `GET /app/installations`. */
  listInstallations(
    page: { cursor?: string; per_page?: number } = {},
  ): Promise<{ installations: Installation[]; next_cursor: string | null }> {
    const q = new URLSearchParams();
    if (page.cursor) q.set('cursor', page.cursor);
    if (page.per_page) q.set('per_page', String(page.per_page));
    const qs = q.toString();
    return this.asApp('listInstallations', {}, undefined, qs ? `?${qs}` : '');
  }

  /** `GET /app/installations/{id}`. */
  getInstallation(id: string): Promise<Installation> {
    return this.asApp('getInstallation', { id });
  }

  /** `POST /app/installations/{id}/access_tokens` (uncached). */
  createInstallationToken(id: string, body: AccessTokenRequest = {}): Promise<AccessTokenResponse> {
    return this.asApp('createAccessToken', { id }, body);
  }

  /** Cached installation token, refreshed 5 min before expiry. */
  async installationToken(id: string, o: InstallationTokenOptions = {}): Promise<string> {
    const key = JSON.stringify([
      id,
      o.permissions ?? null,
      o.project_ids ?? null,
      o.audience ?? null,
    ]);
    const hit = this.tokenCache.get(key);
    if (hit && Date.parse(hit.expires_at) - REFRESH_MARGIN_MS > this.o.now()) return hit.token;
    const fresh = await this.createInstallationToken(id, o);
    this.tokenCache.set(key, fresh);
    return fresh.token;
  }

  /** Drop cached installation tokens (all, or for one installation). */
  clearTokenCache(installationId?: string): void {
    for (const k of [...this.tokenCache.keys()])
      if (!installationId || k.startsWith(JSON.stringify([installationId]).slice(0, -1)))
        this.tokenCache.delete(k);
  }

  /** `PATCH /app/installations/{id}/suspended`. */
  setSuspended(id: string, suspended: boolean, reason?: string): Promise<Installation> {
    return this.asApp('suspendInstallation', { id }, { suspended, ...(reason ? { reason } : {}) });
  }

  /** `GET /app/hook/deliveries`. */
  listDeliveries(): Promise<{ deliveries: HookDelivery[]; next_cursor: string | null }> {
    return this.asApp('listDeliveries');
  }

  /** `POST /app/hook/deliveries/{id}/attempts`. */
  redeliver(deliveryId: string): Promise<{ delivery_id: string; status: 'queued' }> {
    return this.asApp('redeliver', { id: deliveryId });
  }

  /** Fetch wrapper acting as an installation (Bearer + revision headers, cached token). */
  asInstallation(id: string, o: InstallationTokenOptions = {}): InstallationFetch {
    const wrapped = async (path: string, init: RequestInit = {}): Promise<Response> => {
      const token = await this.installationToken(id, o);
      const headers = new Headers(init.headers);
      headers.set('authorization', `Bearer ${token}`);
      const url = /^https?:\/\//.test(path) ? path : this.restBase + path;
      return this.rawFetch(url, { ...init, headers });
    };
    return Object.assign(wrapped, {
      listProjects: async (): Promise<{ projects: Project[]; total_count: number }> => {
        const res = await wrapped(PLATFORM_ROUTES.listInstallationProjects.path);
        const data = await readBody(res);
        if (!res.ok) throw new PlatformClientError(res.status, data);
        return data as { projects: Project[]; total_count: number };
      },
      revoke: async (): Promise<void> => {
        const res = await wrapped(PLATFORM_ROUTES.revokeInstallationToken.path, {
          method: 'DELETE',
        });
        if (!res.ok && res.status !== 401)
          throw new PlatformClientError(res.status, await readBody(res));
        this.clearTokenCache(id);
      },
    });
  }
}

/** Fetch bound to one installation, plus typed helpers. */
export type InstallationFetch = ((path: string, init?: RequestInit) => Promise<Response>) & {
  listProjects(): Promise<{ projects: Project[]; total_count: number }>;
  /** `DELETE /installation/token` for the cached token, then drop it from the cache. */
  revoke(): Promise<void>;
};
