import { Request, Response } from 'express';
import { z } from 'zod';
import { prisma } from '../lib/prisma';
import { logger } from '../lib/logger';
import { tenantWhere } from '../lib/tenant';
import { allocateNumber } from '../lib/numbering';
import { withNumberCollisionRetry } from '../lib/number-collision-retry';
import { taskVisibilityWhere, canAccessTask, canAccessLinkedEntity } from '../lib/tasks/visibility';
import { resolveEntityLabels, resolveUserNames, entityLabelFields, userFullName } from '../lib/tasks/enrich';
import { entityRefKey, ENTITY_DELEGATES } from '../lib/tasks/entityAccess';
import { readersWithEntityAccess } from '../lib/tasks/entityAccessCohort';
import { computeTaskRisk } from '../lib/tasks/risk';
import { TASK_STATUSES, isTerminalTaskStatus } from '../lib/tasks/status';
import { recordTaskActivity, diffTaskActivities, diffIdSets, toIdSet } from '../lib/tasks/activity';
import { deleteTasks, announceTaskDeletions } from '../lib/tasks/deletion';
import { TASK_CATEGORY_INCLUDE } from '../lib/tasks/categories';
import { taskAttachmentCounts } from '../lib/tasks/attachmentCounts';
import { isTaskCategoryInOrg, isMissingTaskCategoryError, UNKNOWN_TASK_CATEGORY } from '../lib/tasks/categoryScope';
import { resolveWatcherPoolForRequest, isWatcherPermitted } from '../lib/permissions/watcherPool';
import { dispatchAutomationEvent } from '../services/automations/dispatch';
import { taskTransitionInto, taskTransitionEvent } from '../services/automations/taskTransitions';
import { DEFAULT_TIMEZONE, getRequestOrgTimezone } from '../lib/timezone';
import { emitTaskNotification, type TaskRef } from '../lib/tasks/notify';

// ─── Zod Schemas ───────────────────────────────────────

/**
 * Per-request channel toggles, mirroring the job assign endpoint's shape (#361):
 *   in_app:false → suppress the bell emits for people newly put on the task
 *   email:false  → suppress the Automation Center dispatch
 * Omitted → today's behaviour exactly, on both channels. A dispatcher muting a one-off
 * task email does it exactly as they already mute a one-off job one.
 */
const notifyOptionsSchema = z
  .object({ in_app: z.boolean().optional(), email: z.boolean().optional() })
  .optional();

export const createTaskSchema = z.object({
  title: z.string().min(1),
  description: z.string().optional(),
  status: z.enum(TASK_STATUSES).optional(),
  priority: z.enum(['LOW', 'MEDIUM', 'HIGH', 'URGENT']).optional(),
  // Flat set of assignees (design §2). `owner_id` is gone; Zod strips it if a stale client sends it.
  assignee_ids: z.array(z.string().uuid()).optional(),
  due_at: z.string().datetime({ offset: true }).nullable().optional(),
  linked_entity_type: z.enum(['JOB', 'LEAD', 'CUSTOMER', 'ESTIMATE']).optional(),
  linked_entity_id: z.string().uuid().optional(),
  tags: z.array(z.string()).optional(),
  watcher_ids: z.array(z.string().uuid()).optional(),
  // At most one category, none is fine. Must be in the caller's org (checked in the handler).
  category_id: z.string().uuid().nullable().optional(),
  ai_source: z.enum(['MANUAL', 'AI_NL', 'AI_TEMPLATE', 'AI_EXTRACT']).optional(),
  ai_suggested_by: z.string().optional(),
  notify: notifyOptionsSchema,
}).refine(
  (d) => (d.linked_entity_type == null) === (d.linked_entity_id == null),
  { message: 'linked_entity_type and linked_entity_id must both be provided or both omitted', path: ['linked_entity_id'] }
);

export const updateTaskSchema = z.object({
  title: z.string().min(1).optional(),
  description: z.string().optional(),
  status: z.enum(TASK_STATUSES).optional(),
  priority: z.enum(['LOW', 'MEDIUM', 'HIGH', 'URGENT']).optional(),
  assignee_ids: z.array(z.string().uuid()).optional(),
  due_at: z.string().datetime({ offset: true }).nullable().optional(),
  tags: z.array(z.string()).optional(),
  watcher_ids: z.array(z.string().uuid()).optional(),
  // Change or clear (null) the category. Part of editing the task - no extra permission - but the
  // category must be in the task's own org.
  category_id: z.string().uuid().nullable().optional(),
  // `email:false` suppresses the TASK_ASSIGNED dispatch for the people this PATCH adds,
  // exactly as it suppresses TASK_CREATED on the create door and the added-crew dispatch on
  // the job assign door (#361). It does not touch the removal/completion/cancellation notices.
  notify: notifyOptionsSchema,
});

export const commentSchema = z.object({
  body: z.string().min(1),
});

export const subtaskCreateSchema = z.object({
  text: z.string().min(1),
});

export const subtaskUpdateSchema = z.object({
  text: z.string().min(1).optional(),
  done: z.boolean().optional(),
});

// ─── Helpers ───────────────────────────────────────────

const param = (req: Request, name: string): string => req.params[name] as string;

const ASSIGN_SELF_ONLY = 'You can only assign tasks to yourself.';
const AT_LEAST_ONE     = 'A task must have at least one assignee.';
const STATUS_CONFLICT  = 'This task was changed by someone else. Reload it and try again.';
const NOT_ORG_MEMBERS  = 'Assignees and watchers must be active users of your organization.';
const WATCHER_OUT_OF_POOL = 'You can only add yourself, an admin, or someone in your department as a watcher.';

/**
 * The status move lost a race to a DIFFERENT status (see update()'s compare-and-set). Thrown
 * inside the transaction so the whole PATCH rolls back, and answered 409 STATE_CONFLICT - the
 * shape inv-assets.controller.ts's lifecycle verbs answer the same race with.
 */
class TaskStatusConflictError extends Error {}

/** Design §3 — assigning OTHER people is a grant (`assign` on Task), never a role test. */
const canAssignOthers = (req: Request): boolean => req.ability?.can('assign', 'Task') ?? false;

