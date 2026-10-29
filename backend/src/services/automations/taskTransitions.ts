/**
 * taskTransitions.ts - the task triggers that fire when a task's status MOVES INTO a state.
 *
 * "Task is done" (slice 14) and "Task is cancelled" (slice 15) are the members. Every such trigger
 * shares one shape, so each is ONE entry in TASK_TRANSITIONS rather than a copy of the plumbing:
 * the controller asks `taskTransitionInto` which trigger (if any) a status change fires,
 * dispatches the event `taskTransitionEvent` builds, and the catalogue, the dedupe key and the
 * stale floor all read the same list. Adding another is an additive entry here plus its enum
 * value, catalogue copy and labels.
 *
 * WHAT THE EVENT CARRIES, AND WHY IT IS NOT READ OFF THE ROW:
 *  - the OCCURRENCE is the transition moment's ISO string. A task can be finished, reopened and
 *    finished again, and each finish is its own occurrence: keyed on the task alone the second one
 *    is swallowed by the (workflow_id, dedupe_key) unique for the life of the task. The moment is
 *    minted fresh at dispatch, so it can never collide with a historical key.
 *  - WHO and WHEN ride `eventPayload.mergeFields`, the channel `event.reason` and the per-visit
 *    overrides already travel on, persisted on the enrollment and re-applied on every step. A task
 *    has no "finished by" column at all, and the moment is what THIS occurrence is about - a WAIT
 *    that outlives a reopen still names the finish it was enrolled for. For CANCELLED the payload
 *    is the ONLY record of the moment: a cancel clears completed_at and there is no cancelled_at.
 *
 * NO "cancellation reason" field: a task records no reason anywhere (no column, and the PATCH
 * takes none), so there is nothing to render. It lands with a source, never as an empty field.
 */

import type { AutomationTriggerType } from '@prisma/client';
import type { TaskStatusValue } from '../../lib/tasks/status';
import { formatDateTimeInZone } from '../../lib/timezone';
import type { AutomationEvent, EventTriggerType } from './dispatch';

export interface TaskTransition {
  /** The trigger that fires. */
  trigger: EventTriggerType;
  /** The status the task moves INTO. Moving from any OTHER status fires; staying put does not. */
  into: TaskStatusValue;
  /** Merge field naming the person who made the change. */
  byField: string;
  /** Merge field carrying the moment of the change, in the org's timezone. */
  atField: string;
}

export const TASK_TRANSITIONS: readonly TaskTransition[] = [
  { trigger: 'TASK_COMPLETED', into: 'DONE', byField: 'task.completed_by', atField: 'task.completed_at' },
  { trigger: 'TASK_CANCELLED', into: 'CANCELLED', byField: 'task.cancelled_by', atField: 'task.cancelled_at' },
];

/**
 * The transition a status change fires, or null. Status is UNORDERED, so this is an explicit
 * before/after test and never a comparison: `after` undefined (the PATCH did not touch status) or
 * equal to `before` (re-sending the same status) is not a transition.
 */
export function taskTransitionInto(before: string, after: string | undefined): TaskTransition | null {
  if (after === undefined || after === before) return null;
  return TASK_TRANSITIONS.find((t) => t.into === after) ?? null;
}

export function isTaskTransitionTrigger(trigger: AutomationTriggerType): boolean {
  return TASK_TRANSITIONS.some((t) => t.trigger === trigger);
}

/** The merge fields a transition trigger adds to the task group - [] for every other trigger. */
export function taskTransitionFields(trigger: AutomationTriggerType): string[] {
  const t = TASK_TRANSITIONS.find((x) => x.trigger === trigger);
  return t ? [t.byField, t.atField] : [];
}

/**
 * The Automation Center event for one transition. Dispatched post-commit by the task update path.
 * `actorId` is Rule 0's carrier: the person who made the change is dropped from every audience.
 */
export function taskTransitionEvent(args: {
  transition: TaskTransition;
  organizationId: string;
  task: { id: string; title: string };
  actorId: string;
  actorName: string;
  /** The transition moment - the SAME instant the write stamped (completed_at for DONE; nothing for CANCELLED). */
  at: Date;
  timeZone: string;
}): AutomationEvent {
  const { transition, task } = args;
  return {
    type: transition.trigger,
    organizationId: args.organizationId,
    // The TITLE, not the task number - the task convention every other task dispatch follows.
    entity: { type: 'task', id: task.id, label: task.title },
    occurrenceKey: args.at.toISOString(),
    actorId: args.actorId,
    eventPayload: {
      mergeFields: {
        [transition.byField]: args.actorName,
        [transition.atField]: formatDateTimeInZone(args.at, args.timeZone),
      },
    },
  };
}
