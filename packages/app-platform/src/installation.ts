import { z } from 'zod';
import { AccountKindSchema } from './manifest';
import { PermissionsSchema } from './permissions';

/** Account an installation targets. */
export const AccountRefSchema = z.object({
  kind: AccountKindSchema,
  id: z.string().min(1),
  login: z.string().optional(),
});
export type AccountRef = z.infer<typeof AccountRefSchema>;

/** Lifecycle status of an installation. */
export const InstallationStatusSchema = z.enum([
  'active',
  'suspended',
  'uninstalled',
  'pending_approval',
]);
export type InstallationStatus = z.infer<typeof InstallationStatusSchema>;

/** An app installed on a user or org account, optionally narrowed to projects. */
export const InstallationSchema = z
  .object({
    id: z.string().min(1),
    app_id: z.string().min(1),
    app_slug: z.string().min(1),
    account: AccountRefSchema,
    target_type: AccountKindSchema,
    project_selection: z.enum(['all', 'selected']),
    project_ids: z.array(z.string().min(1)).default([]),
    permissions: PermissionsSchema,
    events: z.array(z.string()),
    status: InstallationStatusSchema,
    suspended_by: z
      .object({ kind: z.enum(['user', 'app', 'platform']), id: z.string() })
      .optional(),
    created_at: z.string(),
    updated_at: z.string(),
    permissions_version: z.number().int().nonnegative(),
  })
  .refine((i) => i.target_type === i.account.kind, {
    message: 'target_type must equal account.kind',
    path: ['target_type'],
  })
  .refine((i) => i.project_selection === 'selected' || i.project_ids.length === 0, {
    message: 'project_ids only allowed when project_selection is selected',
    path: ['project_ids'],
  });
export type Installation = z.infer<typeof InstallationSchema>;

/** Project ids a token may act on: `null` = all projects of the account. */
export type ProjectScope = string[] | null;

/** Result of {@link narrowProjects}. */
export type NarrowProjectsResult =
  { ok: true; projectIds: ProjectScope } | { ok: false; exceeded: string[] };

/** Narrow an installation's project scope to `requested`; fails if a requested project is outside it. */
export function narrowProjects(
  installation: Pick<Installation, 'project_selection' | 'project_ids'>,
  requested?: readonly string[],
): NarrowProjectsResult {
  const allowed: ProjectScope =
    installation.project_selection === 'all' ? null : [...installation.project_ids];
  if (!requested) return { ok: true, projectIds: allowed };
  const unique = [...new Set(requested)].sort();
  if (allowed === null) return { ok: true, projectIds: unique };
  const set = new Set(allowed);
  const exceeded = unique.filter((p) => !set.has(p));
  return exceeded.length > 0 ? { ok: false, exceeded } : { ok: true, projectIds: unique };
}
