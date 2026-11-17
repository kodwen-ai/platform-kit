import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { toBase64 } from './base64';
import { signEnvelope } from './envelope';
import { PAYLOAD_TYPES } from './payload-types';
import {
  DESKTOP_COHORT_PREFIX,
  ReleaseManifestV2Schema,
  cohortOf,
  isEligible,
  signReleaseManifestV2,
  verifyReleaseManifestV2,
  type EligibilityInput,
  type EligibilityReason,
  type ReleaseManifestV2,
} from './release';
import { compareSemver } from './semver';
import { localP256Signer } from './signers';
import { fixtureJson, keyPair } from './__fixtures__/helpers';

const NOW = 1_790_000_000_000;

function manifest(
  over: Partial<ReleaseManifestV2> = {},
  dir: Partial<ReleaseManifestV2['directives']> = {},
): ReleaseManifestV2 {
  return {
    v: 2,
    kind: 'release',
    product: 'ro.codai.phone',
    surface: 'android',
    version: '1.2.0',
    version_code: 120,
    channel: 'stable',
    issued_at: NOW - 1000,
    expires_at: NOW + 86_400_000,
    artifact: {
      url: 'https://codai.ro/api/phone/download/codai-phone-1.2.0.apk',
      sha256: 'a'.repeat(64),
      size: 1234,
    },
    directives: {
      rollout: 100,
      pulled: false,
      halted: false,
      revoked_versions: [],
      cohort_seed_prefix: '',
      ...dir,
    },
    sequence: 120,
    ...over,
  };
}

describe('cohortOf', () => {
  // Computed independently in .NET with the Kotlin cohortOf / Rust cohort_of byte logic.
  const vectors =
    fixtureJson<Array<{ prefix: string; seed: string; cohort: number }>>('cohort.json');
  for (const v of vectors) {
    it(`cohortOf(${JSON.stringify(v.seed)}, ${JSON.stringify(v.prefix)}) = ${v.cohort}`, () => {
      expect(cohortOf(v.seed, v.prefix)).toBe(v.cohort);
    });
  }

  it('matches the PhoneReleaseTest BigInteger formulation for "abc"', () => {
    const d = createHash('sha256').update('abc').digest();
    expect(cohortOf('abc')).toBe(Number(BigInt('0x' + d.subarray(0, 8).toString('hex')) % 100n));
  });

  it('desktop prefix is codai-update-cohort: and buckets spread over 0..99', () => {
    expect(DESKTOP_COHORT_PREFIX).toBe('codai-update-cohort:');
    const seen = new Set(
      Array.from({ length: 500 }, (_, i) => cohortOf(`d${i}`, DESKTOP_COHORT_PREFIX)),
    );
    expect(Math.min(...seen)).toBeGreaterThanOrEqual(0);
    expect(Math.max(...seen)).toBeLessThanOrEqual(99);
    expect(seen.size).toBeGreaterThan(90);
  });
});

describe('isEligible', () => {
  const base: EligibilityInput = {
    cohort: 50,
    currentVersionCode: 110,
    currentVersion: '1.1.0',
    now: NOW,
  };
  const table: Array<[string, ReleaseManifestV2, EligibilityInput, EligibilityReason]> = [
    ['full rollout, newer', manifest(), base, 'OK'],
    ['expired at exactly expires_at', manifest(), { ...base, now: NOW + 86_400_000 }, 'EXPIRED'],
    [
      'pulled beats everything after expiry',
      manifest({}, { pulled: true, halted: true }),
      base,
      'PULLED',
    ],
    ['halted', manifest({}, { halted: true }), base, 'HALTED'],
    ['own version revoked', manifest({}, { revoked_versions: ['1.2.0'] }), base, 'REVOKED'],
    ['same version_code', manifest(), { ...base, currentVersionCode: 120 }, 'NOT_NEWER'],
    [
      'older semver without codes',
      manifest({ version_code: undefined }),
      { cohort: 0, currentVersion: '1.3.0', now: NOW },
      'NOT_NEWER',
    ],
    [
      'newer semver without codes',
      manifest({ version_code: undefined }),
      { cohort: 0, currentVersion: '1.2.0-beta.1', now: NOW },
      'OK',
    ],
    ['cohort below rollout', manifest({}, { rollout: 51 }), base, 'OK'],
    ['cohort equal to rollout is out', manifest({}, { rollout: 50 }), base, 'NOT_IN_ROLLOUT'],
    [
      'rollout 0 excludes cohort 0',
      manifest({}, { rollout: 0 }),
      { ...base, cohort: 0 },
      'NOT_IN_ROLLOUT',
    ],
    [
      'current version revoked bypasses rollout',
      manifest({}, { rollout: 0, revoked_versions: ['1.1.0'] }),
      base,
      'OK',
    ],
    ['no current version info = newer', manifest(), { cohort: 1, now: NOW }, 'OK'],
  ];
  for (const [name, m, input, want] of table)
    it(name, () => expect(isEligible(m, input)).toBe(want));
});

describe('compareSemver', () => {
  it.each([
    ['1.0.0', '1.0.0', 0],
    ['1.0.1', '1.0.0', 1],
    ['1.0.0-alpha', '1.0.0', -1],
    ['1.0.0-alpha.1', '1.0.0-alpha.beta', -1],
    ['1.0.0-beta.11', '1.0.0-beta.2', 1],
    ['1.0.0-rc.1', '1.0.0-rc.1.1', -1],
    ['v2.0', '1.9.9', 1],
    ['1.0.0+build', '1.0.0', 0],
    ['garbage', '0.0.1', -1],
    ['x', 'y', 0],
    ['0.0.1', 'garbage', 1],
    ['0.7.0-ui.10', '0.7.0-ui.9', 1],
  ])('compareSemver(%s, %s) = %i', (a, b, want) => expect(compareSemver(a, b)).toBe(want));
});

