import { useId, useState } from 'react';
import { Check } from 'lucide-react';

import { Badge } from '@/ui-kit/components/ui/badge';
import { Button } from '@/ui-kit/components/ui/button';
import { Checkbox } from '@/ui-kit/components/ui/checkbox';
import { Label } from '@/ui-kit/components/ui/label';
import { SearchInput } from '@/ui-kit/components/form/searchInput';
import {
  Sheet, SheetBody, SheetContent, SheetDescription, SheetFooter, SheetHeader, SheetTitle,
} from '@/ui-kit/components/ui/sheet';

import { fmtPhone } from '@/lib/api/communication';
import {
  textingState,
  useSaveNumberPeople,
  type DefaultChange,
  type NumberAssignmentRow,
  type OrgUserOption,
  type TextingState,
} from '@/lib/api/phoneNumbers';

/** Why nobody can have this number as their default, or null when they can. */
const NO_DEFAULT_REASON: Record<TextingState, string | null> = {
  texts: null,
  'calls-only': "This number can't send texts, so it can't be anyone's default.",
  paused: "This number is paused, so it can't be anyone's default.",
  disconnected: "This number is no longer connected, so it can't be anyone's default.",
  unavailable: "This number isn't available yet, so it can't be anyone's default.",
};

const NOT_ASSIGNED_REASON = 'Only people who can use this number can have it as their default.';

/** The draft: who is on the number, and whose default it is. */
type Draft = { userIds: string[]; defaults: Set<string> };

function draftFrom(row: NumberAssignmentRow): Draft {
  return {
    userIds: row.assignments.map((a) => a.user_id),
    defaults: new Set(row.assignments.filter((a) => a.is_default).map((a) => a.user_id)),
  };
}

/** Defaults that differ from what is saved, for people still on the number. A
 *  person taken off the number needs no call: removing the assignment drops
 *  their default with it. */
function changedDefaults(row: NumberAssignmentRow, draft: Draft): DefaultChange[] {
  const saved = new Set(row.assignments.filter((a) => a.is_default).map((a) => a.user_id));
  return draft.userIds
    .filter((id) => draft.defaults.has(id) !== saved.has(id))
    .map((id) => ({ userId: id, isDefault: draft.defaults.has(id) }));
}

interface PanelProps {
  row: NumberAssignmentRow;
  users: OrgUserOption[];
  onClose: () => void;
}

/** The panel's contents. Mounted fresh on every open, so the draft always
 *  starts from the saved state and Cancel/Escape simply drop it. */
