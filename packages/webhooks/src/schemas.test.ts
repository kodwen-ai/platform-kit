import { describe, expect, it } from 'vitest';
import {
  CloudEventSchema,
  DeliveryAttemptSchema,
  RedeliveryRequestSchema,
  WebhookEventSchema,
  fromCloudEvent,
  toCloudEvent,
  type WebhookEvent,
} from './index.js';

const event: WebhookEvent = {
  id: 'evt_1',
  type: 'invoice.paid',
  created_at: '2026-10-19T07:00:00.000Z',
  data: { amount: 10 },
  installation_id: 'inst_1',
};

describe('WebhookEventSchema', () => {
  it('accepts a valid event and rejects bad ids/types/dates', () => {
    expect(WebhookEventSchema.parse(event)).toEqual(event);
    expect(WebhookEventSchema.safeParse({ ...event, id: 'a.b' }).success).toBe(false);
    expect(WebhookEventSchema.safeParse({ ...event, type: 'bad type' }).success).toBe(false);
    expect(WebhookEventSchema.safeParse({ ...event, created_at: 'yesterday' }).success).toBe(false);
  });
});

describe('DeliveryAttemptSchema', () => {
  const attempt = {
    id: 'dlv_1',
    event_id: 'evt_1',
    endpoint_id: 'ep_1',
    attempt: 1,
    status: 'retrying',
    response_status: 503,
    response_ms: 120,
    error: 'HTTP 503',
    next_attempt_at: '2026-10-19T07:00:05Z',
    created_at: '2026-10-19T07:00:00Z',
  };

  it('accepts a log row and rejects unknown statuses', () => {
    expect(DeliveryAttemptSchema.parse(attempt)).toEqual(attempt);
    expect(DeliveryAttemptSchema.safeParse({ ...attempt, status: 'done' }).success).toBe(false);
    expect(DeliveryAttemptSchema.safeParse({ ...attempt, attempt: 0 }).success).toBe(false);
  });
});

describe('RedeliveryRequestSchema', () => {
  it('accepts either a delivery id or an event+endpoint pair, not a mix', () => {
    expect(RedeliveryRequestSchema.safeParse({ delivery_id: 'd' }).success).toBe(true);
    expect(RedeliveryRequestSchema.safeParse({ event_id: 'e', endpoint_id: 'p' }).success).toBe(
      true,
    );
    expect(RedeliveryRequestSchema.safeParse({ event_id: 'e' }).success).toBe(false);
    expect(RedeliveryRequestSchema.safeParse({ delivery_id: 'd', event_id: 'e' }).success).toBe(
      false,
    );
  });
});

describe('CloudEvents', () => {
  it('round-trips a webhook event through a structured-mode envelope', () => {
    const ce = toCloudEvent(event, { source: 'https://codai.ro/webhooks' });
    expect(CloudEventSchema.parse(ce)).toMatchObject({
      specversion: '1.0',
      id: 'evt_1',
      type: 'invoice.paid',
      time: event.created_at,
      datacontenttype: 'application/json',
      subject: 'inst_1',
    });
    expect(fromCloudEvent(JSON.parse(JSON.stringify(ce)))).toEqual({
      ...event,
      account: undefined,
    });
  });

  it('rejects an empty source and a non-1.0 specversion', () => {
    expect(() => toCloudEvent(event, { source: '' })).toThrow(TypeError);
    expect(() => fromCloudEvent({ specversion: '0.3', id: 'x', source: 's', type: 't' })).toThrow();
  });
});
