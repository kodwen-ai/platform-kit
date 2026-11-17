// Standard Webhooks v1 (symmetric HMAC-SHA256) signing and verification.
// Spec: https://github.com/standard-webhooks/standard-webhooks/blob/main/spec/standard-webhooks.md
import { base64ToBytes, bytesToBase64, timingSafeEqual } from './encoding.js';

/** Prefix used when serialising symmetric signing secrets. */
export const SECRET_PREFIX = 'whsec_';
/** Signature version identifier for HMAC-SHA256 signatures. */
export const SIGNATURE_VERSION = 'v1';
/** Default replay tolerance in seconds for `webhook-timestamp`. */
export const DEFAULT_TOLERANCE_SEC = 300;

/** Payload accepted by sign/verify: the exact raw body string or bytes. */
export type WebhookPayload = string | Uint8Array;

/** Header bag accepted by `verify`: Fetch `Headers`, a `Map`, or a plain object. */
export type HeaderInput =
  | Headers
  | ReadonlyMap<string, string | readonly string[] | undefined>
  | Readonly<Record<string, string | readonly string[] | undefined>>;

/** The three Standard Webhooks headers (a type alias so it is assignable to `HeaderInput`). */
export type WebhookHeaders = {
  'webhook-id': string;
  'webhook-timestamp': string;
  'webhook-signature': string;
};

/** Why a verification failed. */
export type VerifyFailureReason =
  | 'missing_headers'
  | 'timestamp_too_old'
  | 'timestamp_too_new'
  | 'no_matching_signature'
  | 'invalid_secret';

/** Result of `verify`. */
export type VerifyResult = { ok: true } | { ok: false; reason: VerifyFailureReason };

/** Thrown for malformed secrets and by `verifyOrThrow`. */
export class WebhookVerificationError extends Error {
  /** Machine-readable failure reason. */
  readonly reason: VerifyFailureReason;

  constructor(reason: VerifyFailureReason, message?: string) {
    super(message ?? `webhook verification failed: ${reason}`);
    this.name = 'WebhookVerificationError';
    this.reason = reason;
  }
}

const encoder = new TextEncoder();

/** Generate a new `whsec_` secret from `bytes` (24..64, default 32) random bytes. */
export function generateSecret(bytes = 32): string {
  if (!Number.isInteger(bytes) || bytes < 24 || bytes > 64) {
    throw new RangeError('secret length must be an integer between 24 and 64 bytes');
  }
  return SECRET_PREFIX + bytesToBase64(globalThis.crypto.getRandomValues(new Uint8Array(bytes)));
}

/** Decode a `whsec_`-prefixed or raw base64 secret into key bytes; throws on malformed input. */
export function parseSecret(secret: string): Uint8Array<ArrayBuffer> {
  const raw = secret.startsWith(SECRET_PREFIX) ? secret.slice(SECRET_PREFIX.length) : secret;
  const bytes = base64ToBytes(raw);
  if (bytes === null || bytes.length === 0) {
    throw new WebhookVerificationError('invalid_secret', 'secret is not valid base64');
  }
  return bytes;
}

