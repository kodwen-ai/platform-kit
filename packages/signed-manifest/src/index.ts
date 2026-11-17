export {
  CanonicalizeError,
  canonicalBytes,
  canonicalHash,
  canonicalize,
  sha256Hex,
  type CanonicalizeOptions,
  type NumberMode,
} from './canon';
export { pae } from './pae';
export { fromBase64, toBase64 } from './base64';
export { derToRaw, rawToDer } from './der';
export { PAYLOAD_TYPES, type PayloadType } from './payload-types';
export {
  kmsSigner,
  localEd25519Signer,
  localP256Signer,
  type KmsAsymmetricSignRequest,
  type KmsSignClient,
  type KmsSignerOptions,
  type Signer,
} from './signers';
export {
  EnvelopeSchema,
  envelopeToJson,
  signEnvelope,
  verifyEnvelope,
  type Envelope,
  type SignEnvelopeOptions,
  type VerifyEnvelopeOptions,
  type VerifyEnvelopeResult,
  type VerifyFailureReason,
} from './envelope';
export { compareSemver } from './semver';
export {
  DESKTOP_COHORT_PREFIX,
  KNOWN_CHANNELS,
  KNOWN_SURFACES,
  ReleaseArtifactSchema,
  ReleaseDirectivesSchema,
  ReleaseManifestV2Schema,
  cohortOf,
  isEligible,
  signReleaseManifestV2,
  verifyReleaseManifestV2,
  type EligibilityInput,
  type EligibilityReason,
  type ReleaseDirectives,
  type ReleaseManifestV2,
  type VerifyReleaseResult,
} from './release';
export {
  LegacyPhoneManifestSchema,
  LegacyUiBundleManifestSchema,
  fromLegacyPhone,
  fromLegacyUiBundle,
  parseLegacyDirectives,
  uiBundleSequence,
  type FromLegacyOptions,
  type LegacyDirectives,
  type LegacyPhoneManifest,
  type LegacyUiBundleManifest,
} from './legacy';