const sameSet = (a: string[], b: string[]): boolean =>
  a.length === b.length && a.every((x) => b.includes(x));

/**
 * Every assignee/watcher id must name an ACTIVE user of the caller's org — the arrays carry no FK,
 * so nothing else checks it. The actor is exempt: they authenticated as an active user of this org
 * one middleware ago, and exempting them keeps the overwhelmingly common "assign it to myself"
 * create free of an extra round-trip.
 */
async function allActiveOrgMembers(orgId: string, actorId: string, ids: string[]): Promise<boolean> {
  const probe = ids.filter((id) => id !== actorId);
  if (!probe.length) return true;
  const rows = await prisma.user.findMany({
    where: { id: { in: probe }, organization_id: orgId, is_active: true },
    select: { id: true },
  });
  const found = new Set(rows.map((u) => u.id));
  return probe.every((id) => found.has(id));
}

/**
 * WATCHERS THE ACTOR IS ADDING must fall inside their watcher pool (#1956): themselves, any
 * admin, or their own department — or the whole org for a `manage all` holder.
 *
 * The rule itself lives in `watcherPool.ts`, which the roster endpoint asks for the matching
 * QUERY FRAGMENT. This side asks for the PREDICATE, so the picker and the save are two faces of
 * one definition. That is the entire defect being fixed: the picker used to narrow on
 * `assign Task` — a grant in no default role — while this controller checked nothing but org
 * membership, so the field was simultaneously too narrow to use and open to any id posted
 * directly at the API.
 *
 * The candidates are fetched WITHOUT the pool fragment and judged by the predicate, rather than
 * fetched THROUGH the fragment and counted. Counting would let this path pass while the
 * predicate rotted, and the predicate is what the unit suite pins.
 *
 * Returns the offending ids, empty when everything is permitted. Fail-closed: an id with no row
 * (deleted mid-request, or another tenant's — the `organization_id` clause is real and is what
 * keeps it out) is treated as outside the pool rather than skipped.
 *
 * CALLED AFTER `allActiveOrgMembers`, never instead of it. That check keeps its 400 and answers
 * a different question ("is this a real active colleague"); this one answers "may YOU add them"
 * with a 403, and collapsing the two onto one status would blur two distinct failures.
 */
async function watchersOutsidePool(
  req: Request,
  orgId: string,
  ids: readonly string[],
): Promise<string[]> {
  if (!ids.length) return [];
  const pool = resolveWatcherPoolForRequest(req);
  // An org-wide pool permits everyone by definition — no query, no round-trip.
  if (pool.scope === 'org') return [];
  const rows = await prisma.user.findMany({
    where: { id: { in: [...ids] }, organization_id: orgId },
    select: { id: true, role: true, department_id: true },
  });
  const byId = new Map(rows.map((r) => [r.id, r]));
  return ids.filter((id) => {
    const row = byId.get(id);
    return !row || !isWatcherPermitted(pool, row);
  });
}

/**
 * Fire one task notification as the requesting user. The rules (post-commit only, the
 * empty-recipients guard, Rule 0's single home) are on `emitTaskNotification` (lib/tasks/notify).
 */
function emitTask(req: Request, verb: string, task: TaskRef, entity: Record<string, string[]>): Promise<void> {
  return emitTaskNotification({ orgId: req.user!.organization_id, actorId: req.user!.id }, verb, task, entity);
}

/** Contract shape: `assignees` / `watchers` are `{ id, name | null }`, order matching the id array. */
const withNames = (ids: string[], names: Map<string, string>) =>
  ids.map((id) => ({ id, name: names.get(id) ?? null }));

// ─── Handlers ──────────────────────────────────────────

/** GET /api/tasks — list tasks within the tenant; optionally filter by linked entity */
export async function list(req: Request, res: Response) {
  try {
    const { linked_entity_type, linked_entity_id } = req.query as Record<string, string | undefined>;

    // #245 — listing an entity's tasks requires access to that entity (SQL row check).
    if (linked_entity_type && linked_entity_id && req.user!.role !== 'ADMIN') {
      if (!(await canAccessLinkedEntity(req, linked_entity_type, linked_entity_id))) {
        res.status(403).json({ error: 'Insufficient permissions' });
        return;
      }
    }

    const where = taskVisibilityWhere(req, { linked_entity_type, linked_entity_id });

    const tasks = await prisma.task.findMany({
      where,
      orderBy: { created_at: 'desc' },
      include: { _count: { select: { subtasks: true } }, ...TASK_CATEGORY_INCLUDE },
    });

    const orgId = req.user!.organization_id;
    // #01 - labels resolve WITHIN the caller's entity scope, batched for the whole page: one query
    // per entity type, never one per task. A link the caller cannot open comes back redacted.
    const labels = await resolveEntityLabels(
      req.user!,
      tasks.filter((t) => t.linked_entity_type && t.linked_entity_id)
           .map((t) => ({ type: t.linked_entity_type as string, id: t.linked_entity_id as string })),
      { ability: req.ability },
    );
    const [names, fileCounts] = await Promise.all([
      resolveUserNames(orgId, tasks.flatMap((t) => toIdSet(t.assignee_ids))),
      taskAttachmentCounts(orgId, tasks.map((t) => t.id)),
    ]);
    const now = new Date();

    res.json({
      tasks: tasks.map((t) => ({
        ...t,
        attachment_count: fileCounts.get(t.id) ?? 0,
        assignees: withNames(toIdSet(t.assignee_ids), names),
        ...entityLabelFields(t, labels),
        risk: computeTaskRisk(t, now),
      })),
    });
  } catch (err) {
    logger.error('List tasks error:', err);
    res.status(500).json({ error: 'Failed to list tasks' });
  }
}

