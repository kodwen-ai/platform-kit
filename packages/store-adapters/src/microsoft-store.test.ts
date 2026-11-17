import { describe, expect, it } from 'vitest';
import { StoreStateError, StoreValidationError, UnsupportedCapabilityError } from './errors';
import { mapMsStatus, MicrosoftStoreAdapter, msSubmissionToTrack } from './microsoft-store';
import { fakeFetch, token } from './__fixtures__/fetch';

const APP = 'https://manage.devcenter.microsoft.com/v1.0/my/applications/9NBLGGH4R315';
const SAS = 'https://productingestionbin1.blob.core.windows.net/ingestion/abc?sv=2014&sig=SECRET';
const msix = new Uint8Array([0x50, 0x4b, 9, 9]);

function adapter(script: Parameters<typeof fakeFetch>[0], submissionId?: string) {
  const f = fakeFetch(script);
  const opts = {
    appId: '9NBLGGH4R315',
    fetch: f.fetch,
    getAccessToken: token,
    ...(submissionId ? { submissionId } : {}),
  };
  return { f, a: new MicrosoftStoreAdapter(opts) };
}

describe('MicrosoftStoreAdapter', () => {
  it('creates a submission, PUTs the zip to the SAS URL, updates rollout + notes, commits', async () => {
    const created = {
      id: 'S1',
      fileUploadUrl: SAS,
      applicationPackages: [{ fileName: 'old.msix', fileStatus: 'Uploaded' }],
      listings: { 'en-us': { baseListing: { title: 'codai' } } },
    };
    const { f, a } = adapter([
      { json: created },
      { status: 201 },
      { json: { id: 'S1' } },
      { json: {} },
      { json: { status: 'PreProcessing' } },
    ]);
    const up = await a.upload({ bytes: msix, kind: 'msix', fileName: 'codai_1.0.0.0_x64.msix' });
    expect(up).toEqual({ artifactId: 'S1' });
    await a.setTrack({
      track: 'public',
      artifactIds: ['S1'],
      status: 'inProgress',
      userFraction: 0.25,
      releaseNotes: { 'en-US': 'New' },
    });
    expect(f.lines()).toEqual([
      `POST ${APP}/submissions`,
      `PUT ${SAS}`,
      `PUT ${APP}/submissions/S1`,
      `POST ${APP}/submissions/S1/commit`,
    ]);
    const blob = f.calls[1];
    expect(blob?.headers['x-ms-blob-type']).toBe('BlockBlob');
    expect(blob?.headers.authorization).toBeUndefined();
    const zip = blob?.body as Uint8Array;
    expect([...zip.slice(0, 4)]).toEqual([0x50, 0x4b, 0x03, 0x04]);
    const put = f.calls[2]?.body as Record<string, unknown>;
    expect(put.fileUploadUrl).toBeUndefined();
    expect(put.applicationPackages).toEqual([
      { fileName: 'old.msix', fileStatus: 'PendingDelete' },
      {
        fileName: 'codai_1.0.0.0_x64.msix',
        fileStatus: 'PendingUpload',
        minimumDirectXVersion: 'None',
        minimumSystemRam: 'None',
      },
    ]);
    expect(put.packageDeliveryOptions).toEqual({
      packageRollout: { isPackageRollout: true, packageRolloutPercentage: 25 },
    });
    expect(put.listings).toEqual({
      'en-us': { baseListing: { title: 'codai', releaseNotes: 'New' } },
    });
    expect(await a.getReviewStatus()).toEqual({
      state: 'processing',
      version: 'S1',
      detail: 'PreProcessing',
    });
    expect(f.lines()[4]).toBe(`GET ${APP}/submissions/S1/status`);
  });

  it('halts the rollout of the published submission via haltpackagerollout', async () => {
    const { f, a } = adapter([
      { json: { lastPublishedApplicationSubmission: { id: 'P9' } } },
      {
        json: {
          isPackageRollout: true,
          packageRolloutPercentage: 0,
          packageRolloutStatus: 'PackageRolloutStopped',
        },
      },
    ]);
    const st = await a.halt('public');
    expect(f.lines()).toEqual([`GET ${APP}`, `POST ${APP}/submissions/P9/haltpackagerollout`]);
    expect(f.calls[1]?.body).toBeUndefined();
    expect(st.releases[0]?.status).toBe('halted');
  });

  it('updates the percentage and finalizes on the configured submission', async () => {
    const { f, a } = adapter(
      [
        {
          json: {
            isPackageRollout: true,
            packageRolloutPercentage: 50,
            packageRolloutStatus: 'PackageRolloutInProgress',
          },
        },
        {
          json: {
            isPackageRollout: true,
            packageRolloutPercentage: 100,
            packageRolloutStatus: 'PackageRolloutComplete',
          },
        },
      ],
      'S7',
    );
    const st = await a.resume('public', 0.5);
    expect(st.releases[0]).toMatchObject({ status: 'inProgress', userFraction: 0.5 });
    await a.complete('public');
    expect(f.lines()).toEqual([
      `POST ${APP}/submissions/S7/updatepackagerolloutpercentage?percentage=50`,
      `POST ${APP}/submissions/S7/finalizepackagerollout`,
    ]);
  });

  it('cannot resume a halted rollout without a fraction', async () => {
    const { a } = adapter([]);
    await expect(a.resume('public')).rejects.toBeInstanceOf(UnsupportedCapabilityError);
  });

  it('deletes the submission when the blob upload fails', async () => {
    const { f, a } = adapter([
      { json: { id: 'S2', fileUploadUrl: SAS } },
      { status: 403, text: 'AuthenticationFailed' },
      { status: 204 },
    ]);
    const err = await a.upload({ bytes: msix, kind: 'msixupload' }).then(
      () => new Error('resolved'),
      (e: Error) => e,
    );
    expect(err.message).toMatch(/HTTP 403/);
    expect(err.message).not.toContain('SECRET');
    expect(f.lines()).toEqual([
      `POST ${APP}/submissions`,
      `PUT ${SAS}`,
      `DELETE ${APP}/submissions/S2`,
    ]);
  });

  it('validates track, status, ids and kinds', async () => {
    const { a } = adapter([]);
    await expect(
      a.setTrack({ track: 'beta', artifactIds: ['S1'], status: 'draft' }),
    ).rejects.toBeInstanceOf(StoreValidationError);
    await expect(
      a.setTrack({ track: 'public', artifactIds: ['S1'], status: 'halted' }),
    ).rejects.toThrow(/halt\(\)/);
    await expect(
      a.setTrack({ track: 'public', artifactIds: ['S1'], status: 'draft' }),
    ).rejects.toBeInstanceOf(StoreStateError);
    await expect(a.upload({ bytes: msix, kind: 'aab' })).rejects.toBeInstanceOf(
      StoreValidationError,
    );
    await expect(a.upload({ bytes: msix, kind: 'zip' })).rejects.toThrow(/packageFileNames/);
    await expect(a.halt('beta')).rejects.toBeInstanceOf(StoreValidationError);
    expect(() => new MicrosoftStoreAdapter({ appId: 'bad', getAccessToken: token })).toThrow(
      StoreValidationError,
    );
  });

  it('maps statuses and submissions to tracks', () => {
    expect(mapMsStatus('Published')).toBe('live');
    expect(mapMsStatus('CertificationFailed')).toBe('rejected');
    expect(mapMsStatus('Weird')).toBe('unknown');
    expect(mapMsStatus(undefined)).toBe('unknown');
    expect(msSubmissionToTrack({ id: 'a', status: 'Published' }).releases[0]?.status).toBe(
      'completed',
    );
    expect(msSubmissionToTrack({ id: 'a', status: 'Certification' }).releases[0]?.status).toBe(
      'pending',
    );
    expect(msSubmissionToTrack({ id: 'a', status: 'PendingCommit' }).releases[0]?.status).toBe(
      'draft',
    );
  });

  it('builds a full rollout body without percentage when completed', () => {
    const body = MicrosoftStoreAdapter.buildSubmissionBody({ id: 'x' }, ['a.msix'], {
      track: 'public',
      artifactIds: ['x'],
      status: 'completed',
    });
    expect(body.packageDeliveryOptions?.packageRollout).toEqual({
      isPackageRollout: false,
      packageRolloutPercentage: 0,
    });
  });
});
