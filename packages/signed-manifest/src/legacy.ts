import { z } from 'zod';
import { DESKTOP_COHORT_PREFIX, ReleaseManifestV2Schema, type ReleaseManifestV2 } from './release';

const SHA256_HEX = /^[0-9a-f]{64}$/;
const UI_VERSION = /^(\d+)\.(\d+)\.(\d+)-ui\.(\d+)$/;

/** v1 phone-release payload (`application/vnd.codai.phone-release+json;v=1`, `New-PhoneManifest`). */
export const LegacyPhoneManifestSchema = z.looseObject({
  v: z.literal(1),
  kind: z.literal('phone-release'),
  apk_name: z.string().min(1),
  expires_at: z.number().int().nonnegative(),
  issued_at: z.number().int().nonnegative(),
  min_sdk: z.number().int().positive(),
  notes: z.string(),
  sha256: z.string().regex(SHA256_HEX),
  size: z.number().int().positive(),
  url: z.string().min(1),
  version: z.string().min(1),
  version_code: z.number().int().positive(),
});

/** v1 ui-bundle payload (`application/vnd.codai.ui-bundle+json;v=1`, `New-UiManifest`). */
export const LegacyUiBundleManifestSchema = z.looseObject({
  v: z.literal(1),
  kind: z.literal('ui-bundle'),
  app_version: z.string().min(1),
  expires_at: z.number().int().nonnegative(),
  issued_at: z.number().int().nonnegative(),
  files: z.record(z.string(), z.string().regex(SHA256_HEX)),
  requires_shell: z.string().regex(SHA256_HEX),
  sha256: z.string().regex(SHA256_HEX),
  size: z.number().int().positive(),
  url: z.string().min(1),
  version: z.string().regex(UI_VERSION),
});

/** Parsed v1 phone manifest. */
export type LegacyPhoneManifest = z.infer<typeof LegacyPhoneManifestSchema>;
/** Parsed v1 ui-bundle manifest. */
export type LegacyUiBundleManifest = z.infer<typeof LegacyUiBundleManifestSchema>;

/** Unsigned directives carried as HTML comments in a GitHub release body (v1 transport). */
export interface LegacyDirectives {
  /** `<!-- codai-rollout: N -->` clamped to 0..100; absent/invalid = 100. */
  rollout: number;
  /** `<!-- codai-pulled -->` present. */
  pulled: boolean;
  /** `<!-- codai-ui-channel: x -->` lower-cased; absent = 'stable'; anything but stable/beta = null (never served). */
  uiChannel: 'stable' | 'beta' | null;
  /** `<!-- codai-ui-shell: <hex> -->` lower-cased; null when absent. */
  uiShell: string | null;
}

const ROLLOUT_RE = /<!--\s*codai-rollout\s*:\s*(\S*?)\s*-->/i;
const PULLED_RE = /<!--\s*codai-pulled\s*-->/i;
const UI_CHANNEL_RE = /<!--\s*codai-ui-channel\s*:\s*(\S*?)\s*-->/i;
const UI_SHELL_RE = /<!--\s*codai-ui-shell\s*:\s*(\S*?)\s*-->/i;

/** Parse v1 release-body directives exactly like apps/web `parseDirectives` + `parseUiDirectives`. */
export function parseLegacyDirectives(body: string | null | undefined): LegacyDirectives {
  const text = body ?? '';
  const r = ROLLOUT_RE.exec(text);
  const rollout =
    r && /^-?\d+$/.test(r[1] ?? '') ? Math.min(100, Math.max(0, parseInt(r[1] ?? '100', 10))) : 100;
  const c = UI_CHANNEL_RE.exec(text);
  const rawChannel = c ? (c[1] ?? '').toLowerCase() : 'stable';
  const s = UI_SHELL_RE.exec(text);
  return {
    rollout,
    pulled: PULLED_RE.test(text),
    uiChannel: rawChannel === 'stable' || rawChannel === 'beta' ? rawChannel : null,
    uiShell: s && s[1] ? s[1].toLowerCase() : null,
  };
}

/** Migration options shared by the converters. */
export interface FromLegacyOptions {
  /** Directives from the release body (defaults: rollout 100, not pulled). */
  directives?: Partial<Pick<LegacyDirectives, 'rollout' | 'pulled'>>;
  channel?: string;
  product?: string;
  /** Anti-rollback counter; defaults to version_code (phone) or a packed X.Y.Z-ui.N (ui bundle). */
  sequence?: number;
  revokedVersions?: string[];
}

function directivesOf(opts: FromLegacyOptions, prefix: string): ReleaseManifestV2['directives'] {
  return {
    rollout: opts.directives?.rollout ?? 100,
    pulled: opts.directives?.pulled ?? false,
    halted: false,
    revoked_versions: opts.revokedVersions ?? [],
    cohort_seed_prefix: prefix,
  };
}

/** Convert a v1 phone-release payload to v2 (surface 'android', cohort prefix '', min_os `android-sdk:N`). */
export function fromLegacyPhone(v1: unknown, opts: FromLegacyOptions = {}): ReleaseManifestV2 {
  const m = LegacyPhoneManifestSchema.parse(v1);
  return ReleaseManifestV2Schema.parse({
    v: 2,
    kind: 'release',
    product: opts.product ?? 'ro.codai.phone',
    surface: 'android',
    version: m.version,
    version_code: m.version_code,
    channel: opts.channel ?? (m.version.includes('-') ? 'beta' : 'stable'),
    issued_at: m.issued_at,
    expires_at: m.expires_at,
    artifact: { url: m.url, sha256: m.sha256, size: m.size, name: m.apk_name },
    min_os: `android-sdk:${m.min_sdk}`,
    ...(m.notes ? { notes: m.notes } : {}),
    directives: directivesOf(opts, ''),
    sequence: opts.sequence ?? m.version_code,
  });
}

/** Monotonic sequence for `X.Y.Z-ui.N`: X·10^9 + Y·10^6 + Z·10^3 + N (each part < 1000 except X). */
export function uiBundleSequence(version: string): number {
  const p = UI_VERSION.exec(version);
  if (!p) throw new RangeError(`not a ui-bundle version: ${version}`);
  const [x, y, z, n] = [p[1], p[2], p[3], p[4]].map((s) => Number(s));
  if ([y, z, n].some((v) => (v ?? 0) >= 1000))
    throw new RangeError(`ui-bundle version part >= 1000: ${version}`);
  return (x ?? 0) * 1e9 + (y ?? 0) * 1e6 + (z ?? 0) * 1e3 + (n ?? 0);
}

/** Convert a v1 ui-bundle payload to v2 (surface 'ui-bundle', desktop cohort prefix, files + requires_shell kept). */
export function fromLegacyUiBundle(
  v1: unknown,
  opts: FromLegacyOptions & { uiChannel?: LegacyDirectives['uiChannel'] } = {},
): ReleaseManifestV2 {
  const m = LegacyUiBundleManifestSchema.parse(v1);
  const channel = opts.channel ?? opts.uiChannel ?? 'stable';
  return ReleaseManifestV2Schema.parse({
    v: 2,
    kind: 'release',
    product: opts.product ?? 'ro.codai.desktop',
    surface: 'ui-bundle',
    version: m.version,
    channel,
    issued_at: m.issued_at,
    expires_at: m.expires_at,
    artifact: { url: m.url, sha256: m.sha256, size: m.size, name: `codai-ui-${m.version}.zip` },
    requires_shell: m.requires_shell,
    files: m.files,
    directives: directivesOf(opts, DESKTOP_COHORT_PREFIX),
    sequence: opts.sequence ?? uiBundleSequence(m.version),
  });
}
