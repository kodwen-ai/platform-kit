import { createPublicKey, createVerify, verify as nodeVerify, type KeyObject } from 'node:crypto';
import { z } from 'zod';
import { fromBase64, toBase64 } from './base64';
import { canonicalBytes, canonicalize, type NumberMode } from './canon';
import { pae } from './pae';
import type { Signer } from './signers';

/** Zod schema of a DSSE envelope (`payload` and `sig` are standard base64). */
export const EnvelopeSchema = z.object({
  payloadType: z.string().min(1),
  payload: z.string(),
  signatures: z.array(z.object({ keyid: z.string().optional(), sig: z.string().min(1) })).min(1),
});

/** A DSSE envelope. */
export type Envelope = z.infer<typeof EnvelopeSchema>;

/** Options for {@link signEnvelope}. */
export interface SignEnvelopeOptions {
  payloadType: string;
  signer: Signer;
  /** Informational key id (e.g. the KMS key version name); verifiers try every pinned key regardless. */
  keyid?: string;
  numbers?: NumberMode;
}

/** Canonicalise `payload`, sign its DSSE PAE and wrap both in an envelope. */
export async function signEnvelope(payload: unknown, opts: SignEnvelopeOptions): Promise<Envelope> {
  const body = canonicalBytes(payload, opts.numbers === undefined ? {} : { numbers: opts.numbers });
  const sig = await opts.signer(pae(opts.payloadType, body));
  return {
    payloadType: opts.payloadType,
    payload: toBase64(body),
    signatures: [{ ...(opts.keyid ? { keyid: opts.keyid } : {}), sig: toBase64(sig) }],
  };
}

/** JCS text of an envelope (the exact bytes the release scripts publish). */
export function envelopeToJson(envelope: Envelope): string {
  return canonicalize(envelope);
}

/** Reasons {@link verifyEnvelope} can fail. */
export type VerifyFailureReason = 'BAD_SCHEMA' | 'WRONG_TYPE' | 'BAD_SIGNATURE' | 'NOT_CANONICAL';

/** Result of {@link verifyEnvelope}; `keyIndex` = which pinned key verified. */
export type VerifyEnvelopeResult =
  | { ok: true; payload: unknown; keyIndex: number }
  | { ok: false; reason: VerifyFailureReason; detail?: string };

/** Options for {@link verifyEnvelope}. */
export interface VerifyEnvelopeOptions {
  /** Pinned SPKI PEM public keys (ECDSA P-256 or Ed25519). Every key is tried; `keyid` is informational. */
  publicKeysPem: readonly string[];
  /** Required payload type; omitted = any. */
  payloadType?: string;
  numbers?: NumberMode;
}

function loadKeys(pems: readonly string[]): (KeyObject | null)[] {
  return pems.map((pem) => {
    try {
      return createPublicKey(pem);
    } catch {
      return null;
    }
  });
}

function verifyOne(key: KeyObject, msg: Uint8Array, sig: Uint8Array): boolean {
  try {
    if (key.asymmetricKeyType === 'ed25519') return nodeVerify(null, msg, key, sig);
    const v = createVerify('SHA256');
    v.update(msg);
    return v.verify({ key, dsaEncoding: 'der' }, sig);
  } catch {
    return false;
  }
}

function findKey(env: Envelope, msg: Uint8Array, keys: (KeyObject | null)[]): number {
  for (const s of env.signatures) {
    const sig = fromBase64(s.sig);
    if (!sig) continue;
    const idx = keys.findIndex((k) => k !== null && verifyOne(k, msg, sig));
    if (idx >= 0) return idx;
  }
  return -1;
}

function parseCanonical(
  body: Uint8Array,
  numbers: NumberMode | undefined,
): { ok: true; payload: unknown } | { ok: false; detail: string } {
  let text: string;
  let parsed: unknown;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(body);
    parsed = JSON.parse(text);
  } catch (err) {
    return { ok: false, detail: `payload is not UTF-8 JSON: ${String(err)}` };
  }
  try {
    if (canonicalize(parsed, numbers === undefined ? {} : { numbers }) !== text) {
      return { ok: false, detail: 'payload differs from its JCS form' };
    }
  } catch (err) {
    return { ok: false, detail: String(err) };
  }
  return { ok: true, payload: parsed };
}

/**
 * Verify a DSSE envelope: schema, payload type, a signature over the PAE by any pinned key, and a
 * payload byte-identical to its own JCS form. Schema validation of the payload is the caller's.
 */
export function verifyEnvelope(
  envelope: unknown,
  opts: VerifyEnvelopeOptions,
): VerifyEnvelopeResult {
  const parsed = EnvelopeSchema.safeParse(envelope);
  if (!parsed.success) return { ok: false, reason: 'BAD_SCHEMA', detail: parsed.error.message };
  const env = parsed.data;
  if (opts.payloadType !== undefined && env.payloadType !== opts.payloadType) {
    return { ok: false, reason: 'WRONG_TYPE', detail: env.payloadType };
  }
  const body = fromBase64(env.payload);
  if (!body) return { ok: false, reason: 'BAD_SCHEMA', detail: 'payload is not standard base64' };
  const keyIndex = findKey(env, pae(env.payloadType, body), loadKeys(opts.publicKeysPem));
  if (keyIndex < 0) return { ok: false, reason: 'BAD_SIGNATURE' };
  const canon = parseCanonical(body, opts.numbers);
  if (!canon.ok) return { ok: false, reason: 'NOT_CANONICAL', detail: canon.detail };
  return { ok: true, payload: canon.payload, keyIndex };
}
