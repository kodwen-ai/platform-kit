import { z } from 'zod';
import { BASE_EVENT_CATALOG, EventTypeSchema, eventViolations, type EventCatalog } from './events';
import { PermissionsSchema } from './permissions';
import { PLATFORM_REVISION } from './version';

/** Account kinds an app can be owned by or installed on. */
export const AccountKindSchema = z.enum(['user', 'org']);
export type AccountKind = z.infer<typeof AccountKindSchema>;

const HttpsUrl = z.url({ protocol: /^https?$/ });
const Slug = z.string().regex(/^[a-z0-9][a-z0-9-]{0,62}$/, 'invalid app slug');

/** One UI extension mount point offered by the app. */
export const UiExtensionSchema = z.object({
  point: z
    .string()
    .regex(/^[a-z][a-z0-9_.:-]*$/)
    .max(128),
  url: HttpsUrl,
  title: z.string().min(1).max(80),
});

/** One pricing plan listed for the app. */
export const PricingPlanSchema = z
  .object({
    id: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,63}$/),
    name: z.string().min(1).max(80),
    model: z.enum(['free', 'flat', 'per_unit', 'usage']),
    amount_minor: z.number().int().nonnegative().optional(),
    currency: z
      .string()
      .regex(/^[A-Z]{3}$/)
      .optional(),
    trial_days: z.number().int().min(0).max(365).optional(),
  })
  .refine((p) => p.model === 'free' || (p.amount_minor !== undefined && p.currency !== undefined), {
    message: 'paid plans need amount_minor and currency',
  });

const ManifestBase = z.object({
  name: z.string().min(1).max(80),
  slug: Slug,
  description: z.string().max(2000).default(''),
  url: HttpsUrl,
  owner: z.object({ kind: AccountKindSchema, id: z.string().min(1) }),
  public: z.boolean().default(false),
  redirect_urls: z.array(HttpsUrl).max(20).default([]),
  setup_url: HttpsUrl.optional(),
  callback_urls: z.array(HttpsUrl).max(20).default([]),
  webhook: z
    .object({
      url: HttpsUrl,
      active: z.boolean().default(true),
      events: z.array(EventTypeSchema).default([]),
    })
    .optional(),
  default_permissions: PermissionsSchema.default({}),
  default_events: z.array(EventTypeSchema).default([]),
  request_oauth_on_install: z.boolean().default(false),
  ui_extensions: z.array(UiExtensionSchema).max(50).optional(),
  hosted: z
    .object({
      runtime: z.literal('codai-sandbox-v2'),
      egress: z.array(z.string().min(1).max(253)).max(100),
    })
    .optional(),
  pricing: z.array(PricingPlanSchema).max(20).optional(),
  conformance_revision: z.string().default(PLATFORM_REVISION),
});

/** Build a manifest schema whose event subscriptions are checked against `catalog`. */
export function createAppManifestSchema(catalog: EventCatalog = BASE_EVENT_CATALOG) {
  return ManifestBase.superRefine((m, ctx) => {
    const check = (events: readonly string[], path: (string | number)[]) => {
      for (const v of eventViolations(events, m.default_permissions, catalog)) {
        const why =
          v.reason === 'unknown_event'
            ? 'unknown event'
            : `needs ${v.required?.resource}:${v.required?.level}`;
        ctx.addIssue({
          code: 'custom',
          path: [...path, events.indexOf(v.event)],
          message: `${v.event}: ${why}`,
        });
      }
    };
    check(m.default_events, ['default_events']);
    if (m.webhook) check(m.webhook.events, ['webhook', 'events']);
    if (m.request_oauth_on_install && m.callback_urls.length === 0) {
      ctx.addIssue({
        code: 'custom',
        path: ['callback_urls'],
        message: 'request_oauth_on_install needs a callback url',
      });
    }
  });
}

/** App manifest schema validated against the base (lifecycle-only) event catalog. */
export const AppManifestSchema = createAppManifestSchema();
export type AppManifest = z.output<typeof ManifestBase>;
export type AppManifestInput = z.input<typeof ManifestBase>;

/** A registered app as returned by `GET /app`. */
export const AppSchema = z.object({
  id: z.string().min(1),
  client_id: z.string().min(1),
  slug: Slug,
  name: z.string(),
  description: z.string(),
  owner: z.object({ kind: AccountKindSchema, id: z.string() }),
  url: z.string(),
  public: z.boolean(),
  permissions: PermissionsSchema,
  events: z.array(z.string()),
  created_at: z.string(),
  updated_at: z.string(),
});
export type App = z.infer<typeof AppSchema>;
