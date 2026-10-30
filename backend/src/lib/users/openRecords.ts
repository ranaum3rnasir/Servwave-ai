/**
 * openRecords.ts - what a person still has open, and handing it to someone else (P19, E13).
 *
 * Deactivating a person changes no record: every assignee, crew, Sold By, Owner and Dispatcher field keeps their name, and
 * the screens mark it "Deactivated". What an Admin may want at that moment is to move the person's OPEN work to someone
 * else. This module is that one optional step:
 *
 *   summarizeOpenRecords - how many open records per module name the person (the numbers the deactivation dialog shows);
 *   reassignOpenRecords  - replace the person with another active person on those open records, module by module.
 *
 * "Open" is the module's own meaning: a task not done or cancelled, a lead not won or lost, a job not done or cancelled
 * (and, for crew, a visit not completed or cancelled). Closed records keep the person as history and are never touched.
 *
 * The person taking over must be able to hold each slot they are given (M5 slot eligibility, never a role name); a slot
 * they could not hold is skipped and counted, so the Admin sees what was left behind. Nothing here deactivates anyone.
 */

import type { Prisma } from '@prisma/client';
import { prisma } from '../prisma';
import { logger } from '../logger';
import { OPEN_LEAD_STATUSES } from '../../services/lead-status-options';
import { mayHoldSlot, type Slot } from '../permissions/slotEligibility';
import { PEOPLE_EVENT, recordTaskActivities, toIdSet } from '../tasks/activity';
import { resolveUserNames } from '../tasks/enrich';
import { emit } from '../../services/notifications/notificationService';
import { dispatchAutomationEvent } from '../../services/automations/dispatch';

export const REASSIGN_MODULES = ['tasks', 'leads', 'jobs'] as const;
export type ReassignModule = (typeof REASSIGN_MODULES)[number];

const MODULE_LABEL: Record<ReassignModule, string> = { tasks: 'Tasks', leads: 'Leads', jobs: 'Jobs' };

const OPEN_TASK = { status: { in: ['TODO', 'IN_PROGRESS', 'BLOCKED'] } } satisfies Prisma.TaskWhereInput;
const OPEN_JOB = { status: { notIn: ['DONE', 'CANCELLED'] } } satisfies Prisma.JobWhereInput;
const OPEN_VISIT = { status: { notIn: ['COMPLETED', 'CANCELLED'] } } satisfies Prisma.VisitWhereInput;

/** The open records of each module that name this person in any people field. */
function namedWhere(orgId: string, userId: string) {
  const tasks: Prisma.TaskWhereInput = {
    organization_id: orgId, ...OPEN_TASK, OR: [{ assignee_ids: { has: userId } }, { watcher_ids: { has: userId } }],
  };
  const leads: Prisma.LeadWhereInput = {
    organization_id: orgId, status: { in: [...OPEN_LEAD_STATUSES] },
    OR: [
      { commission_owner_id: userId }, { dispatcher_id: userId }, { lead_assignees: { some: { user_id: userId } } },
      { visits: { some: { ...OPEN_VISIT, assignees: { some: { user_id: userId } } } } },
    ],
  };
  const jobs: Prisma.JobWhereInput = {
    organization_id: orgId, ...OPEN_JOB,
    OR: [
      { salesperson_id: userId }, { dispatcher_id: userId },
      { visits: { some: { ...OPEN_VISIT, assignees: { some: { user_id: userId } } } } },
    ],
  };
  return { tasks, leads, jobs };
}

export interface OpenRecordsSummary {
  modules: Array<{ key: ReassignModule; label: string; open: number }>;
  total: number;
}

/** How many open records per module name the person. Counts only: nothing about the records themselves. */
export async function summarizeOpenRecords(orgId: string, userId: string): Promise<OpenRecordsSummary> {
  const where = namedWhere(orgId, userId);
  const [tasks, leads, jobs] = await Promise.all([
    prisma.task.count({ where: where.tasks }),
    prisma.lead.count({ where: where.leads }),
    prisma.job.count({ where: where.jobs }),
  ]);
  const counts: Record<ReassignModule, number> = { tasks, leads, jobs };
  return {
    modules: REASSIGN_MODULES.map((key) => ({ key, label: MODULE_LABEL[key], open: counts[key] })),
    total: tasks + leads + jobs,
  };
}

export interface ReassignResult {
  /** Records moved to the new person, per module. */
  moved: Record<ReassignModule, number>;
  /** Slots the new person could not hold, per module: the person stays on those records. */
  skipped: Record<ReassignModule, number>;
}

const emptyResult = (): ReassignResult => ({
  moved: { tasks: 0, leads: 0, jobs: 0 },
  skipped: { tasks: 0, leads: 0, jobs: 0 },
});

