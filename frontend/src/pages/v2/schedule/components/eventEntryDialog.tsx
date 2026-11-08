import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { CalendarDays, Trash2 } from 'lucide-react';

import api from '@/lib/axios';
import { extractApiError } from '@/lib/utils';
import { useAppAbility } from '@/contexts/AbilityContext';
import { toast } from '@/ui-kit/components/ui/sonner';
import { Button } from '@/ui-kit/components/ui/button';
import { Checkbox } from '@/ui-kit/components/ui/checkbox';
import { Input } from '@/ui-kit/components/ui/input';
import { Label } from '@/ui-kit/components/ui/label';
import { Textarea } from '@/ui-kit/components/ui/textarea';
import {
  Dialog, DialogBody, DialogContent, DialogFooter, DialogHeader, DialogIcon, DialogTitle,
} from '@/ui-kit/components/ui/dialog';
import { FormField } from '@/components/patterns/FormField';

import {
  asWallClock, nowWallClock, wallClockToIso, addMsToWallClock, type WallClock,
} from '@/lib/schedule-tz';
import {
  allDayRange, durationMinutesOf, isInvertedRange, lastDayOf, scheduleTimeFrom, startDateOf,
  type ScheduleTimeValue,
} from '@/components/schedule/scheduleTimeValue';
import { HOURLESS_DEFAULT_START_MIN, type SchedulableEvent } from '@/components/schedule/scheduleModel';

import { invalidateCalendarEntryQueries, participantsPayload } from '../creation/calendarEntryWrite';

import { ScheduleTimeFields } from '../../_shared/scheduleTimeFields';
import { ScheduleConfirmDialog } from './confirmDialog';
import { ParticipantsField, type ParticipantDraft } from './participantsField';

/** No org default exists for an entry the way `default_job_duration_min` does for a job
 *  (spec §2 - an entry is not work) - one flat hour, the same floor every other v2 create
 *  surface without an org setting of its own falls back to. */
const DEFAULT_EVENT_DURATION_MIN = 60;

const QUARTER_HOUR_MIN = 15;
const QUARTER_HOUR_MS = QUARTER_HOUR_MIN * 60_000;

/**
 * Product-owner finding — the plain toolbar "New Event" button seeded the dialog from the
 * clock to the minute (5:16 AM), so every create started with the user fixing two fields.
 * Rounds a WallClock UP to the next 15-minute boundary (5:16 -> 5:30, 5:31 -> 5:45); a value
 * already on one (5:00) is returned unchanged rather than advanced a whole quarter.
 *
 * Pure WallClock -> WallClock: no `new Date()`, no zone lookup of its own. It operates on
 * whatever WallClock it is given (already the org's `tz` by the time it gets here, via
 * `nowWallClock`) and moves it with `addMsToWallClock`, the same "duration math, never a zone
 * crossing" idiom `lib/schedule-tz` documents - so a round-up that crosses midnight (23:52 ->
 * 00:00 the next day) rolls the date the same way any other WallClock arithmetic does, for
 * free, rather than needing hand-rolled day math here.
 */
export function roundUpToQuarterHour(wallClock: WallClock): WallClock {
  const msIntoHour =
    (wallClock.getMinutes() % QUARTER_HOUR_MIN) * 60_000
    + wallClock.getSeconds() * 1000
    + wallClock.getMilliseconds();
  if (msIntoHour === 0) return wallClock;
  return addMsToWallClock(wallClock, QUARTER_HOUR_MS - msIntoHour);
}

/**
 * QA finding 2 (slice 05) — the fallback for unticking All Day when there is no pre-toggle
 * draft to restore (the entry opened already all-day: never toggled on this session). The
 * underlying span is still literally 00:00->00:00 on `day`; showing that straight through the
 * now-visible timed fields would read as a genuine one-instant "midnight to midnight" event,
 * not a real time anybody meant. Falls back to the same 08:00 day-granularity default
 * `hhmmToMin` uses elsewhere on this board, one DEFAULT_EVENT_DURATION_MIN block.
 */
