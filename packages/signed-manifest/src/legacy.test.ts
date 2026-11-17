import { describe, expect, it } from 'vitest';
import { fromBase64 } from './base64';
import type { Envelope } from './envelope';
import {
  fromLegacyPhone,
  fromLegacyUiBundle,
  parseLegacyDirectives,
  uiBundleSequence,
} from './legacy';
import { cohortOf, isEligible } from './release';
import { fixtureJson } from './__fixtures__/helpers';

function payloadOf(file: string): unknown {
  const env = fixtureJson<Envelope>(file);
  return JSON.parse(Buffer.from(fromBase64(env.payload) ?? []).toString('utf8'));
}

describe('parseLegacyDirectives (same rules as apps/web parseDirectives + parseUiDirectives)', () => {
  it.each([
    [null, { rollout: 100, pulled: false, uiChannel: 'stable', uiShell: null }],
    ['notes\n<!-- codai-rollout: 25 -->', { rollout: 25, pulled: false }],
    ['<!--codai-rollout:150-->', { rollout: 100 }],
    ['<!-- codai-rollout: -5 -->', { rollout: 0 }],
    ['<!-- codai-rollout: abc -->', { rollout: 100 }],
    ['<!-- CODAI-PULLED -->', { pulled: true }],
    ['<!-- codai-ui-channel: Beta -->', { uiChannel: 'beta' }],
    ['<!-- codai-ui-channel: nightly -->', { uiChannel: null }],
    ['<!-- codai-ui-shell: ABCDEF -->', { uiShell: 'abcdef' }],
  ])('parses %j', (body, want) => expect(parseLegacyDirectives(body)).toMatchObject(want));
});

describe('fromLegacyPhone', () => {
  it('converts the real signed v1 phone payload', () => {
    const v2 = fromLegacyPhone(payloadOf('kms-signtest-envelope.json'), {
      directives: { rollout: 10 },
    });
    expect(v2).toMatchObject({
      v: 2,
      kind: 'release',
      product: 'ro.codai.phone',
      surface: 'android',
      version: '0.0.0-signtest.1',
      version_code: 1,
      channel: 'beta',
      min_os: 'android-sdk:30',
      sequence: 1,
      artifact: { name: 'codai-phone-0.0.0-signtest.1.apk', size: 16 },
      directives: {
        rollout: 10,
        pulled: false,
        halted: false,
        revoked_versions: [],
        cohort_seed_prefix: '',
      },
    });
    expect(
      isEligible(v2, { cohort: cohortOf('x'), currentVersionCode: 0, now: 1_790_351_883_305 }),
    ).toMatch(/OK|NOT_IN_ROLLOUT/);
  });

  it('stable channel for a release version and overrides win', () => {
    const v1 = {
      ...(payloadOf('kms-signtest-envelope.json') as object),
      version: '1.0.0',
      notes: '',
    };
    const v2 = fromLegacyPhone(v1, {
      product: 'p',
      sequence: 9,
      revokedVersions: ['0.9.0'],
      directives: { pulled: true },
    });
    expect(v2).toMatchObject({
      channel: 'stable',
      product: 'p',
      sequence: 9,
      directives: { pulled: true, revoked_versions: ['0.9.0'] },
    });
    expect(v2).not.toHaveProperty('notes');
  });

  it('rejects a non-phone payload', () => {
    expect(() => fromLegacyPhone(payloadOf('ui-latest.json'))).toThrow();
  });
});

describe('fromLegacyUiBundle', () => {
  it('converts the real signed v1 ui-bundle payload with desktop cohort prefix', () => {
    const d = parseLegacyDirectives('<!-- codai-ui-channel: beta -->\n<!-- codai-rollout: 30 -->');
    const v2 = fromLegacyUiBundle(payloadOf('ui-latest.json'), {
      uiChannel: d.uiChannel,
      directives: d,
    });
    expect(v2).toMatchObject({
      surface: 'ui-bundle',
      product: 'ro.codai.desktop',
      version: '0.0.0-ui.1',
      channel: 'beta',
      requires_shell: 'be85a7cbe1a494c8fc688a112687428a569b7311499822936bdda6f5d2442cd3',
      sequence: 1,
      artifact: { name: 'codai-ui-0.0.0-ui.1.zip', size: 316 },
      directives: { rollout: 30, cohort_seed_prefix: 'codai-update-cohort:' },
    });
    expect(Object.keys(v2.files ?? {})).toEqual(['assets/app.js', 'index.html']);
  });

  it('rejects a phone payload', () => {
    expect(() => fromLegacyUiBundle(payloadOf('kms-signtest-envelope.json'))).toThrow();
  });
});

describe('uiBundleSequence', () => {
  it('is monotonic across versions and rejects bad input', () => {
    expect(uiBundleSequence('0.7.0-ui.10')).toBeGreaterThan(uiBundleSequence('0.7.0-ui.9'));
    expect(uiBundleSequence('0.8.0-ui.1')).toBeGreaterThan(uiBundleSequence('0.7.999-ui.999'));
    expect(uiBundleSequence('1.2.3-ui.4')).toBe(1_002_003_004);
    expect(() => uiBundleSequence('1.2.3')).toThrow(RangeError);
    expect(() => uiBundleSequence('1.2.3-ui.1000')).toThrow(RangeError);
  });
});
