import * as React from 'react';
import type { VariantProps } from 'class-variance-authority';
import { Check, ChevronDown, Plus } from 'lucide-react';

import { Input } from '@/components/ui/input';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { selectTriggerVariants, type SelectTriggerTone } from '@/components/ui/select';
import { useScrollLockEscape } from '@/hooks/useScrollLockEscape';
import { cn } from '@/lib/utils';
import { DEFAULT_CREATE_LABEL, tidyQuery } from '@/ui-kit/lib/createQuery';
import type { SelectFieldAction, SelectFieldOption } from '@/components/form/SelectField';

/* =============================================================================
   Combobox - the searchable branch of DESIGN_SYSTEM.md §4.2 ("10 or more
   options is a combobox; fewer than 10 is a plain select").
   -----------------------------------------------------------------------------
   A SIBLING of Select, not a flag on it. Radix Select owns focus and ships its
   own single-keystroke typeahead, so a text input cannot live inside it - a
   library constraint, not a styling preference. `select.tsx` is therefore
   untouched and every existing <Select> render stays byte-identical.

   The composition (Popover + Input + useMemo filter + a listbox) is not
   invented here: `crm/AssigneeSelect.tsx` has shipped it in production. This
   primitive consolidates that shape and adds the four things §4.2 requires
   beyond plain filtering - multi-field matching, a pinned input, a selection
   that survives a non-matching query, and a named empty state / a fixed create
   row for a list the user can add to.

   The trigger deliberately renders `selectTriggerVariants()` rather than a
   re-derived class string: a user must not be able to tell which branch of the
   rule they got, and reusing the cva keeps the two triggers identical by
   construction instead of by vigilance. The placeholder state is expressed as
   `data-placeholder`, which is the same hook the shared string already styles
   (`data-[placeholder]:text-text-secondary`).
   ============================================================================= */

export interface ComboboxProps {
  /** Selected option's `value`. The empty string means nothing is selected. */
  value: string;
  onValueChange: (value: string) => void;
  options: SelectFieldOption[];
  placeholder?: string;
  disabled?: boolean;
  className?: string;
  id?: string;
  /**
   * The trigger's height/type rung, read from the SAME `selectTriggerVariants`
   * cva the Radix trigger wears. §4.2 promises a list crossing ten does not
   * change the control, and that covers font-size as well as height - `xs` is
   * `h-8 text-xs`, so forwarding only the height would still visibly restyle
   * the trigger on the commit that grows the list.
   */
  size?: VariantProps<typeof selectTriggerVariants>['size'];
  /** Mirrors `SelectTrigger`'s own `tone`, applied in the same order it applies it. */
  tone?: SelectTriggerTone;
  /** A pinned trailing row that is not a choice - see `SelectFieldAction`. */
  action?: SelectFieldAction;
  'aria-label'?: string;
  'aria-describedby'?: string;
  'aria-invalid'?: boolean;
  /**
   * The fields a typed query is matched against, case-insensitively. Defaults
   * to the label alone; an inventory picker passes SKU and brand too so an item
   * is reachable by `241CRL91723001`, by `Door Closer`, and by `CRL`.
   */
  searchFields?: (option: SelectFieldOption) => string[];
  /** Named empty state. Defaults to `No results for "<query>"`; a function receives the tidied query. */
  emptyText?: string | ((query: string) => string);
  /**
   * The list can be ADDED to. When given, one fixed `+ <createLabel>` row is
   * pinned at the bottom of the panel, below a divider and OUTSIDE the
   * scrolling, filtered area (DESIGN_SYSTEM.md §4.2): there the moment the list
   * opens, the same row with the same label while the user searches, and still
   * there when nothing matches. Picking it hands over the tidied search text
   * (possibly `""`, the shared rule in `@/ui-kit/lib/createQuery`) so whatever
   * was typed pre-fills the new record. Whether that name is a duplicate is for
   * whoever finishes the record to say, not this row.
   *
   * NOT the same door as `action`, and the two cannot substitute for each
   * other: `onCreate` hands over the query and sits outside the list; `action`
   * carries no query and is the list's own last row. Both draw from one row
   * vocabulary so they cannot drift apart visually.
   */
  onCreate?: (query: string) => void;
  /** The create row's constant wording - it never changes with the query. Defaults to "Create new". */
  createLabel?: string;
  /**
   * Observes the list opening and closing. The popover's open state stays this
   * component's own - this only reports it, for a caller whose surrounding copy
   * depends on whether the list is showing (MultiAssigneeSelect's flag note).
   */
  onOpenChange?: (open: boolean) => void;
  /**
   * Extra content on an option's ROW, after its label - never on the trigger.
   * `label` stays a plain string so filtering and the trigger read one value;
   * this is for a marker that describes a row without being part of its name,
   * e.g. MultiAssigneeSelect's advisory "No access" badge.
   */
  renderOptionSuffix?: (option: SelectFieldOption) => React.ReactNode;
}

