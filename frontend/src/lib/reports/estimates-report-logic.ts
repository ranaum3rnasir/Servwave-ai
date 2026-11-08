/** Raw estimate status enum (mirrors Prisma EstimateStatus). */
export type RawStatus = 'DRAFT' | 'SENT' | 'PENDING' | 'WON' | 'DECLINED' | 'EXPIRED' | 'ARCHIVED';

/** Workiz-style status buckets (mutually exclusive; sum to "all"). */
export type StatusBucket = 'unsent' | 'pending' | 'approved' | 'won' | 'declined' | 'archived';
export type StatusKey = 'all' | StatusBucket;

export interface EstimateRow {
  id: string;
  number: string;
  customer: string;
  rep: string;          // estimate creator (created_by display name)
  createdAt: string;    // ISO date
  amount: number;
  depositDue: number;
  status: RawStatus;
  hasJob: boolean;      // WON + linked job ⇒ "won"
}

export interface ListFilters {
  status: StatusKey;
  rep: string | null;
  search: string;
  /** ISO date (yyyy-mm-dd) lower bound on createdAt; null/omitted = all time. */
  dateFrom?: string | null;
}

/**
 * Map one estimate to its mutually-exclusive Workiz bucket.
 *
 * These buckets are a REPORTING taxonomy, not the status enum: `approved` vs `won` splits on
 * whether the accepted estimate has become a job yet, which no single enum value expresses.
 *
 * D6 (2026-07-21): PENDING buckets as `approved`, not `pending`. PENDING means the customer has
 * already approved and signed and only the deposit is outstanding — grouping it with SENT would
 * count an accepted deal as still-awaiting-an-answer in every pipeline figure on the page.
 */
export function bucketStatus(e: EstimateRow): StatusBucket {
  switch (e.status) {
    case 'DRAFT': return 'unsent';
    case 'SENT': return 'pending';
    case 'PENDING': return 'approved';
    case 'WON': return e.hasJob ? 'won' : 'approved';
    case 'DECLINED': return 'declined';
    case 'EXPIRED':
    case 'ARCHIVED': return 'archived';
  }
}

/** Display label per status bucket (shared by the list, status column, and detail panel). */
export const BUCKET_LABEL: Record<StatusBucket, string> = {
  unsent: 'Unsent',
  // `pending` is SENT only — the sole status still awaiting a customer answer. Labelled for what
  // it means rather than after the bucket key, which no longer matches the PENDING enum value.
  pending: 'Awaiting Response',
  // Accepted by the customer but not yet a job: PENDING (deposit outstanding) or WON with no
  // linked job.
  approved: 'Approved',
  won: 'Won',
  declined: 'Declined',
  archived: 'Archived',
};

export interface CountWorth { count: number; worth: number }
export type StatusCounts = Record<StatusKey, CountWorth>;

/** Count + total $ worth per bucket, plus the "all" total. */
export function statusCounts(rows: EstimateRow[]): StatusCounts {
  const empty = (): CountWorth => ({ count: 0, worth: 0 });
  const out: StatusCounts = {
    all: empty(), unsent: empty(), pending: empty(), approved: empty(),
    won: empty(), declined: empty(), archived: empty(),
  };
  for (const e of rows) {
    const b = bucketStatus(e);
    out[b].count += 1; out[b].worth += e.amount;
    out.all.count += 1; out.all.worth += e.amount;
  }
  return out;
}

/** Apply status bucket + rep + search + date filters to the rows. */
export function filterEstimates(rows: EstimateRow[], f: ListFilters): EstimateRow[] {
  const q = f.search.trim().toLowerCase();
  return rows.filter((e) => {
    if (f.status !== 'all' && bucketStatus(e) !== f.status) return false;
    if (f.rep && e.rep !== f.rep) return false;
    if (f.dateFrom && e.createdAt < f.dateFrom) return false;
    if (q && !`${e.number} ${e.customer}`.toLowerCase().includes(q)) return false;
    return true;
  });
}

export interface Kpis { revenue: number; winRate: number; avgDeal: number; topRep: string }

/**
 * Headline analytics over a set of rows (won = revenue basis).
 *
 * The revenue basis is the raw WON status, NOT the `won` bucket. The bucket additionally requires
 * a linked job, so bucketing here would silently drop every won-but-not-yet-scheduled estimate
 * out of revenue, winRate, avgDeal and topRep — understating the sales result because of an
 * operations follow-up that has nothing to do with whether the deal was won.
 */
export function computeKpis(rows: EstimateRow[]): Kpis {
  const won = rows.filter((e) => e.status === 'WON');
  const declined = rows.filter((e) => bucketStatus(e) === 'declined');
  const revenue = won.reduce((a, e) => a + e.amount, 0);
  const decided = won.length + declined.length;
  const winRate = decided === 0 ? 0 : Math.round((won.length / decided) * 100);
  const avgDeal = won.length === 0 ? 0 : Math.round(revenue / won.length);
  const byRep = new Map<string, number>();
  for (const e of won) byRep.set(e.rep, (byRep.get(e.rep) ?? 0) + e.amount);
  let topRep = '—'; let best = -1;
  for (const [rep, dollars] of byRep) if (dollars > best) { best = dollars; topRep = rep; }
  return { revenue, winRate, avgDeal, topRep };
}

export interface RepStat {
  rep: string;
  revenue: number;     // won $
  openDollars: number; // pending $
  winRate: number;
  avgDeal: number;
  rank: number;
}

/** Per-rep aggregation, ranked by revenue desc. */
export function repBreakdown(rows: EstimateRow[]): RepStat[] {
  const reps = [...new Set(rows.map((e) => e.rep))];
  const stats = reps.map((rep) => {
    const mine = rows.filter((e) => e.rep === rep);
    const k = computeKpis(mine);
    const openDollars = mine.filter((e) => bucketStatus(e) === 'pending').reduce((a, e) => a + e.amount, 0);
    return { rep, revenue: k.revenue, openDollars, winRate: k.winRate, avgDeal: k.avgDeal, rank: 0 };
  });
  return stats.sort((a, b) => b.revenue - a.revenue).map((s, i) => ({ ...s, rank: i + 1 }));
}

/** Weekly trend → one numeric series per rep, keyed W1..W8. */
export function weeklyTrend(breakdown: Array<{ rep: string; weekly: number[] }>): Array<{ week: string; [rep: string]: number | string }> {
  return Array.from({ length: 8 }, (_, i) => {
    const obj: { week: string; [rep: string]: number | string } = { week: `W${i + 1}` };
    for (const r of breakdown) obj[r.rep] = r.weekly[i] ?? 0;
    return obj;
  });
}
