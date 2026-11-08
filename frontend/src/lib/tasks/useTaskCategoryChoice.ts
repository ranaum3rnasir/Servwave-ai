import { useMemo, useState } from 'react';

import { useAppAbility } from '@/contexts/AbilityContext';
import { useTaskCategories, type TaskCategoryRow } from '@/lib/api/taskCategories';
import type { TaskCategoryRef } from '@/lib/tasks/types';
import { NO_CATEGORY_LABEL } from '@/lib/tasks/taskCategoryDefaults';

/**
 * Radix Select cannot hold an empty value, so "no category" is this sentinel inside the picker.
 * Not the Filter popover's `NO_CATEGORY_FILTER_VALUE` (tasks-logic): that one is a filter
 * selection, this one only ever lives inside a picker's option list.
 */
export const NO_CATEGORY_OPTION_VALUE = '__no_task_category__';

/** What CreateTaskCategoryDialog takes: the name to start from (null keeps it shut) and its outcomes. */
export interface CreateTaskCategoryDialogProps {
  /**
   * What was typed into the picker's search when "Create category" was picked - `''` when
   * nothing was, which still opens the dialog. `null` keeps the dialog closed.
   */
  name: string | null;
  onClose: () => void;
  onCreated: (category: TaskCategoryRow) => void;
}

/**
 * Everything a task-category picker needs except the control itself: the options (existing
 * categories, "No category" first), the selected option value, the mapping back from a picked
 * value to the category it names, and - for an admin only - creating one (slice 09).
 *
 * CREATE. Whoever may `create TaskCategory` (ADMIN alone) gets `onCreate`: the picker becomes
 * searchable and shows one fixed "Create category" row pinned below the list - there before
 * anything is typed, while searching, and when nothing matches (DESIGN_SYSTEM.md §4.2). Picking
 * it opens CreateTaskCategoryDialog (`createDialog`) with whatever was typed as the name (empty
 * when nothing was) to finish the name and choose the color; the API refuses a duplicate name and
 * the dialog says so. Once saved, `onChange` receives the new category, so the task takes it.
 * Everyone else gets `onCreate: undefined` - the plain list of existing categories, nothing to
 * type and nothing to create.
 *
 * One hook, two presentations - the Tasks page renders it through the kit SelectField
 * (pages/v2/tasks/components/taskCategoryPicker.tsx), the legacy task UI through the app one
 * (components/tasks/TaskCategoryPicker.tsx) - so both offer exactly the same choices.
 */
export function useTaskCategoryChoice(
  value: TaskCategoryRef | null | undefined,
  onChange: (next: TaskCategoryRef | null) => void,
) {
  const { data: categories } = useTaskCategories();
  const canCreate = useAppAbility().can('create', 'TaskCategory');
  const [draftName, setDraftName] = useState<string | null>(null);

  const options = useMemo(() => {
    const rows = (categories ?? []).map((c) => ({ value: c.id, label: c.name }));
    // A task filed under a category the list does not (yet) hold keeps showing it rather than
    // snapping to "No category" - the list may still be loading.
    if (value && !rows.some((r) => r.value === value.id)) rows.push({ value: value.id, label: value.name });
    return [{ value: NO_CATEGORY_OPTION_VALUE, label: NO_CATEGORY_LABEL }, ...rows];
  }, [categories, value]);

  /** The category a picked option value names; null for "No category". */
  function categoryFor(next: string): TaskCategoryRef | null {
    if (next === NO_CATEGORY_OPTION_VALUE) return null;
    const row = categories?.find((c) => c.id === next);
    if (row) return { id: row.id, name: row.name, color: row.color };
    return value?.id === next ? value : null;
  }

  const createDialog: CreateTaskCategoryDialogProps = {
    name: draftName,
    onClose: () => setDraftName(null),
    onCreated: (row: TaskCategoryRow) => {
      setDraftName(null);
      onChange({ id: row.id, name: row.name, color: row.color });
    },
  };

  return {
    options,
    selected: value?.id ?? NO_CATEGORY_OPTION_VALUE,
    /** Hand a picked option value to this - it resolves the category it names. */
    pick: (next: string) => onChange(categoryFor(next)),
    onCreate: canCreate ? setDraftName : undefined,
    createDialog,
  };
}
