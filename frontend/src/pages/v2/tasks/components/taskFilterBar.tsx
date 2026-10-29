import { useMemo } from 'react';

import { useTaskFilterStore } from '@/stores/taskFilterStore';
import { NO_CATEGORY_FILTER_VALUE, type TaskDrillDown } from '@/lib/tasks/tasks-logic';
import { useSelectedTaskCategoryIds, useTaskCategoryCounts } from '@/lib/tasks/useFilteredTasks';
import { useTaskListPage } from '@/lib/tasks/useTaskListPage';
import type { TaskViewKey } from '@/lib/tasks/taskViewRows';
import { useAssignableUsers } from '@/lib/api/users';
import { useDepartments } from '@/lib/api/departments';
import { useTaskCategories } from '@/lib/api/taskCategories';
import { NO_CATEGORY_LABEL } from '@/lib/tasks/taskCategoryDefaults';
import { formatDayLabel } from '@/lib/date-range';

import type { FacetConfig, FacetOption, FilterState, FilterValue } from '@/lib/filters/types';
import { FilterBar, type ActiveFilter } from '@/ui-kit/components/crm/filterBar';

import { FilterPopover } from '../../_shared/filterPopover';
import {
  CategoryFacet, DateRangePane, SelectFacet, type CategoryFilterOption, type FilterOption,
} from './filterPanes';

const CATEGORY_LABEL: Record<Exclude<TaskDrillDown, 'all'>, string> = {
  open: 'Open',
  atRisk: 'At Risk',
  onTime: 'On-Time',
  blocked: 'Blocked',
};

function dateChipText(from: string, to: string): string {
  if (from && to) return `${formatDayLabel(from)} - ${formatDayLabel(to)}`;
  if (from) return `From ${formatDayLabel(from)}`;
  return `Until ${formatDayLabel(to)}`;
}

function labelFor(options: FilterOption[], value: string): string {
  return options.find((o) => o.value === value)?.label ?? value;
}

/**
 * The Tasks filter as the shared list filter's facets, in the order the window lists them.
 *
 * The store is not a `FilterState`: Member and Department hold ONE id with an `'all'` sentinel,
 * the flags are two booleans, and nothing is URL-bound. So this module owns the two translations
 * (`filterState` / `applyFilterState` in `useTaskFilterModel`) and the shared filter only ever sees
 * facets. Member and Department are one-value `multi` facets here, drawn by the pick-one pane in
 * `renderFacet`; their options come from the page's own lists.
 */
const TASK_FILTER_REGISTRY: FacetConfig[] = [
  { key: 'member', label: 'Member', icon: '', kind: 'multi', param: 'member', optionSource: 'members' },
  { key: 'department', label: 'Department', icon: '', kind: 'multi', param: 'department', optionSource: 'departments' },
  { key: 'category', label: 'Category', icon: '', kind: 'multi', param: 'category', optionSource: 'categories' },
  { key: 'due', label: 'Due', icon: '', kind: 'dateRange', param: 'due' },
  { key: 'created', label: 'Created', icon: '', kind: 'dateRange', param: 'created' },
  {
    key: 'flags', label: 'Only show', icon: '', kind: 'multi', param: 'flags',
    options: [{ value: 'overdue', label: 'Overdue' }, { value: 'atRisk', label: 'At risk' }],
  },
];

const multiValues = (v: FilterValue | undefined): string[] => (v?.kind === 'multi' ? v.values : []);
const dateValues = (v: FilterValue | undefined) =>
  (v?.kind === 'dateRange' ? { from: v.from, to: v.to } : { from: '', to: '' });

