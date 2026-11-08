import { useId, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { format } from 'date-fns';
import { CalendarX2, CheckCircle2, Phone, MessageSquare } from 'lucide-react';

import { MultiAssigneeSelect } from '@/components/crm/MultiAssigneeSelect';
import { FLOATING_LAYER_SELECTOR, useListOpenAtPointerDown } from '@/ui-kit/hooks/useListClosesFirst';
import type { KnownPerson } from '@/components/crm/knownPeople';
import {
  EVENT_TYPE_META,
  STATE_META,
  deriveState,
  type SchedulableEvent,
} from '@/components/schedule/scheduleModel';
import { crewPeopleOf, crewPeopleById, ownerOf, fullName } from '@/components/schedule/eventPeople';
import type { AssignableUser } from '@/lib/api/users';
import { asWallClock, type WallClock } from '@/lib/schedule-tz';
import {
  durationMinutesOf,
  scheduleTimeFrom,
  startDateOf,
  type ScheduleTimeValue,
} from '@/components/schedule/scheduleTimeValue';

import { Button } from '@/ui-kit/components/ui/button';
import {
  Dialog, DialogBody, DialogContent, DialogDescription, DialogHeader, DialogTitle,
} from '@/ui-kit/components/ui/dialog';
import { EmptyState } from '@/ui-kit/components/data/emptyState';
import { Label } from '@/ui-kit/components/ui/label';
import { Separator } from '@/ui-kit/components/ui/separator';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/ui-kit/components/ui/select';
import { cn } from '@/ui-kit/lib/utils';

import { jobAddress, walkthroughAddress } from '../creation/entityAddress';
import { ScheduleTimeFields } from '../../_shared/scheduleTimeFields';
import { VisitLocationLine } from '../../_shared/visitLocationLine';
import { preferV2Path } from '../../uiV2';
import { EM, EN } from '../glyphs';

/** REPLACE semantics - order-insensitive equality ([] is a valid crew). */
const sameCrew = (a: string[], b: string[]): boolean =>
  a.length === b.length && a.every((id) => b.includes(id));

/**
 * Detail-page URL for an event: walkthroughs live on the lead, jobs on /jobs/:id.
 *
 * `preferV2Path` is applied to the PATH only and the query string is appended
 * after, because the v2 matcher compares path segments and a `?tab=` suffix
 * would make the last segment unmatchable and silently drop the user out of v2.
 */
export function detailUrlOf(event: SchedulableEvent): string {
  return event.type === 'walkthrough'
    ? `${preferV2Path(`/leads/${event.raw.id as string}`)}?tab=walkthrough`
    : preferV2Path(`/jobs/${event.parentId}`);
}

/**
 * Inline call / text affordances; renders nothing when there is no phone.
 *
 * The legacy pair are raw `tel:` and `sms:` anchors. The design-system raw-tag
 * ratchet for anchors sits at its floor, so a new file may not add one - these
 * are kit Buttons that set `window.location.href`, the same substitution the
 * Leads module made for its contact cell. Same destinations, same accessible
 * names. They still match `INTERACTIVE_SELECTOR` below (it lists `button`), so
 * the whole-popup click guard keeps treating them as controls rather than as
 * dead space that navigates.
 */
function ContactLinks({ phone, label }: { phone?: string | null; label: string }) {
  if (!phone?.trim()) return null;
  return (
    <span className="inline-flex shrink-0 items-center gap-1.5">
      <Button
        variant="ghost"
        size="icon-sm"
        aria-label={`Call ${label}`}
        className="size-6 text-subtle-foreground"
        onClick={(e) => { e.stopPropagation(); window.location.href = `tel:${phone}`; }}
      >
        <Phone className="h-3.5 w-3.5" />
      </Button>
      <Button
        variant="ghost"
        size="icon-sm"
        aria-label={`Text ${label}`}
        className="size-6 text-subtle-foreground"
        onClick={(e) => { e.stopPropagation(); window.location.href = `sms:${phone}`; }}
      >
        <MessageSquare className="h-3.5 w-3.5" />
      </Button>
    </span>
  );
}

/**
 * SAVED crew (event.crew, not the draft) resolved to name + phone.
 *
 * BOTH come from the EVENT's own payload first. The roster is a name-only fallback and
 * nothing more: it answers "who may I ADD" and is gated on the `assign User` grant, so a
 * viewer who owns this job but may not change its crew gets an empty (or self-only) roster.
 * Sourcing the phone there made the call/text affordance disappear for exactly those
 * viewers - and `AssignableUser` no longer carries `phone` at all, which is what the two
 * schedule list selects now project onto `assignees[].user` instead.
 */
function crewContactRowsOf(event: SchedulableEvent, members: AssignableUser[]) {
  const payloadById = crewPeopleById(event.type, event.raw);
  return event.crew.map((id) => {
    const p = payloadById.get(id);
    const m = members.find((u) => u.id === id);
    return {
      id,
      name: fullName(p) ?? (m ? `${m.first_name} ${m.last_name}` : null) ?? 'Unknown',
      phone: p?.phone ?? null,
    };
  });
}

// Whole-popup click guard: clicks on any control keep their editing behaviour;
// only genuinely non-interactive areas navigate.
const INTERACTIVE_SELECTOR =
  'button, a, input, select, textarea, label, [role="combobox"], [role="listbox"]';

// A click inside a floating list (its search row, padding, "No results" line) bubbles here through
// React even though the list is portalled to <body>, and it is a click on the list, never on the
// popup. The selector and the open check are shared with the overlay primitives' own
// list-closes-first rule.

export interface EventEditorProps {
  open: boolean;
  event: SchedulableEvent | null;
  /** Org-wide assignable roster - names must resolve beyond the dept-scoped columns. */
  members: AssignableUser[];
  /** Role-gating consumes this: crew as text, no save buttons, no unschedule. */
  readOnly?: boolean;
  /**
   * `assign User` - whether this viewer may put somebody OTHER than themselves on the crew.
   *
   * REQUIRED, and passed in rather than read off the ability here, for the same reason
   * `UnifiedDropModal` takes it as a prop: `SchedulePage` already holds the verdict (it is what
   * scopes `orgRoster` and what seeds a dropped card's crew), so the field cannot be locked on a
   * different answer from the one the rest of the page acted on. No default - a call site that
   * does not think about it fails to compile rather than shipping an unlocked field.
   *
   * ORTHOGONAL to `readOnly`, which is the ROLE gate (`boardCapabilitiesFor`): a SALES rep gets
   * `readOnly: false`, so before this prop existed the editable branch below rendered for
   * exactly the viewer this gate is about. `readOnly` short-circuits first and is untouched by
   * this - a read-only viewer sees crew as plain text and no controls at all.
   */
  canAssignOthers: boolean;
  /**
   * The signed-in user as a LABEL, from the same `useAssignUserPermission()` call that produced
   * `canAssignOthers`.
   *
   * The editor does not seed anything, so this matters in one case and it is a real one: a
   * self-only viewer whose card is crewed with THEMSELVES. Their `/api/users/assignable` roster
   * is `[]` for the whole of a cold load and for ever if the request fails (`useAssignableUsers`
   * has no `placeholderData` to fall back to on a fresh key), and `crewPeopleOf` only helps when
   * the payload carries crew rows with names. Optional, unlike `canAssignOthers`: this is a
   * LABEL and nothing else, so a call site that omits it renders exactly what it does today
   * rather than opening a permission hole. Adds nobody to the dropdown - see `knownPeople.ts`.
   */
  actorKnownPeople?: readonly KnownPerson[];
  /** Page-computed status gate (same logic as the drag-to-unschedule pre-gate). */
  canUnschedule: boolean;
  /** Why, when canUnschedule=false (timed events only). */
  unscheduleDisabledReason?: string;
  /** Job in an active status + caller may manage it - enables "Mark Complete". */
  canComplete?: boolean;
  onSaveCrew: (crew: string[]) => void;
  onSaveTime: (start: WallClock, durationMin: number, allDay: boolean) => void;
  /** The page owns the confirm dialog + the unschedule POST. */
  onUnschedule: () => void;
  /** The page owns the completion dialog + the /complete POST. */
  onComplete?: () => void;
  onClose: () => void;
}

/**
 * The event editor: the ONLY per-person crew path. Drags are whole-lane swaps
 * and the D5 modal is initial scheduling; this is where one person is added or
 * removed. Opens from every board and bucket card click.
 *
 * PURE controlled dialog. It stages crew and time drafts locally and EMITS
 * onSaveCrew / onSaveTime / onUnschedule / onComplete / onClose - it never
 * POSTs. The PAGE owns the mutations, the confirms and the toasts. The commission
 * owner is OFF-BOARD: a read-only field here, never an editable lane. None of
 * that changed.
 */
export function EventEditor({
  open,
  event,
  members,
  readOnly = false,
  canAssignOthers,
  actorKnownPeople,
  canUnschedule,
  unscheduleDisabledReason,
  canComplete = false,
  onSaveCrew,
  onSaveTime,
  onUnschedule,
  onComplete,
  onClose,
}: EventEditorProps) {
  const navigate = useNavigate();
  // Read at pointerdown, before the list's own outside-click handling closes it: by the time the
  // click lands the list is already gone, so the click handler cannot ask.
  const listAtPointerDown = useListOpenAtPointerDown();
  if (!event) return null;
  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) onClose(); }}>
      {/* The whole popup is clickable: any click OUTSIDE a control opens the
          detail page. The guard keeps crew chips, selects, inputs, labels, the
          call/text buttons and the dialog X behaving as controls. With a list
          open, a click on dead space only closes the list - the crew picker
          is non-modal, so that click reaches here, and navigating on it would
          drop an unsaved crew edit. */}
      <DialogContent
        className="cursor-pointer"
        onPointerDownCapture={listAtPointerDown.record}
        onClick={(e) => {
          const target = e.target as HTMLElement;
          if (target.closest(INTERACTIVE_SELECTOR) || target.closest(FLOATING_LAYER_SELECTOR)) return;
          if (listAtPointerDown.wasOpen.current) return;
          onClose();
          navigate(detailUrlOf(event));
        }}
      >
        {/* Keyed body: drafts reset whenever the dialog reopens (Radix unmounts
            closed content) or a different event opens - no sync effects needed. */}
        <EditorBody
          key={event.boardId}
          event={event}
          members={members}
          readOnly={readOnly}
          canAssignOthers={canAssignOthers}
          actorKnownPeople={actorKnownPeople}
          canUnschedule={canUnschedule}
          unscheduleDisabledReason={unscheduleDisabledReason}
          canComplete={canComplete}
          onSaveCrew={onSaveCrew}
          onSaveTime={onSaveTime}
          onUnschedule={onUnschedule}
          onComplete={onComplete}
          onClose={onClose}
        />
      </DialogContent>
    </Dialog>
  );
}

