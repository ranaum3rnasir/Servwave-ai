import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { FormField } from '@/components/patterns/FormField';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { type ParsedTask } from '@/lib/tasks/taskAI';
import { TASK_PRIORITIES, type LinkedEntity } from '@/lib/tasks/types';
import { LinkedEntitySelect } from './LinkedEntitySelect';
import { TaskCategoryPicker } from './TaskCategoryPicker';
import { useToast } from '@/components/ui/use-toast';
import { MultiAssigneeSelect } from '@/components/crm/MultiAssigneeSelect';
import { useCreateTaskForm } from '@/lib/tasks/useCreateTaskForm';
import { TaskCreateFilesField } from './TaskCreateFilesField';
import { DateTimePicker } from '@/components/form/DateTimePicker';
import { useScheduleTimezone, pickerValueToIso, isoToPickerValue } from '@/lib/schedule-tz';
import { SelectField } from '@/components/form/SelectField';
import { cn } from '@/lib/utils';

interface CreateTaskModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  initialParse?: ParsedTask | null;
  presetEntity?: LinkedEntity | null; // when opened from a Job/Lead (Task 19); locks linked entity
  skipEntityAccess?: boolean;
  className?: string;
  overlayClassName?: string;
  onSuccess?: (task: any) => void;
  notify?: { in_app?: boolean; email?: boolean };
}

export function CreateTaskModal({
  open,
  onOpenChange,
  initialParse,
  presetEntity,
  skipEntityAccess,
  className,
  overlayClassName,
  onSuccess,
  notify,
}: CreateTaskModalProps) {
  // Task due times mean the ORG's clock, never the viewer's browser.
  const timezone = useScheduleTimezone();
  const { toast } = useToast();

  // The form, its create/close flow and the files step are shared with the Tasks page dialog.
  const {
    title, setTitle, assigneeIds, setAssigneeIds, watcherIds, setWatcherIds,
    dueValue: dueDatetimeLocal, setDueValue: setDueDatetimeLocal, priority, setPriority,
    category, setCategory, linkedEntity, setLinkedEntity, linkedEntityLocked,
    description, setDescription, canAssignOthers, entityAccess, files, onFilesStep, footer,
    handleCreate, handleClose, onDialogOpenChange,
  } = useCreateTaskForm({
    open, onOpenChange, initialParse, presetEntity, skipEntityAccess, onSuccess, notify,
    dueFromIso: (iso) => isoToPickerValue(iso, timezone),
    dueToIso: (value) => pickerValueToIso(value, timezone) ?? null,
    onCreateError: (title, description) => toast({ title, description, variant: 'destructive' }),
  });

  return (
    <Dialog open={open} onOpenChange={onDialogOpenChange}>
      <DialogContent
        className={cn("max-w-xl max-h-[90vh] overflow-y-auto z-[90]", className)}
        overlayClassName={cn("z-[85]", overlayClassName)}
      >
        <DialogHeader>
          <DialogTitle>New Task</DialogTitle>
        </DialogHeader>

        {onFilesStep ? (
          <TaskCreateFilesField files={files} />
        ) : (
          <div className="space-y-4">
            {/* Title */}
            <FormField label="Title" required>
              <Input
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder="Task title"
                className="w-full px-3 py-2"
              />
            </FormField>

            {/* Assignees - still not a FormField (that pattern owns the id it hands down, and
                this control is shared with the drawer, which has no FormField), but the label IS
                wired: MultiAssigneeSelect forwards `id` to its trigger. Disabled for a caller
                without `assign` on Task, showing the one value the server would accept. */}
            <div className="space-y-1">
              <label htmlFor="new-task-assignees" className="text-sm font-medium text-text-primary">Assignees</label>
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

          {/* Watchers - not a FormField for the same reason as Assignees above, but likewise
              label-wired through MultiAssigneeSelect's `id` prop. */}
          <div className="space-y-1">
            <label htmlFor="new-task-watchers" className="text-sm font-medium text-text-primary">Watchers</label>
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

          {/* Due date - not converted to FormField: DateTimePicker has no id prop of its own
              to receive fieldProps. */}
          <div className="space-y-1">
            <label className="text-sm font-medium text-text-primary">Due Date</label>
            <DateTimePicker value={dueDatetimeLocal} onChange={setDueDatetimeLocal} />
          </div>

          {/* Priority - not converted to FormField: SelectField doesn't forward an id to its
              SelectTrigger, so fieldProps would have nowhere to land. */}
          <div className="space-y-1">
            <label className="text-sm font-medium text-text-primary">Priority</label>
            <SelectField
              value={priority}
              onValueChange={(v) => setPriority(v)}
              className="w-full rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-primary/40 bg-surface-light"
              options={TASK_PRIORITIES.map((p) => ({ value: p, label: p }))}
            />
          </div>

          {/* Category - not a FormField for the same reason as Priority above; labelled
              through the picker's own id. */}
          <div className="space-y-1">
            <label htmlFor="new-task-category" className="text-sm font-medium text-text-primary">Category</label>
            <TaskCategoryPicker
              id="new-task-category"
              className="w-full rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-primary/40 bg-surface-light"
              value={category}
              onChange={setCategory}
            />
          </div>

          {/* Linked entity - not converted to FormField: LinkedEntitySelect is a compound
              Popover picker with no id prop of its own to receive fieldProps. */}
          <div className="space-y-1">
            <label className="text-sm font-medium text-text-primary">Linked To</label>
            <LinkedEntitySelect
              value={linkedEntity}
              onChange={setLinkedEntity}
              disabled={linkedEntityLocked}
            />
          </div>

          {/* Description */}
          <FormField label="Description">
            <Textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows={3}
              placeholder="Optional details…"
              className="w-full px-3 py-2 resize-none"
            />
          </FormField>

          <TaskCreateFilesField files={files} />
          </div>
        )}

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
