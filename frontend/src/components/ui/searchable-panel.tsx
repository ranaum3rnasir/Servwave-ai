import * as React from 'react';

import { Input } from '@/components/ui/input';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';

/* =============================================================================
   SearchablePanel - the entity-filter pill family, ALWAYS searchable.
   See DESIGN_SYSTEM.md §4.2's "entity-filter pills are always searchable".
   -----------------------------------------------------------------------------
   A second dropdown family exists that §4.2's two Select entry points
   (`components/form/SelectField`, `ui-kit/components/form/selectField`) cannot
   reach, because its choices never arrive as a flat `{ value, label }[]` bound
   for a Radix Select. It is a Popover with a PILL TRIGGER (icon + two-line
   label/subtitle + count badge + chevron), a RESET ROW ("All Categories"), a
   SCROLLABLE MAPPED LIST whose rows carry per-row hover admin actions, and a
   PINNED FOOTER CTA ("+ Add category"). Four such panels shipped; Inventory
   -> Items listed 14 categories with no way to search them.

   THE POINT OF THIS FILE IS THAT IT IS ONE FILE. Search is not patched into
   each panel; it is owned here. A call site declares NOTHING about search - not
   a flag, not a threshold, not a matcher - so a NEW panel of this shape written
   next year inherits it by being built here, with nobody having to remember.
   `design-system/__tests__/dropdown-bypass-guard.test.ts` check 4 is what stops
   the next one being hand-rolled instead.

   WHY THERE IS NO COUNT GATE HERE, AND WHY THAT IS NOT A §4.2 VIOLATION
     §4.2's ten-option rule governs PLAIN OPTION LISTS, where ten short labels is
     the point at which scanning stops beating typing. This family is a different
     control: a management surface whose rows are two lines carrying branch,
     driver, vehicle and plate, with inline edit/delete affordances and a create
     action beneath them. Six of those rows are already denser than ten bare
     labels, and the rows grow subtitles over time while the count stays flat -
     so the count is simply not the right question to ask of this family. It
     earns search at any size, including the six-row Locations pill.

     Concretely: this file does NOT import `SEARCH_THRESHOLD`, and must not.
     Importing it would imply a gate that deliberately does not exist. Please do
     not "fix" this back to a threshold.

     The search box renders even when the list is empty. That is the same
     decision, taken literally: branching on the row count is the thing this
     family stopped doing, and the cost is one inert input inside a panel that is
     already saying it has nothing in it.

   WHAT THIS OWNS, AND WHAT IT DELIBERATELY DOES NOT
     It owns WHETHER a row renders. It never owns HOW. Each row hands in its own
     markup as `render`, because the panels' rows genuinely differ - a 7x7 icon
     tile and a count badge on one, an 11px two-line block on another, an inline
     rename Input on a third. Normalising those would be a rendered change to
     three shipped surfaces, which is the one thing this pass must not do. Every
     row, reset row and footer below the search box is emitted byte-for-byte as
     its call site emits it.
   ============================================================================= */

export interface SearchablePanelRow {
  /** React key, and the row's identity. */
  key: string;
  /**
   * Primary text. Matched by the search box, case-insensitively.
   * Text only - the row's rendered markup is `render`.
   */
  label: string;
  /**
   * Secondary text, ALSO matched. A van's label is "Mike's Van" and its
   * subtitle is "Brooklyn HQ · Mike Alvarez · Ford Transit · BX-4421", so typing
   * "Brooklyn" has to find it. Matching the label alone reads as unfinished for
   * exactly the reason §4.2 gives for the Combobox: an item has to be reachable
   * by every field a user might type.
   */
  subtitle?: string;
  /** Further haystacks beyond label + subtitle - a SKU, a branch code. */
  searchText?: string[];
  /** The row's own markup. Rendered verbatim when the row survives the query. */
  render: React.ReactNode;
}

