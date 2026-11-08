export type TaskStatus = 'TODO' | 'IN_PROGRESS' | 'BLOCKED' | 'DONE' | 'CANCELLED';
export type TaskPriority = 'LOW' | 'MEDIUM' | 'HIGH' | 'URGENT';
export type LinkedEntityType = 'JOB' | 'LEAD' | 'CUSTOMER' | 'ESTIMATE';

export const TASK_STATUSES: TaskStatus[] = ['TODO', 'IN_PROGRESS', 'BLOCKED', 'DONE', 'CANCELLED'];
export const TASK_PRIORITIES: TaskPriority[] = ['LOW', 'MEDIUM', 'HIGH', 'URGENT'];

/**
 * The FINISHED statuses - the frontend twin of `backend/src/lib/tasks/status.ts`.
 *
 * `DONE` means the work completed; `CANCELLED` means it was abandoned. They differ in every
 * other respect, but neither is an outstanding obligation, so neither is open, overdue or at
 * risk. Every "is this task still work?" test in the frontend reads from here rather than
 * spelling out `status !== 'DONE'`, because each of those said it in its own words and adding
 * one value made all of them wrong at once.
 *
 * The two lists are deliberately duplicated across the wire rather than shared: there is no
 * common package, and a frontend that guessed at the backend's enumeration would be wrong
 * silently. Keep them in step.
 */
export const TERMINAL_TASK_STATUSES: TaskStatus[] = ['DONE', 'CANCELLED'];

/**
 * True when the task is finished (either way) and so is not an open obligation.
 *
 * Takes a plain `string` rather than `TaskStatus`, matching the backend twin: several callers
 * hold a column key or a wire value that is only probably a status, and a cast at each of those
 * sites would be a place to get it wrong.
 */
export function isTerminalTaskStatus(status: string | null | undefined): boolean {
  return !!status && (TERMINAL_TASK_STATUSES as string[]).includes(status);
}

/**
 * True when the work actually FINISHED, as opposed to merely stopping.
 *
 * The narrow question, and the one the on-time rate and the completion trend ask: a cancelled
 * task was never completed, on time or otherwise, so counting it would deflate a percentage
 * that is supposed to describe delivered work. Named rather than left as a bare `=== 'DONE'`
 * so the two questions cannot be confused again at a glance.
 */
export function isCompletedTaskStatus(status: string | null | undefined): boolean {
  return status === 'DONE';
}

/**
 * The statuses the Kanban board gives a column to.
 *
 * `CANCELLED` is absent by decision (issue 03): a column for abandoned work is dead weight on
 * a board meant for work in flight. Cancelled tasks are reachable on the History tab and on the
 * record's own Tasks tab, and nowhere on the board.
 */
export const BOARD_TASK_STATUSES: TaskStatus[] = TASK_STATUSES.filter((s) => s !== 'CANCELLED');

export interface LinkedEntity {
  type: LinkedEntityType;
  id: string;
  label: string;
  /**
   * The reader may not open this entity, so `label` is a neutral placeholder rather than its
   * number, its job type or the customer's name. Optional because the create dialogs build a
   * `LinkedEntity` from a picker, where the user demonstrably CAN see what they picked; only a
   * row that came off the API carries it. Absent means the same as false.
   *
   * Distinct from an EMPTY label with `redacted` false, which is a dangling link - the entity is
   * deleted or out of the org - and keeps rendering exactly as it always has.
   */
  redacted?: boolean;
}

/**
 * The category a task is filed under, as every task payload carries it: enough to draw the chip.
 *
 * Named `...Ref` on purpose. `TaskDrillDown` in `tasks-logic.ts` is a different thing - the
 * dashboard KPI drill-down ('open' | 'atRisk' | ...) - and the two must not be confused.
 */
export interface TaskCategoryRef {
  id: string;
  name: string;
  /** `#RRGGBB` from the Tags palette. */
  color: string;
}

export interface Subtask {
  id: string;
  text: string;
  done: boolean;
}

export interface TaskActivity {
  id: string;
  type: 'created' | 'assigned' | 'status_changed' | 'priority_changed' | 'due_changed' | 'commented' | 'nudged' | 'completed' | 'cancelled'
    // Written by the attachment routes on a TASK's timeline (slice 12).
    | 'attachment_uploaded' | 'attachment_updated' | 'attachment_deleted';
  actor_id: string;
  at: string; // ISO
  meta?: Record<string, string>;
  description?: string;
  actor_name?: string | null;
}

export interface TaskComment {
  id: string;
  author_id: string;
  body: string;
  at: string; // ISO
  author_name?: string | null;
}

export type TaskSource = 'manual' | 'ai_nl' | 'ai_template' | 'ai_extract';

export interface TaskAI {
  risk_score: number;        // 0–100
  risk_reason: string | null;
  suggested_by: string | null;
  source: TaskSource;
}

/**
 * A person attached to a task, as the API resolves them.
 *
 * `name` is null when the id no longer resolves to an active user - the wire
 * arrays carry ids with no foreign key, so a deactivated or deleted user leaves
 * the id behind with nothing to resolve it to. EVERY renderer must tolerate
 * that; `assigneeLabel()` in `assignees.ts` is the one place that decides what
 * to show instead.
 */
export interface TaskPersonRef {
  id: string;
  name: string | null;
}

export interface Task {
  id: string;
  task_number: string;       // e.g. "T00001"
  title: string;
  description: string;
  status: TaskStatus;
  priority: TaskPriority;
  /** Never empty for a live task - the API guarantees at least one. */
  assignee_ids: string[];
  /** Resolved names, in the same order as `assignee_ids`. */
  assignees: TaskPersonRef[];
  watcher_ids: string[];
  watchers?: TaskPersonRef[];
  due_at: string | null;     // ISO
  linked_entity: LinkedEntity | null;
  tags: string[];
  /**
   * At most one, and none is fine (null). Optional only so hand-built fixtures predating
   * categories stay valid; every task that came off the API carries it.
   */
  category?: TaskCategoryRef | null;
  subtasks: Subtask[];
  created_by: string;
  created_by_name?: string | null;
  created_at: string;        // ISO
  updated_at: string;        // ISO
  completed_at: string | null;
  activity: TaskActivity[];
  comments: TaskComment[];
  ai: TaskAI;
  /**
   * Files on the task (slice 12), for the board card. Optional only so hand-built fixtures stay
   * valid; every task that came off the API carries it, and a write response keeps the one held.
   */
  attachment_count?: number;
}

/**
 * The attachment route segment a task's files live under (`/api/attachments/task/:id`). The one
 * spelling both drawers and any upload-after-create flow use, so a task file can never be sent to
 * a different entity by a typo.
 */
export const TASK_ATTACHMENT_ENTITY = 'task';

/** A reference person the NL parser and assignee suggester match against. */
export interface TaskPerson {
  id: string;
  name: string;
  role: string;
  department: string;
}
