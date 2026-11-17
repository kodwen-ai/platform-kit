# @codai/app-platform

The codai app platform protocol **v1** — a GitHub-Apps-style model shared by every operator that hosts third-party apps (codai and Brivio each run their **own** issuer; nothing is shared but the protocol).

- **Protocol** (`@codai/app-platform`): Zod schemas and pure functions for app manifests, the permission algebra (`read < write < admin`), installations on user/org accounts narrowed to projects, event catalogs, token claims (app JWT, RFC 9068 `at+jwt` installation and user-to-server tokens, UI session tokens), RFC 8693 token exchange and RFC 7523 client credentials, REST route constants, opaque token helpers and the error envelope.
- **Server core** (`/server`): `createPlatformServer({ issuer, signingKey, store })` verifies app JWTs, mints/verifies/revokes tokens (JWT or opaque, sha256-hashed at rest), handles token exchange, serves JWKS and the discovery document. Persistence is a `PlatformStore` interface the host implements; `MemoryPlatformStore` is included for tests and local dev.
- **Adapters**: `/hono` (`platformRoutes`, `requirePlatformToken`) and `/next` (`withPlatformToken`, Web `Request`/`Response` only).
- **Client** (`/client`): `PlatformClient` signs app JWTs (≤ 9 min), caches installation tokens until 5 min before expiry, retries 429/5xx.
- **Conformance** (`/conformance` + `codai-platform-conformance` bin): a runnable suite any implementation must pass.

Versioning: path major `/platform/v1/...` plus the dated revision header `Codai-Platform-Version: 2026-10-19` (`PLATFORM_VERSION`, `PLATFORM_REVISION`). Unknown revisions get `400 unsupported_revision`.

## Install

```sh
pnpm add @codai/app-platform        # hono is an optional peer for the /hono adapter
```

## Serve the platform (Hono)

```ts
import { createPlatformServer } from '@codai/app-platform/server';
import { platformRoutes, requirePlatformToken } from '@codai/app-platform/hono';

const platform = createPlatformServer({
  issuer: 'https://ai.codai.ro',
  signingKey: {
    kid: '2026-10',
    alg: 'ES256',
    privateKey:
      process.env.PLATFORM_SIGNING_JWK_JSON && JSON.parse(process.env.PLATFORM_SIGNING_JWK_JSON),
  },
  store: myPostgresStore, // implements PlatformStore
});

app.route('/', platformRoutes(platform, { deliveries: myWebhookLog }));
app.get(
  '/v1/invoices',
  requirePlatformToken(platform, { audience: 'https://ai.codai.ro', permission: 'invoices:read' }),
  (c) => c.json({ installation: c.var.platformClaims.codai_installation.id }),
);
```

## Call it as an app

```ts
import { PlatformClient } from '@codai/app-platform/client';

const client = new PlatformClient({
  baseUrl: 'https://ai.codai.ro',
  appId: 'app_123',
  privateKey: pem,
  alg: 'RS256',
});
const inst = client.asInstallation('inst_42', { permissions: { invoices: 'read' } });
const { projects } = await inst.listProjects();
```

## Conformance

```sh
CODAI_PLATFORM_URL=https://brivio.ro CODAI_PLATFORM_APP_ID=app_1 CODAI_PLATFORM_APP_KEY_FILE=./app.pem \
CODAI_PLATFORM_INSTALLATION_ID=inst_1 CODAI_PLATFORM_AUDIENCE=https://brivio.ro npx codai-platform-conformance
```

Optional: `CODAI_PLATFORM_APP_KEY_PEM` (inline PEM instead of a file), `CODAI_PLATFORM_APP_ALG` (`RS256`|`ES256`), `CODAI_PLATFORM_KID`, `CODAI_PLATFORM_REVISION`. Exit code 0 = all checks passed, 1 = failures, 2 = bad configuration. Key material is never printed.

## Licence

Apache-2.0