const TASKS_PER_TRANSACTION = 25;
const TX_OPTIONS = { maxWait: 10_000, timeout: 20_000 };

/** `from` replaced by `to` in an id list, without a duplicate when `to` is already there. */
function swapId(ids: string[], from: string, to: string): string[] {
  const out = toIdSet(ids).map((id) => (id === from ? to : id));
  return [...new Set(out)];
}

/**
 * Replace `fromUserId` with `toUserId` on the open records of the named modules. `toUserId` must be an active person of the
 * same company (the caller checks and refuses otherwise). Closed records keep `fromUserId` as history.
 */
export async function reassignOpenRecords(args: {
  orgId: string;
  actorId: string;
  fromUserId: string;
  toUserId: string;
  modules: readonly ReassignModule[];
}): Promise<ReassignResult> {
  const { orgId, actorId, fromUserId, toUserId } = args;
  const modules = new Set(args.modules);
  const result = emptyResult();
  const target = await prisma.user.findFirst({
    where: { id: toUserId, organization_id: orgId, is_active: true },
    select: { id: true, organization_id: true, role: true, is_admin: true, is_active: true, custom_role_id: true, custom_role: { select: { key: true } } },
  });
  if (!target) throw new Error('reassignOpenRecords: the person taking over is not an active person of this company');
  const may: Record<Slot, boolean> = {
    owner: await mayHoldSlot(target, 'owner'),
    dispatcher: await mayHoldSlot(target, 'dispatcher'),
    crew: await mayHoldSlot(target, 'crew'),
  };
  const where = namedWhere(orgId, fromUserId);

  if (modules.has('tasks')) await reassignTasks(orgId, actorId, fromUserId, toUserId, where.tasks, result);
  if (modules.has('leads')) await reassignLeads(orgId, fromUserId, toUserId, where.leads, may, result);
  if (modules.has('jobs')) await reassignJobs(orgId, fromUserId, toUserId, where.jobs, may, result);
  return result;
}

async function reassignTasks(
  orgId: string, actorId: string, from: string, to: string, where: Prisma.TaskWhereInput, result: ReassignResult,
): Promise<void> {
  const tasks = await prisma.task.findMany({
    where, select: { id: true, task_number: true, title: true, assignee_ids: true, watcher_ids: true },
  });
  if (!tasks.length) return;
  const names = await resolveUserNames(orgId, [from, to]);
  const nameOf = (id: string) => names.get(id) || 'Unknown user';
  const announced: Array<{ id: string; number: string; title: string }> = [];
  for (let i = 0; i < tasks.length; i += TASKS_PER_TRANSACTION) {
    const chunk = tasks.slice(i, i + TASKS_PER_TRANSACTION);
    await prisma.$transaction(async (tx) => {
      const events: Parameters<typeof recordTaskActivities>[1] = [];
      for (const t of chunk) {
        const wasAssignee = toIdSet(t.assignee_ids).includes(from);
        const wasWatcher = toIdSet(t.watcher_ids).includes(from);
        await tx.task.update({
          where: { id: t.id },
          data: {
            ...(wasAssignee ? { assignee_ids: swapId(t.assignee_ids, from, to) } : {}),
            ...(wasWatcher ? { watcher_ids: swapId(t.watcher_ids, from, to) } : {}),
          },
        });
        if (wasAssignee) {
          events.push({ taskId: t.id, orgId, actorId, type: PEOPLE_EVENT.UNASSIGNED.type, description: PEOPLE_EVENT.UNASSIGNED.label(nameOf(from)) });
          events.push({ taskId: t.id, orgId, actorId, type: PEOPLE_EVENT.ASSIGNED.type, description: PEOPLE_EVENT.ASSIGNED.label(nameOf(to)) });
          announced.push({ id: t.id, number: t.task_number, title: t.title });
        }
        if (wasWatcher) {
          events.push({ taskId: t.id, orgId, actorId, type: PEOPLE_EVENT.WATCHER_REMOVED.type, description: PEOPLE_EVENT.WATCHER_REMOVED.label(nameOf(from)) });
        }
      }
      await recordTaskActivities(tx, events);
    }, TX_OPTIONS);
    result.moved.tasks += chunk.length;
  }
  void announceTaskTakeovers(orgId, actorId, to, announced);
}

