import { tintedChipColors } from '@/design-system/contrast';
import { cn } from '@/lib/utils';
import type { TaskCategoryRef } from '@/lib/tasks/types';

interface TaskCategoryChipProps {
  category: TaskCategoryRef | null | undefined;
  className?: string;
}

/**
 * A task's category as a chip, drawn the way the design review's approved mockup draws it: a
 * dot in the category's color, the name in a deep shade of that color, on a light tint of it.
 *
 * Shared by both task UIs (the Tasks page and the Job/Lead Tasks tabs) so a task reads the same
 * wherever it is opened. Renders nothing for a task with no category.
 *
 * The colors are inline styles because the category color is a persisted `#RRGGBB` from the
 * Tags palette, not a theme token (the tag chips in TagInput paint theirs the same way).
 * tintedChipColors derives the fill and the text from it so the name clears WCAG AA on all ten
 * palette colors - the solid chip with white text it replaces did not (2.28:1 on #22C55E).
 */
export function TaskCategoryChip({ category, className }: TaskCategoryChipProps) {
  if (!category) return null;
  const tinted = tintedChipColors(category.color);
  return (
    <span
      data-testid="task-category-chip"
      className={cn(
        'inline-flex max-w-full items-center gap-1.5 rounded-md px-2 py-0.5 text-[11px] font-semibold leading-4',
        // A stored value that is not a hex (never written by the API) still renders, just neutral.
        !tinted && 'bg-background-light text-text-primary',
        className,
      )}
      style={tinted ? { backgroundColor: tinted.fill, color: tinted.text } : undefined}
    >
      <span
        aria-hidden
        data-testid="task-category-dot"
        className="h-2 w-2 shrink-0 rounded-full"
        style={{ backgroundColor: category.color }}
      />
      <span className="truncate">{category.name}</span>
    </span>
  );
}
