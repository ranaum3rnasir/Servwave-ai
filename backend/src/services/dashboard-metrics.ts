// Pure transformation helpers for the redesigned dashboard payload. Kept free of
// Prisma/IO so the branching logic (ranking, status labels, relative-time, funnel
// assembly) is unit-testable in isolation — the controller feeds these the raw
// query results. Mirrors the frontend DashboardResponse contract shapes.

export interface ScoreboardEntry {
  user_id: string | null;
  name: string;
  revenue: number;
  jobs: number;
}

/** Rank a scoreboard by revenue (desc) and cap to `limit` rows. Contributors
 *  with neither revenue nor jobs are dropped so the board shows real activity. */
export function buildScoreboard(rows: ScoreboardEntry[], limit: number): ScoreboardEntry[] {
  return rows
    .filter((r) => r.revenue > 0 || r.jobs > 0)
    .sort((a, b) => b.revenue - a.revenue)
    .slice(0, limit);
}

export interface StatusSlice {
  key: string;
  label: string;
  count: number;
}

// S4 (D17): EN_ROUTE / ON_SITE retired from JobStatus.
const JOB_STATUS_ORDER = [
  'UNSCHEDULED', 'SCHEDULED', 'IN_PROGRESS', 'COMPLETED', 'CANCELLED',
];
const JOB_STATUS_LABEL: Record<string, string> = {
  UNSCHEDULED: 'Unassigned',
  SCHEDULED: 'Scheduled',
  IN_PROGRESS: 'In progress',
  COMPLETED: 'Completed',
  CANCELLED: 'Cancelled',
};

/** Map `job.groupBy(status)` counts into labelled slices in canonical job-status
 *  order, dropping statuses with no jobs. */
export function buildJobsByStatus(groups: { status: string; count: number }[]): StatusSlice[] {
  const counts = new Map(groups.map((g) => [g.status, g.count]));
  return JOB_STATUS_ORDER.filter((s) => (counts.get(s) ?? 0) > 0).map((s) => ({
    key: s.toLowerCase(),
    label: JOB_STATUS_LABEL[s] ?? s,
    count: counts.get(s)!,
  }));
}

function plural(n: number, unit: string): string {
  return `in ${n} ${n === 1 ? unit : `${unit}s`}`;
}

/** Human relative-time label for an upcoming time ("in 15 hours"). Anything at
 *  or before `now` collapses to "now". */
export function comingUpLabel(start: Date, now: Date): string {
  const ms = start.getTime() - now.getTime();
  if (ms <= 0) return 'now';
  const mins = Math.round(ms / 60_000);
  if (mins < 60) return plural(mins, 'minute');
  const hours = Math.round(ms / 3_600_000);
  if (hours < 48) return plural(hours, 'hour');
  return plural(Math.round(ms / 86_400_000), 'day');
}

export interface ComingUpJob {
  id: string;
  in_label: string;
  title: string;
  address: string;
}

/** Map upcoming jobs into the "Coming Up" feed, labelling each by lead time. */
export function buildComingUp(
  jobs: { id: string; scheduled_start: Date | null; title: string; address: string }[],
  now: Date,
): ComingUpJob[] {
  return jobs
    .filter((j) => j.scheduled_start !== null)
    .map((j) => ({
      id: j.id,
      in_label: comingUpLabel(j.scheduled_start!, now),
      title: j.title,
      address: j.address,
    }));
}

export interface PipelineStage {
  key: string;
  label: string;
  kind: 'count' | 'amount';
  value: number;
  link: string;
}

export interface PipelineInputs {
  leads: number;
  estimatesAmount: number;
  approvedAmount: number;
  depositAmount: number;
  jobAmount: number;
  invoicedAmount: number;
  paidAmount: number;
}

/** Assemble the Lead → Estimate → Approved → Deposit → Job → Invoiced → Paid
 *  revenue funnel. Stage keys/labels/links match the frontend PipelineFunnel. */
