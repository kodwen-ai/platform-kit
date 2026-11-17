import { SignJWT } from 'jose';
import { importPrivateKey, type PrivateKeyInput, type SigningAlg } from './keys';

/** Options for {@link signAppJwt}. */
export interface SignAppJwtOptions {
  appId: string;
  privateKey: PrivateKeyInput;
  alg: SigningAlg;
  audience: string;
  kid?: string | undefined;
  /** Seconds since epoch; defaults to now. */
  now?: number | undefined;
  /** Backdate iat to absorb clock drift (default 30 s). */
  backdateSec?: number | undefined;
  /** Lifetime from iat (default 540 s = 9 min, max accepted is 600). */
  lifetimeSec?: number | undefined;
}

/** Sign the short-lived app JWT an app presents to `/app/*` routes and the token endpoint. */
export async function signAppJwt(o: SignAppJwtOptions): Promise<string> {
  const now = o.now ?? Math.floor(Date.now() / 1000);
  const iat = now - (o.backdateSec ?? 30);
  const exp = iat + (o.lifetimeSec ?? 540);
  const key = await importPrivateKey(o.privateKey, o.alg);
  return new SignJWT({})
    .setProtectedHeader({ alg: o.alg, typ: 'JWT', ...(o.kid ? { kid: o.kid } : {}) })
    .setIssuer(o.appId)
    .setAudience(o.audience)
    .setIssuedAt(iat)
    .setExpirationTime(exp)
    .setJti(globalThis.crypto.randomUUID())
    .sign(key);
}
