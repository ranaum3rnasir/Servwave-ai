import { ChevronDown, ListFilter, X } from 'lucide-react';

import type { Division, UserActivity } from '@/lib/reports/activity-logic';
import { DEFAULT_DATE_RANGE, activeFilterCount, allRoles, type Filters } from '@/lib/reports/activity-logic';

import { Badge } from '@/ui-kit/components/ui/badge';
import { Button } from '@/ui-kit/components/ui/button';
import { Card } from '@/ui-kit/components/ui/card';
import {
  DropdownMenu, DropdownMenuCheckboxItem, DropdownMenuContent, DropdownMenuLabel,
  DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuSeparator, DropdownMenuTrigger,
} from '@/ui-kit/components/ui/dropdownMenu';

/**
 * The global "big filter" for the Activity report.
 *
 * THE FACETS CASCADE, and that is the behaviour to preserve: Role is scoped to
 * the selected divisions, and Person to the selected divisions AND roles, so
 * only combinations that actually exist can be picked. `allRoles` and
 * `activeFilterCount` are imported from `activity-logic`, and
 * `DEFAULT_DATE_RANGE` is what "cleared" means for the date facet - clearing to
 * an empty string instead would silently change the default window.
 *
 * Mock-first note carried over: the Date range facet is fully interactive but
 * does not yet narrow the snapshot data - it is wired for the future backend
 * aggregation.
 *
 * On the kit the dropdowns are the kit's `DropdownMenu` (the same Radix menu
 * the app's own wraps) and the removable chips are kit Badges with a Button
 * close, replacing `data/filter-chip`.
 */

const DATE_PRESETS = ['Today', 'Last 7 days', 'Last 30 days', 'This month', 'Last month', 'Year to date'];

interface Props {
  filters: Filters;
  onChange: (next: Filters) => void;
  divisions: Division[];
  users: UserActivity[];
}

/** A single multi-select facet rendered as a dropdown of checkboxes. */
function MultiFacet({
  label, options, selected, onToggle,
}: {
  label: string;
  options: { value: string; label: string }[];
  selected: string[];
  onToggle: (value: string) => void;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="outline" size="sm">
          {label}
          {selected.length > 0 && <Badge variant="blue" size="sm">{selected.length}</Badge>}
          <ChevronDown />
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

/** A removable applied-filter chip. */
function AppliedChip({ label, onRemove }: { label: string; onRemove: () => void }) {
  return (
    <Badge variant="softNeutral" size="pill" className="gap-1">
      {label}
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        className="size-4"
        onClick={onRemove}
        aria-label={`Remove ${label}`}
      >
        <X />
      </Button>
    </Badge>
  );
}

export function ActivityFilterBar({ filters, onChange, divisions, users }: Props) {
  // Cascading options: Role is scoped to the selected divisions; Person to the
  // selected divisions AND roles - so you can only pick combinations that exist.
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
    <Card>
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-muted-foreground mr-1 flex items-center gap-1.5 text-xs font-medium">
          <ListFilter className="size-4" />
          Filters
          {count > 0 && <Badge variant="blue" size="sm">{count}</Badge>}
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

        {/* Date range - single-select preset */}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="outline" size="sm">
              {filters.dateRange}
              <ChevronDown />
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
          <Button type="button" variant="ghost" size="sm" onClick={clearAll} className="ml-auto">
            <X />
            Clear all
          </Button>
        )}
      </div>

      {count > 0 && (
        <div className="mt-2.5 flex flex-wrap gap-1.5 border-t pt-2.5">
          {filters.dateRange !== DEFAULT_DATE_RANGE && (
            <AppliedChip
              label={filters.dateRange}
              onRemove={() => onChange({ ...filters, dateRange: DEFAULT_DATE_RANGE })}
            />
          )}
          {filters.divisionIds.map((id) => (
            <AppliedChip key={`d-${id}`} label={divName(id)} onRemove={() => toggle('divisionIds')(id)} />
          ))}
          {filters.roles.map((r) => (
            <AppliedChip key={`r-${r}`} label={r} onRemove={() => toggle('roles')(r)} />
          ))}
          {filters.userIds.map((id) => (
            <AppliedChip key={`u-${id}`} label={userName(id)} onRemove={() => toggle('userIds')(id)} />
          ))}
        </div>
      )}
    </Card>
  );
}
