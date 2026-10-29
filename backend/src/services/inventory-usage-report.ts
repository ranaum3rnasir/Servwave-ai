// Inventory usage report (catalog: Operations / "Inventory Usage") — pure
// aggregation over consume StockMovements, no Prisma/Express so it unit-tests
// with fixtures (activity-report doctrine).
//
// The controller fetches consume movements for the window, normalizes Prisma
// Decimals to numbers at the boundary, and hands the rows here. Grouping key is
// item_id when present, else `sku:<item_sku>` — SetNull-orphaned and SKU-only
// legacy rows still report (name/sku come from the movement snapshots).
//
// HONEST NUMBERS: cost is Σ qty×unit_cost over rows that CARRY a unit_cost
// snapshot; qty of unpriced rows accumulates in unpricedUnits instead — cost is
// never fabricated. Returns/adjusts are NOT netted here (they stay visible in
// the Action log); this report is Σ consume only (plan D17 / QA-703 tie-out).

/** One consume movement, normalized from the Prisma row by the controller. */
export interface UsageMovementRow {
  type: string;
  occurredAt: Date;
  itemId: string | null;
  itemSku: string;
  itemName: string;
  qty: number;
  unitCost: number | null;
  jobId: string | null;
  jobNumber: string | null;
  invoiceId: string | null;
  invoiceNumber: string | null;
}

export interface UsageReportRow {
  itemId: string | null;
  sku: string;
  name: string;
  /** Σ consumed qty, 2-dp rounded (fractional Decimal ledger). */
  units: number;
  movementCount: number;
  /** Σ qty×unit_cost over PRICED rows only, 2-dp. Stripped for non-canSeePricing viewers. */
  cost: number;
  /** Σ qty of rows with a null unit_cost snapshot — the honesty marker. */
  unpricedUnits: number;
  /** Distinct drill-through refs off the movements themselves. */
  jobs: { id: string; jobNumber: string }[];
  invoices: { id: string; invoiceNumber: string }[];
}

export interface InventoryUsageReport {
  from: string;
  to: string;
  items: UsageReportRow[];
}

/** Float-drift guard — same 2-dp rounding as setQuantity's delta math. */
const round2 = (x: number): number => Math.round(x * 100) / 100;

interface Accumulator {
  itemId: string | null;
  sku: string;
  name: string;
  units: number;
  movementCount: number;
  cost: number;
  unpricedUnits: number;
  jobs: Map<string, string>;
  invoices: Map<string, string>;
}

export function buildInventoryUsageReport(
  rows: UsageMovementRow[],
  range: { from: Date; to: Date },
): InventoryUsageReport {
  const groups = new Map<string, Accumulator>();

  for (const row of rows) {
    if (row.type !== 'consume') continue; // defensive: the report is Σ consume only
    if (row.occurredAt < range.from || row.occurredAt > range.to) continue; // range clip

    const key = row.itemId ?? `sku:${row.itemSku}`;
    let g = groups.get(key);
    if (!g) {
      g = {
        itemId: row.itemId,
        sku: row.itemSku,
        name: row.itemName,
        units: 0,
        movementCount: 0,
        cost: 0,
        unpricedUnits: 0,
        jobs: new Map(),
        invoices: new Map(),
      };
      groups.set(key, g);
    }

    g.units += row.qty;
    g.movementCount += 1;
    if (row.unitCost != null) {
      g.cost += row.qty * row.unitCost;
    } else {
      g.unpricedUnits += row.qty;
    }
    if (row.jobId) g.jobs.set(row.jobId, row.jobNumber ?? '');
    if (row.invoiceId) g.invoices.set(row.invoiceId, row.invoiceNumber ?? '');
  }

  const items: UsageReportRow[] = [...groups.values()]
    .map((g) => ({
      itemId: g.itemId,
      sku: g.sku,
      name: g.name,
      units: round2(g.units),
      movementCount: g.movementCount,
      cost: round2(g.cost),
      unpricedUnits: round2(g.unpricedUnits),
      jobs: [...g.jobs.entries()].map(([id, jobNumber]) => ({ id, jobNumber })),
      invoices: [...g.invoices.entries()].map(([id, invoiceNumber]) => ({ id, invoiceNumber })),
    }))
    .sort((a, b) => b.units - a.units);

  return { from: range.from.toISOString(), to: range.to.toISOString(), items };
}
