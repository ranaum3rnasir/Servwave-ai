/**
 * ActivityFilterBar — the global "big filter" for the Activity report.
 *
 * Sits under the header on every zoom level. Four facets (Division, Person,
 * Role, Date range) narrow the underlying person set; every KPI / table / drill
 * recomputes from the filtered set. Active selections show as removable chips.
 *
 * Mock-first note: the Date range facet is fully interactive but does not yet
 * narrow the snapshot data — it is wired for the future backend aggregation.
 */
import { ChevronDown, ListFilter, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { FilterChip } from '@/components/data/filter-chip';
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuCheckboxItem,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
} from '@/components/ui/dropdown-menu';
import type { Division, UserActivity } from '@/lib/reports/activity-logic';
import { type Filters, DEFAULT_DATE_RANGE, allRoles, activeFilterCount } from '@/lib/reports/activity-logic';

const DATE_PRESETS = ['Today', 'Last 7 days', 'Last 30 days', 'This month', 'Last month', 'Year to date'];

interface Props {
  filters: Filters;
  onChange: (next: Filters) => void;
  divisions: Division[];
  users: UserActivity[];
}

/** A single multi-select facet rendered as a dropdown of checkboxes. */
function MultiFacet({
  label,
  options,
  selected,
  onToggle,
}: {
  label: string;
  options: { value: string; label: string }[];
  selected: string[];
  onToggle: (value: string) => void;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="outline" size="sm" className="gap-1.5">
          {label}
          {selected.length > 0 && (
            <span className="rounded-full bg-primary px-1.5 py-0.5 text-[10px] font-semibold leading-none text-on-fill">
              {selected.length}
            </span>
          )}
          <ChevronDown className="h-3.5 w-3.5 text-text-secondary" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="max-h-72 w-56 overflow-y-auto">
        <DropdownMenuLabel>{label}</DropdownMenuLabel>
        <DropdownMenuSeparator />
        {options.map((o) => (
          <DropdownMenuCheckboxItem
            key={o.value}
            checked={selected.includes(o.value)}
            onCheckedChange={() => onToggle(o.value)}
            onSelect={(e) => e.preventDefault()}
          >
            {o.label}
          </DropdownMenuCheckboxItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export function ActivityFilterBar({ filters, onChange, divisions, users }: Props) {
  // Cascading options: Role is scoped to the selected divisions; Person to the
  // selected divisions AND roles — so you can only pick combinations that exist.
  const inDiv = (u: UserActivity) => !filters.divisionIds.length || filters.divisionIds.includes(u.divisionId);
  const roleScopeUsers = users.filter(inDiv);
  const roles = allRoles(roleScopeUsers);
  const personOptions = users.filter((u) => inDiv(u) && (!filters.roles.length || filters.roles.includes(u.role)));
  const count = activeFilterCount(filters);

  const toggle = (key: 'divisionIds' | 'userIds' | 'roles') => (value: string) => {
    const cur = filters[key];
    const next = cur.includes(value) ? cur.filter((v) => v !== value) : [...cur, value];
    onChange({ ...filters, [key]: next });
  };

  const clearAll = () =>
    onChange({ divisionIds: [], userIds: [], roles: [], dateRange: DEFAULT_DATE_RANGE });

  const divName = (id: string) => divisions.find((d) => d.id === id)?.name ?? id;
  const userName = (id: string) => users.find((u) => u.id === id)?.name ?? id;

  return (
    <div className="rounded-xl border border-border bg-surface-light p-3 shadow-card">
      <div className="flex flex-wrap items-center gap-2">
        <span className="mr-1 flex items-center gap-1.5 text-xs font-medium text-text-secondary">
          <ListFilter className="h-4 w-4" />
          Filters
          {count > 0 && (
            <span className="rounded-full bg-primary px-1.5 py-0.5 text-[10px] font-semibold leading-none text-on-fill">
              {count}
            </span>
          )}
        </span>

        <MultiFacet
          label="Division"
          options={divisions.map((d) => ({ value: d.id, label: `${d.icon} ${d.name}` }))}
          selected={filters.divisionIds}
          onToggle={toggle('divisionIds')}
        />
        <MultiFacet
          label="Person"
          options={personOptions.map((u) => ({ value: u.id, label: u.name }))}
          selected={filters.userIds}
          onToggle={toggle('userIds')}
        />
        <MultiFacet
          label="Role"
          options={roles.map((r) => ({ value: r, label: r }))}
          selected={filters.roles}
          onToggle={toggle('roles')}
        />

        {/* Date range — single-select preset */}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="outline" size="sm" className="gap-1.5">
              {filters.dateRange}
              <ChevronDown className="h-3.5 w-3.5 text-text-secondary" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="w-48">
            <DropdownMenuLabel>Date range</DropdownMenuLabel>
            <DropdownMenuSeparator />
            <DropdownMenuRadioGroup
              value={filters.dateRange}
              onValueChange={(v) => onChange({ ...filters, dateRange: v })}
            >
              {DATE_PRESETS.map((p) => (
                <DropdownMenuRadioItem key={p} value={p}>
                  {p}
                </DropdownMenuRadioItem>
              ))}
            </DropdownMenuRadioGroup>
          </DropdownMenuContent>
        </DropdownMenu>

        {count > 0 && (
          // ghost/subtle matches the idle text-text-secondary and hover:text-text-primary
          // exactly. Three disclosed deltas: ghost/subtle also adds hover:bg-background-light,
          // a hover highlight the raw button never had; the primitive's base font-semibold
          // replaces the raw's font-medium; and the raw's rounded-lg (6px) becomes the
          // primitive's own rounded-button (--radius-button, 14px). size="3xs" (h-6/px-2/
          // text-xs) is the closest rung to the raw's unset height (py-1/text-xs, ~24px).
          <Button
            type="button"
            variant="ghost"
            tone="subtle"
            size="3xs"
            onClick={clearAll}
            className="ml-auto gap-1"
          >
            <X className="h-3.5 w-3.5" />
            Clear all
          </Button>
        )}
      </div>

      {/* Active filter chips */}
      {count > 0 && (
        <div className="mt-2.5 flex flex-wrap gap-1.5 border-t border-border pt-2.5">
          {filters.dateRange !== DEFAULT_DATE_RANGE && (
            <FilterChip
              label={filters.dateRange}
              onRemove={() => onChange({ ...filters, dateRange: DEFAULT_DATE_RANGE })}
            />
          )}
          {filters.divisionIds.map((id) => (
            <FilterChip key={`d-${id}`} label={divName(id)} onRemove={() => toggle('divisionIds')(id)} />
          ))}
          {filters.roles.map((r) => (
            <FilterChip key={`r-${r}`} label={r} onRemove={() => toggle('roles')(r)} />
          ))}
          {filters.userIds.map((id) => (
            <FilterChip key={`u-${id}`} label={userName(id)} onRemove={() => toggle('userIds')(id)} />
          ))}
        </div>
      )}
    </div>
  );
}