export interface SearchablePanelProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /**
   * The pill. Handed to `PopoverTrigger asChild`, which clones it and forwards
   * a ref onto it - so it must be a single ref-accepting element.
   */
  trigger: React.ReactNode;
  /** The choices. Filtered by the query; nothing else here is. */
  rows: SearchablePanelRow[];
  /**
   * A pinned reset row ("All Categories" / "All Locations"), plus whatever
   * separator follows it. NEVER filtered - it is not a choice, it is the
   * absence of one, and a query that matches nothing must still let the user
   * back out to "show everything".
   */
  resetRow?: React.ReactNode;
  /**
   * Where the reset row sits relative to the scroll container.
   * `'above'` (default) - its own block above it, so it never scrolls away.
   * `'inList'` - the first thing inside it, scrolling with the rows.
   * Both shapes ship today and the difference is visible, so it is a prop
   * rather than a silent normalisation of one onto the other.
   */
  resetRowPlacement?: 'above' | 'inList';
  /**
   * Pinned ABOVE the search box, at the very top of the panel. NEVER filtered,
   * for the same reason `footer` is not.
   *
   * It exists because a panel's create affordance is not always at the bottom:
   * `inventory/StagingAreaPicker` pins "+ Add new staging area" at the TOP,
   * under a title block naming the warehouse, and has done since it shipped.
   * The alternative was to pass that block as `footer` and let it render at the
   * bottom, which would have been a rendered change to a live surface made
   * solely to avoid touching this file - exactly the trade this primitive's
   * header says it will not make ("It owns WHETHER a row renders. It never owns
   * HOW."). A slot is the honest expression of "this panel's create row is at
   * the top", so the slot is what it gets.
   *
   * Above the search box rather than below it, because that is where the block
   * already sits relative to everything else in that panel; the search box is
   * inserted directly above the list it filters and nothing else moves.
   */
  header?: React.ReactNode;
  /** Rendered when there are NO rows at all - a different thing from no match. */
  emptyState?: React.ReactNode;
  /** Rendered when a query excludes every row. Defaults to `No results for "<q>"`. */
  noMatchText?: string;
  /**
   * Pinned footer - the "+ Add category" CTA and anything under it.
   * NEVER filtered, for the same reason §4.2 pins the Combobox action row: a
   * user whose query matches nothing must still be able to add the very thing
   * they were looking for. That is the case the filtering creates, so it is
   * precisely the case the CTA has to survive.
   */
  footer?: React.ReactNode;
  searchPlaceholder?: string;
  /** Accessible name for the search box. Defaults to "Search options". */
  searchAriaLabel?: string;
  /** Class on `PopoverContent` - width, max-height, `p-0`, and so on. */
  contentClassName?: string;
  /** Class on the scroll container holding the rows. */
  listClassName?: string;

  // --- Popover pass-through, same names and defaults Radix uses ---------------
  align?: React.ComponentProps<typeof PopoverContent>['align'];
  side?: React.ComponentProps<typeof PopoverContent>['side'];
  sideOffset?: number;
  avoidCollisions?: boolean;
  onEscapeKeyDown?: React.ComponentProps<typeof PopoverContent>['onEscapeKeyDown'];
  /**
   * ARIA role for the list. Applied to the SCROLL CONTAINER, not to
   * `PopoverContent` where two of these call sites used to put it: the search
   * box is a child of the content, and a text input inside a `role="listbox"`
   * is not a listbox option. Moving it down is the correction that always
   * rendering a search box forces.
   */
  role?: string;
}

/** The fields a typed query is matched against, in one place. */
function haystack(row: SearchablePanelRow): string[] {
  return [row.label, row.subtitle ?? '', ...(row.searchText ?? [])];
}

export function SearchablePanel({
  open,
  onOpenChange,
  trigger,
  rows,
  resetRow,
  resetRowPlacement = 'above',
  header,
  emptyState,
  noMatchText,
  footer,
  searchPlaceholder = 'Search…',
  searchAriaLabel = 'Search options',
  contentClassName,
  listClassName,
  align,
  side,
  sideOffset,
  avoidCollisions,
  onEscapeKeyDown,
  role,
}: SearchablePanelProps) {
  const [query, setQuery] = React.useState('');

  /**
   * A stale query must not survive the panel closing. Done as a render-phase
   * adjustment rather than an effect: an effect would render the stale list once
   * and then re-render, and this repo's eslint rule forbids setState in an
   * effect body outright. Same pattern `components/ui/combobox.tsx` uses for its
   * own active-row reset.
   */
  const [seenOpen, setSeenOpen] = React.useState(open);
  if (seenOpen !== open) {
    setSeenOpen(open);
    if (query) setQuery('');
  }

  const trimmed = query.trim();
  const matches = React.useMemo(() => {
    if (!trimmed) return rows;
    const q = trimmed.toLowerCase();
    return rows.filter((row) => haystack(row).some((field) => field.toLowerCase().includes(q)));
  }, [rows, trimmed]);

  const noMatch = rows.length > 0 && matches.length === 0;

  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <PopoverTrigger asChild>{trigger}</PopoverTrigger>
      <PopoverContent
        align={align}
        side={side}
        sideOffset={sideOffset}
        avoidCollisions={avoidCollisions}
        onEscapeKeyDown={onEscapeKeyDown}
        className={contentClassName}
      >
        {header}
        {/* Outside the scroll container below, so the field can never scroll
            away with the results. `flex-shrink-0` because two of these panels
            make the popover content a flex column. */}
        <div className="flex-shrink-0 border-b border-border p-1">
          <Input
            autoFocus
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={searchPlaceholder}
            aria-label={searchAriaLabel}
            // Borderless/ringless by design - it blends into the panel's own
            // bordered wrapper, the same treatment combobox.tsx gives its own.
            className="h-8 border-0 focus-visible:ring-0"
          />
        </div>
        {resetRowPlacement === 'above' && resetRow}
        <div className={listClassName} role={role}>
          {resetRowPlacement === 'inList' && resetRow}
          {rows.length === 0
            ? emptyState
            : matches.map((row) => <React.Fragment key={row.key}>{row.render}</React.Fragment>)}
          {noMatch && (
            <p className="px-3 py-3 text-[11px] italic text-text-secondary">
              {noMatchText ?? `No results for "${trimmed}"`}
            </p>
          )}
        </div>
        {footer}
      </PopoverContent>
    </Popover>
  );
}
