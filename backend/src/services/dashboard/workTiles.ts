import type { Prisma } from '@prisma/client';
import { prisma } from '../../lib/prisma';
import { COMPLETED_OR_LATER_JOB_STATUSES } from '../../lib/job-status-order';
import { FINISHED_VISIT_STATUS, LIVE_VISIT_STATUSES } from '../../lib/visit-status';
import { orgMonthWindow } from '../../lib/orgDayRange';
import { SCOPE_SWITCH_KEY } from '../../lib/permissions/switches/catalog';
import { jobsOfOwnWorkWhere } from '../../lib/permissions/ownSet';
import { jobCrewIds } from '../../lib/job-crew';
import { excludePlanVisitJobsWhere } from '../../lib/job-plan-visits';
import { resolveNextJobVisit } from '../walkthrough.service';
import { buildScoreboard, buildJobsByStatus, buildComingUp, buildLeadSources } from '../dashboard-metrics';
import { clickTarget } from '../../lib/dashboard/clickTargets';
import { reviewQueueWheres } from '../../lib/job-review-queue';
import { missingLeadOwnerWhereIn } from '../../lib/missingLeadOwner';
import { missingCrewVisitWhereIn } from '../../lib/missingCrew';
import { leadClosedWhereIn } from '../../lib/leadClosed';
import { OPEN_LEAD_STATUSES } from '../lead-status-options';
import { REVIEW_PANEL } from '../notifications/jobCompletedAlert';
import { withScope, type DashContext, type Where } from './context';

/**
 * The count tiles about jobs and leads (PRD 9). Each one asks the access resolver for the records the person can
 * open (`ctx.scope`) and counts only those, so the numbers always match the list pages they lead to.
 */

/**
 * S8 repoint (D14): "does this job have a trip in this window" - the reference pattern from `buildJobListWhere`.
 * Composed under `AND` by every call site (never assigned onto `where.visits`) so a row scope on the same query can
 * never be clobbered. The second OR arm exists because a CANCELLED job holds nothing but cancelled trips.
 */
export function visitInWindowClause(window: { gte?: Date; lte?: Date; lt?: Date; gt?: Date }): Record<string, unknown> {
  return {
    OR: [
      { visits: { some: { scheduled_at: window, status: { not: 'CANCELLED' } } } },
      { status: 'CANCELLED' as const, visits: { some: { scheduled_at: window } } },
    ],
  };
}

// Prisma cannot ORDER BY a to-many relation's resolved value, so "coming up" over-fetches a bounded cap and
// resolves, sorts and slices in application code.
const COMING_UP_OVERFETCH = 40; // widget shows top 6

export async function jobsToday(ctx: DashContext) {
  const { b, orgWhere } = ctx;
  const jobScope = await ctx.scope('Job');
  // Backward-looking: "did this job have a trip today", so it reads the visit set.
  const [groups, yesterdayCount] = await Promise.all([
    prisma.job.groupBy({
      by: ['status'],
      where: withScope<Prisma.JobWhereInput>(
        { ...orgWhere, status: { not: 'CANCELLED' }, AND: [visitInWindowClause({ gte: b.todayStart, lte: b.todayEnd })] },
        jobScope,
      ),
      _count: { _all: true },
    }),
    prisma.job.count({
      where: withScope<Prisma.JobWhereInput>(
        { ...orgWhere, status: { not: 'CANCELLED' }, AND: [visitInWindowClause({ gte: b.yesterdayStart, lte: b.yesterdayEnd })] },
        jobScope,
      ),
    }),
  ]);
  const byStatus: Record<string, number> = {};
  for (const g of groups) byStatus[g.status as string] = g._count._all;
  const total = Object.values(byStatus).reduce((a, c) => a + c, 0);
  return {
    total,
    scheduled: byStatus['SCHEDULED'] ?? 0,
    // S4 (D17): EN_ROUTE/ON_SITE retired from JobStatus, so there is nothing left to fold.
    in_progress: byStatus['IN_PROGRESS'] ?? 0,
    completed: COMPLETED_OR_LATER_JOB_STATUSES.reduce((n, s) => n + (byStatus[s] ?? 0), 0),
    vs_yesterday: total - yesterdayCount,
  };
}

