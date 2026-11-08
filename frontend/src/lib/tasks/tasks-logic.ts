import { isCompletedTaskStatus, isTerminalTaskStatus, type Task, type TaskPerson } from './types';
import { isAssignedTo, matchesAssignee } from './assignees';

/**
 * The instant a task stopped being work, or null while it is still open.
 *
 * DONE carries `completed_at`, stamped when the work finished. CANCELLED deliberately never
 * sets it (issue 03) - that column means the work FINISHED - so the abandonment instant has to
 * come from `updated_at`, which is exact when cancelling was the last edit and drifts later if
 * the row is touched afterwards. The timeline holds the precise event, and list rows carry no
 * timeline, so this is the closest honest answer a list row can give.
 *
 * A DONE row with no `completed_at` is bad data and gets no instant at all, which is what the
 * old `status !== 'DONE' || !completed_at` guard in the completion log was for.
 */
export function taskClosedAt(task: Task): Date | null {
  if (isCompletedTaskStatus(task.status)) {
    if (!task.completed_at) return null;
    const at = new Date(task.completed_at);
    return Number.isNaN(at.getTime()) ? null : at;
  }
  if (task.status !== 'CANCELLED') return null;
  const at = new Date(task.updated_at);
  return Number.isNaN(at.getTime()) ? null : at;
}

export function isOverdue(task: Task, now: Date): boolean {
  if (!task.due_at || isTerminalTaskStatus(task.status)) return false;
  return new Date(task.due_at).getTime() < now.getTime();
}

export function ageInStageMs(task: Task, now: Date): number {
  return now.getTime() - new Date(task.updated_at).getTime();
}

export interface RiskContext {
  now: Date;
  /**
   * Open-task load of the BUSIEST assignee on this task.
   *
   * A task with three assignees is at risk if ANY ONE of them is drowning, so
   * the max is the honest input - averaging would let two idle helpers mask an
   * overloaded lead, and summing would call every shared task overloaded.
   * `assigneeOpenCountFor` computes it; every caller should use that rather
   * than picking a number itself.
   */
  assigneeOpenCount: number;
}

export interface RiskResult {
  score: number;
  reason: string | null;
  atRisk: boolean;
}

const DAY = 24 * 60 * 60 * 1000;

export function assessRisk(task: Task, ctx: RiskContext): RiskResult {
  if (isTerminalTaskStatus(task.status)) return { score: 0, reason: null, atRisk: false };

  const reasons: string[] = [];
  let score = 0;

  if (task.due_at) {
    const msToDue = new Date(task.due_at).getTime() - ctx.now.getTime();
    if (msToDue < 0) { score += 45; reasons.push('overdue'); }
    else if (msToDue < DAY) { score += 30; reasons.push('due within 24h'); }
    else if (msToDue < 2 * DAY) { score += 18; reasons.push('due within 48h'); }
  }

  const ageDays = ageInStageMs(task, ctx.now) / DAY;
  if (ageDays >= 5) { score += 20; reasons.push(`sat ${Math.floor(ageDays)}d in ${task.status.toLowerCase()}`); }
  else if (ageDays >= 3) { score += 10; }

  if (ctx.assigneeOpenCount >= 8) { score += 20; reasons.push('assignee overloaded'); }
  else if (ctx.assigneeOpenCount >= 5) { score += 10; }

  if (task.status === 'BLOCKED') { score += 15; reasons.push('blocked'); }

  score = Math.min(100, score);
  return {
    score,
    reason: reasons.length ? reasons.join(', ') : null,
    atRisk: score >= 50,
  };
}

const PRIORITY_RANK: Record<Task['priority'], number> = { URGENT: 0, HIGH: 1, MEDIUM: 2, LOW: 3 };

/**
 * UTC day equality, for DUE DATES ONLY.
 *
 * `due_at` is a calendar date the org typed ("this is due on the 12th"). It is
 * stored at a UTC midnight and every date control in this module reads it back
 * in UTC, so a due date never drifts a day for a reader in another timezone.
 *
 * Do NOT reach for this when bucketing `completed_at` - see the completion-log
 * block near the bottom of this file for why the two are deliberately
 * different.
 */
