import { z } from 'zod';

const isoDate = z.iso.datetime({ offset: true });

/** A webhook event as stored and delivered. */
export const WebhookEventSchema = z.object({
  id: z
    .string()
    .min(1)
    .regex(/^[^.\s]+$/, 'id must not contain "." or whitespace'),
  type: z
    .string()
    .regex(
      /^[A-Za-z0-9_]+(\.[A-Za-z0-9_]+)*$/,
      'type must be full-stop delimited [A-Za-z0-9_] segments',
    ),
  created_at: isoDate,
  data: z.unknown(),
  installation_id: z.string().min(1).optional(),
  account: z.string().min(1).optional(),
});
/** A webhook event. */
export type WebhookEvent = z.infer<typeof WebhookEventSchema>;

/** Lifecycle status of a delivery attempt. */
export const DeliveryStatusSchema = z.enum([
  'pending',
  'succeeded',
  'failed',
  'retrying',
  'abandoned',
]);
/** Lifecycle status of a delivery attempt. */
export type DeliveryStatus = z.infer<typeof DeliveryStatusSchema>;

/** One row of the delivery log. */
export const DeliveryAttemptSchema = z.object({
  id: z.string().min(1),
  event_id: z.string().min(1),
  endpoint_id: z.string().min(1),
  attempt: z.int().min(1),
  status: DeliveryStatusSchema,
  response_status: z.int().min(0).max(999).nullable(),
  response_ms: z.number().min(0).nullable(),
  error: z.string().nullable(),
  next_attempt_at: isoDate.nullable(),
  created_at: isoDate,
});
/** One row of the delivery log. */
export type DeliveryAttempt = z.infer<typeof DeliveryAttemptSchema>;

/** Request to redeliver: a specific delivery, or an event to an endpoint. */
export const RedeliveryRequestSchema = z.union([
  z.strictObject({ delivery_id: z.string().min(1) }),
  z.strictObject({ event_id: z.string().min(1), endpoint_id: z.string().min(1) }),
]);
/** Request to redeliver. */
export type RedeliveryRequest = z.infer<typeof RedeliveryRequestSchema>;
