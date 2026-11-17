# @codai/store-adapters

One `StoreAdapter` interface over app stores and registries: upload, tracks, staged rollout, halt/resume/complete, listings and review status.

| Adapter                                                           | Store                                    | Capabilities                                                                              |
| ----------------------------------------------------------------- | ---------------------------------------- | ----------------------------------------------------------------------------------------- |
| `GooglePlayAdapter`                                               | Google Play (Android Publisher v3 Edits) | upload, tracks, staged_rollout, halt, resume, complete, listing, localized_notes          |
| `MicrosoftStoreAdapter`                                           | Microsoft Store submission API (MSIX)    | upload, tracks (`public`), staged_rollout, halt, complete, localized_notes, review_status |
| `FirebaseAppDistributionAdapter`                                  | Firebase App Distribution                | upload, tracks (= tester groups)                                                          |
| `GithubReleasesAdapter`                                           | GitHub Releases (sideload)               | upload, tracks (`latest` / `prerelease`), review_status                                   |
| `NpmRegistryAdapter`, `PypiRegistryAdapter`, `McpRegistryAdapter` | npm, PyPI, MCP registry                  | review_status (live version; publishing is trusted publishing in CI)                      |

Stores without an adapter yet (Huawei, Samsung, Amazon, winget, Chrome Web Store, VS Code Marketplace) are listed in `STORE_CATALOG` with `implemented: false`. Calling an operation an adapter lacks rejects with `UnsupportedCapabilityError`.

No Google/Azure SDKs: every adapter takes an injectable `fetch` and `getAccessToken()` (tokens come from WIF / OIDC in CI).

## Install

```sh
pnpm add @codai/store-adapters
```

## Usage

```ts
import { GooglePlayAdapter } from '@codai/store-adapters';

const play = new GooglePlayAdapter({
  packageName: 'ro.codai.phone',
  getAccessToken: async () => process.env.PLAY_ACCESS_TOKEN!,
});
const { artifactId } = await play.upload({ artifactPath: 'app-release.aab', kind: 'aab' });
// upload + track + commit happen in one edit; the edit is deleted on any failure
await play.setTrack({
  track: 'production',
  artifactIds: [artifactId],
  status: 'inProgress',
  userFraction: 0.1,
  releaseNotes: { 'en-US': 'Bug fixes' }, // max 500 chars per locale
});
await play.halt('production');
```

```ts
import { MicrosoftStoreAdapter } from '@codai/store-adapters';

const ms = new MicrosoftStoreAdapter({ appId: '9NBLGGH4R315', getAccessToken });
const { artifactId } = await ms.upload({ artifactPath: 'codai_1.2.0.0_x64.msix', kind: 'msix' });
await ms.setTrack({
  track: 'public',
  artifactIds: [artifactId],
  status: 'inProgress',
  userFraction: 0.2,
});
await ms.getReviewStatus(); // { state: 'processing' | 'in_review' | 'live' | ... }
```

## Licence

Apache-2.0
