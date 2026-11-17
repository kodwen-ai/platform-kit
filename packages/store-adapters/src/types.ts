/** Every capability a store adapter may advertise. */
export const CAPABILITIES = [
  'upload',
  'tracks',
  'staged_rollout',
  'halt',
  'resume',
  'listing',
  'localized_notes',
  'review_status',
  'complete',
] as const;

/** One capability of a store adapter. */
export type Capability = (typeof CAPABILITIES)[number];

/** Identifier of a store or registry (shared with `@codai/release-sdk`). */
export type StoreId =
  | 'google_play'
  | 'microsoft_store'
  | 'firebase_app_distribution'
  | 'github_releases'
  | 'npm'
  | 'pypi'
  | 'mcp_registry'
  | 'huawei_appgallery'
  | 'samsung_galaxy_store'
  | 'amazon_appstore'
  | 'winget'
  | 'chrome_web_store'
  | 'vscode_marketplace';

/** Kind of artifact handed to `upload`. */
export type ArtifactKind = 'aab' | 'apk' | 'msix' | 'msixupload' | 'zip' | 'vsix' | 'tgz' | 'wheel';

interface UploadCommon {
  kind: ArtifactKind;
  /** File name shown in the store (defaults to the basename of `artifactPath`, else `artifact.<kind>`). */
  fileName?: string;
  /** Microsoft Store, `kind: 'zip'` only: names of the packages inside the archive. */
  packageFileNames?: string[];
}

/** Input of `upload`: a path on disk or the raw bytes. */
export type UploadInput = UploadCommon &
  ({ artifactPath: string; bytes?: never } | { bytes: Uint8Array; artifactPath?: never });

/** Result of `upload`. */
export interface UploadResult {
  /** Store-side id to pass to `setTrack({ artifactIds })`. */
  artifactId: string;
  versionCode?: number;
}

/** Release status on a track (Google Play vocabulary, mapped by every adapter). */
export type TrackStatus = 'draft' | 'inProgress' | 'halted' | 'completed';

/** Release notes keyed by BCP-47 locale (e.g. `en-US`). */
export type LocalizedNotes = Record<string, string>;

/** Input of `setTrack`. */
export interface SetTrackInput {
  track: string;
  artifactIds: string[];
  status: TrackStatus;
  /** Staged rollout fraction, `0 < f < 1`, only with `status: 'inProgress'`. */
  userFraction?: number;
  releaseNotes?: LocalizedNotes;
  name?: string;
}

/** One release as read back from a track. `pending` = submitted, not yet decided by the store. */
export interface TrackRelease {
  name?: string;
  artifactIds: string[];
  status: TrackStatus | 'pending';
  userFraction?: number;
  releaseNotes?: LocalizedNotes;
}

/** State of a track. */
export interface TrackState {
  track: string;
  releases: TrackRelease[];
}

/** Normalised review / publication state. */
export type ReviewState =
  'draft' | 'processing' | 'in_review' | 'live' | 'rejected' | 'failed' | 'unknown';

/** Result of `getReviewStatus`. */
export interface ReviewStatus {
  state: ReviewState;
  version?: string;
  detail?: string;
}

/** Store listing fields. */
export interface ListingUpdate {
  title?: string;
  shortDescription?: string;
  fullDescription?: string;
}

/** Minimal fetch signature (inject a fake in tests). */
export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

/** Auth + transport shared by every network adapter. Tokens come from WIF/OIDC in CI. */
export interface AdapterTransport {
  fetch?: FetchLike;
  getAccessToken: () => Promise<string>;
}

/** One interface over every store. Unsupported operations reject with `UnsupportedCapabilityError`. */
export interface StoreAdapter {
  readonly id: StoreId;
  readonly capabilities: ReadonlySet<Capability>;
  upload(input: UploadInput): Promise<UploadResult>;
  setTrack(input: SetTrackInput): Promise<TrackState>;
  getTrack(track: string): Promise<TrackState>;
  halt(track: string): Promise<TrackState>;
  resume(track: string, userFraction?: number): Promise<TrackState>;
  complete(track: string): Promise<TrackState>;
  getReviewStatus(): Promise<ReviewStatus>;
  updateListing(locale: string, listing: ListingUpdate): Promise<void>;
}
