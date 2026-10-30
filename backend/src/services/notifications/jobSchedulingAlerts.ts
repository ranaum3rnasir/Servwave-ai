/**
 * jobSchedulingAlerts.ts - the one place the scheduling and parts alerts are sent from (Roles & Permissions, PRD 6, S06.27):
 * Job created, Job assigned to you, Job rescheduled, Unassigned from you and Parts staged and ready.
 *
 * The first three and the parts alert go out through M6's two lanes (alertChain.ts): the job's stored Sold By, crew and
 * Dispatcher; whoever must act next (the Dispatcher, else the holders of Assign people to jobs who can open the job, else the
 * Manage roles and permissions holders); and a copy to the Alert me about every job holders. Nobody comes from a role name, and
 * the person who did it is never told. The people who reached an alert as a fallback are told why and the others are not, so an
 * action goes out as up to two alerts (one without the line, one with it).
 *
 * Job assigned is one event in two wordings. The person named gets "J00123 assigned to you"; everyone else the chain reaches gets
 * "Dana was assigned to J00123", the same alert naming who was assigned. A person is in one group only (the named person who is
 * also on the chain gets the "you" form and no other), so nobody is told twice. Several people assigned by one request are each
 * told "assigned to you", and the rest get ONE alert naming them all. The name of a colleague on a job the person can open is on
 * the job's crew list already, and the chain only reaches people who can open the job, so the alert says nothing the job does not.
 *
 * "Unassigned from you" is personal: it goes to the people taken off the job and to nobody else, no lanes and no copies. The
 * person who removed themselves is not told (the writer drops the actor, as everywhere). It does not ask whether the person can
 * open the job: they have just been taken off it, so a technician who sees only their own jobs could not, and would never learn it.
 *
 * Sent AFTER the change committed and, on a request, AFTER the response (reviewAttentionQueue): the request only queues the alert
 * and gains no statement. Cost of one alert, the same however large the company: one read of the job, one read for the names of
 * the people assigned, the chain's reads (the switch holders of the step, the copies and the manager fallback, each followed by
 * the batched access check) and one write pair per alert sent. A bulk of jobs sends one alert per job, each the same few reads.
 * Fire-and-forget: a failure is logged and never reaches the change that already landed.
 */

import { logger } from '../../lib/logger';
import { prisma } from '../../lib/prisma';
import { jobCrewIds } from '../../lib/job-crew';
import { formatShortDateInZone, getOrgTimezone } from '../../lib/timezone';
import { sendByWhyLine, twoLaneRecipients, WHY_KEY, type TwoLaneAnswer } from './alertChain';
import { emit } from './notificationService';
import { queueAlertAfterResponse } from './reviewAttentionQueue';

/** What the three job verbs are called in a log line. All three are told through Assign people to jobs, with a copy to every job. */
const SCHEDULING_ALERT_NAME = {
  'dispatch.job_created': 'job created alert',
  'dispatch.job_assigned': 'job assigned alert',
  'dispatch.job_rescheduled': 'job rescheduled alert',
} as const;

export type SchedulingVerb = keyof typeof SCHEDULING_ALERT_NAME;

const STEP_SWITCH = 'assign_people_to_jobs';
const STEP_WORDS = 'assign people to jobs';
const COPY_SWITCH = 'alert_every_job';

/** The job as the chain needs it: its number and its people, read once after the change committed. */
async function readJobPeople(organizationId: string, jobId: string) {
  const job = await prisma.job.findFirst({
    where: { id: jobId, organization_id: organizationId },
    select: {
      job_number: true, salesperson_id: true, dispatcher_id: true,
      visits: { select: { assignees: { select: { user_id: true } } } },
    },
  });
  if (!job) return null;
  return {
    jobNumber: job.job_number,
    soldById: job.salesperson_id,
    dispatcherId: job.dispatcher_id,
    crewIds: jobCrewIds(job),
  };
}

// ─── Job created, Job assigned, Job rescheduled ──────────────────────────────────────────────────────────────────────────

export interface SchedulingAlertArgs {
  verb: SchedulingVerb;
  organizationId: string;
  /** The person who did it; never someone for the alert. */
  actorId: string | null;
  jobId: string;
  /** Job assigned only: the people just put on the job, in the order they were named. They get the "you" wording. */
  namedIds?: string[];
  /** The start of the trip the alert is about, kept on the alert for display. */
  scheduledStart?: string | null;
}

/** The two wordings of Job assigned: the named person's, and everyone else's. */
const YOU = 'you';
const ABOUT = 'about';

