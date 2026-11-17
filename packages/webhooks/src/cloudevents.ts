// CloudEvents 1.0 structured content mode (JSON event format).
// Spec: https://github.com/cloudevents/spec/blob/v1.0.2/cloudevents/spec.md
// JSON format: https://github.com/cloudevents/spec/blob/v1.0.2/cloudevents/formats/json-format.md
import { z } from 'zod';
import { WebhookEventSchema, type WebhookEvent } from './schemas.js';

/** CloudEvents 1.0 structured-mode envelope carrying a webhook event. */
export const CloudEventSchema = z.object({
  specversion: z.literal('1.0'),
  id: z.string().min(1),
  source: z.string().min(1),
  type: z.string().min(1),
  time: z.iso.datetime({ offset: true }).optional(),
  datacontenttype: z.literal('application/json').optional(),
  subject: z.string().min(1).optional(),
  data: z.unknown(),
});
/** CloudEvents 1.0 envelope. */
export type CloudEvent = z.infer<typeof CloudEventSchema>;

/** Content type for structured-mode CloudEvents over HTTP. */
export const CLOUDEVENTS_CONTENT_TYPE = 'application/cloudevents+json; charset=utf-8';

/** Wrap a webhook event in a CloudEvents 1.0 envelope; `source` is a URI-reference. */
export function toCloudEvent(event: WebhookEvent, options: { source: string }): CloudEvent {
  if (options.source.length === 0) throw new TypeError('source must be a non-empty URI-reference');
  const ce: CloudEvent = {
    specversion: '1.0',
    id: event.id,
    source: options.source,
    type: event.type,
    time: event.created_at,
    datacontenttype: 'application/json',
    data: event.data,
  };
  if (event.installation_id !== undefined) ce.subject = event.installation_id;
  return ce;
}

/** Parse a CloudEvents envelope back into a webhook event; throws a ZodError on invalid input. */
export function fromCloudEvent(input: unknown): WebhookEvent {
  const ce = CloudEventSchema.parse(input);
  return WebhookEventSchema.parse({
    id: ce.id,
    type: ce.type,
    created_at: ce.time ?? new Date().toISOString(),
    data: ce.data,
    ...(ce.subject === undefined ? {} : { installation_id: ce.subject }),
  });
}
