/**
 * Pure, framework-free logic for the S1 "Estimate / Quote Conversion" report.
 *
 * Everything here operates on plain normalized rows (no Prisma, no Express) so it
 * is fully unit-testable and can be ported verbatim to the frontend sample-data
 * path. The controller (report.controller.ts) is responsible for fetching +
 * tenant-scoping estimates and handing normalized rows to these functions.
 *
 * Conventions (documented + surfaced in the UI):
 *  - Date anchor selects which timestamp a row is filtered/grouped by:
 *      created → created_at, sent → sent_at, decided → COALESCE(approved, declined).
 *    Rows with no date for the active anchor are excluded from anchored metrics.
 *  - Conversion models (Archived AND Expired are excluded from both denominators):
 *      decided → Won / (Won + Lost)
 *      sent    → Won / (Won + Lost + Open)
 *    Won = WON, Lost = DECLINED, Open = SENT + PENDING.
 *  - Aging buckets (open quotes, by days since sent_at): 0–7 / 8–14 / 15–30 / 30+.
 */

import { ESTIMATE_STATUS } from '../constants/estimateStatus';

export type DateAnchor = 'created' | 'sent' | 'decided';
export type ConversionModel = 'decided' | 'sent';

export type EstimateStatusKey =
  | 'DRAFT' | 'SENT' | 'PENDING' | 'WON' | 'DECLINED' | 'EXPIRED' | 'ARCHIVED';

/** A flattened estimate row — the single shape both backend and frontend compute on. */
export interface NormalizedRow {
  id: string;
  number: string;
  customerName: string;
  repId: string | null;
  repName: string;
  source: string | null;
  jobType: string | null;
  amount: number;
  status: EstimateStatusKey;
  createdAt: Date;
  sentAt: Date | null;
  decidedAt: Date | null;
  lastActivityAt: Date | null;
  leadCreatedAt: Date | null;
  lostReason: string | null;
}

export interface ReportFilters {
  anchor: DateAnchor;
  from: Date;
  to: Date;
  repId: string;   // user id or 'all'
  source: string;  // source or 'all'
  jobType: string; // job type or 'all'
  model: ConversionModel;
}

export interface Bucket { count: number; value: number }
export type StatusBuckets = Record<EstimateStatusKey, Bucket>;

export const AGING_BUCKETS = [
  { key: '0-7', label: '0–7 days' },
  { key: '8-14', label: '8–14 days' },
  { key: '15-30', label: '15–30 days' },
  { key: '30+', label: '30+ days' },
] as const;
export type AgingBucketKey = (typeof AGING_BUCKETS)[number]['key'];

// ── Status categorization ────────────────────────────────────────────────────
export const isWon = (s: EstimateStatusKey) => s === ESTIMATE_STATUS.WON;
export const isLost = (s: EstimateStatusKey) => s === 'DECLINED';
export const isOpen = (s: EstimateStatusKey) => s === 'SENT' || s === 'PENDING';

// ── Date helpers ─────────────────────────────────────────────────────────────
export function anchorDate(row: NormalizedRow, anchor: DateAnchor): Date | null {
  if (anchor === 'created') return row.createdAt ?? null;
  if (anchor === 'sent') return row.sentAt ?? null;
  return row.decidedAt ?? null; // 'decided'
}

export function inRange(date: Date, from: Date, to: Date): boolean {
  const t = date.getTime();
  return t >= from.getTime() && t <= to.getTime();
}

const DAY_MS = 86_400_000;
const daysBetween = (later: Date, earlier: Date) =>
  Math.floor((later.getTime() - earlier.getTime()) / DAY_MS);

/** Filter rows by the active anchor/range + rep/source/job-type. Single source of truth. */
export function filterRows(rows: NormalizedRow[], f: ReportFilters): NormalizedRow[] {
  return rows.filter((r) => {
    const d = anchorDate(r, f.anchor);
    if (!d || !inRange(d, f.from, f.to)) return false;
    if (f.repId !== 'all' && r.repId !== f.repId) return false;
    if (f.source !== 'all' && r.source !== f.source) return false;
    if (f.jobType !== 'all' && r.jobType !== f.jobType) return false;
    return true;
  });
}

