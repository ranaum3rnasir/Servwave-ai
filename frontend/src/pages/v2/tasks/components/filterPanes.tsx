import { useId, type ReactNode } from 'react';

import { cn } from '@/ui-kit/lib/utils';
import { Checkbox } from '@/ui-kit/components/ui/checkbox';
import { Label } from '@/ui-kit/components/ui/label';
import { DateField } from '@/ui-kit/components/form/dateField';
import { SelectField } from '@/ui-kit/components/form/selectField';
import { EN_DASH } from './glyphs';

/**
 * The Tasks filter panes the shared list filter (`pages/v2/_shared/filterPopover`) cannot draw from
 * a bare facet: the Category list with its colour dots and per-category counts, the Due / Created
 * pair of date fields, and the Member / Department single-select (the store holds one id and an
 * `'all'` sentinel, so a pick-one control and not a checkbox list). The window around them, the facet list, the phone sheet and
 * the Clear / Apply footer are the shared filter's; these are only what goes in a pane, handed to
 * it through `renderFacet`.
 */

export interface FilterOption {
  value: string;
  label: string;
}

/** One row of the Category facet: a task category, or `NO_CATEGORY_FILTER_VALUE` (color null). */
export interface CategoryFilterOption extends FilterOption {
  color: string | null;
  /** Tasks in the open tab's list that this row would show. */
  count: number;
}

const ROW_CLASS =
  'hover:bg-muted flex h-8 cursor-pointer items-center gap-2.5 rounded-md px-2 text-[13px] font-normal transition-colors';

/**
 * The Category facet: multi-select, one checkbox row per category with its color dot and task
 * count, then "No category". Ticking several shows tasks in ANY of them; none ticked shows all.
 * The count is drawn at the row's end and read out with the name ("Follow-up, 2 tasks") - an
 * explicit aria-label, because a name composed from the row's separate spans reads "Follow-up , 2".
 *
 * Exported for the Tasks filter bar, which mounts it through the shared filter's `renderFacet` with
 * its counts: a pane only renders while the window is open on it, so the counts are only taken then.
 */
export function CategoryFacet({
  options, selected, onChange,
}: {
  options: CategoryFilterOption[];
  selected: string[];
  onChange: (next: string[]) => void;
}) {
  const baseId = useId();
  const toggle = (value: string, on: boolean) =>
    onChange(on ? [...selected.filter((v) => v !== value), value] : selected.filter((v) => v !== value));
  return (
    <div className="flex min-h-0 flex-col gap-3">
      <PaneHeading>Category</PaneHeading>
      <div className="-mx-1.5 flex min-h-0 flex-col gap-0.5 overflow-y-auto overscroll-contain px-1.5">
        {options.map((o, i) => {
          const checked = selected.includes(o.value);
          return (
            <Label
              key={o.value}
              htmlFor={`${baseId}-${i}`}
              // A long name wraps rather than truncating: at phone width the pane is ~130px wide,
              // and a truncated name ("Part o...") cannot be told from its neighbours.
              className={cn(ROW_CLASS, 'h-auto min-h-8 py-1.5', checked && 'text-foreground font-medium')}
            >
              <Checkbox
                id={`${baseId}-${i}`}
                aria-label={`${o.label}, ${o.count} ${o.count === 1 ? 'task' : 'tasks'}`}
                checked={checked}
                onCheckedChange={(v) => toggle(o.value, v === true)}
              />
              {/* The category's own color is a persisted palette hex, not a theme token - the
                  same inline paint TaskCategoryChip uses. "No category" is a dashed ring. */}
              <span
                aria-hidden
                className={cn('h-2.5 w-2.5 shrink-0 rounded-full', !o.color && 'border-subtle-foreground border border-dashed')}
                style={o.color ? { backgroundColor: o.color } : undefined}
              />
              <span className="min-w-0 flex-1 break-words">{o.label}</span>
              <span aria-hidden className="text-muted-foreground tabular-nums">{o.count}</span>
            </Label>
          );
        })}
      </div>
    </div>
  );
}

/**
 * One date-range pane (heading over a pair), on `ui-kit/components/form/dateField` in mode="date" -
 * it stores two `YYYY-MM-DD` STRINGS straight into the zustand store, which is
 * exactly the string contract this field takes and returns. Keeps its
 * `"{label} from"` / `"{label} to"` aria-labels, which a vitest spec queries by.
 */
export function DateRangePane({
  label, from, to, onChange,
}: {
  label: string;
  from: string;
  to: string;
  onChange: (next: { from: string; to: string }) => void;
}) {
  return (
    <div className="flex flex-col gap-3">
      <PaneHeading>{label}</PaneHeading>
      <div className="flex items-center gap-2">
        <DateField
          aria-label={`${label} from`}
          value={from}
          max={to || undefined}
          onChange={(v) => onChange({ from: v, to })}
          className="min-w-0 flex-1"
        />
        <span className="text-subtle-foreground shrink-0">{EN_DASH}</span>
        <DateField
          aria-label={`${label} to`}
          value={to}
          min={from || undefined}
          onChange={(v) => onChange({ from, to: v })}
          className="min-w-0 flex-1"
        />
      </div>
    </div>
  );
}

/** The pane heading, matching `_shared/filterPopover`'s. */
function PaneHeading({ children }: { children: ReactNode }) {
  // role/aria-level rather than an <h3>: the raw-tag ratchet counts heading
  // elements outside the primitives, and the kit ships no Heading component.
  return (
    <span role="heading" aria-level={3} className="text-foreground text-[13px] font-semibold">
      {children}
    </span>
  );
}

/** A single-select facet pane: heading over one kit Select, with an "all" entry first. */
export function SelectFacet({
  label, value, onChange, allLabel, options,
}: {
  label: string;
  value: string;
  onChange: (next: string) => void;
  allLabel: string;
  options: FilterOption[];
}) {
  return (
    <div className="flex flex-col gap-3">
      <PaneHeading>{label}</PaneHeading>
      {/* Always downward, for the same reason the shared panel pins its date
          select: Radix flips a Select up near the viewport bottom, and inside a
          340px panel that detaches the menu from its own control. `position` is
          not passed - the kit's SelectContent already defaults to popper, and
          the combobox branch this control takes past ten options is a Popover,
          which is always popper-positioned. */}
      <SelectField
        value={value}
        onValueChange={onChange}
        aria-label={label}
        side="bottom"
        avoidCollisions={false}
        options={[{ value: 'all', label: allLabel }, ...options]}
      />
    </div>
  );
}