export async function jobsWeek(ctx: DashContext) {
  const { b, orgWhere } = ctx;
  const jobScope = await ctx.scope('Job');
  const [completed, scheduled] = await Promise.all([
    prisma.job.count({
      where: withScope<Prisma.JobWhereInput>(
        { ...orgWhere, status: { in: [...COMPLETED_OR_LATER_JOB_STATUSES] }, completed_at: { gte: b.weekStart, lte: b.weekEnd } },
        jobScope,
      ),
    }),
    prisma.job.count({
      where: withScope<Prisma.JobWhereInput>(
        { ...orgWhere, status: { not: 'CANCELLED' }, AND: [visitInWindowClause({ gte: b.weekStart, lte: b.weekEnd })] },
        jobScope,
      ),
    }),
  ]);
  return { completed, scheduled };
}

/**
 * Open leads (those in an open status) over the leads a row scope reaches. Read once per request however many tiles ask
 * (Open Leads and Needs Attention both want them).
 */
export function openLeadCount(ctx: DashContext, leadScope: Where): Promise<number> {
  return ctx.memo(`openLeadCount:${JSON.stringify(leadScope)}`, async () => {
    const groups = await prisma.lead.groupBy({
      by: ['status'],
      where: withScope<Prisma.LeadWhereInput>({ ...ctx.orgWhere, status: { in: [...OPEN_LEAD_STATUSES] } }, leadScope),
      _count: { _all: true },
    });
    return groups.reduce((sum, g) => sum + g._count._all, 0);
  });
}

/**
 * The Missing lead owner count over the leads a row scope reaches: the shared test (`lib/missingLeadOwner`, the one the
 * Leads page's No owner card reads) through the same builder. The tile, the Needs Attention item and the line under Open
 * Leads all ask here, so the count is read once per request whichever of them asks first, and alone.
 */
export function missingLeadOwnerCount(ctx: DashContext, leadScope: Where): Promise<number> {
  return ctx.memo(`missingLeadOwnerCount:${JSON.stringify(leadScope)}`, () =>
    prisma.lead.count({ where: missingLeadOwnerWhereIn(ctx.orgWhere, leadScope) }),
  );
}

export interface MissingLeadOwnerSummary {
  count: number;
  /** The lead that has been open longest with no Owner, or null when none is. */
  oldest: { id: string; lead_number: string; title: string; age_days: number; link: string } | null;
}

/** "Count plus the oldest one" for the tile and the Needs Attention item: the lookup runs only when there is a lead to find. */
export function missingLeadOwner(ctx: DashContext, leadScope: Where): Promise<MissingLeadOwnerSummary> {
  return ctx.memo(`missingLeadOwner:${JSON.stringify(leadScope)}`, async () => {
    const count = await missingLeadOwnerCount(ctx, leadScope);
    if (count === 0) return { count, oldest: null };
    const row = await prisma.lead.findFirst({
      where: missingLeadOwnerWhereIn(ctx.orgWhere, leadScope),
      select: { id: true, lead_number: true, created_at: true, customer: { select: { first_name: true, last_name: true, company_name: true } } },
      orderBy: [{ created_at: 'asc' }, { id: 'asc' }],
    });
    if (!row) return { count, oldest: null };
    const c = row.customer;
    return {
      count,
      oldest: {
        id: row.id,
        lead_number: row.lead_number,
        title: [c.first_name, c.last_name].filter(Boolean).join(' ') || c.company_name || 'Customer',
        age_days: Math.max(0, Math.floor((ctx.b.now.getTime() - row.created_at.getTime()) / 86_400_000)),
        link: `/leads/${row.id}`,
      },
    };
  });
}

export interface MissingCrewSummary {
  count: number;
  /** The visit that starts soonest with nobody on it, named by its job or lead; null when there is none. */
  soonest: {
    id: string;
    kind: 'job' | 'lead';
    number: string;
    title: string;
    starts_at: string;
    /** When it starts on the company's clock ("Thu 9:00 AM"). */
    starts_label: string;
    /** How long until it starts: whole days from a day out ("2d"), else hours ("5h"). */
    until: string;
    link: string;
  } | null;
}

