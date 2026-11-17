/**
 * FOCUS 1.2 cost-and-usage row (subset codai consumes), decimals as strings, timestamps as ISO 8601 UTC.
 * Spec: https://focus.finops.org/focus-specification/v1-2/  Column library: https://focus.finops.org/docs/column-library/
 * Provider-specific columns go in `x` and serialise with the `x_` prefix the spec reserves for extensions.
 */
import { z } from 'zod';
import { isDecimalString } from './decimal';

/** Decimal stored as a string (never a float). */
export const DecimalString = z.string().refine(isDecimalString, 'expected a decimal string');
const NullableDecimal = DecimalString.nullable();
/** ISO 8601 UTC datetime. */
export const IsoDateTime = z.iso.datetime({ offset: false });

/** FOCUS ChargeCategory allowed values. */
export const CHARGE_CATEGORIES = ['Usage', 'Purchase', 'Tax', 'Credit', 'Adjustment'] as const;
/** FOCUS ChargeFrequency allowed values. */
export const CHARGE_FREQUENCIES = ['One-Time', 'Recurring', 'Usage-Based'] as const;
/** FOCUS ServiceCategory allowed values. */
export const SERVICE_CATEGORIES = [
  'AI and Machine Learning',
  'Analytics',
  'Business Applications',
  'Compute',
  'Databases',
  'Developer Tools',
  'Multicloud',
  'Identity',
  'Integration',
  'Internet of Things',
  'Management and Governance',
  'Media',
  'Migration',
  'Mobile',
  'Networking',
  'Security',
  'Storage',
  'Web',
  'Other',
] as const;

/** A FOCUS 1.2 row. Mandatory columns are non-null; conditional ones are nullable. */
export const FocusRowSchema = z.object({
  BilledCost: DecimalString,
  EffectiveCost: DecimalString,
  ListCost: DecimalString,
  ContractedCost: DecimalString,
  BillingAccountId: z.string().min(1),
  BillingAccountName: z.string().nullable(),
  BillingCurrency: z.string().regex(/^[A-Z]{3}$/),
  BillingPeriodStart: IsoDateTime,
  BillingPeriodEnd: IsoDateTime,
  ChargePeriodStart: IsoDateTime,
  ChargePeriodEnd: IsoDateTime,
  ChargeCategory: z.enum(CHARGE_CATEGORIES),
  ChargeClass: z.literal('Correction').nullable(),
  ChargeDescription: z.string().nullable(),
  ChargeFrequency: z.enum(CHARGE_FREQUENCIES).nullable(),
  ConsumedQuantity: NullableDecimal,
  ConsumedUnit: z.string().nullable(),
  PricingQuantity: NullableDecimal,
  PricingUnit: z.string().nullable(),
  ProviderName: z.string().min(1),
  PublisherName: z.string().min(1),
  InvoiceIssuerName: z.string().min(1),
  RegionId: z.string().nullable(),
  RegionName: z.string().nullable(),
  ResourceId: z.string().nullable(),
  ResourceName: z.string().nullable(),
  ResourceType: z.string().nullable(),
  ServiceCategory: z.enum(SERVICE_CATEGORIES),
  ServiceName: z.string().min(1),
  SubAccountId: z.string().nullable(),
  SubAccountName: z.string().nullable(),
  SkuId: z.string().nullable(),
  SkuPriceId: z.string().nullable(),
  Tags: z.record(z.string(), z.string()),
  /** Extension columns, written as `x_<key>` on export. */
  x: z.record(z.string().regex(/^[A-Za-z][A-Za-z0-9]*$/), z.union([z.string(), z.null()])),
});

/** A validated FOCUS 1.2 row. */
export type FocusRow = z.infer<typeof FocusRowSchema>;
/** FOCUS ChargeCategory. */
export type ChargeCategory = (typeof CHARGE_CATEGORIES)[number];
/** FOCUS ServiceCategory. */
export type ServiceCategory = (typeof SERVICE_CATEGORIES)[number];

/** Flatten a row to FOCUS column names (extensions become `x_<key>`). */
export function toFocusColumns(row: FocusRow): Record<string, unknown> {
  const { x, ...rest } = row;
  const out: Record<string, unknown> = { ...rest };
  for (const [k, v] of Object.entries(x)) out[`x_${k}`] = v;
  return out;
}

/** A half-open time range `[start, end)` in ISO 8601 UTC. */
export interface Period {
  start: string;
  end: string;
}

/** A source of FOCUS rows. */
export interface CostConnector {
  readonly id: string;
  /** Stream every row whose charge period starts in `[start, end)`. */
  fetchPeriod(period: Period): AsyncIterable<FocusRow>;
  /** Periods to (re)ingest now: providers restate, so the current and previous billing months. */
  periodsToReingest(now: Date): Period[];
}

/** UTC billing month containing `d` as `[first day, first day of next month)`. */
export function billingMonth(d: Date): Period {
  const start = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1));
  const end = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1));
  return { start: start.toISOString(), end: end.toISOString() };
}

/** Current and previous UTC billing months, oldest first. */
export function currentAndPreviousMonth(now: Date): Period[] {
  const prev = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
  return [billingMonth(prev), billingMonth(now)];
}

/** Validate a half-open period (`start < end`, both ISO UTC). */
export function assertPeriod(p: Period): void {
  IsoDateTime.parse(p.start);
  IsoDateTime.parse(p.end);
  if (!(Date.parse(p.start) < Date.parse(p.end)))
    throw new RangeError(`empty period ${p.start}..${p.end}`);
}
