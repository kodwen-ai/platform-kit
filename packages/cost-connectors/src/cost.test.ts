import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { monthlyTotals, sumBy } from './aggregate';
import { addDecimals, fromMicros, toDecimalString, toMicros } from './decimal';
import {
  assertPeriod,
  currentAndPreviousMonth,
  type FocusRow,
  FocusRowSchema,
  toFocusColumns,
} from './focus';
import {
  buildGcpBillingExportQuery,
  createGcpConnector,
  type GcpExportRow,
  mapGcpRow,
  serviceCategoryForGcp,
} from './gcp';
import { createVercelConnector, mapVercelCharge, parseJsonl, VercelApiError } from './vercel';

const TABLE = 'codai-billing.billing_export.gcp_billing_export_v1_01ABCD_23EF45_6789AB';
const MAY = { start: '2026-05-01T00:00:00Z', end: '2026-06-01T00:00:00Z' };

const gcpRow: GcpExportRow = {
  billing_account_id: '01ABCD-23EF45-6789AB',
  service_id: '6F81-5844-456A',
  service_description: 'Cloud Run',
  sku_id: 'D1E9-1234',
  sku_description: 'CPU Allocation Time',
  project_id: 'example-project',
  project_name: 'codai inference',
  region: 'europe-west1',
  invoice_month: '202605',
  cost_type: 'regular',
  currency: 'EUR',
  usage_unit: 'seconds',
  labels_json: '[{"key":"service","value":"gateway"}]',
  day_start: '2026-05-03T00:00:00Z',
  cost: '12.3456789',
  list_cost: null,
  credits: '-2.1',
  usage_amount: '360000',
};

async function collect<T>(it: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const x of it) out.push(x);
  return out;
}

function streamOf(chunks: string[]): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  return new ReadableStream({
    start(c) {
      for (const ch of chunks) c.enqueue(enc.encode(ch));
      c.close();
    },
  });
}

describe('decimal', () => {
  it('parses, rounds half away from zero at 6 decimals and formats', () => {
    expect(toMicros('12.3456789')).toBe(12_345_679n);
    expect(toMicros('-0.0000005')).toBe(-1n);
    expect(fromMicros(1_500_000n)).toBe('1.5');
    expect(fromMicros(-1n)).toBe('-0.000001');
    expect(fromMicros(0n)).toBe('0');
    expect(addDecimals('0.1', '0.2')).toBe('0.3');
    expect(() => toMicros('1e3')).toThrow(RangeError);
  });

  it('expands exponent notation without floats', () => {
    expect(toDecimalString(1.2e-7)).toBe('0.00000012');
    expect(toDecimalString('3.5E+3')).toBe('3500');
    expect(toDecimalString('-0.00')).toBe('0');
    expect(toDecimalString(null)).toBeNull();
    expect(() => toDecimalString('abc')).toThrow(RangeError);
  });

  it('round-trips any micro amount', () => {
    fc.assert(
      fc.property(
        fc.bigInt({ min: -(10n ** 18n), max: 10n ** 18n }),
        (n) => toMicros(fromMicros(n)) === n,
      ),
    );
  });

  it('summing many 0.01 stays exact', () => {
    expect(addDecimals(...Array.from({ length: 1000 }, () => '0.01'))).toBe('10');
  });
});

describe('FOCUS schema + periods', () => {
  it('rejects float money and bad enums', () => {
    const row = mapGcpRow(gcpRow);
    expect(() => FocusRowSchema.parse({ ...row, BilledCost: 1.5 })).toThrow();
    expect(() => FocusRowSchema.parse({ ...row, ChargeCategory: 'Fee' })).toThrow();
    expect(() => FocusRowSchema.parse({ ...row, x: { 'bad key': 'v' } })).toThrow();
  });

  it('exports extension columns with the x_ prefix', () => {
    const cols = toFocusColumns(mapGcpRow(gcpRow));
    expect(cols.x_ServiceId).toBe('6F81-5844-456A');
    expect(cols.x).toBeUndefined();
  });

  it('reingests the previous and current billing month (UTC, across a year boundary)', () => {
    expect(currentAndPreviousMonth(new Date('2026-01-15T10:00:00Z'))).toEqual([
      { start: '2025-12-01T00:00:00.000Z', end: '2026-01-01T00:00:00.000Z' },
      { start: '2026-01-01T00:00:00.000Z', end: '2026-02-01T00:00:00.000Z' },
    ]);
    expect(() => assertPeriod({ start: MAY.end, end: MAY.start })).toThrow(RangeError);
  });
});

