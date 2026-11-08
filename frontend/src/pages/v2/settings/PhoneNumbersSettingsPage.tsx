import { useEffect, useRef, useState } from 'react';
import { Phone, TriangleAlert } from 'lucide-react';

import { useAppAbility } from '@/contexts/AbilityContext';
import { useFeature } from '@/lib/entitlements';
import { fmtPhone } from '@/lib/api/communication';
import {
  useNumberAssignments,
  useSetOrgDefaultNumber,
  canBeDefault,
  textingState,
  type NumberAssignmentRow,
} from '@/lib/api/phoneNumbers';
import { useBackgroundNumberSync } from '@/lib/api/backgroundNumberSync';

import { EmptyState } from '@/ui-kit/components/data/emptyState';
import { SelectField, type SelectFieldOption } from '@/ui-kit/components/form/selectField';
import { Label } from '@/ui-kit/components/ui/label';
import { Skeleton } from '@/ui-kit/components/ui/skeleton';

import { CallerIdPeopleSheet } from './components/callerIdPeopleSheet';
import { CallerIdNumberList } from './components/callerIdNumberList';
import { Section } from './components/section';

const ORG_DEFAULT_ID = 'caller-id-org-default';

/** The select's value for "No organization default". Not a number id (those are
 *  uuids), and not '' - a Radix select item cannot carry an empty value. */
const NO_ORG_DEFAULT = 'no-org-default';
const NO_ORG_DEFAULT_LABEL = 'No organization default';

/** The org default list's note beside each number that is not a plain pick. */
const ORG_DEFAULT_HINT: Record<ReturnType<typeof textingState>, string | undefined> = {
  texts: undefined,
  'calls-only': 'Calls only',
  paused: 'Paused',
  disconnected: 'Unavailable',
  unavailable: 'Unavailable',
};

/** "(555) 201-4410 · Office line", or the bare number when it has no name. */
function numberWithName(row: NumberAssignmentRow): string {
  return row.label ? `${fmtPhone(row.e164)} · ${row.label}` : fmtPhone(row.e164);
}

/**
 * Settings > Caller ID (phone-system slice 3). An admin manages which users may
 * send from each phone number, each user's default number, and the single org
 * default. This is exactly what the backend outbound resolver reads to choose
 * the "from" number.
 *
 * `phone` is the master switch for the ENTIRE Communication module, and this
 * page is one of the two settings tabs behind it. The gate is reproduced
 * exactly: the SettingsLayout nav entry is CASL `update Organization` PLUS
 * comm-gated, and this page repeats the gate defensively - a direct URL hit by a
 * non-admin or a non-comm org renders nothing. It is an AND over `canManage` and
 * `canComm`, so missing either value keeps the page locked despite
 * `useFeature('phone')` failing open by design.
 *
 * Caller ID slice 02: the org default is one labelled select at the top of the
 * page instead of a star on every card. Every save reports itself in a toast
 * and refetches the list on failure - that lives in the shared mutation hooks
 * (`@/lib/api/phoneNumbers`), not here.
 *
 * Caller ID slice 03: the numbers are one compact table (`CallerIdTable`), and
 * who can use a number is edited in a side panel (`CallerIdPeopleSheet`) that
 * applies nothing until Save. Only an active number can be a default; paused
 * and pending numbers are listed but cannot be chosen anywhere on the page.
 *
 * The select's first choice, "No organization default", removes the org
 * default (an unset of the current one), as the old per-card star could.
 */