async function importKey(secret: string): Promise<CryptoKey> {
  return globalThis.crypto.subtle.importKey(
    'raw',
    parseSecret(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
}

function assertNoDot(name: string, value: string): void {
  if (value.length === 0 || value.includes('.')) {
    throw new TypeError(`${name} must be non-empty and must not contain "."`);
  }
}

function signedContent(
  id: string,
  timestamp: number | string,
  payload: WebhookPayload,
): Uint8Array<ArrayBuffer> {
  const prefix = encoder.encode(`${id}.${timestamp}.`);
  const body = typeof payload === 'string' ? encoder.encode(payload) : payload;
  const out = new Uint8Array(prefix.length + body.length);
  out.set(prefix, 0);
  out.set(body, prefix.length);
  return out;
}

async function hmac(secret: string, content: Uint8Array<ArrayBuffer>): Promise<Uint8Array> {
  const key = await importKey(secret);
  return new Uint8Array(await globalThis.crypto.subtle.sign('HMAC', key, content));
}

/** Input for `sign` / `buildHeaders`. */
export interface SignInput {
  id: string;
  /** Unix seconds. */
  timestamp: number;
  payload: WebhookPayload;
}

/** Sign `${id}.${timestamp}.${payload}` and return `v1,<base64sig>`. */
export async function sign(input: SignInput & { secret: string }): Promise<string> {
  assertNoDot('id', input.id);
  if (!Number.isSafeInteger(input.timestamp) || input.timestamp < 0) {
    throw new TypeError('timestamp must be a non-negative integer (unix seconds)');
  }
  const sig = await hmac(input.secret, signedContent(input.id, input.timestamp, input.payload));
  return `${SIGNATURE_VERSION},${bytesToBase64(sig)}`;
}

/** Build the three Standard Webhooks headers, signing with every active secret (rotation). */
export async function buildHeaders(
  input: SignInput & { secrets: readonly string[] },
): Promise<WebhookHeaders> {
  if (input.secrets.length === 0) throw new TypeError('at least one secret is required');
  const signatures = await Promise.all(input.secrets.map((secret) => sign({ ...input, secret })));
  return {
    'webhook-id': input.id,
    'webhook-timestamp': String(input.timestamp),
    'webhook-signature': signatures.join(' '),
  };
}

function firstValue(value: string | readonly string[] | undefined | null): string | undefined {
  if (value === undefined || value === null) return undefined;
  return typeof value === 'string' ? value : value.join(' ');
}

/** Case-insensitive header lookup across Headers, Map and plain objects. */
export function getHeader(headers: HeaderInput, name: string): string | undefined {
  if (typeof Headers !== 'undefined' && headers instanceof Headers) {
    return firstValue(headers.get(name));
  }
  const wanted = name.toLowerCase();
  const entries: Iterable<[string, string | readonly string[] | undefined]> =
    headers instanceof Map ? headers.entries() : Object.entries(headers);
  for (const [key, value] of entries) {
    if (key.toLowerCase() === wanted) return firstValue(value);
  }
  return undefined;
}

function decodeSignatures(header: string): Uint8Array[] {
  const out: Uint8Array[] = [];
  for (const part of header.split(/\s+/)) {
    const comma = part.indexOf(',');
    if (comma < 0 || part.slice(0, comma) !== SIGNATURE_VERSION) continue;
    const bytes = base64ToBytes(part.slice(comma + 1));
    if (bytes !== null) out.push(bytes);
  }
  return out;
}

/** Input for `verify`. */
export interface VerifyInput {
  headers: HeaderInput;
  /** Exact raw request body; never a re-serialised JSON value. */
  payload: WebhookPayload;
  /** All currently accepted secrets (old + new during rotation). */
  secrets: readonly string[];
  toleranceSec?: number;
  /** Current time; defaults to `new Date()`. */
  now?: Date | number;
}

const TIMESTAMP_RE = /^\d{1,15}$/;

function checkTimestamp(
  raw: string,
  toleranceSec: number,
  now: Date | number | undefined,
): VerifyResult {
  const nowSec = Math.floor((now === undefined ? Date.now() : Number(now)) / 1000);
  const ts = Number(raw);
  if (ts < nowSec - toleranceSec) return { ok: false, reason: 'timestamp_too_old' };
  if (ts > nowSec + toleranceSec) return { ok: false, reason: 'timestamp_too_new' };
  return { ok: true };
}

async function anySignatureMatches(
  secrets: readonly string[],
  content: Uint8Array<ArrayBuffer>,
  candidates: readonly Uint8Array[],
): Promise<boolean> {
  let matched = false;
  for (const secret of secrets) {
    const expected = await hmac(secret, content);
    for (const candidate of candidates) {
      if (timingSafeEqual(expected, candidate)) matched = true;
    }
  }
  return matched;
}

/** Verify a Standard Webhooks request; returns a typed result and never throws. */
export async function verify(input: VerifyInput): Promise<VerifyResult> {
  const id = getHeader(input.headers, 'webhook-id');
  const timestamp = getHeader(input.headers, 'webhook-timestamp');
  const signature = getHeader(input.headers, 'webhook-signature');
  if (!id || !timestamp || !signature || !TIMESTAMP_RE.test(timestamp) || id.includes('.')) {
    return { ok: false, reason: 'missing_headers' };
  }
  if (input.secrets.length === 0) return { ok: false, reason: 'invalid_secret' };
  for (const secret of input.secrets) {
    try {
      parseSecret(secret);
    } catch {
      return { ok: false, reason: 'invalid_secret' };
    }
  }
  const time = checkTimestamp(timestamp, input.toleranceSec ?? DEFAULT_TOLERANCE_SEC, input.now);
  if (!time.ok) return time;
  const candidates = decodeSignatures(signature);
  const content = signedContent(id, timestamp, input.payload);
  const matched =
    candidates.length > 0 && (await anySignatureMatches(input.secrets, content, candidates));
  return matched ? { ok: true } : { ok: false, reason: 'no_matching_signature' };
}

/** Verify a Standard Webhooks request; throws `WebhookVerificationError` on failure. */
export async function verifyOrThrow(input: VerifyInput): Promise<void> {
  const result = await verify(input);
  if (!result.ok) throw new WebhookVerificationError(result.reason);
}
