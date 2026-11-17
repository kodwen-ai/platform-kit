import type { JWK } from 'jose';
import { platformRoutes } from '../hono-routes';
import type { Installation } from '../installation';
import { generateSigningKeyPair, type SigningAlg } from '../keys';
import type { App } from '../manifest';
import { MemoryPlatformStore } from '../memory-store';
import { createPlatformServer, type PlatformServer } from '../platform-server';

export const ISSUER = 'https://platform.test';
export const AUDIENCE = 'https://api.test';

/** Mutable fake clock (ms). */
export function fakeClock(start = Date.now()) {
  let t = start;
  return { now: () => new Date(t), ms: () => t, advance: (sec: number) => (t += sec * 1000) };
}

const ts = '2026-10-19T00:00:00Z';

/** A registered test app. */
function makeApp(id = 'app_1'): App {
  return {
    id,
    client_id: `cl_${id}`,
    slug: 'invoice-sync',
    name: 'Invoice Sync',
    description: '',
    owner: { kind: 'org', id: 'org_dev' },
    url: 'https://example.ro',
    public: true,
    permissions: { invoices: 'write', contacts: 'read' },
    events: ['installation.created'],
    created_at: ts,
    updated_at: ts,
  };
}

/** A test installation. */
function makeInstallation(over: Partial<Installation> = {}): Installation {
  return {
    id: 'inst_1',
    app_id: 'app_1',
    app_slug: 'invoice-sync',
    account: { kind: 'org', id: 'org_1', login: 'acme' },
    target_type: 'org',
    project_selection: 'selected',
    project_ids: ['p1', 'p2'],
    permissions: { invoices: 'write', contacts: 'read' },
    events: ['installation.created'],
    status: 'active',
    created_at: ts,
    updated_at: ts,
    permissions_version: 1,
    ...over,
  };
}

export interface Fixture {
  server: PlatformServer;
  store: MemoryPlatformStore;
  clock: ReturnType<typeof fakeClock>;
  appKey: { privateJwk: JWK; publicJwk: JWK };
  serverKey: { privateJwk: JWK; publicJwk: JWK };
  appAlg: SigningAlg;
  fetch: typeof fetch;
  hono: ReturnType<typeof platformRoutes>;
}

/** Build a server + store + Hono app wired through an injected fetch. */
export async function makeFixture(
  o: { serverAlg?: SigningAlg; appAlg?: SigningAlg; clock?: ReturnType<typeof fakeClock> } = {},
): Promise<Fixture> {
  const serverAlg = o.serverAlg ?? 'ES256';
  const appAlg = o.appAlg ?? 'RS256';
  const serverKey = await generateSigningKeyPair(serverAlg, 'srv-1');
  const appKey = await generateSigningKeyPair(appAlg, 'app-key-1');
  const store = new MemoryPlatformStore({
    apps: [
      { app: makeApp(), publicKeys: [appKey.publicJwk] },
      { app: makeApp('app_2'), publicKeys: [] },
    ],
    installations: [
      makeInstallation(),
      makeInstallation({ id: 'inst_all', project_selection: 'all', project_ids: [] }),
      makeInstallation({ id: 'inst_other', app_id: 'app_2' }),
      makeInstallation({ id: 'inst_pending', status: 'pending_approval' }),
    ],
    projects: [
      { id: 'p1', name: 'One', account_id: 'org_1' },
      { id: 'p2', name: 'Two', account_id: 'org_1' },
      { id: 'p3', name: 'Three', account_id: 'org_1' },
    ],
    userPermissions: [
      {
        userId: 'u1',
        accountId: 'org_1',
        permissions: { invoices: 'read', contacts: 'admin', billing: 'admin' },
      },
    ],
    deliveries: [
      {
        app_id: 'app_1',
        id: 'd1',
        guid: 'g1',
        event: 'installation.created',
        installation_id: 'inst_1',
        delivered_at: ts,
        redelivery: false,
        duration_ms: 12,
        status: 'ok',
        status_code: 200,
      },
    ],
  });
  const clock = o.clock ?? fakeClock();
  const server = createPlatformServer({
    issuer: ISSUER,
    signingKey: { kid: 'srv-1', alg: serverAlg, privateKey: serverKey.privateJwk },
    store,
    clock: clock.now,
    defaultAudience: AUDIENCE,
  });
  const hono = platformRoutes(server, { deliveries: store, audience: [AUDIENCE] });
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) =>
    hono.request(input instanceof Request ? input : String(input), init)) as typeof fetch;
  return { server, store, clock, appKey, serverKey, appAlg, fetch: fetchImpl, hono };
}
