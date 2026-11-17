import type { JWK } from 'jose';
import type { AccountRef, Installation, ProjectScope } from './installation';
import type { App } from './manifest';
import type { Permissions } from './permissions';
import type { HookDelivery, Project } from './rest';
import type {
  IssuedTokenRecord,
  Page,
  PageOptions,
  PlatformStore,
  TrustedIssuer,
  WebhookDeliveryPort,
} from './store';
import type { AccessTokenClaims } from './tokens';

/** Seed data of {@link MemoryPlatformStore}. */
export interface MemoryStoreSeed {
  apps?: { app: App; publicKeys: JWK[] }[];
  installations?: Installation[];
  projects?: (Project & { installation_ids?: string[] })[];
  userPermissions?: { userId: string; accountId: string; permissions: Permissions }[];
  trustedIssuers?: TrustedIssuer[];
  federatedUsers?: { issuer: string; subject: string; userId: string }[];
  deliveries?: (HookDelivery & { app_id: string })[];
}

function paginate<T>(items: T[], page: PageOptions = {}): Page<T> {
  const start = page.cursor ? Number.parseInt(page.cursor, 10) || 0 : 0;
  const limit = Math.min(Math.max(page.limit ?? 30, 1), 100);
  const slice = items.slice(start, start + limit);
  const next = start + limit < items.length ? String(start + limit) : null;
  return { items: slice, next_cursor: next };
}

/** In-memory {@link PlatformStore} + {@link WebhookDeliveryPort} for tests, local dev and conformance runs. */
export class MemoryPlatformStore implements PlatformStore, WebhookDeliveryPort {
  readonly apps = new Map<string, { app: App; publicKeys: JWK[] }>();
  readonly installations = new Map<string, Installation>();
  readonly projects: (Project & { installation_ids?: string[] })[] = [];
  readonly issued: IssuedTokenRecord[] = [];
  readonly revoked = new Map<string, number>();
  readonly opaque = new Map<string, AccessTokenClaims>();
  readonly userPermissions = new Map<string, Permissions>();
  readonly trustedIssuers = new Map<string, TrustedIssuer>();
  readonly federatedUsers = new Map<string, string>();
  readonly deliveries: (HookDelivery & { app_id: string })[] = [];
  readonly redeliveries: string[] = [];

  constructor(seed: MemoryStoreSeed = {}) {
    for (const a of seed.apps ?? []) this.apps.set(a.app.id, a);
    for (const i of seed.installations ?? []) this.installations.set(i.id, i);
    this.projects.push(...(seed.projects ?? []));
    for (const u of seed.userPermissions ?? [])
      this.userPermissions.set(`${u.userId}@${u.accountId}`, u.permissions);
    for (const t of seed.trustedIssuers ?? []) this.trustedIssuers.set(t.issuer, t);
    for (const f of seed.federatedUsers ?? [])
      this.federatedUsers.set(`${f.issuer} ${f.subject}`, f.userId);
    this.deliveries.push(...(seed.deliveries ?? []));
  }

  /** Look up an app by id or client_id. */
  async getApp(idOrClientId: string): Promise<App | null> {
    const direct = this.apps.get(idOrClientId);
    if (direct) return direct.app;
    for (const { app } of this.apps.values()) if (app.client_id === idOrClientId) return app;
    return null;
  }

  /** Registered public keys of the app. */
  async getAppPublicKeys(appId: string): Promise<JWK[]> {
    return this.apps.get(appId)?.publicKeys ?? [];
  }

  /** Installation by id. */
  async getInstallation(id: string): Promise<Installation | null> {
    return this.installations.get(id) ?? null;
  }

  /** Installations of an app (offset cursor). */
  async listInstallations(appId: string, page?: PageOptions): Promise<Page<Installation>> {
    const all = [...this.installations.values()].filter(
      (i) => i.app_id === appId && i.status !== 'uninstalled',
    );
    return paginate(all, page);
  }

  /** Suspend or unsuspend an installation. */
  async setInstallationSuspended(
    id: string,
    suspended: boolean,
    by: { kind: 'user' | 'app' | 'platform'; id: string },
  ): Promise<Installation | null> {
    const inst = this.installations.get(id);
    if (!inst) return null;
    const { suspended_by: _drop, ...rest } = inst;
    const next: Installation = suspended
      ? { ...rest, status: 'suspended', suspended_by: by, updated_at: new Date().toISOString() }
      : { ...rest, status: 'active', updated_at: new Date().toISOString() };
    this.installations.set(id, next);
    return next;
  }

  /** Projects visible to the installation within `scope`. */
  async listInstallationProjects(installationId: string, scope: ProjectScope): Promise<Project[]> {
    const inst = this.installations.get(installationId);
    if (!inst) return [];
    return this.projects
      .filter((p) => p.account_id === inst.account.id && (scope === null || scope.includes(p.id)))
      .map(({ id, name, account_id }) => ({ id, name, account_id }));
  }

  /** Append an issuance record. */
  async recordTokenIssued(record: IssuedTokenRecord): Promise<void> {
    this.issued.push(record);
  }

  /** True when the jti was revoked. */
  async isJtiRevoked(jti: string): Promise<boolean> {
    return this.revoked.has(jti);
  }

  /** Revoke a jti until `exp`. */
  async revokeJti(jti: string, exp: number): Promise<void> {
    this.revoked.set(jti, exp);
  }

  /** User permissions on an account (empty when unknown). */
  async getUserPermissions(userId: string, account: AccountRef): Promise<Permissions> {
    return this.userPermissions.get(`${userId}@${account.id}`) ?? {};
  }

  /** Store opaque-token claims by hash. */
  async saveOpaqueToken(hash: string, claims: AccessTokenClaims): Promise<void> {
    this.opaque.set(hash, claims);
  }

  /** Find opaque-token claims by hash. */
  async findOpaqueToken(hash: string): Promise<AccessTokenClaims | null> {
    return this.opaque.get(hash) ?? null;
  }

  /** Trusted peer issuer, if registered. */
  async getTrustedIssuer(issuer: string): Promise<TrustedIssuer | null> {
    return this.trustedIssuers.get(issuer) ?? null;
  }

  /** Local user linked to a peer subject. */
  async resolveFederatedUser(issuer: string, subject: string): Promise<string | null> {
    return this.federatedUsers.get(`${issuer} ${subject}`) ?? null;
  }

  /** Delivery log of an app. */
  async listDeliveries(appId: string, page?: PageOptions): Promise<Page<HookDelivery>> {
    const mine = this.deliveries.filter((d) => d.app_id === appId).map(({ app_id: _a, ...d }) => d);
    return paginate(mine, page);
  }

  /** Queue a redelivery of one of the app's deliveries. */
  async redeliver(appId: string, deliveryId: string): Promise<boolean> {
    const found = this.deliveries.some((d) => d.app_id === appId && d.id === deliveryId);
    if (found) this.redeliveries.push(deliveryId);
    return found;
  }
}
