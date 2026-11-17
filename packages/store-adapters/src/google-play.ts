/**
 * Google Play adapter over the Android Publisher v3 Edits API.
 * Docs: https://developers.google.com/android-publisher/api-ref/rest/v3/edits
 *       https://developers.google.com/android-publisher/api-ref/rest/v3/edits.tracks
 * (Release.userFraction: 0 < f < 1, only with status inProgress|halted; statuses draft|inProgress|halted|completed.)
 *
 * Edit lifecycle: `upload` opens an edit and keeps it pending; the next `setTrack` writes the track into the
 * SAME edit and commits it. Any failure deletes the pending edit. Read-only calls use a throwaway edit.
 */
import { loadArtifact } from './artifact';
import { BaseStoreAdapter } from './base';
import { StoreStateError, StoreValidationError } from './errors';
import { HttpClient, resolveFetch } from './http';
import type {
  AdapterTransport,
  Capability,
  ListingUpdate,
  LocalizedNotes,
  SetTrackInput,
  StoreId,
  TrackRelease,
  TrackState,
  TrackStatus,
  UploadInput,
  UploadResult,
} from './types';
import { assertMaxLength, assertNotesLength, assertRolloutFraction } from './validate';

/** Play limit on release notes per locale. */
export const PLAY_RELEASE_NOTES_MAX = 500;
/** Play listing field limits. */
export const PLAY_LISTING_LIMITS = {
  title: 30,
  shortDescription: 80,
  fullDescription: 4000,
} as const;

const API = 'https://androidpublisher.googleapis.com/androidpublisher/v3/applications';
const UPLOAD = 'https://androidpublisher.googleapis.com/upload/androidpublisher/v3/applications';

/** Options of the Google Play adapter. */
export interface GooglePlayOptions extends AdapterTransport {
  /** Application id, e.g. `ro.codai.phone`. */
  packageName: string;
  /** Pass `changesNotSentForReview=true` on commit (needed for apps with rejected updates). */
  changesNotSentForReview?: boolean;
}

/** Wire shape of a Play release. */
export interface PlayRelease {
  name?: string;
  versionCodes?: string[];
  status: TrackStatus | 'statusUnspecified';
  userFraction?: number;
  releaseNotes?: { language: string; text: string }[];
}

/** Wire shape of a Play track. */
export interface PlayTrack {
  track: string;
  releases?: PlayRelease[];
}

/** Map codai SetTrackInput to the Play Track body. */
export function toPlayTrack(input: SetTrackInput): PlayTrack {
  const release: PlayRelease = {
    versionCodes: input.artifactIds.map(String),
    status: input.status,
  };
  if (input.name !== undefined) release.name = input.name;
  if (input.userFraction !== undefined) release.userFraction = input.userFraction;
  if (input.releaseNotes) {
    release.releaseNotes = Object.entries(input.releaseNotes).map(([language, text]) => ({
      language,
      text,
    }));
  }
  return { track: input.track, releases: [release] };
}

function fromPlayRelease(r: PlayRelease): TrackRelease {
  const out: TrackRelease = {
    artifactIds: r.versionCodes ?? [],
    status: r.status === 'statusUnspecified' ? 'pending' : r.status,
  };
  if (r.name !== undefined) out.name = r.name;
  if (r.userFraction !== undefined) out.userFraction = r.userFraction;
  if (r.releaseNotes?.length) {
    out.releaseNotes = Object.fromEntries(
      r.releaseNotes.map((n) => [n.language, n.text]),
    ) as LocalizedNotes;
  }
  return out;
}

/** Map a Play Track body to the neutral TrackState. */
export function fromPlayTrack(t: PlayTrack): TrackState {
  return { track: t.track, releases: (t.releases ?? []).map(fromPlayRelease) };
}

/** Google Play (Android Publisher v3) adapter. */
export class GooglePlayAdapter extends BaseStoreAdapter {
  readonly id: StoreId = 'google_play';
  readonly capabilities: ReadonlySet<Capability> = new Set<Capability>([
    'upload',
    'tracks',
    'staged_rollout',
    'halt',
    'resume',
    'complete',
    'listing',
    'localized_notes',
  ]);
  private readonly http: HttpClient;
  private readonly app: string;
  private readonly upApp: string;
  private pendingEditId: string | undefined;

  constructor(private readonly opts: GooglePlayOptions) {
    super();
    if (!/^[A-Za-z][\w]*(\.[A-Za-z][\w]*)+$/.test(opts.packageName)) {
      throw new StoreValidationError(`invalid Android package name: ${opts.packageName}`);
    }
    this.http = new HttpClient(resolveFetch(opts.fetch), opts.getAccessToken);
    this.app = `${API}/${opts.packageName}`;
    this.upApp = `${UPLOAD}/${opts.packageName}`;
  }

  /** Id of the edit opened by `upload` and not yet committed, if any. */
  get pendingEdit(): string | undefined {
    return this.pendingEditId;
  }

  private async openEdit(): Promise<string> {
    const edit = await this.http.request<{ id: string }>({
      method: 'POST',
      url: `${this.app}/edits`,
      json: {},
    });
    return edit.id;
  }

  private async commitEdit(editId: string): Promise<void> {
    const q = this.opts.changesNotSentForReview ? '?changesNotSentForReview=true' : '';
    await this.http.request({ method: 'POST', url: `${this.app}/edits/${editId}:commit${q}` });
  }

