/**
 * Microsoft Store adapter over the Microsoft Store submission API (MSIX apps).
 * Docs: https://learn.microsoft.com/windows/uwp/monetize/create-and-manage-submissions-using-windows-store-services
 *       https://learn.microsoft.com/windows/uwp/monetize/manage-app-submissions (create/PUT/commit/status, packageDeliveryOptions.packageRollout)
 *       https://learn.microsoft.com/windows/uwp/monetize/halt-the-package-rollout-for-an-app-submission
 *       https://learn.microsoft.com/windows/uwp/monetize/update-the-package-rollout-percentage-for-an-app-submission
 *       https://learn.microsoft.com/windows/uwp/monetize/finalize-the-package-rollout-for-an-app-submission
 *
 * Model: one submission = one release on the single implicit track `public`. `upload` creates the submission
 * (a clone of the last published one) and PUTs the ZIP to its Azure SAS `fileUploadUrl`; `setTrack` PUTs the
 * submission JSON (packages + rollout + notes) and commits. Rollout ops act on the last published submission,
 * or the submission id passed in the options. Halting is final on this store (no resume).
 */
import { loadArtifact } from './artifact';
import { BaseStoreAdapter } from './base';
import { StoreStateError, StoreValidationError } from './errors';
import { HttpClient, resolveFetch } from './http';
import type {
  AdapterTransport,
  Capability,
  ReviewState,
  ReviewStatus,
  SetTrackInput,
  StoreId,
  TrackState,
  TrackStatus,
  UploadInput,
  UploadResult,
} from './types';
import { assertNotesLength, assertRolloutFraction } from './validate';
import { createStoredZip } from './zip';

const BASE = 'https://manage.devcenter.microsoft.com/v1.0/my/applications';
/** Microsoft Store limit on release notes per listing. */
export const MS_RELEASE_NOTES_MAX = 1500;
/** The only track the Microsoft Store has. */
export const MS_TRACK = 'public';

/** Options of the Microsoft Store adapter. */
export interface MicrosoftStoreOptions extends AdapterTransport {
  /** Store ID of the app, e.g. `9NBLGGH4R315`. */
  appId: string;
  /** Submission to drive rollout ops on (default: the app's last published submission). */
  submissionId?: string;
}

/** Package rollout resource. */
export interface MsPackageRollout {
  isPackageRollout: boolean;
  packageRolloutPercentage: number;
  packageRolloutStatus?:
    | 'PackageRolloutNotStarted'
    | 'PackageRolloutInProgress'
    | 'PackageRolloutComplete'
    | 'PackageRolloutStopped';
  fallbackSubmissionId?: string;
}

/** Subset of the app submission resource the adapter reads or writes. */
export interface MsSubmission {
  id: string;
  status?: string;
  fileUploadUrl?: string;
  friendlyName?: string;
  applicationPackages?: {
    fileName: string;
    fileStatus: string;
    version?: string;
    minimumDirectXVersion?: string;
    minimumSystemRam?: string;
  }[];
  packageDeliveryOptions?: { packageRollout?: MsPackageRollout; isMandatoryUpdate?: boolean };
  listings?: Record<string, { baseListing?: { releaseNotes?: string } & Record<string, unknown> }>;
  [k: string]: unknown;
}

const STATUS_MAP: Record<string, ReviewState> = {
  PendingCommit: 'draft',
  CommitStarted: 'processing',
  PreProcessing: 'processing',
  Certification: 'in_review',
  Release: 'in_review',
  PendingPublication: 'in_review',
  Publishing: 'in_review',
  Published: 'live',
  CertificationFailed: 'rejected',
  CommitFailed: 'failed',
  PreProcessingFailed: 'failed',
  PublishFailed: 'failed',
  ReleaseFailed: 'failed',
};

/** Normalise a Microsoft Store submission status. */
export function mapMsStatus(status: string | undefined): ReviewState {
  return (status && STATUS_MAP[status]) || 'unknown';
}

function rolloutToTrackStatus(
  r: MsPackageRollout | undefined,
  submissionStatus: string | undefined,
): TrackStatus | 'pending' {
  if (submissionStatus === 'PendingCommit') return 'draft';
  if (mapMsStatus(submissionStatus) !== 'live') return 'pending';
  if (!r?.isPackageRollout) return 'completed';
  switch (r.packageRolloutStatus) {
    case 'PackageRolloutStopped':
      return 'halted';
    case 'PackageRolloutComplete':
      return 'completed';
    default:
      return 'inProgress';
  }
}

