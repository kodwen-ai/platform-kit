/**
 * Read-only registry adapters: they report the live version. Publishing happens in CI via trusted publishing.
 * Docs: npm https://github.com/npm/registry/blob/main/docs/REGISTRY-API.md
 *       PyPI https://docs.pypi.org/api/json/
 *       MCP registry https://registry.modelcontextprotocol.io/docs (GET /v0/servers?search=)
 */
import { BaseStoreAdapter } from './base';
import { StoreApiError, StoreValidationError } from './errors';
import { HttpClient, resolveFetch } from './http';
import type { Capability, FetchLike, ReviewStatus, StoreId } from './types';

/** Options shared by the registry adapters (no auth: public reads). */
export interface RegistryOptions {
  fetch?: FetchLike;
}

const REVIEW_ONLY: ReadonlySet<Capability> = new Set<Capability>(['review_status']);

abstract class RegistryAdapter extends BaseStoreAdapter {
  readonly capabilities = REVIEW_ONLY;
  protected readonly http: HttpClient;
  constructor(opts: RegistryOptions) {
    super();
    this.http = new HttpClient(resolveFetch(opts.fetch), undefined, { accept: 'application/json' });
  }
  protected async getOrMissing<T>(url: string): Promise<T | undefined> {
    try {
      return await this.http.request<T>({ method: 'GET', url, auth: false });
    } catch (err) {
      if (err instanceof StoreApiError && err.status === 404) return undefined;
      throw err;
    }
  }
}

/** npm registry: live version = `dist-tags.<tag>`. */
export class NpmRegistryAdapter extends RegistryAdapter {
  readonly id: StoreId = 'npm';
  constructor(
    readonly packageName: string,
    opts: RegistryOptions & { distTag?: string; registry?: string } = {},
  ) {
    super(opts);
    if (!/^(@[a-z0-9][\w.-]*\/)?[a-z0-9][\w.-]*$/.test(packageName))
      throw new StoreValidationError(`invalid npm name: ${packageName}`);
    this.distTag = opts.distTag ?? 'latest';
    this.registry = (opts.registry ?? 'https://registry.npmjs.org').replace(/\/$/, '');
  }
  private readonly distTag: string;
  private readonly registry: string;

  override async getReviewStatus(): Promise<ReviewStatus> {
    const name = this.packageName.replace('/', '%2f');
    const doc = await this.getOrMissing<{ 'dist-tags'?: Record<string, string> }>(
      `${this.registry}/${name}`,
    );
    const version = doc?.['dist-tags']?.[this.distTag];
    return version
      ? { state: 'live', version }
      : { state: 'unknown', detail: doc ? `no dist-tag ${this.distTag}` : 'not published' };
  }
}

/** PyPI: live version = `info.version`. */
export class PypiRegistryAdapter extends RegistryAdapter {
  readonly id: StoreId = 'pypi';
  constructor(
    readonly projectName: string,
    opts: RegistryOptions = {},
  ) {
    super(opts);
    if (!/^[A-Za-z0-9]([A-Za-z0-9._-]*[A-Za-z0-9])?$/.test(projectName))
      throw new StoreValidationError(`invalid PyPI name: ${projectName}`);
  }

  override async getReviewStatus(): Promise<ReviewStatus> {
    const doc = await this.getOrMissing<{ info?: { version?: string } }>(
      `https://pypi.org/pypi/${encodeURIComponent(this.projectName)}/json`,
    );
    const version = doc?.info?.version;
    return version ? { state: 'live', version } : { state: 'unknown', detail: 'not published' };
  }
}

interface McpEntry {
  server?: { name?: string; version?: string };
  _meta?: Record<string, { status?: string; isLatest?: boolean } | undefined>;
}

const MCP_META = 'io.modelcontextprotocol.registry/official';

/** Official MCP registry: live version = the entry with `isLatest` for this server name. */
export class McpRegistryAdapter extends RegistryAdapter {
  readonly id: StoreId = 'mcp_registry';
  constructor(
    readonly serverName: string,
    opts: RegistryOptions = {},
  ) {
    super(opts);
    if (!/^[a-zA-Z0-9.-]+\/[a-zA-Z0-9._-]+$/.test(serverName))
      throw new StoreValidationError(`invalid MCP server name: ${serverName}`);
  }

  override async getReviewStatus(): Promise<ReviewStatus> {
    const url = `https://registry.modelcontextprotocol.io/v0/servers?search=${encodeURIComponent(this.serverName)}&limit=100`;
    const doc = await this.getOrMissing<{ servers?: McpEntry[] }>(url);
    const mine = (doc?.servers ?? []).filter((e) => e.server?.name === this.serverName);
    const latest = mine.find((e) => e._meta?.[MCP_META]?.isLatest) ?? mine[0];
    const version = latest?.server?.version;
    if (!version) return { state: 'unknown', detail: 'not published' };
    const status = latest._meta?.[MCP_META]?.status;
    return status && status !== 'active'
      ? { state: 'unknown', version, detail: status }
      : { state: 'live', version };
  }
}
