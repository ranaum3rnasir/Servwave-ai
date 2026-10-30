import type { Prisma } from '@prisma/client';
import { prisma } from '../../lib/prisma';
import { tenantWhere } from '../../lib/tenant';
import { orgDayDiff } from '../../lib/orgDayRange';
import { LIVE_VISIT_STATUSES } from '../../lib/visit-status';
import { resolveNextJobVisit, NO_LIVE_VISIT_WHERE } from '../walkthrough.service';
import { countOpenAttention } from '../payment-attention';
import { NO_CREW_SCHEDULE_QUERY, NO_OWNER_LEADS_QUERY, clickTarget } from '../../lib/dashboard/clickTargets';
import { missingCrew, missingLeadOwner } from './workTiles';
import { withScope, type DashContext } from './context';

/**
 * Needs Attention (PRD 9). Every item is its own category: it is built only for a person who holds that record's View
 * switch, and only for a record the person can open (the same row scope the list page uses), so the card is never a
 * way to learn that an invoice, job or lead exists outside the person's reach.
 */

// The widget shows the top 3 of each lookup; the job-past-start and not-told lookups over-fetch a bounded cap and
// resolve in application code because Prisma cannot ORDER BY a to-many relation's resolved value.
const ATTENTION_OVERFETCH = 25;
// "Customer not told" is bounded like every other attention lookup: the header counts every item, but a shop with more
// than this many trips in two days is not one this widget can usefully enumerate.
const NOT_TOLD_OVERFETCH = 200;

export interface AttentionItem {
  id: string;
  type: string;
  severity: 'danger' | 'warning' | 'info';
  title: string;
  meta: string;
  badge: string;
  /** The address the row opens, or null when the person may not open that page (the row is shown, not clickable). */
  link: string | null;
}

type CustomerName = { first_name: string | null; last_name: string | null; company_name: string | null };
const personName = (c: CustomerName) => [c.first_name, c.last_name].filter(Boolean).join(' ') || c.company_name || 'Customer';

/**
 * "Was this customer told about the schedule": the entities (as `kind:id`) among the given jobs and leads for which
 * the workflow ledger holds a scheduling enrollment that REACHED THE CUSTOMER. The step-run row written at send time
 * is the event, so the dashboard reflects a send the moment it happens; the job row's legacy dispatch stamp records
 * only that a trigger FIRED and is not consulted. A step whose only sent audience was the crew does not count either.
 */
async function customerToldKeys(orgWhere: { organization_id: string }, jobIds: string[], leadIds: string[]): Promise<Set<string>> {
  const told = new Set<string>();
  if (jobIds.length === 0 && leadIds.length === 0) return told;
  const sentSendStep = { status: 'SENT' as const, step_type: { in: ['SEND_EMAIL' as const, 'SEND_TEXT' as const] } };
  const enrollments = await prisma.workflowEnrollment.findMany({
    where: {
      ...orgWhere,
      OR: [
        ...(jobIds.length
          ? [{ entity_type: 'job', entity_id: { in: jobIds }, workflow: { trigger_type: { in: ['JOB_SCHEDULED' as const, 'JOB_RESCHEDULED' as const] } } }]
          : []),
        ...(leadIds.length
          ? [{ entity_type: 'lead', entity_id: { in: leadIds }, workflow: { trigger_type: { in: ['WALKTHROUGH_SCHEDULED' as const, 'WALKTHROUGH_RESCHEDULED' as const] } } }]
          : []),
      ],
      step_runs: { some: sentSendStep },
    },
    select: { entity_type: true, entity_id: true, step_runs: { where: sentSendStep, select: { audience_outcomes: true } } },
  });
  for (const e of enrollments) {
    const reached = e.step_runs.some(
      (run) =>
        Array.isArray(run.audience_outcomes) &&
        run.audience_outcomes.some((o) => {
          const row = o as { audience?: unknown; outcome?: unknown } | null;
          return row?.audience === 'customer' && row?.outcome === 'sent';
        }),
    );
    if (reached) told.add(`${e.entity_type}:${e.entity_id}`);
  }
  return told;
}