export async function alertJobScheduling(args: SchedulingAlertArgs): Promise<void> {
  try {
    const { organizationId } = args;
    const job = await readJobPeople(organizationId, args.jobId);
    if (!job) return;
    const namedIds = args.verb === 'dispatch.job_assigned' ? [...new Set(args.namedIds ?? [])] : [];
    const named = new Set(namedIds);

    const people = await twoLaneRecipients({
      organizationId,
      record: { type: 'JOB', id: args.jobId },
      actorId: args.actorId,
      // The people just named are on the job's crew by now; naming them here keeps them in lane 1 whatever the read saw.
      recordPeople: [...new Set([...(job.soldById ? [job.soldById] : []), ...job.crewIds, ...namedIds])],
      dispatcherId: job.dispatcherId,
      stepSwitch: STEP_SWITCH,
      copySwitch: COPY_SWITCH,
      words: { record: 'job', step: STEP_WORDS, alert: SCHEDULING_ALERT_NAME[args.verb] },
    });

    // Job assigned says one thing to the people named and another to everyone else; a person is in one group only.
    const assignedNames = namedIds.length ? await namesOf(organizationId, namedIds) : [];
    const groupOf = namedIds.length
      ? async (personIds: string[]) => new Map<string, string | null>(personIds.map((id) => [id, named.has(id) ? YOU : ABOUT]))
      : undefined;

    await sendByWhyLine(people, (entity, whyLine, group) =>
      emit({
        verb: args.verb,
        organizationId,
        actorId: args.actorId,
        object: { type: 'JOB', id: args.jobId, label: job.jobNumber },
        // `crew_ids` and `named_ids` are for the priority only: the crew is interrupted by a new job and a move, and the people
        // just assigned by their own alert.
        entity: { ...entity, crew_ids: job.crewIds, named_ids: namedIds },
        data: {
          object_label: job.jobNumber,
          scheduled_start: args.scheduledStart ?? null,
          fallback_reason: whyLine ?? '',
          ...(group === ABOUT ? { assigned_names: assignedNames } : {}),
        },
      }), groupOf);
  } catch (err) {
    logger.warn('[jobSchedulingAlerts] could not send a job alert', {
      verb: args.verb, jobId: args.jobId, error: err instanceof Error ? err.message : String(err),
    });
  }
}

/** The names of the people just assigned, in the order they were named. The company's own people only. */
async function namesOf(organizationId: string, userIds: string[]): Promise<string[]> {
  const users = await prisma.user.findMany({
    where: { id: { in: userIds }, organization_id: organizationId },
    select: { id: true, first_name: true, last_name: true },
  });
  const byId = new Map(users.map((u) => [u.id, `${u.first_name ?? ''} ${u.last_name ?? ''}`.trim() || 'A crew member']));
  return userIds.map((id) => byId.get(id)).filter((n): n is string => Boolean(n));
}

/** Leave a scheduling alert for after the response (or send it now where there is no request to wait for). */
export function queueJobSchedulingAlert(args: SchedulingAlertArgs): void {
  queueAlertAfterResponse({ orgId: args.organizationId, actorId: args.actorId, send: () => alertJobScheduling(args) });
}

// ─── Unassigned from you ─────────────────────────────────────────────────────────────────────────────────────────────────

export interface UnassignedAlertArgs {
  organizationId: string;
  actorId: string | null;
  jobId: string;
  jobNumber: string;
  /** The people taken off the job (or off one trip of it). */
  removedIds: string[];
  scheduledStart?: string | null;
  /** Set when the person came off ONE trip and is still on another: the alert names the trip, not the job. */
  visitLabel?: string;
  /** The same, from the trip itself: the label ("Visit 2 on Wed, Sep 30") is made with the alert, after the response. */
  trip?: { seq: number; scheduledAt: Date | null };
}

/**
 * Personal: only the people taken off, no lanes, no copies, never the Dispatcher or the holders of any switch. The writer drops
 * the person who did it, so someone who removed themselves is not told.
 */
export async function alertJobUnassigned(args: UnassignedAlertArgs): Promise<void> {
  try {
    // The company's active people among those taken off. The row-scope filter is not asked (`personal`): a technician who sees only
    // the jobs they are on can no longer open this one, and they are the one person it is for.
    const removed = await prisma.user.findMany({
      where: { id: { in: [...new Set(args.removedIds)] }, organization_id: args.organizationId, is_active: true },
      select: { id: true },
    });
    if (!removed.length) return;
    const visitLabel = args.visitLabel ?? (args.trip ? await tripLabel(args.organizationId, args.trip) : undefined);
    await emit({
      verb: 'dispatch.job_unassigned',
      organizationId: args.organizationId,
      actorId: args.actorId,
      object: { type: 'JOB', id: args.jobId, label: args.jobNumber },
      personal: true,
      entity: { assignee_ids: removed.map((u) => u.id) },
      data: {
        object_label: args.jobNumber,
        scheduled_start: args.scheduledStart ?? null,
        ...(visitLabel ? { visit_label: visitLabel } : {}),
      },
    });
  } catch (err) {
    logger.warn('[jobSchedulingAlerts] could not send an unassigned alert', {
      jobId: args.jobId, error: err instanceof Error ? err.message : String(err),
    });
  }
}

