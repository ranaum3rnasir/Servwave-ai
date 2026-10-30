import { useAppAbility } from '@/contexts/AbilityContext';
import {
  useTaskCategories,
  type TaskCategoryRow,
} from '@/lib/api/taskCategories';
import { nextFreeCategoryColor } from '@/lib/tasks/taskCategoryDefaults';
import { useCreateTaskCategory, useDeleteTaskCategory, useUpdateTaskCategory } from '@/lib/tasks/useTaskCategoryWrites';
import { DeleteTaskCategoryDialog } from '@/components/tasks/DeleteTaskCategoryDialog';

import { TASK_CATEGORIES_DEF, pluralise, type ListController, type ListItem } from './listDefs';

function toItem(row: TaskCategoryRow): ListItem {
  const open = row.task_counts?.open ?? 0;
  const done = row.task_counts?.done ?? 0;
  const total = open + done;
  return {
    id: row.id,
    name: row.name,
    archived: false,
    usedCount: total,
    usedText: pluralise(total, TASK_CATEGORIES_DEF.usedWord),
    usedTitle: `${open} open, ${done} done`,
    color: row.color,
  };
}

/**
 * The Task categories card's adapter. The reads and writes are the ones the Tasks page's "Categories" dialog already
 * uses (`useTaskCategories` and the write hooks), so a rename or recolour here reaches every task chip at once.
 */
export function useTaskCategoryList(): ListController {
  const ability = useAppAbility();
  const query = useTaskCategories();
  const createRow = useCreateTaskCategory();
  const updateRow = useUpdateTaskCategory();
  const deleteRow = useDeleteTaskCategory();
  const rows = query.data ?? [];

  return {
    def: TASK_CATEGORIES_DEF,
    items: rows.map(toItem),
    isLoading: query.isLoading,
    isError: query.isError,
    retry: () => void query.refetch(),
    canCreate: ability.can('create', 'TaskCategory'),
    canEdit: ability.can('update', 'TaskCategory'),
    canDelete: ability.can('delete', 'TaskCategory'),
    defaultColour: nextFreeCategoryColor(rows),
    create: async (name, colour) => toItem(await createRow.mutateAsync({ name, color: colour ?? nextFreeCategoryColor(rows) })),
    rename: async (id, name) => toItem(await updateRow.mutateAsync({ id, patch: { name } })),
    setColour: async (id, colour) => toItem(await updateRow.mutateAsync({ id, patch: { color: colour } })),
    archive: () => Promise.reject(new Error('Task categories are deleted, not archived.')),
    unarchive: () => Promise.reject(new Error('Task categories are deleted, not archived.')),
    reorder: () => Promise.reject(new Error('Task categories have no manual order.')),
    // Only Undo of a Create calls this: a brand-new category has no tasks, so "keep" is the whole answer.
    remove: async (id) => void (await deleteRow.mutateAsync({ id, input: { mode: 'keep' } })),
    deleteDialog: (item, close) => {
      const row = rows.find((r) => r.id === item.id);
      return row ? <DeleteTaskCategoryDialog category={row} onClose={close} /> : null;
    },
  };
}