function defaultTimedDraftFor(day: string): ScheduleTimeValue {
  const [y, m, d] = day.split('-').map(Number);
  const start = new Date(
    y as number, (m as number) - 1, d as number,
    Math.floor(HOURLESS_DEFAULT_START_MIN / 60), HOURLESS_DEFAULT_START_MIN % 60,
  );
  return scheduleTimeFrom(start, DEFAULT_EVENT_DURATION_MIN);
}

interface RawParticipant {
  kind: 'USER' | 'CUSTOMER';
  user_id: string | null;
  customer_id: string | null;
  first_name?: string | null;
  last_name?: string | null;
  name?: string | null;
  /** Notifications (slice 07, spec §5) - the participant's own saved address, resolved
   *  server-side: Customer.email for a customer, User.email for a teammate (product-owner
   *  change, 2026-08-25 - both kinds are emailed now). Null/absent means "no email on file",
   *  which costs that participant the email and nothing else: the participant row is still what
   *  puts the entry on their customer page / their board column. */
  email?: string | null;
  /** Notifications (slice 07) - non-null only once a SCHEDULED/MOVED/CANCELLED email actually
   *  sent for this participant, either kind. Drives the checkbox pre-tick matrix (spec §5) for
   *  CUSTOMER participants only: never set from anything else, and never read as a stand-in for
   *  "this participant existed before" - which is precisely what the USER half of the matrix
   *  does ask, mirroring classifyOutcome in lib/calendar-entries/notify.ts. */
  notified_at?: string | null;
}

/** Narrows `SchedulableEvent.raw` for a `type: 'calendar-entry'` card - the enriched shape
 *  `calendar-entry.controller.ts`'s `withEnrichedParticipants` sends (participants carrying
 *  display names, not just ids), which is what `calendarEntryToEvent` passes through whole. */
interface RawCalendarEntry {
  title?: string;
  description?: string | null;
  participants?: RawParticipant[];
}

function seedParticipants(raw: Record<string, unknown> | undefined): ParticipantDraft[] {
  const rows = (raw as RawCalendarEntry | undefined)?.participants ?? [];
  const drafts: ParticipantDraft[] = [];
  for (const p of rows) {
    if (p.kind === 'USER' && p.user_id) {
      drafts.push({ kind: 'USER', id: p.user_id, label: `${p.first_name ?? ''} ${p.last_name ?? ''}`.trim() || 'User' });
    } else if (p.kind === 'CUSTOMER' && p.customer_id) {
      drafts.push({ kind: 'CUSTOMER', id: p.customer_id, label: p.name ?? 'Customer' });
    }
  }
  return drafts;
}

const participantKey = (p: ParticipantDraft) => `${p.kind}:${p.id}`;

/** Notifications (slice 07) - email + notified_at, looked up by the SAME kind:id key the chip
 *  list already uses. `ParticipantsField`'s own `ParticipantDraft` stays {kind,id,label} only
 *  (it is the add/remove picker, not a notify concern) - this is a side table, not a field
 *  bolted onto that shared component. */
interface ParticipantMeta {
  email: string | null;
  notifiedAt: string | null;
}

function buildParticipantMetaMap(raw: Record<string, unknown> | undefined): Map<string, ParticipantMeta> {
  const rows = (raw as RawCalendarEntry | undefined)?.participants ?? [];
  const map = new Map<string, ParticipantMeta>();
  for (const p of rows) {
    const id = p.kind === 'USER' ? p.user_id : p.customer_id;
    if (!id) continue;
    map.set(`${p.kind}:${id}`, { email: p.email ?? null, notifiedAt: p.notified_at ?? null });
  }
  return map;
}

function participantsEqual(a: ParticipantDraft[], b: ParticipantDraft[]): boolean {
  if (a.length !== b.length) return false;
  const bKeys = new Set(b.map(participantKey));
  return a.every((p) => bKeys.has(participantKey(p)));
}

/* `participantsPayload` and `invalidateCalendarEntryQueries` now live in
 * `../creation/calendarEntryWrite`, shared with the unified creation popover. */

