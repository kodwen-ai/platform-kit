import type { Capability, StoreId } from './types';

/** How a store authenticates automated publishing. */
export type StoreAuthModel =
  | 'google_oauth_wif'
  | 'azure_ad_client_credentials'
  | 'github_token'
  | 'trusted_publishing_oidc'
  | 'public_read'
  | 'oauth_client_credentials'
  | 'api_key'
  | 'pull_request'
  | 'personal_access_token';

/** Metadata about one store / registry. */
export interface StoreCatalogEntry {
  id: StoreId;
  name: string;
  capabilities: readonly Capability[];
  docsUrl: string;
  auth: StoreAuthModel;
  /** True when this package ships an adapter for it. */
  implemented: boolean;
}

/** Every store codai knows about; `implemented: false` entries have no adapter yet (metadata only). */
export const STORE_CATALOG: readonly StoreCatalogEntry[] = [
  {
    id: 'google_play',
    name: 'Google Play',
    capabilities: [
      'upload',
      'tracks',
      'staged_rollout',
      'halt',
      'resume',
      'complete',
      'listing',
      'localized_notes',
    ],
    docsUrl: 'https://developers.google.com/android-publisher/api-ref/rest/v3/edits',
    auth: 'google_oauth_wif',
    implemented: true,
  },
  {
    id: 'microsoft_store',
    name: 'Microsoft Store',
    capabilities: [
      'upload',
      'tracks',
      'staged_rollout',
      'halt',
      'complete',
      'localized_notes',
      'review_status',
    ],
    docsUrl:
      'https://learn.microsoft.com/windows/uwp/monetize/create-and-manage-submissions-using-windows-store-services',
    auth: 'azure_ad_client_credentials',
    implemented: true,
  },
  {
    id: 'firebase_app_distribution',
    name: 'Firebase App Distribution',
    capabilities: ['upload', 'tracks'],
    docsUrl: 'https://firebase.google.com/docs/reference/app-distribution/rest',
    auth: 'google_oauth_wif',
    implemented: true,
  },
  {
    id: 'github_releases',
    name: 'GitHub Releases',
    capabilities: ['upload', 'tracks', 'review_status'],
    docsUrl: 'https://docs.github.com/rest/releases/releases',
    auth: 'github_token',
    implemented: true,
  },
  {
    id: 'npm',
    name: 'npm',
    capabilities: ['review_status'],
    docsUrl: 'https://docs.npmjs.com/trusted-publishers',
    auth: 'trusted_publishing_oidc',
    implemented: true,
  },
  {
    id: 'pypi',
    name: 'PyPI',
    capabilities: ['review_status'],
    docsUrl: 'https://docs.pypi.org/trusted-publishers/',
    auth: 'trusted_publishing_oidc',
    implemented: true,
  },
  {
    id: 'mcp_registry',
    name: 'MCP Registry',
    capabilities: ['review_status'],
    docsUrl: 'https://github.com/modelcontextprotocol/registry',
    auth: 'trusted_publishing_oidc',
    implemented: true,
  },
  {
    id: 'huawei_appgallery',
    name: 'Huawei AppGallery',
    capabilities: [
      'upload',
      'tracks',
      'staged_rollout',
      'listing',
      'localized_notes',
      'review_status',
    ],
    docsUrl:
      'https://developer.huawei.com/consumer/en/doc/AppGallery-connect-References/agcapi-overview-0000001158365069',
    auth: 'oauth_client_credentials',
    implemented: false,
  },
  {
    id: 'samsung_galaxy_store',
    name: 'Samsung Galaxy Store',
    capabilities: ['upload', 'staged_rollout', 'review_status'],
    docsUrl: 'https://developer.samsung.com/galaxy-store/galaxy-store-developer-api.html',
    auth: 'oauth_client_credentials',
    implemented: false,
  },
  {
    id: 'amazon_appstore',
    name: 'Amazon Appstore',
    capabilities: ['upload', 'listing', 'localized_notes', 'review_status'],
    docsUrl: 'https://developer.amazon.com/docs/app-submission-api/overview.html',
    auth: 'oauth_client_credentials',
    implemented: false,
  },
  {
    id: 'winget',
    name: 'Windows Package Manager (winget)',
    capabilities: ['upload', 'review_status'],
    docsUrl: 'https://learn.microsoft.com/windows/package-manager/package/',
    auth: 'pull_request',
    implemented: false,
  },
  {
    id: 'chrome_web_store',
    name: 'Chrome Web Store',
    capabilities: ['upload', 'staged_rollout', 'review_status'],
    docsUrl: 'https://developer.chrome.com/docs/webstore/api',
    auth: 'google_oauth_wif',
    implemented: false,
  },
  {
    id: 'vscode_marketplace',
    name: 'Visual Studio Code Marketplace',
    capabilities: ['upload', 'review_status'],
    docsUrl: 'https://code.visualstudio.com/api/working-with-extensions/publishing-extension',
    auth: 'personal_access_token',
    implemented: false,
  },
];

/** Catalog entry for a store id (undefined when unknown). */
export function getStoreCatalogEntry(id: StoreId): StoreCatalogEntry | undefined {
  return STORE_CATALOG.find((e) => e.id === id);
}