/**
 * The Tasks filter toolbar, in two halves that render in two places.
 *
 * The six controls used to sit in an always-visible grid inside a bordered card
 * that also held an AI command bar. The command bar is gone and the grid moved
 * into a filter WINDOW (`./filterPopover`), so what was left was a toolbar row:
 * the Filter trigger, and one removable chip per active constraint.
 *
 * That row then held a full line of its own ABOVE the tabs to carry a single
 * button, and pushed every view down the screen for it. So the halves split:
 * the trigger rides the tab strip's right slot, and the chips render under the
 * strip and only when there ARE chips. With no filters active the hub costs
 * nothing between the page header and the view.
 *
 * The chips are the reason a window is safe. A closed panel is the most common
 * way a CRM lies to someone - a stale member filter, and they swear a task has
 * vanished - so every active constraint stays visible and individually
 * removable OUTSIDE the popover, each naming its own field. That is exactly
 * what the kit's `crm/FilterBar` renders, and it is the primitive
 * `_shared/appliedFilters` is itself built on; the `_shared` wrapper is not
 * reused directly because it is registry-driven (`FacetConfig[]` +
 * `FilterState`) and the Tasks filter is a plain zustand store - the same
 * mismatch that made the popover a module-local fork. Sitting on the kit
 * primitive instead of forking the wrapper keeps the chips identical to the
 * ones Leads shows without an adapter in between.
 *
 * Every control still writes `stores/taskFilterStore`, which is module-level,
 * so a filter survives a tab switch. All six views read it through
 * `useFilteredTasks`, so this toolbar scopes every tab - unchanged.
 *
 * The Category facet lists the org's task categories (the shared
 * `taskCategoryKeys.all` list, in the admin's order) and then "No category";
 * the selection is read through that list, so a category deleted while ticked
 * drops out of the filter, the count and the chip together.
 */