const defaultSearchFields = (option: SelectFieldOption): string[] => [option.label];

export function Combobox({
  value,
  onValueChange,
  options,
  placeholder = 'Select...',
  disabled,
  className,
  id,
  size,
  tone = 'default',
  action,
  searchFields = defaultSearchFields,
  emptyText,
  onCreate,
  createLabel = DEFAULT_CREATE_LABEL,
  onOpenChange,
  renderOptionSuffix,
  ...rest
}: ComboboxProps) {
  const [open, setOpenState] = React.useState(false);
  /** Every open/close goes through here, so `onOpenChange` hears all of them. */
  const setOpen = (next: boolean) => {
    setOpenState(next);
    onOpenChange?.(next);
  };
  const [query, setQuery] = React.useState('');
  const [activeIndex, setActiveIndex] = React.useState(0);
  const reactId = React.useId();
  const listboxId = `${reactId}-listbox`;
  const optionId = (index: number) => `${reactId}-option-${index}`;

  // Portalled outside any surrounding Dialog's scroll lock, which would
  // otherwise swallow this list's wheel/touch events - see the hook.
  const attachScrollLockEscape = useScrollLockEscape();

  const selected = React.useMemo(
    () => options.find((o) => o.value === value) ?? null,
    [options, value]
  );

  /** Options the query actually matches. Drives the empty state and `onCreate`. */
  const matches = React.useMemo(() => {
    // Tidied like the create rule (ui-kit/lib/createQuery): extra or invisible spacing in the
    // query, or in a field, never hides an option.
    const q = tidyQuery(query).toLowerCase();
    if (!q) return options;
    return options.filter((o) =>
      searchFields(o).some((field) => tidyQuery(field ?? '').toLowerCase().includes(q))
    );
  }, [options, query, searchFields]);

  const tidiedQuery = tidyQuery(query);

  /**
   * What is rendered. §4.2: the current selection stays reachable even when the
   * query excludes it - the user must always be able to see what is chosen. It
   * is pinned at the top and is a real, navigable option row, but it is NOT
   * counted as a match, so a query that only "finds" the current selection is
   * still a no-match for the empty state and for where Enter lands.
   */
  const pinnedSelection = selected && !matches.includes(selected) ? selected : null;
  const rows = React.useMemo(
    () => (pinnedSelection ? [pinnedSelection, ...matches] : matches),
    [pinnedSelection, matches]
  );

  /**
   * Grouped rendering, under the same rule the select branch follows: `null`
   * unless some option actually carries a `group`, because a heading-less
   * wrapper is still a real `role="group"` node and would change the markup
   * every ungrouped call site emits today.
   *
   * Only groups with a surviving member render, so filtering takes a heading
   * away with its last row instead of stranding it over nothing.
   */
  const sections = React.useMemo(() => {
    if (!options.some((option) => option.group)) return null;
    const map = new Map<string, SelectFieldOption[]>();
    for (const option of rows) {
      const key = option.group ?? '';
      if (!map.has(key)) map.set(key, []);
      map.get(key)!.push(option);
    }
    let cursor = 0;
    return [...map.entries()].map(([group, items]) => ({
      group,
      items: items.map((option) => ({ option, index: cursor++ })),
    }));
  }, [options, rows]);

  /**
   * The keyboard's view of the list. When sections render it is the FLATTENED
   * grouped order, not `rows` - the arrow keys have to walk the sequence the
   * eye sees, and grouping reorders it.
   */
  const visible = React.useMemo(
    () => (sections ? sections.flatMap((s) => s.items.map((i) => i.option)) : rows),
    [sections, rows]
  );

  /**
   * The pinned action row sits one past the last option, on the keyboard and
   * in the DOM alike. It is NOT filtered: a query matching nothing must still
   * leave "+ Add new category…" reachable, which is the whole point of it.
   */
  const actionIndex = action ? visible.length : -1;
  // The create row is the last keyboard row, after the pinned action.
  const createIndex = onCreate ? visible.length + (action ? 1 : 0) : -1;
  const rowCount = visible.length + (action ? 1 : 0) + (onCreate ? 1 : 0);
  // Nothing (or only the pinned selection) matched: Enter should create, not re-pick it.
  const firstActiveIndex = onCreate && matches.length === 0 ? createIndex : 0;

  /**
   * The active row resets to the top whenever the query changes or the popover
   * re-opens. Done as a render-phase adjustment rather than an effect: an
   * effect would render the stale index once, then re-render - React's own
   * "you might not need an effect" case, and the repo's eslint rule forbids
   * setState inside an effect body outright.
   */
  const resetKey = `${open}:${query}`;
  const [seenResetKey, setSeenResetKey] = React.useState(resetKey);
  if (seenResetKey !== resetKey) {
    setSeenResetKey(resetKey);
    setActiveIndex(firstActiveIndex);
  }

  React.useEffect(() => {
    if (!open) return;
    const el = document.getElementById(optionId(activeIndex));
    el?.scrollIntoView?.({ block: 'nearest' });
    // optionId is derived from a stable useId, so it needs no dependency entry.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeIndex, open]);

  const commit = (option: SelectFieldOption) => {
    if (option.disabled) return;
    onValueChange(option.value);
    setOpen(false);
    setQuery('');
  };

  const runCreate = () => {
    onCreate?.(tidiedQuery);
    setOpen(false);
    setQuery('');
  };

  const runAction = () => {
    if (!action) return;
    // Deliberately NOT onValueChange: the action is not a value.
    action.onSelect();
    setOpen(false);
    setQuery('');
  };

  const step = (delta: number) => {
    if (rowCount === 0) return;
    setActiveIndex((current) => {
      let next = current;
      for (let i = 0; i < rowCount; i += 1) {
        next = (next + delta + rowCount) % rowCount;
        // No entry in `visible` means the pinned action or create row, which
        // have no disabled state of their own and are always navigable.
        const option = visible[next];
        if (!option || !option.disabled) return next;
      }
      return current;
    });
  };

  const handleKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      step(1);
      return;
    }
    if (event.key === 'ArrowUp') {
      event.preventDefault();
      step(-1);
      return;
    }
    if (event.key === 'Enter') {
      event.preventDefault();
      if (activeIndex === actionIndex) {
        runAction();
        return;
      }
      if (activeIndex === createIndex) {
        runCreate();
        return;
      }
      const option = visible[activeIndex];
      if (option) commit(option);
    }
    // Escape is deliberately NOT handled here - Radix's dismissable layer
    // closes the popover and restores focus to the trigger for us.
  };

  const noMatch = matches.length === 0;
  const trimmedQuery = query.trim();

  // A listbox option row (role="option"), not a Button-shaped control - same
  // treatment crm/AssigneeSelect.tsx already gives its own rows.
  const renderRow = (option: SelectFieldOption, index: number) => (
    <button
      key={option.value}
      id={optionId(index)}
      type="button"
      role="option"
      aria-selected={option.value === value}
      aria-disabled={option.disabled || undefined}
      onClick={() => commit(option)}
      onMouseEnter={() => setActiveIndex(index)}
      className={cn(
        'flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-sm',
        index === activeIndex && 'bg-background-light',
        option.value === value && 'bg-primary-subtle text-primary',
        option.disabled && 'pointer-events-none opacity-50',
        // Per-option class, last so it wins - the select branch hands it to
        // SelectItem in the same final position.
        option.className
      )}
    >
      <Check
        className={cn(
          'h-3.5 w-3.5 shrink-0',
          option.value === value ? 'opacity-100' : 'opacity-0'
        )}
      />
      <span className="line-clamp-1">{option.label}</span>
      {renderOptionSuffix?.(option)}
    </button>
  );

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) setQuery('');
      }}
    >
      <PopoverTrigger asChild>
        {/* Deliberately a raw <button>, not <Button>: this trigger has to be
            visually indistinguishable from SelectTrigger, which means wearing
            `selectTriggerVariants()` and nothing else. Button would layer its
            own height/padding/fill on top and the two branches of the 10-option
            rule would stop looking alike. */}
        <button
          id={id}
          type="button"
          role="combobox"
          aria-expanded={open}
          aria-haspopup="listbox"
          aria-label={rest['aria-label']}
          disabled={disabled}
          // Presence-only attribute: the shared trigger string already styles
          // `data-[placeholder]:text-text-secondary`.
          data-placeholder={selected ? undefined : ''}
          aria-describedby={rest['aria-describedby']}
          aria-invalid={rest['aria-invalid']}
          // The standard combobox pattern, and what the Radix Select branch
          // already does: an arrow key on the closed trigger opens the list.
          // Enter and Space open it through the button's own click.
          onKeyDown={(event) => {
            if (open || (event.key !== 'ArrowDown' && event.key !== 'ArrowUp')) return;
            event.preventDefault();
            setOpen(true);
          }}
          // Same three layers, in the same order, as SelectTrigger's own cn()
          // call - so the two branches stay identical by construction rather
          // than by vigilance, at every `size` and every `tone`.
          className={cn(
            selectTriggerVariants({ size }),
            (tone === 'sage' || tone === 'business') && 'border-sage-200 text-sage-700',
            className
          )}
        >
          <span>{selected ? selected.label : placeholder}</span>
          <ChevronDown className="h-4 w-4 opacity-50" />
        </button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        pad={0}
        /* Width policy copied from SelectContent, deliberately. Radix
           SelectContent is min-w-[8rem] plus min-w-[trigger-width] - both
           MINIMUMS, so the panel grows past a narrow trigger to fit its
           longest row. Pinning this popover to w-[trigger-width] instead
           would mean a control crossing the §4.2 threshold suddenly could
           not show its own option text: the tax-jurisdiction picker has a
           w-auto min-w-[110px] trigger and rows like "New Jersey
           (6.625%)". Capped at the available viewport width so a long
           label cannot run off-screen. */
        className="min-w-[var(--radix-popover-trigger-width)] max-w-[var(--radix-popover-content-available-width)] w-auto"
      >
        {/* Outside the scroll container below, so the field can never scroll
            out of view with the results (§4.2). */}
        <div className="border-b border-border p-1">
          <Input
            autoFocus
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Search…"
            aria-label="Search options"
            aria-controls={listboxId}
            // `activeIndex` may point at the pinned action row, which is a real
            // navigable option but is not in `visible` - hence the row count,
            // not a lookup in the options array.
            aria-activedescendant={activeIndex < rowCount ? optionId(activeIndex) : undefined}
            // Borderless/ringless by design - it blends into the popover's own
            // bordered wrapper. Input's `tone`/`invalid` only ever ADD a border
            // colour; no shipped prop expresses "no border, no ring".
            className="h-8 border-0 focus-visible:ring-0"
          />
        </div>
        {/* The listbox holds both the scrolling options and, below them, the fixed
            create row - so the row is announced as one of the choices while sitting
            outside the area that scrolls and filters. */}
        <div role="listbox" id={listboxId} aria-label={rest['aria-label']}>
          <div
            ref={attachScrollLockEscape}
            data-testid="combobox-options"
            className="max-h-60 overflow-y-auto overscroll-contain p-1"
          >
            {sections
              ? sections.map(({ group, items }) => (
                  <div key={group || '__ungrouped__'} role="group" aria-label={group || undefined}>
                    {group && (
                      // pl-7 (28px), NOT the select branch's pl-8: these rows
                      // indent by px-2 + a 3.5 check + gap-2 = 30px, and a
                      // heading has to line up with the rows underneath it,
                      // not with the other branch's.
                      <div aria-hidden="true" className="py-1.5 pl-7 pr-2 text-sm font-semibold">
                        {group}
                      </div>
                    )}
                    {items.map(({ option, index }) => renderRow(option, index))}
                  </div>
                ))
              : visible.map((option, index) => renderRow(option, index))}
            {action && (
              <>
                {action.separator && (
                  <div aria-hidden="true" className="-mx-1 my-1 h-px bg-background-light" />
                )}
                {/* role="option", the same shape the select branch gives it (a
                    SelectItem IS a role="option"), so the two branches expose
                    the row to the keyboard and to a screen reader alike. */}
                <button
                  id={optionId(actionIndex)}
                  type="button"
                  role="option"
                  aria-selected={false}
                  onClick={runAction}
                  onMouseEnter={() => setActiveIndex(actionIndex)}
                  className={cn(
                    'flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-sm',
                    actionIndex === activeIndex && 'bg-background-light'
                  )}
                >
                  {/* Holds the check column open so the action's label lines up
                      with the option labels above it - the select branch gets
                      that gutter for free from SelectItem's own pl-8. */}
                  <span aria-hidden="true" className="h-3.5 w-3.5 shrink-0" />
                  <span className="line-clamp-1">{action.label}</span>
                </button>
              </>
            )}
            {noMatch && (
              <div role="presentation" className="px-2 py-1.5 text-sm text-text-secondary">
                {typeof emptyText === 'function'
                  ? emptyText(tidiedQuery)
                  : (emptyText ?? `No results for "${trimmedQuery}"`)}
              </div>
            )}
          </div>
          {onCreate && (
            // Outside the scroll area above, so it never scrolls away and is never
            // filtered out (§4.2). A keyboard row like the options (role="option",
            // last in the arrow sequence, Enter activates it) - the kit picker's
            // create row is one too.
            <div className="border-t border-border p-1">
              <button
                id={optionId(createIndex)}
                type="button"
                role="option"
                aria-selected={false}
                onClick={runCreate}
                onMouseEnter={() => setActiveIndex(createIndex)}
                className={cn(
                  'flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-sm text-primary',
                  createIndex === activeIndex && 'bg-background-light'
                )}
              >
                <Plus className="h-3.5 w-3.5 shrink-0" />
                <span className="line-clamp-1">{createLabel}</span>
              </button>
            </div>
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}
