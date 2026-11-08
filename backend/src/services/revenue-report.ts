// Revenue — Completed vs Invoiced vs Collected (catalog F2) — pure aggregation,
// no Prisma/Express so it unit-tests with fixtures and shares the series shape
// with the frontend (see frontend/src/pages/reports/revenue-data.ts).
//
// Three independent money streams, each bucketed into the same calendar months:
//   • completed — Job.amount_invoiced, by Job.completed_at
//   • invoiced  — Invoice.total_amount, by invoice date (sent_at ?? created_at)
//   • collected — Payment.amount, by Payment.paid_at
//
// The streams never reconcile to one number (that's the report's whole point), so
// the service keeps them as parallel inputs and only aligns them on the month axis.
//
// NOTE: there is NO business-unit dimension in the schema — the mock's "BU split"
// is fabricated. This service deliberately produces NO BU breakdown; real orgs
// render the series without it (the BU control lives only in the demo mock branch).

/** One dated money event the controller normalizes from a Prisma row. */
export interface RevenueEvent {
  /** When the money event happened. Rows with a null date are dropped. */
  date: Date | null;
  /** The dollar amount (already `Number(...)`-coerced from Decimal). */
  amount: number;
}

export interface RevenueInputs {
  completed: RevenueEvent[];
  invoiced: RevenueEvent[];
  collected: RevenueEvent[];
}

/** One month of the trend, aligned across all three streams. */
export interface RevenueSeriesPoint {
  /** Sort/identity key, e.g. "2026-05". */
  month: string;
  /** Display label, e.g. "May 26". */
  label: string;
  completed: number;
  invoiced: number;
  collected: number;
}

export interface RevenueReport {
  series: RevenueSeriesPoint[];
  totals: {
    completed: number;
    invoiced: number;
    collected: number;
    /** collected / invoiced as a percentage (0 when nothing invoiced). */
    collectionRate: number;
    /** invoiced − collected. */
    outstanding: number;
  };
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** Month key "YYYY-MM" in UTC so bucketing is timezone-stable. */
function monthKey(d: Date): string {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  return `${y}-${m}`;
}

/** Display label "Mon YY" from a "YYYY-MM" key. */
function monthLabel(key: string): string {
  const [y, m] = key.split('-');
  return `${MONTHS[Number(m) - 1]} ${y.slice(2)}`;
}

/** All month keys from `start`..`end` inclusive, chronological. */
function monthRange(startKey: string, endKey: string): string[] {
  const [sy, sm] = startKey.split('-').map(Number);
  const [ey, em] = endKey.split('-').map(Number);
  const keys: string[] = [];
  let y = sy;
  let m = sm;
  while (y < ey || (y === ey && m <= em)) {
    keys.push(`${y}-${String(m).padStart(2, '0')}`);
    m += 1;
    if (m > 12) {
      m = 1;
      y += 1;
    }
  }
  return keys;
}

/** Sum each stream into its month bucket. Null-dated events are skipped. */
function bucketByMonth(events: RevenueEvent[]): Map<string, number> {
  const byMonth = new Map<string, number>();
  for (const e of events) {
    if (!e.date) continue;
    const key = monthKey(e.date);
    byMonth.set(key, (byMonth.get(key) ?? 0) + e.amount);
  }
  return byMonth;
}

/**
 * Build the monthly completed/invoiced/collected trend.
 *
 * The month axis spans the earliest to the latest month seen across ALL three
 * streams, with gap months filled at zero so the chart's x-axis is contiguous.
 * An empty input (no events anywhere) yields an empty series and zeroed totals.
 */
export function buildRevenueReport(inputs: RevenueInputs): RevenueReport {
  const completedByMonth = bucketByMonth(inputs.completed);
  const invoicedByMonth = bucketByMonth(inputs.invoiced);
  const collectedByMonth = bucketByMonth(inputs.collected);

  const allKeys = [
    ...completedByMonth.keys(),
    ...invoicedByMonth.keys(),
    ...collectedByMonth.keys(),
  ];

  let series: RevenueSeriesPoint[] = [];
  if (allKeys.length > 0) {
    const sorted = [...allKeys].sort();
    const keys = monthRange(sorted[0], sorted[sorted.length - 1]);
    series = keys.map((key) => ({
      month: key,
      label: monthLabel(key),
      completed: completedByMonth.get(key) ?? 0,
      invoiced: invoicedByMonth.get(key) ?? 0,
      collected: collectedByMonth.get(key) ?? 0,
    }));
  }

  const completed = series.reduce((s, p) => s + p.completed, 0);
  const invoiced = series.reduce((s, p) => s + p.invoiced, 0);
  const collected = series.reduce((s, p) => s + p.collected, 0);

  return {
    series,
    totals: {
      completed,
      invoiced,
      collected,
      collectionRate: invoiced ? (collected / invoiced) * 100 : 0,
      outstanding: invoiced - collected,
    },
  };
}
