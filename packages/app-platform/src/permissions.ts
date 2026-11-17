import { z } from 'zod';

/** Ordered permission levels: read < write < admin. */
export const PERMISSION_LEVELS = ['read', 'write', 'admin'] as const;

/** Zod schema for one permission level. */
export const PermissionLevelSchema = z.enum(PERMISSION_LEVELS);
export type PermissionLevel = z.infer<typeof PermissionLevelSchema>;

/** Resource slug: lowercase, starts with a letter, may contain digits, `_` and `.`. */
export const ResourceSlugSchema = z
  .string()
  .regex(/^[a-z][a-z0-9_.]*$/, 'invalid resource slug')
  .max(64);

/** Map of resource slug to granted level. */
export const PermissionsSchema = z.record(ResourceSlugSchema, PermissionLevelSchema);
export type Permissions = z.infer<typeof PermissionsSchema>;

/** Numeric rank of a level (read=1, write=2, admin=3). */
export function levelRank(level: PermissionLevel): number {
  return PERMISSION_LEVELS.indexOf(level) + 1;
}

/** True when `have` is at least `need`. */
export function levelSatisfies(have: PermissionLevel, need: PermissionLevel): boolean {
  return levelRank(have) >= levelRank(need);
}

function minLevel(a: PermissionLevel, b: PermissionLevel): PermissionLevel {
  return levelRank(a) <= levelRank(b) ? a : b;
}

function sortedEntries(p: Permissions): [string, PermissionLevel][] {
  return Object.entries(p).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
}

/** Resources present in both maps, each at the lower of the two levels. */
export function intersectPermissions(a: Permissions, b: Permissions): Permissions {
  const out: Permissions = {};
  for (const [resource, level] of sortedEntries(a)) {
    const other = b[resource];
    if (other) out[resource] = minLevel(level, other);
  }
  return out;
}

/** True when every requested resource is granted at an equal or higher level. */
export function isSubset(requested: Permissions, granted: Permissions): boolean {
  return exceededResources(requested, granted).length === 0;
}

/** Requested resources that `granted` does not cover (sorted). */
export function exceededResources(requested: Permissions, granted: Permissions): string[] {
  const out: string[] = [];
  for (const [resource, level] of sortedEntries(requested)) {
    const have = granted[resource];
    if (!have || !levelSatisfies(have, level)) out.push(resource);
  }
  return out;
}

/** Result of {@link narrowPermissions}. */
export type NarrowResult =
  { ok: true; permissions: Permissions } | { ok: false; exceeded: string[] };

/** Narrow `granted` to `requested` (all of `granted` when omitted); fails if `requested` exceeds `granted`. */
export function narrowPermissions(granted: Permissions, requested?: Permissions): NarrowResult {
  if (!requested) return { ok: true, permissions: { ...granted } };
  const exceeded = exceededResources(requested, granted);
  if (exceeded.length > 0) return { ok: false, exceeded };
  return { ok: true, permissions: Object.fromEntries(sortedEntries(requested)) };
}

/** Difference between two permission maps. */
export interface PermissionDiff {
  added: Permissions;
  upgraded: Permissions;
  downgraded: Permissions;
  removed: string[];
}

/** Compute what changed from `oldP` to `newP` (levels in `added`/`upgraded`/`downgraded` are the new ones). */
export function permissionDiff(oldP: Permissions, newP: Permissions): PermissionDiff {
  const diff: PermissionDiff = { added: {}, upgraded: {}, downgraded: {}, removed: [] };
  for (const [resource, level] of sortedEntries(newP)) {
    const before = oldP[resource];
    if (!before) diff.added[resource] = level;
    else if (levelRank(level) > levelRank(before)) diff.upgraded[resource] = level;
    else if (levelRank(level) < levelRank(before)) diff.downgraded[resource] = level;
  }
  for (const [resource] of sortedEntries(oldP)) if (!newP[resource]) diff.removed.push(resource);
  return diff;
}

/** True when moving from `oldP` to `newP` adds or upgrades any permission (account owner must re-consent). */
export function requiresReconsent(oldP: Permissions, newP: Permissions): boolean {
  const d = permissionDiff(oldP, newP);
  return Object.keys(d.added).length > 0 || Object.keys(d.upgraded).length > 0;
}

/** Serialise permissions as an OAuth scope string (`resource:level`, sorted, space-separated). */
export function permissionsToScope(p: Permissions): string {
  return sortedEntries(p)
    .map(([r, l]) => `${r}:${l}`)
    .join(' ');
}

/** Parse an OAuth scope string produced by {@link permissionsToScope}; returns null when malformed. */
export function scopeToPermissions(scope: string): Permissions | null {
  const out: Permissions = {};
  for (const part of scope.split(' ').filter((s) => s.length > 0)) {
    const idx = part.lastIndexOf(':');
    if (idx <= 0) return null;
    const resource = ResourceSlugSchema.safeParse(part.slice(0, idx));
    const level = PermissionLevelSchema.safeParse(part.slice(idx + 1));
    if (!resource.success || !level.success) return null;
    const prev = out[resource.data];
    out[resource.data] = prev && levelRank(prev) > levelRank(level.data) ? prev : level.data;
  }
  return out;
}
