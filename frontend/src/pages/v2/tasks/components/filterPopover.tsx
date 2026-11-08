import { useId, useState, type ReactNode } from 'react';
import { ListFilter } from 'lucide-react';

import { useTaskFilterStore } from '@/stores/taskFilterStore';

import { cn } from '@/ui-kit/lib/utils';
import { Badge } from '@/ui-kit/components/ui/badge';
import { Button } from '@/ui-kit/components/ui/button';
import { Checkbox } from '@/ui-kit/components/ui/checkbox';
import { Label } from '@/ui-kit/components/ui/label';
import { Popover, PopoverContent, PopoverTrigger } from '@/ui-kit/components/ui/popover';
import { SelectField } from '@/ui-kit/components/form/selectField';

import { DatePicker } from '../../_shared/datePicker';
import { EN_DASH } from './glyphs';

/**
 * The Tasks filter window - a MODULE-LOCAL fork of `_shared/filterPopover`.
 *
 * WHY A FORK, not the shared component. `_shared/FilterPopover` is
 * registry-driven: it takes a `FacetConfig[]` and edits a `FilterState` whose
 * only value kinds are `multi`, `range` and `dateRange`, and its "Clear all"
 * is `onChange({})` against a URL-bound `useFilterState`. The Tasks filter is
 * none of that. It is mostly single-select-per-dimension with an `'all'` sentinel
 * (there is no `single` FilterValue kind), its Category facet counts and
 * offers a "No category" entry, it carries two BOOLEAN flags (there
 * is no boolean kind either), it lives in a plain module-level zustand store
 * with no URL codec, and it holds a drill-down `category` that the Dashboard
 * KPI cards write directly. Mapping that onto `FacetConfig` would need a lossy
 * adapter in both directions plus a branch per kind inside the shared file -
 * exactly what `_shared/README.md` ("What is deliberately still duplicated")
 * says to fork instead, as jobs, estimates and inventory already do.
 *
 * WHAT IS REUSED: the chrome, verbatim - the outline trigger with a
 * `ListFilter` icon and a count `Badge`, the 640px `PopoverContent`, the header
 * with the count and "Clear all", the `grid h-[340px] grid-cols-[188px_1fr]` (120px below `sm`)
 * facet rail (`role="tablist"`, one `role="tab"` per facet, the left brand
 * rail on the active one), and the footer summary with a `Done` button. Same
 * kit primitives, same class strings, so the two panels are the same object to
 * a user even though their models cannot be one.
 *
 * The store contract is UNTOUCHED: every control below writes the same setter
 * the always-visible bar used to, so all six views keep filtering through
 * `useFilteredTasks` exactly as before.
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

type FacetKey = 'member' | 'department' | 'category' | 'due' | 'created' | 'flags';

const ROW_CLASS =
  'hover:bg-muted flex h-8 cursor-pointer items-center gap-2.5 rounded-md px-2 text-[13px] font-normal transition-colors';

/**
 * The Category facet: multi-select, one checkbox row per category with its color dot and task
 * count, then "No category". Ticking several shows tasks in ANY of them; none ticked shows all.
 * The count is drawn at the row's end and read out with the name ("Follow-up, 2 tasks") - an
 * explicit aria-label, because a name composed from the row's separate spans reads "Follow-up , 2".
 *
 * Exported for the Tasks filter bar, which mounts it as the popover's `categoryPane` with its
 * counts: a pane only renders while the window is open on it, so the counts are only taken then.
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
      <div className="-mx-1.5 flex min-h-0 flex-col gap-0.5 overflow-y-auto px-1.5">
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
 * One date-range pair, on `_shared/datePicker` - the kit's own `form/datePicker`
 * still cannot stand in (it emits a `Date`, while this filter stores two
 * `YYYY-MM-DD` STRINGS straight into the zustand store), but the shared picker
 * takes and returns exactly those strings. Keeps its `"{label} from"` /
 * `"{label} to"` aria-labels, which a vitest spec queries by.
 */
