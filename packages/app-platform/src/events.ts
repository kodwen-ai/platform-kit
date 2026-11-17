import { z } from 'zod';
import {
  levelSatisfies,
  PermissionLevelSchema,
  ResourceSlugSchema,
  type PermissionLevel,
  type Permissions,
} from './permissions';

/** Event type name, e.g. `installation.created` or `invoice.paid`. */
export const EventTypeSchema = z
  .string()
  .regex(/^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)*$/, 'invalid event type')
  .max(128);

/** Permission an app needs to subscribe to an event; `null` = always deliverable (lifecycle events). */
export const EventRequirementSchema = z
  .object({ resource: ResourceSlugSchema, level: PermissionLevelSchema })
  .nullable();
export type EventRequirement = z.infer<typeof EventRequirementSchema>;

/** Event type to required permission. */
export type EventCatalog = Readonly<Record<string, EventRequirement>>;

/** Lifecycle events every platform implementation delivers, needing no permission. */
export const BASE_EVENT_CATALOG: EventCatalog = Object.freeze({
  'installation.created': null,
  'installation.deleted': null,
  'installation.suspended': null,
  'installation.unsuspended': null,
  'installation.new_permissions_accepted': null,
  'installation_targets.changed': null,
  'installation_projects.added': null,
  'installation_projects.removed': null,
  'app.authorization.revoked': null,
  ping: null,
});

/** Merge host-specific events into the base catalog (validates names and requirements; base entries cannot be redefined). */
export function defineEventCatalog(
  extra: Record<string, { resource: string; level: PermissionLevel } | null>,
  base: EventCatalog = BASE_EVENT_CATALOG,
): EventCatalog {
  const out: Record<string, EventRequirement> = { ...base };
  for (const [type, req] of Object.entries(extra)) {
    EventTypeSchema.parse(type);
    if (type in base) throw new Error(`event ${type} is already defined by the base catalog`);
    out[type] = EventRequirementSchema.parse(req);
  }
  return Object.freeze(out);
}

/** Why an event cannot be subscribed: unknown to the catalog, or missing permission. */
export interface EventViolation {
  event: string;
  reason: 'unknown_event' | 'missing_permission';
  required?: { resource: string; level: PermissionLevel };
}

/** Events in `events` that `permissions` does not allow under `catalog`. */
export function eventViolations(
  events: readonly string[],
  permissions: Permissions,
  catalog: EventCatalog,
): EventViolation[] {
  const out: EventViolation[] = [];
  for (const event of events) {
    if (!Object.hasOwn(catalog, event)) {
      out.push({ event, reason: 'unknown_event' });
      continue;
    }
    const req = catalog[event];
    if (!req) continue;
    const have = permissions[req.resource];
    if (!have || !levelSatisfies(have, req.level))
      out.push({ event, reason: 'missing_permission', required: req });
  }
  return out;
}

/** Events from `events` deliverable with `permissions` (drops unknown and unpermitted ones). */
export function allowedEvents(
  events: readonly string[],
  permissions: Permissions,
  catalog: EventCatalog,
): string[] {
  const bad = new Set(eventViolations(events, permissions, catalog).map((v) => v.event));
  return events.filter((e) => !bad.has(e));
}