function EditorBody({
  event,
  members,
  readOnly,
  canAssignOthers,
  actorKnownPeople = [],
  canUnschedule,
  unscheduleDisabledReason,
  canComplete,
  onSaveCrew,
  onSaveTime,
  onUnschedule,
  onComplete,
  onClose,
}: Omit<EventEditorProps, 'open' | 'event' | 'readOnly'> & {
  event: SchedulableEvent;
  readOnly: boolean;
}) {
  const uid = useId();
  const navigate = useNavigate();

  const meta = EVENT_TYPE_META[event.type];
  const state = deriveState(event);
  const stateMeta = STATE_META[state];
  const ownerName = fullName(ownerOf(event.type, event.raw));

  // Crew draft. REPLACE semantics; [] is allowed, crew and schedule are
  // independent axes.
  const [draftCrew, setDraftCrew] = useState<string[]>(() => [...event.crew]);
  const crewDirty = !sameCrew(draftCrew, event.crew);

  // Time draft (timed events only). One value for the whole start/end pair - the same
  // shape every other scheduling surface edits (ScheduleTimeFields). `onSaveTime` still
  // speaks start + duration, so the page's mutation is untouched: the duration is
  // DERIVED here from the two ends rather than picked from a control.
  const originalDuration =
    event.start && event.end
      ? Math.round((event.end.getTime() - event.start.getTime()) / 60_000)
      : null;
  const originalTime = event.start ? scheduleTimeFrom(event.start, originalDuration ?? 0) : null;
  const [draftTime, setDraftTime] = useState<ScheduleTimeValue | null>(() => originalTime);
  // All-day is a property of the JOB, not of the time fields, so it lives
  // beside them rather than inside ScheduleTimeValue - which every other
  // scheduling surface shares and most of them cannot store this on.
  const [draftAllDay, setDraftAllDay] = useState<boolean>(() => Boolean(event.isAllDay));
  const allDayDirty = draftAllDay !== Boolean(event.isAllDay);

  const draftStart = draftTime ? startDateOf(draftTime) : null;
  // One derivation for both modes: ScheduleTimeFields keeps an all-day value on the same
  // EXCLUSIVE-midnight end every other surface stores (`allDayRange`), so a single all-day
  // Thursday is already 00:00 Thu -> 00:00 Fri and subtracts to a whole 1440 on its own.
  const draftDuration = draftTime ? durationMinutesOf(draftTime) : null;
  const timeDirty =
    originalTime !== null &&
    draftTime !== null &&
    draftStart !== null &&
    draftDuration !== null &&
    (allDayDirty ||
      draftTime.date !== originalTime.date ||
      draftTime.startTime !== originalTime.startTime ||
      draftTime.endDate !== originalTime.endDate ||
      draftTime.endTime !== originalTime.endTime);

  const detailUrl = detailUrlOf(event);
  // SAVED crew, not the draft: the flag reports what the board is about to run with, so
  // it must not clear the moment someone picks a name they have not saved yet.
  const needsCrew = event.crew.length === 0;
  // The JOB's own service location, or the LEAD's - never resolved through the customer
  // record. A customer can have several sites, so the customer's address answers a
  // different question than "where is this one going". Blank when the record has none;
  // `entityAddress` has no customer fallback on purpose and this is its second caller.
  const address = event.type === 'walkthrough' ? walkthroughAddress(event.raw) : jobAddress(event.raw);
  const customerPhone = (event.raw.customer as { phone?: string | null } | undefined)?.phone;
  const crewRows = crewContactRowsOf(event, members);

  return (
    <>
      <DialogHeader>
        {/* The kit's DialogHeader is a flex ROW, so everything textual is one child.
            Three lines, narrowing from identity to action: WHO this is, WHERE it is,
            and how to reach them plus anything blocking it. */}
        <div className="min-w-0">
          {/* 1 - identity. The number and the customer on one line, which is how the
              board's own cards name a job, so the modal opens saying what you clicked. */}
          <DialogTitle className="flex min-w-0 items-center gap-2">
            {/* The type chip carries the same accent the calendar paints and the
                legend advertises for this event type - shared, not restyled. */}
            <span
              className={cn(
                'shrink-0 rounded-full border-l-[3px] px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide',
                meta.accent,
                meta.soft,
                meta.text,
              )}
            >
              {meta.label}
            </span>
            <span className="truncate">
              {[event.number, event.customer].filter(Boolean).join(` ${EN} `)}
            </span>
          </DialogTitle>

          {/* 2 - where. ONE address line, never two.
              Staging's slice 6 put a visit's own location in the BODY, anchored under a state
              chip this branch had already deleted. Keeping both would print the job's service
              address in the header and the trip's real address further down - two answers to
              "where am I sending the van", with the header winning the glance. That is exactly
              the wrong-side-of-town failure the slice exists to stop.
              So the header asks the slice's question first: if this trip is somewhere other
              than the service address, `locationLabel` is set (it is null for the majority) and
              that is what the line says. It is rendered by the slice's OWN component, so the
              pin, the screen-reader "Location:" prefix, the testid and the verbatim server
              string are untouched - this only decides where it hangs. */}
          {event.locationLabel ? (
            <VisitLocationLine label={event.locationLabel} className="mt-1.5 text-[13px]" />
          ) : (
            address && <DialogDescription>{address}</DialogDescription>
          )}

          {/* 3 - reach and blockers. ContactLinks renders nothing without a phone, so the
              row appears only when it would hold something. */}
          {(customerPhone?.trim() || needsCrew) && (
            <div className="mt-1.5 flex items-center gap-2">
              <ContactLinks phone={customerPhone} label={event.customer} />
              {needsCrew && (
                <span className="bg-status-red-subtle text-status-red-emphasis rounded-full px-2 py-1 text-[10px] font-bold uppercase tracking-wide">
                  Needs crew
                </span>
              )}
            </div>
          )}
        </div>
      </DialogHeader>

      <DialogBody className="space-y-4 pb-5">
        {/* The state chip is gone (its label and hint duplicated the crew and schedule fields
            below it), and slice 6's location line moved up into the header - see the note on
            the address line there for why it cannot sit in both places. */}
        {/* Owner is OFF-BOARD - a field, never a lane (hidden when there is none) */}
        {ownerName && (
          <div className="flex items-center justify-between rounded-lg border px-2.5 py-1.5">
            <span className="text-[10px] font-bold uppercase tracking-wide text-subtle-foreground">
              Owner (off-board)
            </span>
            <span className="text-xs font-semibold text-muted-foreground">{ownerName}</span>
          </div>
        )}

        {/* Crew - THE per-person edit path. Explicit save; drags never do this. */}
        <div className="flex flex-col gap-1.5">
          <Label>Crew</Label>
          {readOnly ? (
            crewRows.length === 0 ? (
              <EmptyState title="No crew" />
            ) : (
              <div className="space-y-1">
                {crewRows.map((r) => (
                  <p key={r.id} className="flex items-center gap-2 text-[13px] text-muted-foreground">
                    {r.name}
                    <ContactLinks phone={r.phone} label={r.name} />
                  </p>
                ))}
              </div>
            )
          ) : (
            <>
              <MultiAssigneeSelect
                value={draftCrew}
                onChange={setDraftCrew}
                purpose="jobCrew"
                placeholder="Add member..."
                // Locked for a viewer without `assign User`. Their chips keep their names but
                // lose their remove controls and the combobox will not open - the whole of what
                // "may not name others" means on this control.
                //
                // This is the per-person edit path, so the lock matters MORE here than on the
                // drop modal: the crew a card arrives with was put there by somebody who held
                // the grant, and every door this editor saves through refuses a CHANGED set from
                // a non-holder with 403. Unlocked, a rep could drop a dispatcher-assigned
                // technician, press Save crew, take the 403, and be left looking at a field that
                // no longer says what the record says with no way back except closing the
                // dialog.
                //
                // THE WHOLE FIELD IS LOCKED, with no "self only" carve-out that would let a
                // non-holder replace the crew WITH themselves - and the reason is the PRODUCT
                // RULE, not a refusal the server makes. Ran's ruling, as the PRD records it
                // (md_files/plans/permissions/2026-08-31-assignee-pool/03-scoped-roster-
                // endpoint.md): a viewer without the grant "see[s] who is assigned, they simply
                // cannot reach for anyone else". Swapping a technician out for yourself is
                // reaching, so this field does not offer it.
                //
                // Do NOT re-justify this from the API - it does not say what the lock says.
                // `isAssigneeSetPermitted` is `requestedIds.every((id) => id === pool.userId)`:
                // it judges the RESULTING set and not the delta, so a self-only requester
                // replacing ['TECH'] with ['ME'] passes the pool check outright. And the
                // backend note about not being able to take yourself off is about the
                // EMPTY-SET rule ("an empty performer list stays legal at the API"), which is a
                // different question again. An earlier version of this comment cited both as
                // though they refused a self-replacement; neither does, and the behaviour has
                // to stand on the ruling instead.
                disabled={!canAssignOthers}
                // The actor, then the EVENT's own crew rows - the same payload
                // `crewContactRowsOf` above already prefers over the roster. `PersonRef.id` is
                // optional on the wire, so a row with no id is dropped rather than keyed on
                // `undefined`. Load-bearing for a locked viewer specifically: their
                // `/api/users/assignable` roster holds nobody but themselves - and holds nobody
                // at all while it loads or if it fails - so without these every name on the
                // card, their own included, reads `Unknown`. The actor goes first so the card's
                // own copy of a name wins (`namesById` lets a later entry overwrite an earlier).
                knownPeople={[
                  ...actorKnownPeople,
                  ...crewPeopleOf(event.type, event.raw).flatMap((p) =>
                    p.id ? [{ id: p.id, first_name: p.first_name, last_name: p.last_name }] : []
                  ),
                ]}
              />
              {/* NO RULE LINE UNDER THE LOCKED FIELD. This editor used to print
                  `selfOnlyNote(event.type)` here whenever `canAssignOthers` was false; the
                  product owner judged that sentence redundant (a locked field with no dropdown
                  already states the rule) and it came off all three surfaces that carried it at
                  once. The API still refuses in those words on a 403 and that refusal is still
                  shown - what is gone is the promise made before the post. See the file note in
                  `unifiedDropModal.tsx` and the guard in
                  `frontend/src/__tests__/selfOnlyRefusalCopy.test.ts`. */}
              {/* SAVE CREW IS LEFT ALONE - gated on `crewDirty` and nothing else, deliberately.
                  The lock above is complete: `disabled` removes the chips' X buttons AND closes
                  the combobox, and those are the only two callers of `setDraftCrew`, so a locked
                  field cannot produce a dirty draft and this button cannot appear. Adding
                  `&& canAssignOthers` here would be unreachable code that ALSO changes what a
                  future partial lock does - it would silently swallow an edit the user had
                  managed to make instead of letting them save it and hear the server's answer.
                  One mechanism, one truth: the button's absence is a CONSEQUENCE of the lock, not
                  a second rule that could disagree with it. */}
              {crewDirty && (
                <div className="mt-1 flex justify-end">
                  <Button size="sm" onClick={() => onSaveCrew(draftCrew)}>
                    Save crew
                  </Button>
                </div>
              )}
              {/* Contact rows for the SAVED crew members that have a phone. */}
              {crewRows.some((r) => r.phone) && (
                <div className="mt-1 space-y-1">
                  {crewRows.filter((r) => r.phone).map((r) => (
                    <p key={r.id} className="flex items-center gap-2 text-xs text-muted-foreground">
                      {r.name}
                      <ContactLinks phone={r.phone} label={r.name} />
                    </p>
                  ))}
                </div>
              )}
            </>
          )}
        </div>

        {/* Schedule - time edits for timed events; unscheduled events state it plainly */}
        {event.start && draftTime ? (
          <div className="flex flex-col gap-1.5">
            <Label>Schedule</Label>
            {readOnly ? (
              <p className="text-[13px] text-muted-foreground">
                {format(event.start, 'EEE, MMM d · h:mm a')}
                {event.end ? ` ${EN} ${format(event.end, 'h:mm a')}` : ''}
              </p>
            ) : (
              <>
                <ScheduleTimeFields
                  idPrefix={uid}
                  value={draftTime}
                  onChange={setDraftTime}
                  {...(event.type === 'job'
                    ? { allDay: draftAllDay, onAllDayChange: setDraftAllDay }
                    : {})}
                />
                {timeDirty && draftStart && draftDuration !== null && (
                  <div className="mt-2 flex justify-end">
                    <Button size="sm" onClick={() => onSaveTime(asWallClock(draftStart), draftDuration, draftAllDay)}>
                      Save time
                    </Button>
                  </div>
                )}
              </>
            )}
          </div>
        ) : (
          <p className="text-[13px] italic text-muted-foreground">Unscheduled {EM} {stateMeta.hint}</p>
        )}

        {/* Mark Complete - close out an active job directly from the board (jobs only). */}
        {event.type === 'job' && canComplete && !readOnly && onComplete && (
          <>
            <Separator />
            <Button size="sm" className="w-full" onClick={onComplete}>
              <CheckCircle2 /> Mark Complete
            </Button>
          </>
        )}

        <Separator />

        {/* Footer: unschedule (timed only - clears TIME, keeps crew) + detail nav */}
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            {event.start && !readOnly && (
              <>
                <Button
                  size="sm"
                  variant="ghost"
                  className="text-destructive"
                  disabled={!canUnschedule}
                  onClick={onUnschedule}
                >
                  <CalendarX2 /> Move to Unscheduled
                </Button>
                {!canUnschedule && unscheduleDisabledReason && (
                  <p className="mt-1 text-[11px] text-subtle-foreground">{unscheduleDisabledReason}</p>
                )}
              </>
            )}
          </div>
          <Button
            size="sm"
            variant="link"
            className="shrink-0"
            onClick={() => {
              onClose();
              navigate(detailUrl);
            }}
          >
            View details →
          </Button>
        </div>
      </DialogBody>
    </>
  );
}
