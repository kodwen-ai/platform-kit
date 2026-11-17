/**
 * Vercel connector over "List FOCUS billing charges" (FOCUS v1.3 JSONL, streamed).
 * Docs: https://vercel.com/docs/rest-api/billing/list-focus-billing-charges
 * GET https://api.vercel.com/v1/billing/charges?from&to[&teamId]  (from inclusive, to exclusive, ISO UTC, max 1 year)
 *
 * Vercel does not report list/contracted cost: ListCost = ContractedCost = BilledCost.
 * SubAccount = Vercel project (from Tags.ProjectId / Tags.ProjectName).
 */
import { toDecimalString } from './decimal';
import {
  assertPeriod,
  CHARGE_CATEGORIES,
  type ChargeCategory,
  currentAndPreviousMonth,
  type CostConnector,
  type FocusRow,
  FocusRowSchema,
  SERVICE_CATEGORIES,
  type ServiceCategory,
} from './focus';

/** Minimal fetch signature (inject a fake in tests). */
export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

/** One Vercel FOCUS 1.3 charge line (fields we read). */
export interface VercelCharge {
  BilledCost: number | string;
  EffectiveCost: number | string;
  BillingCurrency: string;
  ChargeCategory: string;
  ChargePeriodStart: string;
  ChargePeriodEnd: string;
  ConsumedQuantity?: number | string | null;
  ConsumedUnit?: string | null;
  PricingCategory?: string;
  PricingQuantity?: number | string | null;
  PricingUnit?: string | null;
  RegionId?: string | null;
  RegionName?: string | null;
  ServiceCategory?: string;
  ServiceName: string;
  ServiceProviderName?: string;
  SkuId?: string | null;
  Tags?: Record<string, string> | string | null;
}

/** Thrown on a non-2xx Vercel response. */
export class VercelApiError extends Error {
  override readonly name = 'VercelApiError';
  constructor(
    readonly status: number,
    body: string,
  ) {
    super(`Vercel billing API HTTP ${status}: ${body.slice(0, 300)}`);
  }
}

/** Options of the Vercel connector. */
export interface VercelConnectorOptions {
  token: string | (() => Promise<string>);
  teamId: string;
  teamName?: string;
  fetch?: FetchLike;
  baseUrl?: string;
}

function iso(s: string): string {
  return new Date(s).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

function tagsOf(t: VercelCharge['Tags']): Record<string, string> {
  if (!t) return {};
  if (typeof t === 'string') return { value: t };
  return Object.fromEntries(Object.entries(t).map(([k, v]) => [k, String(v)]));
}

/** Map one Vercel charge line to a validated FOCUS 1.2 row. */
export function mapVercelCharge(
  c: VercelCharge,
  account: { teamId: string; teamName?: string },
): FocusRow {
  const billed = toDecimalString(c.BilledCost) ?? '0';
  const start = iso(c.ChargePeriodStart);
  const d = new Date(start);
  const bpStart = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1)).toISOString();
  const bpEnd = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1)).toISOString();
  const tags = tagsOf(c.Tags);
  const category = (CHARGE_CATEGORIES as readonly string[]).includes(c.ChargeCategory)
    ? (c.ChargeCategory as ChargeCategory)
    : 'Adjustment';
  const service = (SERVICE_CATEGORIES as readonly string[]).includes(c.ServiceCategory ?? '')
    ? (c.ServiceCategory as ServiceCategory)
    : 'Other';
  const provider = c.ServiceProviderName || 'Vercel';
  return FocusRowSchema.parse({
    BilledCost: billed,
    EffectiveCost: toDecimalString(c.EffectiveCost) ?? billed,
    ListCost: billed,
    ContractedCost: billed,
    BillingAccountId: account.teamId,
    BillingAccountName: account.teamName ?? null,
    BillingCurrency: c.BillingCurrency,
    BillingPeriodStart: iso(bpStart),
    BillingPeriodEnd: iso(bpEnd),
    ChargePeriodStart: start,
    ChargePeriodEnd: iso(c.ChargePeriodEnd),
    ChargeCategory: category,
    ChargeClass: null,
    ChargeDescription: c.SkuId ? `${c.ServiceName} (${c.SkuId})` : c.ServiceName,
    ChargeFrequency: category === 'Usage' ? 'Usage-Based' : null,
    ConsumedQuantity: toDecimalString(c.ConsumedQuantity),
    ConsumedUnit: c.ConsumedUnit ?? null,
    PricingQuantity: toDecimalString(c.PricingQuantity),
    PricingUnit: c.PricingUnit ?? null,
    ProviderName: provider,
    PublisherName: provider,
    InvoiceIssuerName: 'Vercel',
    RegionId: c.RegionId ?? null,
    RegionName: c.RegionName ?? null,
    ResourceId: null,
    ResourceName: null,
    ResourceType: null,
    ServiceCategory: service,
    ServiceName: c.ServiceName,
    SubAccountId: tags.ProjectId ?? null,
    SubAccountName: tags.ProjectName ?? null,
    SkuId: c.SkuId ?? null,
    SkuPriceId: null,
    Tags: tags,
    x: {
      PricingCategory: c.PricingCategory ?? null,
      ServiceProviderName: c.ServiceProviderName ?? null,
    },
  });
}

/** Parse a JSONL byte stream into objects, one per non-empty line (handles lines split across chunks). */
export async function* parseJsonl<T>(stream: ReadableStream<Uint8Array>): AsyncGenerator<T> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  try {
    for (;;) {
      const { done, value } = await reader.read();
      buf += done ? decoder.decode() : decoder.decode(value, { stream: true });
      let nl = buf.indexOf('\n');
      while (nl >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (line) yield JSON.parse(line) as T;
        nl = buf.indexOf('\n');
      }
      if (done) break;
    }
    const last = buf.trim();
    if (last) yield JSON.parse(last) as T;
  } finally {
    reader.releaseLock();
  }
}

/** Create the Vercel FOCUS billing connector. */
export function createVercelConnector(opts: VercelConnectorOptions): CostConnector {
  const doFetch: FetchLike = opts.fetch ?? ((u, i) => globalThis.fetch(u, i));
  const base = (opts.baseUrl ?? 'https://api.vercel.com').replace(/\/$/, '');
  const getToken = typeof opts.token === 'string' ? async () => opts.token as string : opts.token;
  return {
    id: 'vercel',
    periodsToReingest: currentAndPreviousMonth,
    async *fetchPeriod(period) {
      assertPeriod(period);
      const q = new URLSearchParams({ from: period.start, to: period.end, teamId: opts.teamId });
      const res = await doFetch(`${base}/v1/billing/charges?${q.toString()}`, {
        headers: { authorization: `Bearer ${await getToken()}`, accept: 'application/jsonl' },
      });
      if (!res.ok) throw new VercelApiError(res.status, await res.text());
      if (!res.body) return;
      for await (const c of parseJsonl<VercelCharge>(res.body)) yield mapVercelCharge(c, opts);
    },
  };
}
