/**
 * M4 - company-figures redaction (Roles & Permissions, PRD 1, slice S01.16).
 *
 * Company-wide money - dashboard money tiles, chart amounts, revenue on the scoreboards, report totals - is shown only to a person who holds "See company figures"
 * (`canSeeCompanyFigures` in enforce.ts). Everything here runs on a payload an endpoint has already built, for a
 * person who does not hold it, and leaves the money out: the key is gone, never zero or null, so a screen cannot
 * mistake "hidden" for "nothing". Counts, rates, dates and the per-record prices of a record the person can open
 * are never touched.
 *
 * PRD 8 (call and agent revenue) builds on `canSeeCompanyFigures` and adds its own redaction beside these.
 */

type Json = Record<string, any>;

/** A copy of a list of rows with the named keys left off each row. */
const withoutKeys = (rows: Json[] | undefined, keys: string[]): Json[] | undefined =>
  rows?.map((row) => Object.fromEntries(Object.entries(row).filter(([k]) => !keys.includes(k))));

/** The Company figures tiles: the company's plan and mix, with no version of them that is the person's own. */
const COMPANY_FIGURE_TILES = ['kpi.recurring', 'revenue_by_job_type', 'smart_insights'];

/**
 * The dashboard answer for a person without See company figures (PRD 9). The endpoint already builds every money tile
 * over the person's own set ("Yours"), so this is the backstop and leaves that money alone: it takes out what is the
 * company's only - the Company figures tiles, the monthly revenue goal and its percentage, the revenue column on both
 * scoreboards and on lead sources. The key is gone, never zero. A price
 * on a record the person can open (an overdue invoice's amount) is not a company figure and stays.
 */
export function redactDashboardCompanyFigures<T extends Json>(answer: T): T {
  const out: Json = { ...answer };
  if (Array.isArray(answer.tiles)) {
    out.tiles = (answer.tiles as Json[]).filter((t) => !COMPANY_FIGURE_TILES.includes(String(t.id)));
  }
  if (answer.data && typeof answer.data === 'object') {
    const data: Json = Object.fromEntries(Object.entries(answer.data as Json).filter(([id]) => !COMPANY_FIGURE_TILES.includes(id)));
    if (data['kpi.revenue_mtd']) {
      const { target: _target, pct_of_goal: _pct, ...rest } = data['kpi.revenue_mtd'] as Json;
      data['kpi.revenue_mtd'] = rest;
    }
    if (data.revenue_chart) {
      const { target: _target, ...rest } = data.revenue_chart as Json;
      data.revenue_chart = rest;
    }
    // A tile whose loader failed holds an error marker, not a list: it has nothing to redact.
    for (const id of ['tech_scoreboard', 'dispatch_scoreboard', 'lead_sources']) {
      if (Array.isArray(data[id])) data[id] = withoutKeys(data[id] as Json[], ['revenue']);
    }
    out.data = data;
  }
  return out as T;
}

/** The revenue report is nothing but company-wide money, so a person without it gets an empty trend. */
export function redactRevenueReport<T extends Json>(_report: T): { series: never[] } {
  return { series: [] };
}

/** The window and the payment counts stay; every dollar sum goes. */
export function redactPaymentFeesReport<T extends Json>(report: T): Json {
  const MONEY = ['gross', 'charged', 'stripeFees', 'platformFees', 'net', 'serviceFees', 'tips'];
  return Object.fromEntries(Object.entries(report).filter(([k]) => !MONEY.includes(k)));
}

/** Every key the estimate-conversion report uses for a dollar total or an average ticket, at any depth. */
const CONVERSION_MONEY = [
  'value', 'totalValue', 'sentEverValue', 'sentValue', 'wonValue', 'lostValue', 'openValue', 'avgTicketWon', 'avgTicketLost',
];

function withoutConversionMoney(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(withoutConversionMoney);
  if (node && typeof node === 'object') {
    return Object.fromEntries(
      Object.entries(node as Json)
        .filter(([k]) => !CONVERSION_MONEY.includes(k))
        .map(([k, v]) => [k, withoutConversionMoney(v)]),
    );
  }
  return node;
}

/** Counts, rates and dates stay; the money totals and average tickets go. */
export function redactEstimateConversionReport<T extends Json>(report: T): Json {
  return withoutConversionMoney(report) as Json;
}

/**
 * The shared unpaid-invoices report keeps each customer's balances (they are the invoices themselves, and the
 * people it is open to need them to collect); the company-wide sales window and the days-sales-outstanding
 * figure built from it go.
 */
export function redactArAgingReport<T extends Json>(report: T): Json {
  const { dso: _dso, salesInWindow: _sales, ...rest } = report;
  return rest;
}

/**
 * The jobs report's margin and cost keys. `profit` is a margin word (and the cost columns beside it are costs), so
 * they follow See costs (`canSeeCosts`), not See company figures: a person without it gets each job's
 * prices (billed, paid, subtotal, tax, tip) and none of these.
 */
const JOBS_REPORT_COST_KEYS = ['profit', 'itemCost', 'laborCost', 'cardExpenses', 'techExpenses'];

/** A copy of the jobs report's rows with every margin and cost key left off. */
export function redactJobsReportCosts(rows: Json[]): Json[] {
  return withoutKeys(rows, JOBS_REPORT_COST_KEYS) ?? [];
}

/**
 * The activity report's per-person revenue touched (and last period's) sums company revenue over records the
 * person may not open, so it goes without See company figures. The action counts and breakdowns stay.
 */
export function redactActivityReportRevenue(users: Json[]): Json[] {
  return withoutKeys(users, ['revenueTouched', 'prevRevenueTouched']) ?? [];
}