/** POST /api/tasks — create a task; allocates task_number inside a transaction */
export async function create(req: Request, res: Response) {
  try {
    const {
      title,
      description,
      status,
      priority,
      assignee_ids,
      due_at,
      linked_entity_type,
      linked_entity_id,
      tags,
      watcher_ids,
      category_id,
      ai_source,
      ai_suggested_by,
    } = req.body;
    // Read separately rather than folded into the destructure above: `req.body` is `any`, and
    // casting it to a typed shape would turn every other field into `unknown` at the Prisma
    // write below.
    const notify = (req.body as { notify?: { in_app?: boolean; email?: boolean } }).notify;

    // #245 — linking a task to an entity requires that entity to exist in the tenant and
    // be within the caller's read scope (one tenant+scope findFirst; fail-closed).
    if (linked_entity_type && linked_entity_id) {
      if (!(await canAccessLinkedEntity(req, linked_entity_type, linked_entity_id))) {
        res.status(403).json({ error: 'Insufficient permissions' });
        return;
      }
    }

    const orgId = req.user!.organization_id;
    const actorId = req.user!.id;

    // ── Design §3: who ends up on the task ────────────────────────────────────────────────
    // Without the grant the actor may only ever create work for themselves; asking for anyone
    // else (including an empty set) is refused rather than silently rewritten, so a stale or
    // hostile client learns it was denied. With the grant the body wins, and an omitted/empty
    // list falls back to the actor — the create dialog pre-fills self as a REMOVABLE default.
    const requested = assignee_ids === undefined ? undefined : toIdSet(assignee_ids);
    let assignees: string[];
    if (canAssignOthers(req)) {
      assignees = requested?.length ? requested : [actorId];
    } else {
      if (requested && !(requested.length === 1 && requested[0] === actorId)) {
        res.status(403).json({ error: ASSIGN_SELF_ONLY });
        return;
      }
      assignees = [actorId];
    }

    // Watchers are OBSERVERS now, and default to nobody. The actor is deliberately NOT
    // auto-added — that reverses the previous behaviour and is the point (design §1/§3).
    const watchers = toIdSet(watcher_ids ?? []);

    if (!(await allActiveOrgMembers(orgId, actorId, [...new Set([...assignees, ...watchers])]))) {
      res.status(400).json({ error: NOT_ORG_MEMBERS });
      return;
    }

    // On create every watcher is an addition, so the whole set is judged.
    if ((await watchersOutsidePool(req, orgId, watchers)).length) {
      res.status(403).json({ error: WATCHER_OUT_OF_POOL });
      return;
    }

    if (category_id && !(await isTaskCategoryInOrg(req, category_id))) {
      res.status(400).json({ error: UNKNOWN_TASK_CATEGORY });
      return;
    }

    const task = await withNumberCollisionRetry(() => prisma.$transaction(async (tx) => {
      const taskNumber = await allocateNumber(tx, 'task', orgId);

      const created = await tx.task.create({
        data: {
          task_number: taskNumber,
          organization_id: orgId,
          created_by: actorId,
          title,
          description: description ?? '',
          status:      status   ?? 'TODO',
          priority:    priority ?? 'MEDIUM',
          assignee_ids: assignees,
          due_at:      due_at   ? new Date(due_at) : null,
          linked_entity_type: linked_entity_type ?? null,
          linked_entity_id:   linked_entity_id   ?? null,
          tags: tags ?? [],
          watcher_ids: watchers,
          category_id: category_id ?? null,
          ai_source: ai_source ?? 'MANUAL',
          ...(ai_suggested_by !== undefined && { ai_suggested_by }),
        },
        include: TASK_CATEGORY_INCLUDE,
      });

      await recordTaskActivity(tx, {
        taskId: created.id,
        orgId,
        actorId,
        type: 'CREATED',
        description: 'created the task',
      });

      return created;
    }), { label: 'task.create' });

    // ─── Notifications (design §5) — POST-COMMIT ───────────────────────────────────────────
    // At create every name on the task is a newly added one, so the whole list IS the delta.
    const ref: TaskRef = { id: task.id, title: task.title, task_number: task.task_number };
    if (notify?.in_app !== false) {
      await emitTask(req, 'task.assigned', ref, { added_assignee_ids: assignees });
      await emitTask(req, 'task.watching', ref, { added_watcher_ids: watchers });
    }

    // ─── Automation Center event - post-commit, fire-and-forget (#271) ─────────────────────
    // Sits AFTER the bell emits and OUTSIDE the transaction, for the reason the emitTask
    // docblock above records: dispatch is fire-and-forget and a transaction that later rolls
    // back must not leave an enrollment behind for a task that never existed.
    //
    // The entity label is the TITLE, not the task number - same choice, and the same reason,
    // as the bell verbs make: T00042 tells the reader nothing.
    //
    // `actorId` is what keeps the creator out of the audience (Rule 0). It rides the
    // enrollment's event_payload, so it survives a WAIT of any length.
    //
    // ── MUTUAL EXCLUSION, decided deliberately - do NOT add a TASK_ASSIGNED dispatch here ──
    // A task created WITH assignees fires TASK_CREATED and nothing else. TASK_ASSIGNED fires
    // only for someone added to a task that already existed (the update handler below). Both
    // task defaults ship enabled and both address the same people, so firing both here would
    // email every new task's assignees twice on day one, with nothing in the logs to say why.
    //
    // Two established behaviours point the OTHER way, which is why this is written down at
    // three sites rather than one:
    //   * the bell, ten lines above, fires `task.assigned` at create time for the WHOLE
    //     initial roster, on the recorded rationale that at create the whole list is the
    //     delta. After this slice the bell and the automation deliberately disagree about
    //     this moment: a task created with two assignees produces a bell reading "Assigned to
    //     you" and an email whose trigger is "Task is created". That is intended.
    //   * lead.controller.ts's create handler fires LEAD_CREATED *and* LEAD_ASSIGNED for a new
    //     lead that already has an owner. A lead has ONE owner and its two triggers were never
    //     seeded as a pair; a task takes several people and both its defaults ship enabled, so
    //     the same shape doubles here and does not there.
    // -> src/controllers/task.controller.ts update(), and lead.controller.ts's create sites.
    if (notify?.email !== false) {
      dispatchAutomationEvent({
        type: 'TASK_CREATED',
        organizationId: orgId,
        entity: { type: 'task', id: task.id, label: task.title },
        actorId,
      });
    }

    const names = await resolveUserNames(orgId, toIdSet(task.assignee_ids));
    res.status(201).json({ task: { ...task, assignees: withNames(toIdSet(task.assignee_ids), names) } });
  } catch (err) {
    if (isMissingTaskCategoryError(err)) {
      res.status(400).json({ error: UNKNOWN_TASK_CATEGORY });
      return;
    }
    logger.error('Create task error:', err);
    res.status(500).json({ error: 'Failed to create task' });
  }
}

