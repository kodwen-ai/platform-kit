import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { loadArtifact } from './artifact';
import { getStoreCatalogEntry, STORE_CATALOG } from './catalog';
import { StoreStateError, StoreValidationError, UnsupportedCapabilityError } from './errors';
import { FirebaseAppDistributionAdapter, parseGroups } from './firebase-app-distribution';
import { GithubReleasesAdapter } from './github-releases';
import { McpRegistryAdapter, NpmRegistryAdapter, PypiRegistryAdapter } from './registries';
import { fakeFetch, token } from './__fixtures__/fetch';
import { crc32, createStoredZip } from './zip';

const FB = 'https://firebaseappdistribution.googleapis.com';
const APPP = 'projects/123/apps/1:123:android:abcdef';

describe('FirebaseAppDistributionAdapter', () => {
  it('uploads, polls the operation, patches notes and distributes to groups', async () => {
    const release = { name: `${APPP}/releases/r1`, buildVersion: '42', displayVersion: '1.0' };
    const f = fakeFetch([
      { json: { name: 'op1' } },
      { json: { name: 'op1', done: true, response: { result: 'RELEASE_CREATED', release } } },
      { json: {} },
      { json: {} },
    ]);
    const a = new FirebaseAppDistributionAdapter({
      projectNumber: '123',
      appId: '1:123:android:abcdef',
      fetch: f.fetch,
      getAccessToken: token,
      sleep: async () => {},
    });
    const up = await a.upload({ bytes: new Uint8Array([1]), kind: 'apk', fileName: 'app.apk' });
    expect(up).toEqual({ artifactId: release.name, versionCode: 42 });
    const st = await a.setTrack({
      track: 'qa, alpha',
      artifactIds: [release.name],
      status: 'completed',
      releaseNotes: { 'en-US': 'hi' },
    });
    expect(f.lines()).toEqual([
      `POST ${FB}/upload/v1/${APPP}/releases:upload`,
      `GET ${FB}/v1/op1`,
      `PATCH ${FB}/v1/${release.name}?updateMask=release_notes.text`,
      `POST ${FB}/v1/${release.name}:distribute`,
    ]);
    expect(f.calls[0]?.headers['x-goog-upload-protocol']).toBe('raw');
    expect(f.calls[0]?.headers['x-goog-upload-file-name']).toBe('app.apk');
    expect(f.calls[3]?.body).toEqual({ groupAliases: ['qa', 'alpha'] });
    expect(st.track).toBe('qa,alpha');
  });

  it('fails on operation error, poll budget and invalid input; has no staged rollout', async () => {
    const opts = {
      projectNumber: '123',
      appId: '1:123:android:abcdef',
      getAccessToken: token,
      sleep: async () => {},
    };
    const e1 = fakeFetch([
      { json: { name: 'op', done: true, error: { code: 3, message: 'bad apk' } } },
    ]);
    await expect(
      new FirebaseAppDistributionAdapter({ ...opts, fetch: e1.fetch }).upload({
        bytes: new Uint8Array(),
        kind: 'apk',
      }),
    ).rejects.toThrow(/bad apk/);
    const e2 = fakeFetch([{ json: { name: 'op' } }, { json: { name: 'op' } }]);
    await expect(
      new FirebaseAppDistributionAdapter({ ...opts, fetch: e2.fetch, maxPolls: 1 }).upload({
        bytes: new Uint8Array(),
        kind: 'apk',
      }),
    ).rejects.toBeInstanceOf(StoreStateError);
    const a = new FirebaseAppDistributionAdapter(opts);
    await expect(
      a.setTrack({ track: 'qa', artifactIds: ['x'], status: 'completed' }),
    ).rejects.toBeInstanceOf(StoreValidationError);
    await expect(
      a.setTrack({
        track: 'qa',
        artifactIds: [`${APPP}/releases/r`],
        status: 'inProgress',
        userFraction: 0.5,
      }),
    ).rejects.toThrow(/completed/);
    await expect(
      a.setTrack({ track: ' , ', artifactIds: [`${APPP}/releases/r`], status: 'completed' }),
    ).rejects.toThrow(/groups/);
    await expect(a.halt('qa')).rejects.toBeInstanceOf(UnsupportedCapabilityError);
    expect(() => new FirebaseAppDistributionAdapter({ ...opts, appId: 'x' })).toThrow(
      StoreValidationError,
    );
    expect(parseGroups('a,,b ')).toEqual(['a', 'b']);
  });

  it('lists recent releases as track state', async () => {
    const f = fakeFetch([
      {
        json: {
          releases: [{ name: `${APPP}/releases/r1`, displayVersion: '1.0', buildVersion: '4' }],
        },
      },
    ]);
    const a = new FirebaseAppDistributionAdapter({
      projectNumber: '123',
      appId: '1:123:android:abcdef',
      fetch: f.fetch,
      getAccessToken: token,
    });
    const st = await a.getTrack('qa');
    expect(st.releases[0]).toMatchObject({ name: '1.0 (4)', status: 'completed' });
    expect(f.lines()[0]).toBe(`GET ${FB}/v1/${APPP}/releases?pageSize=10&orderBy=createTimeDesc`);
  });
});

