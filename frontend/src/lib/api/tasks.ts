import api from '@/lib/axios';
import type { Task, TaskCategoryRef, TaskPersonRef, TaskStatus, TaskPriority, LinkedEntity, LinkedEntityType } from '@/lib/tasks/types';

export interface TaskRow {
  id: string;
  task_number: string;
  title: string;
  description: string;
  status: TaskStatus;
  priority: TaskPriority;
  assignee_ids: string[];
  assignees: TaskPersonRef[];
  /**
   * Watchers as bare ids, with no names resolved - `watchers` (names and all) is the detail
   * row's field, not this one.
   *
   * Optional here rather than required because it is the RESPONSE type for four endpoints and
   * only a promise about three of them. `watcher_ids` is a `String[] @default([])` column and
   * the list, create and update handlers all answer by spreading the Prisma row, so those three
   * always send it. Declaring it required would let a future handler that projects columns
   * explicitly type-check while silently sending nothing.
   */
  watcher_ids?: string[];
  due_at: string | null;
  linked_entity_type: LinkedEntityType | null;
  linked_entity_id: string | null;
  linked_entity_label?: string | null;
  /**
   * The label above is a placeholder because the caller may not open the entity. Both read paths
   * (`GET /api/tasks` and `GET /api/tasks/:id`) always send it; the create and update responses
   * never resolved a label at all, so it is optional here and absent reads as false.
   */
  linked_entity_redacted?: boolean;
  tags: string[];
  /** Every task read and write answers with it; null when the task has none. */
  category?: TaskCategoryRef | null;
  created_by: string;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
  risk?: { score: number; reason: string | null };
  _count?: { subtasks: number };
  /** Both read paths send it; the create and update responses do not (see `mapRowToTask`). */
  attachment_count?: number;
}

export interface CreateTaskInput {
  title: string;
  description?: string;
  status?: TaskStatus;
  priority?: TaskPriority;
  /**
   * Omitting this is meaningful, not lazy: the server then defaults to
   * `[actorId]`. A caller WITHOUT the `assign` grant that sends anything other
   * than exactly `[actorId]` gets a 403, so the create dialogs send the field
   * only when the user could actually have chosen it.
   */
  assignee_ids?: string[];
  due_at?: string | null;
  linked_entity?: { type: LinkedEntityType; id: string } | null;
  watcher_ids?: string[];
  /** Omitted or null: the task has no category. */
  category_id?: string | null;
}

/** The fields a PATCH may carry. `category_id: null` clears the category. */
export type TaskPatch = Partial<
  Pick<Task, 'title' | 'description' | 'status' | 'priority' | 'assignee_ids' | 'due_at' | 'watcher_ids'>
> & { category_id?: string | null };

/**
 * The link a row describes, keeping what the row does not carry.
 *
 * Only the two READ paths resolve a label. `POST /api/tasks` and `PATCH /api/tasks/:id` answer with
 * the raw row (`{ ...task }` in task.controller.ts), which has the `linked_entity_type`/`_id`
 * COLUMNS and no label at all - so a store that replaced its task with the mapped response blanked
 * the chip on every edit: a redacted chip lost its padlock and its placeholder, a normal one lost
 * its label, until a reload. Resolving labels on the write path would buy that back with an entity
 * query per edit, for text the client is already holding.
 *
 * The two cases are told apart on the wire, not guessed:
 *   `undefined` - the key is absent, so the response never resolved a label -> keep what we have
 *   `null`      - a read path resolved it and found nothing -> a DANGLING link, follow it
 * `entityLabelFields` always emits both keys, so a read is never mistaken for a write.
 *
 * "Omitted" is not "cleared": a cleared link answers with `linked_entity_type: null` and a
 * RE-POINTED one answers with a different type/id, and both are followed. Only the same entity
 * inherits, and it inherits `label` and `redacted` as a PAIR - mixing a fresh label with a stale
 * flag is how a chip would un-redact itself.
 */
