import type { Task, TaskPersonRef } from './types';

/**
 * What to show for an assignee whose id no longer resolves to a user.
 *
 * The wire arrays are bare id lists with no foreign key, so a deactivated or
 * deleted user leaves its id in `assignee_ids` with `name: null` alongside it.
 * Every surface answers that the same way rather than each one inventing its
 * own em-dash / blank / raw-uuid rendering - and, critically, none of them may
 * crash on it (`name.split(...)` on null is the bug this exists to prevent).
 */
export const UNKNOWN_ASSIGNEE_LABEL = 'Unknown user';

/** Display name for one assignee. Never empty, never throws. */
export function assigneeLabel(person: TaskPersonRef | null | undefined): string {
  const name = person?.name?.trim();
  return name ? name : UNKNOWN_ASSIGNEE_LABEL;
}

/**
 * The task's assignees as renderable refs.
 *
 * `assignee_ids` is the authority on WHO, `assignees` is only the name lookup:
 * a payload that carries an id with no matching resolved entry still has to
 * render a tile for that person, and a stale `assignees` entry for an id that
 * was removed must not. Deriving the list from the ids in their order - the
 * order the API promises - makes both cases right without a second code path.
 */
export function taskAssignees(task: Pick<Task, 'assignee_ids' | 'assignees'>): TaskPersonRef[] {
  const byId = new Map((task.assignees ?? []).map((a) => [a.id, a]));
  return (task.assignee_ids ?? []).map((id) => byId.get(id) ?? { id, name: null });
}

/** Every assignee's display name, in wire order. */
export function assigneeNames(task: Pick<Task, 'assignee_ids' | 'assignees'>): string[] {
  return taskAssignees(task).map(assigneeLabel);
}

/**
 * One line naming everybody, for a `title` tooltip on a capped avatar stack.
 * Names the FULL set, not the visible slice - the whole point of hovering an
 * overflowing stack is to learn who the "+2" are.
 */
export function assigneeTooltip(task: Pick<Task, 'assignee_ids' | 'assignees'>): string {
  return assigneeNames(task).join(', ');
}

/** Does `userId` hold this task? The `owner_id === me` test's replacement. */
export function isAssignedTo(
  task: Pick<Task, 'assignee_ids'>,
  userId: string,
): boolean {
  return (task.assignee_ids ?? []).includes(userId);
}

/**
 * Free-text match over the assignee names AND ids.
 *
 * Ids are searched too because that is what the single-owner version did
 * (`(owner_name ?? owner_id)`), and it is the only handle a user has on an
 * assignee whose name no longer resolves.
 */
export function matchesAssignee(
  task: Pick<Task, 'assignee_ids' | 'assignees'>,
  needle: string,
): boolean {
  if (!needle) return true;
  return taskAssignees(task).some(
    (a) => (a.name ?? '').toLowerCase().includes(needle) || a.id.toLowerCase().includes(needle),
  );
}