async function overdueInvoices(ctx: DashContext): Promise<AttentionItem[]> {
  const { b, orgWhere } = ctx;
  const invoiceScope = await ctx.scope('Invoice');
  const rows = await prisma.invoice.findMany({
    // Cut where the LABEL cuts (`orgDayDiff` below), so this widget can never say "overdue - 0 days past due".
    where: withScope<Prisma.InvoiceWhereInput>({ ...orgWhere, status: { in: ['SENT', 'PARTIAL'] }, due_date: { lt: b.overdueBefore } }, invoiceScope),
    select: {
      id: true,
      invoice_number: true,
      due_date: true,
      amount_due: true,
      job: { select: { customer: { select: { first_name: true, last_name: true, company_name: true } } } },
    },
    orderBy: { due_date: 'asc' },
    take: 3,
  });
  return rows.map((inv) => {
    const daysPast = orgDayDiff(inv.due_date!, b.now, ctx.timeZone);
    const c = inv.job?.customer;
    const name = c?.company_name || `${c?.first_name ?? ''} ${c?.last_name ?? ''}`.trim() || 'Customer';
    return {
      id: inv.id,
      type: 'overdue_invoice',
      severity: 'danger',
      title: `Invoice ${inv.invoice_number} overdue`,
      // The amount is the invoice's own price: it shows to anyone who can open the invoice.
      meta: `${name} · ${daysPast} days past due · $${Math.round(Number(inv.amount_due)).toLocaleString()}`,
      badge: `${daysPast}d`,
      link: `/invoices/${inv.id}`,
    };
  });
}

/**
 * "N leads with no owner": the Missing lead owner test over the leads the person can open, the same count as the tile and
 * the line under Open Leads. It opens the Leads list filtered to No owner when the person may go there, else the oldest
 * of the leads they can open: always a way through.
 */
async function missingLeadOwnerItem(ctx: DashContext): Promise<AttentionItem[]> {
  const { count, oldest } = await missingLeadOwner(ctx, await ctx.scope('Lead'));
  if (count === 0 || !oldest) return [];
  return [
    {
      id: 'missing-lead-owner',
      type: 'missing_lead_owner',
      severity: 'info',
      title: `${count} lead${count !== 1 ? 's' : ''} with no owner`,
      meta: `Oldest: ${oldest.title} · ${oldest.age_days} day${oldest.age_days !== 1 ? 's' : ''} open`,
      badge: String(count),
      link: clickTarget('leads_list', ctx.values, NO_OWNER_LEADS_QUERY) ?? oldest.link,
    },
  ];
}

/**
 * Jobs past their scheduled start (still SCHEDULED - no visit has begun). Resolves each candidate's winning live visit
 * with `resolveNextJobVisit` and keeps those whose winning visit is overdue today; the WHERE is a widening pre-filter.
 */
async function jobsPastStart(ctx: DashContext): Promise<AttentionItem[]> {
  const { b } = ctx;
  const jobScope = await ctx.scope('Job');
  const candidates = await prisma.job.findMany({
    where: withScope<Prisma.JobWhereInput>(
      {
        ...ctx.orgWhere,
        status: 'SCHEDULED',
        AND: [{ visits: { some: { status: { in: [...LIVE_VISIT_STATUSES] }, scheduled_at: { gte: b.todayStart, lt: b.now } } } }],
      },
      jobScope,
    ),
    select: {
      id: true,
      job_number: true,
      scope_notes: true,
      visits: {
        where: { status: { in: [...LIVE_VISIT_STATUSES] } },
        select: {
          scheduled_at: true,
          scheduled_end: true,
          created_at: true,
          assignees: { select: { user: { select: { first_name: true, last_name: true } } } },
        },
      },
    },
    take: ATTENTION_OVERFETCH,
  });
  return candidates
    .map((job) => ({ job, visit: resolveNextJobVisit(job.visits, b.now) }))
    .filter(
      (x): x is { job: (typeof candidates)[number]; visit: NonNullable<typeof x.visit> & { scheduled_at: Date } } =>
        x.visit !== null && x.visit.scheduled_at !== null && x.visit.scheduled_at >= b.todayStart && x.visit.scheduled_at < b.now,
    )
    .sort((x, y) => x.visit.scheduled_at.getTime() - y.visit.scheduled_at.getTime())
    .slice(0, 3)
    .map(({ job, visit }) => {
      const minutesPast = Math.floor((b.now.getTime() - visit.scheduled_at.getTime()) / 60_000);
      // The winning visit's own crew: the lead tech for THIS overdue trip.
      const crewLead = visit.assignees[0]?.user;
      const techName = crewLead ? `${crewLead.first_name} ${crewLead.last_name}` : 'No crew';
      const badge = minutesPast >= 60 ? `${Math.floor(minutesPast / 60)}h` : `${minutesPast}m`;
      return {
        id: job.id,
        type: 'job_past_start',
        severity: 'danger' as const,
        title: `${job.job_number} past start time`,
        meta: `${techName} · started ${badge} ago, no check-in`,
        badge,
        link: `/jobs/${job.id}`,
      };
    });
}

