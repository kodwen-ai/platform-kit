import { StoreApiError } from './errors';
import type { FetchLike } from './types';

/** One HTTP request against a store API. */
export interface StoreRequest {
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  url: string;
  json?: unknown;
  body?: Uint8Array;
  headers?: Record<string, string>;
  /** Default true; false for pre-signed URLs (Azure SAS). */
  auth?: boolean;
}

function toBody(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
  return bytes.buffer instanceof ArrayBuffer
    ? (bytes as Uint8Array<ArrayBuffer>)
    : new Uint8Array(bytes);
}

/** Thin JSON client over an injectable fetch with bearer auth. */
export class HttpClient {
  constructor(
    private readonly fetchImpl: FetchLike,
    private readonly getToken?: () => Promise<string>,
    private readonly defaultHeaders: Record<string, string> = {},
  ) {}

  /** Send a request; parse a JSON body (empty body → `{}`); throw `StoreApiError` on non-2xx. */
  async request<T = unknown>(req: StoreRequest): Promise<T> {
    const headers: Record<string, string> = { ...this.defaultHeaders, ...req.headers };
    if (req.auth !== false && this.getToken)
      headers.authorization = `Bearer ${await this.getToken()}`;
    let body: BodyInit | undefined;
    if (req.json !== undefined) {
      headers['content-type'] = 'application/json';
      body = JSON.stringify(req.json);
    } else if (req.body) {
      headers['content-type'] ??= 'application/octet-stream';
      body = toBody(req.body);
    }
    const res = await this.fetchImpl(req.url, { method: req.method, headers, body });
    const text = await res.text();
    if (!res.ok) throw new StoreApiError(res.status, req.method, req.url, text);
    return (text ? JSON.parse(text) : {}) as T;
  }
}

/** Resolve the fetch to use (injected, else the global). */
export function resolveFetch(f?: FetchLike): FetchLike {
  return f ?? ((input, init) => globalThis.fetch(input, init));
}