function DateRange({
  label, from, to, onChange,
}: {
  label: string;
  from: string;
  to: string;
  onChange: (next: { from: string; to: string }) => void;
}) {
  return (
    <div className="flex items-center gap-2">
      <DatePicker
        aria-label={`${label} from`}
        value={from}
        max={to || undefined}
        onChange={(v) => onChange({ from: v, to })}
        className="min-w-0 flex-1"
      />
      <span className="text-subtle-foreground shrink-0">{EN_DASH}</span>
      <DatePicker
        aria-label={`${label} to`}
        value={to}
        min={from || undefined}
        onChange={(v) => onChange({ from, to: v })}
        className="min-w-0 flex-1"
      />
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

/** A single-select facet pane: heading over one kit Select. */
function SelectFacet({
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

export function TaskFilterPopover({
  members, departments, selectedCategoryIds, categoryPane,
}: {
  members: FilterOption[];
  departments: FilterOption[];
  /** The live selection - ids of deleted categories already dropped (see taskFilterBar). */
  selectedCategoryIds: string[];
  /**
   * The Category pane (a `CategoryFacet` with its counts). Passed as an element so whatever it
   * computes runs only while the window is open on that pane, never for the always-mounted trigger.
   */
  categoryPane: ReactNode;
}) {
  const {
    memberId, departmentId, category, overdue, atRisk,
    dueFrom, dueTo, createdFrom, createdTo,
    setMember, setDepartment, setOverdue, setAtRisk,
    setDueRange, setCreatedRange, reset,
  } = useTaskFilterStore();

  const [open, setOpen] = useState(false);
  const [selectedKey, setSelectedKey] = useState<FacetKey>('member');
  const flagId = useId();

  const counts: Record<FacetKey, number> = {
    member: memberId === 'all' ? 0 : 1,
    department: departmentId === 'all' ? 0 : 1,
    category: selectedCategoryIds.length,
    due: dueFrom || dueTo ? 1 : 0,
    created: createdFrom || createdTo ? 1 : 0,
    flags: (overdue ? 1 : 0) + (atRisk ? 1 : 0),
  };

  const facets: { key: FacetKey; label: string }[] = [
    { key: 'member', label: 'Member' },
    { key: 'department', label: 'Department' },
    { key: 'category', label: 'Category' },
    { key: 'due', label: 'Due' },
    { key: 'created', label: 'Created' },
    { key: 'flags', label: 'Only show' },
  ];

  const totalSelected = facets.reduce((sum, f) => sum + counts[f.key], 0);
  const activeFacetCount = facets.filter((f) => counts[f.key] > 0).length;

  // The drill-down `category` (the Dashboard KPI cards' Open / At Risk / ...,
  // not the Category facet above) is deliberately NOT a facet in here: nothing
  // sets it from this panel, only the Dashboard KPI cards do, and it is surfaced
  // outside as its own removable chip. "Clear all" still calls the store's
  // `reset`, so it clears the drill-down too.
  const canClear = totalSelected > 0 || (category ?? 'all') !== 'all';

  function renderPane(key: FacetKey) {
    switch (key) {
      case 'member':
        return (
          <SelectFacet
            label="Member" value={memberId} onChange={setMember}
            allLabel="Everybody" options={members}
          />
        );
      case 'department':
        return (
          <SelectFacet
            label="Department" value={departmentId} onChange={setDepartment}
            allLabel="All departments" options={departments}
          />
        );
      case 'category':
        return categoryPane;
      case 'due':
        return (
          <div className="flex flex-col gap-3">
            <PaneHeading>Due</PaneHeading>
            <DateRange label="Due" from={dueFrom} to={dueTo} onChange={setDueRange} />
          </div>
        );
      case 'created':
        return (
          <div className="flex flex-col gap-3">
            <PaneHeading>Created</PaneHeading>
            <DateRange label="Created" from={createdFrom} to={createdTo} onChange={setCreatedRange} />
          </div>
        );
      case 'flags':
        return (
          <div className="flex flex-col gap-3">
            <PaneHeading>Only show</PaneHeading>
            <div className="-mx-1.5 flex flex-col gap-0.5 px-1.5">
              {/* Row-as-label, the same hit target the shared checkbox facet
                  uses: a filter list is scanned and clicked quickly, and making
                  people aim at a 16px box costs more than it saves. */}
              <Label
                htmlFor={`${flagId}-overdue`}
                className={cn(
                  ROW_CLASS,
                  overdue && 'text-foreground font-medium',
                )}
              >
                <Checkbox
                  id={`${flagId}-overdue`}
                  checked={overdue}
                  onCheckedChange={(v) => setOverdue(v === true)}
                />
                Overdue
              </Label>
              <Label
                htmlFor={`${flagId}-at-risk`}
                className={cn(
                  ROW_CLASS,
                  atRisk && 'text-foreground font-medium',
                )}
              >
                <Checkbox
                  id={`${flagId}-at-risk`}
                  checked={atRisk}
                  onCheckedChange={(v) => setAtRisk(v === true)}
                />
                At risk
              </Label>
            </div>
          </div>
        );
      default:
        return null;
    }
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button variant="outline" size="sm" aria-expanded={open}>
          <ListFilter />
          Filter
          {totalSelected > 0 && <Badge variant="softBlue" size="pill">{totalSelected}</Badge>}
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        className="flex max-h-[calc(100vh-2rem)] w-[640px] max-w-[94vw] flex-col overflow-hidden p-0"
      >
        <div className="flex shrink-0 items-center justify-between gap-3 border-b px-4 py-3">
          <div className="flex items-center gap-2">
            <span className="text-[13px] font-semibold">Filters</span>
            {totalSelected > 0 && (
              <Badge variant="softBlue" size="pill">{totalSelected}</Badge>
            )}
          </div>
          {canClear && (
            <Button
              variant="ghost"
              size="sm"
              className="h-auto px-1.5 py-0.5 text-xs font-medium"
              onClick={reset}
            >
              Clear all
            </Button>
          )}
        </div>

        {/* A fixed height, not a min-height, so the Done button never moves as
            you switch between a two-input pane and a two-checkbox one. */}
        {/* A narrower facet rail below `sm`: at phone width the 188px rail left the pane about 130px,
            too little for a category name to fit on a line. */}
        <div className="grid h-[340px] flex-1 grid-cols-[120px_1fr] overflow-hidden sm:grid-cols-[188px_1fr]">
          <div role="tablist" aria-label="Filter facets" className="flex flex-col gap-0.5 overflow-y-auto border-r p-2">
            {facets.map((facet) => {
              const active = facet.key === selectedKey;
              return (
                <Button
                  key={facet.key}
                  variant="ghost"
                  size="sm"
                  role="tab"
                  aria-selected={active}
                  onClick={() => setSelectedKey(facet.key)}
                  className={cn(
                    'relative flex h-8 w-full items-center justify-between gap-2 rounded-md px-2.5 text-left text-[13px] font-normal transition-colors',
                    active
                      ? 'before:bg-brand text-foreground bg-brand-subtle font-semibold before:absolute before:top-1.5 before:bottom-1.5 before:left-0 before:w-[3px] before:rounded-r-full before:content-[""]'
                      : 'text-muted-foreground hover:bg-muted hover:text-foreground',
                  )}
                >
                  <span className="truncate">{facet.label}</span>
                  {counts[facet.key] > 0 && (
                    <Badge variant="softBlue" size="pill">{counts[facet.key]}</Badge>
                  )}
                </Button>
              );
            })}
          </div>
          <div className="flex min-w-0 flex-col overflow-hidden p-4">
            {renderPane(selectedKey)}
          </div>
        </div>

        <div className="flex shrink-0 items-center justify-between gap-3 border-t px-4 py-2.5">
          <span className="text-muted-foreground text-xs">
            {totalSelected === 0
              ? 'No filters applied'
              : `${totalSelected} selected across ${activeFacetCount} ${activeFacetCount === 1 ? 'filter' : 'filters'}`}
          </span>
          <Button size="sm" onClick={() => setOpen(false)}>Done</Button>
        </div>
      </PopoverContent>
    </Popover>
  );
}
