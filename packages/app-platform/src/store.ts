import type { JWK } from 'jose';
import type { AccountRef, Installation, ProjectScope } from './installation';
import type { App } from './manifest';
import type { Permissions } from './permissions';
import type { HookDelivery, Project } from './rest';
import type { AccessTokenClaims } from './tokens';

/** Cursor pagination input. */
export interface PageOptions {
  cursor?: string | undefined;
  limit?: number | undefined;
}

/** One page of results. */
export interface Page<T> {
  items: T[];
  next_cursor: string | null;
}

/** Audit record written whenever the platform issues an access token. */
export interface IssuedTokenRecord {
  jti: string;
  app_id: string;
  installation_id: string;
  sub: string;
  aud: string | string[];
  format: 'jwt' | 'opaque';
  permissions: Permissions;
  project_ids: ProjectScope;
  issued_at: number;
  expires_at: number;
}

/** A peer platform (e.g. Brivio for codai) whose tokens may be exchanged for local delegated tokens. */
export interface TrustedIssuer {
  issuer: string;
  jwks: JWK[];
}

/** Persistence the host implements; the platform core never touches a DB directly. */
export interface PlatformStore {
  /** App by id or client_id. */
  getApp(appIdOrClientId: string): Promise<App | null>;
  /** Public keys registered for the app (app JWT verification). */
  getAppPublicKeys(appId: string): Promise<JWK[]>;
  getInstallation(id: string): Promise<Installation | null>;
  listInstallations(appId: string, page?: PageOptions): Promise<Page<Installation>>;
  /** Suspend/unsuspend; returns the updated installation or null when unknown. */
  setInstallationSuspended(
    id: string,
    suspended: boolean,
    by: { kind: 'user' | 'app' | 'platform'; id: string },
  ): Promise<Installation | null>;
  /** Projects of the installation's account, restricted to `scope` (null = all). */
  listInstallationProjects(installationId: string, scope: ProjectScope): Promise<Project[]>;
  recordTokenIssued(record: IssuedTokenRecord): Promise<void>;
  isJtiRevoked(jti: string): Promise<boolean>;
  /** Revoke until `exp` (seconds); entries may be purged afterwards. */
  revokeJti(jti: string, exp: number): Promise<void>;
  /** Permissions the user holds on `account` (for user-to-server intersection). */
  getUserPermissions(userId: string, account: AccountRef): Promise<Permissions>;
  /** Opaque tokens: persist claims under the sha256 hash (optional; needed for format 'opaque'). */
  saveOpaqueToken?(hash: string, claims: AccessTokenClaims): Promise<void>;
  /** Opaque tokens: look up claims by sha256 hash. */
  findOpaqueToken?(hash: string): Promise<AccessTokenClaims | null>;
  /** Peer issuer trusted for cross-platform delegation, or null. */
  getTrustedIssuer?(issuer: string): Promise<TrustedIssuer | null>;
  /** Map a peer-issued subject to a local user id, or null when not linked. */
  resolveFederatedUser?(issuer: string, subject: string): Promise<string | null>;
}

/** Webhook delivery log + redelivery, implemented by the host's webhook package. */
export interface WebhookDeliveryPort {
  listDeliveries(appId: string, page?: PageOptions): Promise<Page<HookDelivery>>;
  /** Queue a redelivery; false when the delivery does not belong to the app. */
  redeliver(appId: string, deliveryId: string): Promise<boolean>;
}