/**
 * PATCH /api/tasks/:id - update a task; status→DONE sets completed_at, every other status
 * (CANCELLED included) clears it. A cancelled task never finished, so it must not carry a
 * completion timestamp (issue 03).
 */
export async function update(req: Request, res: Response) {
  try {
    const id = param(req, 'id');

    const existing = await prisma.task.findFirst({
      where: { id, ...tenantWhere(req) },
    });
    if (!existing) {
      res.status(404).json({ error: 'Task not found' });
      return;
    }
    if (!(await canAccessTask(req, existing))) {
      res.status(403).json({ error: 'Insufficient permissions' });
      return;
    }

    const {
      title,
      description,
      status,
      priority,
      assignee_ids,
      due_at,
      tags,
      watcher_ids,
      category_id,
    } = req.body;
    const notify = (req.body as { notify?: { in_app?: boolean; email?: boolean } }).notify;

    const orgId   = req.user!.organization_id;
    const actorId = req.user!.id;

    const existingAssignees = toIdSet(existing.assignee_ids);
    const existingWatchers  = toIdSet(existing.watcher_ids);

    // A live task always has >= 1 assignee (design §2) — the invariant lives here, not in the DB.
    let nextAssignees: string[] | undefined;
    if (assignee_ids !== undefined) {
      nextAssignees = toIdSet(assignee_ids);
      if (!nextAssignees.length) {
        res.status(400).json({ error: AT_LEAST_ONE });
        return;
      }
      // A non-holder keeps every other field on a task they can see; only the roster is closed to
      // them. Re-sending the SAME set is not a change, so an untouched multi-select never 403s.
      if (!sameSet(nextAssignees, existingAssignees) && !canAssignOthers(req)) {
        res.status(403).json({ error: ASSIGN_SELF_ONLY });
        return;
      }
    }
    const nextWatchers = watcher_ids === undefined ? undefined : toIdSet(watcher_ids);

    const incoming = [...new Set([...(nextAssignees ?? []), ...(nextWatchers ?? [])])];
    if (incoming.length && !(await allActiveOrgMembers(orgId, actorId, incoming))) {
      res.status(400).json({ error: NOT_ORG_MEMBERS });
      return;
    }

    // ONLY THE ADDED WATCHERS are judged (#1956). Re-checking the ones already on the task would
    // mean that renaming a task fails — or silently strips a watcher — whenever someone added
    // earlier has since changed department or the editor is not who added them. The DELTA is what
    // the rule governs; a watcher already present survives an unrelated edit by design.
    if (nextWatchers !== undefined) {
      const added = diffIdSets(existingWatchers, nextWatchers).added;
      if ((await watchersOutsidePool(req, orgId, added)).length) {
        res.status(403).json({ error: WATCHER_OUT_OF_POOL });
        return;
      }
    }

    // Setting the category is part of editing the task (the canAccessTask gate above and the
    // route's `update Task`); the only extra rule is that it names a category of this org.
    if (category_id && !(await isTaskCategoryInOrg(req, category_id))) {
      res.status(400).json({ error: UNKNOWN_TASK_CATEGORY });
      return;
    }

    const data: Record<string, unknown> = {};
    if (title        !== undefined) data.title        = title;
    if (description  !== undefined) data.description  = description;
    if (priority     !== undefined) data.priority     = priority;
    if (nextAssignees !== undefined) data.assignee_ids = nextAssignees;
    if (due_at       !== undefined) data.due_at       = due_at ? new Date(due_at) : null;
    if (tags         !== undefined) data.tags         = tags;
    if (nextWatchers !== undefined) data.watcher_ids  = nextWatchers;
    if (category_id  !== undefined) data.category_id  = category_id;

    // ONE instant for the status change: the completed_at stamp below AND the occurrence key of
    // the transition trigger dispatched after commit, so a run can always be matched to the
    // finish it reports.
    const changedAt = new Date();
    // The status fields are kept apart from `data` because a MOVE is written as a compare-and-set
    // inside the transaction below; re-sending the status the task already has is not a move and
    // is written with everything else, exactly as before.
    const statusData: Record<string, unknown> = {};
    if (status !== undefined) {
      statusData.status = status;
      // DONE only. NOT `isTerminalTaskStatus`: CANCELLED is terminal but did not complete,
      // and stamping it here is exactly the lie the new status exists to stop telling.
      statusData.completed_at = status === 'DONE' ? changedAt : null;
    }
    const statusMoveRequested = status !== undefined && status !== existing.status;
    if (!statusMoveRequested) Object.assign(data, statusData);

    // One lookup covers both the named activity entries (design §6) and the response projection.
    const names = await resolveUserNames(orgId, [...new Set([
      ...existingAssignees, ...(nextAssignees ?? []),
      ...existingWatchers,  ...(nextWatchers ?? []),
    ])]);
    // Resolved BEFORE the write, and only when the PATCH could fire a transition trigger, so no
    // lookup after the commit can turn a committed write into a 500.
    const timeZone = statusMoveRequested ? await getRequestOrgTimezone(req) : DEFAULT_TIMEZONE;

    // The SAME membership diff the activity events below are built from (diffIdSets is the one
    // implementation both go through), reused here as design §5's recipient lists rather than
    // re-derived — a second hand-rolled diff would eventually disagree with the feed.
    const assigneeDelta = diffIdSets(existingAssignees, nextAssignees);
    const watcherDelta  = diffIdSets(existingWatchers, nextWatchers);
    const { task, statusMoved } = await prisma.$transaction(async (tx) => {
      // THE STATUS MOVE IS A COMPARE-AND-SET. `existing` was read before this transaction, so two
      // requests finishing the same task at once (a double-click, two people) both read TODO and
      // both believed they moved it: two "Task is done" runs, two bells, duplicate mail. Only the
      // request whose conditional update matched the status it read has moved the task, and only
      // that request records the change and notifies.
      let moved = false;
      if (statusMoveRequested) {
        const claimed = await tx.task.updateMany({
          where: { id, ...tenantWhere(req), status: existing.status },
          data: { status },
        });
        moved = claimed.count === 1;
        if (!moved) {
          // Lost the race. If the task already sits where this request wanted it, the request is
          // satisfied and carries on with its other fields; if someone moved it somewhere else,
          // writing this request's status over theirs would be the silent lie, so refuse it.
          const current = await tx.task.findFirst({ where: { id, ...tenantWhere(req) }, select: { status: true } });
          if (current?.status !== status) throw new TaskStatusConflictError();
        }
      }

      // The winner writes its completed_at with everything else; the claim above only flipped
      // the status, which is what serialises the race.
      const written = moved ? { ...data, ...statusData } : data;
      const updated = await tx.task.update({
        where: { id },
        data: written,
        include: TASK_CATEGORY_INCLUDE,
      });

      const events = diffTaskActivities(existing, written, names);
      for (const event of events) {
        await recordTaskActivity(tx, {
          taskId: id,
          orgId,
          actorId,
          type: event.type,
          description: event.description,
        });
      }

      return { task: updated, statusMoved: moved };
    });

    // Status is UNORDERED, so these are explicit transition tests, not `status >= DONE`. They
    // are also mutually exclusive by construction: one PATCH carries one status - and they hold
    // only for the request that actually MOVED the task (the compare-and-set above).
    const justCompleted = statusMoved && status === 'DONE';
    const justCancelled = statusMoved && status === 'CANCELLED';

    // ─── Notifications (design §5) — POST-COMMIT ───────────────────────────────────────────
    const ref: TaskRef = { id: task.id, title: task.title, task_number: task.task_number };
    // notify.in_app:false suppresses the ADDED notices only, exactly as the job assign door
    // does: removal, completion and cancellation notices stay unconditional, because those
    // are the ones nobody would think to ask for and everybody needs.
    if (notify?.in_app !== false) {
      await emitTask(req, 'task.assigned', ref, { added_assignee_ids: assigneeDelta.added });
      await emitTask(req, 'task.watching', ref, { added_watcher_ids: watcherDelta.added });
    }
    // One notice per person taken off the task, whichever of the two lists they were on.
    await emitTask(req, 'task.removed', ref, {
      removed_ids: [...new Set([...assigneeDelta.removed, ...watcherDelta.removed])],
    });
    if (justCompleted || justCancelled) {
      // The roster AFTER the write, so someone added in this very PATCH still hears about it.
      // The actor is dropped downstream, hence "the OTHER assignees".
      //
      // Issue 03: a cancellation gets its OWN verb. `task.completed` is gated on the flip into
      // DONE above and so cannot fire here; reusing it would tell the other assignees the work
      // finished. Being dropped from work you were assigned is the surprise task.removed exists
      // to prevent, so silence is not an option either.
      await emitTask(req, justCompleted ? 'task.completed' : 'task.cancelled', ref, {
        assignee_ids: toIdSet(task.assignee_ids),
        watcher_ids:  toIdSet(task.watcher_ids),
      });
    }

    // ─── Automation Center event - post-commit, fire-and-forget (#271) ─────────────────────
    // This is the ONLY door TASK_ASSIGNED fires from: someone added to a task that already
    // existed. A task created WITH assignees fires TASK_CREATED instead, and never this - see
    // the mutual-exclusion note in create() above, which also records why the bell (which does
    // fire `task.assigned` at create time) and lead.controller.ts (which fires created AND
    // assigned for a new owned lead) deliberately disagree with this.
    //
    // ONLY the assignee delta dispatches. `watcherDelta.added` is deliberately absent:
    // watching is self-service following, not work being handed to someone, so adding a
    // watcher fires no automation at all while `task.watching` still rings the bell. That
    // asymmetry with the bell is intentional; the two deltas are computed separately one
    // screen above precisely so it can be expressed.
    //
    // ONE event per newly added person, discriminated by their user id. The trigger is in
    // dedupe.ts's OCCURRENCE_SCOPED set, so an event arriving here WITHOUT `occurrenceKey`
    // makes buildDedupeKey throw, createEnrollment swallow the throw and return null, and the
    // trigger silently never enrols for the life of the task.
    //
    // The added person's own row rides `eventPayload.recipient`, which is what the
    // `assigned_user` audience resolves from. Addressing this trigger to the live roster
    // (`assignees`) instead would re-email everyone already on the task on every addition.
    if (notify?.email !== false && assigneeDelta.added.length > 0) {
      const addedUsers = await prisma.user.findMany({
        where: { id: { in: assigneeDelta.added }, ...tenantWhere(req), is_active: true },
        select: { id: true, email: true, first_name: true, last_name: true, phone: true },
      });
      for (const uid of assigneeDelta.added) {
        const addedUser = addedUsers.find((u) => u.id === uid);
        dispatchAutomationEvent({
          type: 'TASK_ASSIGNED',
          organizationId: orgId,
          // The TITLE, not the task number - the same choice, and the same reason, the bell
          // verbs make.
          entity: { type: 'task', id: task.id, label: task.title },
          occurrenceKey: uid,
          actorId,
          // Absent only if the row vanished between the write and this read; the event still
          // dispatches, so a workflow addressed to the live roster is unaffected. Mirrors the
          // job assign door's TECH_ASSIGNED dispatch.
          ...(addedUser ? { eventPayload: { recipient: addedUser } } : {}),
        });
      }
    }

    // The status-transition triggers ("Task is done"): the status moved INTO a state from any
    // other, including again after a reopen - each move is its own occurrence (taskTransitions.ts).
    // Not gated on notify.email, which mutes the ADDED notices only; a finish is the notice nobody
    // thinks to ask for, which is also why the bell's task.completed verb above is unconditional.
    const transition = statusMoved ? taskTransitionInto(existing.status, status) : null;
    if (transition) {
      dispatchAutomationEvent(taskTransitionEvent({
        transition,
        organizationId: orgId,
        task: { id: task.id, title: task.title },
        actorId,
        actorName: userFullName(req.user!),
        at: changedAt,
        timeZone,
      }));
    }

    res.json({ task: { ...task, assignees: withNames(toIdSet(task.assignee_ids), names) } });
  } catch (err) {
    if (err instanceof TaskStatusConflictError) {
      res.status(409).json({ error: STATUS_CONFLICT, code: 'STATE_CONFLICT' });
      return;
    }
    if (isMissingTaskCategoryError(err)) {
      res.status(400).json({ error: UNKNOWN_TASK_CATEGORY });
      return;
    }
    logger.error('Update task error:', err);
    res.status(500).json({ error: 'Failed to update task' });
  }
}