describe('GithubReleasesAdapter', () => {
  const REPO = 'https://api.github.com/repos/codai-ro/codai';
  it('creates a draft release when the tag is missing, uploads an asset, then publishes as prerelease', async () => {
    const rel = { id: 9, tag_name: 'v1.0.0', draft: true, prerelease: false };
    const f = fakeFetch([
      { status: 404, json: { message: 'Not Found' } },
      { status: 201, json: rel },
      { status: 201, json: { id: 77, name: 'codai.apk' } },
      {
        json: {
          ...rel,
          draft: false,
          prerelease: true,
          body: 'notes',
          assets: [{ id: 77, name: 'codai.apk' }],
        },
      },
    ]);
    const a = new GithubReleasesAdapter({
      owner: 'codai-ro',
      repo: 'codai',
      tag: 'v1.0.0',
      targetCommitish: 'main',
      fetch: f.fetch,
      getAccessToken: token,
    });
    expect(
      await a.upload({ bytes: new Uint8Array([1]), kind: 'apk', fileName: 'codai.apk' }),
    ).toEqual({ artifactId: '77' });
    const st = await a.setTrack({
      track: 'prerelease',
      artifactIds: ['77'],
      status: 'completed',
      releaseNotes: { 'en-US': 'notes' },
    });
    expect(f.lines()).toEqual([
      `GET ${REPO}/releases/tags/v1.0.0`,
      `POST ${REPO}/releases`,
      'POST https://uploads.github.com/repos/codai-ro/codai/releases/9/assets?name=codai.apk',
      `PATCH ${REPO}/releases/9`,
    ]);
    expect(f.calls[1]?.body).toEqual({
      tag_name: 'v1.0.0',
      name: 'v1.0.0',
      draft: true,
      target_commitish: 'main',
    });
    expect(f.calls[2]?.headers['content-type']).toBe('application/vnd.android.package-archive');
    expect(f.calls[3]?.body).toEqual({
      draft: false,
      prerelease: true,
      make_latest: 'false',
      body: 'notes',
    });
    expect(f.calls[0]?.headers['x-github-api-version']).toBe('2022-11-28');
    expect(st).toEqual({
      track: 'prerelease',
      releases: [
        {
          name: 'v1.0.0',
          artifactIds: ['77'],
          status: 'completed',
          releaseNotes: { 'en-US': 'notes' },
        },
      ],
    });
  });

  it('reports the latest published tag and rejects rollout semantics', async () => {
    const f = fakeFetch([
      { json: { id: 1, tag_name: 'v2.0.0', draft: false, prerelease: false } },
      { status: 404, text: '' },
      { status: 404, text: '' },
    ]);
    const a = new GithubReleasesAdapter({
      owner: 'o',
      repo: 'r',
      tag: 'v2.0.0',
      fetch: f.fetch,
      getAccessToken: token,
    });
    expect(await a.getReviewStatus()).toEqual({ state: 'live', version: 'v2.0.0' });
    expect(await a.getReviewStatus()).toEqual({ state: 'unknown', detail: 'no published release' });
    expect(await a.getTrack('latest')).toEqual({ track: 'latest', releases: [] });
    await expect(
      a.setTrack({ track: 'latest', artifactIds: [], status: 'inProgress', userFraction: 0.5 }),
    ).rejects.toBeInstanceOf(StoreValidationError);
    await expect(
      a.setTrack({ track: 'beta', artifactIds: [], status: 'completed' }),
    ).rejects.toThrow(/latest/);
    await expect(a.halt('latest')).rejects.toBeInstanceOf(UnsupportedCapabilityError);
    expect(
      () => new GithubReleasesAdapter({ owner: 'a b', repo: 'r', tag: 't', getAccessToken: token }),
    ).toThrow(StoreValidationError);
  });
});