export function emptyBuckets(): StatusBuckets {
  return {
    DRAFT: { count: 0, value: 0 },
    SENT: { count: 0, value: 0 },
    PENDING: { count: 0, value: 0 },
    WON: { count: 0, value: 0 },
    DECLINED: { count: 0, value: 0 },
    EXPIRED: { count: 0, value: 0 },
    ARCHIVED: { count: 0, value: 0 },
  };
}

export function computeBuckets(rows: NormalizedRow[]): StatusBuckets {
  const b = emptyBuckets();
  for (const r of rows) {
    b[r.status].count += 1;
    b[r.status].value += r.amount;
  }
  return b;
}

/** Conversion rate (0–100). Archived + Expired are never in the denominator. */
export function computeConversion(
  buckets: StatusBuckets,
  model: ConversionModel,
): { rate: number; num: number; denom: number } {
  const won = buckets.WON.count;
  const lost = buckets.DECLINED.count;
  const open = buckets.SENT.count + buckets.PENDING.count;
  const denom = model === 'decided' ? won + lost : won + lost + open;
  const rate = denom > 0 ? Math.round((won / denom) * 100) : 0;
  return { rate, num: won, denom };
}

export function median(nums: number[]): number | null {
  if (nums.length === 0) return null;
  const sorted = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1]! + sorted[mid]!) / 2 : sorted[mid]!;
}

const mean = (nums: number[]): number | null =>
  nums.length === 0 ? null : nums.reduce((s, n) => s + n, 0) / nums.length;

export interface ContextMetrics {
  avgTicketWon: number | null;
  avgTicketLost: number | null;
  medianDaysToDecision: number | null;
  medianHoursRequestToSent: number | null;
}

export function computeContext(rows: NormalizedRow[]): ContextMetrics {
  const wonAmounts = rows.filter((r) => isWon(r.status)).map((r) => r.amount);
  const lostAmounts = rows.filter((r) => isLost(r.status)).map((r) => r.amount);

  const daysToDecision = rows
    .filter((r) => (isWon(r.status) || isLost(r.status)) && r.sentAt && r.decidedAt)
    .map((r) => daysBetween(r.decidedAt!, r.sentAt!))
    .filter((n) => n >= 0);

  const hoursRequestToSent = rows
    .filter((r) => r.sentAt && r.leadCreatedAt)
    .map((r) => (r.sentAt!.getTime() - r.leadCreatedAt!.getTime()) / 3_600_000)
    .filter((n) => n >= 0);

  return {
    avgTicketWon: mean(wonAmounts),
    avgTicketLost: mean(lostAmounts),
    medianDaysToDecision: median(daysToDecision),
    medianHoursRequestToSent: median(hoursRequestToSent) === null
      ? null
      : Math.round(median(hoursRequestToSent)!),
  };
}

export interface RepRow {
  repId: string | null;
  repName: string;
  sentCount: number;
  sentValue: number;
  wonCount: number;
  wonValue: number;
  lostValue: number;
  openValue: number;
  conversionPct: number;
  avgTicketWon: number | null;
}

/** Per-rep aggregation. "sent" here means rows that were genuinely sent (have sent_at). */
export function computeByRep(rows: NormalizedRow[], model: ConversionModel): RepRow[] {
  const map = new Map<string, NormalizedRow[]>();
  for (const r of rows) {
    const key = r.repId ?? '__unassigned__';
    (map.get(key) ?? map.set(key, []).get(key)!).push(r);
  }
  const out: RepRow[] = [];
  for (const [, group] of map) {
    const buckets = computeBuckets(group);
    const { rate } = computeConversion(buckets, model);
    const sentRows = group.filter((r) => r.sentAt != null);
    const wonRows = group.filter((r) => isWon(r.status));
    out.push({
      repId: group[0]!.repId,
      repName: group[0]!.repName,
      sentCount: sentRows.length,
      sentValue: sentRows.reduce((s, r) => s + r.amount, 0),
      wonCount: wonRows.length,
      wonValue: wonRows.reduce((s, r) => s + r.amount, 0),
      lostValue: group.filter((r) => isLost(r.status)).reduce((s, r) => s + r.amount, 0),
      openValue: group.filter((r) => isOpen(r.status)).reduce((s, r) => s + r.amount, 0),
      conversionPct: rate,
      avgTicketWon: mean(wonRows.map((r) => r.amount)),
    });
  }
  return out.sort((a, b) => b.wonValue - a.wonValue);
}

