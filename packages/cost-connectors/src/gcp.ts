/**
 * GCP connector over the Cloud Billing STANDARD usage cost export in BigQuery
 * (`<project>.<dataset>.gcp_billing_export_v1_<BILLING_ACCOUNT_ID>`).
 * Schema: https://cloud.google.com/billing/docs/how-to/export-data-bigquery-tables/standard-usage
 *
 * The host runs BigQuery; this module only builds the SQL and maps rows. Money is cast to NUMERIC and
 * returned as STRING by the query, so no float ever reaches the mapper.
 * Mapping (follows Google's FOCUS view): EffectiveCost = BilledCost = cost + SUM(credits.amount);
 * ContractedCost = cost; ListCost = cost_at_list when the export has it, else cost.
 */
import { addDecimals, toDecimalString } from './decimal';
import {
  assertPeriod,
  type ChargeCategory,
  currentAndPreviousMonth,
  type CostConnector,
  type FocusRow,
  FocusRowSchema,
  type Period,
  type ServiceCategory,
} from './focus';

/** Options of `buildGcpBillingExportQuery`. */
export interface GcpQueryOptions {
  /** Fully qualified table: `project.dataset.gcp_billing_export_v1_XXXXXX_XXXXXX_XXXXXX`. */
  table: string;
  /** The export has the `cost_at_list` column (newer exports). */
  hasCostAtList?: boolean;
}

/** SQL + named parameters for one period. */
export interface GcpQuery {
  sql: string;
  params: { start: string; end: string };
}

const TABLE_RE =
  /^[a-z][a-z0-9-]{4,61}[a-z0-9]\.[A-Za-z0-9_]{1,1024}\.gcp_billing_export_v1_[0-9A-F]{6}_[0-9A-F]{6}_[0-9A-F]{6}$/;

/** Build the aggregated (per day) SQL over the standard billing export for `[start, end)` of usage_start_time. */
export function buildGcpBillingExportQuery(opts: GcpQueryOptions, period: Period): GcpQuery {
  if (!TABLE_RE.test(opts.table))
    throw new RangeError(`not a standard billing export table: ${opts.table}`);
  assertPeriod(period);
  const list = opts.hasCostAtList ? 'CAST(cost_at_list AS NUMERIC)' : 'CAST(cost AS NUMERIC)';
  const sql = `SELECT
  billing_account_id,
  service.id AS service_id,
  service.description AS service_description,
  sku.id AS sku_id,
  sku.description AS sku_description,
  project.id AS project_id,
  project.name AS project_name,
  location.region AS region,
  invoice.month AS invoice_month,
  cost_type,
  currency,
  usage.unit AS usage_unit,
  TO_JSON_STRING(labels) AS labels_json,
  FORMAT_TIMESTAMP('%Y-%m-%dT%H:%M:%SZ', TIMESTAMP_TRUNC(usage_start_time, DAY)) AS day_start,
  CAST(SUM(CAST(cost AS NUMERIC)) AS STRING) AS cost,
  CAST(SUM(${list}) AS STRING) AS list_cost,
  CAST(SUM((SELECT IFNULL(SUM(CAST(c.amount AS NUMERIC)), 0) FROM UNNEST(credits) AS c)) AS STRING) AS credits,
  CAST(SUM(CAST(usage.amount AS NUMERIC)) AS STRING) AS usage_amount
FROM \`${opts.table}\`
WHERE usage_start_time >= TIMESTAMP(@start) AND usage_start_time < TIMESTAMP(@end)
GROUP BY billing_account_id, service_id, service_description, sku_id, sku_description, project_id, project_name,
  region, invoice_month, cost_type, currency, usage_unit, labels_json, day_start
ORDER BY day_start, service_description, sku_id`;
  return { sql, params: { start: period.start, end: period.end } };
}

/** One row as returned by the query above. */
export interface GcpExportRow {
  billing_account_id: string;
  service_id: string | null;
  service_description: string | null;
  sku_id: string | null;
  sku_description: string | null;
  project_id: string | null;
  project_name: string | null;
  region: string | null;
  invoice_month: string | null;
  cost_type: string | null;
  currency: string;
  usage_unit: string | null;
  labels_json: string | null;
  day_start: string;
  cost: string | number;
  list_cost: string | number | null;
  credits: string | number | null;
  usage_amount: string | number | null;
}

const COST_TYPE: Record<string, ChargeCategory> = {
  regular: 'Usage',
  tax: 'Tax',
  adjustment: 'Adjustment',
  rounding_error: 'Adjustment',
};

/** FOCUS ChargeCategory for a GCP `cost_type`. */
export function chargeCategoryForCostType(costType: string | null): ChargeCategory {
  return COST_TYPE[costType ?? 'regular'] ?? 'Usage';
}