export interface EventEntryDialogProps {
  mode: 'create' | 'edit';
  open: boolean;
  /** Required for 'edit'; ignored (may be null) for 'create'. */
  event: SchedulableEvent | null;
  tz: string;
  onClose: () => void;
  /**
   * QA finding 3 (slice 05) - create-mode only. Pre-fills the time (and all-day state) from
   * where the user clicked - e.g. the all-day slot popover's "New Event" (spec §3's "What to
   * build": the popover "must be able to seed a new Event, not only a job"). Ignored for
   * 'edit' - the entry's own start/end/is_all_day seed there, via `event`. Omitted entirely by
   * the plain "New Event" toolbar button, which still falls back to "now, one hour, timed".
   */
  createSeed?: { start: WallClock; end: WallClock; isAllDay?: boolean };
}

/**
 * The Event dialog (calendar-entries spec §2/§4/§7, slice 04): create, edit, hard delete,
 * one participants field. Self-contained - owns its own create/update/delete mutations and
 * the `CalendarEntry` ability check, so the board only has to decide WHEN to render it.
 */
export function EventEntryDialog({ mode, open, event, tz, onClose, createSeed }: EventEntryDialogProps) {
  const ability = useAppAbility();
  const canWrite = mode === 'create'
    ? ability.can('create', 'CalendarEntry')
    : ability.can('update', 'CalendarEntry');
  const canDelete = mode === 'edit' && ability.can('delete', 'CalendarEntry');

  // Hard delete needs its own confirm (spec §7). It hides the main dialog rather than
  // stacking a second Radix Dialog over it - the same "one Radix dialog open at a time"
  // rule the board's own unschedule-confirm/EventEditor pair already follows, to avoid a
  // focus-lock fight between the two.
  const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false);

  if (mode === 'edit' && !event) return null;

  return (
    <>
      <Dialog open={open && !deleteConfirmOpen} onOpenChange={(o) => { if (!o) onClose(); }}>
        <DialogContent>
          {/* Keyed: a fresh draft every time the dialog opens for a different entry (or for
              create) - Radix unmounts closed content, so this also resets state between two
              back-to-back "New Event" clicks. */}
          <EventEntryDialogBody
            key={mode === 'edit' && event ? event.boardId : 'create'}
            mode={mode}
            event={event}
            tz={tz}
            readOnly={!canWrite}
            canDelete={canDelete}
            onClose={onClose}
            onRequestDelete={() => setDeleteConfirmOpen(true)}
            createSeed={createSeed}
          />
        </DialogContent>
      </Dialog>

      {mode === 'edit' && event && (
        <DeleteEventConfirm
          open={deleteConfirmOpen}
          entryId={event.parentId}
          participantCount={((event.raw as RawCalendarEntry | undefined)?.participants ?? []).length}
          onOpenChange={setDeleteConfirmOpen}
          onDeleted={onClose}
        />
      )}
    </>
  );
}

function DeleteEventConfirm({
  open, entryId, participantCount, onOpenChange, onDeleted,
}: {
  open: boolean;
  entryId: string;
  /** Spec §5: the delete prompt is pre-ticked whenever the entry has participants at all (an
   *  email costs something real going out the door). Counted across BOTH kinds since the
   *  product-owner change of 2026-08-25 — a teammate is emailed too now, so a user-only entry
   *  is no longer a "nobody to ask about" case. The in-app cancellation notice is separate and
   *  unconditional; unticking here quiets the mail, never the board. */
  participantCount: number;
  onOpenChange: (open: boolean) => void;
  onDeleted: () => void;
}) {
  const queryClient = useQueryClient();
  // Default true (pre-ticked) — only actually reaches the wire as `?notify=false` on an
  // explicit untick, so the bare `DELETE /api/calendar-entries/:id` call an entry with no
  // participants makes is byte-identical to before this slice.
  const [notifyEnabled, setNotifyEnabled] = useState(true);
  const hasParticipants = participantCount > 0;

  const deleteMutation = useMutation({
    mutationFn: async () => api.delete(
      hasParticipants && !notifyEnabled
        ? `/api/calendar-entries/${entryId}?notify=false`
        : `/api/calendar-entries/${entryId}`,
    ),
    onSuccess: () => {
      invalidateCalendarEntryQueries(queryClient);
      toast('Event deleted');
      onOpenChange(false);
      onDeleted();
    },
    onError: (err) => {
      onOpenChange(false);
      toast.error('Could not delete event', { description: extractApiError(err, 'Please try again.') });
    },
  });

  return (
    <ScheduleConfirmDialog
      open={open}
      onOpenChange={onOpenChange}
      icon={<Trash2 />}
      title="Delete this event?"
      description="This removes it for everyone on the schedule. This cannot be undone."
      confirmLabel="Delete"
      isLoading={deleteMutation.isPending}
      onConfirm={() => deleteMutation.mutate()}
    >
      {hasParticipants && (
        <label className="flex cursor-pointer items-center gap-3">
          <Checkbox
            checked={notifyEnabled}
            onCheckedChange={(next) => setNotifyEnabled(next === true)}
            aria-label="Notify participants"
          />
          <span className="text-foreground text-sm font-medium">Notify participants</span>
        </label>
      )}
    </ScheduleConfirmDialog>
  );
}