function useTaskFilterModel() {
  const {
    memberId, departmentId, category, overdue, atRisk,
    dueFrom, dueTo, createdFrom, createdTo,
    setMember, setDepartment, setCategoryIds, setCategory, setOverdue, setAtRisk,
    setDueRange, setCreatedRange, reset,
  } = useTaskFilterStore();

  const { data: categories = [] } = useTaskCategories();
  const selectedCategoryIds = useSelectedTaskCategoryIds();
  // `directory`, not `task`: this is the FILTER bar's "Assignee" facet - it narrows a list the
  // caller is already allowed to read and writes nothing. The task ASSIGNEE pickers keep
  // `task` (that is what #1950 is about); a filter dropdown is a directory read.
  const { data: people = [] } = useAssignableUsers({ purpose: 'directory', eligibleFor: 'task' });
  const { data: departments = [] } = useDepartments();

  // Resolved here rather than inside the popover so the menu and the chip that
  // reports it read off ONE list - a chip that falls back to a raw uuid is the
  // classic symptom of two option sources drifting apart.
  const memberOptions = useMemo<FilterOption[]>(
    () => people.map((p) => ({ value: p.id, label: `${p.first_name} ${p.last_name}` })),
    [people],
  );
  const departmentOptions = useMemo<FilterOption[]>(
    () => departments.map((d) => ({ value: d.id, label: d.name })),
    [departments],
  );
  const categoryOptions = useMemo<Omit<CategoryFilterOption, 'count'>[]>(
    () => [
      ...categories.map((c) => ({ value: c.id, label: c.name, color: c.color })),
      { value: NO_CATEGORY_FILTER_VALUE, label: NO_CATEGORY_LABEL, color: null },
    ],
    [categories],
  );

  const activeCategory = category ?? 'all';

  const chips: ActiveFilter[] = [];
  if (memberId !== 'all') {
    chips.push({ id: 'member', label: 'Member', value: labelFor(memberOptions, memberId) });
  }
  if (departmentId !== 'all') {
    chips.push({ id: 'department', label: 'Department', value: labelFor(departmentOptions, departmentId) });
  }
  // One chip for the facet, naming every ticked category in the list's order.
  if (selectedCategoryIds.length > 0) {
    const names = categoryOptions.filter((o) => selectedCategoryIds.includes(o.value)).map((o) => o.label);
    chips.push({ id: 'categories', label: 'Category', value: names.join(', ') });
  }
  if (dueFrom || dueTo) {
    chips.push({ id: 'due', label: 'Due', value: dateChipText(dueFrom, dueTo) });
  }
  if (createdFrom || createdTo) {
    chips.push({ id: 'created', label: 'Created', value: dateChipText(createdFrom, createdTo) });
  }
  if (overdue) chips.push({ id: 'overdue', label: 'Only show', value: 'Overdue' });
  if (atRisk) chips.push({ id: 'atRisk', label: 'Only show', value: 'At risk' });
  // The drill-down set by clicking a Dashboard KPI card. It is a chip like any
  // other so it can be dropped without going back to the Dashboard for it.
  // Labelled for where it came from: "Category" now names the task-category facet.
  if (activeCategory !== 'all') {
    chips.push({ id: 'category', label: 'Dashboard', value: CATEGORY_LABEL[activeCategory] });
  }

  const remove = (id: string) => {
    switch (id) {
      case 'member': setMember('all'); break;
      case 'department': setDepartment('all'); break;
      case 'categories': setCategoryIds([]); break;
      case 'due': setDueRange({ from: '', to: '' }); break;
      case 'created': setCreatedRange({ from: '', to: '' }); break;
      case 'overdue': setOverdue(false); break;
      case 'atRisk': setAtRisk(false); break;
      case 'category': setCategory('all'); break;
    }
  };

  // The store, read as the shared filter's value. Only an active facet has a key.
  const filterState = useMemo<FilterState>(() => {
    const next: FilterState = {};
    if (memberId !== 'all') next.member = { kind: 'multi', values: [memberId] };
    if (departmentId !== 'all') next.department = { kind: 'multi', values: [departmentId] };
    if (selectedCategoryIds.length > 0) next.category = { kind: 'multi', values: selectedCategoryIds };
    if (dueFrom || dueTo) next.due = { kind: 'dateRange', from: dueFrom, to: dueTo };
    if (createdFrom || createdTo) next.created = { kind: 'dateRange', from: createdFrom, to: createdTo };
    const flags = [overdue && 'overdue', atRisk && 'atRisk'].filter((f): f is string => Boolean(f));
    if (flags.length > 0) next.flags = { kind: 'multi', values: flags };
    return next;
  }, [memberId, departmentId, selectedCategoryIds, dueFrom, dueTo, createdFrom, createdTo, overdue, atRisk]);

  // The shared filter's value, written back: every facet is set from it, an absent one to its
  // inactive value. The drill-down is not a facet and is left alone (only the store's own
  // clear-all drops it).
  //
  // Absolute writes, never a diff against the values this render captured: the window's Clear runs
  // `reset()` first and then this, so a draft equal to the pre-Clear value would otherwise look
  // "unchanged", no setter would run, and the reset would silently win over the re-picked value.
  const applyFilterState = (next: FilterState) => {
    setMember(multiValues(next.member)[0] ?? 'all');
    setDepartment(multiValues(next.department)[0] ?? 'all');
    setCategoryIds(multiValues(next.category));
    setDueRange(dateValues(next.due));
    setCreatedRange(dateValues(next.created));
    const flags = multiValues(next.flags);
    setOverdue(flags.includes('overdue'));
    setAtRisk(flags.includes('atRisk'));
  };

  return {
    memberOptions, departmentOptions, categoryOptions, selectedCategoryIds, setCategoryIds,
    chips, remove, reset, filterState, applyFilterState, hasDrillDown: activeCategory !== 'all',
  };
}

/**
 * The Category pane with its per-category counts. Mounted only while the Filter window is open on
 * it, so the counts - the hub filter plus the open tab's own rows - are never taken for a trigger
 * nobody has opened (it is on every tab, all the time).
 */
function CountedCategoryFacet({
  view, options, selected, onChange,
}: {
  view: TaskViewKey;
  options: Omit<CategoryFilterOption, 'count'>[];
  selected: string[];
  onChange: (next: string[]) => void;
}) {
  // The List holds one server page, not every task, so its counts come from the server (taken with
  // every other facet applied and Category left open, exactly as below). Every other tab still
  // counts the full list it holds.
  return view === 'list'
    ? <ListCountedCategoryFacet options={options} selected={selected} onChange={onChange} />
    : <ViewCountedCategoryFacet view={view} options={options} selected={selected} onChange={onChange} />;
}

type CountedFacetProps = {
  options: Omit<CategoryFilterOption, 'count'>[];
  selected: string[];
  onChange: (next: string[]) => void;
};