/** GET /api/tasks/:id — task detail: base fields + subtasks, comments, activity, watchers */
export async function getOne(req: Request, res: Response) {
  try {
    const id = param(req, 'id');
    const orgId = req.user!.organization_id;

    const task = await prisma.task.findFirst({
      where: { id, ...tenantWhere(req) },
      include: { _count: { select: { subtasks: true } }, ...TASK_CATEGORY_INCLUDE },
    });
    if (!task) {
      res.status(404).json({ error: 'Task not found' });
      return;
    }
    if (!(await canAccessTask(req, task))) {
      res.status(403).json({ error: 'Insufficient permissions' });
      return;
    }

    // Load includes in parallel
    const [subtasks, notes, events] = await Promise.all([
      prisma.taskSubtask.findMany({ where: { task_id: id }, orderBy: { position: 'asc' } }),
      prisma.note.findMany({ where: { entity_type: 'TASK', entity_id: id, organization_id: req.user!.organization_id }, orderBy: { created_at: 'asc' } }),
      prisma.timelineEvent.findMany({ where: { entity_type: 'TASK', entity_id: id, organization_id: req.user!.organization_id }, orderBy: { created_at: 'desc' } }),
    ]);

    // Collect all user IDs that need names
    const watcherIds:  string[] = toIdSet(task.watcher_ids);
    const assigneeIds: string[] = toIdSet(task.assignee_ids);
    const allUserIds = [
      ...assigneeIds,
      task.created_by,
      ...watcherIds,
      ...notes.map((n: { created_by: string }) => n.created_by),
      ...events.map((e) => e.created_by).filter((x): x is string => !!x),
    ].filter(Boolean) as string[];

    // #01 - same scoped resolver as the list. Reaching here does NOT imply entity access: an
    // assignee or watcher passes canAccessTask on that arm alone, so the link can still redact.
    const [names, labels, fileCounts] = await Promise.all([
      resolveUserNames(orgId, allUserIds),
      resolveEntityLabels(
        req.user!,
        task.linked_entity_type && task.linked_entity_id
          ? [{ type: task.linked_entity_type, id: task.linked_entity_id }]
          : [],
        { ability: req.ability },
      ),
      taskAttachmentCounts(orgId, [task.id]),
    ]);

    const now = new Date();

    res.json({
      task: {
        ...task,
        attachment_count: fileCounts.get(task.id) ?? 0,
        assignees: withNames(assigneeIds, names),
        created_by_name: names.get(task.created_by) ?? null,
        ...entityLabelFields(task, labels),
        risk: computeTaskRisk(task, now),
        subtasks,
        comments: notes.map((n: { id: string; content: string; created_by: string; created_at: Date }) => ({
          id: n.id,
          body: n.content,
          author_id: n.created_by,
          author_name: names.get(n.created_by) ?? null,
          at: n.created_at,
        })),
        activity: events.map((e) => ({
          id: e.id,
          type: e.event_type,
          description: e.description,
          actor_id: e.created_by,
          actor_name: e.created_by ? names.get(e.created_by) ?? null : null,
          at: e.created_at,
          metadata: e.metadata,
        })),
        watchers: withNames(watcherIds, names),
      },
    });
  } catch (err) {
    logger.error('Get task error:', err);
    res.status(500).json({ error: 'Failed to get task' });
  }
}

