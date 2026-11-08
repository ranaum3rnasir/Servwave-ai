import {
  Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '@/ui-kit/components/ui/dialog';
import { Button } from '@/ui-kit/components/ui/button';

import { useState } from 'react';

import { TASK_CATEGORIES_DESCRIPTION, keepOpenForInlineFormEscape } from '@/lib/tasks/taskCategoryDefaults';

import { AddTaskCategoryButton, TaskCategoryManager } from './TaskCategoryManager';

interface TaskCategoriesDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/**
 * The manage panel as a dialog - what the admin-only "Categories" button on the Tasks page opens.
 * The Settings card (Payments & Lists) hosts the same TaskCategoryManager in a card instead.
 */
function TaskCategoriesDialog({ open, onOpenChange }: TaskCategoriesDialogProps) {
  const [adding, setAdding] = useState(false);
  const changeOpen = (next: boolean) => {
    if (!next) setAdding(false);
    onOpenChange(next);
  };
  return (
    <Dialog open={open} onOpenChange={changeOpen}>
      {/* Escape inside an add/edit row cancels that row only; the form handles it. */}
      <DialogContent className="max-w-lg" onEscapeKeyDown={keepOpenForInlineFormEscape}>
        <DialogHeader>
          {/* One block, so the header row reads title-left, "Add category" right (the mockup). */}
          <div className="flex items-start justify-between gap-4">
            <div className="min-w-0">
              <DialogTitle>Task categories</DialogTitle>
              <DialogDescription>{TASK_CATEGORIES_DESCRIPTION}</DialogDescription>
            </div>
            <AddTaskCategoryButton onClick={() => setAdding(true)} />
          </div>
        </DialogHeader>
        <DialogBody>
          <TaskCategoryManager adding={adding} onAddingChange={setAdding} />
        </DialogBody>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => changeOpen(false)}>
            Done
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export { TaskCategoriesDialog };
