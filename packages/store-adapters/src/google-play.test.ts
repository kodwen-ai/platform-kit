import { describe, expect, it } from 'vitest';
import {
  StoreApiError,
  StoreStateError,
  StoreValidationError,
  UnsupportedCapabilityError,
} from './errors';
import { fromPlayTrack, GooglePlayAdapter, toPlayTrack } from './google-play';
import { fakeFetch, token } from './__fixtures__/fetch';

const API =
  'https://androidpublisher.googleapis.com/androidpublisher/v3/applications/ro.example.app';
const UP =
  'https://androidpublisher.googleapis.com/upload/androidpublisher/v3/applications/ro.example.app';
const bytes = new Uint8Array([1, 2, 3]);

function adapter(script: Parameters<typeof fakeFetch>[0]) {
  const f = fakeFetch(script);
  return {
    f,
    a: new GooglePlayAdapter({
      packageName: 'ro.example.app',
      fetch: f.fetch,
      getAccessToken: token,
    }),
  };
}

describe('GooglePlayAdapter', () => {
  it('uploads, sets a staged rollout and commits inside ONE edit (edit -> upload -> track -> commit)', async () => {
    const { f, a } = adapter([
      { json: { id: 'E1' } },
      { json: { versionCode: 42 } },
      {
        json: {
          track: 'production',
          releases: [{ versionCodes: ['42'], status: 'inProgress', userFraction: 0.1 }],
        },
      },
      { json: {} },
    ]);
    const up = await a.upload({ bytes, kind: 'aab' });
    expect(up).toEqual({ artifactId: '42', versionCode: 42 });
    expect(a.pendingEdit).toBe('E1');
    const st = await a.setTrack({
      track: 'production',
      artifactIds: [up.artifactId],
      status: 'inProgress',
      userFraction: 0.1,
      releaseNotes: { 'en-US': 'Fixes', 'ro-RO': 'Reparații' },
      name: '42 (1.0)',
    });
    expect(f.lines()).toEqual([
      `POST ${API}/edits`,
      `POST ${UP}/edits/E1/bundles?uploadType=media`,
      `PUT ${API}/edits/E1/tracks/production`,
      `POST ${API}/edits/E1:commit`,
    ]);
    expect(f.calls[0]?.headers.authorization).toBe('Bearer tok');
    expect(f.calls[1]?.headers['content-type']).toBe('application/octet-stream');
    expect(f.calls[2]?.body).toEqual({
      track: 'production',
      releases: [
        {
          name: '42 (1.0)',
          versionCodes: ['42'],
          status: 'inProgress',
          userFraction: 0.1,
          releaseNotes: [
            { language: 'en-US', text: 'Fixes' },
            { language: 'ro-RO', text: 'Reparații' },
          ],
        },
      ],
    });
    expect(st.releases[0]).toMatchObject({
      status: 'inProgress',
      userFraction: 0.1,
      artifactIds: ['42'],
    });
    expect(a.pendingEdit).toBeUndefined();
  });

  it('deletes the edit when the track update fails', async () => {
    const { f, a } = adapter([
      { json: { id: 'E2' } },
      { json: { versionCode: 7 } },
      { status: 400, json: { error: { message: 'bad' } } },
      { status: 204 },
    ]);
    await a.upload({ bytes, kind: 'aab' });
    await expect(
      a.setTrack({ track: 'internal', artifactIds: ['7'], status: 'draft' }),
    ).rejects.toBeInstanceOf(StoreApiError);
    expect(f.lines()).toEqual([
      `POST ${API}/edits`,
      `POST ${UP}/edits/E2/bundles?uploadType=media`,
      `PUT ${API}/edits/E2/tracks/internal`,
      `DELETE ${API}/edits/E2`,
    ]);
    expect(a.pendingEdit).toBeUndefined();
  });

  it('deletes the edit when the upload itself fails', async () => {
    const { f, a } = adapter([
      { json: { id: 'E3' } },
      { status: 500, text: 'boom' },
      { status: 204 },
    ]);
    await expect(a.upload({ bytes, kind: 'apk' })).rejects.toThrow(/HTTP 500/);
    expect(f.lines()).toEqual([
      `POST ${API}/edits`,
      `POST ${UP}/edits/E3/apks?uploadType=media`,
      `DELETE ${API}/edits/E3`,
    ]);
  });

  it('halts the inProgress release keeping the others', async () => {
    const live = { versionCodes: ['40'], status: 'completed' };
    const staged = { versionCodes: ['42'], status: 'inProgress', userFraction: 0.2 };
    const { f, a } = adapter([
      { json: { id: 'R' } },
      { json: { track: 'production', releases: [live, staged] } },
      { status: 204 },
      { json: { id: 'W' } },
      { json: {} },
      { json: {} },
    ]);
    const st = await a.halt('production');
    expect(f.lines()).toEqual([
      `POST ${API}/edits`,
      `GET ${API}/edits/R/tracks/production`,
      `DELETE ${API}/edits/R`,
      `POST ${API}/edits`,
      `PUT ${API}/edits/W/tracks/production`,
      `POST ${API}/edits/W:commit`,
    ]);
    expect(f.calls[4]?.body).toEqual({
      track: 'production',
      releases: [live, { ...staged, status: 'halted' }],
    });
    expect(st.releases.map((r) => r.status)).toEqual(['completed', 'halted']);
  });

  it('resumes a halted release with a new fraction and completes it without userFraction', async () => {
    const halted = { versionCodes: ['42'], status: 'halted', userFraction: 0.2 };
    const { f, a } = adapter([
      { json: { id: 'R' } },
      { json: { track: 'beta', releases: [halted] } },
      { status: 204 },
      { json: { id: 'W' } },
      { json: {} },
      { json: {} },
      { json: { id: 'R2' } },
      {
        json: { track: 'beta', releases: [{ ...halted, status: 'inProgress', userFraction: 0.5 }] },
      },
      { status: 204 },
      { json: { id: 'W2' } },
      { json: {} },
      { json: {} },
    ]);
    await a.resume('beta', 0.5);
    expect(f.calls[4]?.body).toEqual({
      track: 'beta',
      releases: [{ versionCodes: ['42'], status: 'inProgress', userFraction: 0.5 }],
    });
    await a.complete('beta');
    expect(f.calls[10]?.body).toEqual({
      track: 'beta',
      releases: [{ versionCodes: ['42'], status: 'completed' }],
    });
  });

  it('refuses halt when nothing is rolling out', async () => {
    const { a } = adapter([
      { json: { id: 'R' } },
      { json: { track: 'production', releases: [{ versionCodes: ['1'], status: 'completed' }] } },
      { status: 204 },
    ]);
    await expect(a.halt('production')).rejects.toBeInstanceOf(StoreStateError);
  });

  it('validates rollout fraction, notes length, kind and package name before any request', async () => {
    const { f, a } = adapter([]);
    await expect(
      a.setTrack({ track: 'production', artifactIds: ['1'], status: 'inProgress' }),
    ).rejects.toBeInstanceOf(StoreValidationError);
    await expect(
      a.setTrack({
        track: 'production',
        artifactIds: ['1'],
        status: 'inProgress',
        userFraction: 1,
      }),
    ).rejects.toThrow(/0 < f < 1/);
    await expect(
      a.setTrack({
        track: 'production',
        artifactIds: ['1'],
        status: 'completed',
        userFraction: 0.5,
      }),
    ).rejects.toThrow(/only allowed/);
    await expect(
      a.setTrack({
        track: 'internal',
        artifactIds: ['1'],
        status: 'draft',
        releaseNotes: { 'en-US': 'x'.repeat(501) },
      }),
    ).rejects.toThrow(/501 chars \(max 500\)/);
    await expect(
      a.setTrack({
        track: 'internal',
        artifactIds: ['1'],
        status: 'draft',
        releaseNotes: { 'en-US': 'é'.repeat(500) },
      }),
    ).rejects.toThrow(/unexpected request/);
    await expect(
      a.setTrack({ track: 'internal', artifactIds: ['v1'], status: 'draft' }),
    ).rejects.toThrow(/numeric/);
    await expect(a.upload({ bytes, kind: 'msix' })).rejects.toBeInstanceOf(StoreValidationError);
    expect(() => new GooglePlayAdapter({ packageName: 'nodots', getAccessToken: token })).toThrow(
      StoreValidationError,
    );
    expect(f.calls).toHaveLength(1);
  });

  it('patches a listing with length limits and rejects unsupported review status', async () => {
    const { f, a } = adapter([{ json: { id: 'L' } }, { json: {} }, { json: {} }]);
    await a.updateListing('en-US', { title: 'codai', shortDescription: 'AI' });
    expect(f.lines()).toEqual([
      `POST ${API}/edits`,
      `PATCH ${API}/edits/L/listings/en-US`,
      `POST ${API}/edits/L:commit`,
    ]);
    expect(f.calls[1]?.body).toEqual({ language: 'en-US', title: 'codai', shortDescription: 'AI' });
    await expect(a.updateListing('en-US', { title: 'x'.repeat(31) })).rejects.toThrow(/title/);
    await expect(a.getReviewStatus()).rejects.toBeInstanceOf(UnsupportedCapabilityError);
    expect(a.supports('staged_rollout')).toBe(true);
    expect(a.supports('review_status')).toBe(false);
  });

  it('maps track bodies both ways', () => {
    const t = toPlayTrack({ track: 'alpha', artifactIds: ['5'], status: 'draft' });
    expect(t).toEqual({ track: 'alpha', releases: [{ versionCodes: ['5'], status: 'draft' }] });
    expect(
      fromPlayTrack({
        track: 'alpha',
        releases: [
          { status: 'statusUnspecified', releaseNotes: [{ language: 'en-US', text: 'a' }] },
        ],
      }),
    ).toEqual({
      track: 'alpha',
      releases: [{ artifactIds: [], status: 'pending', releaseNotes: { 'en-US': 'a' } }],
    });
    expect(fromPlayTrack({ track: 'x' })).toEqual({ track: 'x', releases: [] });
  });
});