async function walkthroughsNeeded(ctx: DashContext): Promise<AttentionItem[]> {
  // Multi-visit D22a: the ABSENCE of a live visit, not the retired REQUESTED placeholder.
  const leadScope = await ctx.scope('Lead');
  const leads = await prisma.lead.findMany({
    where: withScope<Prisma.LeadWhereInput>({ ...ctx.orgWhere, ...NO_LIVE_VISIT_WHERE }, leadScope),
    select: { id: true, lead_number: true, service_request: true, customer: { select: { first_name: true, last_name: true, company_name: true } } },
    orderBy: { created_at: 'asc' },
    take: 2,
  });
  return leads.map((lead) => ({
    id: lead.id,
    type: 'walkthrough_needed',
    severity: 'warning' as const,
    title: 'Walkthrough not scheduled',
    meta: `${lead.lead_number} — ${personName(lead.customer)} · requires walk before estimate`,
    badge: 'Req.',
    link: `/leads/${lead.id}`,
  }));
}

/**
 * "N visits with no crew": the Missing crew test over the jobs and leads the person can open, the same count as the tile.
 * It replaces the old line per visit inside 48 hours, so a visit is never flagged twice. It opens the Schedule's "No
 * crew" filter when the person may go there, else the soonest record: always a way through.
 */
async function missingCrewItem(ctx: DashContext): Promise<AttentionItem[]> {
  const { count, soonest } = await missingCrew(ctx);
  if (count === 0 || !soonest) return [];
  return [
    {
      id: 'missing-crew',
      type: 'missing_crew',
      severity: 'warning',
      title: `${count} visit${count !== 1 ? 's' : ''} with no crew`,
      meta: soonest.kind === 'job' ? `${soonest.number} starts ${soonest.starts_label}` : `${soonest.number} walkthrough ${soonest.starts_label}`,
      badge: soonest.until,
      link: clickTarget('schedule', ctx.values, NO_CREW_SCHEDULE_QUERY) ?? soonest.link,
    },
  ];
}

