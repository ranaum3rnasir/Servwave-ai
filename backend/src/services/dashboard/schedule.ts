import type { Prisma } from '@prisma/client';
import { prisma } from '../../lib/prisma';
import { signAvatarPaths, resolveAvatarUrl } from '../../lib/avatar';
import { SCOPE_SWITCH_KEY } from '../../lib/permissions/switches/catalog';
import { buildScheduleLanes } from '../dashboard-metrics';
import { visitInWindowClause } from './workTiles';
import { withScope, type DashContext } from './context';

/**
 * Today's Schedule (PRD 9). The job lanes follow the person's Jobs scope and the walkthrough lane their Leads scope
 * (it needs View leads, and is left out without it). Under scope Attached the card is the person's own work: only the
 * visits and walkthroughs they are on the crew of. Being a job's Sold By or Dispatcher opens the job but puts no other
 * crew's visit on this card.
 */
export async function scheduleToday(ctx: DashContext) {
  const { b, orgWhere } = ctx;
  const departmentId = ctx.scheduleDepartmentId;
  const jobsAttached = ctx.values[SCOPE_SWITCH_KEY.Job] === 'attached';
  const leadsAttached = ctx.values[SCOPE_SWITCH_KEY.Lead] === 'attached';
  const me = ctx.userId;
  const window = { gte: b.scheduleDateStart, lte: b.scheduleDateEnd };

  const jobs = await (async () => {
    const jobScope = await ctx.scope('Job');
    return prisma.job.findMany({
      where: withScope<Prisma.JobWhereInput>(
        {
          ...orgWhere,
          status: { not: 'CANCELLED' },
          AND: [
            visitInWindowClause(window),
            // S8 (D6): crew through the trips. The sibling clause on the walkthrough query below looks identical but is
            // on `prisma.visit`, where `assignees` is the real relation - do not "tidy" the two into one shape.
            ...(departmentId ? [{ visits: { some: { assignees: { some: { user: { department_id: departmentId } } } } } }] : []),
            // Attached: the person is on the crew of a trip in the window.
            ...(jobsAttached
              ? [{ visits: { some: { scheduled_at: window, status: { not: 'CANCELLED' as const }, assignees: { some: { user_id: me } } } } }]
              : []),
          ],
        },
        jobScope,
      ),
      select: {
        id: true,
        job_number: true,
        status: true,
        scope_notes: true,
        visits: {
          select: {
            scheduled_at: true,
            scheduled_end: true,
            status: true,
            assignees: { select: { user: { select: { id: true, first_name: true, last_name: true, avatar_path: true } } } },
          },
        },
        customer: { select: { first_name: true, last_name: true, company_name: true } },
        service_location: { select: { address_line1: true, city: true } },
      },
    });
  })();

  // The walkthrough lane belongs to the Leads category.
  const walkthroughs = ctx.has('view_leads')
    ? await (async () => {
        const leadScope = await ctx.scope('Lead');
        return prisma.visit.findMany({
          where: {
            ...orgWhere,
            // LEAD visits only: `visits` holds a job's trips too, and without this every scheduled job turns up here.
            lead_id: { not: null },
            scheduled_at: window,
            status: { in: ['SCHEDULED', 'COMPLETED'] },
            ...(Object.keys(leadScope).length > 0 ? { lead: leadScope } : {}),
            ...(departmentId ? { assignees: { some: { user: { department_id: departmentId } } } } : {}),
            ...(leadsAttached ? { AND: [{ assignees: { some: { user_id: me } } }] } : {}),
          },
          select: {
            id: true,
            scheduled_at: true,
            duration_minutes: true,
            completed_at: true,
            lead: {
              select: {
                id: true,
                lead_number: true,
                service_request: true,
                customer: { select: { first_name: true, last_name: true, company_name: true } },
                service_location: { select: { address_line1: true, city: true } },
              },
            },
            assignees: { select: { user: { select: { id: true, first_name: true, last_name: true, avatar_path: true } } } },
          },
          orderBy: { scheduled_at: 'asc' },
        });
      })()
    : [];

  // Derive each job's displayed time from the trip(s) that fall inside the viewed day. Under Attached only the
  // person's own trips are kept, so the lanes name no one but who is on those trips.
  const jobsWithTimes = jobs.map((job) => {
    const visits = jobsAttached ? job.visits.filter((v) => v.assignees.some((a) => a.user.id === me)) : job.visits;
    const inWindow = visits
      .filter((v) => v.scheduled_at !== null && v.scheduled_at >= b.scheduleDateStart && v.scheduled_at <= b.scheduleDateEnd && v.status !== 'CANCELLED')
      .sort((x, y) => x.scheduled_at!.getTime() - y.scheduled_at!.getTime());
    const winner = inWindow[0] ?? null;
    return { ...job, visits, scheduled_start: winner?.scheduled_at ?? null, scheduled_end: winner?.scheduled_end ?? null };
  });

  const lanes = buildScheduleLanes(
    jobsWithTimes,
    // `lead` is nullable on a visit; the query is lead-scoped and this filter is the belt to that braces.
    walkthroughs.flatMap((w) =>
      w.lead === null
        ? []
        : [{
            id: w.lead.id,
            lead_number: w.lead.lead_number,
            service_request: w.lead.service_request,
            walkthrough_scheduled_at: w.scheduled_at!,
            walkthrough_duration_minutes: w.duration_minutes,
            walkthrough_completed_at: w.completed_at,
            customer: w.lead.customer,
            service_location: w.lead.service_location,
            performers: w.assignees.map((p) => p.user),
          }],
    ),
  );

  // Avatars: one batched sign over the lanes already built.
  const signed = await signAvatarPaths(lanes.map((lane) => lane.avatar_path));
  return lanes.map(({ avatar_path, ...lane }) => ({
    ...lane,
    avatar_url: resolveAvatarUrl(avatar_path, signed),
    // Each entry opens the record it names (a job, or the lead a walkthrough belongs to): a record the person can open.
    jobs: lane.jobs.map((entry) => ({ ...entry, link: entry.entity === 'walkthrough' ? `/leads/${entry.id}` : `/jobs/${entry.id}` })),
  }));
}