/** POST /api/tasks/:id/comments — add a comment (reuses polymorphic Note, entity_type=TASK) */
export async function addComment(req: Request, res: Response) {
  try {
    const id = param(req, 'id');
    const { body } = req.body as { body: string };
    const orgId   = req.user!.organization_id;
    const actorId = req.user!.id;

    const existing = await prisma.task.findFirst({
      where: { id, ...tenantWhere(req) },
    });
    if (!existing) {
      res.status(404).json({ error: 'Task not found' });
      return;
    }
    if (!(await canAccessTask(req, existing))) {
      res.status(403).json({ error: 'Insufficient permissions' });
      return;
    }

    const note = await prisma.$transaction(async (tx) => {
      const created = await tx.note.create({
        data: {
          entity_type:     'TASK',
          entity_id:       id,
          content:         body,
          created_by:      actorId,
          organization_id: orgId,
        },
      });

      await recordTaskActivity(tx, {
        taskId:      id,
        orgId,
        actorId,
        type:        'COMMENTED',
        description: 'commented',
      });

      return created;
    });

    // ─── Notifications (Spec B slice 3) - POST-COMMIT ──────────────────────────────────────
    // The bell and the automation event fire from HERE, one after the other, off the same
    // commit. The spec asks for them "inside the same transaction boundary as the note
    // write"; that is read as intent, not instruction, because this codebase's documented
    // contract - the emitTask docblock above, citing #271 - is the opposite: both run AFTER
    // the commit, so a rolled-back note leaves no notification and no enrollment behind. The
    // intent, that the trigger cannot disagree with the record, is satisfied by both firing
    // from the same handler on the same commit.
    //
    // The whole roster is handed over, actor included: dedupe() drops the commenter one layer
    // down, exactly as it does for task.completed. A commenter who is not on the task at all
    // is simply never in the list.
    const ref: TaskRef = {
      id: existing.id,
      title: existing.title,
      task_number: existing.task_number,
    };
    await emitTask(req, 'task.commented', ref, {
      assignee_ids: toIdSet(existing.assignee_ids),
      watcher_ids:  toIdSet(existing.watcher_ids),
    });

    // ─── Automation Center event - post-commit, fire-and-forget (#271) ─────────────────────
    // The occurrence is the NOTE id, and it is the whole reason this dispatch is more than
    // three lines. TASK_COMMENT_ADDED is in dedupe.ts's OCCURRENCE_SCOPED set, so an event
    // arriving here WITHOUT `occurrenceKey` makes buildDedupeKey throw, createEnrollment
    // swallow the throw and return null - and only the FIRST comment on any task would ever
    // notify, silently, for the life of that task. Keyed on the note, each comment is its own
    // occurrence.
    //
    // No `eventPayload`: unlike TASK_ASSIGNED this event is about the TASK, not about one
    // person, so there is no recipient to carry and `assigned_user` is not offered on it.
    // The audiences resolve from the LIVE task, which is what a comment should reach - the
    // people on it when the mail actually goes out.
    //
    // `actorId` is the commenter, and it rides the enrollment's event_payload rather than
    // being evaluated at dispatch time. That is what keeps them excluded when the workflow's
    // first step is a WAIT and the send happens a day later.
    dispatchAutomationEvent({
      type: 'TASK_COMMENT_ADDED',
      organizationId: orgId,
      // The TITLE, not the task number - the same choice, and the same reason, the bell
      // verbs make.
      entity: { type: 'task', id: existing.id, label: existing.title },
      occurrenceKey: note.id,
      actorId,
    });

    res.status(201).json({
      comment: {
        id:        note.id,
        body:      note.content,
        author_id: note.created_by,
        at:        note.created_at,
      },
    });
  } catch (err) {
    logger.error('Add comment error:', err);
    res.status(500).json({ error: 'Failed to add comment' });
  }
}

