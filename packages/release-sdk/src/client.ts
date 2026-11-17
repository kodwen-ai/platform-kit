import type { z } from 'zod';
import {
  AppSchema,
  type CreateProductInput,
  CreateProductInputSchema,
  type CreateReleaseInput,
  CreateReleaseInputSchema,
  ErrorBodySchema,
  pageSchema,
  type Product,
  ProductSchema,
  type Release,
  type RolloutAction,
  RolloutActionSchema,
  ReleaseSchema,
  type App,
} from './schemas';

/** Default API base. */
export const DEFAULT_BASE_URL = 'https://api.codai.ro/v1/releases';
/** Default `Codai-Platform-Version`. */
export const DEFAULT_REVISION = '2026-10-19';

/** Minimal fetch signature (inject a fake in tests). */
export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

/** Error from the Release Manager API (or a response that broke the contract). */
export class ReleaseApiError extends Error {
  override readonly name = 'ReleaseApiError';
  constructor(
    readonly code: string,
    readonly status: number,
    message: string,
    readonly requestId?: string,
  ) {
    super(`${code} (HTTP ${status}): ${message}`);
  }
}

/** Options of `ReleaseClient`. Exactly one of `token` / `getToken`. */
export interface ReleaseClientOptions {
  baseUrl?: string;
  token?: string;
  getToken?: () => Promise<string>;
  fetch?: FetchLike;
  revision?: string;
  /** Retries on 429/5xx/network errors (default 3). */
  maxRetries?: number;
  /** Base backoff in ms, doubled per attempt, capped by Retry-After when present (default 250). */
  backoffMs?: number;
  /** Injectable sleep (tests). */
  sleep?: (ms: number) => Promise<void>;
}

/** One page of results. */
export interface Page<T> {
  data: T[];
  next_cursor: string | null;
}

/** Listing options. */
export interface ListOptions {
  cursor?: string;
  limit?: number;
}

interface Req {
  method: 'GET' | 'POST';
  path: string;
  query?: Record<string, string | number | undefined>;
  body?: unknown;
  idempotencyKey?: string;
}

function retryAfterMs(res: Response): number | undefined {
  const h = res.headers.get('retry-after');
  if (!h) return undefined;
  const s = Number(h);
  if (Number.isFinite(s)) return s * 1000;
  const at = Date.parse(h);
  return Number.isNaN(at) ? undefined : Math.max(0, at - Date.now());
}

function newIdempotencyKey(): string {
  return globalThis.crypto.randomUUID();
}

