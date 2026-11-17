import { createHash } from 'node:crypto';
import { z } from 'zod';
import { signEnvelope, verifyEnvelope, type Envelope, type VerifyFailureReason } from './envelope';
import { PAYLOAD_TYPES } from './payload-types';
import { compareSemver } from './semver';
import type { Signer } from './signers';

/** Surfaces known today; any other non-empty id is allowed (forward compatible). */
export const KNOWN_SURFACES = [
  'android',
  'wear',
  'windows',
  'macos',
  'linux',
  'ui-bundle',
  'web-bundle',
] as const;
/** Channels known today; any other non-empty id is allowed. */
export const KNOWN_CHANNELS = ['stable', 'beta', 'internal'] as const;
/** Cohort seed prefix of the desktop updater (`update_channel.rs` cohort_of); the phone uses ''. */
export const DESKTOP_COHORT_PREFIX = 'codai-update-cohort:';

const SHA256_HEX = /^[0-9a-f]{64}$/;
const SEMVER = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/;
const NOTES_MAX = 2000;

const epochMs = z.number().int().nonnegative();
const sha256 = z.string().regex(SHA256_HEX, 'sha256 must be 64 lowercase hex chars');

/** Rollout / pull / channel controls, signed together with the artifact they govern. */
export const ReleaseDirectivesSchema = z.object({
  rollout: z.number().int().min(0).max(100),
  pulled: z.boolean(),
  halted: z.boolean(),
  revoked_versions: z.array(z.string().min(1)),
  cohort_seed_prefix: z.string(),
});

/** Downloadable artifact pinned by hash and size. */
export const ReleaseArtifactSchema = z.object({
  url: z.url({ protocol: /^https$/ }),
  sha256,
  size: z.number().int().positive(),
  name: z.string().min(1).optional(),
});

/**
 * Release manifest v2 (`application/vnd.codai.release+json;v=2`): one shape for every product and
 * surface. Integers only (sign/verify with `numbers: 'integers'`). Unknown keys are tolerated
 * (they are signed) so v=2 can grow additively.
 */
export const ReleaseManifestV2Schema = z
  .looseObject({
    v: z.literal(2),
    kind: z.literal('release'),
    product: z.string().min(1),
    surface: z.string().min(1),
    version: z.string().regex(SEMVER, 'version must be SemVer'),
    version_code: z.number().int().positive().optional(),
    channel: z.string().min(1),
    issued_at: epochMs,
    expires_at: epochMs,
    artifact: ReleaseArtifactSchema,
    min_os: z.string().min(1).optional(),
    requires_shell: sha256.optional(),
    notes: z.string().max(NOTES_MAX).optional(),
    notes_i18n: z.record(z.string().min(2), z.string().max(NOTES_MAX)).optional(),
    directives: ReleaseDirectivesSchema,
    sequence: z.number().int().nonnegative(),
    files: z.record(z.string().min(1), sha256).optional(),
  })
  .refine((m) => m.expires_at > m.issued_at, {
    message: 'expires_at must be after issued_at',
    path: ['expires_at'],
  });

/** Parsed release manifest v2. */
export type ReleaseManifestV2 = z.infer<typeof ReleaseManifestV2Schema>;
/** Release directives. */
export type ReleaseDirectives = z.infer<typeof ReleaseDirectivesSchema>;

/**
 * Stable 0..99 bucket: first 8 bytes of sha256(prefix + seed) as an unsigned big-endian integer, mod 100.
 * Equals phone `cohortOf(seed)` with prefix '' and desktop `cohort_of(id)` with {@link DESKTOP_COHORT_PREFIX}.
 */
export function cohortOf(seed: string, prefix = ''): number {
  const d = createHash('sha256')
    .update(prefix + seed, 'utf8')
    .digest();
  return Number(d.readBigUInt64BE(0) % 100n);
}

/** Why a client may or may not install a release. */
export type EligibilityReason =
  'OK' | 'EXPIRED' | 'PULLED' | 'HALTED' | 'REVOKED' | 'NOT_NEWER' | 'NOT_IN_ROLLOUT';

/** Client facts for {@link isEligible}. */
export interface EligibilityInput {
  /** 0..99 bucket from {@link cohortOf}. */
  cohort: number;
  currentVersionCode?: number;
  currentVersion?: string;
  /** Epoch milliseconds. */
  now: number;
}

function isNewer(m: ReleaseManifestV2, input: EligibilityInput): boolean {
  if (m.version_code !== undefined && input.currentVersionCode !== undefined) {
    return m.version_code > input.currentVersionCode;
  }
  if (input.currentVersion !== undefined) return compareSemver(m.version, input.currentVersion) > 0;
  return true;
}

/**
 * Decide whether a verified manifest applies to this client. Order: EXPIRED, PULLED, HALTED,
 * REVOKED (this release's own version is revoked), NOT_NEWER, NOT_IN_ROLLOUT (`cohort >= rollout`).
 * A client whose current version is in `revoked_versions` bypasses the rollout gate (urgent fix).
 */
export function isEligible(m: ReleaseManifestV2, input: EligibilityInput): EligibilityReason {
  const d = m.directives;
  if (input.now >= m.expires_at) return 'EXPIRED';
  if (d.pulled) return 'PULLED';
  if (d.halted) return 'HALTED';
  if (d.revoked_versions.includes(m.version)) return 'REVOKED';
  if (!isNewer(m, input)) return 'NOT_NEWER';
  const currentRevoked =
    input.currentVersion !== undefined && d.revoked_versions.includes(input.currentVersion);
  if (!currentRevoked && d.rollout < 100 && input.cohort >= d.rollout) return 'NOT_IN_ROLLOUT';
  return 'OK';
}

/** Validate then sign a v2 manifest (integers-only JCS, payload type v2). */
export async function signReleaseManifestV2(
  manifest: ReleaseManifestV2,
  opts: { signer: Signer; keyid?: string },
): Promise<Envelope> {
  const m = ReleaseManifestV2Schema.parse(manifest);
  return signEnvelope(m, {
    payloadType: PAYLOAD_TYPES.releaseV2,
    signer: opts.signer,
    numbers: 'integers',
    ...(opts.keyid ? { keyid: opts.keyid } : {}),
  });
}

/** Result of {@link verifyReleaseManifestV2}. */
export type VerifyReleaseResult =
  | { ok: true; manifest: ReleaseManifestV2; keyIndex: number }
  | { ok: false; reason: VerifyFailureReason | 'SCHEMA_INVALID'; detail?: string };

/** Verify a v2 release envelope against pinned keys and validate the payload schema. */
export function verifyReleaseManifestV2(
  envelope: unknown,
  opts: { publicKeysPem: readonly string[] },
): VerifyReleaseResult {
  const r = verifyEnvelope(envelope, {
    publicKeysPem: opts.publicKeysPem,
    payloadType: PAYLOAD_TYPES.releaseV2,
    numbers: 'integers',
  });
  if (!r.ok) return r;
  const m = ReleaseManifestV2Schema.safeParse(r.payload);
  if (!m.success) return { ok: false, reason: 'SCHEMA_INVALID', detail: m.error.message };
  return { ok: true, manifest: m.data, keyIndex: r.keyIndex };
}