/**
 * The Missing crew visits over the jobs and the leads the person can open, count plus the soonest: the shared test
 * (`lib/missingCrew`, the one the Schedule's "No crew" filter reads) through the same builder. The tile and the Needs
 * Attention item both ask here (the tile is this function), so the count is read once per request whichever asks first. Walkthroughs are part of it
 * only with View leads; without it they are not read at all.
 */
export function missingCrew(ctx: DashContext): Promise<MissingCrewSummary> {
  return ctx.memo('missingCrew', async () => {
    const [job, lead] = await Promise.all([ctx.scope('Job'), ctx.has('view_leads') ? ctx.scope('Lead') : null]);
    const where = missingCrewVisitWhereIn(ctx.orgWhere, { job, lead }, ctx.b.now, ctx.timeZone);
    const count = await prisma.visit.count({ where });
    if (count === 0) return { count, soonest: null };
    const row = await prisma.visit.findFirst({
      where,
      select: {
        scheduled_at: true,
        job: { select: { id: true, job_number: true, customer: { select: { first_name: true, last_name: true, company_name: true } } } },
        lead: { select: { id: true, lead_number: true, customer: { select: { first_name: true, last_name: true, company_name: true } } } },
      },
      orderBy: [{ scheduled_at: 'asc' }, { id: 'asc' }],
    });
    const parent = row?.job
      ? { kind: 'job' as const, id: row.job.id, number: row.job.job_number, customer: row.job.customer, link: `/jobs/${row.job.id}` }
      : row?.lead
        ? { kind: 'lead' as const, id: row.lead.id, number: row.lead.lead_number, customer: row.lead.customer, link: `/leads/${row.lead.id}` }
        : null;
    if (!row?.scheduled_at || !parent) return { count, soonest: null };
    const c = parent.customer;
    const hours = Math.max(0, Math.floor((row.scheduled_at.getTime() - ctx.b.now.getTime()) / 3_600_000));
    return {
      count,
      soonest: {
        id: parent.id,
        kind: parent.kind,
        number: parent.number,
        title: [c.first_name, c.last_name].filter(Boolean).join(' ') || c.company_name || 'Customer',
        starts_at: row.scheduled_at.toISOString(),
        // The company's clock, not the server's: "Thu 9:00 AM" has to be the 9:00 AM the crew is expected at.
        starts_label: row.scheduled_at.toLocaleString('en-US', { weekday: 'short', hour: 'numeric', minute: '2-digit', timeZone: ctx.timeZone }),
        until: hours >= 24 ? `${Math.floor(hours / 24)}d` : `${hours}h`,
        link: parent.link,
      },
    };
  });
}

export interface JobsThisMonth {
  /** The jobs in the person's scope with a visit that is not cancelled this month. */
  jobs: number;
  /** Those visits the crew finished, whatever their job's status (a finished visit never completes its job). */
  finished: number;
  /** Those visits still live: Scheduled, En route, On site or In progress. */
  still_to_do: number;
}

/**
 * Jobs this month: the jobs in the person's Jobs scope with a visit scheduled this calendar month on the company's
 * clock, and the visits themselves split into finished and still to do. A cancelled visit is neither and does not make its
 * job count. Under scope Attached only the visits the person is crew on count: being attached to a job opens it, but the
 * other crew's visits are not this person's month (the same rule as Today's Schedule). One grouped read of the visits
 * answers all three figures: a row per job and status, folded here.
 */
export async function jobsThisMonth(ctx: DashContext): Promise<JobsThisMonth> {
  const jobScope = await ctx.scope('Job');
  const month = orgMonthWindow(ctx.timeZone, ctx.b.now);
  const attached = ctx.values[SCOPE_SWITCH_KEY.Job] === 'attached';
  const groups = await prisma.visit.groupBy({
    by: ['job_id', 'status'],
    where: {
      ...ctx.orgWhere,
      // A job's visits only: a lead's walkthroughs live in the same table.
      job_id: { not: null },
      status: { in: [FINISHED_VISIT_STATUS, ...LIVE_VISIT_STATUSES] },
      scheduled_at: month,
      ...(Object.keys(jobScope).length > 0 ? { job: { AND: [jobScope as Prisma.JobWhereInput] } } : {}),
      ...(attached ? { assignees: { some: { user_id: ctx.userId } } } : {}),
    },
    _count: { _all: true },
  });
  const jobs = new Set<string>();
  let finished = 0;
  let stillToDo = 0;
  for (const g of groups) {
    jobs.add(g.job_id!);
    if (g.status === FINISHED_VISIT_STATUS) finished += g._count._all;
    else stillToDo += g._count._all;
  }
  return { jobs: jobs.size, finished, still_to_do: stillToDo };
}