function EventEntryDialogBody({
  mode, event, tz, readOnly, canDelete, onClose, onRequestDelete, createSeed,
}: {
  mode: 'create' | 'edit';
  event: SchedulableEvent | null;
  tz: string;
  readOnly: boolean;
  canDelete: boolean;
  onClose: () => void;
  onRequestDelete: () => void;
  createSeed?: { start: WallClock; end: WallClock; isAllDay?: boolean };
}) {
  const queryClient = useQueryClient();
  const raw = event?.raw;
  const seedTitle = (raw as RawCalendarEntry | undefined)?.title ?? event?.title ?? '';
  const seedDescription = (raw as RawCalendarEntry | undefined)?.description ?? '';

  const [title, setTitle] = useState(seedTitle);
  const [description, setDescription] = useState(seedDescription);
  const [participants, setParticipants] = useState<ParticipantDraft[]>(() => seedParticipants(raw));

  // Time draft (spec: fields come from `_shared/scheduleTimeFields.tsx` over the pure
  // `scheduleTimeValue` module, #1551). Seeded from the entry's OWN start/end via the same
  // `scheduleTimeFrom(start, duration)` idiom `eventEditor.tsx` uses - never re-derived from a
  // narrower combined string (#1535).
  //
  // QA finding 3 (slice 05) — in CREATE mode only, `createSeed` (the all-day slot popover's
  // "New Event") takes over from the usual "now, one hour" default; EDIT mode is untouched
  // (createSeed is always undefined there, so `event` alone still decides, exactly as before).
  //
  // Product-owner finding (post-launch) — the "now, one hour" default is the PLAIN toolbar
  // button's fallback only (no `createSeed`, no `event`): `roundUpToQuarterHour` rounds the
  // clock up before it ever reaches `scheduleTimeFrom`, so the seeded start always lands on a
  // :00/:15/:30/:45 boundary. `createSeed` (seeded from where the user clicked) and `event`
  // (the entry's own stored time, EDIT mode) both bypass it entirely — the seed IS the
  // deliberate time in both of those cases, never something to correct.
  const seedStart = mode === 'create' ? (createSeed?.start ?? null) : (event?.start ?? null);
  const seedEnd = mode === 'create' ? (createSeed?.end ?? null) : (event?.end ?? null);
  const originalDuration = seedStart && seedEnd
    ? Math.round((seedEnd.getTime() - seedStart.getTime()) / 60_000)
    : DEFAULT_EVENT_DURATION_MIN;
  const [originalTime] = useState<ScheduleTimeValue>(() => (
    seedStart
      ? scheduleTimeFrom(seedStart, originalDuration || DEFAULT_EVENT_DURATION_MIN)
      : scheduleTimeFrom(roundUpToQuarterHour(nowWallClock(tz)), DEFAULT_EVENT_DURATION_MIN)
  ));
  const [draftTime, setDraftTime] = useState<ScheduleTimeValue>(originalTime);

  // All-day toggle (spec §3/§9 risk 1, slice 05) — same seed as the job visit dialog
  // (AssignJobDialog/VisitScheduleDialog): the entry's OWN flag, read once at mount. In create
  // mode, `createSeed.isAllDay` (QA finding 3) stands in for the not-yet-existing entry's flag.
  const originalIsAllDay = mode === 'create' ? (createSeed?.isAllDay ?? false) : (event?.isAllDay ?? false);
  const [isAllDay, setIsAllDay] = useState<boolean>(originalIsAllDay);
  // Remembers the timed draft from just before the box was checked, so unchecking it in the
  // same session restores real times instead of leaving the midnight-to-midnight span
  // allDayRange wrote. Null whenever there is nothing to restore FROM THIS SESSION (untouched,
  // or - QA finding 2 - the entry opened already all-day and was never toggled on here).
  const [preToggleTime, setPreToggleTime] = useState<ScheduleTimeValue | null>(null);
  function handleAllDayToggle(checked: boolean) {
    setIsAllDay(checked);
    if (checked) {
      setPreToggleTime(draftTime);
      if (draftTime.date) setDraftTime(allDayRange(draftTime.date, lastDayOf(draftTime)));
    } else if (preToggleTime) {
      setDraftTime(preToggleTime);
      setPreToggleTime(null);
    } else if (draftTime.date) {
      // Nothing this session to restore to: the underlying span is still the literal
      // 00:00->00:00 the entry (or an earlier toggle-on) wrote. Piping that straight into
      // the now-visible timed fields would read as a genuine one-instant midnight-to-midnight
      // event - fall back to a sensible business-hours window on the same day instead.
      setDraftTime(defaultTimedDraftFor(draftTime.date));
    }
  }

  const draftStart = startDateOf(draftTime);
  const draftDuration = durationMinutesOf(draftTime);
  const inverted = isInvertedRange(draftTime);
  const timeDirty =
    draftTime.date !== originalTime.date
    || draftTime.startTime !== originalTime.startTime
    || draftTime.endDate !== originalTime.endDate
    || draftTime.endTime !== originalTime.endTime;
  const participantsDirty = !participantsEqual(participants, seedParticipants(raw));

  const canSave = title.trim() !== '' && draftStart !== null && draftDuration !== null && !inverted;

  const invalidate = () => invalidateCalendarEntryQueries(queryClient);

  // ─── Notifications (slice 07, spec §5) ──────────────────────────────────
  //
  // Address is always the participant's own saved email, never editable here (spec §5) - so
  // unlike the job/walkthrough doors' NotifyComposeFields (one recipient, an overridable "To"),
  // this block is purpose-built for "0..N participants, each addressed at their own saved email
  // or not at all". A hand-rolled block rather than a mis-fitting reuse of that component.
  //
  // BOTH KINDS (product-owner change, 2026-08-25 - "I actually wanted all participants to be
  // notified"). The block used to render only when a CUSTOMER participant was present, and a
  // teammate's only notification was the in-app notice. It now covers every participant, so a
  // user-only entry gets the checkbox too.
  const participantMeta = buildParticipantMetaMap(raw);
  const hasParticipants = participants.length > 0;

  // The pre-tick matrix (spec §5, corrected post-review): MIRRORS notify.ts's classifyOutcome
  // exactly — pre-ticked when at least one CURRENT participant would actually receive
  // something. "Already knows about this" is asked per kind, the same way notify.ts asks it:
  //   - CUSTOMER: `notified_at` — they were actually emailed before. Attaching without sending
  //     (no email on file, or the box left unticked) must not promote a later save to "moved".
  //   - USER: the participant was on the entry BEFORE this dialog opened (present in `raw`) —
  //     a teammate sees it on their board the moment they are added, email or no email.
  // A participant who was never known pre-ticks unconditionally (they would get SCHEDULED, the
  // first-notice case) — the earlier `timeDirty &&` AND dropped that branch entirely, so
  // attaching someone to an existing entry with no time change (spec §1's primary use case)
  // silently defaulted the box OFF even though notify.ts would send them the scheduled email
  // the moment the box was ticked. Someone who WAS known pre-ticks only when the time actually
  // changed (MOVED); unchanged time pre-ticks nothing for them (a description typo classifies
  // to 'none' for someone who already knows the entry). Subsumes the old `mode === 'create'`
  // special case: on create `raw` is undefined, so `participantMeta` is empty and every
  // participant is "never known" by construction.
  const defaultNotifyChecked = participants.some((p) => {
    const meta = participantMeta.get(participantKey(p));
    const wasKnownBefore = p.kind === 'CUSTOMER' ? Boolean(meta?.notifiedAt) : meta !== undefined;
    return !wasKnownBefore || timeDirty;
  });
  const [notifyTouched, setNotifyTouched] = useState(false);
  const [notifyManualValue, setNotifyManualValue] = useState(false);
  const notifyEnabled = notifyTouched ? notifyManualValue : defaultNotifyChecked;
  const setNotifyEnabled = (next: boolean) => { setNotifyTouched(true); setNotifyManualValue(next); };

  // Free text (spec §5), seeded live from title/description until the admin actually types into
  // it - a "seed until dirty" idiom, so editing the title after opening the notify block keeps
  // the message in sync right up to the moment it stops being untouched. Only consequential for a participant notify.ts resolves to
  // the SCHEDULED outcome; a MOVED send ignores it entirely (sendCalendarEntryMovedEmail has no
  // `message` parameter at all).
  const [messageTouched, setMessageTouched] = useState(false);
  const [messageDraft, setMessageDraft] = useState('');
  const seededMessage = title.trim() + (description.trim() ? `\n\n${description.trim()}` : '');
  const notifyMessage = messageTouched ? messageDraft : seededMessage;
  const setNotifyMessage = (next: string) => { setMessageTouched(true); setMessageDraft(next); };

  const createMutation = useMutation({
    mutationFn: async () => {
      const start = draftStart as Date;
      const end = addMsToWallClock(asWallClock(start), (draftDuration as number) * 60_000);
      const { data } = await api.post('/api/calendar-entries', {
        title: title.trim(),
        description: description.trim() || undefined,
        start: wallClockToIso(start, tz),
        end: wallClockToIso(end, tz),
        // Always explicit, like the visit dialog's own is_all_day: the box is always rendered
        // and its state is always a decision made in front of the user on THIS save, so there
        // is no "untouched" case for a create to read as "unchanged".
        is_all_day: isAllDay,
        // Explicit [] rather than an omitted key - zero participants is the normal case
        // (spec §2, "Dave is off Thursday") and must round-trip as an empty, not absent, set.
        participants: participantsPayload(participants),
        // Omitted entirely (not `false`) when there is nobody to email or the box is unticked -
        // matches notifyKeys()'s own "no notify_customer key ⇒ silent" convention, and is what
        // the backend's own POST /api/calendar-entries test suite asserts for "unticked".
        ...(hasParticipants && notifyEnabled
          ? { notify_customer: true, notify_message: notifyMessage.trim() || undefined }
          : {}),
      });
      return data;
    },
    onSuccess: () => {
      invalidate();
      toast('Event created', { description: title.trim() });
      onClose();
    },
    onError: (err) => toast.error('Could not create event', { description: extractApiError(err, 'Please try again.') }),
  });

  const updateMutation = useMutation({
    mutationFn: async () => {
      const payload: Record<string, unknown> = {};
      if (title.trim() !== seedTitle) payload.title = title.trim();
      if (description !== seedDescription) payload.description = description.trim();
      // Only sent when the DRAFT actually differs from the seed (#1535 class): a pre-filled
      // dialog editing only the description must not re-derive and resend start/end for a
      // field nobody touched.
      if (timeDirty && draftStart && draftDuration !== null) {
        const end = addMsToWallClock(asWallClock(draftStart), draftDuration * 60_000);
        payload.start = wallClockToIso(draftStart, tz);
        payload.end = wallClockToIso(end, tz);
      }
      if (isAllDay !== originalIsAllDay) payload.is_all_day = isAllDay;
      if (participantsDirty) payload.participants = participantsPayload(participants);
      // See createMutation's identical comment - omitted, not `false`, when there is nobody to
      // email or the box is unticked.
      if (hasParticipants && notifyEnabled) {
        payload.notify_customer = true;
        payload.notify_message = notifyMessage.trim() || undefined;
      }
      const { data } = await api.patch(`/api/calendar-entries/${event!.parentId}`, payload);
      return data;
    },
    onSuccess: () => {
      invalidate();
      toast('Event updated');
      onClose();
    },
    onError: (err) => toast.error('Could not update event', { description: extractApiError(err, 'Please try again.') }),
  });

  const isSaving = createMutation.isPending || updateMutation.isPending;
  const handleSave = () => {
    if (!canSave) return;
    if (mode === 'create') createMutation.mutate();
    else updateMutation.mutate();
  };

  return (
    <>
      <DialogHeader>
        <DialogIcon tone="brand"><CalendarDays /></DialogIcon>
        <DialogTitle>
          {mode === 'create' ? 'New Event' : (readOnly ? (seedTitle || 'Event') : 'Edit Event')}
        </DialogTitle>
      </DialogHeader>

      <DialogBody className="space-y-4 pb-2">
        <FormField label="Title" required>
          <Input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            disabled={readOnly}
          />
        </FormField>

        <FormField label="Description" optional>
          <Textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            disabled={readOnly}
            rows={3}
          />
        </FormField>

        {/* Not paired with Label/htmlFor: matches the visit dialog's own label-beside-control
            row (AssignJobDialog/VisitScheduleDialog) for the identical control. */}
        <label className="flex cursor-pointer items-center gap-2 py-1">
          <Checkbox
            checked={isAllDay}
            onCheckedChange={(next) => handleAllDayToggle(next === true)}
            disabled={readOnly}
            aria-label="All Day"
          />
          <span className="text-text-primary text-sm">All Day</span>
        </label>

        <ScheduleTimeFields
          value={draftTime}
          onChange={setDraftTime}
          disabled={readOnly}
          idPrefix="event-entry"
          allDay={isAllDay}
        />

        <div className="space-y-1.5">
          <Label>Participants</Label>
          <ParticipantsField value={participants} onChange={setParticipants} disabled={readOnly} />
        </div>

        {!readOnly && hasParticipants && (
          <div className="border-border rounded-lg border">
            <label className="flex cursor-pointer items-center gap-3 p-4">
              <Checkbox
                checked={notifyEnabled}
                onCheckedChange={(next) => setNotifyEnabled(next === true)}
                aria-label="Notify participants"
              />
              <span className="text-foreground text-sm font-medium">Notify participants</span>
            </label>

            {/* Product-owner change, 2026-08-25: the explanatory copy that used to sit under the
                heading, under the Message field, and in a "Will be emailed:" recipient manifest
                is all gone, on his call - "there's no need for more sentences or more
                description about what's going to happen". The manifest in particular restated
                the participant chips a few pixels above it. What is left is the control itself:
                one checkbox, one message field. */}
            {notifyEnabled && (
              <div className="border-border space-y-1.5 border-t p-4">
                <Label htmlFor="event-entry-notify-message">Message</Label>
                <Textarea
                  id="event-entry-notify-message"
                  rows={3}
                  value={notifyMessage}
                  onChange={(e) => setNotifyMessage(e.target.value)}
                />
              </div>
            )}
          </div>
        )}

      </DialogBody>

      <DialogFooter>
        <div className="flex w-full items-center justify-between gap-2">
          <div>
            {canDelete && !readOnly && (
              <Button
                type="button"
                variant="ghost"
                className="text-destructive hover:text-destructive"
                onClick={onRequestDelete}
              >
                <Trash2 className="h-4 w-4" /> Delete
              </Button>
            )}
          </div>
          <div className="flex gap-2">
            <Button variant="ghost" onClick={onClose}>{readOnly ? 'Close' : 'Cancel'}</Button>
            {!readOnly && (
              <Button disabled={!canSave} isLoading={isSaving} onClick={handleSave}>
                {mode === 'create' ? 'Create Event' : 'Save'}
              </Button>
            )}
          </div>
        </div>
      </DialogFooter>
    </>
  );
}
