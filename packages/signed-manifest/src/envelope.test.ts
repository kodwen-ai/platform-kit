import { describe, expect, it } from 'vitest';
import { fromBase64, toBase64 } from './base64';
import { envelopeToJson, signEnvelope, verifyEnvelope, type Envelope } from './envelope';
import { pae } from './pae';
import { PAYLOAD_TYPES } from './payload-types';
import { kmsSigner, localEd25519Signer, localP256Signer, type KmsSignClient } from './signers';
import { PINNED_PEM, fixtureJson, fixtureText, keyPair } from './__fixtures__/helpers';

const REAL_FIXTURES = [
  { file: 'kms-signtest-envelope.json', type: PAYLOAD_TYPES.phoneReleaseV1, kind: 'phone-release' },
  { file: 'ui-latest.json', type: PAYLOAD_TYPES.uiBundleV1, kind: 'ui-bundle' },
] as const;

function flipPayloadByte(env: Envelope, index: number): Envelope {
  const body = fromBase64(env.payload);
  if (!body) throw new Error('fixture payload not base64');
  body[index] = (body[index] ?? 0) ^ 0x01;
  return { ...env, payload: toBase64(body) };
}

describe('real Cloud KMS envelopes (frozen fixtures, rules-signing key v1)', () => {
  for (const f of REAL_FIXTURES) {
    const env = fixtureJson<Envelope>(f.file);

    it(`${f.file} verifies with the pinned PEM in integers mode`, () => {
      const r = verifyEnvelope(env, {
        publicKeysPem: [PINNED_PEM],
        payloadType: f.type,
        numbers: 'integers',
      });
      expect(r.ok).toBe(true);
      if (r.ok) {
        expect(r.keyIndex).toBe(0);
        expect((r.payload as { kind: string }).kind).toBe(f.kind);
      }
    });

    it(`${f.file} is byte-identical to its JCS re-serialisation`, () => {
      expect(envelopeToJson(env)).toBe(fixtureText(f.file).trim());
    });

    it(`${f.file} fails BAD_SIGNATURE when one payload byte flips`, () => {
      for (const i of [0, 10, 40]) {
        const r = verifyEnvelope(flipPayloadByte(env, i), { publicKeysPem: [PINNED_PEM] });
        expect(r).toMatchObject({ ok: false, reason: 'BAD_SIGNATURE' });
      }
    });

    it(`${f.file} verifies when the pinned key is second and payload padding is stripped`, () => {
      const other = keyPair('p256').publicKeyPem;
      const unpadded = { ...env, payload: env.payload.replace(/=+$/, '') };
      const r = verifyEnvelope(unpadded, { publicKeysPem: ['not a pem', other, PINNED_PEM] });
      expect(r).toMatchObject({ ok: true, keyIndex: 2 });
    });
  }

  it('rejects a phone envelope pinned to the ui-bundle type (WRONG_TYPE)', () => {
    const env = fixtureJson<Envelope>('kms-signtest-envelope.json');
    const r = verifyEnvelope(env, {
      publicKeysPem: [PINNED_PEM],
      payloadType: PAYLOAD_TYPES.uiBundleV1,
    });
    expect(r).toMatchObject({ ok: false, reason: 'WRONG_TYPE' });
  });
});

describe('signEnvelope / verifyEnvelope round-trip', () => {
  const p256 = keyPair('p256');

  it('signs with a local P-256 key and verifies, keyid kept', async () => {
    const env = await signEnvelope(
      { b: 1, a: 'ș' },
      {
        payloadType: PAYLOAD_TYPES.rulesV1,
        signer: localP256Signer(p256.privateKeyPem),
        keyid: 'k1',
      },
    );
    expect(Buffer.from(fromBase64(env.payload) ?? []).toString('utf8')).toBe('{"a":"ș","b":1}');
    expect(env.signatures[0]?.keyid).toBe('k1');
    expect(
      verifyEnvelope(env, {
        publicKeysPem: [p256.publicKeyPem],
        payloadType: PAYLOAD_TYPES.rulesV1,
      }),
    ).toEqual({
      ok: true,
      payload: { a: 'ș', b: 1 },
      keyIndex: 0,
    });
  });

  it('omits keyid when not given and fails against an unrelated key', async () => {
    const env = await signEnvelope(
      { x: 1 },
      { payloadType: 't', signer: localP256Signer(p256.privateKeyPem) },
    );
    expect(env.signatures[0]).not.toHaveProperty('keyid');
    expect(verifyEnvelope(env, { publicKeysPem: [keyPair('p256').publicKeyPem] })).toMatchObject({
      ok: false,
      reason: 'BAD_SIGNATURE',
    });
  });

  it('supports Ed25519 for dev/test keys', async () => {
    const ed = keyPair('ed25519');
    const env = await signEnvelope(
      { ok: true },
      { payloadType: 't', signer: localEd25519Signer(ed.privateKeyPem) },
    );
    expect(verifyEnvelope(env, { publicKeysPem: [ed.publicKeyPem] })).toMatchObject({ ok: true });
  });

  it('refuses a key of the wrong kind for each local signer', () => {
    expect(() => localP256Signer(keyPair('ed25519').privateKeyPem)).toThrow('expected an EC');
    expect(() => localEd25519Signer(p256.privateKeyPem)).toThrow('expected an Ed25519');
  });

  it('throws when integers mode meets a float', async () => {
    const signer = localP256Signer(p256.privateKeyPem);
    await expect(
      signEnvelope({ n: 0.5 }, { payloadType: 't', signer, numbers: 'integers' }),
    ).rejects.toThrow('only safe integers');
  });
});

