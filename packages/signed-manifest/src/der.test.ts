import { createSign, createVerify } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { fromBase64, toBase64 } from './base64';
import { derToRaw, rawToDer } from './der';
import { fixtureJson, keyPair } from './__fixtures__/helpers';

describe('derToRaw / rawToDer', () => {
  it('round-trips raw → DER → raw for any 64 bytes (property)', () => {
    fc.assert(
      fc.property(fc.uint8Array({ minLength: 64, maxLength: 64 }), (raw) => {
        expect(Array.from(derToRaw(rawToDer(raw)) ?? [])).toEqual(Array.from(raw));
      }),
    );
  });

  it('round-trips the real KMS DER signature byte-exactly', () => {
    const env = fixtureJson<{ signatures: [{ sig: string }] }>('kms-signtest-envelope.json');
    const der = fromBase64(env.signatures[0].sig);
    if (!der) throw new Error('fixture sig not base64');
    const raw = derToRaw(der);
    expect(raw).toHaveLength(64);
    expect(toBase64(rawToDer(raw ?? new Uint8Array()))).toBe(env.signatures[0].sig);
  });

  it('converts node DER signatures to raw that WebCrypto verifies, and back to DER that node verifies', async () => {
    const kp = keyPair('p256');
    const msg = new TextEncoder().encode('hello');
    const der = new Uint8Array(
      createSign('SHA256').update(msg).sign({ key: kp.privateKeyPem, dsaEncoding: 'der' }),
    );
    const raw = derToRaw(der);
    if (!raw) throw new Error('derToRaw failed');
    const spki = fromBase64(kp.publicKeyPem.replace(/-----[^-]+-----/g, '').replace(/\s+/g, ''));
    if (!spki) throw new Error('bad pem');
    const key = await crypto.subtle.importKey(
      'spki',
      spki,
      { name: 'ECDSA', namedCurve: 'P-256' },
      false,
      ['verify'],
    );
    expect(await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, key, raw, msg)).toBe(
      true,
    );
    const back = rawToDer(raw);
    expect(
      createVerify('SHA256').update(msg).verify({ key: kp.publicKeyPem, dsaEncoding: 'der' }, back),
    ).toBe(true);
  });

  it('encodes high-bit and leading-zero coordinates minimally', () => {
    const raw = new Uint8Array(64);
    raw[0] = 0x80;
    raw[63] = 0x01;
    const der = rawToDer(raw);
    expect(Array.from(der.slice(0, 5))).toEqual([0x30, 0x26, 0x02, 0x21, 0x00]);
    expect(Array.from(der.slice(-3))).toEqual([0x02, 0x01, 0x01]);
  });

  it('rejects malformed DER and wrong raw lengths', () => {
    expect(derToRaw(new Uint8Array([0x31, 0x00]))).toBeNull();
    expect(derToRaw(new Uint8Array([0x30, 0x06, 0x03, 0x01, 0x01, 0x02, 0x01, 0x01]))).toBeNull();
    expect(derToRaw(new Uint8Array([0x30, 0x06, 0x02, 0x05, 0x01]))).toBeNull();
    expect(
      derToRaw(new Uint8Array([0x30, 0x23, 0x02, 0x21, ...new Uint8Array(33).fill(1)])),
    ).toBeNull();
    expect(derToRaw(new Uint8Array([...rawToDer(new Uint8Array(64).fill(1)), 0x00]))).toBeNull();
    expect(() => rawToDer(new Uint8Array(63))).toThrow(RangeError);
  });
});

describe('fromBase64', () => {
  it('accepts padded and unpadded standard base64, rejects url-safe and bad lengths', () => {
    expect(Array.from(fromBase64('AQI=') ?? [])).toEqual([1, 2]);
    expect(Array.from(fromBase64('AQI') ?? [])).toEqual([1, 2]);
    expect(fromBase64('A-_B')).toBeNull();
    expect(fromBase64('AQIDB')).toBeNull();
    expect(fromBase64('AQ=')).toBeNull();
  });
});