export interface CompletedJobsValue {
  /** The jobs in scope that reached Completed this month. */
  jobs: number;
  /** What was invoiced on those jobs, in dollars (a job with no invoice adds nothing and still counts as a job). */
  value: number;
}

/**
 * Completed jobs value: the invoiced value of the jobs in scope that reached Completed this month on the company's clock
 * ("reached Completed" is the job's completed date inside the month and a status in the completed-or-later set, so a
 * reopened job, whose completed date Reopen clears, and a Cancelled job never count), with the job count.
 *
 * A job's invoiced value is its `amount_invoiced`, the one figure the pipeline's "Job completed" stage, the scoreboards and the
 * revenue report already sum: the totals of its standard invoices, tax included, less any voided. A deposit invoice is not
 * in it, so a deposit applied to the final invoice is counted once, in that invoice's total. A job with no invoice is 0.
 *
 * The jobs are `ctx.money('Job')`, the same rule every money tile uses: the person's own set without See company figures
 * (whatever their Jobs scope), the Jobs scope's set with it. A job shared by a crew counts in full for each member. Under
 * Attached or Team a service plan's visit job is left out when the person's only link is the Sold By copied from
 * the plan. One aggregate answers both figures.
 */
export async function completedJobsValue(ctx: DashContext): Promise<CompletedJobsValue> {
  const reach = await ctx.money('Job');
  const mode = ctx.modeOf('completed_jobs_value');
  const scope = mode === 'own' ? 'attached' : ctx.values[SCOPE_SWITCH_KEY.Job];
  const ownWork = scope === 'attached' || scope === 'team' ? jobsOfOwnWorkWhere(scope, ctx.req.user!) : {};
  const agg = await prisma.job.aggregate({
    where: withScope<Prisma.JobWhereInput>(
      { ...ctx.orgWhere, status: { in: [...COMPLETED_OR_LATER_JOB_STATUSES] }, completed_at: orgMonthWindow(ctx.timeZone, ctx.b.now) },
      reach,
      ownWork,
    ),
    _sum: { amount_invoiced: true },
    _count: { _all: true },
  });
  return { jobs: agg._count._all, value: Number(agg._sum.amount_invoiced ?? 0) };
}

/** The estimates the Estimates still to send tile draws: the few that have waited longest. */
const ESTIMATE_ROWS = 5;

export interface EstimatesToSend {
  /** Every draft estimate the person can open. */
  count: number;
  /** The oldest few, each a row that opens its estimate. */
  estimates: Array<{ id: string; estimate_number: string; title: string; total: number; link: string }>;
}

/**
 * Estimates still to send: the draft estimates the person can open, the oldest first, with the count over all of them. What
 * the person can open is `ctx.scope('Estimate')`, the row scope the Estimates list is built from: the reach the Leads and Jobs
 * scopes give plus the estimates the person made for a customer alone, so there is one answer to "which
 * estimates can this person open". "Draft" is the status Draft and nothing else: a sent estimate leaves, and so does one that
 * was won, declined, expired, archived or superseded; an estimate recalled to draft for a revision is a draft again.
 *
 * A row is the estimate's number, its customer's name and its total: the record's own price, which shows to anyone who can open
 * the estimate (no See company figures needed), with no cost, margin or contact detail and no sum across rows, which would
 * be a company figure. The customer's name is part of the record, as it is on the Estimates list. With nothing to send the
 * rows (and the customers they name) are not read at all.
 */
