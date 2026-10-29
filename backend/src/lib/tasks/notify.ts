import { emit } from '../../services/notifications/notificationService';

/**
 * The task bell, shared by every path that tells people about a task: the task controller's
 * handlers and the task-deletion service (./deletion), which a category delete also runs.
 * Moved out of task.controller.ts unchanged (slice 11) so a bulk delete rings exactly the bell a
 * manual delete rings.
 */

/** Who is acting, and in which organization - what a notification needs from a request. */
export interface TaskActor {
  orgId: string;
  actorId: string;
}

/**
 * How a task identifies itself to the notification layer (design §5).
 *
 * `title` is the label, not `task_number`: "T00042 assigned to you" tells the reader nothing,
 * and for `task.deleted` the title is the ONLY thing left that can say which task — it is a
 * SNAPSHOT taken from the row before the delete, never a re-read.
 */
export type TaskRef = { id: string; title: string; task_number: string };

/**
 * Fire one task notification. Callers pass the raw people-lists; `resolveRecipients` owns the
 * matrix that turns them into recipients, and `dedupe()` drops the actor one layer below that.
 *
 * POST-COMMIT ONLY — never handed the caller's `tx` (#271, the job.controller precedent).
 * emit() writes rows; a transaction that later rolls back must not leave notifications behind
 * for an edit that never happened. It is also best-effort and never throws, so an await here
 * cannot fail the request.
 *
 * The empty-recipients guard is NOT redundant with the actor drop downstream: emit() loads the
 * org's role holders BEFORE it resolves recipients, so an emit destined for nobody still costs
 * a query. Skipping it keeps the overwhelmingly common assign-it-to-myself create free of one.
 *
 * It is also NOT a second implementation of Rule 0 ("never tell someone about their own
 * action"). Rule 0 has exactly one home, dedupe() in services/notifications/resolveRecipients.ts,
 * and every task verb is classified `involvement` with no exception in VERB_RULES
 * (services/notifications/templates.ts), so it applies here unmodified. Deleting the guard below
 * would change how many queries run, never who gets told.
 */
export async function emitTaskNotification(
  actor: TaskActor,
  verb: string,
  task: TaskRef,
  entity: Record<string, string[]>,
): Promise<void> {
  const { actorId } = actor;
  const someoneElse = Object.values(entity).flat().some((id) => id !== actorId);
  if (!someoneElse) return;
  await emit({
    verb,
    organizationId: actor.orgId,
    actorId,
    object: { type: 'TASK', id: task.id, label: task.title },
    entity,
    data: { task_number: task.task_number },
  });
}