function isSameUtcDay(a: Date, b: Date): boolean {
  return a.getUTCFullYear() === b.getUTCFullYear()
    && a.getUTCMonth() === b.getUTCMonth()
    && a.getUTCDate() === b.getUTCDate();
}

function myDayBucket(task: Task, now: Date): number {
  if (isOverdue(task, now)) return 0;
  if (task.due_at && isSameUtcDay(new Date(task.due_at), now)) return 1;
  return 2;
}

export function rankMyDay(tasks: Task[], userId: string, now: Date): Task[] {
  return tasks
    .filter((t) => isAssignedTo(t, userId) && !isTerminalTaskStatus(t.status))
    .sort((a, b) => {
      const ba = myDayBucket(a, now);
      const bb = myDayBucket(b, now);
      if (ba !== bb) return ba - bb;
      const pa = PRIORITY_RANK[a.priority];
      const pb = PRIORITY_RANK[b.priority];
      if (pa !== pb) return pa - pb;
      return ageInStageMs(b, now) - ageInStageMs(a, now);
    });
}

export interface AssigneeStat { userId: string; open: number; overdue: number; }
export interface TrendPoint { weekIndex: number; done: number; }
export interface TaskStats {
  open: number;
  atRisk: number;
  onTimePct: number;
  blocked: number;
  topCloserId: string | null;
  byAssignee: AssigneeStat[];
  trend: TrendPoint[];
}

/**
 * Open tasks per assignee.
 *
 * A task with three assignees counts ONCE FOR EACH of them, so the totals here
 * deliberately exceed the number of tasks. That is the question being asked -
 * "how much is on this person's plate" - and three people each owing the same
 * deliverable each really do owe it. Do not "fix" the totals to sum to the task
 * count; that would be a different, less useful metric.
 */
export function assigneeOpenCounts(tasks: Task[]): Map<string, number> {
  const m = new Map<string, number>();
  for (const t of tasks) {
    if (isTerminalTaskStatus(t.status)) continue;
    for (const id of t.assignee_ids) m.set(id, (m.get(id) ?? 0) + 1);
  }
  return m;
}

/** The busiest assignee's load - see `RiskContext.assigneeOpenCount`. */
export function assigneeOpenCountFor(task: Task, counts: Map<string, number>): number {
  let max = 0;
  for (const id of task.assignee_ids) max = Math.max(max, counts.get(id) ?? 0);
  return max;
}

export function computeStats(tasks: Task[], now: Date): TaskStats {
  const openCounts = assigneeOpenCounts(tasks);

  const open = tasks.filter((t) => !isTerminalTaskStatus(t.status)).length;
  const blocked = tasks.filter((t) => t.status === 'BLOCKED').length;

  const atRisk = tasks.filter(
    (t) => assessRisk(t, { now, assigneeOpenCount: assigneeOpenCountFor(t, openCounts) }).atRisk,
  ).length;

  // COMPLETED, not merely closed: the on-time rate, the top-closer credit and the trend line
  // all describe delivered work, and a cancelled task delivered none.
  const done = tasks.filter((t) => isCompletedTaskStatus(t.status) && t.completed_at);
  const onTime = done.filter((t) => t.due_at && new Date(t.completed_at!).getTime() <= new Date(t.due_at).getTime()).length;
  const onTimePct = done.length === 0 ? 100 : Math.round((onTime / done.length) * 100);

  // Same per-assignee rule as the open counts: everyone who held a closed task
  // gets credit for closing it.
  const closeCounts = new Map<string, number>();
  for (const t of done) {
    for (const id of t.assignee_ids) closeCounts.set(id, (closeCounts.get(id) ?? 0) + 1);
  }
  let topCloserId: string | null = null;
  let topCount = -1;
  for (const [uid, c] of closeCounts) if (c > topCount) { topCount = c; topCloserId = uid; }

  const byAssignee: AssigneeStat[] = Array.from(openCounts.keys()).map((userId) => ({
    userId,
    open: openCounts.get(userId) ?? 0,
    overdue: tasks.filter((t) => isAssignedTo(t, userId) && isOverdue(t, now)).length,
  })).sort((a, b) => b.open - a.open);

  const WEEK = 7 * DAY;
  const trend: TrendPoint[] = Array.from({ length: 8 }, (_, i) => ({ weekIndex: i, done: 0 }));
  for (const t of done) {
    const weeksAgo = Math.floor((now.getTime() - new Date(t.completed_at!).getTime()) / WEEK);
    if (weeksAgo >= 0 && weeksAgo < 8) { const pt = trend[7 - weeksAgo]; if (pt) pt.done += 1; }
  }

  return { open, atRisk, onTimePct, blocked, topCloserId, byAssignee, trend };
}

