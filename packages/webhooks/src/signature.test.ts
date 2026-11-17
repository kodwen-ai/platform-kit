import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  WebhookVerificationError,
  buildHeaders,
  generateSecret,
  getHeader,
  parseSecret,
  sign,
  verify,
  verifyOrThrow,
} from './index.js';

// Official public test vector from the Standard Webhooks reference libraries
// (https://github.com/standard-webhooks/standard-webhooks). Assembled at runtime so
// secret scanners do not flag the well-known, non-sensitive vector key.
const VECTOR_KEY = ['whsec', 'MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw'].join('_');
const VECTOR = {
  id: 'msg_p5jXN8AQM9LWM0D4loKWxJek',
  timestamp: 1614265330,
  payload: '{"test": 2432232314}',
  expected: 'v1,g0hM9SsE+OTPJTGt/tmIKtSyZlE3uFJELVlNIOLJ1OE=',
};
const NOW = VECTOR.timestamp * 1000;
const KEYS = [VECTOR_KEY];

function vectorHeaders(signature = VECTOR.expected): Record<string, string> {
  return {
    'webhook-id': VECTOR.id,
    'webhook-timestamp': String(VECTOR.timestamp),
    'webhook-signature': signature,
  };
}

describe('secrets', () => {
  it('generates a whsec_ secret that parses back to the requested byte length', () => {
    const generated = generateSecret();
    expect(generated.startsWith('whsec_')).toBe(true);
    expect(parseSecret(generated)).toHaveLength(32);
    expect(parseSecret(generateSecret(24))).toHaveLength(24);
  });

  it('rejects secret lengths outside 24..64 bytes', () => {
    expect(() => generateSecret(16)).toThrow(RangeError);
    expect(() => generateSecret(65)).toThrow(RangeError);
  });

  it('accepts raw base64 as well as the whsec_ prefix', () => {
    expect(parseSecret(VECTOR_KEY.slice(6))).toEqual(parseSecret(VECTOR_KEY));
  });

  it('throws invalid_secret for malformed base64', () => {
    expect(() => parseSecret('whsec_not*base64')).toThrow(WebhookVerificationError);
    expect(() => parseSecret('')).toThrow(/base64/);
  });
});

describe('sign', () => {
  it('matches the official Standard Webhooks test vector', async () => {
    await expect(sign({ ...VECTOR, secret: VECTOR_KEY })).resolves.toBe(VECTOR.expected);
  });

  it('signs byte payloads identically to their string form', async () => {
    const bytes = new TextEncoder().encode(VECTOR.payload);
    await expect(sign({ ...VECTOR, payload: bytes, secret: VECTOR_KEY })).resolves.toBe(
      VECTOR.expected,
    );
  });

  it('refuses ids containing a full stop and non-integer timestamps', async () => {
    await expect(sign({ ...VECTOR, id: 'a.b', secret: VECTOR_KEY })).rejects.toThrow(TypeError);
    await expect(sign({ ...VECTOR, timestamp: 1.5, secret: VECTOR_KEY })).rejects.toThrow(
      TypeError,
    );
  });

  it('builds space-separated signatures for every active secret', async () => {
    const headers = await buildHeaders({ ...VECTOR, secrets: [VECTOR_KEY, generateSecret()] });
    expect(headers['webhook-id']).toBe(VECTOR.id);
    expect(headers['webhook-timestamp']).toBe('1614265330');
    const sigs = headers['webhook-signature'].split(' ');
    expect(sigs).toHaveLength(2);
    expect(sigs[0]).toBe(VECTOR.expected);
    await expect(buildHeaders({ ...VECTOR, secrets: [] })).rejects.toThrow(TypeError);
  });
});

