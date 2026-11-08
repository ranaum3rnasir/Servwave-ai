import { useState } from 'react';

import { extractApiError } from '@/lib/utils';
import { useTaskCategories } from '@/lib/api/taskCategories';
import { useCreateTaskCategory } from '@/lib/tasks/useTaskCategoryWrites';
import type { CreateTaskCategoryDialogProps } from '@/lib/tasks/useTaskCategoryChoice';
import { nextFreeCategoryColor } from '@/lib/tasks/taskCategoryDefaults';

import {
  Dialog, DialogBody, DialogContent, DialogDescription, DialogHeader, DialogTitle,
} from '@/ui-kit/components/ui/dialog';

import { TaskCategoryForm } from './TaskCategoryForm';

/**
 * Finish a category an admin started from a task's category picker ("Create category"): whatever
 * they had typed into the picker's search comes prefilled (an empty name when nothing was - the
 * form will not save one), they choose its color, and the task takes the new category once it is
 * saved (slice 09). A duplicate name - already in the list, or another admin got there first - is
 * refused by the API and shown here, with the dialog left open to rename.
 */
function CreateTaskCategoryDialog({ name, onClose, onCreated }: CreateTaskCategoryDialogProps) {
  const { data: categories } = useTaskCategories();
  const createCategory = useCreateTaskCategory();
  const [error, setError] = useState<string | null>(null);

  const close = () => {
    setError(null);
    onClose();
  };

  return (
    <Dialog open={name !== null} onOpenChange={(next) => !next && close()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>New task category</DialogTitle>
          <DialogDescription>Everyone who can see a task sees its category.</DialogDescription>
        </DialogHeader>
        <DialogBody className="pb-5">
          {name !== null && (
            <TaskCategoryForm
              // A fresh form per opening name, so reopening never shows the last one's draft.
              key={name}
              initial={{ name, color: nextFreeCategoryColor(categories ?? []) }}
              submitLabel="Create category"
              pending={createCategory.isPending}
              error={error}
              onSubmit={(values) =>
                createCategory.mutate(values, {
                  onSuccess: (row) => {
                    setError(null);
                    onCreated(row);
                  },
                  onError: (err) => setError(extractApiError(err, "Couldn't create the category. Please try again.")),
                })
              }
              onCancel={close}
            />
          )}
        </DialogBody>
      </DialogContent>
    </Dialog>
  );
}

export { CreateTaskCategoryDialog };