// ---------------------------------------------------------------------------
// Filter
// ---------------------------------------------------------------------------

export type TaskDrillDown = 'all' | 'open' | 'atRisk' | 'onTime' | 'blocked';

/**
 * The "No category" entry of the task category facet: matches a task filed under no category.
 * Task category ids are uuids, so the sentinel cannot collide with one.
 */
export const NO_CATEGORY_FILTER_VALUE = 'none';

export interface TaskFilter {
  memberId: string;     // 'all' or a person id
  departmentId: string; // 'all' or a department id
  /**
   * The Filter popover's Category facet: task category ids, plus `NO_CATEGORY_FILTER_VALUE` for tasks with
   * none. A task matches when it is in ANY of them; empty (or omitted) means every task. Not
   * `category` below - that is the Dashboard KPI drill-down, a different thing.
   */
  categoryIds?: string[];
  category?: TaskDrillDown; // optional drill-down from the dashboard KPI cards
  overdue?: boolean;
  atRisk?: boolean;
  dueFrom?: string;     // 'YYYY-MM-DD' | ''
  dueTo?: string;       // 'YYYY-MM-DD' | ''
  createdFrom?: string; // 'YYYY-MM-DD' | ''
  createdTo?: string;   // 'YYYY-MM-DD' | ''
}

export const ALL_FILTER: TaskFilter = { memberId: 'all', departmentId: 'all', categoryIds: [], category: 'all' };

/** Whether a task is in any of the selected task categories; an empty selection matches every task. */
export function matchesTaskCategories(task: Task, categoryIds: readonly string[] | undefined): boolean {
  if (!categoryIds || categoryIds.length === 0) return true;
  return categoryIds.includes(task.category?.id ?? NO_CATEGORY_FILTER_VALUE);
}

/**
 * The selected category ids that still exist: `NO_CATEGORY_FILTER_VALUE` always does, a real id only while
 * it is in `categories`. Until the list has loaded (`undefined`) the selection is kept as it is.
 */
export function liveCategoryIds(
  selected: string[],
  categories: readonly { id: string }[] | undefined,
): string[] {
  if (!categories) return selected;
  const known = new Set(categories.map((c) => c.id));
  const live = selected.filter((id) => id === NO_CATEGORY_FILTER_VALUE || known.has(id));
  return live.length === selected.length ? selected : live;
}

/**
 * How many of `tasks` sit in each task category, keyed by category id, with the uncategorised
 * under `NO_CATEGORY_FILTER_VALUE`. A category no task uses is absent (read it as 0).
 *
 * Pass the list with every OTHER facet applied and the category facet left open: each count is
 * then exactly what ticking that category alone would show.
 */