describe('GCP billing export', () => {
  it('builds a parameterised query over the standard export with credits summed', () => {
    const q = buildGcpBillingExportQuery({ table: TABLE }, MAY);
    expect(q.params).toEqual({ start: MAY.start, end: MAY.end });
    expect(q.sql).toContain(`FROM \`${TABLE}\``);
    expect(q.sql).toContain('FROM UNNEST(credits) AS c');
    expect(q.sql).toContain(
      'usage_start_time >= TIMESTAMP(@start) AND usage_start_time < TIMESTAMP(@end)',
    );
    expect(q.sql).not.toContain('cost_at_list');
    expect(buildGcpBillingExportQuery({ table: TABLE, hasCostAtList: true }, MAY).sql).toContain(
      'cost_at_list',
    );
    expect(() => buildGcpBillingExportQuery({ table: 'x.y.z; DROP' }, MAY)).toThrow(RangeError);
  });

  it('maps a row: EffectiveCost = cost + credits, project -> SubAccount, cost_type -> ChargeCategory', () => {
    const r = mapGcpRow(gcpRow, 'codai');
    expect(r).toMatchObject({
      BilledCost: '10.2456789',
      EffectiveCost: '10.2456789',
      ContractedCost: '12.3456789',
      ListCost: '12.3456789',
      BillingAccountName: 'codai',
      BillingCurrency: 'EUR',
      BillingPeriodStart: '2026-05-01T00:00:00Z',
      BillingPeriodEnd: '2026-06-01T00:00:00Z',
      ChargePeriodStart: '2026-05-03T00:00:00Z',
      ChargePeriodEnd: '2026-05-04T00:00:00Z',
      ChargeCategory: 'Usage',
      ChargeFrequency: 'Usage-Based',
      ConsumedQuantity: '360000',
      ServiceCategory: 'Compute',
      SubAccountId: 'example-project',
      Tags: { service: 'gateway' },
      x: { Credits: '-2.1', CostType: 'regular', ServiceId: '6F81-5844-456A' },
    });
    const tax = mapGcpRow({ ...gcpRow, cost_type: 'tax', credits: null, usage_amount: null });
    expect(tax).toMatchObject({
      ChargeCategory: 'Tax',
      ConsumedQuantity: null,
      ChargeFrequency: null,
      EffectiveCost: '12.3456789',
    });
    expect(mapGcpRow({ ...gcpRow, cost_type: 'adjustment' }).ChargeClass).toBe('Correction');
    expect(serviceCategoryForGcp('Vertex AI')).toBe('AI and Machine Learning');
    expect(serviceCategoryForGcp(null)).toBe('Other');
  });

  it('connector runs the injected query and yields FOCUS rows', async () => {
    const seen: string[] = [];
    const c = createGcpConnector({
      table: TABLE,
      query: async (sql, params) => {
        seen.push(params.start ?? '', sql.slice(0, 6));
        return [gcpRow, { ...gcpRow, day_start: '2026-05-04T00:00:00Z' }];
      },
    });
    const rows = await collect(c.fetchPeriod(MAY));
    expect(rows).toHaveLength(2);
    expect(seen).toEqual([MAY.start, 'SELECT']);
    expect(c.periodsToReingest(new Date('2026-05-10T00:00:00Z'))).toHaveLength(2);
  });
});

const vercelLines = [
  {
    BilledCost: 20,
    EffectiveCost: 18.5,
    BillingCurrency: 'USD',
    ChargeCategory: 'Usage',
    ChargePeriodStart: '2026-05-02T00:00:00.000Z',
    ChargePeriodEnd: '2026-05-03T00:00:00.000Z',
    ConsumedQuantity: 1.2e-7,
    ConsumedUnit: 'GB',
    PricingCategory: 'Standard',
    PricingQuantity: 1,
    PricingUnit: 'GB',
    ServiceCategory: 'Networking',
    ServiceName: 'Fast Data Transfer',
    ServiceProviderName: 'Vercel',
    SkuId: 'fdt',
    Tags: { ProjectId: 'prj_1', ProjectName: 'web' },
  },
  {
    BilledCost: '0.1',
    EffectiveCost: '0.1',
    BillingCurrency: 'USD',
    ChargeCategory: 'Purchase',
    ChargePeriodStart: '2026-05-02T00:00:00Z',
    ChargePeriodEnd: '2026-05-03T00:00:00Z',
    ServiceCategory: 'Something New',
    ServiceName: 'Pro seat',
    Tags: null,
  },
];