async function reassignLeads(
  orgId: string, from: string, to: string, where: Prisma.LeadWhereInput, may: Record<Slot, boolean>, result: ReassignResult,
): Promise<void> {
  const leads = await prisma.lead.findMany({
    where, select: { id: true, commission_owner_id: true, dispatcher_id: true, lead_assignees: { select: { user_id: true } } },
  });
  for (const lead of leads) {
    let touched = false;
    let skipped = false;
    const data: Prisma.LeadUncheckedUpdateInput = {};
    const isOwner = lead.commission_owner_id === from;
    const isAssignee = lead.lead_assignees.some((a) => a.user_id === from);
    if (isOwner || isAssignee) {
      if (may.owner) {
        if (isOwner) data.commission_owner_id = to;
        touched = true;
      } else skipped = true;
    }
    if (lead.dispatcher_id === from) {
      if (may.dispatcher) { data.dispatcher_id = to; touched = true; } else skipped = true;
    }
    await prisma.$transaction(async (tx) => {
      if (Object.keys(data).length) await tx.lead.update({ where: { id: lead.id }, data });
      if (isAssignee && may.owner) {
        await tx.leadAssignee.deleteMany({ where: { lead_id: lead.id, user_id: from } });
        await tx.leadAssignee.upsert({
          where: { lead_id_user_id: { lead_id: lead.id, user_id: to } },
          create: { lead_id: lead.id, user_id: to, organization_id: orgId },
          update: {},
        });
      }
      touched = (await reassignVisitCrew(tx, orgId, { lead_id: lead.id }, from, to, may.crew)) || touched;
      // A walkthrough crew slot the heir cannot hold is left with the leaver, and counted like every other slot (CR-5).
      if (!may.crew && (await tx.visitAssignee.count({ where: { user_id: from, visit: { lead_id: lead.id, ...OPEN_VISIT } } })) > 0) skipped = true;
    });
    if (touched) result.moved.leads += 1;
    if (skipped) result.skipped.leads += 1;
  }
}

async function reassignJobs(
  orgId: string, from: string, to: string, where: Prisma.JobWhereInput, may: Record<Slot, boolean>, result: ReassignResult,
): Promise<void> {
  const jobs = await prisma.job.findMany({ where, select: { id: true, salesperson_id: true, dispatcher_id: true } });
  for (const job of jobs) {
    let touched = false;
    let skipped = false;
    const data: Prisma.JobUncheckedUpdateInput = {};
    if (job.salesperson_id === from) {
      if (may.owner) { data.salesperson_id = to; touched = true; } else skipped = true;
    }
    if (job.dispatcher_id === from) {
      if (may.dispatcher) { data.dispatcher_id = to; touched = true; } else skipped = true;
    }
    await prisma.$transaction(async (tx) => {
      if (Object.keys(data).length) await tx.job.update({ where: { id: job.id }, data });
      touched = (await reassignVisitCrew(tx, orgId, { job_id: job.id }, from, to, may.crew)) || touched;
      if (!may.crew && (await tx.visitAssignee.count({ where: { user_id: from, visit: { job_id: job.id, ...OPEN_VISIT } } })) > 0) skipped = true;
    });
    if (touched) result.moved.jobs += 1;
    if (skipped) result.skipped.jobs += 1;
  }
}

/** Swap the crew on a record's open visits. Returns whether any visit changed. */
async function reassignVisitCrew(
  tx: Prisma.TransactionClient, orgId: string, parent: { lead_id: string } | { job_id: string }, from: string, to: string, mayCrew: boolean,
): Promise<boolean> {
  if (!mayCrew) return false;
  const visits = await tx.visit.findMany({
    where: { ...parent, ...OPEN_VISIT, assignees: { some: { user_id: from } } },
    select: { id: true, assignees: { select: { user_id: true } } },
  });
  for (const visit of visits) {
    await tx.visitAssignee.deleteMany({ where: { visit_id: visit.id, user_id: from } });
    if (!visit.assignees.some((a) => a.user_id === to)) {
      await tx.visitAssignee.create({ data: { visit_id: visit.id, user_id: to, organization_id: orgId } });
    }
  }
  return visits.length > 0;
}

/** Tell the person who took tasks over, by bell and by the TASK_ASSIGNED automation event (never awaited by the request). */
async function announceTaskTakeovers(
  orgId: string, actorId: string, to: string, tasks: Array<{ id: string; number: string; title: string }>,
): Promise<void> {
  if (!tasks.length) return;
  try {
    const inheritor = await prisma.user.findFirst({
      where: { id: to, organization_id: orgId, is_active: true },
      select: { id: true, email: true, first_name: true, last_name: true, phone: true },
    });
    for (const t of tasks) {
      await emit({
        verb: 'task.assigned', organizationId: orgId, actorId,
        object: { type: 'TASK', id: t.id, label: t.title },
        entity: { added_assignee_ids: [to] }, data: { task_number: t.number },
      });
      dispatchAutomationEvent({
        type: 'TASK_ASSIGNED', organizationId: orgId, entity: { type: 'task', id: t.id, label: t.title },
        occurrenceKey: to, actorId, ...(inheritor ? { eventPayload: { recipient: inheritor } } : {}),
      });
    }
  } catch (err) {
    logger.error('Task takeover announcement failed:', err);
  }
}