export default function PhoneNumbersSettingsPage() {
  const ability = useAppAbility();
  const canManage = ability.can('update', 'Organization');
  const canComm = useFeature('phone');
  // Only an admin of a communication-enabled org may see or fetch this.
  const gated = canManage && canComm;

  const { data, isLoading, isError } = useNumberAssignments(gated);
  useBackgroundNumberSync({ enabled: gated });
  const setOrgDefault = useSetOrgDefaultNumber();

  // The org-default control is disabled while a change saves, and a browser
  // drops focus to the page body off a disabled control - so the menu's own
  // "focus back to the trigger" lands nowhere. Put it back once the save
  // settles, unless the person has already moved focus somewhere else.
  const refocusOrgDefault = useRef(false);
  useEffect(() => {
    if (setOrgDefault.isPending || !refocusOrgDefault.current) return;
    refocusOrgDefault.current = false;
    const active = document.activeElement;
    if (active && active !== document.body) return;
    document.getElementById(ORG_DEFAULT_ID)?.focus();
  }, [setOrgDefault.isPending]);

  // The number whose people panel is open. Looked up in the latest list, so a
  // refetch while the panel is open feeds it the server's current row.
  const [editingId, setEditingId] = useState<string | null>(null);
  // Each row's Edit button, so focus returns to it when the panel closes.
  const editButtons = useRef(new Map<string, HTMLButtonElement>());
  // The last number opened. Kept past close: the sheet asks where focus goes
  // only after `editingId` has already been cleared.
  const lastEditedId = useRef<string | null>(null);
  // Where focus goes instead when a save took that number's row off the list
  // (it no longer matches the search or filter), so it never drops to the body.
  const searchBox = useRef<HTMLInputElement>(null);

  // No routing notice any more. Assignment used to reroute the number in CTM and
  // hand back a sync result to explain what it had done; upstream made assignment
  // stop rerouting and forwarding separately editable, so the mutation now returns
  // `{ ok: true }` with nothing to report. The legacy page dropped this banner in
  // the same change.

  // Fail closed: the query above is disabled when !gated (no admin fetch), and
  // the page renders nothing.
  if (!gated) return null;

  if (isLoading) {
    return (
      <div className="space-y-3">
        <Skeleton className="h-16 w-full" />
        {[0, 1, 2, 3].map((i) => (
          <Skeleton key={i} className="h-12 w-full" />
        ))}
      </div>
    );
  }

  if (isError || !data) {
    return (
      <Section>
        <p className="text-destructive text-sm">
          Couldn&apos;t load caller-ID settings - refresh the page to try again.
        </p>
      </Section>
    );
  }

  const { numbers, users } = data;

  if (numbers.length === 0) {
    return (
      <Section>
        <EmptyState
          icon={<Phone />}
          title="No phone numbers yet"
          description="Once your organization has numbers, you can choose which users send from each one and set the org default caller ID here."
        />
      </Section>
    );
  }

  // While a pick is saving, show the pick (a number, or no default while a
  // removal saves); otherwise show the server's answer. A failed save therefore
  // falls back to whatever the refetch says is saved.
  const serverOrgDefaultId = numbers.find((n) => n.is_org_default)?.id;
  const shownOrgDefaultId = setOrgDefault.isPending
    ? setOrgDefault.variables?.isOrgDefault
      ? setOrgDefault.variables.id
      : undefined
    : serverOrgDefaultId;
  const shownOrgDefault = numbers.find((n) => n.id === shownOrgDefaultId);
  const orgDefaultIsCallsOnly =
    !!shownOrgDefault && textingState(shownOrgDefault) === 'calls-only';

  // With no usable org default, the outbound resolver falls back to the org's
  // oldest active number - for a text, the oldest active number that can text.
  // It reads only an ACTIVE default, so a paused, disconnected or not-yet-ready
  // default is skipped the same way. Name the fallback only when such a number
  // exists: with nothing active there is no fallback.
  const activeNumbers = numbers.filter(canBeDefault);
  const fallback = activeNumbers.some((n) => n.sms_enabled)
    ? 'will call from your oldest active number and text from the oldest one that can send texts'
    : activeNumbers.length > 0
      ? 'will call from your oldest active number'
      : null;
  const fallbackNote = !shownOrgDefault
    ? fallback && `Anyone without a usable default of their own ${fallback}.`
    : !canBeDefault(shownOrgDefault)
      ? fallback
        ? `This number can't be used right now, so anyone without a usable default of their own ${fallback}.`
        : "This number can't be used right now."
      : null;

  const orgDefaultOptions: SelectFieldOption[] = [
    { value: NO_ORG_DEFAULT, label: NO_ORG_DEFAULT_LABEL },
    ...numbers.map((row, i) => ({
      value: row.id,
      label: numberWithName(row),
      triggerLabel: numberWithName(row),
      // Only an active number can present as caller ID, so a paused or pending
      // number cannot be picked.
      hint: ORG_DEFAULT_HINT[textingState(row)],
      disabled: !canBeDefault(row),
      // A rule between "no default" and the numbers.
      separatorBefore: i === 0,
    })),
  ];

  const editingRow = editingId ? (numbers.find((n) => n.id === editingId) ?? null) : null;

  const chooseOrgDefault = (value: string) => {
    if (value === NO_ORG_DEFAULT) {
      // Removing is an unset of the number that is the default now; with none
      // there is nothing to send.
      if (!serverOrgDefaultId) return;
      refocusOrgDefault.current = true;
      setOrgDefault.mutate({ id: serverOrgDefaultId, isOrgDefault: false });
      return;
    }
    if (value === shownOrgDefaultId) return;
    refocusOrgDefault.current = true;
    setOrgDefault.mutate({ id: value, isOrgDefault: true });
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <p className="text-muted-foreground max-w-prose text-sm">
          Choose who can call and text from each number.
          {/* Only while there is a default the phone system will actually use. */}
          {shownOrgDefault && canBeDefault(shownOrgDefault) &&
            ' Anyone without a number of their own uses the organization default.'}
        </p>

        <div className="bg-muted border-border w-full space-y-2 rounded-lg border p-3 sm:w-auto sm:min-w-80">
          <Label htmlFor={ORG_DEFAULT_ID}>Organization default</Label>
          <SelectField
            id={ORG_DEFAULT_ID}
            aria-label="Organization default"
            options={orgDefaultOptions}
            value={shownOrgDefaultId ?? NO_ORG_DEFAULT}
            onValueChange={chooseOrgDefault}
            searchPlaceholder="Search numbers"
            emptyMessage="No number matches."
            disabled={setOrgDefault.isPending}
          />
          {/* w-0 min-w-full: the notes take the box's width and add none of their
              own, so a long note never widens the box and pushes it onto its
              own row on a wide screen. */}
          <div aria-live="polite" className="w-0 min-w-full">
            {orgDefaultIsCallsOnly && (
              <p className="text-status-amber-emphasis flex items-start gap-1.5 text-xs">
                <TriangleAlert className="mt-px size-3.5 shrink-0" aria-hidden="true" />
                <span>
                  This number can make calls but can&apos;t send texts, so texts will go out from a
                  different number.
                </span>
              </p>
            )}
            {fallbackNote && <p className="text-muted-foreground text-xs">{fallbackNote}</p>}
          </div>
        </div>
      </div>

      <CallerIdNumberList
        rows={numbers}
        searchRef={searchBox}
        onEdit={(row) => {
          lastEditedId.current = row.id;
          setEditingId(row.id);
        }}
        editButtonRef={(id, el) => {
          if (el) editButtons.current.set(id, el);
          else editButtons.current.delete(id);
        }}
      />

      <CallerIdPeopleSheet
        row={editingRow}
        users={users}
        onClose={() => setEditingId(null)}
        returnFocusTo={() =>
          (lastEditedId.current ? editButtons.current.get(lastEditedId.current) : null) ??
          searchBox.current
        }
      />
    </div>
  );
}
