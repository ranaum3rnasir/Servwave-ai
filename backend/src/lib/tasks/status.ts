/**
 * The Task status model, in ONE place.
 *
 * `DONE` used to be hard-coded as "the terminal status" at roughly a dozen backend sites plus
 * the whole frontend: open-task counts, the risk score, the KPI tiles, the History membership
 * test. Adding `CANCELLED` made every one of them wrong by exactly one value, silently, because
 * each said `status !== 'DONE'` in its own words.
 *
 * So the enumeration lives here and nowhere else. A future status is a one-line change to
 * `TERMINAL_TASK_STATUSES` (or to `TASK_STATUSES` if it is an open one), not a grep.
 *
 * Shape follows `TERMINAL_LEAD_STATUSES` in `services/lead-stage.service.ts`.
 */

/** Every value of the `TaskStatus` enum, in schema order. The Zod route schemas read this. */
export const TASK_STATUSES = ['TODO', 'IN_PROGRESS', 'BLOCKED', 'DONE', 'CANCELLED'] as const;

export type TaskStatusValue = (typeof TASK_STATUSES)[number];

/**
 * The FINISHED statuses. `DONE` means the work completed; `CANCELLED` means it was abandoned.
 * They differ in every other respect, but neither is an outstanding obligation, so neither is
 * open, overdue, or at risk.
 *
 * `CANCELLED` deliberately does NOT set `completed_at` (issue 03): that column means the work
 * finished. Nothing here may be used to infer that it did.
 */
export const TERMINAL_TASK_STATUSES = ['DONE', 'CANCELLED'] as const;

export type TerminalTaskStatus = (typeof TERMINAL_TASK_STATUSES)[number];

/** True when the task is finished (either way) and so is not an open obligation. */
export function isTerminalTaskStatus(status: string | null | undefined): boolean {
  return !!status && (TERMINAL_TASK_STATUSES as readonly string[]).includes(status);
}

/**
 * Prisma `where.status` fragment selecting the OPEN tasks.
 *
 * A FUNCTION, not a shared constant: Prisma `where` objects get spread, mutated and reused by
 * callers, and one caller editing a module-level literal would corrupt every other count in the
 * process. Same reasoning as `diffIdSets` handing back a fresh delta each call.
 */
export function openTaskStatusFilter(): { notIn: TerminalTaskStatus[] } {
  return { notIn: [...TERMINAL_TASK_STATUSES] };
}
