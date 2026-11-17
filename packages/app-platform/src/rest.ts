import { z } from 'zod';
import { InstallationSchema } from './installation';
import { PermissionsSchema } from './permissions';
import { DISCOVERY_PATH } from './version';

/** REST routes of `/platform/v1` (paths relative to the base path; discovery is absolute). */
export const PLATFORM_ROUTES = {
  app: { method: 'GET', path: '/app', auth: 'app_jwt' },
  listInstallations: { method: 'GET', path: '/app/installations', auth: 'app_jwt' },
  getInstallation: { method: 'GET', path: '/app/installations/{id}', auth: 'app_jwt' },
  createAccessToken: {
    method: 'POST',
    path: '/app/installations/{id}/access_tokens',
    auth: 'app_jwt',
  },
  suspendInstallation: {
    method: 'PATCH',
    path: '/app/installations/{id}/suspended',
    auth: 'app_jwt',
  },
  revokeInstallationToken: { method: 'DELETE', path: '/installation/token', auth: 'access_token' },
  listInstallationProjects: { method: 'GET', path: '/installation/projects', auth: 'access_token' },
  listDeliveries: { method: 'GET', path: '/app/hook/deliveries', auth: 'app_jwt' },
  redeliver: { method: 'POST', path: '/app/hook/deliveries/{id}/attempts', auth: 'app_jwt' },
  token: { method: 'POST', path: '/oauth/token', auth: 'client_assertion' },
  jwks: { method: 'GET', path: '/jwks.json', auth: 'none' },
  discovery: { method: 'GET', path: DISCOVERY_PATH, auth: 'none' },
} as const;

/** Name of a REST route. */
export type PlatformRouteName = keyof typeof PLATFORM_ROUTES;

/** Substitute `{param}` placeholders in a route path (values are URI-encoded). */
export function buildPath(path: string, params: Record<string, string> = {}): string {
  return path.replace(/\{(\w+)\}/g, (_, k: string) => {
    const v = params[k];
    if (v === undefined) throw new Error(`missing path param ${k}`);
    return encodeURIComponent(v);
  });
}

/** Body of `POST /app/installations/{id}/access_tokens`. */
export const AccessTokenRequestSchema = z.object({
  permissions: PermissionsSchema.optional(),
  project_ids: z.array(z.string().min(1)).max(500).optional(),
  audience: z.string().min(1).optional(),
});
export type AccessTokenRequest = z.infer<typeof AccessTokenRequestSchema>;

/** Response of `POST /app/installations/{id}/access_tokens`. */
export const AccessTokenResponseSchema = z.object({
  token: z.string().min(1),
  expires_at: z.string(),
  permissions: PermissionsSchema,
  project_ids: z.array(z.string()).optional(),
});
export type AccessTokenResponse = z.infer<typeof AccessTokenResponseSchema>;

/** Body of `PATCH /app/installations/{id}/suspended`. */
export const SuspendRequestSchema = z.object({
  suspended: z.boolean(),
  reason: z.string().max(500).optional(),
});
export type SuspendRequest = z.infer<typeof SuspendRequestSchema>;

/** Response of `GET /app/installations`. */
export const InstallationListSchema = z.object({
  installations: z.array(InstallationSchema),
  next_cursor: z.string().nullable(),
});

/** A project visible to an installation. */
export const ProjectSchema = z.object({
  id: z.string().min(1),
  name: z.string(),
  account_id: z.string(),
});
export type Project = z.infer<typeof ProjectSchema>;

/** Response of `GET /installation/projects`. */
export const ProjectListSchema = z.object({
  projects: z.array(ProjectSchema),
  total_count: z.number().int().nonnegative(),
});

/** Summary of one webhook delivery attempt. */
export const HookDeliverySchema = z.object({
  id: z.string().min(1),
  guid: z.string().min(1),
  event: z.string().min(1),
  installation_id: z.string().nullable(),
  delivered_at: z.string(),
  redelivery: z.boolean(),
  duration_ms: z.number().nonnegative(),
  status: z.enum(['pending', 'ok', 'failed']),
  status_code: z.number().int().nullable(),
});
export type HookDelivery = z.infer<typeof HookDeliverySchema>;

/** Response of `GET /app/hook/deliveries`. */
export const HookDeliveryListSchema = z.object({
  deliveries: z.array(HookDeliverySchema),
  next_cursor: z.string().nullable(),
});

/** Response of `POST /app/hook/deliveries/{id}/attempts` (202). */
export const RedeliveryResponseSchema = z.object({
  delivery_id: z.string().min(1),
  status: z.literal('queued'),
});

/** `/.well-known/codai-platform` discovery document. */
export const DiscoveryDocumentSchema = z.object({
  issuer: z.url(),
  platform_version: z.string().min(1),
  revisions_supported: z.array(z.string()).min(1),
  token_endpoint: z.url(),
  jwks_uri: z.url(),
  installations_url: z.url(),
  manifest_conversion_url: z.url(),
  events_supported: z.array(z.string()),
  token_formats_supported: z.array(z.enum(['opaque', 'at+jwt'])).optional(),
  signing_alg_values_supported: z.array(z.string()).optional(),
});
export type DiscoveryDocument = z.infer<typeof DiscoveryDocumentSchema>;

/** JWKS response shape (public keys only). */
export const JwksSchema = z.object({
  keys: z
    .array(
      z
        .object({
          kty: z.string(),
          kid: z.string().min(1),
          alg: z.string().optional(),
          use: z.string().optional(),
        })
        .loose(),
    )
    .min(1),
});
