import { tidyQuery } from '@/ui-kit/lib/createQuery';
import { TAG_COLORS } from '@/lib/tag-colors';

/** The line both hosts of the category manage panel (Tasks page dialog, Settings card) show. */
export const TASK_CATEGORIES_DESCRIPTION =
  'Shown to everyone who can see a task. Only admins can change this list.';

/**
 * The color a new category starts on: the first Tags palette color no category uses yet, so it
 * is told apart from the others without the admin having to pick. Falls back to the first color
 * once all ten are taken.
 */
export function nextFreeCategoryColor(categories: ReadonlyArray<{ color: string }>): string {
  const used = new Set(categories.map((c) => c.color.toUpperCase()));
  return TAG_COLORS.find((c) => !used.has(c)) ?? TAG_COLORS[0]!;
}

/**
 * A category name as it is stored and compared: invisible format characters removed, trimmed,
 * runs of whitespace collapsed to one space - the pickers' own tidy rule (ui-kit/lib/createQuery). The API normalises the same way (normaliseTaskCategoryName in
 * backend/src/lib/tasks/categories.ts) and then refuses a case-insensitive duplicate, so the
 * manager compares in this form too - a spacing-only edit is no change.
 */
export function normaliseTaskCategoryName(name: string): string {
  return tidyQuery(name);
}

/** The entry for "filed under no category", in the task pickers and the Filter popover alike. */
export const NO_CATEGORY_LABEL = 'No category';

/** The picker's fixed create row - the same words whether or not anything is typed. */
export const CREATE_TASK_CATEGORY_LABEL = 'Create category';
/** The picker's no-match line (the design review mockup's wording). */
export const noTaskCategoryMatches = (query: string) => `No category matches "${query}"`;

/**
 * Marks an inline form whose Escape cancels the form rather than the dialog around it. Radix
 * dialogs catch Escape on the document BEFORE the form's own handler runs, so stopPropagation in
 * the form cannot help; the host dialog checks for this attribute in `onEscapeKeyDown` instead.
 */
export const ESCAPE_CANCELS_ATTR = 'data-escape-cancels-form';

/** For a dialog's `onEscapeKeyDown`: keep the dialog open when Escape belongs to an inline form. */
export function keepOpenForInlineFormEscape(event: KeyboardEvent): void {
  const target = event.target as Element | null;
  if (target?.closest?.(`[${ESCAPE_CANCELS_ATTR}]`)) event.preventDefault();
}