export async function estimatesToSend(ctx: DashContext): Promise<EstimatesToSend> {
  const where = withScope<Prisma.EstimateWhereInput>({ ...ctx.orgWhere, status: 'DRAFT' }, await ctx.scope('Estimate'));
  const count = await prisma.estimate.count({ where });
  const rows = count === 0 ? [] : await prisma.estimate.findMany({
    where,
    orderBy: [{ created_at: 'asc' }, { id: 'asc' }],
    take: ESTIMATE_ROWS,
    select: {
      id: true,
      estimate_number: true,
      total_amount: true,
      customer: { select: { first_name: true, last_name: true, company_name: true } },
    },
  });
  return {
    count,
    estimates: rows.map((e) => {
      const c = e.customer;
      return {
        id: e.id,
        estimate_number: e.estimate_number,
        title: [c.first_name, c.last_name].filter(Boolean).join(' ') || c.company_name || 'Customer',
        total: Number(e.total_amount),
        link: `/estimates/${e.id}`,
      };
    }),
  };
}

export async function openLeads(ctx: DashContext) {
  const leadScope = await ctx.scope('Lead');
  const [count, no_owner] = await Promise.all([openLeadCount(ctx, leadScope), missingLeadOwnerCount(ctx, leadScope)]);
  return { count, no_owner };
}

/** The Missing lead owner tile: the open leads in the person's scope with no Owner, and the oldest of them. */
export async function missingLeadOwnerTile(ctx: DashContext) {
  return missingLeadOwner(ctx, await ctx.scope('Lead'));
}

export async function closeRate(ctx: DashContext) {
  return closeRateOver(ctx, await ctx.scope('Lead'));
}

/** Won against Lost over the leads a row scope reaches ({} for every lead), the last 30 days against the 30 before. */
export function closeRateOver(ctx: DashContext, leadScope: Where) {
  // Close Rate and Smart Insights ask the same question of the same leads: one read between them.
  return ctx.memo(`closeRate:${JSON.stringify(leadScope)}`, () => readCloseRate(ctx, leadScope));
}

async function readCloseRate(ctx: DashContext, leadScope: Where) {
  const { b, orgWhere } = ctx;
  // Two reads whatever the windows hold: the last 30 days and the 30 before, each grouped into Won and Lost.
  const [current, prior] = await Promise.all([
    prisma.lead.groupBy({ by: ['status'], where: leadClosedWhereIn(orgWhere, leadScope, { gte: b.thirtyDaysAgo }), _count: { _all: true } }),
    prisma.lead.groupBy({
      by: ['status'],
      where: leadClosedWhereIn(orgWhere, leadScope, { gte: b.sixtyDaysAgo, lt: b.thirtyDaysAgo }),
      _count: { _all: true },
    }),
  ]);
  const counts = (groups: typeof current) => {
    const map: Record<string, number> = {};
    for (const g of groups) map[g.status as string] = g._count._all;
    return { won: map['WON'] ?? 0, lost: map['LOST'] ?? 0 };
  };
  const rate = (c: { won: number; lost: number }) => (c.won + c.lost > 0 ? Math.round((c.won / (c.won + c.lost)) * 100) : 0);
  const now = counts(current);
  return { rate: rate(now), won: now.won, lost: now.lost, vs_last_period_pp: rate(now) - rate(counts(prior)) };
}

export async function jobsByStatus(ctx: DashContext) {
  const jobScope = await ctx.scope('Job');
  const groups = await prisma.job.groupBy({
    by: ['status'],
    where: withScope<Prisma.JobWhereInput>({ ...ctx.orgWhere, status: { not: 'CANCELLED' } }, jobScope),
    _count: { _all: true },
  });
  return buildJobsByStatus(groups.map((g) => ({ status: g.status as string, count: g._count._all })));
}

