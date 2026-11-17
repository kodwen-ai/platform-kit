import { createHash } from 'node:crypto';

/**
 * RFC 8785 JSON Canonicalization Scheme (JCS), byte-compatible with `@codai/rules-core` canon.ts,
 * the phone `Canon.kt` and the release scripts' `ConvertTo-Jcs`.
 *  - object keys sorted by UTF-16 code units, keys whose value is `undefined` dropped
 *  - no insignificant whitespace
 *  - numbers per ECMAScript Number::toString (JSON.stringify); `integers` mode = safe integers only
 *  - strings escaped per RFC 8785 §3.2.2.2 (JSON.stringify is conformant)
 *  - I-JSON subset: lone surrogates, NaN/Infinity, bigint, undefined, functions, symbols abort
 */

/** Number policy: `finite` = any finite double (RFC 8785); `integers` = safe integers only (release manifests). */
export type NumberMode = 'finite' | 'integers';

/** Options shared by every canonicalising function. */
export interface CanonicalizeOptions {
  numbers?: NumberMode;
}

/** Thrown when a value cannot be represented in canonical I-JSON. */
export class CanonicalizeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CanonicalizeError';
  }
}

function assertNoLoneSurrogates(s: string): void {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff) {
      const n = s.charCodeAt(i + 1);
      if (n >= 0xdc00 && n <= 0xdfff) {
        i++;
        continue;
      }
      throw new CanonicalizeError('lone high surrogate');
    }
    if (c >= 0xdc00 && c <= 0xdfff) throw new CanonicalizeError('lone low surrogate');
  }
}

function byCodeUnits(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function numberToJcs(n: number, mode: NumberMode): string {
  if (!Number.isFinite(n)) throw new CanonicalizeError('non-finite number');
  if (mode === 'integers' && !Number.isSafeInteger(n)) {
    throw new CanonicalizeError(`only safe integers are allowed (got ${n})`);
  }
  return JSON.stringify(n);
}

function scalarToJcs(value: unknown, mode: NumberMode): string | undefined {
  if (value === null) return 'null';
  switch (typeof value) {
    case 'boolean':
      return value ? 'true' : 'false';
    case 'number':
      return numberToJcs(value, mode);
    case 'string':
      assertNoLoneSurrogates(value);
      return JSON.stringify(value);
    case 'bigint':
      throw new CanonicalizeError('bigint not allowed (encode as string)');
    case 'undefined':
    case 'function':
    case 'symbol':
      throw new CanonicalizeError(`unsupported type ${typeof value}`);
    default:
      return undefined;
  }
}

function objectToJcs(obj: Record<string, unknown>, mode: NumberMode): string {
  const keys = Object.keys(obj)
    .filter((k) => obj[k] !== undefined)
    .sort(byCodeUnits);
  const parts: string[] = [];
  for (const k of keys) {
    assertNoLoneSurrogates(k);
    parts.push(JSON.stringify(k) + ':' + toJcs(obj[k], mode));
  }
  return '{' + parts.join(',') + '}';
}

function toJcs(value: unknown, mode: NumberMode): string {
  const scalar = scalarToJcs(value, mode);
  if (scalar !== undefined) return scalar;
  if (Array.isArray(value)) {
    return '[' + value.map((v: unknown) => toJcs(v === undefined ? null : v, mode)).join(',') + ']';
  }
  return objectToJcs(value as Record<string, unknown>, mode);
}

/** RFC 8785 canonical JSON text of `value`; throws {@link CanonicalizeError} on non-I-JSON input. */
export function canonicalize(value: unknown, opts: CanonicalizeOptions = {}): string {
  return toJcs(value, opts.numbers ?? 'finite');
}

/** UTF-8 bytes of the canonical JSON of `value`. */
export function canonicalBytes(value: unknown, opts: CanonicalizeOptions = {}): Uint8Array {
  return new TextEncoder().encode(canonicalize(value, opts));
}

/** Lowercase hex SHA-256 of a string (UTF-8) or bytes. */
export function sha256Hex(data: string | Uint8Array): string {
  return createHash('sha256').update(data).digest('hex');
}

/** Lowercase hex SHA-256 of the canonical JSON of `value` (manifest hash for anti-rollback/tamper checks). */
export function canonicalHash(value: unknown, opts: CanonicalizeOptions = {}): string {
  return sha256Hex(canonicalize(value, opts));
}