export interface MonthRow {
  month: string;      // 'yyyy-MM'
  label: string;      // 'MMM'
  sentValue: number;  // quoted $ that left draft
  wonValue: number;
  conversionPct: number;
  partial: boolean;   // current calendar month relative to `now`
}

const MONTH_LABELS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

export function computeByMonth(
  rows: NormalizedRow[],
  anchor: DateAnchor,
  now: Date,
  model: ConversionModel,
): MonthRow[] {
  const groups = new Map<string, NormalizedRow[]>();
  for (const r of rows) {
    const d = anchorDate(r, anchor);
    if (!d) continue;
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
    (groups.get(key) ?? groups.set(key, []).get(key)!).push(r);
  }
  const currentKey = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
  return [...groups.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, group]) => {
      const buckets = computeBuckets(group);
      const { rate } = computeConversion(buckets, model);
      const sentRows = group.filter((r) => r.sentAt != null);
      return {
        month: key,
        label: MONTH_LABELS[Number(key.slice(5)) - 1]!,
        sentValue: sentRows.reduce((s, r) => s + r.amount, 0),
        wonValue: group.filter((r) => isWon(r.status)).reduce((s, r) => s + r.amount, 0),
        conversionPct: rate,
        partial: key === currentKey,
      };
    });
}

/** Days since sent_at → aging bucket. Open = SENT|PENDING with a non-null sent_at. */
export function agingBucketOf(days: number): AgingBucketKey {
  if (days <= 7) return '0-7';
  if (days <= 14) return '8-14';
  if (days <= 30) return '15-30';
  return '30+';
}

export function bucketAging(
  rows: NormalizedRow[],
  asOf: Date,
): Record<AgingBucketKey, Bucket> {
  const out: Record<AgingBucketKey, Bucket> = {
    '0-7': { count: 0, value: 0 },
    '8-14': { count: 0, value: 0 },
    '15-30': { count: 0, value: 0 },
    '30+': { count: 0, value: 0 },
  };
  for (const r of rows) {
    if (!isOpen(r.status) || !r.sentAt) continue;
    const bucket = agingBucketOf(daysBetween(asOf, r.sentAt));
    out[bucket].count += 1;
    out[bucket].value += r.amount;
  }
  return out;
}

// ── Drill-down selection ─────────────────────────────────────────────────────
export type Outcome = 'won' | 'lost' | 'open';
export interface DrillSelector {
  status?: EstimateStatusKey;
  outcome?: Outcome;
  agingBucket?: AgingBucketKey;
  repId?: string;
  month?: string; // 'yyyy-MM' (by active anchor)
}

export function selectDrillRows(
  rows: NormalizedRow[],
  drill: DrillSelector,
  anchor: DateAnchor,
  asOf: Date,
): NormalizedRow[] {
  return rows.filter((r) => {
    if (drill.status && r.status !== drill.status) return false;
    if (drill.outcome === 'won' && !isWon(r.status)) return false;
    if (drill.outcome === 'lost' && !isLost(r.status)) return false;
    if (drill.outcome === 'open' && !isOpen(r.status)) return false;
    if (drill.repId !== undefined && (r.repId ?? '__unassigned__') !== drill.repId) return false;
    if (drill.agingBucket) {
      if (!isOpen(r.status) || !r.sentAt) return false;
      if (agingBucketOf(daysBetween(asOf, r.sentAt)) !== drill.agingBucket) return false;
    }
    if (drill.month) {
      const d = anchorDate(r, anchor);
      if (!d) return false;
      const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
      if (key !== drill.month) return false;
    }
    return true;
  });
}

export interface DrillRowDto {
  id: string;
  number: string;
  customerName: string;
  repName: string;
  amount: number;
  status: EstimateStatusKey;
  sentAt: string | null;
  decidedAt: string | null;
  daysOpen: number | null;
  lastActivityAt: string | null;
}