function linkedEntityFrom(r: TaskRow, prev?: Task | null): LinkedEntity | null {
  if (!r.linked_entity_type || !r.linked_entity_id) return null;

  const carriesLabel = r.linked_entity_label !== undefined || r.linked_entity_redacted !== undefined;
  const same =
    prev?.linked_entity?.type === r.linked_entity_type &&
    prev?.linked_entity?.id === r.linked_entity_id;
  const inherited = !carriesLabel && same ? prev!.linked_entity! : null;

  return {
    type: r.linked_entity_type,
    id: r.linked_entity_id,
    // `?? ''` is the DANGLING case and stays: a link whose entity is deleted or out of the org
    // comes back with a null label and `redacted` false, and has always rendered as a bare type
    // chip. A redacted link is the other thing entirely - it carries the server's placeholder
    // text - so the two must not be collapsed into one fallback.
    label: inherited ? inherited.label : (r.linked_entity_label ?? ''),
    redacted: inherited ? (inherited.redacted ?? false) : (r.linked_entity_redacted ?? false),
  };
}

/**
 * Row → full Task (list rows: fill rich client-only fields with empty defaults).
 *
 * `prev` is the task this row is REPLACING, when there is one. It is read for nothing but the
 * linked-entity fields a write response does not carry; see `linkedEntityFrom`.
 */
export function mapRowToTask(r: TaskRow, prev?: Task | null): Task {
  const ids = r.assignee_ids ?? [];
  const resolved = new Map((r.assignees ?? []).map((a) => [a.id, a]));
  return {
    id: r.id,
    task_number: r.task_number,
    title: r.title,
    description: r.description ?? '',
    status: r.status,
    priority: r.priority,
    assignee_ids: ids,
    // `assignee_ids` is the authority on WHO; `assignees` only resolves names.
    // Rebuilding the resolved list FROM the ids tolerates both halves of a
    // partial payload - an id with no entry renders "Unknown user" rather than
    // vanishing, and a stale entry for a removed id does not reappear.
    assignees: ids.map((id) => resolved.get(id) ?? { id, name: null }),
    /**
     * The real watchers, not `[]`.
     *
     * This used to be hardcoded empty on the premise that only the detail row knew about
     * watchers. It does not: `GET /api/tasks` spreads the Prisma row and the column comes with
     * it. Hardcoding it meant the Board's own predicate -
     * `assignee_ids.includes(me) || watcher_ids.includes(me)` - always tested an empty array,
     * so a task you ONLY watch was missing from your Board until you opened its drawer, which
     * fetched the detail row and made the card appear.
     *
     * Absent is not empty. A response that does not carry the key tells us nothing about the
     * watchers, so we keep the ones already in hand rather than clearing them - the same
     * "omitted is not cleared" rule `linkedEntityFrom` above follows.
     */
    watcher_ids: r.watcher_ids ?? prev?.watcher_ids ?? [],
    due_at: r.due_at,
    linked_entity: linkedEntityFrom(r, prev),
    tags: r.tags ?? [],
    // Absent is not "none": keep what we hold, the same rule `watcher_ids` follows above.
    category: r.category !== undefined ? r.category : (prev?.category ?? null),
    subtasks: [],
    created_by: r.created_by,
    created_at: r.created_at,
    updated_at: r.updated_at,
    completed_at: r.completed_at,
    // Absent is not "none": a write response carries no count, so keep the one in hand.
    attachment_count: r.attachment_count ?? prev?.attachment_count ?? 0,
    activity: [],
    comments: [],
    ai: {
      risk_score: r.risk?.score ?? 0,
      risk_reason: r.risk?.reason ?? null,
      suggested_by: null,
      source: 'manual',
    },
  };
}

// Detail row type: TaskRow + rich arrays returned by GET /api/tasks/:id
interface TaskDetailRow extends TaskRow {
  subtasks: Array<{ id: string; text: string; done: boolean; position?: number }>;
  comments: Array<{ id: string; body: string; author_id: string; author_name?: string | null; at: string }>;
  activity: Array<{ id: string; type: string; actor_id: string; actor_name?: string | null; at: string; description?: string; metadata?: Record<string, string> | null }>;
  watchers: Array<{ id: string; name: string | null }>;
  created_by_name?: string | null;
}

