import { useTaskCategoryChoice } from '@/lib/tasks/useTaskCategoryChoice';
import type { TaskCategoryPickerProps } from '@/components/tasks/TaskCategoryPicker';
import { CreateTaskCategoryDialog } from '@/components/tasks/CreateTaskCategoryDialog';
import { CREATE_TASK_CATEGORY_LABEL, noTaskCategoryMatches } from '@/lib/tasks/taskCategoryDefaults';

import { SelectField } from '@/ui-kit/components/form/selectField';

/**
 * Pick a task's category, or none - the Tasks page's copy, on the kit control so it matches the
 * Priority and Status selects beside it. Same choices as the legacy picker
 * (components/tasks/TaskCategoryPicker.tsx): both come from `useTaskCategoryChoice`.
 *
 * An admin also gets a fixed "Create category" row below the list (useTaskCategoryChoice).
 */
export function TaskCategoryPicker({
  value,
  onChange,
  id,
  disabled,
  className,
  'aria-label': ariaLabel = 'Category',
}: TaskCategoryPickerProps) {
  const { options, selected, pick, onCreate, createDialog } = useTaskCategoryChoice(value, onChange);
  return (
    <>
      <SelectField
        id={id}
        aria-label={ariaLabel}
        value={selected}
        onValueChange={pick}
        options={options}
        disabled={disabled}
        className={className}
        onCreate={onCreate}
        createLabel={CREATE_TASK_CATEGORY_LABEL}
        emptyMessage={noTaskCategoryMatches}
      />
      {onCreate && <CreateTaskCategoryDialog {...createDialog} />}
    </>
  );
}
