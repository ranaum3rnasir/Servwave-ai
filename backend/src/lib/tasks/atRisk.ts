import { isTerminalTaskStatus } from './status';

/**
 * The "At risk" rule the Tasks hub has always applied in the browser (`assessRisk` in
 * frontend/src/lib/tasks/tasks-logic.ts), moved here so the list can filter on it BEFORE a page
 * is cut. It is a different score from `computeTaskRisk` (risk.ts), which is the number shown
 * on a row; this one decides membership of the "At risk" filter and the Dashboard drill-down, and
 * the two must keep answering as the browser-side rule does. The cases in
 * __tests__/atRisk.test.ts are the same hand-worked ones the frontend rule is pinned with.
 *
 * The inputs are exactly the browser's: a due date, how long the task has sat in its stage
 * (`updated_at`), its status, and the open-task load of its BUSIEST assignee.
 */

const DAY = 24 * 60 * 60 * 1000;

export interface AtRiskRow {
  id: string;
  status: string;
  due_at: Date | null;
  updated_at: Date;
  assignee_ids: string[];
}

export function atRiskScore(row: AtRiskRow, now: Date, assigneeOpenCount: number): number {
  if (isTerminalTaskStatus(row.status)) return 0;
  let score = 0;

  if (row.due_at) {
    const msToDue = row.due_at.getTime() - now.getTime();
    if (msToDue < 0) score += 45;
    else if (msToDue < DAY) score += 30;
    else if (msToDue < 2 * DAY) score += 18;
  }

  const ageDays = (now.getTime() - row.updated_at.getTime()) / DAY;
  if (ageDays >= 5) score += 20;
  else if (ageDays >= 3) score += 10;

  if (assigneeOpenCount >= 8) score += 20;
  else if (assigneeOpenCount >= 5) score += 10;

  if (row.status === 'BLOCKED') score += 15;

  return Math.min(100, score);
}

/**
 * Open tasks per assignee. A task with three assignees counts once for EACH of them (the
 * question is "how much is on this person's plate"), exactly as the browser's
 * `assigneeOpenCounts` does.
 */
export function assigneeOpenCounts(rows: readonly AtRiskRow[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const r of rows) {
    if (isTerminalTaskStatus(r.status)) continue;
    for (const id of r.assignee_ids) counts.set(id, (counts.get(id) ?? 0) + 1);
  }
  return counts;
}

/**
 * The ids in `candidates` that are at risk, with every assignee's load counted over `loadBasis`
 * (which is where the two callers differ: the "At risk" flag sizes the load over the caller's
 * whole visible list, the Dashboard drill-down over the filtered list - as the browser did).
 */
export function atRiskIds(
  candidates: readonly AtRiskRow[],
  loadBasis: readonly AtRiskRow[],
  now: Date,
): string[] {
  const counts = assigneeOpenCounts(loadBasis);
  return candidates
    .filter((r) => {
      let busiest = 0;
      for (const id of r.assignee_ids) busiest = Math.max(busiest, counts.get(id) ?? 0);
      return atRiskScore(r, now, busiest) >= 50;
    })
    .map((r) => r.id);
}