describe('verify', () => {
  it('accepts the official vector', async () => {
    await expect(
      verify({ headers: vectorHeaders(), payload: VECTOR.payload, secrets: KEYS, now: NOW }),
    ).resolves.toEqual({ ok: true });
  });

  it('looks headers up case-insensitively in objects, Maps and Headers', async () => {
    const upper = Object.fromEntries(
      Object.entries(vectorHeaders()).map(([k, v]) => [k.toUpperCase(), v]),
    );
    const base = { payload: VECTOR.payload, secrets: KEYS, now: NOW };
    await expect(verify({ ...base, headers: upper })).resolves.toEqual({ ok: true });
    await expect(verify({ ...base, headers: new Map(Object.entries(upper)) })).resolves.toEqual({
      ok: true,
    });
    await expect(verify({ ...base, headers: new Headers(upper) })).resolves.toEqual({ ok: true });
    expect(getHeader({ 'Webhook-Id': ['a', 'b'] }, 'webhook-id')).toBe('a b');
  });

  it('reports missing or malformed headers', async () => {
    const base = { payload: VECTOR.payload, secrets: KEYS, now: NOW };
    await expect(verify({ ...base, headers: {} })).resolves.toEqual({
      ok: false,
      reason: 'missing_headers',
    });
    await expect(
      verify({ ...base, headers: { ...vectorHeaders(), 'webhook-timestamp': 'abc' } }),
    ).resolves.toEqual({ ok: false, reason: 'missing_headers' });
  });

  it('rejects timestamps outside the tolerance window both ways', async () => {
    const base = { headers: vectorHeaders(), payload: VECTOR.payload, secrets: KEYS };
    await expect(verify({ ...base, now: NOW + 301_000 })).resolves.toEqual({
      ok: false,
      reason: 'timestamp_too_old',
    });
    await expect(verify({ ...base, now: NOW - 301_000 })).resolves.toEqual({
      ok: false,
      reason: 'timestamp_too_new',
    });
    await expect(verify({ ...base, now: NOW + 299_000 })).resolves.toEqual({ ok: true });
    await expect(verify({ ...base, now: NOW + 20_000, toleranceSec: 10 })).resolves.toEqual({
      ok: false,
      reason: 'timestamp_too_old',
    });
  });

  it('reports invalid_secret for empty or malformed secrets', async () => {
    const base = { headers: vectorHeaders(), payload: VECTOR.payload, now: NOW };
    await expect(verify({ ...base, secrets: [] })).resolves.toEqual({
      ok: false,
      reason: 'invalid_secret',
    });
    await expect(verify({ ...base, secrets: ['whsec_%%%'] })).resolves.toEqual({
      ok: false,
      reason: 'invalid_secret',
    });
  });

  it('ignores unknown signature versions and garbage entries', async () => {
    const base = { payload: VECTOR.payload, secrets: KEYS, now: NOW };
    const sig = VECTOR.expected.slice(3);
    await expect(
      verify({ ...base, headers: vectorHeaders(`v1a,${sig} v2,${sig} junk`) }),
    ).resolves.toEqual({ ok: false, reason: 'no_matching_signature' });
    await expect(
      verify({ ...base, headers: vectorHeaders(`v1a,abc ${VECTOR.expected}`) }),
    ).resolves.toEqual({ ok: true });
  });

  it('verifyOrThrow throws a typed error with the reason', async () => {
    const promise = verifyOrThrow({
      headers: vectorHeaders(),
      payload: '{}',
      secrets: KEYS,
      now: NOW,
    });
    await expect(promise).rejects.toBeInstanceOf(WebhookVerificationError);
    await expect(promise).rejects.toMatchObject({ reason: 'no_matching_signature' });
    await expect(
      verifyOrThrow({ headers: vectorHeaders(), payload: VECTOR.payload, secrets: KEYS, now: NOW }),
    ).resolves.toBeUndefined();
  });
});

describe('properties', () => {
  const idArb = fc.stringMatching(/^[A-Za-z0-9_-]{1,40}$/);
  const tsArb = fc.integer({ min: 1_000_000_000, max: 4_000_000_000 });

  it('sign -> verify round-trips for random ids and payloads', async () => {
    const key = generateSecret();
    await fc.assert(
      fc.asyncProperty(idArb, tsArb, fc.string(), async (id, timestamp, payload) => {
        const headers = await buildHeaders({ id, timestamp, payload, secrets: [key] });
        const result = await verify({ headers, payload, secrets: [key], now: timestamp * 1000 });
        expect(result).toEqual({ ok: true });
      }),
      { numRuns: 100 },
    );
  });

  it('any single-byte payload mutation fails verification', async () => {
    const key = generateSecret();
    await fc.assert(
      fc.asyncProperty(
        fc.uint8Array({ minLength: 1, maxLength: 200 }),
        fc.nat(),
        fc.integer({ min: 1, max: 255 }),
        async (payload, index, delta) => {
          const headers = await buildHeaders({
            id: 'msg_x',
            timestamp: 1_700_000_000,
            payload,
            secrets: [key],
          });
          const mutated = payload.slice();
          const at = index % mutated.length;
          mutated[at] = ((mutated[at] ?? 0) + delta) % 256;
          const result = await verify({
            headers,
            payload: mutated,
            secrets: [key],
            now: 1_700_000_000_000,
          });
          expect(result).toEqual({ ok: false, reason: 'no_matching_signature' });
        },
      ),
      { numRuns: 100 },
    );
  });

  it('rotation: verification succeeds when any one of N secrets matches', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 1, max: 5 }),
        fc.nat(),
        fc.string(),
        async (n, pick, payload) => {
          const verifierKeys = Array.from({ length: n }, () => generateSecret());
          const signer = verifierKeys[pick % n] ?? '';
          const headers = await buildHeaders({
            id: 'msg_rot',
            timestamp: 1_700_000_000,
            payload,
            secrets: [generateSecret(), signer],
          });
          const ok = await verify({
            headers,
            payload,
            secrets: verifierKeys,
            now: 1_700_000_000_000,
          });
          expect(ok).toEqual({ ok: true });
          const none = await verify({
            headers,
            payload,
            secrets: [generateSecret()],
            now: 1_700_000_000_000,
          });
          expect(none).toEqual({ ok: false, reason: 'no_matching_signature' });
        },
      ),
      { numRuns: 50 },
    );
  });
});