describe('Vercel FOCUS charges', () => {
  it('parses JSONL across chunk boundaries', async () => {
    const out = await collect(
      parseJsonl<{ a: number }>(streamOf(['{"a":1}\n{"a"', ':2}\n\n{"a":3}'])),
    );
    expect(out).toEqual([{ a: 1 }, { a: 2 }, { a: 3 }]);
  });

  it('GETs /v1/billing/charges with bearer + teamId and maps rows', async () => {
    const calls: { url: string; auth: string | undefined }[] = [];
    const body = vercelLines.map((l) => JSON.stringify(l)).join('\n');
    const c = createVercelConnector({
      token: async () => 'vtok',
      teamId: 'team_123',
      teamName: 'codai',
      fetch: async (url, init) => {
        calls.push({ url, auth: (init?.headers as Record<string, string>).authorization });
        return new Response(streamOf([body.slice(0, 50), body.slice(50)]));
      },
    });
    const rows = await collect(c.fetchPeriod(MAY));
    expect(calls).toEqual([
      {
        url: 'https://api.vercel.com/v1/billing/charges?from=2026-05-01T00%3A00%3A00Z&to=2026-06-01T00%3A00%3A00Z&teamId=team_123',
        auth: 'Bearer vtok',
      },
    ]);
    expect(rows[0]).toMatchObject({
      BilledCost: '20',
      EffectiveCost: '18.5',
      ListCost: '20',
      ConsumedQuantity: '0.00000012',
      BillingAccountId: 'team_123',
      ChargePeriodStart: '2026-05-02T00:00:00Z',
      SubAccountId: 'prj_1',
      SubAccountName: 'web',
      ServiceCategory: 'Networking',
      x: { PricingCategory: 'Standard', ServiceProviderName: 'Vercel' },
    });
    expect(rows[1]).toMatchObject({
      ChargeCategory: 'Purchase',
      ServiceCategory: 'Other',
      SubAccountId: null,
      Tags: {},
    });
  });

  it('throws VercelApiError on non-2xx', async () => {
    const c = createVercelConnector({
      token: 't',
      teamId: 'team',
      fetch: async () => new Response('nope', { status: 403 }),
    });
    await expect(collect(c.fetchPeriod(MAY))).rejects.toBeInstanceOf(VercelApiError);
  });

  it('maps unknown charge categories to Adjustment', () => {
    const first = vercelLines[0];
    if (!first) throw new Error('fixture');
    expect(
      mapVercelCharge({ ...first, ChargeCategory: 'Weird' }, { teamId: 't' }).ChargeCategory,
    ).toBe('Adjustment');
  });
});

describe('aggregation', () => {
  const base = mapGcpRow(gcpRow);
  const rows: FocusRow[] = [
    base,
    { ...base, BilledCost: '0.000001', EffectiveCost: '0.000001' },
    { ...base, ServiceName: 'BigQuery', BilledCost: '1', EffectiveCost: '1' },
    { ...base, BillingCurrency: 'USD', BilledCost: '5', EffectiveCost: '5' },
    { ...base, BillingPeriodStart: '2026-04-01T00:00:00Z', BilledCost: '2', EffectiveCost: '2' },
  ];

  it('sumBy is exact and groups by the given keys', () => {
    const g = sumBy(rows.slice(0, 3), ['ServiceName']);
    expect(g).toEqual([
      {
        key: { ServiceName: 'Cloud Run' },
        BilledCost: '10.24568',
        EffectiveCost: '10.24568',
        ListCost: '24.691358',
        ContractedCost: '24.691358',
        rows: 2,
      },
      {
        key: { ServiceName: 'BigQuery' },
        BilledCost: '1',
        EffectiveCost: '1',
        ListCost: '12.345679',
        ContractedCost: '12.345679',
        rows: 1,
      },
    ]);
  });

  it('monthlyTotals never mixes currencies and sorts by month', () => {
    const t = monthlyTotals(rows);
    expect(
      t.map((x) => `${x.month}|${x.BillingCurrency}|${x.ServiceName}|${x.BilledCost}`),
    ).toEqual([
      '2026-04|EUR|Cloud Run|2',
      '2026-05|EUR|BigQuery|1',
      '2026-05|EUR|Cloud Run|10.24568',
      '2026-05|USD|Cloud Run|5',
    ]);
  });

  it('total is order-independent', () => {
    fc.assert(
      fc.property(
        fc.shuffledSubarray(rows, { minLength: rows.length, maxLength: rows.length }),
        (shuffled) => {
          const a = sumBy(shuffled, ['BillingCurrency'])
            .map((g) => `${g.key.BillingCurrency}=${g.BilledCost}`)
            .sort();
          const b = sumBy(rows, ['BillingCurrency'])
            .map((g) => `${g.key.BillingCurrency}=${g.BilledCost}`)
            .sort();
          expect(a).toEqual(b);
        },
      ),
    );
  });
});