export function toDrillDto(r: NormalizedRow, asOf: Date): DrillRowDto {
  return {
    id: r.id,
    number: r.number,
    customerName: r.customerName,
    repName: r.repName,
    amount: r.amount,
    status: r.status,
    sentAt: r.sentAt ? r.sentAt.toISOString() : null,
    decidedAt: r.decidedAt ? r.decidedAt.toISOString() : null,
    daysOpen: r.sentAt && isOpen(r.status) ? daysBetween(asOf, r.sentAt) : null,
    lastActivityAt: r.lastActivityAt ? r.lastActivityAt.toISOString() : null,
  };
}

// ── Top-level report assembly ────────────────────────────────────────────────
export interface FilterOptions {
  reps: { id: string; name: string }[];
  sources: string[];
  jobTypes: string[];
}

export interface ReportSummary {
  buckets: StatusBuckets;
  totalCount: number;
  totalValue: number;
  sentEverCount: number;   // rows with a non-null sent_at ("Total sent")
  sentEverValue: number;
  won: Bucket;
  lost: Bucket;
  open: Bucket;
  conversion: { rate: number; num: number; denom: number };
}

export function summarize(rows: NormalizedRow[], model: ConversionModel): ReportSummary {
  const buckets = computeBuckets(rows);
  const sentRows = rows.filter((r) => r.sentAt != null);
  return {
    buckets,
    totalCount: rows.length,
    totalValue: rows.reduce((s, r) => s + r.amount, 0),
    sentEverCount: sentRows.length,
    sentEverValue: sentRows.reduce((s, r) => s + r.amount, 0),
    won: { count: buckets.WON.count, value: buckets.WON.value },
    lost: { count: buckets.DECLINED.count, value: buckets.DECLINED.value },
    open: {
      count: buckets.SENT.count + buckets.PENDING.count,
      value: buckets.SENT.value + buckets.PENDING.value,
    },
    conversion: computeConversion(buckets, model),
  };
}

export function computeOptions(allRows: NormalizedRow[]): FilterOptions {
  const reps = new Map<string, string>();
  const sources = new Set<string>();
  const jobTypes = new Set<string>();
  for (const r of allRows) {
    if (r.repId) reps.set(r.repId, r.repName);
    if (r.source) sources.add(r.source);
    if (r.jobType) jobTypes.add(r.jobType);
  }
  return {
    reps: [...reps.entries()].map(([id, name]) => ({ id, name })).sort((a, b) => a.name.localeCompare(b.name)),
    sources: [...sources].sort(),
    jobTypes: [...jobTypes].sort(),
  };
}

export interface ReportPayload {
  filters: { anchor: DateAnchor; from: string; to: string; repId: string; source: string; jobType: string; model: ConversionModel };
  summary: ReportSummary;
  prior: ReportSummary;
  context: ContextMetrics;
  priorContext: ContextMetrics;
  byRep: RepRow[];
  byMonth: MonthRow[];
  aging: Record<AgingBucketKey, Bucket>;
  options: FilterOptions;
}

/** Previous equal-length period immediately preceding [from, to]. */
export function priorPeriod(from: Date, to: Date): { from: Date; to: Date } {
  const len = to.getTime() - from.getTime();
  return { from: new Date(from.getTime() - len), to: new Date(from.getTime()) };
}

/** Assemble the full report payload from already-normalized org rows. */
export function buildReport(allRows: NormalizedRow[], f: ReportFilters, now: Date): ReportPayload {
  const current = filterRows(allRows, f);
  const pp = priorPeriod(f.from, f.to);
  const prior = filterRows(allRows, { ...f, from: pp.from, to: pp.to });

  return {
    filters: {
      anchor: f.anchor, from: f.from.toISOString(), to: f.to.toISOString(),
      repId: f.repId, source: f.source, jobType: f.jobType, model: f.model,
    },
    summary: summarize(current, f.model),
    prior: summarize(prior, f.model),
    context: computeContext(current),
    priorContext: computeContext(prior),
    byRep: computeByRep(current, f.model),
    byMonth: computeByMonth(current, f.anchor, now, f.model),
    aging: bucketAging(current, now),
    options: computeOptions(allRows),
  };
}