/** Typed client of the codai Release Manager API. */
export class ReleaseClient {
  private readonly baseUrl: string;
  private readonly fetchImpl: FetchLike;
  private readonly getToken: () => Promise<string>;
  private readonly revision: string;
  private readonly maxRetries: number;
  private readonly backoffMs: number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(opts: ReleaseClientOptions) {
    const { token, getToken } = opts;
    if ((token === undefined) === (getToken === undefined))
      throw new TypeError('pass exactly one of token or getToken');
    this.getToken = getToken ?? (async () => token as string);
    this.baseUrl = (opts.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, '');
    this.fetchImpl = opts.fetch ?? ((u, i) => globalThis.fetch(u, i));
    this.revision = opts.revision ?? DEFAULT_REVISION;
    this.maxRetries = opts.maxRetries ?? 3;
    this.backoffMs = opts.backoffMs ?? 250;
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  private url(path: string, query?: Req['query']): string {
    const q = new URLSearchParams();
    for (const [k, v] of Object.entries(query ?? {})) if (v !== undefined) q.set(k, String(v));
    const qs = q.toString();
    return `${this.baseUrl}${path}${qs ? `?${qs}` : ''}`;
  }

  private async send(req: Req): Promise<Response> {
    const headers: Record<string, string> = {
      authorization: `Bearer ${await this.getToken()}`,
      accept: 'application/json',
      'codai-platform-version': this.revision,
    };
    if (req.body !== undefined) headers['content-type'] = 'application/json';
    if (req.idempotencyKey) headers['idempotency-key'] = req.idempotencyKey;
    const init: RequestInit = { method: req.method, headers };
    if (req.body !== undefined) init.body = JSON.stringify(req.body);
    return this.fetchImpl(this.url(req.path, req.query), init);
  }

  /** Send with retries on 429/5xx/network errors; POSTs carry one Idempotency-Key across attempts. */
  private async request<S extends z.ZodType>(req: Req, schema: S): Promise<z.infer<S>> {
    const r =
      req.method === 'POST'
        ? { ...req, idempotencyKey: req.idempotencyKey ?? newIdempotencyKey() }
        : req;
    for (let attempt = 0; ; attempt++) {
      let res: Response;
      try {
        res = await this.send(r);
      } catch (err) {
        if (attempt >= this.maxRetries)
          throw new ReleaseApiError(
            'network_error',
            0,
            err instanceof Error ? err.message : String(err),
          );
        await this.sleep(this.backoffMs * 2 ** attempt);
        continue;
      }
      if ((res.status === 429 || res.status >= 500) && attempt < this.maxRetries) {
        await res.body?.cancel();
        await this.sleep(retryAfterMs(res) ?? this.backoffMs * 2 ** attempt);
        continue;
      }
      return this.parse(res, schema);
    }
  }

  private async parse<S extends z.ZodType>(res: Response, schema: S): Promise<z.infer<S>> {
    const text = await res.text();
    let json: unknown;
    try {
      json = text ? JSON.parse(text) : undefined;
    } catch {
      throw new ReleaseApiError(
        res.ok ? 'invalid_response' : 'http_error',
        res.status,
        text.slice(0, 200),
      );
    }
    if (!res.ok) {
      const e = ErrorBodySchema.safeParse(json);
      if (e.success)
        throw new ReleaseApiError(
          e.data.error.code,
          res.status,
          e.data.error.message,
          e.data.error.request_id,
        );
      throw new ReleaseApiError('http_error', res.status, text.slice(0, 200) || res.statusText);
    }
    const parsed = schema.safeParse(json);
    if (!parsed.success)
      throw new ReleaseApiError('invalid_response', res.status, parsed.error.message);
    return parsed.data;
  }

  /** List products. */
  listProducts(opts: ListOptions = {}): Promise<Page<Product>> {
    return this.request(
      { method: 'GET', path: '/products', query: { ...opts } },
      pageSchema(ProductSchema),
    );
  }

  /** Create a product. */
  async createProduct(input: CreateProductInput): Promise<Product> {
    return this.request(
      { method: 'POST', path: '/products', body: CreateProductInputSchema.parse(input) },
      ProductSchema,
    );
  }

  /** List apps, optionally of one product. */
  listApps(opts: ListOptions & { productId?: string } = {}): Promise<Page<App>> {
    const { productId, ...page } = opts;
    return this.request(
      { method: 'GET', path: '/apps', query: { ...page, product_id: productId } },
      pageSchema(AppSchema),
    );
  }

  /** List releases of an app, newest first. */
  listReleases(appId: string, opts: ListOptions = {}): Promise<Page<Release>> {
    return this.request(
      { method: 'GET', path: `/apps/${encodeURIComponent(appId)}/releases`, query: { ...opts } },
      pageSchema(ReleaseSchema),
    );
  }

  /** Get one release. */
  getRelease(releaseId: string): Promise<Release> {
    return this.request(
      { method: 'GET', path: `/releases/${encodeURIComponent(releaseId)}` },
      ReleaseSchema,
    );
  }

  /** Create a release (draft until the build is uploaded). */
  async createRelease(
    input: CreateReleaseInput,
    opts: { idempotencyKey?: string } = {},
  ): Promise<Release> {
    const req: Req = {
      method: 'POST',
      path: '/releases',
      body: CreateReleaseInputSchema.parse(input),
    };
    if (opts.idempotencyKey) req.idempotencyKey = opts.idempotencyKey;
    return this.request(req, ReleaseSchema);
  }

  /** Apply a rollout action. */
  async rollout(releaseId: string, action: RolloutAction): Promise<Release> {
    const body = RolloutActionSchema.parse(action);
    return this.request(
      { method: 'POST', path: `/releases/${encodeURIComponent(releaseId)}/rollout`, body },
      ReleaseSchema,
    );
  }

  /** Halt a staged rollout. */
  halt(releaseId: string): Promise<Release> {
    return this.rollout(releaseId, { action: 'halt' });
  }

  /** Resume a halted rollout, optionally at a new percentage. */
  resume(releaseId: string, percent?: number): Promise<Release> {
    return this.rollout(
      releaseId,
      percent === undefined ? { action: 'resume' } : { action: 'resume', percent },
    );
  }

  /** Roll out to 100 % and finish. */
  complete(releaseId: string): Promise<Release> {
    return this.rollout(releaseId, { action: 'complete' });
  }
}