/** POST /api/tasks/:id/nudge — record a NUDGED activity event; no external notification */
export async function nudge(req: Request, res: Response) {
  try {
    const id     = param(req, 'id');
    const orgId   = req.user!.organization_id;
    const actorId = req.user!.id;

    const task = await prisma.task.findFirst({
      where: { id, ...tenantWhere(req) },
    });
    if (!task) {
      res.status(404).json({ error: 'Task not found' });
      return;
    }
    if (!(await canAccessTask(req, task))) {
      res.status(403).json({ error: 'Insufficient permissions' });
      return;
    }

    await prisma.$transaction((tx) =>
      recordTaskActivity(tx, {
        taskId: id,
        orgId,
        actorId,
        type: 'NUDGED',
        description: 'nudged the task',
      }),
    );

    res.json({ task });
  } catch (err) {
    logger.error('Nudge task error:', err);
    res.status(500).json({ error: 'Failed to nudge task' });
  }
}

/**
 * DELETE /api/tasks/:id — delete a task.
 *
 * The `delete Task` grant is enforced HERE, not on the route, because of design §3's escape
 * hatch: a technician holds no delete grant at all, yet must be able to get rid of a to-do they
 * made for themselves. A route-level `canDo('delete','Task')` fires before the row is loaded, so
 * the exception would be unreachable. Both paths are checked below, row in hand:
 *   • creator AND sole assignee → allowed regardless of grant, or
 *   • the `delete Task` grant.
 * The narrow exception is deliberate — a blanket technician delete grant would also let them
 * destroy an office task they merely reached through a linked job.
 */
export async function remove(req: Request, res: Response) {
  try {
    const id = param(req, 'id');
    const actorId = req.user!.id;

    const existing = await prisma.task.findFirst({
      where: { id, ...tenantWhere(req) },
    });
    if (!existing) {
      res.status(404).json({ error: 'Task not found' });
      return;
    }
    if (!(await canAccessTask(req, existing))) {
      res.status(403).json({ error: 'Insufficient permissions' });
      return;
    }

    const assignees = toIdSet(existing.assignee_ids);
    const ownTodo = existing.created_by === actorId && assignees.length === 1 && assignees[0] === actorId;
    if (!ownTodo && !(req.ability?.can('delete', 'Task') ?? false)) {
      res.status(403).json({ error: 'Insufficient permissions' });
      return;
    }

    // The task-deletion service (lib/tasks/deletion) - the same one a category delete runs. It
    // works from the row already in hand: after the transaction there is nothing left to read.
    const actor = { orgId: req.user!.organization_id, actorId };
    const { deleted, attachmentPaths } = await prisma.$transaction((tx) => deleteTasks(tx, [existing], actor));
    // Another request deleted it between the read above and the lock: that one owns the audit
    // event and the announcements, and this one found nothing to delete.
    if (!deleted.length) {
      res.status(404).json({ error: 'Task not found' });
      return;
    }
    await announceTaskDeletions(actor, deleted, attachmentPaths);

    res.status(204).send();
  } catch (err) {
    logger.error('Delete task error:', err);
    res.status(500).json({ error: 'Failed to delete task' });
  }
}

/**
 * GET /api/tasks/entity-access?entity_type=&entity_id= - which assignable users CANNOT open the
 * entity a task is linked to (#05).
 *
 * ADVISORY ONLY. Assignment is unchanged: being assigned a task grants the TASK and nothing else,
 * and a candidate listed here is still perfectly assignable. This exists so the picker can say so
 * up front, instead of the assignee discovering a "Restricted job" placeholder later.
 *
 * The roster is `GET /api/users/assignable?purpose=task&eligible_for=task` (active users in the
 * tenant), resolved server-side so the picker needs ONE request for the whole list and none per
 * keystroke. Not narrowed to the caller in practice: `purpose=task` is held open for anyone
 * holding `read User` (user.controller's `taskHeldOpen`, issue #1950), so the parenthetical this
 * comment used to carry — "narrowed to the caller alone unless they hold `assign Task`" — was
 * describing a rule the endpoint does not apply.
 *
 * The entity's own label goes through `resolveEntityLabels` for the CALLER, so an assigner who
 * cannot see the entity gets #01's placeholder here too and the warning never becomes the leak it
 * is warning about.
 */