/** "Visit 2 on Wed, Sep 30": the trip a person came off, in the company's own time zone (no date when the trip has none). */
async function tripLabel(organizationId: string, trip: { seq: number; scheduledAt: Date | null }): Promise<string> {
  const when = trip.scheduledAt;
  const day = when ? await getOrgTimezone(organizationId).then((zone) => ` on ${formatShortDateInZone(when, zone)}`, () => '') : '';
  return `Visit ${trip.seq}${day}`;
}

/** Leave the personal alert for after the response (or send it now where there is no request to wait for). */
export function queueJobUnassignedAlert(args: UnassignedAlertArgs): void {
  queueAlertAfterResponse({ orgId: args.organizationId, actorId: args.actorId, send: () => alertJobUnassigned(args) });
}

// ─── Parts staged and ready ──────────────────────────────────────────────────────────────────────────────────────────────

export interface StagingReadyArgs {
  organizationId: string;
  /** The person who marked the parts ready; never someone for the alert. */
  actorId: string | null;
  stageId: string;
}

/**
 * Parts staged and ready is about a job: its people, its Dispatcher, whoever must act and the copies, plus the technician the
 * parts are staged for (interrupted: it is their pickup). Several doors can report one stage, so the alert keeps one key per
 * stage and goes out once; the covering people's alert carries the same key with the why suffix.
 *
 * The technician is told whether or not they can open the job: assignment is what reaches them to the stage.
 *
 * A stage that belongs to no job has no record to chain on and nobody to cover for it: only the technician it is staged for is
 * told, and a stage with nobody on it is logged like any alert that finds nobody.
 */
export async function alertStagingReady(args: StagingReadyArgs): Promise<void> {
  try {
    const { organizationId } = args;
    const dedupKey = `inventory.staging_ready:${args.stageId}`;
    const sent = await prisma.notification.findFirst({
      where: { organization_id: organizationId, dedup_key: { in: [dedupKey, dedupKey + WHY_KEY] } },
      select: { id: true },
    });
    if (sent) return;

    const stage = await prisma.jobStage.findFirst({
      where: { id: args.stageId, organization_id: organizationId },
      select: { job_id: true, job_number: true, assigned_tech_id: true },
    });
    if (!stage) return;
    const tech = stage.assigned_tech_id;
    const object = { type: 'JOB_STAGE', id: args.stageId, label: stage.job_number };
    const send = (entity: Record<string, unknown>, whyLine: string | null) =>
      emit({
        verb: 'inventory.staging_ready',
        organizationId,
        actorId: args.actorId,
        object,
        // `assignee_ids` is for the priority only: the technician the parts are staged for is interrupted.
        entity: { ...entity, assignee_ids: tech ? [tech] : [] },
        data: { object_label: stage.job_number, fallback_reason: whyLine ?? '' },
        dedupKey: whyLine ? dedupKey + WHY_KEY : dedupKey,
      });

    const job = stage.job_id ? await readJobPeople(organizationId, stage.job_id) : null;
    if (!stage.job_id || !job) {
      const told = tech && tech !== args.actorId
        ? await prisma.user.findFirst({ where: { id: tech, organization_id: organizationId, is_active: true }, select: { id: true } })
        : null;
      if (!told) {
        logger.warn('[alertChain] parts staged alert: nobody to tell', {
          alert: 'parts staged alert', organizationId, recordType: 'JOB_STAGE', recordId: args.stageId,
        });
        return;
      }
      await send({ lane_one_ids: [told.id], lane_two_ids: [], copy_ids: [] }, null);
      return;
    }

    const people: TwoLaneAnswer = await twoLaneRecipients({
      organizationId,
      record: { type: 'JOB', id: stage.job_id },
      actorId: args.actorId,
      recordPeople: [...new Set([...(job.soldById ? [job.soldById] : []), ...job.crewIds, ...(tech ? [tech] : [])])],
      dispatcherId: job.dispatcherId,
      stepSwitch: STEP_SWITCH,
      copySwitch: COPY_SWITCH,
      words: { record: 'job', step: STEP_WORDS, alert: 'parts staged alert' },
    });
    // The technician the parts are staged for reaches the stage because it is assigned to them, whether or not they can open the
    // job, so they are told even when the chain dropped them (they are not on the job's crew, say).
    if (tech && tech !== args.actorId && ![...people.laneOne, ...people.laneTwo, ...people.copies].includes(tech)) {
      const active = await prisma.user.findFirst({ where: { id: tech, organization_id: organizationId, is_active: true }, select: { id: true } });
      if (active) people.laneOne.push(tech);
    }
    await sendByWhyLine(people, (entity, whyLine) => send(entity as unknown as Record<string, unknown>, whyLine));
  } catch (err) {
    logger.warn('[jobSchedulingAlerts] could not send a parts staged alert', {
      stageId: args.stageId, error: err instanceof Error ? err.message : String(err),
    });
  }
}

/** Leave the parts alert for after the response (or send it now where there is no request to wait for). */
export function queueStagingReadyAlert(args: StagingReadyArgs): void {
  queueAlertAfterResponse({ orgId: args.organizationId, actorId: args.actorId, send: () => alertStagingReady(args) });
}