/** Map a submission (+ optional live rollout) to the neutral TrackState. */
export function msSubmissionToTrack(s: MsSubmission, rollout?: MsPackageRollout): TrackState {
  const r = rollout ?? s.packageDeliveryOptions?.packageRollout;
  const status = rolloutToTrackStatus(r, s.status);
  const release: TrackState['releases'][number] = {
    name: s.friendlyName ?? s.id,
    artifactIds: [s.id],
    status,
  };
  if (r?.isPackageRollout && status === 'inProgress')
    release.userFraction = r.packageRolloutPercentage / 100;
  const notes = Object.entries(s.listings ?? {}).flatMap(([loc, l]) =>
    l.baseListing?.releaseNotes ? [[loc, l.baseListing.releaseNotes]] : [],
  );
  if (notes.length) release.releaseNotes = Object.fromEntries(notes) as Record<string, string>;
  return { track: MS_TRACK, releases: [release] };
}

/** Microsoft Store submission API adapter. */
export class MicrosoftStoreAdapter extends BaseStoreAdapter {
  readonly id: StoreId = 'microsoft_store';
  readonly capabilities: ReadonlySet<Capability> = new Set<Capability>([
    'upload',
    'tracks',
    'staged_rollout',
    'halt',
    'complete',
    'localized_notes',
    'review_status',
  ]);
  private readonly http: HttpClient;
  private readonly app: string;
  private draft: { submission: MsSubmission; packageFileNames: string[] } | undefined;
  private lastCommittedId: string | undefined;

  constructor(private readonly opts: MicrosoftStoreOptions) {
    super();
    if (!/^[A-Za-z0-9]{12}$/.test(opts.appId))
      throw new StoreValidationError(`invalid Store ID: ${opts.appId}`);
    this.http = new HttpClient(resolveFetch(opts.fetch), opts.getAccessToken);
    this.app = `${BASE}/${opts.appId}`;
  }

  private sub(id: string, suffix = ''): string {
    return `${this.app}/submissions/${id}${suffix}`;
  }

  override async upload(input: UploadInput): Promise<UploadResult> {
    const { bytes, fileName } = await loadArtifact(input);
    let zip: Uint8Array;
    let names: string[];
    if (input.kind === 'zip') {
      if (!input.packageFileNames?.length)
        throw new StoreValidationError(
          'kind zip needs packageFileNames (packages inside the archive)',
        );
      zip = bytes;
      names = input.packageFileNames;
    } else if (input.kind === 'msix' || input.kind === 'msixupload') {
      zip = createStoredZip([{ name: fileName, data: bytes }]);
      names = [fileName];
    } else {
      throw new StoreValidationError(
        `Microsoft Store accepts msix|msixupload|zip, not ${input.kind}`,
      );
    }
    const submission = await this.http.request<MsSubmission>({
      method: 'POST',
      url: `${this.app}/submissions`,
    });
    if (!submission.fileUploadUrl) throw new StoreStateError('submission has no fileUploadUrl');
    try {
      await this.http.request({
        method: 'PUT',
        url: submission.fileUploadUrl,
        body: zip,
        auth: false,
        headers: { 'x-ms-blob-type': 'BlockBlob', 'content-type': 'application/zip' },
      });
    } catch (err) {
      await this.http
        .request({ method: 'DELETE', url: this.sub(submission.id) })
        .catch(() => undefined);
      throw err;
    }
    this.draft = { submission, packageFileNames: names };
    return { artifactId: submission.id };
  }

  /** Build the submission body for `setTrack` (pure; exported for tests). */
  static buildSubmissionBody(
    base: MsSubmission,
    packageFileNames: string[],
    input: SetTrackInput,
  ): MsSubmission {
    const old = (base.applicationPackages ?? []).map((p) => ({
      ...p,
      fileStatus: 'PendingDelete',
    }));
    const added = packageFileNames.map((fileName) => ({
      fileName,
      fileStatus: 'PendingUpload',
      minimumDirectXVersion: 'None',
      minimumSystemRam: 'None',
    }));
    const staged = input.status === 'inProgress';
    const listings = { ...(base.listings ?? {}) };
    for (const [locale, text] of Object.entries(input.releaseNotes ?? {})) {
      const key = locale.toLowerCase();
      const prev = listings[key] ?? {};
      listings[key] = { ...prev, baseListing: { ...(prev.baseListing ?? {}), releaseNotes: text } };
    }
    return {
      ...base,
      applicationPackages: [...old, ...added],
      packageDeliveryOptions: {
        ...(base.packageDeliveryOptions ?? {}),
        packageRollout: {
          isPackageRollout: staged,
          packageRolloutPercentage: staged
            ? Math.round((input.userFraction ?? 0) * 10000) / 100
            : 0,
        },
      },
      listings,
    };
  }

