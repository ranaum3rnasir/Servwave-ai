import { useMemo } from 'react';

import { Combobox } from '@/components/ui/combobox';
import type { SelectFieldOption } from '@/components/form/SelectField';
import { useAssignableUsers, type AssigneePurpose } from '@/lib/api/users';
import { namesById, type KnownPerson } from './knownPeople';

export type { KnownPerson };

/* =============================================================================
   AssigneeSelect - now a thin adapter over the §4.2 searchable primitive.
   -----------------------------------------------------------------------------
   This file USED to be the hand-rolled original: its own Popover + search Input
   + useMemo filter + listbox, written for #514 (a Radix Select's closed-trigger
   typeahead committed the first prefix match on a single keystroke, so typing
   "S" instantly assigned "Sherry Dispatcher" and made "Sagiv" unreachable).
   `components/ui/combobox.tsx` was then built FROM this composition - its own
   header says so - which left the two as the same shape maintained twice.

   All this file owns now is the assignee-specific part: sourcing the pool and
   turning users into `{ value, label, group }`. Everything the popover does -
   filtering, the pinned input, keyboard arrows/Enter/Esc, the named empty
   state, keeping the current selection reachable under a non-matching query -
   is the primitive's, and is tested once in components/ui/__tests__/combobox.

   TWO THINGS ARE DELIBERATE HERE:

   - The department heading is ALWAYS emitted, `No department` included. The
     primitive only groups when some option carries a `group`, so handing every
     option one (with the same `?? 'No department'` fallback this file always
     used) is what keeps a headed list headed.
   - The groups are SORTED HERE, not in the primitive. `Combobox` buckets in
     first-seen order over the rows it renders, so the department order has to
     be baked into the options array: alphabetical, with `No department` last -
     byte-for-byte the comparator this file already had.

   ONE KNOWN NARROWING: grouping used to key on `department.id` and now keys on
   the heading text, so two departments sharing a name would merge into one
   section instead of rendering twice under identical headings. That is the
   primitive's `group` contract (a heading is a string), and the merged
   rendering is the better of the two.
   ============================================================================= */

interface AssigneeSelectBaseProps {
  value: string | null;
  onChange: (id: string) => void;
  placeholder?: string;
  disabled?: boolean;
  enabled?: boolean;
  eligibleFor?: 'owner' | 'task' | 'dispatcher';
  /** Accessible name for the trigger. The combobox's visible text is the CHOSEN PERSON, which
   *  says nothing about what choosing them means, so a caller that renders more than one of
   *  these - or any picker whose adjacent <Label> cannot be associated by id - should name it. */
  ariaLabel?: string;
  /**
   * Names for people ALREADY on the record - the single-select half of the same separation
   * `MultiAssigneeSelect` draws (see `knownPeople.ts`).
   *
   * `Combobox` reads its trigger label out of `options`, so a `value` the scoped roster does not
   * contain renders as nothing at all: the dispatcher currently on a job disappears from the
   * control the moment the viewer lacks `assign User`. Only the person matching `value` is
   * adopted from here, and only when the roster has not already supplied them - so this never
   * lengthens the list of people who may be chosen, it just stops the current one going blank.
   */
  knownPeople?: readonly KnownPerson[];
}

/**
 * `purpose` and `users` are the two ways to source the pool, and exactly one of them applies:
 * a caller that hands in its own roster is doing so because it cannot reach the shared one, so
 * there is no grant for a purpose to select. Expressed as a union rather than an optional
 * `purpose` so neither can be forgotten and neither can be given pointlessly.
 */
type AssigneeSelectProps = AssigneeSelectBaseProps &
  (
    | {
        /**
         * Which list this is. Selects the grant `GET /api/users/assignable` scopes the roster
         * by - see `AssigneePurpose` for the two families. There is no default, because a wrong
         * purpose either offers a set the write side then refuses, or (if it names a pool the
         * write side does not consult) hides people that write would have accepted.
         */
        purpose: AssigneePurpose;
        users?: undefined;
      }
    | {
        purpose?: never;
        /**
         * Supply the roster instead of letting this component fetch it.
         *
         * For a caller whose users may not hold `read User` at all. The manual communication
         * log is the live case: an admin can grant the logging capability to SALES, who hold no
         * `read User` row in any default grant, so a directory fetch 403s and the picker renders
         * empty - an unusable control on a feature that had just been switched on. Such a caller
         * reads its own capability-scoped roster and hands it in here.
         *
         * Only the fields this component actually renders are required, so a narrower endpoint's
         * row satisfies it without pretending to be a whole `AssignableUser`.
         */
        users: PickableUser[];
      }
  );

/** What this component reads off a person: a name to show, an id to return, and an optional
 *  department to group by. `AssignableUser` satisfies it structurally. */
type PickableUser = {
  id: string;
  first_name: string;
  last_name: string;
  department?: { id: string; name: string } | null;
};

interface DeptGroup {
  key: string;
  label: string;
  users: PickableUser[];
}

function group(users: PickableUser[]): DeptGroup[] {
  const map = new Map<string, DeptGroup>();
  for (const u of users) {
    const key = u.department?.id ?? '__none__';
    const label = u.department?.name ?? 'No department';
    if (!map.has(key)) map.set(key, { key, label, users: [] });
    map.get(key)!.users.push(u);
  }
  const groups = Array.from(map.values());
  groups.sort((a, b) => {
    if (a.key === '__none__') return 1;
    if (b.key === '__none__') return -1;
    return a.label.localeCompare(b.label);
  });
  return groups;
}

export function AssigneeSelect({
  value,
  onChange,
  purpose,
  placeholder = 'Select assignee...',
  disabled,
  enabled = true,
  eligibleFor,
  ariaLabel,
  users: supplied,
  knownPeople,
}: AssigneeSelectProps) {
  // A supplied roster turns the built-in fetch OFF rather than merely overriding its result: a
  // caller that hands one in is doing so precisely because it cannot reach `/api/users`, and
  // firing the request anyway would 403 in their console on every open.
  const { data: fetched = [] } = useAssignableUsers({
    // Never read when `supplied` is set - the union above makes the two mutually exclusive, and
    // the query is off in that case anyway. The coalesce is only here to satisfy the required
    // field on the hook's options.
    purpose: purpose ?? 'jobCrew',
    enabled: enabled && !supplied,
    eligibleFor,
  });
  const users = supplied ?? fetched;

  const options = useMemo<SelectFieldOption[]>(() => {
    const rosterOptions = group(users).flatMap((g) =>
      g.users.map((u) => ({
        value: u.id,
        // The one string the trigger shows AND the query matches - the same
        // `${first} ${last}` this file always filtered on.
        label: `${u.first_name} ${u.last_name}`,
        group: g.label,
      }))
    );
    // The CURRENT selection, and nothing else, adopted from the record when the roster has no
    // row for it. Appended last so it cannot reorder the department sections above it, and
    // ungrouped because the record carries a name, not a department.
    if (!value || rosterOptions.some((o) => o.value === value)) return rosterOptions;
    const known = namesById(knownPeople).get(value);
    return known ? [...rosterOptions, { value, label: known }] : rosterOptions;
  }, [users, value, knownPeople]);

  return (
    <Combobox
      // `null` is this component's "nothing selected"; the primitive's is ''.
      value={value ?? ''}
      onValueChange={onChange}
      options={options}
      placeholder={placeholder}
      disabled={disabled}
      aria-label={ariaLabel}
      // The wording this file has always shown, kept verbatim - the primitive's
      // default would say `No results for "sz"` instead.
      emptyText="No users found"
    />
  );
}