export async function comingUp(ctx: DashContext) {
  const { b, orgWhere } = ctx;
  const jobScope = await ctx.scope('Job');
  // S8 repoint (D14(ii)): forward-looking - resolves each candidate's next live visit with `resolveNextJobVisit`.
  // The WHERE is a widening pre-filter; the resolve, sort and slice below decide the final 6.
  const rows = await prisma.job.findMany({
    where: withScope<Prisma.JobWhereInput>(
      {
        ...orgWhere,
        status: { notIn: ['CANCELLED', ...COMPLETED_OR_LATER_JOB_STATUSES] },
        AND: [
          {
            visits: {
              some: {
                status: { in: [...LIVE_VISIT_STATUSES] },
                OR: [{ scheduled_end: { gt: b.now } }, { scheduled_end: null, scheduled_at: { gt: b.now } }],
              },
            },
          },
        ],
      },
      jobScope,
    ),
    select: {
      id: true,
      customer: { select: { first_name: true, last_name: true, company_name: true } },
      service_location: { select: { address_line1: true, city: true } },
      // Unfiltered by time beyond LIVE - resolveNextJobVisit needs the full live-visit set.
      visits: { where: { status: { in: [...LIVE_VISIT_STATUSES] } }, select: { scheduled_at: true, scheduled_end: true, created_at: true } },
    },
    take: COMING_UP_OVERFETCH,
  });
  const resolved = rows
    .map((j) => ({ j, visit: resolveNextJobVisit(j.visits, b.now) }))
    .filter(
      (x): x is { j: (typeof rows)[number]; visit: NonNullable<typeof x.visit> & { scheduled_at: Date } } =>
        x.visit !== null && x.visit.scheduled_at !== null && (x.visit.scheduled_end ?? x.visit.scheduled_at).getTime() > b.now.getTime(),
    )
    .sort((a, c) => a.visit.scheduled_at.getTime() - c.visit.scheduled_at.getTime())
    .slice(0, 6);
  return buildComingUp(
    resolved.map(({ j, visit }) => {
      const c = j.customer;
      const title = c.company_name || [c.first_name, c.last_name].filter(Boolean).join(' ') || 'Customer';
      const address = j.service_location ? `${j.service_location.address_line1}, ${j.service_location.city}` : '';
      return { id: j.id, scheduled_start: visit.scheduled_at, title, address };
    }),
    b.now,
  ).map((row) => ({ ...row, link: `/jobs/${row.id}` }));
}

/** "Count plus the oldest few": the tile draws this many jobs and the server sends no more than it draws. */
const UNSCHEDULED_ROWS = 5;
const QUEUE_ROWS = 5;

/**
 * Jobs waiting for a visit: the person's jobs whose STORED status is Unscheduled (the status the server derives from
 * the visit set). A job whose visits are all finished stays In Progress, and Cancelled and the completed-or-later set
 * are other statuses, so equality on the stored status leaves every one of them out. The count is over everything in
 * the person's scope; the rows are the ones that have waited longest, each opening its job.
 *
 * "View all" opens the Jobs list, which leaves out a service plan's visit jobs (they are managed in the Service Plans
 * module), so the tile leaves them out with the same clause and its number is the list's total.
 */
export async function unscheduledJobs(ctx: DashContext) {
  const where = withScope<Prisma.JobWhereInput>({ ...ctx.orgWhere, status: 'UNSCHEDULED', ...excludePlanVisitJobsWhere }, await ctx.scope('Job'));
  // Nothing waiting is the common answer, and then the rows (and the customers and places they name) are not read at all.
  const count = await prisma.job.count({ where });
  const rows = count === 0 ? [] : await prisma.job.findMany({
    where,
    orderBy: [{ created_at: 'asc' }, { id: 'asc' }],
    take: UNSCHEDULED_ROWS,
    select: {
      id: true,
      job_number: true,
      created_at: true,
      customer: { select: { first_name: true, last_name: true, company_name: true } },
      service_location: { select: { address_line1: true, city: true } },
    },
  });
  return {
    count,
    jobs: rows.map((j) => {
      const c = j.customer;
      return {
        id: j.id,
        job_number: j.job_number,
        title: c.company_name || [c.first_name, c.last_name].filter(Boolean).join(' ') || 'Customer',
        address: j.service_location ? `${j.service_location.address_line1}, ${j.service_location.city}` : '',
        age_days: Math.max(0, Math.floor((ctx.b.now.getTime() - j.created_at.getTime()) / 86_400_000)),
        link: `/jobs/${j.id}`,
      };
    }),
  };
}

