import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Plus } from 'lucide-react';

import type { RoleSummary } from '@/lib/api/roles';
import { Button } from '@/ui-kit/components/ui/button';
import { Combobox } from '@/components/ui/combobox';
import { Input } from '@/components/ui/input';
import { useIsBelow } from '@/ui-kit/hooks/useMediaQuery';
import { useScrollerRoom } from '@/hooks/useScrollerRoom';

import { BUILT_IN, CUSTOM, orderRoles, roleOptions } from './roleOrder';

/**
 * The Roles page's list of roles, however many a company has.
 *
 * A company can hold dozens of custom roles, so the list never spreads across the page. Below the xl screen it is one
 * searchable picker; from xl it is the side column, with its own scroll and a search box once there are many roles. Only
 * one of the two is ever mounted. Both order the roles the same way: the built-in roles first, in the order the server
 * gives them, then the custom roles by name, each with the number of people on it.
 *
 * The New role control belongs to the list but never to its scrolling part: it sits beside the picker, or above the side
 * column's search box, so it is in view at every width however many roles there are.
 */

/** A company with more roles than this gets a search box above the side column. */
const SEARCH_ABOVE = 8;

interface RoleListProps {
  roles: RoleSummary[];
  selected: string;
  onPick: (role: string) => void;
  onNew: () => void;
}

const peopleText = (n: number) => `${n} ${n === 1 ? 'person' : 'people'}`;
const matchesName = (role: RoleSummary, query: string) => role.label.toLowerCase().includes(query.trim().toLowerCase());

function NewRoleButton({ onNew, className }: { onNew: () => void; className?: string }) {
  return (
    <Button variant="outline" size="sm" className={className} onClick={onNew}>
      <Plus />
      New role
    </Button>
  );
}

export function RoleList(props: RoleListProps) {
  return useIsBelow('xl') ? <RolePicker {...props} /> : <RoleColumn {...props} />;
}

/** Below xl: one control showing the selected role and its people count; opening it lists every role, searchable. */
function RolePicker({ roles, selected, onPick, onNew }: RoleListProps) {
  const options = useMemo(() => roleOptions(roles, (r) => `${r.label} · ${peopleText(r.userCount)}`), [roles]);
  const nameOf = useMemo(() => new Map(roles.map((r) => [r.role, r.label])), [roles]);
  // The search reads the role's name, not the count written beside it.
  const searchFields = useCallback((option: { value: string; label: string }) => [nameOf.get(option.value) ?? option.label], [nameOf]);

  return (
    <div className="flex w-full min-w-0 items-center gap-2">
      <div className="min-w-0 flex-1">
        <Combobox
          aria-label="Role"
          value={selected}
          onValueChange={onPick}
          options={options}
          searchFields={searchFields}
          emptyText="No role matches."
          placeholder="Choose a role"
          className="w-full"
        />
      </div>
      <NewRoleButton onNew={onNew} className="shrink-0" />
    </div>
  );
}

/**
 * From xl: the side column. It scrolls on its own and stays in view while the editor scrolls. Its height is what the page
 * scroller has left below its slot (see useScrollerRoom), never a guess at the window height, so the last row is whole
 * at the end of the list and the page gains no scroll of its own from the column.
 */
function RoleColumn({ roles, selected, onPick, onNew }: RoleListProps) {
  const [query, setQuery] = useState('');
  // A role picked or just created that the search would hide is shown: the search is cleared, never the role left out of view.
  const [seen, setSeen] = useState(selected);
  if (seen !== selected) {
    setSeen(selected);
    const picked = roles.find((r) => r.role === selected);
    if (picked && !matchesName(picked, query)) setQuery('');
  }
  const slotRef = useRef<HTMLDivElement>(null);
  const room = useScrollerRoom(slotRef);
  const listRef = useRef<HTMLDivElement>(null);
  const { builtIn, custom } = useMemo(() => orderRoles(roles), [roles]);
  const searchable = roles.length > SEARCH_ABOVE;
  const shown = searchable && query.trim() ? { builtIn: builtIn.filter((r) => matchesName(r, query)), custom: custom.filter((r) => matchesName(r, query)) } : { builtIn, custom };
  // Said only of a search: while the roles are still loading there is nothing to apologise for.
  const nothingShown = roles.length > 0 && shown.builtIn.length === 0 && shown.custom.length === 0;

  // The selected role stays in view: when the roles load, when another is picked, and when a search is cleared.
  useEffect(() => {
    listRef.current?.querySelector('[aria-current="true"]')?.scrollIntoView?.({ block: 'nearest' });
  }, [selected, roles, query]);

  return (
    // The slot is as tall as the page row, so the box inside can stick while the editor beside it scrolls.
    <div ref={slotRef} className="w-56 shrink-0">
      <div data-roles-column style={{ maxHeight: room }} className="sticky top-5 flex flex-col gap-2">
        <NewRoleButton onNew={onNew} className="w-full" />
        {searchable && (
          <Input kind="search" size="sm" aria-label="Search roles" placeholder="Search roles" value={query} onChange={(e) => setQuery(e.target.value)} />
        )}
        {/* Switching role goes through the page's unsaved-changes guard - see RolesPage. */}
        <div data-roles-scroll ref={listRef} className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
          <div role="group" aria-label="Roles" data-roles-list className="space-y-3">
            <RoleGroup title={BUILT_IN} roles={shown.builtIn} selected={selected} onPick={onPick} />
            <RoleGroup title={CUSTOM} roles={shown.custom} selected={selected} onPick={onPick} />
            {nothingShown && <p className="text-muted-foreground px-2 text-sm">No role matches.</p>}
          </div>
        </div>
      </div>
    </div>
  );
}

function RoleGroup({ title, roles, selected, onPick }: { title: string; roles: RoleSummary[]; selected: string; onPick: (role: string) => void }) {
  if (roles.length === 0) return null;
  return (
    <div role="group" aria-label={title} className="space-y-1">
      <p className="text-muted-foreground px-2 text-[11px] font-semibold uppercase tracking-widest">{title}</p>
      {roles.map((r) => (
        <Button
          key={r.role}
          variant={selected === r.role ? 'secondary' : 'ghost'}
          size="sm"
          aria-current={selected === r.role ? 'true' : undefined}
          className="w-full justify-between gap-3"
          onClick={() => onPick(r.role)}
        >
          <span className="min-w-0 truncate font-medium">{r.label}</span>
          <span className="text-muted-foreground text-xs">{r.userCount}</span>
        </Button>
      ))}
    </div>
  );
}
