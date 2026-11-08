import { create } from 'zustand';
import type { Task, TaskCategoryRef, TaskStatus } from '@/lib/tasks/types';
import {
  listTasks,
  createTask,
  updateTaskApi,
  deleteTaskApi,
  getTask,
  addCommentApi,
  addSubtaskApi,
  updateSubtaskApi,
  deleteSubtaskApi,
  nudgeApi,
  type CreateTaskInput,
} from '@/lib/api/tasks';
import { toast } from '@/components/ui/use-toast';
import { extractApiError } from '@/lib/utils';
import { registerStoreReset } from '@/lib/storeReset';

interface TasksState {
  tasks: Task[];
  loaded: boolean;
  loading: boolean;
  fetchTasks: () => Promise<void>;
  fetchTaskDetail: (id: string) => Promise<void>;
  addTask: (input: CreateTaskInput) => Promise<Task>;
  updateStatus: (id: string, status: TaskStatus) => Promise<void>;
  updateTask: (id: string, patch: Partial<Task>) => Promise<void>;
  reschedule: (id: string, due_at: string) => Promise<void>;
  deleteTask: (id: string) => Promise<void>;
  addComment: (id: string, body: string) => Promise<void>;
  addSubtask: (id: string, text: string) => Promise<void>;
  toggleSubtask: (id: string, sid: string, done: boolean) => Promise<void>;
  deleteSubtask: (id: string, sid: string) => Promise<void>;
  setAssignees: (id: string, ids: string[]) => Promise<void>;
  setWatchers: (id: string, ids: string[]) => Promise<void>;
  nudge: (id: string) => Promise<void>;
  /** The drawer's Files section reports the loaded count here, so the board card follows it. */
  setAttachmentCount: (id: string, count: number) => void;
  /**
   * An admin renamed or recolored a category (slice 09): every task carrying it takes the new
   * name and color, locally, with no refetch. Each task holds its own copy of `{ id, name, color }`
   * for the chip, and `fetchTasks` never re-runs once loaded, so without this the board, list,
   * My Day and both drawers would keep the old chip until a reload.
   */
  applyCategory: (category: TaskCategoryRef) => void;
  /**
   * An admin deleted a category (slice 11): its tasks lose the chip, take the category they were
   * moved to, or - the ids in `deletedTaskIds` - leave the store, exactly as a manual delete does.
   */
  applyCategoryDeleted: (a: { categoryId: string; movedTo: TaskCategoryRef | null; deletedTaskIds: string[] }) => void;
}

/**
 * Keys a PATCH response cannot carry, and which therefore have to be re-applied
 * from the row already in the store.
 *
 * `updateTaskApi` answers with a LIST row, and the list mapper hardcodes
 * `subtasks: []`, `activity: []`, `comments: []` and never sets
 * `created_by_name` or `watchers` at all - only `GET /api/tasks/:id` resolves
 * those. Spreading the server row over the detail row therefore blanks every
 * one of them, which is how the drawer came to print the creator's raw uuid the
 * moment anybody changed a status or a priority: `created_by_name` went missing
 * and the render falls back to `task.created_by`.
 *
 * `watcher_ids` is the exception, and it is left here on purpose. The list
 * mapper reads the real column now, so a write response carries the current
 * ids and re-applying the store's copy over them is a NO-OP rather than a
 * rescue - #1771's reason for the entry has gone.
 *
 * Keeping it costs nothing and keeps it beside `watchers`, the resolved-name
 * half of the same fact, which only `GET /api/tasks/:id` can produce and which
 * therefore cannot leave this list. Nothing renders `watchers` today, so
 * splitting the pair would break nothing today either - it would just leave the
 * two halves of one fact updated by different rules, waiting for the first
 * component to read both. Whoever gives `watchers` a reader gets a consistent
 * pair rather than a bug to find.
 *
 * None of the three merge sites edits watchers. `setWatchers` - the one that
 * does - refetches the detail row outright, as do `setAssignees`, `nudge` and
 * the comment/subtask mutators, so none of them is affected by this list.
 */
const DETAIL_ONLY_KEYS = [
  'subtasks', 'activity', 'comments', 'ai', 'watcher_ids', 'watchers', 'created_by_name',
] as const satisfies readonly (keyof Task)[];

/** The server's answer when another person's status change landed first (task.controller.ts). */
function isStateConflict(err: unknown): boolean {
  const response = (err as { response?: { status?: number; data?: { code?: string } } })?.response;
  return response?.status === 409 && response.data?.code === 'STATE_CONFLICT';
}

