# @codai/app-platform

## 0.2.1

- Metadata release: the published package is now built from the `kodwen-ai` mirror and its trusted
  publisher needed a first successful publish to validate. No behaviour changes.

## 0.2.0

- Link account contract (`@codai/app-platform/server`): `signLinkAssertion` / `verifyLinkAssertion` (`typ: codai-link+jwt`, ≤ 300 s, verified email + optional org/tax id, bound to the install `state`), `buildInstallUrl`, `buildSetupRedirect`.

## 0.1.0

- Initial release: codai app platform protocol v1: manifest, permissions, installations, app JWT, installation tokens, token exchange, Hono/Next adapters, typed client and conformance suite.
