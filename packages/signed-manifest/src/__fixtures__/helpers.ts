import { generateKeyPairSync } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

/** Read a fixture file as UTF-8 text. */
export function fixtureText(name: string): string {
  return readFileSync(join(here, name), 'utf8');
}

/** Parse a JSON fixture. */
export function fixtureJson<T>(name: string): T {
  return JSON.parse(fixtureText(name)) as T;
}

/** The rules-signing KMS key (cryptoKeyVersions/1) pinned in desktop store.rs and phone RulesKeys.kt. */
export const PINNED_PEM = fixtureText('rules-signing-v1.pem');

/** Fresh PEM key pair. */
export function keyPair(kind: 'p256' | 'ed25519'): { privateKeyPem: string; publicKeyPem: string } {
  const publicKeyEncoding = { type: 'spki', format: 'pem' } as const;
  const privateKeyEncoding = { type: 'pkcs8', format: 'pem' } as const;
  const kp =
    kind === 'p256'
      ? generateKeyPairSync('ec', { namedCurve: 'P-256', publicKeyEncoding, privateKeyEncoding })
      : generateKeyPairSync('ed25519', { publicKeyEncoding, privateKeyEncoding });
  return { privateKeyPem: kp.privateKey, publicKeyPem: kp.publicKey };
}
