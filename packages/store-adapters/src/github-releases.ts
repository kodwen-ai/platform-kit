/**
 * GitHub Releases adapter — the sideload channel (desktop installers, APKs, VSIX, tarballs).
 * Docs: https://docs.github.com/rest/releases/releases  https://docs.github.com/rest/releases/assets
 *
 * One adapter instance = one tag. Tracks: `latest` (published, marked latest) and `prerelease`.
 * `status: 'draft'` keeps the release a draft; any other status publishes it.
 */
import { loadArtifact } from './artifact';
import { BaseStoreAdapter } from './base';
import { StoreApiError, StoreValidationError } from './errors';
import { HttpClient, resolveFetch } from './http';
import type {
  AdapterTransport,
  Capability,
  ReviewStatus,
  SetTrackInput,
  StoreId,
  TrackState,
  UploadInput,
  UploadResult,
} from './types';
import { pickNote } from './validate';

const API = 'https://api.github.com';
const UPLOADS = 'https://uploads.github.com';
/** GitHub caps release bodies at 125000 characters. */
export const GITHUB_RELEASE_BODY_MAX = 125_000;

/** Tracks the GitHub Releases adapter knows. */
export type GithubTrack = 'latest' | 'prerelease';

/** Options of the GitHub Releases adapter. */
export interface GithubReleasesOptions extends AdapterTransport {
  owner: string;
  repo: string;
  /** Tag of the release this instance manages, e.g. `v1.2.3`. */
  tag: string;
  /** Commit-ish to create the tag from when it does not exist yet. */
  targetCommitish?: string;
}

/** GitHub release resource (subset). */
export interface GithubRelease {
  id: number;
  tag_name: string;
  name?: string | null;
  draft: boolean;
  prerelease: boolean;
  body?: string | null;
  assets?: { id: number; name: string }[];
}

const CONTENT_TYPES: Record<string, string> = {
  apk: 'application/vnd.android.package-archive',
  msix: 'application/msix',
  zip: 'application/zip',
  tgz: 'application/gzip',
};

/** Map a GitHub release to the neutral TrackState. */
export function githubReleaseToTrack(r: GithubRelease): TrackState {
  const release: TrackState['releases'][number] = {
    name: r.name ?? r.tag_name,
    artifactIds: (r.assets ?? []).map((a) => String(a.id)),
    status: r.draft ? 'draft' : 'completed',
  };
  if (r.body) release.releaseNotes = { 'en-US': r.body };
  return { track: r.prerelease ? 'prerelease' : 'latest', releases: [release] };
}

/** GitHub Releases adapter. */
export class GithubReleasesAdapter extends BaseStoreAdapter {
  readonly id: StoreId = 'github_releases';
  readonly capabilities: ReadonlySet<Capability> = new Set<Capability>([
    'upload',
    'tracks',
    'review_status',
  ]);
  private readonly http: HttpClient;
  private readonly repoUrl: string;
  private release: GithubRelease | undefined;

  constructor(private readonly opts: GithubReleasesOptions) {
    super();
    const ok = /^[A-Za-z0-9_.-]+$/;
    if (!ok.test(opts.owner) || !ok.test(opts.repo))
      throw new StoreValidationError('invalid owner/repo');
    if (!opts.tag || /\s/.test(opts.tag)) throw new StoreValidationError('invalid tag');
    this.http = new HttpClient(resolveFetch(opts.fetch), opts.getAccessToken, {
      accept: 'application/vnd.github+json',
      'x-github-api-version': '2022-11-28',
    });
    this.repoUrl = `${API}/repos/${opts.owner}/${opts.repo}`;
  }

  private async findRelease(): Promise<GithubRelease | undefined> {
    if (this.release) return this.release;
    try {
      this.release = await this.http.request<GithubRelease>({
        method: 'GET',
        url: `${this.repoUrl}/releases/tags/${encodeURIComponent(this.opts.tag)}`,
      });
      return this.release;
    } catch (err) {
      if (err instanceof StoreApiError && err.status === 404) return undefined;
      throw err;
    }
  }

  private async ensureRelease(): Promise<GithubRelease> {
    const found = await this.findRelease();
    if (found) return found;
    const body: Record<string, unknown> = {
      tag_name: this.opts.tag,
      name: this.opts.tag,
      draft: true,
    };
    if (this.opts.targetCommitish) body.target_commitish = this.opts.targetCommitish;
    this.release = await this.http.request<GithubRelease>({
      method: 'POST',
      url: `${this.repoUrl}/releases`,
      json: body,
    });
    return this.release;
  }

  override async upload(input: UploadInput): Promise<UploadResult> {
    const { bytes, fileName } = await loadArtifact(input);
    const release = await this.ensureRelease();
    const asset = await this.http.request<{ id: number; name: string }>({
      method: 'POST',
      url: `${UPLOADS}/repos/${this.opts.owner}/${this.opts.repo}/releases/${release.id}/assets?name=${encodeURIComponent(fileName)}`,
      body: bytes,
      headers: { 'content-type': CONTENT_TYPES[input.kind] ?? 'application/octet-stream' },
    });
    return { artifactId: String(asset.id) };
  }

  override async setTrack(input: SetTrackInput): Promise<TrackState> {
    if (input.track !== 'latest' && input.track !== 'prerelease')
      throw new StoreValidationError("GitHub tracks are 'latest' | 'prerelease'");
    if (input.userFraction !== undefined)
      throw new StoreValidationError('GitHub Releases has no staged rollout');
    if (input.status === 'halted')
      throw new StoreValidationError('GitHub Releases cannot halt; delete the release instead');
    const notes = pickNote(input.releaseNotes);
    if (notes !== undefined && notes.length > GITHUB_RELEASE_BODY_MAX)
      throw new StoreValidationError('release body too long');
    const release = await this.ensureRelease();
    const draft = input.status === 'draft';
    const patch: Record<string, unknown> = { draft, prerelease: input.track === 'prerelease' };
    if (!draft) patch.make_latest = input.track === 'latest' ? 'true' : 'false';
    if (notes !== undefined) patch.body = notes;
    if (input.name !== undefined) patch.name = input.name;
    this.release = await this.http.request<GithubRelease>({
      method: 'PATCH',
      url: `${this.repoUrl}/releases/${release.id}`,
      json: patch,
    });
    return githubReleaseToTrack(this.release);
  }

  override async getTrack(track: string): Promise<TrackState> {
    const r = await this.findRelease();
    if (!r) return { track, releases: [] };
    return githubReleaseToTrack(r);
  }

  /** Version of the repo's latest published release. */
  override async getReviewStatus(): Promise<ReviewStatus> {
    try {
      const latest = await this.http.request<GithubRelease>({
        method: 'GET',
        url: `${this.repoUrl}/releases/latest`,
      });
      return { state: 'live', version: latest.tag_name };
    } catch (err) {
      if (err instanceof StoreApiError && err.status === 404)
        return { state: 'unknown', detail: 'no published release' };
      throw err;
    }
  }
}
