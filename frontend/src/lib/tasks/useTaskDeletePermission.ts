import { useAppAbility } from '@/contexts/AbilityContext';
import { useAuthStore } from '@/stores/auth.store';
import type { Task } from '@/lib/tasks/types';

/**
 * May this user delete THIS task?
 *
 * Mirrors `task.controller.remove` exactly, which does NOT gate the route on
 * `delete Task` alone. Two independent arms, either of which is enough:
 *
 *   1. the CASL `delete` grant on `Task`, or
 *   2. design §3's row-level escape hatch - the caller CREATED the task AND is
 *      its ONLY assignee. A TECHNICIAN holds no `delete` grant by default (see
 *      `defaultGrants.ts`), so without this arm the todo item they opened for
 *      themselves is undeletable: a task must always keep at least one
 *      assignee, so they cannot unassign their way out of it either.
 *
 * Read from CASL and the session's own user id - never `user.role === 'ADMIN'`.
 * Custom roles are in production; a role test is invisible to them and would
 * disagree with the server in both directions. See the sibling
 * `useTaskAssignPermission` for the same reasoning on the `assign` grant.
 *
 * Returns false while `task` is null (nothing to authorise) and while the
 * session has not hydrated (no actor id to compare `created_by` against), so
 * the control stays hidden rather than flashing in and then out.
 */
export function useTaskDeletePermission(task: Task | null | undefined): boolean {
  const ability = useAppAbility();
  const actorId = useAuthStore((s) => s.user?.id) ?? '';

  if (!task) return false;
  if (ability.can('delete', 'Task')) return true;
  if (!actorId) return false;

  const assignees = task.assignee_ids ?? [];
  return task.created_by === actorId && assignees.length === 1 && assignees[0] === actorId;
}
