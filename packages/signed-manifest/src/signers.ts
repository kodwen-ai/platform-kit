import { createHash, createPrivateKey, createSign, sign as nodeSign } from 'node:crypto';
import { fromBase64 } from './base64';

/**
 * Signs the DSSE PAE bytes. ECDSA P-256 signers return an ASN.1 DER signature (what Cloud KMS
 * `EC_SIGN_P256_SHA256` emits); Ed25519 signers return the raw 64-byte signature.
 */
export type Signer = (bytes: Uint8Array) => Promise<Uint8Array>;

/** Local ECDSA P-256 / SHA-256 signer from a PKCS#8 or SEC1 PEM private key (tests, dev, offline CI). */
export function localP256Signer(privateKeyPem: string): Signer {
  const key = createPrivateKey(privateKeyPem);
  if (key.asymmetricKeyType !== 'ec')
    throw new TypeError(`expected an EC private key, got ${key.asymmetricKeyType}`);
  return async (bytes) => {
    const s = createSign('SHA256');
    s.update(bytes);
    return new Uint8Array(s.sign({ key, dsaEncoding: 'der' }));
  };
}

/** Local Ed25519 signer from a PEM private key (tests/dev only; production envelopes use P-256). */
export function localEd25519Signer(privateKeyPem: string): Signer {
  const key = createPrivateKey(privateKeyPem);
  if (key.asymmetricKeyType !== 'ed25519') {
    throw new TypeError(`expected an Ed25519 private key, got ${key.asymmetricKeyType}`);
  }
  return async (bytes) => new Uint8Array(nodeSign(null, bytes, key));
}

/** Request shape of KMS `asymmetricSign` used here (digest-based signing). */
export interface KmsAsymmetricSignRequest {
  name: string;
  digest: { sha256: Uint8Array };
}

/**
 * Minimal subset of `@google-cloud/kms` `KeyManagementServiceClient` this package needs, so the
 * package does not depend on the KMS SDK. `signature` is bytes (gRPC) or base64 text (REST/JSON).
 * API: https://cloud.google.com/kms/docs/reference/rpc/google.cloud.kms.v1#asymmetricsignrequest
 */
export interface KmsSignClient {
  asymmetricSign(
    req: KmsAsymmetricSignRequest,
  ): Promise<readonly [{ signature?: Uint8Array | string | null }, ...unknown[]]>;
}

/** Options for {@link kmsSigner}. */
export interface KmsSignerOptions {
  /** Full resource name: `projects/…/locations/…/keyRings/…/cryptoKeys/…/cryptoKeyVersions/N`. */
  keyVersionName: string;
  client: KmsSignClient;
}

function signatureBytes(sig: Uint8Array | string | null | undefined): Uint8Array {
  if (sig === null || sig === undefined || sig.length === 0) {
    throw new Error('KMS asymmetricSign returned an empty signature');
  }
  if (typeof sig !== 'string') return new Uint8Array(sig);
  const bytes = fromBase64(sig);
  if (!bytes) throw new Error('KMS asymmetricSign returned a non-base64 signature');
  return bytes;
}

/**
 * Cloud KMS `EC_SIGN_P256_SHA256` signer: SHA-256 of the PAE bytes is sent as `digest.sha256`,
 * the DER signature comes back (byte-identical to `gcloud kms asymmetric-sign --digest-algorithm sha256`).
 */
export function kmsSigner({ keyVersionName, client }: KmsSignerOptions): Signer {
  return async (bytes) => {
    const digest = new Uint8Array(createHash('sha256').update(bytes).digest());
    const [resp] = await client.asymmetricSign({
      name: keyVersionName,
      digest: { sha256: digest },
    });
    return signatureBytes(resp.signature);
  };
}
