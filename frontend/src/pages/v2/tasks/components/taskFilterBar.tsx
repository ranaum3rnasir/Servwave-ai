import { useMemo } from 'react';

import { useTaskFilterStore } from '@/stores/taskFilterStore';
import { NO_CATEGORY_FILTER_VALUE, type TaskDrillDown } from '@/lib/tasks/tasks-logic';
import { useSelectedTaskCategoryIds, useTaskCategoryCounts } from '@/lib/tasks/useFilteredTasks';
import type { TaskViewKey } from '@/lib/tasks/taskViewRows';
import { useAssignableUsers } from '@/lib/api/users';
import { useDepartments } from '@/lib/api/departments';
import { useTaskCategories } from '@/lib/api/taskCategories';
import { NO_CATEGORY_LABEL } from '@/lib/tasks/taskCategoryDefaults';
import { formatDayLabel } from '@/lib/date-range';

import { FilterBar, type ActiveFilter } from '@/ui-kit/components/crm/filterBar';

import { CategoryFacet, TaskFilterPopover, type CategoryFilterOption, type FilterOption } from './filterPopover';

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

  return {
    memberOptions, departmentOptions, categoryOptions, selectedCategoryIds, setCategoryIds,
    chips, remove, reset,
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
  const counts = useTaskCategoryCounts(view);
  const counted = useMemo<CategoryFilterOption[]>(
    () => options.map((o) => ({ ...o, count: counts.get(o.value) ?? 0 })),
    [options, counts],
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
    memberOptions, departmentOptions, categoryOptions, selectedCategoryIds, setCategoryIds,
  } = useTaskFilterModel();
  return (
    <TaskFilterPopover
      members={memberOptions}
      departments={departmentOptions}
      selectedCategoryIds={selectedCategoryIds}
      categoryPane={
        <CountedCategoryFacet
          view={view}
          options={categoryOptions}
          selected={selectedCategoryIds}
          onChange={setCategoryIds}
        />
      }
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
