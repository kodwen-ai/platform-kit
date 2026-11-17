/**
 * Firebase App Distribution adapter (upload + distribute to tester groups).
 * Docs: https://firebase.google.com/docs/reference/app-distribution/rest/v1/upload.v1.projects.apps.releases/upload
 *       https://firebase.google.com/docs/reference/app-distribution/rest/v1/projects.apps.releases/distribute
 *       https://firebase.google.com/docs/reference/app-distribution/rest/v1/projects.apps.releases/patch
 *
 * Tracks are tester groups: `setTrack({ track: 'alpha,qa', artifactIds: [releaseName], status: 'completed' })`
 * distributes the release to group aliases `alpha` and `qa`. Release notes (one text, not localized) are patched first.
 */
import { loadArtifact } from './artifact';
import { BaseStoreAdapter } from './base';
import { StoreStateError, StoreValidationError } from './errors';
import { HttpClient, resolveFetch } from './http';
import type {
  AdapterTransport,
  Capability,
  SetTrackInput,
  StoreId,
  TrackState,
  UploadInput,
  UploadResult,
} from './types';
import { pickNote } from './validate';

const API = 'https://firebaseappdistribution.googleapis.com';
/** Firebase limit on combined testers + groups per distribute call. */
export const FIREBASE_MAX_RECIPIENTS = 999;

/** Options of the Firebase App Distribution adapter. */
export interface FirebaseAppDistributionOptions extends AdapterTransport {
  /** Firebase project number. */
  projectNumber: string;
  /** Firebase app id, e.g. `1:1234567890:android:abc123`. */
  appId: string;
  /** Delay between operation polls (default 2000 ms). */
  pollIntervalMs?: number;
  /** Max operation polls before giving up (default 90). */
  maxPolls?: number;
  /** Injectable sleep (tests). */
  sleep?: (ms: number) => Promise<void>;
}

/** Firebase release resource (subset). */
export interface FirebaseRelease {
  name: string;
  displayVersion?: string;
  buildVersion?: string;
  createTime?: string;
  releaseNotes?: { text?: string };
}

interface Operation {
  name: string;
  done?: boolean;
  error?: { code: number; message: string };
  response?: { result?: string; release?: FirebaseRelease };
}

/** Split a track string into group aliases. */
export function parseGroups(track: string): string[] {
  return track
    .split(',')
    .map((g) => g.trim())
    .filter(Boolean);
}

/** Firebase App Distribution adapter. */
export class FirebaseAppDistributionAdapter extends BaseStoreAdapter {
  readonly id: StoreId = 'firebase_app_distribution';
  readonly capabilities: ReadonlySet<Capability> = new Set<Capability>(['upload', 'tracks']);
  private readonly http: HttpClient;
  private readonly appPath: string;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(private readonly opts: FirebaseAppDistributionOptions) {
    super();
    if (!/^\d+$/.test(opts.projectNumber))
      throw new StoreValidationError('projectNumber must be numeric');
    if (!/^1:\d+:(android|ios|web):[0-9a-f]+$/.test(opts.appId))
      throw new StoreValidationError(`invalid Firebase app id: ${opts.appId}`);
    this.http = new HttpClient(resolveFetch(opts.fetch), opts.getAccessToken);
    this.appPath = `projects/${opts.projectNumber}/apps/${opts.appId}`;
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  private async waitFor(op: Operation): Promise<Operation> {
    let cur = op;
    const max = this.opts.maxPolls ?? 90;
    for (let i = 0; !cur.done; i++) {
      if (i >= max)
        throw new StoreStateError(`upload operation ${op.name} not done after ${max} polls`);
      await this.sleep(this.opts.pollIntervalMs ?? 2000);
      cur = await this.http.request<Operation>({ method: 'GET', url: `${API}/v1/${cur.name}` });
    }
    return cur;
  }

  override async upload(input: UploadInput): Promise<UploadResult> {
    if (input.kind !== 'apk' && input.kind !== 'aab')
      throw new StoreValidationError(`App Distribution accepts apk|aab here, not ${input.kind}`);
    const { bytes, fileName } = await loadArtifact(input);
    const started = await this.http.request<Operation>({
      method: 'POST',
      url: `${API}/upload/v1/${this.appPath}/releases:upload`,
      body: bytes,
      headers: {
        'x-goog-upload-protocol': 'raw',
        'x-goog-upload-file-name': fileName,
        'content-type': 'application/octet-stream',
      },
    });
    const done = await this.waitFor(started);
    if (done.error) throw new StoreStateError(`upload failed: ${done.error.message}`);
    const release = done.response?.release;
    if (!release) throw new StoreStateError('upload finished without a release');
    const out: UploadResult = { artifactId: release.name };
    const vc = Number(release.buildVersion);
    if (Number.isInteger(vc) && vc > 0) out.versionCode = vc;
    return out;
  }

  override async setTrack(input: SetTrackInput): Promise<TrackState> {
    const groups = parseGroups(input.track);
    if (groups.length === 0 || groups.length > FIREBASE_MAX_RECIPIENTS)
      throw new StoreValidationError(`need 1..${FIREBASE_MAX_RECIPIENTS} groups`);
    if (input.status !== 'completed')
      throw new StoreValidationError(
        'App Distribution distributes immediately: status must be completed',
      );
    if (input.userFraction !== undefined)
      throw new StoreValidationError('App Distribution has no staged rollout');
    const [release, ...rest] = input.artifactIds;
    if (!release || rest.length > 0 || !release.startsWith(`${this.appPath}/releases/`)) {
      throw new StoreValidationError(
        'setTrack needs exactly one release name returned by upload()',
      );
    }
    const text = pickNote(input.releaseNotes);
    if (text !== undefined) {
      await this.http.request({
        method: 'PATCH',
        url: `${API}/v1/${release}?updateMask=release_notes.text`,
        json: { name: release, releaseNotes: { text } },
      });
    }
    await this.http.request({
      method: 'POST',
      url: `${API}/v1/${release}:distribute`,
      json: { groupAliases: groups },
    });
    const r: TrackState['releases'][number] = { artifactIds: [release], status: 'completed' };
    if (text !== undefined) r.releaseNotes = { 'en-US': text };
    return { track: groups.join(','), releases: [r] };
  }

  /** Latest releases of the app (Firebase does not expose which groups a release went to). */
  override async getTrack(track: string): Promise<TrackState> {
    const res = await this.http.request<{ releases?: FirebaseRelease[] }>({
      method: 'GET',
      url: `${API}/v1/${this.appPath}/releases?pageSize=10&orderBy=createTimeDesc`,
    });
    return {
      track,
      releases: (res.releases ?? []).map((r) => ({
        name: r.displayVersion ? `${r.displayVersion} (${r.buildVersion ?? '?'})` : r.name,
        artifactIds: [r.name],
        status: 'completed' as const,
      })),
    };
  }
}