  override async setTrack(input: SetTrackInput): Promise<TrackState> {
    if (input.track !== MS_TRACK)
      throw new StoreValidationError(`Microsoft Store has only the '${MS_TRACK}' track`);
    if (input.status !== 'draft' && input.status !== 'inProgress' && input.status !== 'completed') {
      throw new StoreValidationError(
        `setTrack status ${input.status} not possible on a new submission; use halt()`,
      );
    }
    assertRolloutFraction(input);
    assertNotesLength(input.releaseNotes, MS_RELEASE_NOTES_MAX);
    const draft = this.draft;
    const id = input.artifactIds[0];
    if (!draft || input.artifactIds.length !== 1 || id !== draft.submission.id) {
      throw new StoreStateError('setTrack needs exactly the submission id returned by upload()');
    }
    const body = MicrosoftStoreAdapter.buildSubmissionBody(
      draft.submission,
      draft.packageFileNames,
      input,
    );
    const { fileUploadUrl: _sas, ...wire } = body;
    try {
      const updated = await this.http.request<MsSubmission>({
        method: 'PUT',
        url: this.sub(id),
        json: wire,
      });
      if (input.status !== 'draft')
        await this.http.request({ method: 'POST', url: this.sub(id, '/commit') });
      this.draft = undefined;
      this.lastCommittedId = id;
      return msSubmissionToTrack({
        ...body,
        ...updated,
        status: input.status === 'draft' ? 'PendingCommit' : 'CommitStarted',
      });
    } catch (err) {
      await this.http.request({ method: 'DELETE', url: this.sub(id) }).catch(() => undefined);
      this.draft = undefined;
      throw err;
    }
  }

  private async publishedSubmissionId(): Promise<string> {
    if (this.opts.submissionId) return this.opts.submissionId;
    const app = await this.http.request<{ lastPublishedApplicationSubmission?: { id: string } }>({
      method: 'GET',
      url: this.app,
    });
    const id = app.lastPublishedApplicationSubmission?.id;
    if (!id) throw new StoreStateError('app has no published submission');
    return id;
  }

  private assertTrack(track: string): void {
    if (track !== MS_TRACK)
      throw new StoreValidationError(`Microsoft Store has only the '${MS_TRACK}' track`);
  }

  override async getTrack(track: string): Promise<TrackState> {
    this.assertTrack(track);
    const id = await this.publishedSubmissionId();
    return msSubmissionToTrack(
      await this.http.request<MsSubmission>({ method: 'GET', url: this.sub(id) }),
    );
  }

  private async rolloutOp(track: string, op: string): Promise<TrackState> {
    this.assertTrack(track);
    const id = await this.publishedSubmissionId();
    const rollout = await this.http.request<MsPackageRollout>({
      method: 'POST',
      url: this.sub(id, op),
    });
    return msSubmissionToTrack({ id, status: 'Published' }, rollout);
  }

  override async halt(track: string): Promise<TrackState> {
    return this.rolloutOp(track, '/haltpackagerollout');
  }

  /** Change the gradual rollout percentage of the published submission (`0 < f < 1`). */
  async setRolloutFraction(track: string, userFraction: number): Promise<TrackState> {
    assertRolloutFraction({ status: 'inProgress', userFraction });
    const pct = Math.round(userFraction * 10000) / 100;
    return this.rolloutOp(track, `/updatepackagerolloutpercentage?percentage=${pct}`);
  }

  override async resume(track: string, userFraction?: number): Promise<TrackState> {
    if (userFraction === undefined) {
      return this.unsupported(
        'resume',
        'a halted package rollout cannot be resumed; create a new submission',
      );
    }
    return this.setRolloutFraction(track, userFraction);
  }

  override async complete(track: string): Promise<TrackState> {
    return this.rolloutOp(track, '/finalizepackagerollout');
  }

  override async getReviewStatus(): Promise<ReviewStatus> {
    const id =
      this.draft?.submission.id ?? this.lastCommittedId ?? (await this.publishedSubmissionId());
    const s = await this.http.request<{
      status?: string;
      statusDetails?: { errors?: { code: string; details: string }[] };
    }>({
      method: 'GET',
      url: this.sub(id, '/status'),
    });
    const err = s.statusDetails?.errors?.[0];
    const out: ReviewStatus = { state: mapMsStatus(s.status), version: id };
    if (err) out.detail = `${err.code}: ${err.details}`;
    else if (s.status) out.detail = s.status;
    return out;
  }
}
