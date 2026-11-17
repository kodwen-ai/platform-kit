import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import { AUDIENCE, ISSUER, makeFixture } from './__fixtures__/platform';
import { runConformanceCli } from './cli-main';
import {
  CONFORMANCE_CHECK_IDS,
  formatConformanceReport,
  runConformance,
  type ConformanceReport,
} from './conformance-suite';

describe('conformance suite', () => {
  it.each([
    ['ES256', 'RS256'],
    ['RS256', 'ES256'],
  ] as const)(
    'passes every check against the in-memory Hono server (issuer %s, app %s)',
    async (serverAlg, appAlg) => {
      const f = await makeFixture({ serverAlg, appAlg });
      const report = await runConformance({
        baseUrl: ISSUER,
        appId: 'app_1',
        privateKey: f.appKey.privateJwk,
        alg: appAlg,
        kid: 'app-key-1',
        installationId: 'inst_1',
        audience: AUDIENCE,
        fetch: f.fetch,
      });
      expect(report.results.filter((r) => !r.ok)).toEqual([]);
      expect(report.passed).toBe(CONFORMANCE_CHECK_IDS.length);
      expect(report.failed).toBe(0);
    },
  );

  it('detects a non-conforming server (proves the checks can fail)', async () => {
    const f = await makeFixture();
    const broken = new Hono();
    broken.all('*', async (c) => {
      const url = new URL(c.req.url);
      if (url.pathname.endsWith('/installation/token')) return c.body(null, 204);
      const headers = new Headers(c.req.raw.headers);
      headers.delete('codai-platform-version');
      return f.hono.request(c.req.raw.url, {
        method: c.req.method,
        headers,
        ...(c.req.method === 'GET' ? {} : { body: await c.req.text() }),
      });
    });
    const fetchImpl = (async (i: RequestInfo | URL, init?: RequestInit) =>
      broken.request(String(i), init)) as typeof fetch;
    const report = await runConformance({
      baseUrl: ISSUER,
      appId: 'app_1',
      privateKey: f.appKey.privateJwk,
      alg: f.appAlg,
      installationId: 'inst_1',
      audience: AUDIENCE,
      fetch: fetchImpl,
    });
    const failed = report.results.filter((r) => !r.ok).map((r) => r.id);
    expect(failed).toEqual(['revocation', 'unknown-revision']);
    expect(formatConformanceReport(report)).toMatch(/FAIL\s+revocation/);
  });

  it('reports failures when the server is unreachable', async () => {
    const f = await makeFixture();
    const down = (async () => {
      throw new TypeError('ECONNREFUSED');
    }) as typeof fetch;
    const report = await runConformance({
      baseUrl: ISSUER,
      appId: 'app_1',
      privateKey: f.appKey.privateJwk,
      alg: f.appAlg,
      installationId: 'inst_1',
      audience: AUDIENCE,
      fetch: down,
    });
    expect(report.passed).toBe(0);
    expect(report.results[0]?.detail).toContain('ECONNREFUSED');
  });
});

describe('conformance CLI', () => {
  const report: ConformanceReport = {
    passed: 1,
    failed: 0,
    results: [{ id: 'discovery', title: 't', ok: true, detail: 'd' }],
  };
  const env = {
    CODAI_PLATFORM_URL: ISSUER,
    CODAI_PLATFORM_APP_ID: 'app_1',
    CODAI_PLATFORM_INSTALLATION_ID: 'inst_1',
    CODAI_PLATFORM_AUDIENCE: AUDIENCE,
    CODAI_PLATFORM_APP_KEY_FILE: '/keys/app.pem',
  };
  const label = ['PRIVATE', 'KEY'].join(' ');
  const FAKE_PEM = `-----BEGIN ${label}-----\\nFAKEMATERIAL\\n-----END ${label}-----`;

  function io(over: Record<string, string | undefined>, run = async () => report) {
    const out: string[] = [];
    const err: string[] = [];
    let seen: { privateKey?: unknown; alg?: string } = {};
    return {
      out,
      err,
      seen: () => seen,
      io: {
        env: { ...env, ...over },
        readFile: async (p: string) => {
          if (p !== '/keys/app.pem') throw new Error('ENOENT');
          return FAKE_PEM;
        },
        out: (l: string) => out.push(l),
        err: (l: string) => err.push(l),
        run: async (o: { privateKey: unknown; alg: string }) => ((seen = o), run()),
      },
    };
  }

  it('prints the table, exits 0 and never prints key material', async () => {
    const t = io({});
    expect(await runConformanceCli(t.io)).toBe(0);
    expect(t.out.join('\n')).toContain('1 passed, 0 failed');
    expect([...t.out, ...t.err].join('\n')).not.toContain('FAKEMATERIAL');
    expect(t.seen().privateKey).toContain('\nFAKEMATERIAL\n');
    expect(t.seen().alg).toBe('ES256');
  });

  it('exits 1 on failed checks or aborted runs', async () => {
    expect(
      await runConformanceCli(io({}, async () => ({ ...report, passed: 0, failed: 1 })).io),
    ).toBe(1);
    const t = io({}, async () => {
      throw new Error('boom FAKEMATERIAL');
    });
    expect(await runConformanceCli(t.io)).toBe(1);
    expect(t.err.join('')).not.toContain('FAKEMATERIAL');
  });

  it('exits 2 on missing env, unreadable key or bad alg', async () => {
    const missing = io({ CODAI_PLATFORM_URL: undefined, CODAI_PLATFORM_APP_KEY_FILE: undefined });
    expect(await runConformanceCli(missing.io)).toBe(2);
    expect(missing.err[0]).toContain('CODAI_PLATFORM_URL');
    expect(await runConformanceCli(io({ CODAI_PLATFORM_APP_KEY_FILE: '/nope' }).io)).toBe(2);
    expect(await runConformanceCli(io({ CODAI_PLATFORM_APP_ALG: 'HS256' }).io)).toBe(2);
  });

  it('uses an inline PEM and explicit alg when given', async () => {
    const t = io({
      CODAI_PLATFORM_APP_KEY_FILE: undefined,
      CODAI_PLATFORM_APP_KEY_PEM: 'x'.repeat(1200),
      CODAI_PLATFORM_APP_ALG: 'RS256',
      CODAI_PLATFORM_KID: 'k1',
    });
    expect(await runConformanceCli(t.io)).toBe(0);
    expect(t.seen().alg).toBe('RS256');
  });
});
