import { useQuery } from '@tanstack/react-query';

import api from '@/lib/axios';
import type { TaskCategoryRef } from '@/lib/tasks/types';

/**
 * Task categories - the org-wide list a task is filed under (visits-and-task-categories plan).
 *
 * The ONE client and the ONE query key for the list. The admin manager (slice 09), the category
 * filter (slice 10) and the delete dialog (slice 11) read and invalidate `taskCategoryKeys.all`
 * rather than minting their own, so a rename or a delete refreshes every picker at once.
 */
export interface TaskCategoryRow extends TaskCategoryRef {
  sort_order: number;
  /**
   * How many tasks use the category, split into open and done (done = Done or Cancelled). Only an
   * admin's list carries it (slice 11): it is what the manage panel and the delete dialog show.
   */
  task_counts?: { open: number; done: number };
}

export const taskCategoryKeys = {
  all: ['task-categories'] as const,
};

export function listTaskCategories(): Promise<TaskCategoryRow[]> {
  return api.get('/api/task-categories').then((r) => (r.data?.categories ?? []) as TaskCategoryRow[]);
}

/** The org's categories, in the admin's order. Every role may read them. */
export function useTaskCategories() {
  return useQuery({
    queryKey: taskCategoryKeys.all,
    queryFn: listTaskCategories,
    // A short list that changes only when an admin edits it; the manager invalidates on write.
    staleTime: 5 * 60_000,
  });
}

/** What an admin sends to add a category, or to rename and/or recolor one (slice 09). */
export interface TaskCategoryInput {
  name: string;
  color: string;
}

/** Admin-only; the API refuses a duplicate name (any letter case) and a color off the palette. */
export function createTaskCategory(input: TaskCategoryInput): Promise<TaskCategoryRow> {
  return api.post('/api/task-categories', input).then((r) => r.data.category as TaskCategoryRow);
}

/** Admin-only; send only the fields that changed. */
export function updateTaskCategory(id: string, patch: Partial<TaskCategoryInput>): Promise<TaskCategoryRow> {
  return api.patch(`/api/task-categories/${id}`, patch).then((r) => r.data.category as TaskCategoryRow);
}

/**
 * What happens to a category's tasks when it is deleted (slice 11): they stay with no category,
 * move to another category, or are deleted too - the last only with the category's name typed.
 */
export type DeleteTaskCategoryInput =
  | { mode: 'keep' }
  | { mode: 'move'; target_id: string }
  /** `expected_task_count`: the count the dialog showed; the server refuses (409) if it moved. */
  | { mode: 'delete_tasks'; confirm_name: string; expected_task_count: number };

export interface DeleteTaskCategoryResult {
  mode: DeleteTaskCategoryInput['mode'];
  task_count: number;
  /** The category the tasks moved to (`move` only). */
  target: TaskCategoryRow | null;
  /** The tasks that were deleted (`delete_tasks` only). */
  deleted_task_ids: string[];
}

/** Admin-only; the whole change is one transaction on the server. */
export function deleteTaskCategory(id: string, input: DeleteTaskCategoryInput): Promise<DeleteTaskCategoryResult> {
  return api.delete(`/api/task-categories/${id}`, { data: input }).then((r) => r.data as DeleteTaskCategoryResult);
}
