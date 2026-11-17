import { fromMicros, toMicros } from './decimal';
import type { FocusRow } from './focus';

/** Money columns that can be summed. */
export type CostColumn = 'BilledCost' | 'EffectiveCost' | 'ListCost' | 'ContractedCost';
/** Columns usable as group keys. */
export type GroupKey = Exclude<keyof FocusRow, CostColumn | 'Tags' | 'x'>;

/** One group produced by `sumBy`. */
export interface SumGroup {
  key: Partial<Record<GroupKey, string | null>>;
  BilledCost: string;
  EffectiveCost: string;
  ListCost: string;
  ContractedCost: string;
  rows: number;
}

const COSTS: CostColumn[] = ['BilledCost', 'EffectiveCost', 'ListCost', 'ContractedCost'];

interface Bucket<K> {
  key: K;
  sums: bigint[];
  rows: number;
}

function groupSum<K>(rows: Iterable<FocusRow>, keyOf: (r: FocusRow) => K): Bucket<K>[] {
  const acc = new Map<string, Bucket<K>>();
  for (const row of rows) {
    const key = keyOf(row);
    const id = JSON.stringify(key);
    let g = acc.get(id);
    if (!g) {
      g = { key, sums: COSTS.map(() => 0n), rows: 0 };
      acc.set(id, g);
    }
    for (const [i, c] of COSTS.entries()) g.sums[i] = (g.sums[i] ?? 0n) + toMicros(row[c]);
    g.rows++;
  }
  return [...acc.values()];
}

/** Sum the four cost columns grouped by `keys`, exactly (bigint micro units, 6-decimal scale). */
export function sumBy(rows: Iterable<FocusRow>, keys: readonly GroupKey[]): SumGroup[] {
  const keyOf = (row: FocusRow) =>
    Object.fromEntries(
      keys.map((k) => [k, row[k] === null ? null : String(row[k])]),
    ) as SumGroup['key'];
  return groupSum(rows, keyOf).map((g) => ({
    key: g.key,
    BilledCost: fromMicros(g.sums[0] ?? 0n),
    EffectiveCost: fromMicros(g.sums[1] ?? 0n),
    ListCost: fromMicros(g.sums[2] ?? 0n),
    ContractedCost: fromMicros(g.sums[3] ?? 0n),
    rows: g.rows,
  }));
}

/** One monthly total. */
export interface MonthlyTotal {
  /** `YYYY-MM` of the billing period. */
  month: string;
  ServiceName: string;
  SubAccountId: string | null;
  BillingCurrency: string;
  BilledCost: string;
  EffectiveCost: string;
  rows: number;
}

/** Totals per billing month × ServiceName × SubAccountId × currency, sorted. Currencies are never mixed. */
export function monthlyTotals(rows: Iterable<FocusRow>): MonthlyTotal[] {
  const keyOf = (r: FocusRow) =>
    [r.BillingPeriodStart.slice(0, 7), r.ServiceName, r.SubAccountId, r.BillingCurrency] as const;
  const sortKey = (t: MonthlyTotal) =>
    [t.month, t.BillingCurrency, t.ServiceName, t.SubAccountId ?? ''].join('\u0000');
  return groupSum(rows, keyOf)
    .map(({ key: [month, ServiceName, SubAccountId, BillingCurrency], sums, rows: n }) => ({
      month,
      ServiceName,
      SubAccountId,
      BillingCurrency,
      BilledCost: fromMicros(sums[0] ?? 0n),
      EffectiveCost: fromMicros(sums[1] ?? 0n),
      rows: n,
    }))
    .sort((a, b) => (sortKey(a) < sortKey(b) ? -1 : sortKey(a) > sortKey(b) ? 1 : 0));
}