describe('registry adapters', () => {
  it('npm reads dist-tags, scoped names escaped, missing package -> unknown', async () => {
    const f = fakeFetch([
      { json: { 'dist-tags': { latest: '1.2.3', next: '2.0.0-rc.1' } } },
      { status: 404, json: {} },
    ]);
    const a = new NpmRegistryAdapter('@codai/sdk', { fetch: f.fetch });
    expect(await a.getReviewStatus()).toEqual({ state: 'live', version: '1.2.3' });
    expect(f.lines()[0]).toBe('GET https://registry.npmjs.org/@codai%2fsdk');
    expect(await a.getReviewStatus()).toEqual({ state: 'unknown', detail: 'not published' });
    await expect(a.upload({ bytes: new Uint8Array(), kind: 'tgz' })).rejects.toBeInstanceOf(
      UnsupportedCapabilityError,
    );
    expect(() => new NpmRegistryAdapter('Bad Name')).toThrow(StoreValidationError);
  });

  it('PyPI reads info.version', async () => {
    const f = fakeFetch([{ json: { info: { version: '0.4.0' } } }]);
    expect(await new PypiRegistryAdapter('codai', { fetch: f.fetch }).getReviewStatus()).toEqual({
      state: 'live',
      version: '0.4.0',
    });
    expect(f.lines()[0]).toBe('GET https://pypi.org/pypi/codai/json');
  });

  it('MCP registry picks the isLatest entry of the exact server name', async () => {
    const meta = (isLatest: boolean, status = 'active') => ({
      'io.modelcontextprotocol.registry/official': { status, isLatest },
    });
    const f = fakeFetch([
      {
        json: {
          servers: [
            { server: { name: 'ro.codai/mcp', version: '1.0.0' }, _meta: meta(false) },
            { server: { name: 'ro.codai/mcp-other', version: '9.0.0' }, _meta: meta(true) },
            { server: { name: 'ro.codai/mcp', version: '1.1.0' }, _meta: meta(true) },
          ],
        },
      },
      {
        json: {
          servers: [
            { server: { name: 'ro.codai/mcp', version: '1.0.0' }, _meta: meta(true, 'deprecated') },
          ],
        },
      },
      { json: { servers: [] } },
    ]);
    const a = new McpRegistryAdapter('ro.codai/mcp', { fetch: f.fetch });
    expect(await a.getReviewStatus()).toEqual({ state: 'live', version: '1.1.0' });
    expect(f.lines()[0]).toBe(
      'GET https://registry.modelcontextprotocol.io/v0/servers?search=ro.codai%2Fmcp&limit=100',
    );
    expect(await a.getReviewStatus()).toEqual({
      state: 'unknown',
      version: '1.0.0',
      detail: 'deprecated',
    });
    expect(await a.getReviewStatus()).toEqual({ state: 'unknown', detail: 'not published' });
  });
});

describe('STORE_CATALOG', () => {
  it('has unique ids, https docs and marks unimplemented stores', () => {
    const ids = STORE_CATALOG.map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(STORE_CATALOG.every((e) => e.docsUrl.startsWith('https://'))).toBe(true);
    const missing = STORE_CATALOG.filter((e) => !e.implemented).map((e) => e.id);
    expect(missing).toEqual([
      'huawei_appgallery',
      'samsung_galaxy_store',
      'amazon_appstore',
      'winget',
      'chrome_web_store',
      'vscode_marketplace',
    ]);
    expect(getStoreCatalogEntry('google_play')?.implemented).toBe(true);
  });
});

describe('zip + artifact', () => {
  it('crc32 matches the standard check value', () => {
    expect(crc32(new TextEncoder().encode('123456789'))).toBe(0xcbf43926);
  });

  it('stored zip has a local header, the raw data and an end record', () => {
    fc.assert(
      fc.property(fc.uint8Array({ maxLength: 256 }), (data) => {
        const z = createStoredZip([{ name: 'a.msix', data }]);
        const v = new DataView(z.buffer);
        expect(v.getUint32(0, true)).toBe(0x04034b50);
        expect(v.getUint32(14, true)).toBe(crc32(data));
        expect([...z.slice(36, 36 + data.length)]).toEqual([...data]);
        expect(v.getUint32(z.length - 22, true)).toBe(0x06054b50);
      }),
    );
    expect(() => createStoredZip([])).toThrow(StoreValidationError);
    expect(() => createStoredZip([{ name: '../x', data: new Uint8Array() }])).toThrow(
      StoreValidationError,
    );
  });

  it('loads an artifact from disk with its basename', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'sa-'));
    const p = join(dir, 'app.aab');
    await writeFile(p, new Uint8Array([7, 8]));
    expect(await loadArtifact({ artifactPath: p, kind: 'aab' })).toEqual({
      bytes: expect.any(Uint8Array),
      fileName: 'app.aab',
    });
    expect((await loadArtifact({ bytes: new Uint8Array([1]), kind: 'vsix' })).fileName).toBe(
      'artifact.vsix',
    );
  });
});
