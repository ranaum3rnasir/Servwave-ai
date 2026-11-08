import { useEffect, useId, useState, type KeyboardEvent, type ReactNode } from 'react';

import { cn, extractApiError } from '@/lib/utils';
import { normaliseTaskCategoryName } from '@/lib/tasks/taskCategoryDefaults';
import { useTaskCategories, type DeleteTaskCategoryInput, type TaskCategoryRow } from '@/lib/api/taskCategories';
import { useDeleteTaskCategory } from '@/lib/tasks/useTaskCategoryWrites';

import { ConfirmDialog } from '@/ui-kit/components/ui/confirmDialog';
import { Input } from '@/ui-kit/components/ui/input';
import { Label } from '@/ui-kit/components/ui/label';
import { SelectField } from '@/ui-kit/components/form/selectField';

type Mode = DeleteTaskCategoryInput['mode'];

const tasks = (n: number) => `${n} ${n === 1 ? 'task' : 'tasks'}`;

/** "14 tasks use this category: 11 open, 3 done." - the design review's wording. */
function usageLine(open: number, done: number): string {
  const total = open + done;
  if (total === 0) return 'No tasks use this category.';
  return `${tasks(total)} ${total === 1 ? 'uses' : 'use'} this category: ${open} open, ${done} done.`;
}

/**
 * The typed confirmation matches when it is the category's name, spaced the way names are stored;
 * letter case counts. The same rule as the server's (confirmsTaskCategoryName in
 * backend/src/lib/tasks/categoryWrites.ts), so an enabled button is never refused for the name.
 */
function confirmsName(typed: string, name: string): boolean {
  return normaliseTaskCategoryName(typed) === name;
}

interface ChoiceProps {
  checked: boolean;
  onSelect: () => void;
  title: string;
  hint: string;
  children?: ReactNode;
}

/**
 * One of the dialog's choices, with radio semantics. A row rather than a native radio: the kit has
 * no radio control and the title/hint pair needs two lines. Space or Enter picks it.
 */
function Choice({ checked, onSelect, title, hint, children }: ChoiceProps) {
  const id = useId();
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === ' ' || e.key === 'Enter') {
      e.preventDefault();
      onSelect();
    }
  };
  return (
    <div className="flex flex-col gap-2">
      <div
        role="radio"
        aria-checked={checked}
        aria-labelledby={`${id}-title`}
        aria-describedby={`${id}-hint`}
        tabIndex={0}
        onClick={onSelect}
        onKeyDown={onKeyDown}
        className="flex cursor-pointer items-start gap-2.5 rounded-md p-1 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
      >
        <span
          aria-hidden
          className={cn(
            'mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-full border-2',
            checked ? 'border-primary' : 'border-text-soft',
          )}
        >
          {checked && <span className="h-2 w-2 rounded-full bg-primary" />}
        </span>
        <span className="min-w-0">
          <span id={`${id}-title`} className="block text-sm font-semibold text-text-primary">{title}</span>
          <span id={`${id}-hint`} className="block text-sm text-text-secondary">{hint}</span>
        </span>
      </div>
      {checked && children}
    </div>
  );
}

interface DeleteTaskCategoryDialogProps {
  category: TaskCategoryRow;
  onClose: () => void;
}

/**
 * Delete a task category (slice 11), opened from the Delete action on each row of the manage
 * panel. It states how many tasks use the category - re-read as it opens, so the number it
 * confirms is current - and offers three choices: keep the tasks (the default), move them to
 * another category (which doubles as a merge), or also delete them, whatever their status. The
 * last needs the category's name typed and its button names the number of tasks. The server
 * applies whichever is chosen in one transaction and checks the typed name again.
 */
