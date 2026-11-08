/**
 * Expenses report — pure, framework-free aggregation. Keep mirror-able to a
 * future backend service (see S1 estimate-conversion pattern). No imports.
 *
 * Two flavours of aggregation: the CALENDAR-fixed helpers (`profitSummary`,
 * `expenseKpis`, `spendByCategoryByMonth`) compute relative to `now`, and the
 * RANGE-driven variants (`periodProfitSummary`, `periodExpenseKpis`, …) compute
 * over an arbitrary [from, to] window so the report's time filter can drive the
 * whole page. The transaction table is driven by `filterExpenses` (date range +
 * category/cardholder/status/business-unit + free-text search).
 */

export const EXPENSE_CATEGORIES = [
  'Hardware', 'Materials', 'Gas', 'Parking', 'Software', 'Tools', 'Meals', 'General',
] as const;
export type ExpenseCategory = (typeof EXPENSE_CATEGORIES)[number];

export const BUSINESS_UNITS = ['Install', 'Service', 'Monitoring', 'Sales'] as const;
export type BusinessUnit = (typeof BUSINESS_UNITS)[number];

export const CARDHOLDERS = ['Efrain', 'Priya', 'Ohad', 'Emanuel', 'Adam', 'Shuli'] as const;
export type Cardholder = (typeof CARDHOLDERS)[number];

// Who logged the expense (Workiz "User"), distinct from whose card was used.
export const USERS = ['Emanuel Dahan', 'Ohad', 'Rami', 'Ben', 'Priya', 'Robert Bresnick', 'Yonatan', 'Logistics'] as const;
export type ExpenseUser = (typeof USERS)[number];

export const EXPENSE_STATUSES = ['Pending', 'Settled'] as const;
export type ExpenseStatus = (typeof EXPENSE_STATUSES)[number];

// Presence facets for the Workiz-style With / Without columns.
export const EXPENSE_ATTRIBUTES = ['Receipt', 'Description', 'Job'] as const;
export type ExpenseAttribute = (typeof EXPENSE_ATTRIBUTES)[number];

export interface ExpenseRow {
  id: string;
  date: Date;
  merchant: string;
  category: ExpenseCategory;
  amount: number;
  cardholder: string;
  loggedBy: string;
  businessUnit: string;
  jobNumber: string | null;
  description: string;
  hasReceipt: boolean;
  status: ExpenseStatus;
}

export interface ExpenseFilters {
  from: Date | null;
  to: Date | null;
  categories: string[];
  merchants: string[];
  cardholders: string[];
  users: string[];
  statuses: string[];
  businessUnits: string[];
  withAttrs: string[];    // rows must HAVE each of these (Receipt/Description/Job)
  withoutAttrs: string[]; // rows must LACK each of these
  search: string;
}

/** Whether a row has the given presence attribute (Receipt / Description / Job). */
export function hasAttribute(r: ExpenseRow, attr: string): boolean {
  switch (attr) {
    case 'Receipt': return r.hasReceipt;
    case 'Description': return r.description.trim() !== '';
    case 'Job': return r.jobNumber != null;
    default: return false;
  }
}

