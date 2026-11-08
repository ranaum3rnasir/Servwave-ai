import { type ParsedTask } from '@/lib/tasks/taskAI';
import { TASK_PRIORITIES, type LinkedEntity } from '@/lib/tasks/types';
import { MultiAssigneeSelect } from '@/components/crm/MultiAssigneeSelect';
import { useCreateTaskForm } from '@/lib/tasks/useCreateTaskForm';
import { TaskCreateFilesField } from '@/components/tasks/TaskCreateFilesField';

import { Button } from '@/ui-kit/components/ui/button';
import {
  Dialog, DialogBody, DialogContent, DialogFooter, DialogHeader, DialogTitle,
} from '@/ui-kit/components/ui/dialog';
import { Input } from '@/ui-kit/components/ui/input';
import { Label } from '@/ui-kit/components/ui/label';
import { SelectField } from '@/ui-kit/components/form/selectField';
import { Textarea } from '@/ui-kit/components/ui/textarea';
import { toast } from '@/ui-kit/components/ui/sonner';

import { DateTimePicker } from '../../_shared/dateTimePicker';
import { LinkedEntitySelect } from './linkedEntitySelect';
import { TaskCategoryPicker } from './taskCategoryPicker';
import { ELLIPSIS } from './glyphs';

interface CreateTaskDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  initialParse?: ParsedTask | null;
  /** When opened from a Job/Lead the linked entity is preset and locked. */
  presetEntity?: LinkedEntity | null;
}

function toDatetimeLocal(isoOrNull: string | null): string {
  if (!isoOrNull) return '';
  // datetime-local expects "YYYY-MM-DDTHH:MM"
  return isoOrNull.slice(0, 16);
}

/**
 * New Task.
 *
 * There is NO react-hook-form and NO client zod schema here, and that is
 * carried over rather than corrected: every field is plain `useState`, the only
 * client-side requirement is a non-empty title (enforced by the disabled Create
 * button and an early return), and the real validation is the server's zod
 * schema in `task.controller.ts`. Adding a resolver here would be a behaviour
 * change dressed as a restyle.
 *
 * The form state, the create/close flow and the files step live in
 * `useCreateTaskForm`, shared with the legacy CreateTaskModal; this file draws it
 * with the kit's controls.
 *
 * Due date is a `datetime-local` string converted with `new Date(v)
 * .toISOString()` on submit, i.e. LOCAL time in, UTC out - unchanged.
 */
function CreateTaskDialog({ open, onOpenChange, initialParse, presetEntity }: CreateTaskDialogProps) {
  const {
    title, setTitle, assigneeIds, setAssigneeIds, watcherIds, setWatcherIds,
    dueValue: dueDatetimeLocal, setDueValue: setDueDatetimeLocal, priority, setPriority,
    category, setCategory, linkedEntity, setLinkedEntity, linkedEntityLocked,
    description, setDescription, canAssignOthers, entityAccess, files, onFilesStep, footer,
    handleCreate, handleClose, onDialogOpenChange,
  } = useCreateTaskForm({
    open, onOpenChange, initialParse, presetEntity,
    dueFromIso: toDatetimeLocal,
    dueToIso: (value) => (value ? new Date(value).toISOString() : null),
    onCreateError: (title, description) => toast.error(title, { description }),
  });

  return (
    <Dialog open={open} onOpenChange={onDialogOpenChange}>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle>New Task</DialogTitle>
        </DialogHeader>

        <DialogBody className="flex flex-col gap-4">
          {onFilesStep ? (
            <TaskCreateFilesField files={files} />
          ) : (
            <>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="task-title">Title</Label>
                <Input
                  id="task-title"
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                  placeholder="Task title"
                />
              </div>

              <div className="flex flex-col gap-1.5">
                <Label htmlFor="new-task-assignees">Assignees</Label>
                {/* Disabled for a caller without `assign` on Task, showing the one
                    value the server would accept from them. */}
                <MultiAssigneeSelect
                  id="new-task-assignees"
                  value={assigneeIds}
                  onChange={setAssigneeIds}
                  purpose="task"
                  disabled={!canAssignOthers}
                  eligibleFor="task"
                  flaggedIds={entityAccess.flaggedIds}
                  flagNote={entityAccess.note}
                  flagBadge={entityAccess.badge}
                />
              </div>

              <div className="flex flex-col gap-1.5">
                <Label htmlFor="new-task-watchers">Watchers</Label>
                <MultiAssigneeSelect
                  id="new-task-watchers"
                  value={watcherIds}
                  onChange={setWatcherIds}
                  purpose="taskWatcher"
                  eligibleFor="task"
                  flaggedIds={entityAccess.flaggedIds}
                  flagNote={entityAccess.note}
                  flagBadge={entityAccess.badge}
                />
              </div>

              <div className="flex flex-col gap-1.5">
                <Label htmlFor="task-due">Due Date</Label>
                {/* Not a bare datetime-local Input: a native picker cannot be
                    dismissed from inside a modal Radix Dialog (#430). See the
                    component's own note. */}
                <DateTimePicker id="task-due" value={dueDatetimeLocal} onChange={setDueDatetimeLocal} />
              </div>

              <div className="flex flex-col gap-1.5">
                <Label>Priority</Label>
                <SelectField
                  value={priority}
                  onValueChange={setPriority}
                  options={TASK_PRIORITIES.map((p) => ({ value: p, label: p }))}
                />
              </div>

              <div className="flex flex-col gap-1.5">
                <Label htmlFor="new-task-category">Category</Label>
                <TaskCategoryPicker id="new-task-category" value={category} onChange={setCategory} />
              </div>

              <div className="flex flex-col gap-1.5">
                <Label>Linked To</Label>
                <LinkedEntitySelect
                  value={linkedEntity}
                  onChange={setLinkedEntity}
                  disabled={linkedEntityLocked}
                />
              </div>

              <div className="flex flex-col gap-1.5">
                <Label htmlFor="task-description">Description</Label>
                <Textarea
                  id="task-description"
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  rows={3}
                  placeholder={`Optional details${ELLIPSIS}`}
                />
              </div>

              <TaskCreateFilesField files={files} />
            </>
          )}
        </DialogBody>

        <DialogFooter>
          {footer.step === 'files' ? (
            <Button type="button" onClick={handleClose} disabled={footer.doneDisabled}>
              {footer.doneLabel}
            </Button>
          ) : (
            <>
              <Button type="button" variant="outline" onClick={handleClose} disabled={footer.cancelDisabled}>
                Cancel
              </Button>
              <Button type="button" onClick={handleCreate} disabled={footer.createDisabled}>
                {footer.createLabel}
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export { CreateTaskDialog };