function ViewCountedCategoryFacet({ view, options, selected, onChange }: CountedFacetProps & { view: TaskViewKey }) {
  const counts = useTaskCategoryCounts(view);
  const counted = useMemo<CategoryFilterOption[]>(
    () => options.map((o) => ({ ...o, count: counts.get(o.value) ?? 0 })),
    [options, counts],
  );
  return <CategoryFacet options={counted} selected={selected} onChange={onChange} />;
}

function ListCountedCategoryFacet({ options, selected, onChange }: CountedFacetProps) {
  // The same cached query the List tab renders from, so opening the window costs no request.
  const { categoryCounts } = useTaskListPage();
  const counted = useMemo<CategoryFilterOption[]>(
    () => options.map((o) => ({ ...o, count: categoryCounts.get(o.value) ?? 0 })),
    [options, categoryCounts],
  );
  return <CategoryFacet options={counted} selected={selected} onChange={onChange} />;
}

/**
 * The Filter trigger alone, for the tab strip's right slot.
 *
 * Both halves call `useTaskFilterModel`, and two instances cannot drift: the
 * options come from the same react-query caches and the constraints from
 * the same module-level zustand store, so they are two readers of one state.
 *
 * `view` is the open tab, so each Category count is exactly the rows ticking
 * that category then shows there (see `useTaskCategoryCounts`).
 */
export function TaskFilterTrigger({ view }: { view: TaskViewKey }) {
  const {
    memberOptions, departmentOptions, categoryOptions, reset, filterState, applyFilterState, hasDrillDown,
  } = useTaskFilterModel();

  const resolveOptions = (sourceId: string): FacetOption[] => {
    if (sourceId === 'members') return memberOptions;
    if (sourceId === 'departments') return departmentOptions;
    return [];
  };

  // Every pane but "Only show" is the Tasks pane it always was. Handed over as elements, so a
  // pane's work (the Category counts) runs only while the window is open on it, never for the
  // trigger.
  const renderFacet = (
    facet: FacetConfig,
    ctx: { value: FilterValue | undefined; onChange: (next: FilterValue) => void },
  ) => {
    if (facet.key === 'member' || facet.key === 'department') {
      const isMember = facet.key === 'member';
      return (
        <SelectFacet
          label={facet.label}
          value={multiValues(ctx.value)[0] ?? 'all'}
          onChange={(next) => ctx.onChange({ kind: 'multi', values: next === 'all' ? [] : [next] })}
          allLabel={isMember ? 'Everybody' : 'All departments'}
          options={isMember ? memberOptions : departmentOptions}
        />
      );
    }
    if (facet.key === 'category') {
      return (
        <CountedCategoryFacet
          view={view}
          options={categoryOptions}
          selected={multiValues(ctx.value)}
          onChange={(values) => ctx.onChange({ kind: 'multi', values })}
        />
      );
    }
    if (facet.key === 'due' || facet.key === 'created') {
      const range = dateValues(ctx.value);
      return (
        <DateRangePane
          label={facet.label}
          from={range.from}
          to={range.to}
          onChange={({ from, to }) => ctx.onChange({ kind: 'dateRange', from, to })}
        />
      );
    }
    return undefined;
  };

  return (
    <FilterPopover
      registry={TASK_FILTER_REGISTRY}
      value={filterState}
      onChange={applyFilterState}
      resolveOptions={resolveOptions}
      renderFacet={renderFacet}
      // Clear all is the store's own, so it drops the Dashboard drill-down too.
      onClearAll={reset}
      hasExtraConstraint={hasDrillDown}
    />
  );
}

/**
 * The active constraints, under the strip. Renders nothing when there are none
 * - an empty chip rail is exactly the blank band this split exists to remove.
 */
export function TaskFilterChips() {
  const { chips, remove, reset } = useTaskFilterModel();
  if (chips.length === 0) return null;
  // `gap-0`: FilterBar stacks a controls row over the chips row, and this half
  // passes no controls, so the gap would be measured against an empty div.
  return <FilterBar className="mt-3 gap-0" filters={chips} onRemove={remove} onClearAll={reset} />;
}
