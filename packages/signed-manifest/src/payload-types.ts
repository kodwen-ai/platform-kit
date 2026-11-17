/** DSSE payload types used across codai. A verifier pins one so envelopes never cross over. */
export const PAYLOAD_TYPES = {
  /** Phone self-update manifest v1 (apps/phone-android `PhoneRelease`). */
  phoneReleaseV1: 'application/vnd.codai.phone-release+json;v=1',
  /** Desktop hot UI bundle manifest v1 (apps/desktop `ui_bundle.rs`). */
  uiBundleV1: 'application/vnd.codai.ui-bundle+json;v=1',
  /** Rules layer manifest (`@codai/rules-core`). */
  rulesV1: 'application/vnd.codai.rules+json;v=1',
  /** Signed client config (apps/desktop `client-config.ts`). */
  clientConfigV1: 'application/vnd.codai.client-config+json;v=1',
  /** Resolve task attestation. */
  resolveAttestationV1: 'application/vnd.codai.resolve.attestation+json;v=1',
  /** Release manifest v2: one shape for every product/surface, directives inside the signed payload. */
  releaseV2: 'application/vnd.codai.release+json;v=2',
} as const;

/** One of the known codai payload types. */
export type PayloadType = (typeof PAYLOAD_TYPES)[keyof typeof PAYLOAD_TYPES];