export function filterExpenses(rows: ExpenseRow[], f: ExpenseFilters): ExpenseRow[] {
  const q = f.search.trim().toLowerCase();
  return rows.filter((r) => {
    if (f.from && r.date < f.from) return false;
    if (f.to && r.date > f.to) return false;
    if (f.categories.length && !f.categories.includes(r.category)) return false;
    if (f.merchants.length && !f.merchants.includes(r.merchant)) return false;
    if (f.cardholders.length && !f.cardholders.includes(r.cardholder)) return false;
    if (f.users.length && !f.users.includes(r.loggedBy)) return false;
    if (f.statuses.length && !f.statuses.includes(r.status)) return false;
    if (f.businessUnits.length && !f.businessUnits.includes(r.businessUnit)) return false;
    if (f.withAttrs.some((a) => !hasAttribute(r, a))) return false;
    if (f.withoutAttrs.some((a) => hasAttribute(r, a))) return false;
    if (q) {
      const hay = `${r.merchant} ${r.description} ${r.jobNumber ?? ''} ${r.category} ${r.loggedBy}`.toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });
}

export interface ExpenseKpis {
  thisMonth: number;
  lastMonth: number;
  momDeltaPct: number | null;
  receiptsAttached: number;
  receiptsTotal: number;
  receiptsPct: number;
}

export function monthlyExpenseTotal(rows: ExpenseRow[], year: number, month: number): number {
  return rows.reduce(
    (sum, r) => (r.date.getFullYear() === year && r.date.getMonth() === month ? sum + r.amount : sum),
    0,
  );
}

const MONTH_LABEL = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export interface MonthlySpend {
  month: string;
  monthKey: string;
  [category: string]: number | string;
}

export function spendByCategoryByMonth(rows: ExpenseRow[], now: Date, monthsBack = 12): MonthlySpend[] {
  const buckets: MonthlySpend[] = [];
  const index = new Map<string, MonthlySpend>();
  for (let i = monthsBack - 1; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
    const bucket: MonthlySpend = { month: MONTH_LABEL[d.getMonth()]!, monthKey: key };
    for (const c of EXPENSE_CATEGORIES) bucket[c] = 0;
    buckets.push(bucket);
    index.set(key, bucket);
  }
  for (const r of rows) {
    const key = `${r.date.getFullYear()}-${String(r.date.getMonth() + 1).padStart(2, '0')}`;
    const bucket = index.get(key);
    if (bucket) bucket[r.category] = (bucket[r.category] as number) + r.amount;
  }
  return buckets;
}

export interface CategoryTotal {
  category: string;
  amount: number;
}

/**
 * All of one cardholder's spend, grouped by category, highest first. Only
 * categories the cardholder actually spent in are returned. Drives the
 * row-expansion drill-down chart.
 */
export function spendByCategoryForCardholder(rows: ExpenseRow[], cardholder: string): CategoryTotal[] {
  const totals = new Map<string, number>();
  for (const r of rows) {
    if (r.cardholder !== cardholder) continue;
    totals.set(r.category, (totals.get(r.category) ?? 0) + r.amount);
  }
  return [...totals.entries()]
    .map(([category, amount]) => ({ category, amount }))
    .sort((a, b) => b.amount - a.amount);
}

export function monthKeyOf(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

export interface ProfitSummary {
  revenue: number;
  expenses: number;
  net: number;
  margin: number; // 0..100
  revenueDeltaPct: number | null;
  expensesDeltaPct: number | null;
  netDeltaPct: number | null;
  marginDeltaPp: number | null;
}

const pctDelta = (cur: number, prev: number): number | null =>
  prev === 0 ? null : ((cur - prev) / prev) * 100;

export function profitSummary(
  rows: ExpenseRow[],
  monthlyRevenue: Record<string, number>,
  now: Date,
): ProfitSummary {
  const thisKey = monthKeyOf(now);
  const prevDate = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  const prevKey = monthKeyOf(prevDate);

  const revenue = monthlyRevenue[thisKey] ?? 0;
  const prevRevenue = monthlyRevenue[prevKey] ?? 0;
  const expenses = monthlyExpenseTotal(rows, now.getFullYear(), now.getMonth());
  const prevExpenses = monthlyExpenseTotal(rows, prevDate.getFullYear(), prevDate.getMonth());

  const net = revenue - expenses;
  const prevNet = prevRevenue - prevExpenses;
  const margin = revenue === 0 ? 0 : (net / revenue) * 100;
  const prevMargin = prevRevenue === 0 ? 0 : (prevNet / prevRevenue) * 100;

  return {
    revenue,
    expenses,
    net,
    margin,
    revenueDeltaPct: pctDelta(revenue, prevRevenue),
    expensesDeltaPct: pctDelta(expenses, prevExpenses),
    netDeltaPct: pctDelta(net, prevNet),
    marginDeltaPp: prevRevenue === 0 ? null : margin - prevMargin,
  };
}

export function expenseKpis(rows: ExpenseRow[], now: Date): ExpenseKpis {
  const y = now.getFullYear();
  const m = now.getMonth();
  const prev = new Date(y, m - 1, 1);
  const thisMonth = monthlyExpenseTotal(rows, y, m);
  const lastMonth = monthlyExpenseTotal(rows, prev.getFullYear(), prev.getMonth());
  const monthRows = rows.filter((r) => r.date.getFullYear() === y && r.date.getMonth() === m);
  const receiptsTotal = monthRows.length;
  const receiptsAttached = monthRows.filter((r) => r.hasReceipt).length;
  return {
    thisMonth,
    lastMonth,
    momDeltaPct: lastMonth === 0 ? null : ((thisMonth - lastMonth) / lastMonth) * 100,
    receiptsAttached,
    receiptsTotal,
    receiptsPct: receiptsTotal === 0 ? 0 : (receiptsAttached / receiptsTotal) * 100,
  };
}

// ── Range-driven variants ────────────────────────────────────────────────────
// The report's top-right time filter drives the WHOLE page (profit strip, KPI
// tiles, drill-downs, and the table). These mirror the calendar-fixed helpers
// above but operate over an arbitrary [from, to] window (a null bound = open-
// ended / all time) and compare against the immediately-preceding window of
// equal length for period-over-period deltas.

/** Inclusive membership test for an arbitrary, possibly open-ended window. */
/**
 * Inclusive [from, to] membership test; a null bound is open-ended.
 *
 * Deliberately NOT imported from `@/lib/date-range` (which holds the canonical
 * copy): this module is documented above as dependency-free so it stays
 * mirror-able to a future backend service. A four-line pure predicate is a
 * conscious trade for that portability.
 */
export function withinRange(d: Date, from: Date | null, to: Date | null): boolean {
  if (from && d < from) return false;
  if (to && d > to) return false;
  return true;
}

/**
 * The equal-length window immediately before [from, to], used for deltas. An
 * open-ended range (a null bound) has no comparable prior window, so both bounds
 * come back null and deltas resolve to null.
 */
export function previousPeriod(
  from: Date | null,
  to: Date | null,
): { from: Date | null; to: Date | null } {
  if (!from || !to) return { from: null, to: null };
  const len = to.getTime() - from.getTime();
  const prevTo = new Date(from.getTime() - 1);
  const prevFrom = new Date(prevTo.getTime() - len);
  return { from: prevFrom, to: prevTo };
}

/** Total expense amount within an arbitrary window. */
export function expenseTotalInRange(rows: ExpenseRow[], from: Date | null, to: Date | null): number {
  return rows.reduce((sum, r) => (withinRange(r.date, from, to) ? sum + r.amount : sum), 0);
}

/**
 * Revenue within an arbitrary window. Revenue is only known per calendar month,
 * so partial months are prorated by the fraction of their days the window
 * covers. An open-ended bound clamps to the month edge (i.e. counts full months).
 */
export function revenueInRange(
  monthlyRevenue: Record<string, number>,
  from: Date | null,
  to: Date | null,
): number {
  let total = 0;
  for (const key of Object.keys(monthlyRevenue)) {
    const [y, m] = key.split('-').map(Number);
    const monthStart = new Date(y!, m! - 1, 1, 0, 0, 0, 0);
    const monthEnd = new Date(y!, m!, 0, 23, 59, 59, 999);
    const lo = from && from > monthStart ? from : monthStart;
    const hi = to && to < monthEnd ? to : monthEnd;
    if (hi < lo) continue;
    const daysInMonth = monthEnd.getDate();
    const overlapDays = Math.floor((hi.getTime() - lo.getTime()) / 86_400_000) + 1;
    const frac = Math.min(1, overlapDays / daysInMonth);
    total += (monthlyRevenue[key] ?? 0) * frac;
  }
  return total;
}

/** Profit strip (revenue / expenses / net / margin + deltas) for an arbitrary window. */
export function periodProfitSummary(
  rows: ExpenseRow[],
  monthlyRevenue: Record<string, number>,
  from: Date | null,
  to: Date | null,
): ProfitSummary {
  const prev = previousPeriod(from, to);
  const hasPrev = prev.from != null && prev.to != null;

  const revenue = revenueInRange(monthlyRevenue, from, to);
  const expenses = expenseTotalInRange(rows, from, to);
  const prevRevenue = hasPrev ? revenueInRange(monthlyRevenue, prev.from, prev.to) : 0;
  const prevExpenses = hasPrev ? expenseTotalInRange(rows, prev.from, prev.to) : 0;

  const net = revenue - expenses;
  const prevNet = prevRevenue - prevExpenses;
  const margin = revenue === 0 ? 0 : (net / revenue) * 100;
  const prevMargin = prevRevenue === 0 ? 0 : (prevNet / prevRevenue) * 100;

  return {
    revenue,
    expenses,
    net,
    margin,
    revenueDeltaPct: hasPrev ? pctDelta(revenue, prevRevenue) : null,
    expensesDeltaPct: hasPrev ? pctDelta(expenses, prevExpenses) : null,
    netDeltaPct: hasPrev ? pctDelta(net, prevNet) : null,
    marginDeltaPp: hasPrev && prevRevenue !== 0 ? margin - prevMargin : null,
  };
}

export interface PeriodExpenseKpis {
  total: number;     // spend in the selected window
  prevTotal: number; // spend in the prior equal-length window
  deltaPct: number | null;
  receiptsAttached: number;
  receiptsTotal: number;
  receiptsPct: number;
}

/** Expense KPI tiles (period spend, prior-period spend, receipts) for an arbitrary window. */
export function periodExpenseKpis(rows: ExpenseRow[], from: Date | null, to: Date | null): PeriodExpenseKpis {
  const prev = previousPeriod(from, to);
  const hasPrev = prev.from != null && prev.to != null;
  const total = expenseTotalInRange(rows, from, to);
  const prevTotal = hasPrev ? expenseTotalInRange(rows, prev.from, prev.to) : 0;
  const periodRows = rows.filter((r) => withinRange(r.date, from, to));
  const receiptsTotal = periodRows.length;
  const receiptsAttached = periodRows.filter((r) => r.hasReceipt).length;
  return {
    total,
    prevTotal,
    deltaPct: hasPrev && prevTotal !== 0 ? ((total - prevTotal) / prevTotal) * 100 : null,
    receiptsAttached,
    receiptsTotal,
    receiptsPct: receiptsTotal === 0 ? 0 : (receiptsAttached / receiptsTotal) * 100,
  };
}
