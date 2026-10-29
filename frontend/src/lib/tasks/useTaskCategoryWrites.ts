import { useMutation, useQueryClient, type QueryClient } from '@tanstack/react-query';

import {
  createTaskCategory,
  deleteTaskCategory,
  taskCategoryKeys,
  updateTaskCategory,
  type DeleteTaskCategoryInput,
  type TaskCategoryInput,
  type TaskCategoryRow,
} from '@/lib/api/taskCategories';
import { useTasksStore } from '@/stores/tasksStore';
import { useTaskDetailStore } from '@/stores/taskDetailStore';

/**
 * The admin's category writes (slices 09 and 11) and the ONE place that makes their result show
 * everywhere at once:
 *
 *  - the shared list (`taskCategoryKeys.all`) - every picker, the manage panel, slice 10's filter -
 *    takes the written row immediately and is then refetched, so the server's order wins;
 *  - every task already carrying the category takes its new name and color in the task store,
 *    which both task UIs (the Tasks page and the Job/Lead Tasks tab drawers) render from. Tasks
 *    are not in React Query - there is no task query key to invalidate.
 *
 * The Job/Lead Tasks tab's own card list is fetched on mount and on every drawer close, and the
 * manage panel cannot be open on the same screen, so it never shows a stale chip either.
 */
function applyWrittenCategory(queryClient: QueryClient, row: TaskCategoryRow) {
  queryClient.setQueryData<TaskCategoryRow[]>(taskCategoryKeys.all, (prev) =>
    prev ? (prev.some((c) => c.id === row.id) ? prev.map((c) => (c.id === row.id ? row : c)) : [...prev, row]) : prev,
  );
  void queryClient.invalidateQueries({ queryKey: taskCategoryKeys.all });
  useTasksStore.getState().applyCategory({ id: row.id, name: row.name, color: row.color });
}

export function useCreateTaskCategory() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: TaskCategoryInput) => createTaskCategory(input),
    onSuccess: (row) => applyWrittenCategory(queryClient, row),
  });
}

export function useUpdateTaskCategory() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, patch }: { id: string; patch: Partial<TaskCategoryInput> }) => updateTaskCategory(id, patch),
    onSuccess: (row) => applyWrittenCategory(queryClient, row),
  });
}

/**
 * Delete a category and keep, move or delete its tasks (slice 11). On success the category leaves
 * the shared list, and the task store follows the server: kept tasks lose the chip, moved tasks
 * carry the target's, deleted tasks leave (and a drawer open on one of them closes). The list is
 * refetched too - a move changes the target's task counts.
 */
export function useDeleteTaskCategory() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, input }: { id: string; input: DeleteTaskCategoryInput }) => deleteTaskCategory(id, input),
    onSuccess: (result, { id }) => {
      queryClient.setQueryData<TaskCategoryRow[]>(taskCategoryKeys.all, (prev) => prev?.filter((c) => c.id !== id));
      void queryClient.invalidateQueries({ queryKey: taskCategoryKeys.all });
      const movedTo = result.target ? { id: result.target.id, name: result.target.name, color: result.target.color } : null;
      useTasksStore.getState().applyCategoryDeleted({ categoryId: id, movedTo, deletedTaskIds: result.deleted_task_ids });
      const detail = useTaskDetailStore.getState();
      if (detail.openTaskId && result.deleted_task_ids.includes(detail.openTaskId)) detail.close();
    },
  });
}
