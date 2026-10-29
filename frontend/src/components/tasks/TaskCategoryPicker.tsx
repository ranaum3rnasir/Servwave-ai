import { SelectField } from '@/components/form/SelectField';
import { CreateTaskCategoryDialog } from '@/components/tasks/CreateTaskCategoryDialog';
import { CREATE_TASK_CATEGORY_LABEL, noTaskCategoryMatches } from '@/lib/tasks/taskCategoryDefaults';
import { useTaskCategoryChoice } from '@/lib/tasks/useTaskCategoryChoice';
import type { TaskCategoryRef } from '@/lib/tasks/types';

export interface TaskCategoryPickerProps {
  value: TaskCategoryRef | null | undefined;
  onChange: (next: TaskCategoryRef | null) => void;
  id?: string;
  disabled?: boolean;
  className?: string;
  /** Accessible name. Defaults to "Category". */
  'aria-label'?: string;
}

/**
 * Pick a task's category, or none - the legacy task UI's copy (the Job/Lead Tasks tabs mount
 * CreateTaskModal and TaskDetailDrawer). The Tasks page renders the same choices through the kit
 * control in pages/v2/tasks/components/taskCategoryPicker.tsx; both come from
 * `useTaskCategoryChoice`.
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
        emptyText={noTaskCategoryMatches}
      />
      {onCreate && <CreateTaskCategoryDialog {...createDialog} />}
    </>
  );
}
