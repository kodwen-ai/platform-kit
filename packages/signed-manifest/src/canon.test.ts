import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { CanonicalizeError, canonicalBytes, canonicalHash, canonicalize, sha256Hex } from './canon';
import { pae } from './pae';
import { fixtureJson } from './__fixtures__/helpers';

describe('golden JCS vectors (copied from rules-core test-vectors/jcs.json)', () => {
  const cases =
    fixtureJson<Array<{ name: string; input: unknown; canonical?: string; error?: string }>>(
      'jcs.json',
    );
  it('has at least 8 cases', () => expect(cases.length).toBeGreaterThanOrEqual(8));
  for (const c of cases) {
    it(c.name, () => {
      if (c.error !== undefined) expect(() => canonicalize(c.input)).toThrow(c.error);
      else expect(canonicalize(c.input)).toBe(c.canonical);
    });
  }
});

describe('golden DSSE PAE vectors (copied from rules-core test-vectors/pae.json)', () => {
  const cases =
    fixtureJson<Array<{ name: string; type: string; body: string; pae_hex: string }>>('pae.json');
  it('has at least 4 cases', () => expect(cases.length).toBeGreaterThanOrEqual(4));
  for (const c of cases) {
    it(c.name, () => {
      expect(Buffer.from(pae(c.type, new TextEncoder().encode(c.body))).toString('hex')).toBe(
        c.pae_hex,
      );
    });
  }
});

describe('canonicalize', () => {
  it('drops undefined object keys and maps undefined array items to null', () => {
    expect(canonicalize({ b: undefined, a: [1, undefined] })).toBe('{"a":[1,null]}');
  });

  it('rejects a lone low surrogate, also in keys', () => {
    expect(() => canonicalize('\udc00')).toThrow('lone low surrogate');
    expect(() => canonicalize({ '\ud800': 1 })).toThrow(CanonicalizeError);
  });

  it('rejects non-finite numbers, bigint and unsupported types', () => {
    expect(() => canonicalize(Number.NaN)).toThrow('non-finite');
    expect(() => canonicalize(1n)).toThrow('bigint');
    expect(() => canonicalize(undefined)).toThrow('unsupported type undefined');
    expect(() => canonicalize(() => 1)).toThrow('unsupported type function');
  });

  it('integers mode accepts safe integers and rejects floats and unsafe integers', () => {
    expect(canonicalize({ n: 9007199254740991 }, { numbers: 'integers' })).toBe(
      '{"n":9007199254740991}',
    );
    expect(() => canonicalize({ n: 1.5 }, { numbers: 'integers' })).toThrow('only safe integers');
    expect(() => canonicalize([9007199254740992], { numbers: 'integers' })).toThrow(
      'only safe integers',
    );
    expect(canonicalize(1.5)).toBe('1.5');
  });

  it('is idempotent over JSON round-trips (property)', () => {
    fc.assert(
      fc.property(fc.jsonValue(), (v) => {
        const once = canonicalize(v);
        expect(canonicalize(JSON.parse(once))).toBe(once);
      }),
    );
  });
});

describe('canonicalBytes / canonicalHash', () => {
  it('encodes UTF-8 and hashes the canonical text', () => {
    expect(new TextDecoder().decode(canonicalBytes({ b: 'ă', a: 1 }))).toBe('{"a":1,"b":"ă"}');
    expect(canonicalHash({ b: 1, a: 2 })).toBe(sha256Hex('{"a":2,"b":1}'));
    expect(sha256Hex('')).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
  });
});