/**
 * Jobs waiting for an office review (PRD 6's queue, for a holder of Office review): the jobs in Office review that the
 * person can open. The count and the rows both come from the queue rule (`lib/job-review-queue`), within the person's
 * Jobs scope, so the tile always agrees with the Jobs menu count. No one owns a review, so there is no per-person
 * version: it is every waiting job the person can open, the ones that have waited longest first. A row opens the job
 * with the review panel open.
 */
export async function officeReviewQueue(ctx: DashContext) {
  const scopeWhere = { ...ctx.orgWhere, ...(await ctx.scope('Job')) } as Prisma.JobWhereInput;
  const where = reviewQueueWheres(ctx.req.ability, scopeWhere).office_review;
  // The tile exists only for a holder, so the queue is always there; a person who somehow is not one gets an empty tile.
  if (!where) return { count: 0, jobs: [] };
  // The tenant rides at the top of every dashboard query as well as inside the queue's own clause (where the tenant
  // guard tests look for it); the clause itself is the queue rule's, unchanged.
  const inTenant = (w: Prisma.JobWhereInput): Prisma.JobWhereInput => ({ ...ctx.orgWhere, ...w });
  // The count and the rows are the same clause, so the tile agrees with the Jobs menu count; with nothing waiting the
  // rows (and the customers and places they name) are not read at all.
  const count = await prisma.job.count({ where: inTenant(where) });
  const rows = count === 0 ? [] : await prisma.job.findMany({
    where: inTenant(where),
    orderBy: [{ created_at: 'asc' }, { id: 'asc' }],
    take: QUEUE_ROWS,
    select: {
      id: true,
      job_number: true,
      created_at: true,
      customer: { select: { first_name: true, last_name: true, company_name: true } },
      service_location: { select: { address_line1: true, city: true } },
    },
  });
  return {
    count,
    jobs: rows.map((j) => {
      const c = j.customer;
      return {
        id: j.id,
        job_number: j.job_number,
        title: c.company_name || [c.first_name, c.last_name].filter(Boolean).join(' ') || 'Customer',
        address: j.service_location ? `${j.service_location.address_line1}, ${j.service_location.city}` : '',
        age_days: Math.max(0, Math.floor((ctx.b.now.getTime() - j.created_at.getTime()) / 86_400_000)),
        link: `/jobs/${j.id}?panel=${REVIEW_PANEL}`,
      };
    }),
  };
}

type NamedUser = { id: string; first_name: string; last_name: string };
async function namesOf(ids: string[]): Promise<Map<string, NamedUser>> {
  if (ids.length === 0) return new Map();
  const users = await prisma.user.findMany({ where: { id: { in: ids } }, select: { id: true, first_name: true, last_name: true } });
  return new Map(users.map((u) => [u.id, u]));
}

/** The name on a scoreboard row whose person is no longer in the system (the foreign keys make this rare). */
const FORMER_USER = 'Former user';

/** A scoreboard's rows: the revenue column is a company figure, so it is built only for a person who holds it. */
function scoreboardRows<T extends { revenue: number }>(rows: T[], ctx: DashContext): Omit<T, 'revenue'>[] | T[] {
  return ctx.sees ? rows : rows.map(({ revenue: _revenue, ...rest }) => rest);
}

/** Completed jobs (the completed-or-later set) and invoiced revenue per crew member; a job shared by a crew counts toward each. */
export async function techScoreboard(ctx: DashContext) {
  const jobScope = await ctx.scope('Job');
  const jobs = await prisma.job.findMany({
    where: withScope<Prisma.JobWhereInput>({ ...ctx.orgWhere, status: { in: [...COMPLETED_OR_LATER_JOB_STATUSES] } }, jobScope),
    select: { amount_invoiced: true, visits: { select: { assignees: { select: { user_id: true } } } } },
  });
  const agg = new Map<string, { revenue: number; jobs: number }>();
  for (const j of jobs) {
    const rev = Number(j.amount_invoiced ?? 0);
    for (const userId of jobCrewIds(j)) {
      const cur = agg.get(userId) ?? { revenue: 0, jobs: 0 };
      cur.revenue += rev;
      cur.jobs += 1;
      agg.set(userId, cur);
    }
  }
  const users = await namesOf([...agg.keys()]);
  const rows = buildScoreboard(
    [...agg.entries()].map(([user_id, a]) => {
      const u = users.get(user_id);
      return { user_id, name: u ? `${u.first_name} ${u.last_name}`.trim() : FORMER_USER, revenue: a.revenue, jobs: a.jobs };
    }),
    5,
    ctx.sees ? 'revenue' : 'jobs',
  );
  return scoreboardRows(rows, ctx);
}

