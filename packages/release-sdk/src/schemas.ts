/**
 * Contract of the codai Release Manager API (`/v1/releases`), revision 2026-10-19.
 * Wire format is snake_case JSON; ids are opaque strings; timestamps ISO 8601 UTC.
 */
import { z } from 'zod';

/** Store ids (kept in sync with `@codai/store-adapters` StoreId). */
export const STORE_IDS = [
  'google_play',
  'microsoft_store',
  'firebase_app_distribution',
  'github_releases',
  'npm',
  'pypi',
  'mcp_registry',
  'huawei_appgallery',
  'samsung_galaxy_store',
  'amazon_appstore',
  'winget',
  'chrome_web_store',
  'vscode_marketplace',
] as const;
/** A store id. */
export const StoreIdSchema = z.enum(STORE_IDS);
/** A store id. */
export type StoreId = z.infer<typeof StoreIdSchema>;

const Id = z.string().min(1).max(128);
const Slug = z.string().regex(/^[a-z0-9][a-z0-9-]{0,62}$/);
const Timestamp = z.iso.datetime({ offset: true });
const Sha256 = z.string().regex(/^[0-9a-f]{64}$/);

/** A product (one brand / codebase that ships to several stores). */
export const ProductSchema = z.object({
  id: Id,
  slug: Slug,
  name: z.string().min(1).max(200),
  project_id: Id.optional(),
});
/** A product. */
export type Product = z.infer<typeof ProductSchema>;

/** One listing of a product in one store. */
export const AppSchema = z.object({
  id: Id,
  product_id: Id,
  store: StoreIdSchema,
  /** Package / bundle / extension / npm id. */
  identifier: z.string().min(1).max(255),
  store_connection_id: Id,
});
/** An app. */
export type App = z.infer<typeof AppSchema>;

/** How the server authenticates to the store. */
export const StoreAuthSchema = z.enum(['oidc_workflow', 'vault', 'service_account']);

/** Credentials binding to a store account (secrets never leave the server). */
export const StoreConnectionSchema = z.object({
  id: Id,
  store: StoreIdSchema,
  account_label: z.string().min(1).max(200),
  auth: StoreAuthSchema,
  status: z.enum(['active', 'needs_attention', 'revoked']),
});
/** A store connection. */
export type StoreConnection = z.infer<typeof StoreConnectionSchema>;

/** Release lifecycle. */
export const RELEASE_STATUSES = [
  'draft',
  'building',
  'uploaded',
  'in_review',
  'rolling_out',
  'halted',
  'completed',
  'failed',
] as const;
/** A release status. */
export type ReleaseStatus = (typeof RELEASE_STATUSES)[number];

/** Release notes keyed by BCP-47 locale. */
export const NotesI18nSchema = z.record(
  z.string().regex(/^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$/),
  z.string().max(5000),
);

/** Build provenance attached to a release. */
export const BuildInfoSchema = z.object({
  artifact_sha256: Sha256,
  sbom_url: z.url().optional(),
  provenance_url: z.url().optional(),
});

/** A release of one app on one channel. */
export const ReleaseSchema = z.object({
  id: Id,
  app_id: Id,
  version: z.string().min(1).max(64),
  version_code: z.number().int().positive().optional(),
  /** Store track / channel (`production`, `beta`, `public`, `latest`…). */
  channel: z.string().min(1).max(64),
  status: z.enum(RELEASE_STATUSES),
  rollout_percent: z.number().min(0).max(100),
  notes_i18n: NotesI18nSchema,
  build: BuildInfoSchema,
  created_at: Timestamp,
});
/** A release. */
export type Release = z.infer<typeof ReleaseSchema>;

/** A rollout action on a release. `set` needs `percent` (0 < p ≤ 100). */
export const RolloutActionSchema = z
  .object({
    action: z.enum(['set', 'halt', 'resume', 'complete']),
    percent: z.number().gt(0).max(100).optional(),
  })
  .refine((a) => (a.action === 'set' ? a.percent !== undefined : true), {
    message: 'percent is required for set',
    path: ['percent'],
  });
/** A rollout action. */
export type RolloutAction = z.infer<typeof RolloutActionSchema>;

/** Body of `createProduct`. */
export const CreateProductInputSchema = ProductSchema.omit({ id: true });
/** Input of `createProduct`. */
export type CreateProductInput = z.infer<typeof CreateProductInputSchema>;

/** Body of `createRelease`. */
export const CreateReleaseInputSchema = z.object({
  app_id: Id,
  version: z.string().min(1).max(64),
  version_code: z.number().int().positive().optional(),
  channel: z.string().min(1).max(64),
  notes_i18n: NotesI18nSchema.default({}),
  build: BuildInfoSchema,
  /** Initial staged rollout; omitted = server default for the store. */
  rollout_percent: z.number().gt(0).max(100).optional(),
});
/** Input of `createRelease`. */
export type CreateReleaseInput = z.input<typeof CreateReleaseInputSchema>;

/** Cursor-paginated list envelope. */
export function pageSchema<T extends z.ZodType>(item: T) {
  return z.object({ data: z.array(item), next_cursor: z.string().nullable().default(null) });
}

/** Error body: `{ error: { code, message, request_id? } }`. */
export const ErrorBodySchema = z.object({
  error: z.object({ code: z.string(), message: z.string(), request_id: z.string().optional() }),
});