export function buildPipeline(input: PipelineInputs): PipelineStage[] {
  return [
    { key: 'leads', label: 'Leads', kind: 'count', value: input.leads, link: '/leads' },
    { key: 'estimates', label: 'Estimates', kind: 'amount', value: input.estimatesAmount, link: '/estimates' },
    { key: 'approved', label: 'Approved', kind: 'amount', value: input.approvedAmount, link: '/estimates?status=approved' },
    { key: 'deposit', label: 'Deposit', kind: 'amount', value: input.depositAmount, link: '/estimates' },
    { key: 'job', label: 'Job done', kind: 'amount', value: input.jobAmount, link: '/jobs' },
    { key: 'invoiced', label: 'Invoiced', kind: 'amount', value: input.invoicedAmount, link: '/invoices' },
    { key: 'paid', label: 'Paid', kind: 'amount', value: input.paidAmount, link: '/invoices?status=paid' },
  ];
}

/** Title-Case a raw source/type key ("repeat", "access_control", "panic-hardware")
 *  into a display label ("Repeat", "Access Control", "Panic Hardware"). */
function titleCase(key: string): string {
  return key
    .split(/[\s_-]+/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
    .join(' ');
}

export interface LeadSourceSlice {
  source: string;
  label: string;
  lead_pct: number;
  revenue: number;
}

/** Build the Lead-Sources widget rows. Computes each source's share of total
 *  leads (rounded %), Title-Cases the label, and ranks by lead count desc.
 *  Revenue passes through (won-job revenue attributed to the source). */
export function buildLeadSources(
  rows: { source: string; leads: number; revenue: number }[],
): LeadSourceSlice[] {
  const totalLeads = rows.reduce((a, r) => a + r.leads, 0);
  return rows
    .slice()
    .sort((a, b) => b.leads - a.leads)
    .map((r) => ({
      source: r.source,
      label: titleCase(r.source),
      lead_pct: totalLeads > 0 ? Math.round((r.leads / totalLeads) * 100) : 0,
      revenue: Math.round(r.revenue),
    }));
}

export interface JobTypeSlice {
  label: string;
  pct: number;
  revenue: number;
}

/** Build the Revenue-by-Job-Type widget rows. Computes each type's share of
 *  total revenue (rounded %), Title-Cases the label, ranks by revenue desc,
 *  and drops zero-revenue types so the chart shows only real money. */
export function buildRevenueByJobType(
  rows: { job_type: string; revenue: number }[],
): JobTypeSlice[] {
  const total = rows.reduce((a, r) => a + r.revenue, 0);
  return rows
    .filter((r) => r.revenue > 0)
    .sort((a, b) => b.revenue - a.revenue)
    .map((r) => ({
      label: titleCase(r.job_type),
      pct: total > 0 ? Math.round((r.revenue / total) * 100) : 0,
      revenue: Math.round(r.revenue),
    }));
}

export interface Recurring {
  mrr: number;
  active_plans: number;
}

/** Build the Recurring (MRR) widget value. Returns null when there are no active
 *  plans so the widget hides itself; otherwise rounds the monthly-normalized MRR. */
export function buildRecurring(input: { active_plans: number; mrr: number }): Recurring | null {
  if (input.active_plans === 0) return null;
  return { mrr: Math.round(input.mrr), active_plans: input.active_plans };
}

// ── Today's Schedule lanes (jobs + walkthroughs) ─────────────────────────────

interface SchedulePerson {
  id: string;
  first_name: string;
  last_name: string;
  avatar_path: string | null;
}

interface ScheduleCustomer {
  first_name: string | null;
  last_name: string | null;
  company_name: string | null;
}

interface ScheduleLocation {
  address_line1: string;
  city: string;
}

export interface ScheduleJobIn {
  id: string;
  job_number: string;
  status: string;
  scope_notes: string | null;
  scheduled_start: Date | null;
  scheduled_end: Date | null;
  // S8 (D6): the job's crew is the union across its trips; the lane shaper flattens it.
  visits: { assignees: { user: SchedulePerson }[] }[];
  customer: ScheduleCustomer;
  service_location: ScheduleLocation | null;
}

export interface ScheduleWalkthroughIn {
  id: string;
  lead_number: string;
  service_request: string;
  walkthrough_scheduled_at: Date;
  walkthrough_duration_minutes: number | null;
  walkthrough_completed_at: Date | null;
  customer: ScheduleCustomer;
  service_location: ScheduleLocation | null;
  performers: SchedulePerson[];
}

export interface ScheduleEntry {
  id: string;
  job_number: string;
  status: string;
  scope_notes: string | null;
  scheduled_start: string | null;
  scheduled_end: string | null;
  customer_name: string;
  address: string | null;
  entity: 'job' | 'walkthrough';
}

export interface ScheduleLane {
  user_id: string | null;
  first_name: string;
  last_name: string;
  // Raw storage path, not yet signed — the caller batch-signs across every lane at once
  // (never per-lane) and swaps this for a response-safe avatar_url.
  avatar_path: string | null;
  jobs: ScheduleEntry[];
}

function scheduleCustomerName(c: ScheduleCustomer): string {
  return c.company_name || [c.first_name, c.last_name].filter(Boolean).join(' ') || 'Customer';
}

function scheduleAddress(loc: ScheduleLocation | null): string | null {
  return loc ? `${loc.address_line1}, ${loc.city}` : null;
}

/** Group the day's jobs and scheduled walkthroughs into per-tech lanes for the
 *  Today's Schedule widget. Jobs fan out per crew assignee, walkthroughs per
 *  performer; entries with no people land in the Unassigned lane (always last).
 *  Completed walkthroughs stay visible (status WALKTHROUGH_COMPLETED, keyed off
 *  walkthrough_completed_at — the lead may already be ESTIMATED/WON) for exact
 *  parity with the /schedule calendar. Each lane is sorted by scheduled_start
 *  ascending; Node's stable sort makes this a no-op for jobs-only input, which
 *  arrives pre-sorted from Prisma. */
export function buildScheduleLanes(
  jobs: ScheduleJobIn[],
  visits: ScheduleWalkthroughIn[],
): ScheduleLane[] {
  const techMap = new Map<string | null, ScheduleLane>();

  const push = (people: SchedulePerson[], entry: ScheduleEntry) => {
    if (people.length === 0) {
      if (!techMap.has(null)) {
        techMap.set(null, { user_id: null, first_name: 'Unassigned', last_name: '', avatar_path: null, jobs: [] });
      }
      techMap.get(null)!.jobs.push(entry);
    } else {
      for (const u of people) {
        if (!techMap.has(u.id)) {
          techMap.set(u.id, { user_id: u.id, first_name: u.first_name, last_name: u.last_name, avatar_path: u.avatar_path, jobs: [] });
        }
        techMap.get(u.id)!.jobs.push(entry);
      }
    }
  };

  for (const job of jobs) {
    // Crew fan-out: a multi-tech job lands in every assignee's lane (consistent
    // with the dispatch board). An empty crew falls into the Unassigned lane.
    // S8 (D6): the union across the job's trips, deduped so a person on two trips does not get
    // the same card twice in their lane.
    const crew = [...new Map(job.visits.flatMap((v) => v.assignees).map((a) => [a.user.id, a.user])).values()];
    push(crew, {
      id: job.id,
      job_number: job.job_number,
      status: job.status,
      scope_notes: job.scope_notes,
      scheduled_start: job.scheduled_start?.toISOString() ?? null,
      scheduled_end: job.scheduled_end?.toISOString() ?? null,
      customer_name: scheduleCustomerName(job.customer),
      address: scheduleAddress(job.service_location),
      entity: 'job',
    });
  }

  for (const wt of visits) {
    const start = wt.walkthrough_scheduled_at;
    const end = new Date(start.getTime() + (wt.walkthrough_duration_minutes || 60) * 60_000);
    push(wt.performers, {
      id: wt.id,
      job_number: wt.lead_number,
      status: wt.walkthrough_completed_at ? 'WALKTHROUGH_COMPLETED' : 'WALKTHROUGH',
      scope_notes: wt.service_request,
      scheduled_start: start.toISOString(),
      scheduled_end: end.toISOString(),
      customer_name: scheduleCustomerName(wt.customer),
      address: scheduleAddress(wt.service_location),
      entity: 'walkthrough',
    });
  }

  // Two independently-ordered sources were merged: re-sort each lane by start
  // time. Stable, so pre-sorted jobs-only lanes come out byte-identical.
  for (const lane of techMap.values()) {
    lane.jobs.sort((a, b) => (a.scheduled_start ?? '').localeCompare(b.scheduled_start ?? ''));
  }

  // Assigned techs first, unassigned last
  const lanes: ScheduleLane[] = [];
  for (const [key, lane] of techMap.entries()) {
    if (key !== null) lanes.push(lane);
  }
  if (techMap.has(null)) lanes.push(techMap.get(null)!);
  return lanes;
}
