/** Path major of the platform REST surface (`/platform/v1/...`). */
export const PLATFORM_VERSION = 'v1' as const;

/** Current dated revision; sent and echoed in the {@link REVISION_HEADER}. */
export const PLATFORM_REVISION = '2026-10-19' as const;

/** Header carrying the dated revision on every request and response. */
export const REVISION_HEADER = 'Codai-Platform-Version' as const;

/** Every revision this implementation understands (newest first). */
export const SUPPORTED_REVISIONS: readonly string[] = [PLATFORM_REVISION];

/** Default base path of the REST surface. */
export const DEFAULT_BASE_PATH = `/platform/${PLATFORM_VERSION}` as const;

/** Path of the discovery document (served at the issuer root, not under the base path). */
export const DISCOVERY_PATH = '/.well-known/codai-platform' as const;

/** True when `revision` is a revision this implementation supports. */
export function isSupportedRevision(revision: string): boolean {
  return SUPPORTED_REVISIONS.includes(revision);
}