function DeleteTaskCategoryDialog({ category, onClose }: DeleteTaskCategoryDialogProps) {
  const { data: categories, refetch } = useTaskCategories();
  const deleteCategory = useDeleteTaskCategory();
  const [mode, setMode] = useState<Mode>('keep');
  const [targetId, setTargetId] = useState('');
  const [typed, setTyped] = useState('');
  const [error, setError] = useState<string | null>(null);
  const confirmId = useId();

  // The panel's counts can be minutes old; the dialog must state what the delete will touch now.
  useEffect(() => {
    void refetch();
  }, [refetch]);

  const current = categories?.find((c) => c.id === category.id) ?? category;
  const open = current.task_counts?.open ?? 0;
  const done = current.task_counts?.done ?? 0;
  const total = open + done;
  const others = (categories ?? []).filter((c) => c.id !== category.id);

  const input: DeleteTaskCategoryInput =
    mode === 'move' ? { mode, target_id: targetId }
    : mode === 'delete_tasks' ? { mode, confirm_name: typed, expected_task_count: total }
    : { mode: 'keep' };
  const ready =
    mode === 'keep' || (mode === 'move' ? targetId !== '' : confirmsName(typed, category.name));

  const pick = (next: Mode) => {
    setError(null);
    setMode(next);
  };

  const confirm = () => {
    setError(null);
    deleteCategory.mutate(
      { id: category.id, input: total === 0 ? { mode: 'keep' } : input },
      {
        onSuccess: onClose,
        onError: (err) => {
          // The count moved since the dialog read it (the server compares it with what we showed):
          // re-read it so the dialog, and the button, name the number the next click will delete.
          if ((err as { response?: { status?: number } }).response?.status === 409) void refetch();
          setError(extractApiError(err, "Couldn't delete the category. Please try again."));
        },
      },
    );
  };

  return (
    <ConfirmDialog
      open
      onOpenChange={(next) => !next && onClose()}
      destructive
      title={`Delete "${category.name}"?`}
      description={usageLine(open, done)}
      confirmLabel={mode === 'delete_tasks' && total > 0 ? `Delete category and ${tasks(total)}` : 'Delete category'}
      isPending={deleteCategory.isPending}
      confirmDisabled={total > 0 && !ready}
      onConfirm={confirm}
    >
      {(total > 0 || error) && (
        <div className="flex flex-col gap-3">
          {total > 0 && (
            <div role="radiogroup" aria-label="What happens to the tasks" className="flex flex-col gap-3">
              <Choice
                checked={mode === 'keep'}
                onSelect={() => pick('keep')}
                title="Keep the tasks"
                hint="They stay as they are, with no category."
              />
              {others.length > 0 && (
                <Choice
                  checked={mode === 'move'}
                  onSelect={() => pick('move')}
                  title="Move them to another category"
                  hint={total === 1 ? 'Pick a category for it.' : `Pick a category for all ${total}.`}
                >
                  <SelectField
                    aria-label="Move the tasks to"
                    placeholder="Choose a category"
                    value={targetId}
                    onValueChange={setTargetId}
                    options={others.map((c) => ({ value: c.id, label: c.name }))}
                  />
                </Choice>
              )}
              <Choice
                checked={mode === 'delete_tasks'}
                onSelect={() => pick('delete_tasks')}
                title={total === 1 ? 'Also delete the task' : `Also delete the ${total} tasks`}
                hint="Their comments, subtasks and files are deleted too. This can't be undone."
              >
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor={confirmId}>
                    Type <kbd className="rounded border border-border px-1 font-mono text-xs">{category.name}</kbd> to confirm
                  </Label>
                  <Input
                    id={confirmId}
                    value={typed}
                    onChange={(e) => setTyped(e.target.value)}
                    placeholder={category.name}
                    autoComplete="off"
                  />
                </div>
              </Choice>
            </div>
          )}
          {error && (
            <p role="alert" className="text-sm text-danger">
              {error}
            </p>
          )}
        </div>
      )}
    </ConfirmDialog>
  );
}

export { DeleteTaskCategoryDialog };