/** Completed jobs grouped by the job's current Dispatcher; the jobs with none are one row of their own, "No dispatcher". */
export async function dispatchScoreboard(ctx: DashContext) {
  const jobScope = await ctx.scope('Job');
  const groups = await prisma.job.groupBy({
    by: ['dispatcher_id'],
    where: withScope<Prisma.JobWhereInput>(
      { ...ctx.orgWhere, status: { in: [...COMPLETED_OR_LATER_JOB_STATUSES] } },
      jobScope,
    ),
    _sum: { amount_invoiced: true },
    _count: { _all: true },
  });
  const users = await namesOf(groups.map((g) => g.dispatcher_id).filter((id): id is string => id !== null));
  const rows = buildScoreboard(
    groups.map((g) => {
      const u = g.dispatcher_id ? users.get(g.dispatcher_id) : undefined;
      return {
        user_id: g.dispatcher_id,
        name: g.dispatcher_id === null ? 'No dispatcher' : u ? `${u.first_name} ${u.last_name}`.trim() : FORMER_USER,
        revenue: Number(g._sum.amount_invoiced ?? 0),
        jobs: g._count._all,
      };
    }),
    5,
    ctx.sees ? 'revenue' : 'jobs',
  );
  return scoreboardRows(rows, ctx);
}

/** Lead counts by source over the leads the person can open; the revenue per source is a company figure. */
export async function leadSources(ctx: DashContext) {
  const rows = await leadSourceRows(ctx, await ctx.scope('Lead'), ctx.sees ? await ctx.scope('Job') : null);
  // A row leads to the Leads list filtered to its source (the raw key, which is what that list's filter reads).
  const linked = rows.map((row) => ({ ...row, link: clickTarget('leads_list', ctx.values, `?source=${row.source}`) }));
  return scoreboardRows(linked, ctx);
}

/** Lead-source rows over the leads a row scope reaches; with a job scope, the revenue the completed jobs brought in. */
export function leadSourceRows(ctx: DashContext, leadScope: Where, jobScope: Where | null) {
  // Lead Sources and Smart Insights read the same rows when both look at the whole company: one read between them.
  return ctx.memo(`leadSourceRows:${JSON.stringify([leadScope, jobScope])}`, () => readLeadSourceRows(ctx, leadScope, jobScope));
}

async function readLeadSourceRows(ctx: DashContext, leadScope: Where, jobScope: Where | null) {
  const groups = await prisma.lead.groupBy({
    by: ['source'],
    where: withScope<Prisma.LeadWhereInput>({ ...ctx.orgWhere, source: { not: null } }, leadScope),
    _count: { _all: true },
  });
  // Lead-source revenue (job -> estimate -> lead.source) over the jobs the person's Jobs scope reaches.
  const revenue = new Map<string, number>();
  if (jobScope) {
    const jobs = await prisma.job.findMany({
      where: withScope<Prisma.JobWhereInput>(
        { ...ctx.orgWhere, status: { in: [...COMPLETED_OR_LATER_JOB_STATUSES] }, estimate_id: { not: null } },
        jobScope,
      ),
      select: { amount_invoiced: true, estimate: { select: { lead: { select: { source: true } } } } },
    });
    for (const j of jobs) {
      const src = j.estimate?.lead?.source;
      if (src) revenue.set(src, (revenue.get(src) ?? 0) + Number(j.amount_invoiced ?? 0));
    }
  }
  return buildLeadSources(
    groups
      .filter((g): g is typeof g & { source: string } => g.source !== null)
      .map((g) => ({ source: g.source, leads: g._count._all, revenue: revenue.get(g.source) ?? 0 })),
  );
}