/** Customer not told: one item per parent, on its earliest upcoming visit with no scheduling message that reached the customer. */
async function customerNotTold(ctx: DashContext): Promise<AttentionItem[]> {
  const { b } = ctx;
  const arms: Prisma.VisitWhereInput[] = [];
  if (ctx.has('view_jobs')) arms.push({ job: withScope<Prisma.JobWhereInput>({ status: { not: 'CANCELLED' } }, await ctx.scope('Job')) });
  if (ctx.has('view_leads')) {
    const leadScope = await ctx.scope('Lead');
    arms.push({ lead_id: { not: null }, ...(Object.keys(leadScope).length > 0 ? { lead: leadScope } : {}) });
  }
  if (arms.length === 0) return [];
  const visits = await prisma.visit.findMany({
    where: { ...ctx.orgWhere, status: { in: [...LIVE_VISIT_STATUSES] }, scheduled_at: { gte: b.now, lte: b.attentionHorizon }, OR: arms },
    select: {
      scheduled_at: true,
      job: { select: { id: true, job_number: true, customer: { select: { first_name: true, last_name: true, company_name: true } } } },
      lead: { select: { id: true, lead_number: true, customer: { select: { first_name: true, last_name: true, company_name: true } } } },
    },
    orderBy: { scheduled_at: 'asc' },
    take: NOT_TOLD_OVERFETCH,
  });
  const told = await customerToldKeys(
    ctx.orgWhere,
    visits.flatMap((v) => (v.job ? [v.job.id] : [])),
    visits.flatMap((v) => (v.lead ? [v.lead.id] : [])),
  );
  const items: AttentionItem[] = [];
  const seen = new Set<string>();
  for (const visit of visits) {
    if (!visit.scheduled_at) continue;
    const parent = visit.job
      ? { kind: 'job' as const, id: visit.job.id, number: visit.job.job_number, customer: visit.job.customer }
      : visit.lead
        ? { kind: 'lead' as const, id: visit.lead.id, number: visit.lead.lead_number, customer: visit.lead.customer }
        : null;
    if (!parent) continue;
    const key = `${parent.kind}:${parent.id}`;
    if (seen.has(key) || told.has(key)) continue;
    seen.add(key);
    const when = visit.scheduled_at.toLocaleString('en-US', { weekday: 'short', hour: 'numeric', minute: '2-digit', timeZone: ctx.timeZone });
    const minutesAhead = Math.max(0, Math.floor((visit.scheduled_at.getTime() - b.now.getTime()) / 60_000));
    items.push({
      id: `customer-not-told-${parent.id}`,
      type: 'customer_not_told',
      severity: 'warning',
      title: parent.kind === 'job' ? `${parent.number} starts ${when}, customer not told` : `${parent.number} walkthrough ${when}, customer not told`,
      meta: `${personName(parent.customer)} · no scheduling notification has reached the customer`,
      badge: minutesAhead >= 60 ? `${Math.floor(minutesAhead / 60)}h` : `${minutesAhead}m`,
      link: parent.kind === 'job' ? `/jobs/${parent.id}` : `/leads/${parent.id}`,
    });
  }
  return items;
}

/**
 * Payments that need a person: failed payments, refunds, disputes, payouts and money that could not be applied. The
 * people who may SEE the Payments page are told (what they may do about each item is decided on the page); the number
 * is the page's own count for this caller, privacy applied. Shown to a holder who cannot open the page, with no link.
 */
async function paymentsAttention(ctx: DashContext): Promise<AttentionItem | null> {
  if (!ctx.req.ability?.can('view_payments', 'Organization')) return null;
  const { open } = await countOpenAttention(ctx.req);
  if (open === 0) return null;
  return {
    id: 'payments-attention',
    type: 'payments_attention',
    severity: 'warning',
    title: `${open} payment${open !== 1 ? 's' : ''} ${open !== 1 ? 'need' : 'needs'} attention`,
    meta: 'Failed payments, refunds, disputes and payouts',
    badge: String(open),
    link: clickTarget('payments_page', ctx.values, '?tab=payments&chip=attention'),
  };
}

export async function needsAttention(ctx: DashContext): Promise<AttentionItem[]> {
  const none = Promise.resolve<AttentionItem[]>([]);
  const [overdue, leads, pastStart, walkthroughs, crew, notTold, payments] = await Promise.all([
    ctx.has('view_invoices') ? overdueInvoices(ctx) : none,
    ctx.has('view_leads') ? missingLeadOwnerItem(ctx) : none,
    ctx.has('view_jobs') ? jobsPastStart(ctx) : none,
    ctx.has('view_leads') ? walkthroughsNeeded(ctx) : none,
    ctx.has('view_jobs') ? missingCrewItem(ctx) : none,
    customerNotTold(ctx),
    paymentsAttention(ctx),
  ]);
  const items = [...overdue, ...leads, ...pastStart, ...crew, ...walkthroughs, ...notTold];
  // Sort: danger -> warning -> info
  const severityOrder: Record<string, number> = { danger: 0, warning: 1, info: 2 };
  items.sort((a, c) => severityOrder[a.severity]! - severityOrder[c.severity]!);
  // Money that arrived and is not applied comes first, whatever else ranks: the widget shows only six rows and this
  // item sat last in its band, so it never rendered on an org with six others (slice 33b).
  if (payments) items.unshift(payments);
  return items;
}