describe('verifyEnvelope failure modes', () => {
  const p256 = keyPair('p256');
  const signer = localP256Signer(p256.privateKeyPem);
  const keys = { publicKeysPem: [p256.publicKeyPem] };

  async function rawEnvelope(text: string): Promise<Envelope> {
    const body = new TextEncoder().encode(text);
    const sig = await signer(pae('t', body));
    return { payloadType: 't', payload: toBase64(body), signatures: [{ sig: toBase64(sig) }] };
  }

  it('NOT_CANONICAL for a validly signed payload that is not its own JCS form', async () => {
    expect(verifyEnvelope(await rawEnvelope('{"b":1,"a":2}'), keys)).toMatchObject({
      ok: false,
      reason: 'NOT_CANONICAL',
    });
    expect(verifyEnvelope(await rawEnvelope('{ "a":1}'), keys)).toMatchObject({
      ok: false,
      reason: 'NOT_CANONICAL',
    });
    expect(verifyEnvelope(await rawEnvelope('not json'), keys)).toMatchObject({
      ok: false,
      reason: 'NOT_CANONICAL',
    });
  });

  it('NOT_CANONICAL when integers mode is required but the payload has a float', async () => {
    const env = await rawEnvelope('{"a":1.5}');
    expect(verifyEnvelope(env, keys)).toMatchObject({ ok: true });
    expect(verifyEnvelope(env, { ...keys, numbers: 'integers' })).toMatchObject({
      ok: false,
      reason: 'NOT_CANONICAL',
    });
  });

  it('BAD_SCHEMA for malformed envelopes and non-base64 payloads', () => {
    expect(verifyEnvelope(null, keys)).toMatchObject({ ok: false, reason: 'BAD_SCHEMA' });
    expect(
      verifyEnvelope({ payloadType: 't', payload: 'e30=', signatures: [] }, keys),
    ).toMatchObject({
      ok: false,
      reason: 'BAD_SCHEMA',
    });
    expect(
      verifyEnvelope({ payloadType: 't', payload: 'e3-_', signatures: [{ sig: 'AA==' }] }, keys),
    ).toMatchObject({
      ok: false,
      reason: 'BAD_SCHEMA',
    });
  });

  it('BAD_SIGNATURE when the signature is not base64 or no key parses', async () => {
    const env = await rawEnvelope('{}');
    expect(verifyEnvelope({ ...env, signatures: [{ sig: '%%%' }] }, keys)).toMatchObject({
      reason: 'BAD_SIGNATURE',
    });
    expect(verifyEnvelope(env, { publicKeysPem: ['garbage'] })).toMatchObject({
      reason: 'BAD_SIGNATURE',
    });
  });
});

describe('kmsSigner', () => {
  const p256 = keyPair('p256');

  function fakeClient(
    signature: (digest: Uint8Array) => Uint8Array | string | null,
  ): KmsSignClient & { names: string[] } {
    const names: string[] = [];
    return {
      names,
      async asymmetricSign(req) {
        names.push(req.name);
        expect(req.digest.sha256).toHaveLength(32);
        return [{ signature: signature(req.digest.sha256) }];
      },
    };
  }

  it('sends the SHA-256 digest of the PAE and yields a verifiable envelope (bytes and base64 responses)', async () => {
    const { createSign } = await import('node:crypto');
    // A real KMS signs the digest; locally, re-sign the PAE we capture through a wrapping signer.
    for (const asText of [false, true]) {
      let lastPae: Uint8Array = new Uint8Array();
      const client = fakeClient(() => {
        const s = createSign('SHA256');
        s.update(lastPae);
        const der = s.sign({ key: p256.privateKeyPem, dsaEncoding: 'der' });
        return asText ? der.toString('base64') : new Uint8Array(der);
      });
      const kms = kmsSigner({
        keyVersionName: 'projects/p/locations/global/keyRings/r/cryptoKeys/k/cryptoKeyVersions/1',
        client,
      });
      const env = await signEnvelope(
        { a: 1 },
        {
          payloadType: 't',
          signer: (bytes) => {
            lastPae = bytes;
            return kms(bytes);
          },
        },
      );
      expect(client.names[0]).toContain('cryptoKeyVersions/1');
      expect(verifyEnvelope(env, { publicKeysPem: [p256.publicKeyPem] })).toMatchObject({
        ok: true,
      });
    }
  });

  it('throws on an empty or non-base64 signature', async () => {
    await expect(
      kmsSigner({ keyVersionName: 'k', client: fakeClient(() => null) })(new Uint8Array([1])),
    ).rejects.toThrow('empty signature');
    await expect(
      kmsSigner({ keyVersionName: 'k', client: fakeClient(() => '%%') })(new Uint8Array([1])),
    ).rejects.toThrow('non-base64');
  });
});
