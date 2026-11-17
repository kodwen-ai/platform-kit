# @codai/release-sdk

Typed client of the codai Release Manager API (`https://api.codai.ro/v1/releases`): products, apps, store connections, releases, staged rollouts, halt / resume / complete. Every request sends `Codai-Platform-Version` (default `2026-10-19`); POSTs carry an `Idempotency-Key` reused across retries; 429 / 5xx / network errors are retried 3 times with exponential backoff (honouring `Retry-After`). Errors are `ReleaseApiError { code, status, requestId }`. Responses are validated with Zod.

## Install

```sh
pnpm add @codai/release-sdk
```

## Usage

```ts
import { ReleaseClient } from '@codai/release-sdk';

const releases = new ReleaseClient({ token: process.env.CODAI_TOKEN! });
const rel = await releases.createRelease({
  app_id: 'app_123',
  version: '3.5.1',
  version_code: 14,
  channel: 'production',
  notes_i18n: { 'en-US': 'Bug fixes', ro: 'Remedieri' },
  build: { artifact_sha256: '…64 hex…' },
  rollout_percent: 10,
});
await releases.rollout(rel.id, { action: 'set', percent: 50 });
await releases.halt(rel.id);
```

```ts
const { data, next_cursor } = await releases.listReleases('app_123', { limit: 20 });
```

## Licence

Apache-2.0
