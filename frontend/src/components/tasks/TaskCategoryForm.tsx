import { useState, type FormEvent } from 'react';

import { PaletteSwatchPicker } from '@/components/form/PaletteSwatchPicker';
import { TAG_COLORS } from '@/lib/tag-colors';
import type { TaskCategoryInput } from '@/lib/api/taskCategories';
import { ESCAPE_CANCELS_ATTR, normaliseTaskCategoryName } from '@/lib/tasks/taskCategoryDefaults';

import { Button } from '@/ui-kit/components/ui/button';
import { Input } from '@/ui-kit/components/ui/input';

/** The API's own limit (task-category.controller.ts). */
const TASK_CATEGORY_NAME_MAX = 50;

interface TaskCategoryFormProps {
  initial: TaskCategoryInput;
  submitLabel: string;
  pending?: boolean;
  /** The server's refusal (a duplicate name), shown under the field until the next submit. */
  error?: string | null;
  onSubmit: (values: TaskCategoryInput) => void;
  onCancel: () => void;
  autoFocus?: boolean;
}

/**
 * A category's name and color - the one form behind every place an admin writes a category: the
 * manage panel's add row, its inline edit row, and the picker's "Create" dialog. The swatches are
 * the Tags palette, which the API also enforces (task-category-palette-parity.test.ts).
 */
export function TaskCategoryForm({
  initial,
  submitLabel,
  pending,
  error,
  onSubmit,
  onCancel,
  autoFocus = true,
}: TaskCategoryFormProps) {
  const [name, setName] = useState(initial.name);
  const [color, setColor] = useState(initial.color);
  const trimmed = normaliseTaskCategoryName(name);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    // A form nested in a dialog's form (the create-task dialog) must not submit that one too.
    e.stopPropagation();
    if (trimmed && !pending) onSubmit({ name: trimmed, color });
  };

  return (
    <form
      onSubmit={submit}
      // Escape anywhere in the form (the name field or a swatch) cancels THIS edit. A host dialog
      // sees ESCAPE_CANCELS_ATTR on the event target and keeps itself open (TaskCategoriesDialog).
      {...{ [ESCAPE_CANCELS_ATTR]: '' }}
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.stopPropagation();
          onCancel();
        }
      }}
      className="flex flex-col gap-2.5"
    >
      <Input
        value={name}
        onChange={(e) => setName(e.target.value)}
        maxLength={TASK_CATEGORY_NAME_MAX}
        placeholder="Category name"
        aria-label="Category name"
        aria-invalid={error ? true : undefined}
        autoFocus={autoFocus}
      />
      <PaletteSwatchPicker colors={TAG_COLORS} value={color} onChange={setColor} />
      {error && (
        <p role="alert" className="text-destructive text-xs">
          {error}
        </p>
      )}
      <div className="flex justify-end gap-2">
        <Button type="button" variant="outline" size="sm" onClick={onCancel}>
          Cancel
        </Button>
        <Button type="submit" size="sm" disabled={!trimmed || pending}>
          {submitLabel}
        </Button>
      </div>
    </form>
  );
}
