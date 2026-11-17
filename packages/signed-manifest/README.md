# @codai/signed-manifest

DSSE v1 envelopes over RFC 8785 (JCS) canonical JSON, signed with ECDSA P-256 / SHA-256 (Cloud KMS
`EC_SIGN_P256_SHA256` or a local key). Byte-compatible with the envelopes codai's phone, desktop and
rules layer already verify, plus **release manifest v2**: one signed shape for every product and surface,
with rollout / pull / halt / revocation directives _inside_ the signed payload, and deterministic cohorts.

```sh
pnpm add @codai/signed-manifest
```

## Sign with Cloud KMS, verify with a pinned key

```ts
import { KeyManagementServiceClient } from '@google-cloud/kms';
import {
  envelopeToJson,
  kmsSigner,
  signReleaseManifestV2,
  verifyReleaseManifestV2,
} from '@codai/signed-manifest';

const keyVersionName =
  'projects/p/locations/global/keyRings/codai/cryptoKeys/rules-signing/cryptoKeyVersions/1';
const signer = kmsSigner({ keyVersionName, client: new KeyManagementServiceClient() });
const envelope = await signReleaseManifestV2(manifest, { signer, keyid: keyVersionName });
const json = envelopeToJson(envelope); // publish this

const r = verifyReleaseManifestV2(JSON.parse(json), { publicKeysPem: [PINNED_PEM] });
if (r.ok) console.log(r.manifest.version, r.manifest.directives.rollout);
```

The KMS SDK is not a dependency: `kmsSigner` takes any client with an `asymmetricSign` method.

## Decide whether a client should update

```ts
import { cohortOf, DESKTOP_COHORT_PREFIX, isEligible } from '@codai/signed-manifest';

const cohort = cohortOf(installId, r.manifest.directives.cohort_seed_prefix); // '' on phone, DESKTOP_COHORT_PREFIX on desktop
isEligible(r.manifest, { cohort, currentVersion: '1.1.0', now: Date.now() }); // 'OK' | 'NOT_IN_ROLLOUT' | 'PULLED' | …
```

## Also included

- `canonicalize` / `canonicalBytes` / `canonicalHash` (`numbers: 'finite' | 'integers'`), `pae`
- `signEnvelope` / `verifyEnvelope` for any payload type (`PAYLOAD_TYPES`), `localP256Signer`, `localEd25519Signer`
- `derToRaw` / `rawToDer` for WebCrypto verifiers
- `legacy`: `parseLegacyDirectives`, `fromLegacyPhone`, `fromLegacyUiBundle` to serve v1 and v2 during migration

## Licence

Apache-2.0
