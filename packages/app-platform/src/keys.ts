import { exportJWK, generateKeyPair, importJWK, importPKCS8, type CryptoKey, type JWK } from 'jose';

/** JWS algorithms accepted for app JWTs and platform-issued tokens. */
export const SIGNING_ALGS = ['RS256', 'ES256'] as const;
export type SigningAlg = (typeof SIGNING_ALGS)[number];

/** Private key input: a WebCrypto key, a private JWK, or a PKCS#8 PEM string. */
export type PrivateKeyInput = CryptoKey | JWK | string;

/** The issuer's signing key. `publicJwk` is required only for non-extractable CryptoKeys. */
export interface SigningKey {
  kid: string;
  alg: SigningAlg;
  privateKey: PrivateKeyInput;
  publicJwk?: JWK;
}

const PRIVATE_JWK_FIELDS = ['d', 'p', 'q', 'dp', 'dq', 'qi', 'oth', 'k'] as const;

/** Strip private members from a JWK. */
export function toPublicJwk(jwk: JWK): JWK {
  const out: Record<string, unknown> = { ...jwk };
  for (const f of PRIVATE_JWK_FIELDS) delete out[f];
  delete out.key_ops;
  return out as JWK;
}

function isJwk(x: PrivateKeyInput): x is JWK {
  return typeof x === 'object' && x !== null && 'kty' in x;
}

/** Import a private key (CryptoKey passthrough, JWK or PKCS#8 PEM) for `alg`. */
export async function importPrivateKey(
  input: PrivateKeyInput,
  alg: SigningAlg,
): Promise<CryptoKey> {
  if (typeof input === 'string') return importPKCS8(input, alg, { extractable: true });
  if (!isJwk(input)) return input;
  const k = await importJWK({ ...input, alg }, alg, { extractable: true });
  if (k instanceof Uint8Array) throw new Error('symmetric keys are not supported');
  return k;
}

/** Import a public JWK for verification. */
export async function importPublicJwk(jwk: JWK, alg?: string): Promise<CryptoKey> {
  const useAlg = alg ?? jwk.alg;
  if (!useAlg) throw new Error('public JWK needs an alg');
  const k = await importJWK(toPublicJwk(jwk), useAlg);
  if (k instanceof Uint8Array) throw new Error('symmetric keys are not supported');
  return k;
}

/** Resolve a signing key into an importable private key plus its public JWK (with kid/alg/use). */
export async function resolveSigningKey(
  k: SigningKey,
): Promise<{ key: CryptoKey; publicJwk: JWK }> {
  const key = await importPrivateKey(k.privateKey, k.alg);
  let pub = k.publicJwk;
  if (!pub && isJwk(k.privateKey)) pub = toPublicJwk(k.privateKey);
  if (!pub) {
    if (!key.extractable) throw new Error('non-extractable signing key needs publicJwk');
    pub = toPublicJwk(await exportJWK(key));
  }
  return { key, publicJwk: { ...toPublicJwk(pub), kid: k.kid, alg: k.alg, use: 'sig' } };
}

/** Generate an extractable key pair as JWKs (bootstrap and tests). */
export async function generateSigningKeyPair(
  alg: SigningAlg,
  kid: string,
): Promise<{ privateJwk: JWK; publicJwk: JWK }> {
  const { privateKey } = await generateKeyPair(alg, { extractable: true });
  const privateJwk = { ...(await exportJWK(privateKey)), kid, alg };
  return { privateJwk, publicJwk: { ...toPublicJwk(privateJwk), use: 'sig' } };
}
