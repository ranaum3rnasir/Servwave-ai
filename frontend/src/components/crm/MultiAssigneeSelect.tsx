import { useMemo, useState } from 'react';
import { AlertTriangle, X } from 'lucide-react';
import { Combobox } from '@/components/ui/combobox';
import type { SelectFieldOption } from '@/components/form/SelectField';
import { useAssignableUsers, type AssignableUser, type AssigneePurpose } from '@/lib/api/users';
import { useAppAbility } from '@/contexts/AbilityContext';
import { namesById, type KnownPerson } from './knownPeople';

export type { KnownPerson };

/* =============================================================================
   Why the "add member" list is a Combobox (a non-modal Popover), not a Select.
   -----------------------------------------------------------------------------
   It used to be a Radix Select, and Radix Select is MODAL with no way to turn
   that off: while its list is open it sets `pointer-events: none` on <body>
   (and on any dialog underneath), aria-hides the rest of the page and locks
   scroll. So a dispatcher who picked crew and clicked "Book visit" with the
   list still open had that first click eaten - it only closed the list, and a
   second click was needed (slice 07, reproduced in a real browser on the job
   "Add Visit" dialog and the lead "Book Visit" form). Every surface that
   mounts this picker had the same trap in front of its own Save.

   A Popover dismisses on the outside pointerdown WITHOUT blocking it, so the
   same click closes the list and lands on whatever it was aimed at. That is
   the whole fix, and it lives here so none of the ~12 surfaces needs a
   workaround of its own.

   It is still an "add one" picker, not a multi-select: `value` on the
   Combobox is always '' and a pick calls `addMember`, then the list closes,
   exactly as before. It is also the §4.2 searchable combobox that the
   dropdown-bypass guard had this file parked for, and the same primitive its
   single-select sibling `AssigneeSelect.tsx` already uses.

   ONE KNOWN NARROWING, shared with AssigneeSelect: department headings key on
   the department NAME (the primitive's `group` is a string), so two
   departments with the same name would render under one heading.
   ============================================================================= */

interface MultiAssigneeSelectProps {
  value: string[];
  onChange: (ids: string[]) => void;
  /**
   * Which list this is, and therefore which grant the server scopes it by - `jobCrew` and
   * `walkthroughPerformer` read `assign User`, `task` reads `assign Task` (plus #1950's
   * `read User` hold), `directory` reads `read User`. It is the same question this component
   * asks the local ability to decide whether "nothing left to add" is an absence or a rule
   * (see `mayAddOthers`). Required, with no default: a wrong purpose would offer a set the
   * write side then refuses, or hide one it would have accepted.
   */
  purpose: AssigneePurpose;
  placeholder?: string;
  disabled?: boolean;
  enabled?: boolean;
  eligibleFor?: 'owner' | 'task';
  /**
   * Names for people ALREADY on the record, straight off the record's own payload.
   *
   * The roster answers "who may I ADD" and is scoped: a rep without the `assign` grant gets
   * exactly themselves. That is deliberate - but they still own the record, and Ran's ruling is
   * that they see who is on it, by name, and are merely unable to CHANGE it. Without this the
   * chip for a technician a dispatcher assigned rendered the literal string `Unknown`, because
   * the label was looked up only in a roster that will never contain them.
   *
   * Purely a label source. It adds nobody to the dropdown and widens nothing: these ids are
   * already in `value`, put there by the record. See `knownPeople.ts`.
   */
  knownPeople?: readonly KnownPerson[];
  /**
   * Forwarded to the trigger so a caller's <Label htmlFor> actually names this control. Optional
   * and additive: every existing call site keeps its current markup, and this one is SHARED by
   * two routed surfaces, so it must not change for them.
   */
  id?: string;
  /**
   * Advisory marking (#05). Ids listed here render a marker on their chip and on their dropdown
   * row; `flagNote` is the single explanation shown under the control, and is the only place the
   * reason is spelled out. Purely presentational and deliberately so - this component knows
   * nothing about WHY a candidate is flagged, and a flagged candidate stays selectable,
   * removable and never disabled. Both default to nothing, so every existing call site is
   * unchanged. Ignored entirely when the control itself is `disabled` - see the note below.
   */
  flaggedIds?: string[];
  flagNote?: string | null;
  flagBadge?: string;
}

/**
 * The roster as Combobox options, one `group` per department: alphabetical, with
 * `No department` last. Sorted here because the primitive renders groups in first-seen order.
 */
