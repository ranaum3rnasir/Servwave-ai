import { useState } from 'react';
import { Plus } from 'lucide-react';

import { extractApiError } from '@/lib/utils';
import { nextFreeCategoryColor } from '@/lib/tasks/taskCategoryDefaults';
import { useTaskCategories, type TaskCategoryInput, type TaskCategoryRow } from '@/lib/api/taskCategories';
import { useCreateTaskCategory, useUpdateTaskCategory } from '@/lib/tasks/useTaskCategoryWrites';

import { Button } from '@/ui-kit/components/ui/button';
import { EmptyState } from '@/ui-kit/components/data/emptyState';

import { DeleteTaskCategoryDialog } from './DeleteTaskCategoryDialog';
import { TaskCategoryForm } from './TaskCategoryForm';

export interface TaskCategoryManagerProps {
  /**
   * Whether the add row is open, when the HOST draws the "Add category" button - in its own
   * header row, beside the title, as the design review's mockup places it (both hosts do).
   * Leave both unset and the panel draws its own button above the list.
   */
  adding?: boolean;
  onAddingChange?: (adding: boolean) => void;
}

/** The panel's "Add category" button, for a host to place in its header row. */
export function AddTaskCategoryButton({ onClick }: { onClick: () => void }) {
  return (
    <Button type="button" size="sm" onClick={onClick}>
      <Plus />
      Add category
    </Button>
  );
}

/** "14 tasks" - how many tasks a delete would touch, open and done together. */
function taskCountLabel(counts: TaskCategoryRow['task_counts']): string | null {
  if (!counts) return null;
  const n = counts.open + counts.done;
  return `${n} ${n === 1 ? 'task' : 'tasks'}`;
}

/**
 * The task categories manage panel (slice 09): the org's list, an "Add category" row and inline
 * rename/recolor from the Tags palette. Each row also shows how many tasks use the category and
 * offers Delete, which opens the keep / move / delete-the-tasks dialog (slice 11). ONE panel, opened from two places - the admin-only
 * "Categories" button on the Tasks page (TaskCategoriesDialog) and the Task categories card in
 * Settings > Payments & Lists - modelled on the Tags settings card.
 *
 * Its hosts render it only for admins; the API refuses everyone else regardless. Writes save
 * immediately, and a rename or recolor reaches every task using the category at once
 * (useTaskCategoryWrites).
 */
export function TaskCategoryManager({ adding, onAddingChange }: TaskCategoryManagerProps) {
  const { data: categories, isLoading } = useTaskCategories();
  const createCategory = useCreateTaskCategory();
  const updateCategory = useUpdateTaskCategory();
  const hostOwnsAdd = adding !== undefined;
  const [ownAdding, setOwnAdding] = useState(false);
  const isAdding = hostOwnsAdd ? adding : ownAdding;
  const setAdding = (next: boolean) => (hostOwnsAdd ? onAddingChange?.(next) : setOwnAdding(next));
  const [editingId, setEditingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<TaskCategoryRow | null>(null);

  const startEdit = (id: string) => {
    setError(null);
    setAdding(false);
    setEditingId(id);
  };
  const close = () => {
    setError(null);
    setAdding(false);
    setEditingId(null);
  };
  const refuse = (err: unknown) => setError(extractApiError(err, "Couldn't save the category. Please try again."));

  const add = (values: TaskCategoryInput) => {
    createCategory.mutate(values, { onSuccess: close, onError: refuse });
  };

  const save = (category: TaskCategoryRow, values: TaskCategoryInput) => {
    const patch: Partial<TaskCategoryInput> = {
      ...(values.name !== category.name ? { name: values.name } : {}),
      ...(values.color.toUpperCase() !== category.color.toUpperCase() ? { color: values.color } : {}),
    };
    if (Object.keys(patch).length === 0) return close();
    updateCategory.mutate({ id: category.id, patch }, { onSuccess: close, onError: refuse });
  };

  const list = categories ?? [];

  return (
    <div className="flex flex-col gap-3">
      {isAdding ? (
        <TaskCategoryForm
          initial={{ name: '', color: nextFreeCategoryColor(list) }}
          submitLabel="Add"
          pending={createCategory.isPending}
          error={error}
          onSubmit={add}
          onCancel={close}
        />
      ) : (
        !hostOwnsAdd && (
          <div className="flex justify-end">
            <AddTaskCategoryButton
              onClick={() => {
                setError(null);
                setEditingId(null);
                setAdding(true);
              }}
            />
          </div>
        )
      )}

      {isLoading ? (
        <p className="text-sm text-text-secondary">Loading categories…</p>
      ) : list.length === 0 ? (
        <EmptyState title="No task categories yet." />
      ) : (
        <ul aria-label="Task categories" className="divide-y divide-border">
          {list.map((category) => (
            <li key={category.id} className="py-2">
              {!isAdding && editingId === category.id ? (
                <TaskCategoryForm
                  initial={{ name: category.name, color: category.color }}
                  submitLabel="Save"
                  pending={updateCategory.isPending}
                  error={error}
                  onSubmit={(values) => save(category, values)}
                  onCancel={close}
                />
              ) : (
                <div className="flex items-center gap-2">
                  <span aria-hidden style={{ backgroundColor: category.color }} className="h-3 w-3 shrink-0 rounded-full" />
                  <span className="min-w-0 flex-1 truncate text-sm font-medium text-text-primary">{category.name}</span>
                  {category.task_counts && (
                    <span className="shrink-0 text-sm text-text-secondary">{taskCountLabel(category.task_counts)}</span>
                  )}
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    aria-label={`Edit ${category.name}`}
                    onClick={() => startEdit(category.id)}
                  >
                    Edit
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    aria-label={`Delete ${category.name}`}
                    className="text-danger hover:text-danger"
                    onClick={() => {
                      close();
                      setDeleting(category);
                    }}
                  >
                    Delete
                  </Button>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}

      {deleting && <DeleteTaskCategoryDialog category={deleting} onClose={() => setDeleting(null)} />}
    </div>
  );
}