export function countTasksByCategory(tasks: readonly Task[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const t of tasks) {
    const key = t.category?.id ?? NO_CATEGORY_FILTER_VALUE;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
}

// people: list used to resolve an assignee's department for the department filter.
//
// Both the member and the department arms are ANY-ASSIGNEE tests, not equality
// on one person: a task shared by Sales and Field shows under BOTH department
// filters, and under either member's filter. Anything narrower would hide a
// task from someone who is genuinely on it.
export function applyTaskFilter(tasks: Task[], filter: TaskFilter, people: TaskPerson[], now: Date = new Date()): Task[] {
  const deptOf = (userId: string) => people.find((p) => p.id === userId)?.department ?? null;
  const openCounts = filter.atRisk ? assigneeOpenCounts(tasks) : null;
  const base = tasks.filter((t) => {
    if (filter.memberId !== 'all' && !isAssignedTo(t, filter.memberId)) return false;
    if (filter.departmentId !== 'all'
      && !t.assignee_ids.some((id) => deptOf(id) === filter.departmentId)) return false;
    if (filter.overdue && !isOverdue(t, now)) return false;
    if (filter.atRisk && !assessRisk(t, { now, assigneeOpenCount: assigneeOpenCountFor(t, openCounts!) }).atRisk) return false;
    if (filter.dueFrom || filter.dueTo) {
      if (!t.due_at) return false;
      const d = t.due_at.slice(0, 10);
      if (filter.dueFrom && d < filter.dueFrom) return false;
      if (filter.dueTo && d > filter.dueTo) return false;
    }
    if (filter.createdFrom || filter.createdTo) {
      const c = t.created_at.slice(0, 10);
      if (filter.createdFrom && c < filter.createdFrom) return false;
      if (filter.createdTo && c > filter.createdTo) return false;
    }
    return true;
  });

  // The task category facet narrows LAST, after the KPI drill-down: nothing before it depends on
  // it (the at-risk arms size each assignee's workload over the whole scoped list, not one
  // category of it), so the per-category counts the popover shows - taken over this function's
  // result with the facet left open - are exactly what ticking a category then shows.
  return drillDown(base, filter.category ?? 'all', now)
    .filter((t) => matchesTaskCategories(t, filter.categoryIds));
}

function drillDown(base: Task[], category: TaskDrillDown, now: Date): Task[] {
  if (category === 'all') return base;
  if (category === 'open') return base.filter((t) => !isTerminalTaskStatus(t.status));
  if (category === 'blocked') return base.filter((t) => t.status === 'BLOCKED');
  if (category === 'onTime') {
    return base.filter((t) =>
      isCompletedTaskStatus(t.status) && !!t.completed_at && !!t.due_at &&
      new Date(t.completed_at).getTime() <= new Date(t.due_at).getTime());
  }
  // atRisk — compute assignee open-counts over `base` so the drilled list
  // exactly matches computeStats' At Risk card for the same member/department scope.
  const catOpenCounts = assigneeOpenCounts(base);
  return base.filter((t) => assessRisk(t, { now, assigneeOpenCount: assigneeOpenCountFor(t, catOpenCounts) }).atRisk);
}

// ---------------------------------------------------------------------------
// History analytics
// ---------------------------------------------------------------------------

export interface HistorySnapshot { todo: number; inProgress: number; blocked: number; done: number; cancelled: number; }
export interface FlowPoint { weekIndex: number; created: number; closed: number; }
export interface UpcomingBuckets { thisWeek: Task[]; nextWeek: Task[]; later: Task[]; }
export interface TaskHistory {
  snapshot: HistorySnapshot;
  flow: FlowPoint[];        // last 8 weeks, index 0 = oldest, 7 = current
  upcoming: UpcomingBuckets;
}

export function computeHistory(tasks: Task[], now: Date): TaskHistory {
  const DAY_MS = 24 * 60 * 60 * 1000;
  const WEEK_MS = 7 * DAY_MS;

  const snapshot: HistorySnapshot = {
    todo:       tasks.filter((t) => t.status === 'TODO').length,
    inProgress: tasks.filter((t) => t.status === 'IN_PROGRESS').length,
    blocked:    tasks.filter((t) => t.status === 'BLOCKED').length,
    done:       tasks.filter((t) => isCompletedTaskStatus(t.status)).length,
    // Its own bucket rather than folded into `done`: the snapshot is a census of where the
    // work stands, and "finished" and "abandoned" are different answers to that.
    cancelled:  tasks.filter((t) => t.status === 'CANCELLED').length,
  };

  const flow: FlowPoint[] = Array.from({ length: 8 }, (_, i) => ({ weekIndex: i, created: 0, closed: 0 }));
  const bucketIdx = (iso: string) => {
    const weeksAgo = Math.floor((now.getTime() - new Date(iso).getTime()) / WEEK_MS);
    return weeksAgo >= 0 && weeksAgo < 8 ? 7 - weeksAgo : -1;
  };
  for (const t of tasks) {
    const ci = bucketIdx(t.created_at);
    if (ci >= 0) flow[ci]!.created += 1;
    // CLOSED, either way: the flow chart weighs work arriving against work leaving the
    // backlog, and a cancellation removes it from the backlog exactly as a completion does.
    const closedAt = taskClosedAt(t);
    if (closedAt) {
      const di = bucketIdx(closedAt.toISOString());
      if (di >= 0) flow[di]!.closed += 1;
    }
  }

  const upcoming: UpcomingBuckets = { thisWeek: [], nextWeek: [], later: [] };
  for (const t of tasks) {
    if (isTerminalTaskStatus(t.status) || !t.due_at) continue;
    const ms = new Date(t.due_at).getTime() - now.getTime();
    if (ms < 0) continue;                 // overdue is not "upcoming"
    if (ms <= WEEK_MS) upcoming.thisWeek.push(t);
    else if (ms <= 2 * WEEK_MS) upcoming.nextWeek.push(t);
    else upcoming.later.push(t);
  }

  return { snapshot, flow, upcoming };
}

// ---------------------------------------------------------------------------
// Completion log
//
// LOCAL DAY, NOT UTC - deliberate, and the opposite of `isSameUtcDay` above.
// Do not "align" the two.
//
//   due_at       a calendar date somebody typed. Read in UTC so "due on the
//                12th" stays the 12th no matter who opens the page.
//   completed_at a real instant, stamped the moment someone closed the task.
//                An instant has no calendar day of its own - only the reader's
//                clock gives it one. Bucketing it by its UTC day files a task
//                closed at 8pm ET on Friday under Saturday, and prints its
//                time as 12:00 AM, which is simply the wrong story about when
//                the person did the work.
//
// So everything below reads LOCAL calendar parts and formats without a
// `timeZone` option.
// ---------------------------------------------------------------------------

export type CompletionRange = '7d' | '30d' | '90d' | 'all';
export type CompletionScope = 'mine' | 'everyone';

export interface CompletionLogQuery {
  /** 'mine' keeps only the viewer's own closures. */
  scope: CompletionScope;
  viewerId: string;
  range: CompletionRange;
  /** Free text over title, task number, assignees and linked entity. */
  search: string;
}

export interface CompletionEntry {
  task: Task;
  /**
   * Which way the task ended. The History table paints the two differently and must not have
   * to re-derive it from `task.status`, which is also what a caller filtering the log reads.
   */
  outcome: 'DONE' | 'CANCELLED';
  /** When it closed - `completed_at` for a completion, `updated_at` for a cancellation. */
  completedAt: Date;
  /** How long the task was open. `null` when `created_at` is unparseable. */
  timeToCloseMs: number | null;
}

export interface CompletionDayGroup {
  /** 'YYYY-MM-DD' in the VIEWER'S calendar - the group's identity. */
  key: string;
  /** Local midnight of that day, for labelling. */
  date: Date;
  entries: CompletionEntry[];
}

const COMPLETION_RANGE_DAYS: Record<CompletionRange, number | null> = {
  '7d': 7,
  '30d': 30,
  '90d': 90,
  all: null,
};

/**
 * 'YYYY-MM-DD' from a date's LOCAL calendar parts. Mirrors `isoDateLocal` in
 * `lib/format-date`, restated here so this module keeps importing nothing but
 * its own types. Never `toISOString()`, which shifts to UTC and can report the
 * previous day.
 */
export function localDayKey(d: Date): string {
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${m}-${day}`;
}

function matchesCompletionSearch(task: Task, needle: string): boolean {
  if (!needle) return true;
  return task.title.toLowerCase().includes(needle)
    || task.task_number.toLowerCase().includes(needle)
    || matchesAssignee(task, needle)
    || (task.linked_entity?.label ?? '').toLowerCase().includes(needle);
}

/**
 * The closed-task log, newest first.
 *
 * `tasks` is whatever the hub's Member/Department/Category filter already narrowed
 * to, so this only layers the log's own dimensions on top: closed (see
 * `taskClosedAt`), the viewer's own work unless the scope is widened, inside
 * the range, matching the search.
 *
 * BOTH terminal statuses land here (issue 03). A cancelled task is closed work
 * and History is the only surface that shows it, so excluding it would make it
 * unreachable; `outcome` is what keeps it from reading as a completion.
 */
export function selectCompletionLog(
  tasks: Task[],
  query: CompletionLogQuery,
  now: Date,
): CompletionEntry[] {
  const days = COMPLETION_RANGE_DAYS[query.range];
  const cutoff = days === null ? null : now.getTime() - days * DAY;
  const needle = query.search.trim().toLowerCase();

  const entries: CompletionEntry[] = [];
  for (const task of tasks) {
    const completedAt = taskClosedAt(task);
    if (!completedAt) continue;
    if (query.scope === 'mine' && !isAssignedTo(task, query.viewerId)) continue;

    const closedMs = completedAt.getTime();
    if (cutoff !== null && closedMs < cutoff) continue;
    if (!matchesCompletionSearch(task, needle)) continue;

    const createdMs = new Date(task.created_at).getTime();
    entries.push({
      task,
      outcome: isCompletedTaskStatus(task.status) ? 'DONE' : 'CANCELLED',
      completedAt,
      // Clamped at 0: a row whose completed_at precedes its created_at is bad
      // data, and "closed in -3d" is worse than "closed in <1m".
      timeToCloseMs: Number.isNaN(createdMs) ? null : Math.max(0, closedMs - createdMs),
    });
  }

  return entries.sort((a, b) => b.completedAt.getTime() - a.completedAt.getTime());
}

/**
 * Buckets an already-sorted log into local days, preserving the input order
 * both between groups and inside them.
 */
export function groupCompletionsByLocalDay(entries: CompletionEntry[]): CompletionDayGroup[] {
  const groups: CompletionDayGroup[] = [];
  const byKey = new Map<string, CompletionDayGroup>();

  for (const entry of entries) {
    const key = localDayKey(entry.completedAt);
    let group = byKey.get(key);
    if (!group) {
      const d = entry.completedAt;
      group = { key, date: new Date(d.getFullYear(), d.getMonth(), d.getDate()), entries: [] };
      byKey.set(key, group);
      groups.push(group);
    }
    group.entries.push(entry);
  }

  return groups;
}

/** 'Today' / 'Yesterday' / 'Fri, Jun 5' - relative to the viewer's local day. */
export function formatCompletionDayLabel(day: Date, now: Date): string {
  const key = localDayKey(day);
  if (key === localDayKey(now)) return 'Today';

  const yesterday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1);
  if (key === localDayKey(yesterday)) return 'Yesterday';

  // No `timeZone` option anywhere below: the viewer's zone is the whole point.
  return new Intl.DateTimeFormat('en-US', {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    ...(day.getFullYear() === now.getFullYear() ? {} : { year: 'numeric' }),
  }).format(day);
}

/** Wall-clock time of the close, in the viewer's zone. */
export function formatCompletionTime(at: Date): string {
  return new Intl.DateTimeFormat('en-US', { hour: 'numeric', minute: '2-digit' }).format(at);
}

/** Compact "how long it stayed open": '<1m' / '45m' / '6h' / '3d' / '2w'. */
export function formatTimeToClose(ms: number | null): string | null {
  if (ms === null || !Number.isFinite(ms) || ms < 0) return null;

  const minutes = Math.round(ms / 60000);
  if (minutes < 1) return '<1m';
  if (minutes < 60) return `${minutes}m`;

  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h`;

  const days = Math.round(hours / 24);
  if (days < 14) return `${days}d`;

  return `${Math.round(days / 7)}w`;
}