function toOptions(users: AssignableUser[]): SelectFieldOption[] {
  const byDept = new Map<string, { key: string; label: string; users: AssignableUser[] }>();
  for (const u of users) {
    const key = u.department?.id ?? '__none__';
    const label = u.department?.name ?? 'No department';
    if (!byDept.has(key)) byDept.set(key, { key, label, users: [] });
    byDept.get(key)!.users.push(u);
  }
  const groups = Array.from(byDept.values());
  groups.sort((a, b) => {
    if (a.key === '__none__') return 1;
    if (b.key === '__none__') return -1;
    return a.label.localeCompare(b.label);
  });
  return groups.flatMap((g) =>
    g.users.map((u) => ({ value: u.id, label: `${u.first_name} ${u.last_name}`, group: g.label })),
  );
}

/**
 * Multi-select crew picker. Renders the chosen users as removable chips plus an
 * "add member" combobox over the assignable-users query (the dropdown excludes
 * users already in `value`). REPLACE semantics: `value` is the full crew array.
 *
 * `flaggedIds`/`flagNote` add an advisory marking on top of that without narrowing it - see the
 * prop docs.
 */
export function MultiAssigneeSelect({
  value,
  onChange,
  purpose,
  placeholder = 'Add member...',
  disabled,
  enabled = true,
  eligibleFor,
  id,
  knownPeople,
  flaggedIds,
  flagNote,
  flagBadge = 'No access',
}: MultiAssigneeSelectProps) {
  const { data: users = [] } = useAssignableUsers({ purpose, enabled, eligibleFor });
  const ability = useAppAbility();

  /**
   * Whether this user may name anyone but themselves - the SAME condition, read off the same
   * purpose, that `listAssignable` applies server-side to build the roster.
   *
   * Asked here rather than passed in so a call site cannot forget it, and read from the
   * ability rather than inferred from the roster's length: a one-row roster and an
   * everyone-already-picked roster are both empty lists, and they mean opposite things. It is
   * used for wording only - what may actually be chosen is the roster, and what is accepted is
   * the server's business.
   *
   * `task` READS `read User` TOO, and that is not a widening - it is this component catching up
   * with the endpoint. `purpose=task` is held open for any holder of `read User` (issue #1950's
   * hold), so a DISPATCHER - who holds `read User` but not `assign Task`, which no seeded role
   * holds - was handed the whole org roster by the server while this trigger told them "You
   * cannot add others". Reading `assign Task` alone described a rule the endpoint does not
   * apply. The disjunction mirrors `taskHeldOpen` and should be deleted with it.
   *
   * `directory` reads `read User` outright: the directory family's whole gate.
   *
   * `taskWatcher` IS ALWAYS TRUE, and reads no grant at all (#1956), because no grant gates it:
   * the watcher pool is a cohort every user has a non-empty share of — at minimum themselves
   * plus every admin in the org. So there is no caller for whom "you cannot add others" is the
   * honest wording here, and asking any ability would only re-create the read/write mismatch
   * this purpose exists to fix. Whether a SPECIFIC person may be added is the roster's answer
   * and then the server's; this flag is wording only.
   */
  const mayAddOthers =
    purpose === 'task'
      ? ability.can('assign', 'Task') || ability.can('read', 'User')
      : purpose === 'directory'
        ? ability.can('read', 'User')
        : purpose === 'taskWatcher'
          ? true
          : ability.can('assign', 'User');

  const [menuOpen, setMenuOpen] = useState(false);

  // A control the user cannot change carries no advisory marking. `disabled` is how the task
  // surfaces render the assignee picker for someone without the `assign` grant, and an amber
  // warning about a choice that control will not let them make is pure noise. Enforced here
  // rather than at each call site so a fifth surface cannot forget it.
  const flagged = useMemo(
    () => (disabled ? new Set<string>() : new Set(flaggedIds ?? [])),
    [disabled, flaggedIds],
  );

  const byId = useMemo(() => {
    const m = new Map<string, AssignableUser>();
    for (const u of users) m.set(u.id, u);
    return m;
  }, [users]);

  /** id -> name for people the RECORD already carries. Second in the label chain below. */
  const knownById = useMemo(() => namesById(knownPeople), [knownPeople]);

  // Dropdown lists only users NOT already selected.
  const available = useMemo(
    () => users.filter((u) => !value.includes(u.id)),
    [users, value],
  );
  const options = useMemo(() => toOptions(available), [available]);

  /**
   * The note appears when it is about to matter: this picker already HOLDS a flagged person, or
   * the dropdown is open on one.
   *
   * Testing the whole assignable roster instead is what the first cut did, and it is worse than
   * useless. TECHNICIAN holds no `read Customer`, so on a technician-heavy org every
   * CUSTOMER-linked task carried this sentence permanently, on every surface, whether or not the
   * user had gone anywhere near a flagged person. A warning that is always on screen is one
   * people learn to stop reading, which costs attention on every unrelated task.
   *
   * The per-control duplication is deliberate and stays: a picker showing amber pills with no
   * sentence is a puzzle. Under this condition the two copies will rarely be on screen together.
   */
  const showNote = useMemo(
    () =>
      Boolean(flagNote) &&
      (value.some((v) => flagged.has(v)) || (menuOpen && available.some((u) => flagged.has(u.id)))),
    [flagNote, value, flagged, menuOpen, available],
  );

  /**
   * What the trigger says when there is nothing left to pick - and it is not one state.
   *
   * `No more members` used to cover both, which made a RULE read like a bug: a rep who may name
   * only themselves, and has, was told the roster had run out. Now the two are separated, and
   * the not-permitted wording states the rule plainly. The full explanation belongs under the
   * field, not in a placeholder.
   */
  const emptyPlaceholder =
    available.length > 0 ? null : mayAddOthers ? 'No more members' : 'You cannot add others';

  const addMember = (id: string) => {
    if (!value.includes(id)) onChange([...value, id]);
  };
  const removeMember = (id: string) => onChange(value.filter((v) => v !== id));

  return (
    <div className="space-y-2">
      {value.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {value.map((id) => {
            const u = byId.get(id);
            // Roster first, then the record's own names, then - only when neither knows this
            // id - the honest admission. `Unknown` used to be reached the moment the roster
            // was scoped, which is exactly when the record's copy was available and unused.
            const label = u
              ? `${u.first_name} ${u.last_name}`
              : (knownById.get(id) ?? 'Unknown');
            const isFlagged = flagged.has(id);
            return (
              <span
                key={id}
                className={
                  isFlagged
                    ? 'inline-flex items-center gap-1 rounded-full bg-warning-surface px-2.5 py-1 text-xs font-medium text-warning-text'
                    : 'inline-flex items-center gap-1 rounded-full bg-primary-subtle px-2.5 py-1 text-xs font-medium text-primary'
                }
              >
                {label}
                {isFlagged && (
                  // whitespace-nowrap: the chip's label is the flexible part. Without it a long
                  // name pushes the marker to the chip's second line and breaks it across
                  // "No" / "access" - measured at the drawer's 440px in QA.
                  <span
                    className="inline-flex shrink-0 items-center gap-0.5 whitespace-nowrap"
                    title={flagNote ?? undefined}
                  >
                    <AlertTriangle aria-hidden="true" className="h-3 w-3" />
                    {flagBadge}
                  </span>
                )}
                {!disabled && (
                  // Small close-X affordance inside a chip, not Button-shaped - left raw.
                  <button
                    type="button"
                    onClick={() => removeMember(id)}
                    className="rounded-full hover:bg-primary/10"
                    aria-label={`Remove ${label}`}
                  >
                    <X className="h-3 w-3" />
                  </button>
                )}
              </span>
            );
          })}
        </div>
      )}

      <Combobox
        id={id}
        // Always empty: this is an "add one" picker, so the trigger keeps showing the placeholder
        // and re-picking the same user fires onValueChange again.
        value=""
        onValueChange={addMember}
        options={options}
        placeholder={emptyPlaceholder ?? placeholder}
        // Only OBSERVES the open state, for `showNote` above.
        onOpenChange={setMenuOpen}
        disabled={disabled || available.length === 0}
        renderOptionSuffix={(option) =>
          flagged.has(option.value) && (
            <span
              className="ml-1.5 inline-flex shrink-0 items-center gap-0.5 whitespace-nowrap rounded-full bg-warning-surface px-1.5 py-0.5 text-[11px] font-medium text-warning-text"
              title={flagNote ?? undefined}
            >
              <AlertTriangle aria-hidden="true" className="h-3 w-3" />
              {flagBadge}
            </span>
          )
        }
      />

      {showNote && (
        <p className="flex items-start gap-1 text-xs text-warning-text">
          <AlertTriangle aria-hidden="true" className="mt-0.5 h-3 w-3 shrink-0" />
          <span>{flagNote}</span>
        </p>
      )}
    </div>
  );
}