export async function entityAccess(req: Request, res: Response) {
  try {
    const { entity_type, entity_id } = req.query as Record<string, string | undefined>;
    if (!entity_type || !entity_id) {
      res.status(400).json({ error: 'entity_type and entity_id are required' });
      return;
    }
    if (!ENTITY_DELEGATES[entity_type]) {
      res.status(400).json({ error: 'Unknown entity_type' });
      return;
    }

    // Existence first: a link to a row that is gone would otherwise read as "nobody can see it"
    // and flag the entire roster.
    const exists = await ENTITY_DELEGATES[entity_type].findFirst({
      where: { id: entity_id, ...tenantWhere(req) },
      select: { id: true },
    });
    if (!exists) {
      res.status(404).json({ error: 'Linked entity not found' });
      return;
    }

    const candidates = await prisma.user.findMany({
      where: { ...tenantWhere(req), is_active: true },
      select: {
        id: true,
        role: true,
        organization_id: true,
        custom_role_id: true,
        // grantRoleKey throws when custom_role_id is set without the relation loaded - deliberately,
        // because the fallback would be the BASE role's wider grant set.
        custom_role: { select: { key: true } },
        department_id: true,
        location_id: true,
      },
    });

    const ref = { type: entity_type, id: entity_id };
    const [{ withAccess }, labels] = await Promise.all([
      readersWithEntityAccess(candidates, ref),
      resolveEntityLabels(req.user!, [ref], { ability: req.ability }),
    ]);
    const label = labels.get(entityRefKey(entity_type, entity_id));

    res.json({
      entity: {
        type: entity_type,
        id: entity_id,
        label: label?.label ?? null,
        redacted: label?.redacted ?? false,
      },
      checked_user_ids: candidates.map((c) => c.id),
      without_access: candidates.filter((c) => !withAccess.has(c.id)).map((c) => c.id),
    });
  } catch (err) {
    logger.error('Task entity-access error:', err);
    res.status(500).json({ error: 'Failed to resolve entity access' });
  }
}

/** GET /api/tasks/summary — { open, overdue, at_risk, next_due_at } for a linked entity */
export async function summary(req: Request, res: Response) {
  try {
    const { linked_entity_type, linked_entity_id } = req.query as Record<string, string | undefined>;
    if (!linked_entity_type || !linked_entity_id) {
      res.status(400).json({ error: 'linked_entity_type and linked_entity_id are required' });
      return;
    }
    // #245 — a summary of an entity's tasks requires access to that entity (SQL row check).
    if (req.user!.role !== 'ADMIN') {
      if (!(await canAccessLinkedEntity(req, linked_entity_type, linked_entity_id))) {
        res.status(403).json({ error: 'Insufficient permissions' });
        return;
      }
    }
    const where = taskVisibilityWhere(req, { linked_entity_type, linked_entity_id });
    const tasks = await prisma.task.findMany({
      where, select: { status: true, priority: true, due_at: true, completed_at: true },
    });
    const now = new Date();
    let open = 0, overdue = 0, at_risk = 0;
    let next: Date | null = null;
    for (const t of tasks) {
      // Terminal (DONE or CANCELLED) is finished either way; everything else, BLOCKED included,
      // counts as open: it is still an unresolved obligation. Reopening a cancelled task to
      // TODO puts it straight back in this count, with no transition rule to unwind.
      if (isTerminalTaskStatus(t.status)) continue;
      open++;
      if (t.due_at && t.due_at < now) overdue++;
      if (computeTaskRisk(t, now).score >= 50) at_risk++;
      if (t.due_at && t.due_at > now && (!next || t.due_at < next)) next = t.due_at;
    }
    res.json({ open, overdue, at_risk, next_due_at: next ? next.toISOString() : null });
  } catch (err) {
    logger.error('Task summary error:', err);
    res.status(500).json({ error: 'Failed to compute task summary' });
  }
}

/** POST /api/tasks/:id/subtasks — add a subtask checklist item */
export async function addSubtask(req: Request, res: Response) {
  try {
    const id = param(req, 'id');
    const { text } = req.body as { text: string };

    const task = await prisma.task.findFirst({
      where: { id, ...tenantWhere(req) },
    });
    if (!task) {
      res.status(404).json({ error: 'Task not found' });
      return;
    }
    if (!(await canAccessTask(req, task))) {
      res.status(403).json({ error: 'Insufficient permissions' });
      return;
    }

    const subtask = await prisma.taskSubtask.create({
      data: { task_id: id, text },
    });

    res.status(201).json({ subtask });
  } catch (err) {
    logger.error('Add subtask error:', err);
    res.status(500).json({ error: 'Failed to add subtask' });
  }
}

/** PATCH /api/tasks/:id/subtasks/:subtaskId — update a subtask (text and/or done) */
export async function updateSubtask(req: Request, res: Response) {
  try {
    const id = param(req, 'id');
    const subtaskId = param(req, 'subtaskId');

    const task = await prisma.task.findFirst({
      where: { id, ...tenantWhere(req) },
    });
    if (!task) {
      res.status(404).json({ error: 'Task not found' });
      return;
    }
    if (!(await canAccessTask(req, task))) {
      res.status(403).json({ error: 'Insufficient permissions' });
      return;
    }

    const existing = await prisma.taskSubtask.findFirst({
      where: { id: subtaskId, task_id: id },
    });
    if (!existing) {
      res.status(404).json({ error: 'Subtask not found' });
      return;
    }

    const { text, done } = req.body as { text?: string; done?: boolean };
    const data: Record<string, unknown> = {};
    if (text !== undefined) data.text = text;
    if (done !== undefined) data.done = done;

    const subtask = await prisma.taskSubtask.update({
      where: { id: subtaskId },
      data,
    });

    res.json({ subtask });
  } catch (err) {
    logger.error('Update subtask error:', err);
    res.status(500).json({ error: 'Failed to update subtask' });
  }
}

/** DELETE /api/tasks/:id/subtasks/:subtaskId — remove a subtask */
export async function deleteSubtask(req: Request, res: Response) {
  try {
    const id = param(req, 'id');
    const subtaskId = param(req, 'subtaskId');

    const task = await prisma.task.findFirst({
      where: { id, ...tenantWhere(req) },
    });
    if (!task) {
      res.status(404).json({ error: 'Task not found' });
      return;
    }
    if (!(await canAccessTask(req, task))) {
      res.status(403).json({ error: 'Insufficient permissions' });
      return;
    }

    const existing = await prisma.taskSubtask.findFirst({
      where: { id: subtaskId, task_id: id },
    });
    if (!existing) {
      res.status(404).json({ error: 'Subtask not found' });
      return;
    }

    await prisma.taskSubtask.delete({ where: { id: subtaskId } });

    res.status(204).send();
  } catch (err) {
    logger.error('Delete subtask error:', err);
    res.status(500).json({ error: 'Failed to delete subtask' });
  }
}
