# @codai/webhooks

[Standard Webhooks](https://www.standardwebhooks.com/) v1 (HMAC-SHA256) for producers and consumers, platform neutral (WebCrypto):

- secrets (`generateSecret`, `parseSecret`), signing (`sign`, `buildHeaders` with multi-secret rotation)
- verification (`verify` → typed result, `verifyOrThrow`) with replay tolerance and constant-time comparison
- retry policy (`RETRY_SCHEDULE_SEC`, `nextAttemptAt`, `isRetryableStatus`, `shouldDisableEndpoint`, `parseRetryAfter`)
- delivery-log and redelivery contract as Zod schemas (`WebhookEventSchema`, `DeliveryAttemptSchema`, `RedeliveryRequestSchema`)
- CloudEvents 1.0 structured-mode envelope (`toCloudEvent`, `fromCloudEvent`)
- SSRF-safe target checks (`validateWebhookUrl`, `isPrivateAddress`)
- a small fetch-based sender (`sendWebhook`) that never throws

## Install

```sh
pnpm add @codai/webhooks
```

## Receive

```ts
import { verify } from '@codai/webhooks';

export async function POST(req: Request) {
  const payload = await req.text(); // raw body — never re-serialise parsed JSON
  const result = await verify({
    headers: req.headers,
    payload,
    secrets: [process.env.WEBHOOK_SECRET!],
  });
  if (!result.ok) return new Response(result.reason, { status: 401 });
  // use the webhook-id header as an idempotency key
  return new Response(null, { status: 204 });
}
```

## Send

```ts
import { nextAttemptAt, sendWebhook, shouldDisableEndpoint } from '@codai/webhooks';

const r = await sendWebhook({ url: endpoint.url, event, secrets: endpoint.activeSecrets });
if (r.disable)
  await disableEndpoint(endpoint.id); // 410 Gone
else if (r.retryable)
  schedule(nextAttemptAt(attempt + 1, Date.now(), { jitter: 0.1, retryAfterSec: r.retryAfterSec }));
```

## SSRF: re-check at connect time

`validateWebhookUrl` inspects only the URL. A public hostname can resolve to a private
address later (DNS rebinding), so the delivering server **must** re-check every resolved IP
with `isPrivateAddress` at connect time (custom DNS lookup / undici dispatcher, or an egress
proxy such as smokescreen) and must not follow redirects (`sendWebhook` uses
`redirect: 'manual'`). Pass such a fetch via `sendWebhook({ fetch })`.

## Licence

Apache-2.0