  /** Delete the pending edit (no-op when none); errors from the delete itself are swallowed. */
  async abort(): Promise<void> {
    const id = this.pendingEditId;
    this.pendingEditId = undefined;
    if (id)
      await this.http
        .request({ method: 'DELETE', url: `${this.app}/edits/${id}` })
        .catch(() => undefined);
  }

  /** Run `fn` inside the pending edit (or a new one); commit when `commit`, else keep it pending; delete on failure. */
  private async inEdit<T>(fn: (editId: string) => Promise<T>, commit: boolean): Promise<T> {
    const editId = this.pendingEditId ?? (await this.openEdit());
    this.pendingEditId = editId;
    try {
      const out = await fn(editId);
      if (commit) {
        await this.commitEdit(editId);
        this.pendingEditId = undefined;
      }
      return out;
    } catch (err) {
      await this.abort();
      throw err;
    }
  }

  /** Read in a throwaway edit, deleted afterwards (unless a pending edit is open, which is reused). */
  private async readEdit<T>(fn: (editId: string) => Promise<T>): Promise<T> {
    if (this.pendingEditId) return fn(this.pendingEditId);
    const editId = await this.openEdit();
    try {
      return await fn(editId);
    } finally {
      await this.http
        .request({ method: 'DELETE', url: `${this.app}/edits/${editId}` })
        .catch(() => undefined);
    }
  }

  override async upload(input: UploadInput): Promise<UploadResult> {
    if (input.kind !== 'aab' && input.kind !== 'apk') {
      throw new StoreValidationError(`Google Play accepts aab|apk, not ${input.kind}`);
    }
    const { bytes } = await loadArtifact(input);
    const path = input.kind === 'aab' ? 'bundles' : 'apks';
    return this.inEdit(async (editId) => {
      const res = await this.http.request<{ versionCode: number }>({
        method: 'POST',
        url: `${this.upApp}/edits/${editId}/${path}?uploadType=media`,
        body: bytes,
        headers: { 'content-type': 'application/octet-stream' },
      });
      return { artifactId: String(res.versionCode), versionCode: res.versionCode };
    }, false);
  }

  override async setTrack(input: SetTrackInput): Promise<TrackState> {
    if (input.artifactIds.length === 0)
      throw new StoreValidationError('setTrack needs at least one version code');
    if (input.artifactIds.some((v) => !/^\d+$/.test(v)))
      throw new StoreValidationError('Play artifact ids are numeric version codes');
    assertRolloutFraction(input);
    assertNotesLength(input.releaseNotes, PLAY_RELEASE_NOTES_MAX);
    return this.putTrack(toPlayTrack(input));
  }

  private async putTrack(body: PlayTrack): Promise<TrackState> {
    return this.inEdit(async (editId) => {
      const res = await this.http.request<PlayTrack>({
        method: 'PUT',
        url: `${this.app}/edits/${editId}/tracks/${encodeURIComponent(body.track)}`,
        json: body,
      });
      return fromPlayTrack(res.track ? res : body);
    }, true);
  }

  private async getPlayTrack(track: string): Promise<PlayTrack> {
    return this.readEdit((editId) =>
      this.http.request<PlayTrack>({
        method: 'GET',
        url: `${this.app}/edits/${editId}/tracks/${encodeURIComponent(track)}`,
      }),
    );
  }

  override async getTrack(track: string): Promise<TrackState> {
    return fromPlayTrack(await this.getPlayTrack(track));
  }

  /** Rewrite the single release in `from` statuses with `patch`, keeping the other releases. */
  private async transition(
    track: string,
    from: TrackStatus[],
    patch: (r: PlayRelease) => PlayRelease,
  ): Promise<TrackState> {
    const current = await this.getPlayTrack(track);
    const releases = current.releases ?? [];
    const idx = releases.findIndex((r) => (from as string[]).includes(r.status));
    const target = releases[idx];
    if (!target)
      throw new StoreStateError(`track ${track} has no release in status ${from.join('|')}`);
    const next = releases.map((r, i) => (i === idx ? patch(r) : r));
    return this.putTrack({ track, releases: next });
  }

  override async halt(track: string): Promise<TrackState> {
    return this.transition(track, ['inProgress'], (r) => ({ ...r, status: 'halted' }));
  }

  override async resume(track: string, userFraction?: number): Promise<TrackState> {
    return this.transition(track, ['halted', 'inProgress'], (r) => {
      const f = userFraction ?? r.userFraction;
      assertRolloutFraction({ status: 'inProgress', userFraction: f });
      return { ...r, status: 'inProgress', userFraction: f };
    });
  }

  override async complete(track: string): Promise<TrackState> {
    return this.transition(track, ['inProgress', 'halted'], (r) => {
      const { userFraction: _drop, ...rest } = r;
      return { ...rest, status: 'completed' };
    });
  }

  override async updateListing(locale: string, listing: ListingUpdate): Promise<void> {
    for (const [k, max] of Object.entries(PLAY_LISTING_LIMITS)) {
      assertMaxLength(k, listing[k as keyof ListingUpdate], max);
    }
    const commit = this.pendingEditId === undefined;
    await this.inEdit(
      (editId) =>
        this.http.request({
          method: 'PATCH',
          url: `${this.app}/edits/${editId}/listings/${encodeURIComponent(locale)}`,
          json: { language: locale, ...listing },
        }),
      commit,
    );
  }
}
