// "Estimates" report (catalog slug `estimates`) — pure normalization, no Prisma
// or Express so it unit-tests with fixtures and shares its row shape with the
// frontend.
//
// The frontend owns ALL aggregation (status buckets, KPIs, per-rep breakdown,
// weekly trend) in frontend/src/pages/reports/estimates-report-logic.ts. To keep
// the demo (mock) and live (DB) paths in lockstep — exactly like the
// estimate-conversion report — the backend only flattens real Estimate rows into
// the SAME `EstimateRow` shape that pure logic consumes, then ships them as
// `{ rows }`. The frontend hook runs the identical pure functions over them.
//
// Mirrors estimates-report-logic.ts:
//   RawStatus = Prisma EstimateStatus enum (DRAFT|SENT|PENDING|WON|DECLINED|EXPIRED|ARCHIVED)
//   hasJob    = the estimate has a linked Job (Estimate.job is 1:1) ⇒ "won" when WON.

/** Raw estimate status — mirrors Prisma EstimateStatus (same union as the frontend RawStatus). */
export type RawStatus =
  | 'DRAFT' | 'SENT' | 'PENDING' | 'WON' | 'DECLINED' | 'EXPIRED' | 'ARCHIVED';

/** One normalized estimate — the single shape both backend and frontend compute on.
 *  Keep field-for-field identical to EstimateRow in estimates-report-logic.ts. */
export interface EstimateReportRow {
  id: string;
  number: string;
  customer: string;
  rep: string; // estimate creator (created_by display name)
  createdAt: string; // ISO date (yyyy-mm-dd)
  amount: number;
  depositDue: number;
  status: RawStatus;
  hasJob: boolean; // WON + linked job ⇒ "won"
}

/** A name carrier — Customer (company or person) or User (first/last). */
interface NameParts {
  company_name?: string | null;
  first_name?: string | null;
  last_name?: string | null;
}

/** Customer display name: company first, else "First Last", else "Unknown". */
export function customerName(c: NameParts | null | undefined): string {
  if (!c) return 'Unknown';
  if (c.company_name) return c.company_name;
  const personal = [c.first_name, c.last_name].filter(Boolean).join(' ').trim();
  return personal || 'Unknown';
}

/** Rep (estimate creator) display name from a User; "Unassigned" when missing. */
export function repName(u: NameParts | null | undefined): string {
  if (!u) return 'Unassigned';
  const name = [u.first_name, u.last_name].filter(Boolean).join(' ').trim();
  return name || 'Unassigned';
}

/** The lean Prisma row this service flattens (see report.controller.ts select). */
export interface EstimateSourceRow {
  id: string;
  estimate_number: string;
  status: RawStatus;
  total_amount: unknown; // Prisma Decimal | number | string
  created_at: Date;
  creator?: NameParts | null;
  lead?: { customer?: NameParts | null } | null;
  // SERV10X-61 - direct anchor (R6) so a lead-less estimate reports its customer name; the report
  // controller's select carries it as a sibling of `lead.customer`.
  customer?: NameParts | null;
  job?: { id: string } | null;
  send_config?: { deposit_amount: unknown } | null;
}

/** ISO yyyy-mm-dd in UTC — matches the frontend mock's `createdAt` slice. */
function isoDate(d: Date): string {
  return new Date(d).toISOString().slice(0, 10);
}

/** Decimal/number/string → number, NaN-safe. */
function toNumber(v: unknown): number {
  const n = Number(v ?? 0);
  return Number.isFinite(n) ? n : 0;
}

/**
 * Flatten a tenant-scoped Prisma estimate into the report row the frontend logic
 * expects. `hasJob` is the presence of a linked Job (drives the "won" bucket for
 * WON estimates). `depositDue` reads the send-config deposit amount, mirroring
 * the mock's depositDue column (0 when no send config).
 */
export function toEstimateReportRow(e: EstimateSourceRow): EstimateReportRow {
  return {
    id: e.id,
    number: e.estimate_number,
    customer: customerName(e.lead?.customer ?? e.customer),
    rep: repName(e.creator),
    createdAt: isoDate(e.created_at),
    amount: toNumber(e.total_amount),
    depositDue: toNumber(e.send_config?.deposit_amount),
    status: e.status,
    hasJob: !!e.job,
  };
}

/** Map a list of source rows to report rows (controller entry point). */
export function buildEstimatesReport(rows: EstimateSourceRow[]): EstimateReportRow[] {
  return rows.map(toEstimateReportRow);
}