// Detail row → full Task (includes subtasks, comments, activity, watchers).
export function mapDetailToTask(d: TaskDetailRow): Task {
  const base = mapRowToTask(d);
  return {
    ...base,
    created_by_name: d.created_by_name ?? null,
    subtasks: d.subtasks.map(({ id, text, done }) => ({ id, text, done })),
    comments: d.comments.map((c) => ({
      id: c.id,
      author_id: c.author_id,
      body: c.body,
      at: c.at,
      author_name: c.author_name ?? null,
    })),
    activity: d.activity.map((e) => ({
      id: e.id,
      type: (e.type as string).toLowerCase() as Task['activity'][number]['type'],
      actor_id: e.actor_id,
      at: e.at,
      description: e.description,
      actor_name: e.actor_name ?? null,
      meta: (e.metadata as Record<string, string> | null | undefined) ?? undefined,
    })),
    watchers: d.watchers,
    watcher_ids: d.watchers.map((w) => w.id),
  };
}

export function getTask(id: string): Promise<Task> {
  return api.get('/api/tasks/' + id).then((r) => mapDetailToTask(r.data.task as TaskDetailRow));
}

export function listTasks(params?: {
  linked_entity_type?: LinkedEntityType;
  linked_entity_id?: string;
}): Promise<Task[]> {
  return api
    .get('/api/tasks', { params })
    // Not point-free: `map` would hand the index in as `prev`. A list read carries its own
    // labels anyway, so there is nothing to inherit here.
    .then((res) => (res.data.tasks as TaskRow[]).map((r) => mapRowToTask(r)));
}

export function createTask(input: CreateTaskInput): Promise<Task> {
  const body: Record<string, unknown> = {
    title: input.title,
    description: input.description,
    status: input.status,
    priority: input.priority,
    due_at: input.due_at,
    linked_entity_type: input.linked_entity?.type,
    linked_entity_id: input.linked_entity?.id,
  };
  if (input.category_id) body.category_id = input.category_id;
  // Sent only when non-empty. An empty array is a 400 ("a task must have at
  // least one assignee") where OMITTING the key is the documented way to say
  // "default me" - so a blank field must not become an empty array on the wire.
  if (input.assignee_ids && input.assignee_ids.length > 0) {
    body.assignee_ids = input.assignee_ids;
  }
  if (input.watcher_ids && input.watcher_ids.length > 0) {
    body.watcher_ids = input.watcher_ids;
  }
  return api.post('/api/tasks', body).then((res) => mapRowToTask(res.data.task as TaskRow));
}

/**
 * `prev` is the store's copy of the task being patched. The PATCH response carries no
 * linked-entity label, so without it every edit blanks the chip; see `linkedEntityFrom`.
 */
export function updateTaskApi(
  id: string,
  patch: TaskPatch,
  prev?: Task | null,
): Promise<Task> {
  return api
    .patch(`/api/tasks/${id}`, patch)
    .then((res) => mapRowToTask(res.data.task as TaskRow, prev));
}

export function addCommentApi(id: string, body: string): Promise<void> {
  return api.post(`/api/tasks/${id}/comments`, { body }).then(() => undefined);
}

export function addSubtaskApi(id: string, text: string): Promise<void> {
  return api.post(`/api/tasks/${id}/subtasks`, { text }).then(() => undefined);
}

export function updateSubtaskApi(
  id: string,
  sid: string,
  patch: { text?: string; done?: boolean },
): Promise<void> {
  return api.patch(`/api/tasks/${id}/subtasks/${sid}`, patch).then(() => undefined);
}

export function deleteSubtaskApi(id: string, sid: string): Promise<void> {
  return api.delete(`/api/tasks/${id}/subtasks/${sid}`).then(() => undefined);
}

export function nudgeApi(id: string): Promise<void> {
  return api.post(`/api/tasks/${id}/nudge`).then(() => undefined);
}

export function deleteTaskApi(id: string): Promise<void> {
  return api.delete(`/api/tasks/${id}`).then(() => undefined);
}

