# codai platform kit

Shared building blocks of the codai ↔ Brivio **Platform Fabric**: the app-platform protocol both products implement, plus release and cost primitives. Published to npm with provenance via trusted publishing (OIDC).

| Package                                              | What it is                                                                                                                                                                             |
| ---------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`@codai/app-platform`](packages/app-platform)       | App platform protocol v1 (GitHub-Apps model): manifests, permissions, installations, app JWT, installation tokens, token exchange, Hono/Next adapters, typed client, conformance suite |
| [`@codai/webhooks`](packages/webhooks)               | Standard Webhooks signing/verification, secret rotation, retry schedule, delivery log + redelivery contract, CloudEvents, SSRF-safe targets                                            |
| [`@codai/signed-manifest`](packages/signed-manifest) | DSSE envelopes over RFC 8785 JCS with ECDSA P-256 (Cloud KMS), signed release manifests with rollout / halt / pull directives                                                          |
| [`@codai/store-adapters`](packages/store-adapters)   | One interface over Google Play, Microsoft Store, Firebase App Distribution, GitHub Releases and package registries                                                                     |
| [`@codai/cost-connectors`](packages/cost-connectors) | Cloud/SaaS cost connectors normalised to FOCUS 1.2+ rows                                                                                                                               |
| [`@codai/release-sdk`](packages/release-sdk)         | Typed client of the codai Release Manager API                                                                                                                                          |

This repository is a **generated mirror** of the codai monorepo. Issues are welcome here; changes land upstream and are synced.

Licence: Apache-2.0.
