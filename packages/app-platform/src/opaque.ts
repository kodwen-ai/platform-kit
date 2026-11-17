/** Default prefixes of opaque platform-internal tokens; consumers (e.g. Brivio) may pass their own. */
export const TOKEN_PREFIXES = {
  installation: 'cpi_',
  user: 'cpu_',
  refresh: 'cpr_',
  app_secret: 'cps_',
} as const;

/** Kind of opaque token. */
export type OpaqueTokenKind = keyof typeof TOKEN_PREFIXES;

const BASE62 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
/** Length of the random body of an opaque token. */
export const OPAQUE_TOKEN_BODY_LENGTH = 40;
const PREFIX_RE = /^[a-z][a-z0-9]{1,15}_$/;

/** Generate `<prefix><40 base62 chars>` from WebCrypto randomness (rejection sampling, unbiased). */
export function generateOpaqueToken(prefix: string): string {
  if (!PREFIX_RE.test(prefix)) throw new Error('invalid token prefix (expected e.g. "cpi_")');
  let body = '';
  while (body.length < OPAQUE_TOKEN_BODY_LENGTH) {
    const bytes = globalThis.crypto.getRandomValues(new Uint8Array(64));
    for (const b of bytes) {
      if (b < 248 && body.length < OPAQUE_TOKEN_BODY_LENGTH) body += BASE62[b % 62];
    }
  }
  return prefix + body;
}

/** sha256 hex of a token — the only form stored at rest. */
export async function hashOpaqueToken(token: string): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(token));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** True when `token` is shaped as `<prefix><40 base62>`. */
export function isOpaqueToken(token: string, prefix: string): boolean {
  if (!token.startsWith(prefix)) return false;
  const body = token.slice(prefix.length);
  return body.length === OPAQUE_TOKEN_BODY_LENGTH && /^[0-9A-Za-z]+$/.test(body);
}

/** True when `token` looks like a compact JWS (three base64url segments) rather than an opaque token. */
export function looksLikeJwt(token: string): boolean {
  return /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(token);
}

/** Constant-time comparison of two hex digests of equal length. */
export function timingSafeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
