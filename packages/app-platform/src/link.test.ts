import { describe, expect, it } from 'vitest';
import { generateSigningKeyPair } from './keys';
import {
  buildInstallUrl,
  buildSetupRedirect,
  signLinkAssertion,
  verifyLinkAssertion,
} from './link';

const PEER = 'https://staging.brivio.ro';
const AUD = 'https://api.staging.codai.ro';
const STATE = 'st_0123456789abcdef';

async function setup() {
  const { privateJwk, publicJwk } = await generateSigningKeyPair('ES256', 'brivio-1');
  const keysFor = async (iss: string) => (iss === PEER ? [publicJwk] : null);
  const sign = (over: Partial<Parameters<typeof signLinkAssertion>[0]> = {}) =>
    signLinkAssertion({
      issuer: PEER,
      audience: AUD,
      userId: '42',
      app: 'brivio',
      email: 'Ana@Example.ro',
      state: STATE,
      privateKey: privateJwk,
      alg: 'ES256',
      kid: 'brivio-1',
      org: { id: 'space-1', name: 'Ana SRL', tax_id: 'RO123', country: 'RO' },
      ...over,
    });
  return { keysFor, sign };
}

describe('link assertion', () => {
  it('verifies a valid assertion and lowercases the email', async () => {
    const { keysFor, sign } = await setup();
    const r = await verifyLinkAssertion(await sign(), {
      keysFor,
      audience: AUD,
      app: 'brivio',
      state: STATE,
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.userId).toBe('42');
      expect(r.claims.email).toBe('ana@example.ro');
      expect(r.claims.org?.tax_id).toBe('RO123');
    }
  });

  it('rejects an untrusted issuer', async () => {
    const { sign } = await setup();
    const r = await verifyLinkAssertion(await sign(), { keysFor: async () => null, audience: AUD });
    expect(r).toMatchObject({ ok: false, error: 'untrusted_issuer' });
  });

  it('rejects the wrong audience', async () => {
    const { keysFor, sign } = await setup();
    const r = await verifyLinkAssertion(await sign(), {
      keysFor,
      audience: 'https://api.codai.ro',
    });
    expect(r).toMatchObject({ ok: false, error: 'wrong_audience' });
  });

  it('rejects an expired assertion', async () => {
    const { keysFor, sign } = await setup();
    const token = await sign({ now: Math.floor(Date.now() / 1000) - 3600 });
    const r = await verifyLinkAssertion(token, { keysFor, audience: AUD });
    expect(r).toMatchObject({ ok: false, error: 'expired' });
  });

  it('rejects a state or app mismatch', async () => {
    const { keysFor, sign } = await setup();
    const token = await sign();
    expect(
      await verifyLinkAssertion(token, { keysFor, audience: AUD, state: 'st_other_state_x' }),
    ).toMatchObject({
      ok: false,
      error: 'state_mismatch',
    });
    expect(
      await verifyLinkAssertion(token, { keysFor, audience: AUD, app: 'codai' }),
    ).toMatchObject({
      ok: false,
      error: 'wrong_app',
    });
  });

  it('rejects a signature from another key', async () => {
    const { sign } = await setup();
    const other = await generateSigningKeyPair('ES256', 'brivio-1');
    const r = await verifyLinkAssertion(await sign(), {
      keysFor: async () => [other.publicJwk],
      audience: AUD,
    });
    expect(r).toMatchObject({ ok: false, error: 'bad_signature' });
  });

  it('rejects a non-link JWT type', async () => {
    const { keysFor } = await setup();
    const r = await verifyLinkAssertion('eyJhbGciOiJub25lIn0.e30.', { keysFor, audience: AUD });
    expect(r.ok).toBe(false);
  });
});

describe('urls', () => {
  it('builds the install url with state and assertion', () => {
    const u = new URL(
      buildInstallUrl('https://hub.codai.ro', 'brivio', { state: STATE, assertion: 'a.b.c' }),
    );
    expect(u.pathname).toBe('/apps/brivio/install');
    expect(u.searchParams.get('state')).toBe(STATE);
    expect(u.searchParams.get('link_assertion')).toBe('a.b.c');
  });

  it('builds the setup redirect and refuses http', () => {
    const u = new URL(
      buildSetupRedirect('https://brivio.ro/settings/codai/setup', {
        installationId: 'i1',
        action: 'install',
        state: STATE,
      }),
    );
    expect(u.searchParams.get('installation_id')).toBe('i1');
    expect(u.searchParams.get('setup_action')).toBe('install');
    expect(() =>
      buildSetupRedirect('http://evil.example/x', { installationId: 'i', action: 'install' }),
    ).toThrow();
  });
});
