import { Request, Response } from 'express';
import { z } from 'zod';
import { InvoiceStatus, Prisma } from '@prisma/client';
import { prisma } from '../lib/prisma';
import { COUNTED_PAYMENT_WHERE } from '../lib/payment-ledger';
import { logger } from '../lib/logger';
import { tenantWhere } from '../lib/tenant';
import { scopeWhereForReq } from '../lib/permissions/enforce';
import { tableSql, whereSql } from '../lib/permissions/reachSql';
import { arOutstandingWhere } from '../lib/ar';
import { getRequestOrgTimezone } from '../lib/timezone';
import {
  buildReport,
  filterRows,
  selectDrillRows,
  toDrillDto,
  type NormalizedRow,
  type ReportFilters,
  type EstimateStatusKey,
} from '../services/estimate-conversion-report';
import { buildArAging, computeDso, DSO_WINDOW_DAYS, type ArInvoiceRow, type ArSegment } from '../services/ar-aging-report';
import { buildJobsReport, type JobInput } from '../services/jobs-report';
import { resolveJobScheduleWindow } from '../lib/job-schedule-projection';
import { buildLeadsReport, type LeadInput } from '../services/leads-report';
import { buildEstimatesReport, type EstimateSourceRow } from '../services/estimates-report';
import { buildRevenueReport, type RevenueEvent } from '../services/revenue-report';
import { buildPaymentsReport, type PaymentInput, type DbInvoiceKind } from '../services/payments-report';
import { buildInvoicesReport, invoiceSellerFor, type InvoiceReportInput } from '../services/invoices-report';
import { buildActivityReport, type ActivityEventRow } from '../services/activity-report';
import { buildInventoryUsageReport, type UsageMovementRow } from '../services/inventory-usage-report';
import {
  buildPaymentFeesReport,
  type PaymentFeeRow,
  type PaymentExtraRow,
} from '../services/payment-fees-report';
import { DEPOSIT_CREDIT_REFERENCE } from './invoice.controller';
import { canSeeCosts, canSeeCompanyFigures } from '../lib/permissions/enforce';
import {
  redactActivityReportRevenue,
  redactArAgingReport,
  redactEstimateConversionReport,
  redactJobsReportCosts,
  redactPaymentFeesReport,
  redactRevenueReport,
} from '../lib/permissions/companyFigures';
import { creditsTotalOf } from '../lib/invoice-editable';
import { inclusiveEndOfDay } from '../lib/dateBounds';

// Prisma select for the rows the report computes on. Kept lean — only what the
// pure logic needs. All filtering/aggregation happens in the service in JS so
// the date-anchor logic has a single source of truth (shared with the frontend).
const reportSelect = {
  id: true,
  estimate_number: true,
  status: true,
  total_amount: true,
  lead_source: true,
  job_type: true,
  lost_reason: true,
  sent_at: true,
  approved_at: true,
  declined_at: true,
  created_at: true,
  updated_at: true,
  lead: {
    select: {
      created_at: true,
      // The conversion report's "rep" is the SELLER = commission_owner (single,
      // off-board), not the crew. Read it directly off the lead.
      commission_owner_id: true,
      commission_owner: { select: { id: true, first_name: true, last_name: true } },
      customer: { select: { first_name: true, last_name: true, company_name: true } },
    },
  },
  // SERV10X-61 - direct anchor (R6) so a lead-less estimate still names its customer in the
  // conversion report; falls back through the lead for lead-anchored rows (see normalize()).
  customer: { select: { first_name: true, last_name: true, company_name: true } },
} as const;

function fullName(first?: string | null, last?: string | null): string {
  return [first, last].filter(Boolean).join(' ').trim();
}

function normalize(e: any): NormalizedRow {
  const rep = e.lead?.commission_owner;
  const cust = e.lead?.customer ?? e.customer;
  return {
    id: e.id,
    number: e.estimate_number,
    customerName: cust
      ? (cust.company_name || fullName(cust.first_name, cust.last_name) || 'Unknown')
      : 'Unknown',
    repId: e.lead?.commission_owner_id ?? null,
    repName: (rep && fullName(rep.first_name, rep.last_name)) || 'Unassigned',
    source: e.lead_source ?? null,
    jobType: e.job_type ?? null,
    amount: Number(e.total_amount ?? 0),
    status: e.status as EstimateStatusKey,
    createdAt: e.created_at,
    sentAt: e.sent_at ?? null,
    decidedAt: e.approved_at ?? e.declined_at ?? null,
    lastActivityAt: e.updated_at ?? null,
    leadCreatedAt: e.lead?.created_at ?? null,
    lostReason: e.lost_reason ?? null,
  };
}

/**
 * A report is a view over the rows the person's scope reaches, never a wider door (P13): every query below carries the same
 * row scope the lists use, ANDed on so it never clobbers a filter of the report's own. The sums are over those rows alone,
 * and what money they may show is the money classes' (See prices on a row, See company figures on a total).
 */
const reach = (req: Request, resource: 'Job' | 'Lead' | 'Estimate' | 'Invoice') => scopeWhereForReq(req, resource);

