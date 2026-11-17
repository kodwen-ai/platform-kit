# @codai/cost-connectors

Cloud and SaaS cost connectors that emit [FOCUS 1.2](https://focus.finops.org/focus-specification/v1-2/) rows. Money is always a decimal **string** and sums use bigint micro units (6 decimals), never floats.

- `FocusRowSchema` — Zod schema of the FOCUS columns codai uses, plus an `x` record exported as `x_*` extension columns.
- `createGcpConnector` — Cloud Billing standard BigQuery export (`gcp_billing_export_v1_<ACCOUNT>`); you supply the BigQuery runner. `EffectiveCost = cost + SUM(credits.amount)`.
- `createVercelConnector` — Vercel "List FOCUS billing charges" (JSONL, streamed).
- `sumBy`, `monthlyTotals` — exact aggregation, never mixing currencies.
- `periodsToReingest(now)` — current + previous billing month (providers restate costs).

## Install

```sh
pnpm add @codai/cost-connectors
```

## Usage

```ts
import { createGcpConnector, monthlyTotals } from '@codai/cost-connectors';
import { BigQuery } from '@google-cloud/bigquery';

const bq = new BigQuery();
const gcp = createGcpConnector({
  table: 'my-billing.billing.gcp_billing_export_v1_01ABCD_23EF45_6789AB',
  query: async (query, params) => (await bq.query({ query, params }))[0],
});
for (const period of gcp.periodsToReingest(new Date())) {
  const rows = [];
  for await (const row of gcp.fetchPeriod(period)) rows.push(row);
  console.table(monthlyTotals(rows));
}
```

```ts
import { createVercelConnector } from '@codai/cost-connectors';

const vercel = createVercelConnector({ token: process.env.VERCEL_TOKEN!, teamId: 'team_abc' });
for await (const row of vercel.fetchPeriod({
  start: '2026-10-01T00:00:00Z',
  end: '2026-11-01T00:00:00Z',
})) {
  // row.BilledCost is a string such as "12.34"
}
```

## Licence

Apache-2.0