const SERVICE_CATEGORY: [RegExp, ServiceCategory][] = [
  [
    /vertex|ai platform|gemini|generative|speech|translation|vision|natural language|document ai|dialogflow/i,
    'AI and Machine Learning',
  ],
  [/bigquery|dataflow|dataproc|pub\/sub|looker|composer/i, 'Analytics'],
  [/sql|spanner|firestore|bigtable|memorystore|alloydb|datastore/i, 'Databases'],
  [/storage|filestore|backup/i, 'Storage'],
  [/networking|load balanc|cdn|dns|vpc|interconnect|nat|armor/i, 'Networking'],
  [/kms|secret manager|security|identity|iam|recaptcha/i, 'Security'],
  [/compute|cloud run|kubernetes|functions|app engine|batch|gpu/i, 'Compute'],
  [/artifact registry|cloud build|source repositories|deploy/i, 'Developer Tools'],
  [/logging|monitoring|trace|scheduler|tasks/i, 'Management and Governance'],
];

/** Heuristic FOCUS ServiceCategory for a GCP service description. */
export function serviceCategoryForGcp(description: string | null): ServiceCategory {
  for (const [re, cat] of SERVICE_CATEGORY) if (description && re.test(description)) return cat;
  return 'Other';
}

function billingPeriod(invoiceMonth: string | null, fallbackIso: string): Period {
  const m = invoiceMonth ? /^(\d{4})(\d{2})$/.exec(invoiceMonth) : null;
  const y = m ? Number(m[1]) : new Date(fallbackIso).getUTCFullYear();
  const mo = m ? Number(m[2]) - 1 : new Date(fallbackIso).getUTCMonth();
  return {
    start: new Date(Date.UTC(y, mo, 1)).toISOString(),
    end: new Date(Date.UTC(y, mo + 1, 1)).toISOString(),
  };
}

function parseLabels(json: string | null): Record<string, string> {
  if (!json) return {};
  const arr = JSON.parse(json) as { key?: string; value?: string }[] | null;
  const out: Record<string, string> = {};
  for (const l of arr ?? []) if (l.key) out[l.key] = l.value ?? '';
  return out;
}

function iso(s: string): string {
  return new Date(s).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

/** Map one aggregated export row to a validated FOCUS row. */
export function mapGcpRow(row: GcpExportRow, billingAccountName: string | null = null): FocusRow {
  const cost = toDecimalString(row.cost) ?? '0';
  const credits = toDecimalString(row.credits) ?? '0';
  const effective = addDecimals(cost, credits);
  const start = iso(row.day_start);
  const end = iso(new Date(Date.parse(start) + 86_400_000).toISOString());
  const bp = billingPeriod(row.invoice_month, start);
  const category = chargeCategoryForCostType(row.cost_type);
  const quantity = toDecimalString(row.usage_amount);
  return FocusRowSchema.parse({
    BilledCost: effective,
    EffectiveCost: effective,
    ListCost: toDecimalString(row.list_cost) ?? cost,
    ContractedCost: cost,
    BillingAccountId: row.billing_account_id,
    BillingAccountName: billingAccountName,
    BillingCurrency: row.currency,
    BillingPeriodStart: iso(bp.start),
    BillingPeriodEnd: iso(bp.end),
    ChargePeriodStart: start,
    ChargePeriodEnd: end,
    ChargeCategory: category,
    ChargeClass: row.cost_type === 'adjustment' ? 'Correction' : null,
    ChargeDescription: row.sku_description,
    ChargeFrequency: category === 'Usage' ? 'Usage-Based' : null,
    ConsumedQuantity: category === 'Usage' ? quantity : null,
    ConsumedUnit: category === 'Usage' ? row.usage_unit : null,
    PricingQuantity: quantity,
    PricingUnit: row.usage_unit,
    ProviderName: 'Google Cloud',
    PublisherName: 'Google Cloud',
    InvoiceIssuerName: 'Google Cloud',
    RegionId: row.region,
    RegionName: row.region,
    ResourceId: null,
    ResourceName: null,
    ResourceType: null,
    ServiceCategory: serviceCategoryForGcp(row.service_description),
    ServiceName: row.service_description ?? 'Unknown',
    SubAccountId: row.project_id,
    SubAccountName: row.project_name,
    SkuId: row.sku_id,
    SkuPriceId: null,
    Tags: parseLabels(row.labels_json),
    x: { ServiceId: row.service_id, CostType: row.cost_type, Credits: credits },
  });
}

/** Host-provided BigQuery runner. */
export type BigQueryRunner = (
  sql: string,
  params: Record<string, string>,
) => Promise<readonly GcpExportRow[]> | AsyncIterable<GcpExportRow>;

/** Options of the GCP connector. */
export interface GcpConnectorOptions extends GcpQueryOptions {
  query: BigQueryRunner;
  billingAccountName?: string;
}

/** Create the GCP billing-export connector. */
export function createGcpConnector(opts: GcpConnectorOptions): CostConnector {
  return {
    id: 'gcp',
    periodsToReingest: currentAndPreviousMonth,
    async *fetchPeriod(period) {
      const q = buildGcpBillingExportQuery(opts, period);
      const rows = await opts.query(q.sql, q.params);
      for await (const r of rows) yield mapGcpRow(r, opts.billingAccountName ?? null);
    },
  };
}