async function fetchOrgRows(req: Request): Promise<NormalizedRow[]> {
  const rows = await prisma.estimate.findMany({
    where: { ...tenantWhere(req), AND: [await reach(req, 'Estimate')] },
    select: reportSelect,
  });
  return rows.map(normalize);
}

// ── Shared filter parsing ────────────────────────────────────────────────────
const baseFilterSchema = z.object({
  anchor: z.enum(['created', 'sent', 'decided']).default('sent'),
  from: z.coerce.date().optional(),
  to: inclusiveEndOfDay,
  rep: z.string().default('all'),
  source: z.string().default('all'),
  jobType: z.string().default('all'),
  model: z.enum(['decided', 'sent']).default('sent'),
});

function resolveFilters(q: z.infer<typeof baseFilterSchema>, now: Date): ReportFilters {
  const to = q.to ?? now;
  // Default window: trailing 12 months.
  const from = q.from ?? new Date(to.getTime() - 365 * 86_400_000);
  return { anchor: q.anchor, from, to, repId: q.rep, source: q.source, jobType: q.jobType, model: q.model };
}

// GET /api/reports/estimate-conversion
export async function getEstimateConversion(req: Request, res: Response) {
  try {
    const parsed = baseFilterSchema.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({ error: 'Invalid query', details: parsed.error.flatten() });
      return;
    }
    const now = new Date();
    const filters = resolveFilters(parsed.data, now);
    const rows = await fetchOrgRows(req);
    const report = buildReport(rows, filters, now);
    // The quoted and won totals, average tickets and per-rep values are company figures; the counts and rates stay.
    res.json(canSeeCompanyFigures(req) ? report : redactEstimateConversionReport(report));
  } catch (err) {
    logger.error('Estimate conversion report error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
}

const DRILL_CAP = 200;

const drillFilterSchema = baseFilterSchema.extend({
  status: z.enum(['DRAFT', 'SENT', 'PENDING', 'WON', 'DECLINED', 'EXPIRED', 'ARCHIVED']).optional(),
  outcome: z.enum(['won', 'lost', 'open']).optional(),
  agingBucket: z.enum(['0-7', '8-14', '15-30', '30+']).optional(),
  repId: z.string().optional(),
  month: z.string().regex(/^\d{4}-\d{2}$/).optional(),
});

// GET /api/reports/estimate-conversion/estimates
export async function getEstimateConversionDrilldown(req: Request, res: Response) {
  try {
    const parsed = drillFilterSchema.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({ error: 'Invalid query', details: parsed.error.flatten() });
      return;
    }
    const now = new Date();
    const filters = resolveFilters(parsed.data, now);
    const rows = await fetchOrgRows(req);
    const scoped = filterRows(rows, filters);
    const selected = selectDrillRows(
      scoped,
      {
        status: parsed.data.status,
        outcome: parsed.data.outcome,
        agingBucket: parsed.data.agingBucket,
        repId: parsed.data.repId,
        month: parsed.data.month,
      },
      filters.anchor,
      now,
    );
    const truncated = selected.length > DRILL_CAP;
    if (truncated) {
      logger.info(`Drill-down capped at ${DRILL_CAP} of ${selected.length} estimates`);
    }
    res.json({
      total: selected.length,
      truncated,
      rows: selected.slice(0, DRILL_CAP).map((r) => toDrillDto(r, now)),
    });
  } catch (err) {
    logger.error('Estimate conversion drill-down error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
}

// ── F4: AR Aging & Collections ───────────────────────────────────────────────
// The "outstanding AR" filter lives in lib/ar.ts (arOutstandingWhere) and is
// shared with the dashboard AR KPI so the two totals can never diverge.

const arInvoiceSelect = {
  invoice_number: true,
  amount_due: true,
  due_date: true,
  sent_at: true,
  created_at: true,
  customer_id: true,
  customer: { select: { segment: true, company_name: true, first_name: true, last_name: true } },
  // job_id is nullable (standalone invoices have no job), so the address is
  // best-effort — those rows fall back to the "—" placeholder in the report.
  job: {
    select: {
      service_location: {
        select: { address_line1: true, address_line2: true, city: true, state: true, zip: true },
      },
    },
  },
} as const;

function customerDisplayName(c: {
  company_name: string | null;
  first_name: string | null;
  last_name: string | null;
}): string {
  if (c.company_name) return c.company_name;
  const personal = [c.last_name, c.first_name].filter(Boolean).join(', ').trim();
  return personal || 'Unknown';
}

/** One-line service address for the AR worklist. Mirrors leadAddress (:312). */
function formatArLocation(
  loc: {
    address_line1: string; address_line2: string | null;
    city: string; state: string; zip: string;
  } | null | undefined,
): string | null {
  if (!loc) return null;
  const street = [loc.address_line1, loc.address_line2].filter(Boolean).join(' ');
  return [street, [loc.city, loc.state].filter(Boolean).join(', '), loc.zip]
    .filter(Boolean).join(', ').trim() || null;
}

// GET /api/reports/ar-aging
export async function getArAging(req: Request, res: Response) {
  try {
    const invoices = await prisma.invoice.findMany({
      where: { ...tenantWhere(req), ...arOutstandingWhere, AND: [await reach(req, 'Invoice')] },
      select: arInvoiceSelect,
    });

    const rows: ArInvoiceRow[] = invoices.map((inv) => ({
      invoiceNumber: inv.invoice_number,
      amountDue: Number(inv.amount_due),
      dueDate: inv.due_date,
      sentAt: inv.sent_at,
      createdAt: inv.created_at,
      customerId: inv.customer_id,
      customerName: customerDisplayName(inv.customer),
      segment: (inv.customer.segment === 'COMMERCIAL' ? 'Commercial' : 'Residential') as ArSegment,
      location: formatArLocation(inv.job?.service_location),
    }));

    // Aging is counted on the ORG's calendar, not UTC's and not the viewer's - the same
    // clock the invoice pages print their due dates on.
    const accounts = buildArAging(rows, new Date(), await getRequestOrgTimezone(req));

    // DSO denominator = credit sales actually ISSUED in the window. Anchored on
    // sent_at (falling back to created_at for never-sent rows) because the Workiz
    // importer backdates created_at, and DRAFT invoices were never issued at all.
    // Verified against the B&G clone: this choice moves DSO from 65 to 26 days.
    const since = new Date(Date.now() - DSO_WINDOW_DAYS * 86_400_000);
    const sales = await prisma.invoice.aggregate({
      where: {
        ...tenantWhere(req),
        AND: [await reach(req, 'Invoice')],
        kind: { not: 'DEPOSIT' },
        voided_at: null,
        status: { notIn: [InvoiceStatus.DRAFT, InvoiceStatus.VOIDED] },
        OR: [
          { sent_at: { gte: since } },
          { sent_at: null, created_at: { gte: since } },
        ],
      },
      _sum: { total_amount: true },
    });

    // Numerator is the same outstanding set the accounts were built from, so the
    // ratio can never drift from what the report displays.
    const arBalance = rows.reduce((s, r) => s + r.amountDue, 0);
    const salesInWindow = Number(sales._sum.total_amount ?? 0);

    const report = {
      accounts,
      dso: computeDso(arBalance, salesInWindow),
      salesInWindow,
      salesWindowDays: DSO_WINDOW_DAYS,
    };
    // Each customer's balances are the invoices themselves and stay for everyone this report opens to; the company-wide
    // sales window and the days-sales-outstanding figure built from it are company figures.
    res.json(canSeeCompanyFigures(req) ? report : redactArAgingReport(report));
  } catch (err) {
    logger.error('AR aging report error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
}

// ── Jobs report ──────────────────────────────────────────────────────────────
const jobsReportSelect = {
  job_number: true,
  scope_notes: true,
  status: true,
  created_at: true,
  customer: {
    select: { company_name: true, first_name: true, last_name: true, email: true, phone: true, source: true },
  },
  service_location: {
    select: { address_line1: true, address_line2: true, city: true, state: true, zip: true },
  },
  // S8 (D6): crew through the trips.
  // S8 (A5, RATIFIED): also the source of scheduledStart/scheduledEnd below - the stored mirror
  // (scheduled_start/scheduled_end) is DROPPED; found as a straggler via this PR's own Step 0
  // re-grep, not named in the contract's snapshot list.
  visits: {
    select: {
      status: true, scheduled_at: true, scheduled_end: true, is_all_day: true, created_at: true,
      assignees: { select: { user: { select: { first_name: true, last_name: true } } } },
    },
  },
  dispatcher: { select: { first_name: true, last_name: true } },
  invoices: {
    where: { voided_at: null, kind: { not: 'DEPOSIT' } },
    select: {
      total_amount: true, amount_due: true, subtotal: true, tax_amount: true,
      // SRVW-84 - `paid` back-derives cash from total_amount - amount_due, so the credit notes
      // have to net out. Rides the tenant-scoped job.findMany below.
      credits: { select: { amount: true } },
    },
  },
} as const;

// GET /api/reports/jobs
export async function getJobsReport(req: Request, res: Response) {
  try {
    // A job's own invoices ride along to sum its money; only the ones the person can reach count (P13), whatever the job's reach.
    const invoiceReach = await reach(req, 'Invoice');
    const jobs = await prisma.job.findMany({
      where: { ...tenantWhere(req), AND: [await reach(req, 'Job')] },
      select: { ...jobsReportSelect, invoices: { ...jobsReportSelect.invoices, where: { ...jobsReportSelect.invoices.where, AND: [invoiceReach] } } },
    });
    const rows: JobInput[] = jobs.map((j) => {
      const schedule = resolveJobScheduleWindow(j.visits);
      return {
      jobNumber: j.job_number,
      scopeNotes: j.scope_notes,
      status: j.status,
      customerCompanyName: j.customer.company_name,
      customerFirstName: j.customer.first_name,
      customerLastName: j.customer.last_name,
      customerEmail: j.customer.email,
      customerPhone: j.customer.phone,
      addressLine1: j.service_location.address_line1,
      addressLine2: j.service_location.address_line2,
      city: j.service_location.city,
      state: j.service_location.state,
      zip: j.service_location.zip,
      // S8 (D6): the job's crew is the union across its trips.
      assignees: j.visits.flatMap((v) => v.assignees).map((a) => ({ firstName: a.user.first_name, lastName: a.user.last_name })),
      dispatcher: j.dispatcher ? { firstName: j.dispatcher.first_name, lastName: j.dispatcher.last_name } : null,
      source: j.customer.source,
      createdAt: j.created_at,
      scheduledStart: schedule.scheduled_start,
      scheduledEnd: schedule.scheduled_end,
      invoices: j.invoices.map((inv) => ({
        totalAmount: Number(inv.total_amount),
        amountDue: Number(inv.amount_due),
        subtotal: Number(inv.subtotal),
        taxAmount: Number(inv.tax_amount),
        creditsTotal: creditsTotalOf(inv.credits),
      })),
      };
    });
    const report = buildJobsReport(rows);
    res.json({ jobs: canSeeCosts(req) ? report : redactJobsReportCosts(report) });
  } catch (err) {
    logger.error('Jobs report error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
}

// ── Leads report ─────────────────────────────────────────────────────────────
const leadsReportSelect = {
  lead_number: true,
  status: true,
  source: true,
  job_type: true,
  created_at: true,
  scheduled_start: true,
  customer: { select: { email: true, phone: true, company_name: true, first_name: true, last_name: true } },
  service_location: { select: { address_line1: true, city: true, state: true, zip: true } },
  commission_owner: { select: { first_name: true, last_name: true } },
  lead_assignees: { select: { user: { select: { first_name: true, last_name: true } } } },
  lead_tags: { select: { tag: { select: { name: true } } } },
  estimates: { select: { total_amount: true, status: true, approved_at: true } },
} as const;

function leadAddress(loc: { address_line1: string; city: string; state: string; zip: string } | null): string {
  if (!loc) return '';
  return [loc.address_line1, [loc.city, loc.state].filter(Boolean).join(', '), loc.zip].filter(Boolean).join(', ');
}

// GET /api/reports/leads
export async function getLeadsReport(req: Request, res: Response) {
  try {
    // A lead's estimates give its value and its conversion; only the ones the person can reach count (P13).
    const estimateReach = await reach(req, 'Estimate');
    const leads = await prisma.lead.findMany({
      where: { ...tenantWhere(req), AND: [await reach(req, 'Lead')] },
      select: { ...leadsReportSelect, estimates: { ...leadsReportSelect.estimates, where: { AND: [estimateReach] } } },
    });
    const rows: LeadInput[] = leads.map((l) => {
      const assignee = l.commission_owner ?? l.lead_assignees[0]?.user ?? null;
      return {
        leadNumber: l.lead_number,
        client: l.customer ? customerDisplayName(l.customer) : 'Unknown',
        email: l.customer?.email ?? '',
        phone: l.customer?.phone ?? '',
        address: leadAddress(l.service_location),
        status: l.status,
        source: l.source ?? null,
        jobType: l.job_type ?? null,
        assigned: assignee ? fullName(assignee.first_name, assignee.last_name) : '',
        createdBy: assignee ? fullName(assignee.first_name, assignee.last_name) : '',
        tags: l.lead_tags.map((t) => t.tag.name),
        createdAt: l.created_at,
        scheduledAt: l.scheduled_start,
        estimates: l.estimates.map((e) => ({
          total: Number(e.total_amount ?? 0),
          status: e.status,
          approvedAt: e.approved_at,
        })),
      };
    });
    res.json({ leads: buildLeadsReport(rows) });
  } catch (err) {
    logger.error('Leads report error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
}

// ── Estimates report ─────────────────────────────────────────────────────────
const estimatesReportSelect = {
  id: true,
  estimate_number: true,
  status: true,
  total_amount: true,
  created_at: true,
  creator: { select: { first_name: true, last_name: true } },
  lead: { select: { customer: { select: { company_name: true, first_name: true, last_name: true } } } },
  // SERV10X-61 - direct anchor (R6) so a lead-less estimate reports its customer name; the service
  // (estimates-report.ts) prefers lead.customer and falls back to this.
  customer: { select: { company_name: true, first_name: true, last_name: true } },
  job: { select: { id: true } },
  send_config: { select: { deposit_amount: true } },
} as const;

// GET /api/reports/estimates
export async function getEstimatesReport(req: Request, res: Response) {
  try {
    const rows = await prisma.estimate.findMany({ where: { ...tenantWhere(req), AND: [await reach(req, 'Estimate')] }, select: estimatesReportSelect });
    res.json({ rows: buildEstimatesReport(rows as unknown as EstimateSourceRow[]) });
  } catch (err) {
    logger.error('Estimates report error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
}

// ── F2: Revenue — Completed vs Invoiced vs Collected ─────────────────────────
// No business-unit dimension in the schema → NO BU split (that stays mock-only).
export async function getRevenueReport(req: Request, res: Response) {
  try {
    // Jobs can be moved backward off COMPLETED (Spec B1), which clears completed_at and shrinks
    // a historical month total until they are re-completed. That is intended: the user is
    // asserting the job was not in fact done. The TimelineEvent preserves the original moment.
    const [jobScope, invoiceScope] = await Promise.all([reach(req, 'Job'), reach(req, 'Invoice')]);
    const [completedJobs, invoices, payments] = await Promise.all([
      prisma.job.findMany({
        where: { ...tenantWhere(req), AND: [jobScope], completed_at: { not: null } },
        select: { completed_at: true, amount_invoiced: true },
      }),
      prisma.invoice.findMany({
        where: { ...tenantWhere(req), AND: [invoiceScope], kind: { not: 'DEPOSIT' }, voided_at: null },
        select: { total_amount: true, sent_at: true, created_at: true },
      }),
      // Slice 05: collected = SUCCEEDED, non-voided payments only.
      prisma.payment.findMany({
        where: { ...COUNTED_PAYMENT_WHERE, invoice: { is: { ...tenantWhere(req), AND: [invoiceScope], kind: { not: 'DEPOSIT' } } } },
        select: { amount: true, paid_at: true },
      }),
    ]);
    const completed: RevenueEvent[] = completedJobs.map((j) => ({ date: j.completed_at, amount: Number(j.amount_invoiced) }));
    const invoiced: RevenueEvent[] = invoices.map((inv) => ({ date: inv.sent_at ?? inv.created_at, amount: Number(inv.total_amount) }));
    const collected: RevenueEvent[] = payments.map((p) => ({ date: p.paid_at, amount: Number(p.amount) }));
    const report = buildRevenueReport({ completed, invoiced, collected });
    // Nothing on this report is anything but company-wide money.
    res.json(canSeeCompanyFigures(req) ? report : redactRevenueReport(report));
  } catch (err) {
    logger.error('Revenue report error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
}

// ── F5: Payments Collected & Method Mix ──────────────────────────────────────
const paymentReportSelect = {
  id: true,
  amount: true,
  method: true,
  paid_at: true,
  refunded_at: true,
  refunded_amount: true,
  voided_at: true,
  void_category: true,
  reference_number: true,
  tip_amount: true,
  wallet: true,
  card_brand: true,
  card_last4: true,
  bank_name: true,
  bank_last4: true,
  created_by_source: true,
  invoice: {
    select: { kind: true, customer: { select: { email: true, company_name: true, first_name: true, last_name: true } } },
  },
  collector: { select: { first_name: true, last_name: true } },
} as const;

// GET /api/reports/payments
export async function getPaymentsReport(req: Request, res: Response) {
  try {
    // Slice 05: a PROCESSING bank debit has not been collected and a FAILED one never was, so
    // neither is a row in this report. Voided payments stay listed (as "Voided").
    const payments = await prisma.payment.findMany({
      // A payment is reached through its invoice (P13), so the invoice scope decides which payments the report lists.
      where: { state: 'SUCCEEDED', invoice: { ...tenantWhere(req), AND: [await reach(req, 'Invoice')] } },
      select: paymentReportSelect,
    });
    const rows: PaymentInput[] = payments.map((p) => ({
      id: p.id,
      amount: Number(p.amount),
      method: p.method,
      paidAt: p.paid_at,
      refundedAt: p.refunded_at,
      refundedAmount: p.refunded_amount == null ? null : Number(p.refunded_amount),
      voidedAt: p.voided_at,
      voidCategory: p.void_category,
      // #498 - a deposit-credit application is the SAME money as the deposit payment it draws
      // from, so summing both double-counts it. Same hazard already guarded by
      // invoice.controller's NON_CREDIT_PAYMENT_FILTER and job.controller's cancelJob total.
      isDepositCredit: p.reference_number === DEPOSIT_CREDIT_REFERENCE,
      invoiceKind: p.invoice.kind as DbInvoiceKind,
      customerName: customerDisplayName(p.invoice.customer),
      customerEmail: p.invoice.customer.email ?? null,
      collectorName: p.collector ? fullName(p.collector.first_name, p.collector.last_name) || null : null,
      // CLIENT = the customer paid it themselves (webhook-written payment); nobody keyed or collected it.
      paidOnline: p.created_by_source === 'CLIENT',
      tipAmount: Number(p.tip_amount ?? 0),
      wallet: p.wallet,
      cardBrand: p.card_brand,
      cardLast4: p.card_last4,
      bankName: p.bank_name,
      bankLast4: p.bank_last4,
    }));
    res.json(buildPaymentsReport(rows));
  } catch (err) {
    logger.error('Payments report error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
}

// ── Invoices list report ─────────────────────────────────────────────────────
// Salesperson = whose sale the invoice is (invoiceSellerFor): the job's stored Sold By, a plan's own
// invoice's "Sold by", else the estimate's lead Owner.
const INVOICE_REPORT_STATUSES: InvoiceStatus[] = [
  InvoiceStatus.DRAFT,
  InvoiceStatus.SENT,
  InvoiceStatus.PARTIAL,
  InvoiceStatus.PAID,
  InvoiceStatus.PARTIALLY_REFUNDED,
  InvoiceStatus.DISPUTED,
];

const invoicesReportSelect = {
  invoice_number: true,
  status: true,
  subtotal: true,
  tax_amount: true,
  total_amount: true,
  amount_due: true,
  discount_amount: true,
  sent_at: true,
  due_date: true,
  created_at: true,
  customer: { select: { company_name: true, first_name: true, last_name: true, email: true } },
  job: {
    select: {
      job_number: true,
      salesperson: { select: { first_name: true, last_name: true } },
      // S8 (D6): crew through the trips - the earliest trip's earliest crew row is the lead tech.
      visits: { select: { assignees: { select: { user: { select: { first_name: true, last_name: true } } }, orderBy: { created_at: 'asc' } } }, orderBy: { created_at: 'asc' } },
    },
  },
  service_plan: { select: { sold_by_user: { select: { first_name: true, last_name: true } } } },
  estimate: {
    select: {
      job_type: true,
      lead: { select: { job_type: true, commission_owner: { select: { first_name: true, last_name: true } } } },
    },
  },
} as const;

// GET /api/reports/invoices
export async function getInvoicesReport(req: Request, res: Response) {
  try {
    const invoices = await prisma.invoice.findMany({
      where: { ...tenantWhere(req), AND: [await reach(req, 'Invoice')], kind: { not: 'DEPOSIT' }, voided_at: null, status: { in: INVOICE_REPORT_STATUSES } },
      select: invoicesReportSelect,
      orderBy: { created_at: 'desc' },
    });
    const rows: InvoiceReportInput[] = invoices.map((inv) => {
      const seller = invoiceSellerFor(inv);
      const tech = inv.job?.visits.flatMap((v) => v.assignees)[0]?.user ?? null;
      return {
        invoiceNumber: inv.invoice_number,
        status: inv.status,
        subtotal: Number(inv.subtotal),
        taxAmount: Number(inv.tax_amount),
        totalAmount: Number(inv.total_amount),
        amountDue: Number(inv.amount_due),
        discountAmount: Number(inv.discount_amount),
        sentAt: inv.sent_at,
        dueDate: inv.due_date,
        createdAt: inv.created_at,
        customerName: customerDisplayName(inv.customer),
        customerEmail: inv.customer.email ?? '',
        jobNumber: inv.job?.job_number ?? '',
        salesperson: seller ? fullName(seller.first_name, seller.last_name) || null : null,
        technician: tech ? fullName(tech.first_name, tech.last_name) || null : null,
        jobType: inv.estimate?.job_type ?? inv.estimate?.lead?.job_type ?? null,
      };
    });
    res.json({ rows: buildInvoicesReport(rows, new Date()) });
  } catch (err) {
    logger.error('Invoices report error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
}

// ── Activity — per-actor rollup over the TimelineEvent log ────────────────────
// No division dimension in the schema → flat per-actor list (division is mock-only).
/**
 * The events the person's scope reaches (P13): an event on a job, lead, estimate or invoice counts only when the person can
 * reach that record. A person who reaches all four kinds of record sees the whole log; for anyone narrower, an event on
 * anything else (a customer, a task, a stock movement) has no scope to be judged by, so it is left out rather than widened.
 *
 * The filter runs entirely in the database (spec story 49): each kind's reach, the same `where` the lists use, is compiled
 * to SQL (lib/permissions/reachSql.ts) and the events are joined against their record with EXISTS. No id list leaves the
 * database, so it neither slows down nor breaks in a company with more records than a statement can list.
 */
async function activityEvents(req: Request): Promise<ActivityEventRow[]> {
  const kinds = [
    { type: 'JOB', resource: 'Job' },
    { type: 'LEAD', resource: 'Lead' },
    { type: 'ESTIMATE', resource: 'Estimate' },
    { type: 'INVOICE', resource: 'Invoice' },
  ] as const;
  const scopes = await Promise.all(kinds.map((k) => reach(req, k.resource)));
  const org = tenantWhere(req).organization_id;
  if (scopes.every((scope) => Object.keys(scope).length === 0)) {
    // Reach over every record: the whole log, read as it always was.
    const all = await prisma.timelineEvent.findMany({
      where: { ...tenantWhere(req) },
      select: { event_type: true, created_at: true, created_by: true, creator: { select: { first_name: true, last_name: true, role: true } } },
    });
    return all.map((e) => ({
      eventType: e.event_type,
      createdAt: e.created_at,
      actorId: e.created_by,
      actorFirstName: e.creator?.first_name ?? null,
      actorLastName: e.creator?.last_name ?? null,
      actorRole: e.creator?.role ?? null,
    }));
  }
  const arms = kinds.map((k, i) => {
    const scope = scopes[i]!;
    if (Object.keys(scope).length === 0) return Prisma.sql`e.entity_type = ${k.type}`;
    return Prisma.sql`(e.entity_type = ${k.type} AND EXISTS (
      SELECT 1 FROM ${tableSql(k.resource)} rec
      WHERE rec.id = e.entity_id AND rec.organization_id = ${org}::uuid AND (${whereSql(k.resource, scope, 'rec')})
    ))`;
  });
  const events = await prisma.$queryRaw<Array<{
    event_type: string; created_at: Date; created_by: string | null; first_name: string | null; last_name: string | null; role: string | null;
  }>>(Prisma.sql`
    SELECT e.event_type, e.created_at, e.created_by, u.first_name, u.last_name, u.role::text AS role
    FROM timeline_events e
    LEFT JOIN users u ON u.id = e.created_by
    WHERE e.organization_id = ${org}::uuid AND (${Prisma.join(arms, ' OR ')})
  `);
  return events.map((e) => ({
    eventType: e.event_type,
    createdAt: e.created_at,
    actorId: e.created_by,
    actorFirstName: e.first_name,
    actorLastName: e.last_name,
    actorRole: e.role as ActivityEventRow['actorRole'],
  }));
}

// GET /api/reports/activity
export async function getActivityReport(req: Request, res: Response) {
  try {
    const users = buildActivityReport(await activityEvents(req));
    res.json({ users: canSeeCompanyFigures(req) ? users : redactActivityReportRevenue(users) });
  } catch (err) {
    logger.error('Activity report error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
}

// ── Inventory usage — Σ consume movements per item (P5 §3.1, plan D17) ────────
const inventoryUsageQuerySchema = z.object({
  from: z.coerce.date().optional(),
  to: inclusiveEndOfDay,
});

async function inventoryJobReach(req: Request): Promise<Record<string, unknown>> {
  const scope = await reach(req, 'Job');
  return Object.keys(scope).length === 0 ? {} : { job: { is: { AND: [scope] } } };
}

/** Which of these invoices the person reaches, asked in the database in slices that stay well under a statement's value limit. */
async function reachableInvoiceIds(req: Request, invoiceIds: string[]): Promise<Set<string>> {
  const wanted = [...new Set(invoiceIds)];
  const scope = await reach(req, 'Invoice');
  if (Object.keys(scope).length === 0) return new Set(wanted);
  const out = new Set<string>();
  for (let i = 0; i < wanted.length; i += 5_000) {
    const rows = await prisma.invoice.findMany({
      where: { id: { in: wanted.slice(i, i + 5_000) }, ...tenantWhere(req), AND: [scope] },
      select: { id: true },
    });
    for (const r of rows) out.add(r.id);
  }
  return out;
}

// GET /api/reports/inventory-usage
export async function getInventoryUsageReport(req: Request, res: Response) {
  try {
    const parsed = inventoryUsageQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({ error: 'Invalid query', details: parsed.error.flatten() });
      return;
    }
    // Default window: trailing 12 months (mirrors resolveFilters).
    const to = parsed.data.to ?? new Date();
    const from = parsed.data.from ?? new Date(to.getTime() - 365 * 86_400_000);

    const movements = await prisma.stockMovement.findMany({
      // A consumption is reached through the job it was used on (P13); one with no job belongs to nobody's scope, so a person
      // whose Jobs scope is narrower than All does not see it.
      where: { ...tenantWhere(req), type: 'consume', occurred_at: { gte: from, lte: to }, ...(await inventoryJobReach(req)) },
      select: {
        type: true, occurred_at: true, item_id: true, item_sku: true, item_name: true,
        qty: true, unit_cost: true, job_id: true,
        job: { select: { id: true, job_number: true } },
        invoice_line_item: { select: { invoice: { select: { id: true, invoice_number: true } } } },
        // §14 H2 / E26: LO-issued consumption carries no invoice LINE — invoice attribution
        // rides the LO's own invoice anchor, or the usage report shows it as unattributed.
        logistic_order: { select: { invoice: { select: { id: true, invoice_number: true } } } },
      },
    });

    // The invoice a consumption was billed on is named only when the person can reach that invoice (spec story 48): the job
    // being within reach does not open the invoice, which follows the person's own invoice reach (View invoices included).
    const billedOn = (m: any): { id: string; invoice_number: string } | null =>
      m.invoice_line_item?.invoice ?? m.logistic_order?.invoice ?? null;
    const reachable = await reachableInvoiceIds(req, movements.map(billedOn).filter((i): i is { id: string; invoice_number: string } => !!i).map((i) => i.id));

    // Normalize at the boundary (qty/unit_cost are Prisma Decimals) → pure service.
    const rows: UsageMovementRow[] = movements.map((m: any) => ({
      type: m.type,
      occurredAt: m.occurred_at,
      itemId: m.item_id ?? null,
      itemSku: m.item_sku,
      itemName: m.item_name,
      qty: Number(m.qty),
      unitCost: m.unit_cost != null ? Number(m.unit_cost) : null,
      jobId: m.job?.id ?? m.job_id ?? null,
      jobNumber: m.job?.job_number ?? null,
      invoiceId: reachable.has(billedOn(m)?.id ?? '') ? billedOn(m)!.id : null,
      invoiceNumber: reachable.has(billedOn(m)?.id ?? '') ? billedOn(m)!.invoice_number : null,
    }));

    const report = buildInventoryUsageReport(rows, { from, to });

    // Cost gate (plan §3.5): movement cost data is stripped for non-canSeeCosts
    // viewers. Admin and Sales hold See costs by default, but per-user
    // overrides make the strip mandatory. delete → key absent, not null.
    if (!canSeeCosts(req)) {
      for (const item of report.items) {
        delete (item as Partial<UsageMovementRow> & { cost?: number; unpricedUnits?: number }).cost;
        delete (item as Partial<UsageMovementRow> & { cost?: number; unpricedUnits?: number }).unpricedUnits;
      }
    }

    res.json(report);
  } catch (err) {
    logger.error('Inventory usage report error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
}

// ── Payment processing fees — Task 4.1 (Phase 4, follow-on to §7.3) ─────────
// Two independent queries feed one report (Plan A, 2026-08-04) - the doctrine
// for why the extras query is not gated on cost-side reconciliation lives in
// payment-fees-report.ts's HONEST NUMBERS comment.
//
// Cost query - Σ Gross / Charged / Stripe fee / ServWave platform fee / Net
// over succeeded CARD payments in a date window. Gross is the face basis and
// Charged is net_amount's own basis (face + fee + tip); the doctrine comment
// in payment-fees-report.ts explains why both are reported rather than one
// being made to match the other. "Succeeded" mirrors
// payments-report.ts's statusLabel(): not refunded (refunded_at is stamped on
// ANY refund, even partial - see invoice.controller.ts's refund handler), not
// voided. All three fee columns must also be non-null.
//
// Extras query - service fee + tip, gated on neither the three cost columns,
// nor refunded_at, nor method; a partial refund returns only its proportional
// share (see proportionalRefundExtras in invoice.controller.ts), so
// buildPaymentFeesReport prorates by refunded_amount / amount instead of
// dropping the row outright.
const paymentFeesQuerySchema = z.object({
  from: z.coerce.date().optional(),
  to: inclusiveEndOfDay,
});

// GET /api/reports/payment-fees
export async function getPaymentFeesReport(req: Request, res: Response) {
  try {
    const parsed = paymentFeesQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({ error: 'Invalid query', details: parsed.error.flatten() });
      return;
    }
    // Default window: trailing 12 months (mirrors resolveFilters / inventory-usage).
    // A date-only "to" (e.g. "2026-06-30" — what the frontend always sends, see
    // PaymentsReport.tsx's feeRange) is bumped to the end of that day by
    // inclusiveEndOfDay, matching baseFilterSchema.to / inventoryUsageQuerySchema.to
    // above — used as a plain `lte` below, a date-only value would otherwise
    // silently exclude every payment made later that same day. A precise
    // timestamp (or the default `new Date()` "now") is left untouched.
    const to = parsed.data.to ?? new Date();
    const from = parsed.data.from ?? new Date(to.getTime() - 365 * 86_400_000);

    // Payment has no own organization_id — tenant-scope via the invoice relation,
    // same shape as getRevenueReport's `collected` stream.
    const invoiceScope = await reach(req, 'Invoice');
    const payments = await prisma.payment.findMany({
      where: {
        method: 'CARD',
        ...COUNTED_PAYMENT_WHERE,
        refunded_at: null,
        stripe_fee_amount: { not: null },
        platform_fee_amount: { not: null },
        net_amount: { not: null },
        paid_at: { gte: from, lte: to },
        invoice: { is: { ...tenantWhere(req), AND: [invoiceScope] } },
      },
      select: {
        amount: true,
        stripe_fee_amount: true,
        platform_fee_amount: true,
        net_amount: true,
        // net_amount is measured against the FULL charge (face + fee + tip), not
        // against `amount` - so the cost query reads both columns to report the
        // `charged` basis alongside face-basis `gross`. Selected here in addition
        // to the extras query below, which is a different population entirely.
        service_fee_amount: true,
        tip_amount: true,
        paid_at: true,
      },
    });

    // Extras (service fee + tip) - a separate population, independent of the cost-side
    // reconciliation columns and of refunded_at (see the doctrine comment above). One query
    // for both, not two, because they need byte-identical treatment (same base filter, same
    // window, same tenant scope, same proration) and a payment usually carries both.
    //
    // Deliberately NOT gated on method, unlike the cost query above: a tip is not card-only
    // (a tech can be tipped in cash), and gating here silently dropped every non-card tip.
    // The service fee stays card-only without a filter, because only a card checkout ever
    // writes service_fee_amount - the OR below is what restricts the population.
    const extraPayments = await prisma.payment.findMany({
      where: {
        ...COUNTED_PAYMENT_WHERE,
        paid_at: { gte: from, lte: to },
        invoice: { is: { ...tenantWhere(req), AND: [invoiceScope] } },
        OR: [{ service_fee_amount: { not: null } }, { tip_amount: { not: null } }],
      },
      select: {
        amount: true,
        refunded_amount: true,
        service_fee_amount: true,
        tip_amount: true,
        paid_at: true,
      },
    });

    const rows: PaymentFeeRow[] = payments.map((p) => ({
      amount: Number(p.amount),
      stripeFeeAmount: Number(p.stripe_fee_amount),
      platformFeeAmount: Number(p.platform_fee_amount),
      netAmount: Number(p.net_amount),
      serviceFeeAmount: p.service_fee_amount != null ? Number(p.service_fee_amount) : null,
      tipAmount: p.tip_amount != null ? Number(p.tip_amount) : null,
      paidAt: p.paid_at,
    }));

    const extraRows: PaymentExtraRow[] = extraPayments.map((p) => ({
      amount: Number(p.amount),
      refundedAmount: p.refunded_amount != null ? Number(p.refunded_amount) : null,
      serviceFeeAmount: p.service_fee_amount != null ? Number(p.service_fee_amount) : null,
      tipAmount: p.tip_amount != null ? Number(p.tip_amount) : null,
      paidAt: p.paid_at,
    }));

    const report = buildPaymentFeesReport(rows, extraRows, { from, to });
    // The window and the payment counts stay; the fee, tip and net sums are company figures.
    res.json(canSeeCompanyFigures(req) ? report : redactPaymentFeesReport(report));
  } catch (err) {
    logger.error('Payment fees report error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
}