describe('ReleaseManifestV2Schema', () => {
  it('accepts a full manifest with optional fields and unknown extra keys', () => {
    const m = {
      ...manifest(),
      notes_i18n: { ro: 'Notă', en: 'Note' },
      files: { 'index.html': 'b'.repeat(64) },
      future: 1,
    };
    expect(ReleaseManifestV2Schema.parse(m)).toMatchObject({ future: 1 });
  });

  it.each([
    [
      'uppercase sha256',
      { artifact: { url: 'https://codai.ro/x', sha256: 'A'.repeat(64), size: 1 } },
    ],
    ['http url', { artifact: { url: 'http://codai.ro/x', sha256: 'a'.repeat(64), size: 1 } }],
    ['float version_code', { version_code: 1.5 }],
    ['expires before issue', { expires_at: NOW - 2000 }],
    ['notes too long', { notes: 'x'.repeat(2001) }],
    ['bad semver', { version: '1.2' }],
  ])('rejects %s', (_name, over) => {
    expect(ReleaseManifestV2Schema.safeParse({ ...manifest(), ...over }).success).toBe(false);
  });

  it('rejects rollout outside 0..100', () => {
    expect(ReleaseManifestV2Schema.safeParse(manifest({}, { rollout: 101 })).success).toBe(false);
  });
});

const manifestArb: fc.Arbitrary<ReleaseManifestV2> = fc
  .record({
    product: fc.stringMatching(/^[a-z][a-z0-9.]{0,20}$/),
    surface: fc.constantFrom(
      'android',
      'wear',
      'windows',
      'macos',
      'linux',
      'ui-bundle',
      'web-bundle',
      'tv',
    ),
    major: fc.nat(50),
    minor: fc.nat(50),
    patch: fc.nat(50),
    code: fc.integer({ min: 1, max: 2 ** 31 - 1 }),
    channel: fc.constantFrom('stable', 'beta', 'internal'),
    issued: fc.integer({ min: 0, max: 2 ** 45 }),
    ttl: fc.integer({ min: 1, max: 2 ** 40 }),
    sha: fc.stringMatching(/^[0-9a-f]{64}$/),
    size: fc.integer({ min: 1, max: Number.MAX_SAFE_INTEGER }),
    notes: fc.string({ maxLength: 200 }),
    rollout: fc.integer({ min: 0, max: 100 }),
    pulled: fc.boolean(),
    halted: fc.boolean(),
    revoked: fc.array(fc.stringMatching(/^\d\.\d\.\d$/), { maxLength: 3 }),
    sequence: fc.nat(),
  })
  .map((r) =>
    manifest(
      {
        product: r.product,
        surface: r.surface,
        version: `${r.major}.${r.minor}.${r.patch}`,
        version_code: r.code,
        channel: r.channel,
        issued_at: r.issued,
        expires_at: r.issued + r.ttl,
        artifact: { url: 'https://codai.ro/d/a.bin', sha256: r.sha, size: r.size },
        notes: r.notes,
        sequence: r.sequence,
      },
      { rollout: r.rollout, pulled: r.pulled, halted: r.halted, revoked_versions: r.revoked },
    ),
  );

describe('signReleaseManifestV2 / verifyReleaseManifestV2', () => {
  const kp = keyPair('p256');
  const signer = localP256Signer(kp.privateKeyPem);

  it('round-trips random manifests (property)', async () => {
    await fc.assert(
      fc.asyncProperty(manifestArb, async (m) => {
        const env = await signReleaseManifestV2(m, { signer, keyid: 'k' });
        expect(env.payloadType).toBe(PAYLOAD_TYPES.releaseV2);
        const r = verifyReleaseManifestV2(env, { publicKeysPem: [kp.publicKeyPem] });
        expect(r).toEqual({ ok: true, manifest: ReleaseManifestV2Schema.parse(m), keyIndex: 0 });
      }),
      { numRuns: 40 },
    );
  });

  it('directives are signed: changing rollout breaks the signature', async () => {
    const env = await signReleaseManifestV2(manifest({}, { rollout: 5 }), { signer });
    const tampered = {
      ...env,
      payload: toBase64(new TextEncoder().encode(JSON.stringify(manifest({}, { rollout: 100 })))),
    };
    expect(verifyReleaseManifestV2(tampered, { publicKeysPem: [kp.publicKeyPem] })).toMatchObject({
      ok: false,
      reason: 'BAD_SIGNATURE',
    });
  });

  it('SCHEMA_INVALID for a validly signed v2 payload with a bad shape', async () => {
    const env = await signEnvelope(
      { v: 2, kind: 'release' },
      { payloadType: PAYLOAD_TYPES.releaseV2, signer },
    );
    expect(verifyReleaseManifestV2(env, { publicKeysPem: [kp.publicKeyPem] })).toMatchObject({
      ok: false,
      reason: 'SCHEMA_INVALID',
    });
  });

  it('WRONG_TYPE for a v1 envelope', async () => {
    const env = await signEnvelope(manifest(), {
      payloadType: PAYLOAD_TYPES.phoneReleaseV1,
      signer,
    });
    expect(verifyReleaseManifestV2(env, { publicKeysPem: [kp.publicKeyPem] })).toMatchObject({
      reason: 'WRONG_TYPE',
    });
  });

  it('refuses to sign an invalid manifest', async () => {
    await expect(
      signReleaseManifestV2({ ...manifest(), version: 'nope' }, { signer }),
    ).rejects.toThrow();
  });
});