function PeoplePanel({ row, users, onClose }: PanelProps) {
  const save = useSaveNumberPeople();
  const [draft, setDraft] = useState<Draft>(() => draftFrom(row));
  const [query, setQuery] = useState('');
  const numberReasonId = useId();
  const assignedReasonId = useId();

  const formatted = fmtPhone(row.e164);
  const numberReason = NO_DEFAULT_REASON[textingState(row)];
  const assigned = new Set(draft.userIds);
  const q = query.trim().toLowerCase();
  const shownUsers = q ? users.filter((u) => u.name.toLowerCase().includes(q)) : users;

  const toggleAssigned = (userId: string, on: boolean) =>
    setDraft((d) => {
      const defaults = new Set(d.defaults);
      if (!on) defaults.delete(userId);
      return {
        userIds: on ? [...d.userIds, userId] : d.userIds.filter((id) => id !== userId),
        defaults,
      };
    });

  const toggleDefault = (userId: string) =>
    setDraft((d) => {
      const defaults = new Set(d.defaults);
      if (defaults.has(userId)) defaults.delete(userId);
      else defaults.add(userId);
      return { ...d, defaults };
    });

  const onSave = () =>
    save.mutate(
      // `row` is the latest server row (the page re-reads it after every
      // refetch), so a retry after a failure sends only what still differs.
      { id: row.id, userIds: draft.userIds, defaultChanges: changedDefaults(row, draft) },
      // Close only on success. On failure the panel keeps the draft so the
      // admin can retry, while the list behind it refetches the server state.
      { onSuccess: onClose },
    );

  return (
    <>
      <SheetHeader>
        <p className="text-muted-foreground text-[11px] font-semibold tracking-widest uppercase">
          Who can call and text from
        </p>
        <SheetTitle className="font-mono tabular-nums">{formatted}</SheetTitle>
        <SheetDescription>{row.label ?? 'No name'}</SheetDescription>
        {numberReason && (
          <p className="text-muted-foreground mt-2 flex items-start gap-2 text-[12.5px]">
            {textingState(row) === 'calls-only' && (
              <Badge variant="softAmber" size="pill">Calls only</Badge>
            )}
            <span id={numberReasonId}>{numberReason}</span>
          </p>
        )}
      </SheetHeader>
      <SheetBody className="space-y-3">
        <SearchInput
          value={query}
          onValueChange={setQuery}
          placeholder="Search people"
          aria-label="Search people"
          autoComplete="off"
        />
        <p id={assignedReasonId} className="text-muted-foreground text-xs">
          {NOT_ASSIGNED_REASON}
        </p>
        {shownUsers.length === 0 ? (
          <p className="text-muted-foreground py-6 text-center text-sm">No one matches.</p>
        ) : (
          <ul className="divide-border rounded-lg border">
            {shownUsers.map((u) => {
              const isAssigned = assigned.has(u.id);
              const isDefault = draft.defaults.has(u.id);
              // A default already set can always be cleared; a new one needs an
              // assigned person on an active number that can text.
              const blockedBy = !isAssigned ? assignedReasonId : numberReason && !isDefault ? numberReasonId : null;
              return (
                <li key={u.id} className="flex items-center justify-between gap-2 border-b px-3 last:border-b-0">
                  {/* The whole row is the checkbox's target (min-h-11 = 44px). */}
                  <Label className="flex min-h-11 flex-1 cursor-pointer items-center gap-2.5 text-sm font-normal">
                    <Checkbox
                      checked={isAssigned}
                      aria-label={u.name}
                      onCheckedChange={(v) => toggleAssigned(u.id, v === true)}
                    />
                    <span>{u.name}</span>
                  </Label>
                  {/* size="sm" is h-8.5 (34px), above the 24px minimum. */}
                  <Button
                    type="button"
                    size="sm"
                    variant={isDefault ? 'secondary' : 'outline'}
                    aria-pressed={isDefault}
                    aria-label={`Default number for ${u.name}`}
                    aria-describedby={blockedBy ?? undefined}
                    disabled={blockedBy !== null}
                    onClick={() => toggleDefault(u.id)}
                  >
                    {isDefault && <Check aria-hidden="true" />}
                    Default
                  </Button>
                </li>
              );
            })}
          </ul>
        )}
      </SheetBody>
      <SheetFooter>
        <Button variant="outline" onClick={onClose} disabled={save.isPending}>
          Cancel
        </Button>
        <Button onClick={onSave} isLoading={save.isPending}>
          Save
        </Button>
      </SheetFooter>
    </>
  );
}

export interface CallerIdPeopleSheetProps {
  /** The number being edited, or null when the panel is closed. */
  row: NumberAssignmentRow | null;
  users: OrgUserOption[];
  onClose: () => void;
  /** Where focus goes when the panel closes: the row's Edit button. */
  returnFocusTo: () => HTMLElement | null | undefined;
}

/**
 * Settings > Caller ID side panel (slice 03): who can call and text from one
 * number, and whose default it is. Built on the kit sheet, so it traps focus
 * and closes on Escape. Nothing is applied until Save; Cancel, Escape and the
 * close button all discard the draft.
 */
export function CallerIdPeopleSheet({ row, users, onClose, returnFocusTo }: CallerIdPeopleSheetProps) {
  return (
    <Sheet open={row !== null} onOpenChange={(open) => { if (!open) onClose(); }}>
      <SheetContent
        onCloseAutoFocus={(e) => {
          // Explicitly the row's Edit button, not whatever had focus before
          // the panel opened (Safari never focuses a clicked button).
          const target = returnFocusTo();
          if (target) {
            e.preventDefault();
            target.focus();
          }
        }}
      >
        {row && <PeoplePanel key={row.id} row={row} users={users} onClose={onClose} />}
      </SheetContent>
    </Sheet>
  );
}