export const useTasksStore = create<TasksState>()((set, get) => ({
  tasks: [],
  loaded: false,
  loading: false,

  fetchTasks: async () => {
    // Dedup concurrent mounts: skip if already in-flight or hydrated
    if (get().loading || get().loaded) return;
    set({ loading: true });
    try {
      const tasks = await listTasks();
      set({ tasks, loaded: true });
    } finally {
      set({ loading: false });
    }
  },

  fetchTaskDetail: async (id: string) => {
    const full = await getTask(id);
    set((s) => {
      const exists = s.tasks.some((t) => t.id === id);
      return { tasks: exists ? s.tasks.map((t) => (t.id === id ? full : t)) : [...s.tasks, full] };
    });
  },

  addTask: async (input: CreateTaskInput) => {
    const t = await createTask(input);
    set((s) => ({ tasks: [t, ...s.tasks] }));
    return t;
  },

  // Optimistic, like `reschedule` below and for the same reason: this is what
  // a board drag calls, and a card that only moves once the server answers
  // snaps back under the cursor and reads as a drop that did not take. On
  // failure the card returns to its lane and says so, rather than the change
  // disappearing silently - the previous version awaited the round trip and
  // swallowed any rejection into an unhandled promise.
  updateStatus: async (id, status) => {
    const prev = get().tasks.find((t) => t.id === id);
    if (!prev) return;
    const prevStatus = prev.status;

    set((s) => ({ tasks: s.tasks.map((t) => (t.id === id ? { ...t, status } : t)) }));
    try {
      // `prev` is the pre-edit task: the PATCH response carries no linked-entity label, so
      // without it a drag between lanes blanks the chip (redacted loses its padlock too).
      const serverRow = await updateTaskApi(id, { status }, prev);
      set((s) => ({
        tasks: s.tasks.map((t) =>
          t.id === id
            ? { ...serverRow, ...pick(t, DETAIL_ONLY_KEYS) }
            : t,
        ),
      }));
    } catch (err) {
      // Someone else moved the task to a DIFFERENT status first, and the server refused this
      // move rather than overwrite theirs (409 STATE_CONFLICT). Rolling back to the pre-click
      // status would show a status the task no longer has, and "try again" would invite the
      // overwrite - so show the task as the server holds it now, and say why.
      if (isStateConflict(err)) {
        await get().fetchTaskDetail(id).catch(() => {
          set((s) => ({ tasks: s.tasks.map((t) => (t.id === id ? { ...t, status: prevStatus } : t)) }));
        });
        toast({
          title: 'Task was changed',
          description: extractApiError(err, 'This task was changed by someone else.'),
          variant: 'destructive',
        });
        return;
      }
      set((s) => ({ tasks: s.tasks.map((t) => (t.id === id ? { ...t, status: prevStatus } : t)) }));
      toast({
        title: 'Status change failed',
        description: 'Could not move the task. Please try again.',
        variant: 'destructive',
      });
    }
  },

  updateTask: async (id, patch) => {
    // Only send API-supported scalar fields; ignore client-only fields (subtasks, etc.)
    const apiPatch: Parameters<typeof updateTaskApi>[1] = {};
    if (patch.title !== undefined) apiPatch.title = patch.title;
    if (patch.description !== undefined) apiPatch.description = patch.description;
    if (patch.status !== undefined) apiPatch.status = patch.status;
    if (patch.priority !== undefined) apiPatch.priority = patch.priority;
    if (patch.assignee_ids !== undefined) apiPatch.assignee_ids = patch.assignee_ids;
    if (patch.due_at !== undefined) apiPatch.due_at = patch.due_at;
    // The chip's category travels as its id; `null` clears it.
    if (patch.category !== undefined) apiPatch.category_id = patch.category?.id ?? null;

    const serverRow = await updateTaskApi(id, apiPatch, get().tasks.find((t) => t.id === id));
    // Re-merge any client-only keys so the UI doesn't lose them
    set((s) => ({
      tasks: s.tasks.map((x) =>
        x.id === id
          ? {
              ...serverRow,
              // From `x` - the row in the store - never from `patch`. `patch` is the
              // caller's partial: the drawer sends `{ priority }` alone, so picking from
              // it restored nothing and let the empty server row through.
              ...pick(x, DETAIL_ONLY_KEYS),
            }
          : x,
      ),
    }));
  },

  reschedule: async (id, due_at) => {
    const prev = get().tasks.find((t) => t.id === id);
    if (!prev) return;
    const prevDueAt = prev.due_at;
    // Optimistic: move the chip to the new day immediately so the calendar re-renders.
    set((s) => ({ tasks: s.tasks.map((t) => (t.id === id ? { ...t, due_at } : t)) }));
    try {
      const serverRow = await updateTaskApi(id, { due_at }, prev);
      // Reconcile with the server row; re-apply client-only keys the list-row mapper drops.
      set((s) => ({
        tasks: s.tasks.map((t) =>
          t.id === id
            ? { ...serverRow, ...pick(t, DETAIL_ONLY_KEYS) }
            : t,
        ),
      }));
    } catch {
      // Rollback to the pre-drag due_at and notify.
      set((s) => ({ tasks: s.tasks.map((t) => (t.id === id ? { ...t, due_at: prevDueAt } : t)) }));
      toast({
        title: 'Reschedule failed',
        description: 'Could not move the task. Please try again.',
        variant: 'destructive',
      });
    }
  },

  deleteTask: async (id) => {
    await deleteTaskApi(id);
    set((s) => ({ tasks: s.tasks.filter((x) => x.id !== id) }));
  },

  addComment: async (id, body) => {
    await addCommentApi(id, body);
    await get().fetchTaskDetail(id);
  },

  addSubtask: async (id, text) => {
    await addSubtaskApi(id, text);
    await get().fetchTaskDetail(id);
  },

  toggleSubtask: async (id, sid, done) => {
    await updateSubtaskApi(id, sid, { done });
    await get().fetchTaskDetail(id);
  },

  deleteSubtask: async (id, sid) => {
    await deleteSubtaskApi(id, sid);
    await get().fetchTaskDetail(id);
  },

  // A full REPLACE of the assignee set, mirroring setWatchers. Refetches the
  // detail row rather than trusting the optimistic array: the PATCH response is
  // a list row, and only the detail row carries watchers/subtasks/activity,
  // which a bare merge would blank.
  //
  // The empty case is caught HERE, not sent. A live task always has at least one
  // assignee, and the server answers an empty array with a 400 - but this is
  // reached from a multi-select's onChange, where a rejected promise has no
  // catch and would surface as an unhandled rejection with the chip already
  // gone from the UI. Refusing locally keeps the widget and the server agreeing
  // on the same invariant, and says why.
  setAssignees: async (id, ids) => {
    if (ids.length === 0) {
      toast({
        title: 'A task needs at least one assignee',
        description: 'Add someone else before removing the last one.',
        variant: 'destructive',
      });
      await get().fetchTaskDetail(id);
      return;
    }
    await updateTaskApi(id, { assignee_ids: ids });
    await get().fetchTaskDetail(id);
  },

  setWatchers: async (id, ids) => {
    await updateTaskApi(id, { watcher_ids: ids });
    await get().fetchTaskDetail(id);
  },

  nudge: async (id) => {
    await nudgeApi(id);
    await get().fetchTaskDetail(id);
  },

  // A no-op when nothing changed: returning the SAME state object is what lets Zustand skip the
  // notify, so a caller reporting the count on every render cannot start a render loop.
  setAttachmentCount: (id, count) => {
    set((s) => {
      const current = s.tasks.find((t) => t.id === id);
      if (!current || current.attachment_count === count) return s;
      return { tasks: s.tasks.map((t) => (t.id === id ? { ...t, attachment_count: count } : t)) };
    });
  },
  applyCategory: (category) => {
    set((s) => ({
      tasks: s.tasks.map((t) => (t.category?.id === category.id ? { ...t, category } : t)),
    }));
  },
  applyCategoryDeleted: ({ categoryId, movedTo, deletedTaskIds }) => {
    const deleted = new Set(deletedTaskIds);
    set((s) => ({
      tasks: s.tasks
        .filter((t) => !deleted.has(t.id))
        .map((t) => (t.category?.id === categoryId ? { ...t, category: movedTo } : t)),
    }));
  },
}));

/**
 * Logout must empty this store, not just the query cache.
 *
 * `fetchTasks` short-circuits on `loaded`, and a Zustand module singleton outlives a logout -
 * signing back in is a client-side navigation. Without this, an admin's org-wide board stayed
 * on screen for the technician who signed in next, and never re-fetched.
 */
registerStoreReset(() => {
  useTasksStore.setState({ tasks: [], loaded: false, loading: false });
});

// Helper: pick a subset of keys from an object (avoids a lodash dep)
function pick<T extends object, K extends keyof T>(obj: T, keys: readonly K[]): Pick<T, K> {
  const result = {} as Pick<T, K>;
  for (const k of keys) {
    if (k in obj) result[k] = obj[k];
  }
  return result;
}
