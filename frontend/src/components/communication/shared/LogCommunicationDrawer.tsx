/**
 * Log communication — the manual communication log's capture drawer (slice 1; the job anchor,
 * slice 5).
 *
 * Records a conversation that ALREADY HAPPENED, off the platform: a call a rep made from a
 * personal mobile, or months of history an admin is typing up during onboarding. It is not a
 * composer — nothing is sent, nobody is notified, no automation fires.
 *
 * ONE drawer for both anchors. The lead and job Communication tabs open the same component and
 * hand it a `ManualCommAnchor`, which can name a lead or a job and never both — the entry stays
 * on whichever it names, so a lead's history does not migrate onto the job it became.
 *
 * Captures what an entry cannot exist without - direction, when it happened (backdatable) and
 * free-text notes - plus WHO HAD THE CONVERSATION, defaulting to the current user and selectable
 * from anyone in the organisation (slice 2), and HOW LONG IT TOOK (slice 3): an optional duration
 * in minutes. That one stays OPTIONAL - an attempt that says nothing about its length is still a
 * complete entry. (Slice 3's outcome pills - "connected", "no answer" and the rest - were removed
 * as a question not worth asking, and the field behind them is now RETIRED end to end: no reader,
 * no writer, and the API refuses a body naming it.)
 *
 * WHICH CHANNEL (slice 6): call, text or email, defaulting to a call. The optional fields FOLLOW
 * the channel - a duration belongs to a call, a subject line to an email - and are
 * CLEARED rather than merely hidden when the channel changes. Hiding them would let a duration
 * typed against a call ride along on an email, which the API refuses and which would render, if
 * it ever landed, as "Outbound email · 12m" - a statement about a conversation that never had a
 * length.
 *
 * THE ZONE: `occurred_at` leaves here as the ZONELESS wall clock the user picked
 * ('YYYY-MM-DDTHH:MM', DateTimePicker's own contract) and is never converted. Converting it here
 * would resolve it against the BROWSER's timezone, which is exactly the recurring bug this
 * feature must not ship: a rep in another timezone logging "yesterday, 4pm" has to land on the
 * ORGANISATION's yesterday. The server composes it against the org's zone instead, and refuses a
 * value that already carries one — so this component simply never consults the browser's clock.
 *
 * IT MUST ALREADY HAVE HAPPENED. The API refuses an `occurred_at` in the future, and this form
 * says so inline before the user meets that 400 — the same shape as the duration guard below. The
 * comparison needs the ORGANISATION's zone, so it is made only once `GET /api/organization` has
 * actually answered: while the zone is still a guess the guard simply stands down and the server's
 * refusal is the whole of the rule, which is the right way round for a convenience.
 *
 * The value that makes this worth guarding is not a typo. DateTimePicker defaults an unset time to
 * 09:00 when a DATE is chosen, so picking "today" any morning before nine silently produces a
 * future timestamp. That default is shared with tasks, service plans, inventory and payments and
 * is deliberately left alone.
 *
 * `occurred_at` is deliberately NOT seeded with "now". A seed would have to be computed in the
 * org's zone, and `useScheduleTimezone()` answers with a GUESS while the organisation query is in
 * flight (see its doc comment) — a picker seeded on the guess and saved is a silent shift. The
 * question this form asks is "when did this happen?", so it starts blank and the user answers it.
 *
 * ── CORRECTING AN ENTRY (slice 8) ─────────────────────────────────────────────────────────────
 *
 * The SAME form, reopened on an entry that already exists. One component and not two, because a
 * correction has to be able to change every field a creation could set — including which lead or
 * job the entry hangs off, which is how an entry gets moved between the two — and a second form
 * would be a second place for a field to be forgotten.
 *
 * It reopens on the FULL stored entry, fetched by id, never on the timeline item the row was
 * rendered from: that item's preview is truncated at 160 characters and carries no duration,
 * performer or subject, so seeding from it would silently discard the tail of somebody's notes on
 * save.
 *
 * And it reopens on `occurredAtLocal` — the stored instant read back through the ORGANISATION's
 * zone, composed server-side. Reading the instant through the BROWSER's zone would show a
 * different time from the one that was typed, and saving the form untouched would then move it.
 */
import { useEffect, useState } from 'react';
import { ChevronDown, Loader2, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { RequiredToggleGroup } from '@/components/ui/required-toggle-group';
import { ToggleGroupItem } from '@/components/ui/toggle-group';
import { DateTimePicker } from '@/components/form/DateTimePicker';
import { FormField } from '@/components/patterns/FormField';
import { Sheet, SheetContent, SheetDescription, SheetTitle } from '@/components/ui/sheet';
import { AssigneeSelect } from '@/components/crm/AssigneeSelect';
import { useConfirm } from '@/hooks/useConfirm';
import { CommJobMenu } from './CommJobMenu';
import { useAttachTargets } from './useAttachTargets';
import { extractApiError } from '@/lib/utils';
import { Text } from '@/components/ui/text';
import { pickerValueToIso } from '@/lib/schedule-tz';
import { useOrganization } from '@/lib/api/organization';
import { useAuthStore } from '@/stores/auth.store';
import {
  MANUAL_COMM_CHANNELS,
  useLogCommunication,
  useManualCommunicationLog,
  useManualLogPerformers,
  useUpdateCommunicationLog,
  useDeleteCommunicationLog,
  type ManualCommAnchor,
  type ManualCommChannel,
  type ManualLogEntry,
} from '@/lib/api/jobCommunications';

/** Mirrors the API's own FUTURE_TOLERANCE_MS - see `occurredInFuture` for why it is duplicated. */
const FUTURE_GRACE_MS = 2 * 60 * 1000;

/**
 * How often the drawer re-reads the clock while it is open. See `nowMs`.
 *
 * Well inside FUTURE_GRACE_MS, so the staleness this leaves can never itself refuse a value the
 * server would accept, and long enough that a drawer nobody is touching is not re-rendering
 * meaningfully.
 */
const CLOCK_TICK_MS = 15 * 1000;

interface LogCommunicationDrawerProps {
  /** The lead OR job this entry hangs off — exactly one, by construction (see ManualCommAnchor).
   *  On a CORRECTION this is where the entry currently sits, and switching it is what moves the
   *  entry between a lead and a job. */
  anchor: ManualCommAnchor;
  /** Set to correct an existing entry rather than record a new one. The entry itself is fetched
   *  here, by id, because the timeline item the row was rendered from is not enough to edit from
   *  (truncated notes; no duration, performer or subject). */
  entryId?: string;
  /** Seeds the DEFAULT list of the "attached to" picker with this customer's own open jobs and
   *  leads. Optional throughout: typing searches the whole organisation regardless, and a lead
   *  with no customer yet attached is one of the cases this feature exists for. */
  customerId?: string;
  /** What the "attached to" picker CALLS that customer. Optional: the arm still appears without
   *  it, reading "This customer", which is accurate on a surface that is already the customer's
   *  own page. A name is what makes it legible from a lead or a job. */
  customerName?: string;
  onClose: () => void;
}

/**
 * The shell: it decides whether this is a creation or a correction, and — for a correction —
 * holds the drawer open on a loading state until the stored entry has arrived.
 *
 * The form below is mounted only once its initial values exist, and is KEYED on the entry, so its
 * state is initialised from them rather than synchronised into them afterwards. An effect copying
 * a late-arriving prop into state is the shape that loses a keystroke typed while it was in
 * flight.
 */
/**
 * What the "Attached to" control calls the entry's CURRENT anchor, until the user moves it.
 *
 * Keyed by anchor kind and exhaustive over it, so adding a fourth anchor is a type error here
 * rather than a label that silently reads as one of the other three.
 */
const ANCHOR_LABEL: Record<ManualCommAnchor['kind'], string> = {
  lead: 'This lead',
  job: 'This job',
  customer: 'This customer',
};

export function LogCommunicationDrawer({ anchor, entryId, customerId, customerName, onClose }: LogCommunicationDrawerProps) {
  const existing = useManualCommunicationLog(entryId);

  if (entryId && !existing.data) {
    return (
      <Sheet
        open
        onOpenChange={(o) => {
          if (!o) onClose();
        }}
      >
        <SheetContent side="right" className="flex w-full flex-col gap-0 p-0 sm:max-w-md">
          <div className="border-b border-border px-4 py-3 pr-12">
            <SheetTitle className="text-sm font-semibold">Edit logged communication</SheetTitle>
            <SheetDescription className="text-[11px] text-text-secondary">
              Correct what was recorded about this conversation.
            </SheetDescription>
          </div>
          <div className="flex flex-1 items-center justify-center px-4 py-10 text-sm text-text-secondary">
            {existing.isError ? (
              <span className="text-danger">
                {extractApiError(existing.error, 'Failed to load this entry')}
              </span>
            ) : (
              <Loader2 className="h-4 w-4 animate-spin" aria-label="Loading" />
            )}
          </div>
        </SheetContent>
      </Sheet>
    );
  }

  return (
    <CommunicationEntryForm
      key={entryId ?? 'new'}
      anchor={anchor}
      entry={existing.data}
      customerId={customerId}
      customerName={customerName}
      onClose={onClose}
    />
  );
}

function CommunicationEntryForm({
  anchor,
  entry,
  customerId,
  customerName,
  onClose,
}: {
  anchor: ManualCommAnchor;
  entry?: ManualLogEntry;
  customerId?: string;
  customerName?: string;
  onClose: () => void;
}) {
  const editing = entry != null;
  const log = useLogCommunication(anchor);
  const save = useUpdateCommunicationLog(entry?.id ?? '');
  const remove = useDeleteCommunicationLog(entry?.id ?? '');
  const currentUserId = useAuthStore((s) => s.user?.id) ?? '';
  const { confirm, confirmDialog } = useConfirm();
  /**
   * WHICH CHANNEL this conversation happened over. Defaulted to a call rather than left blank:
   * a call is what every entry logged before this picker existed is, and an empty required
   * field the user must clear before saving would be a new obstacle in front of the commonest
   * case. Not deselectable, for the same reason - an entry with no channel is not a thing.
   */
  const [channel, setChannel] = useState<ManualCommChannel>(entry?.channel ?? 'call');
  const [direction, setDirection] = useState<'' | 'in' | 'out'>(entry?.direction ?? '');
  const [occurredAt, setOccurredAt] = useState(entry?.occurredAtLocal ?? '');
  /**
   * "NOW" AS A PIECE OF STATE, because it is one — see `occurredInFuture` for what reads it.
   *
   * `Date.now()` in the render body is an impure call (react-hooks/purity), so the clock has to
   * be captured somewhere. The obvious captures are both wrong here:
   *
   *   ONCE PER MOUNT (the repo's usual workaround, e.g. LeadDetailPage's `daysOpen`) freezes it.
   *   This drawer sits open while somebody types up their notes from memory, and TIME PASSING is
   *   itself enough to change the answer: the 08:47 user from the bug report who picks today,
   *   takes DateTimePicker's 09:00 default and then spends fifteen minutes writing would go on
   *   being refused a now-valid entry until they re-picked the date. The client guard would be
   *   stricter than the server it exists to explain, which is worse than not having one.
   *
   *   ONLY ON A PICK is the same freeze with extra steps — it re-reads on the one event that is
   *   NOT the one this gets wrong.
   *
   * So it ticks. The interval is the guarantee (the value can never be more than CLOCK_TICK_MS
   * stale, whatever the user does or does not touch); re-reading on a pick on top of that is not
   * required for correctness, it just makes the answer exact at the moment the question is
   * actually being asked, instead of up to fifteen seconds conservative.
   *
   * Staleness can only ever make this guard STRICTER, never more permissive — time moves a value
   * from future to past and never back — so the bounded lag cannot let a future entry through.
   */
  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNowMs(Date.now()), CLOCK_TICK_MS);
    return () => clearInterval(id);
  }, []);
  const pickOccurredAt = (next: string) => {
    setNowMs(Date.now());
    setOccurredAt(next);
  };
  const [notes, setNotes] = useState(entry?.notes ?? '');
  /**
   * WHO HAD THE CONVERSATION — defaulted to the signed-in user, which is right for a rep logging
   * their own call. The reason it is a PICKER at all is the other case: an onboarding admin
   * typing up months of conversations COLLEAGUES had, where recording the typist would credit the
   * wrong person on every entry the feature exists to capture.
   *
   * There is deliberately no counterpart for the logger. It is set from the authenticated
   * principal server-side and never sent from here: telling an eyewitness record from a
   * second-hand one is the point of keeping both, and a user able to choose the logger could
   * disown their own entry.
   */
  const [performedBy, setPerformedBy] = useState(entry?.performedBy ?? currentUserId);
  /**
   * HOW LONG THE CALL TOOK (slice 3) — optional, and meaningful only for a CALL, which the
   * channel picker above now makes a real condition rather than a description of every entry.
   *
   * Held as the raw STRING the field carries, not as a number: '' is a real state that must
   * survive round-tripping through the input, and it means "I don't know how long it was" — a
   * different fact from zero, so it is omitted from the body rather than sent as 0.
   */
  const [durationText, setDurationText] = useState(
    entry?.durationMinutes != null ? String(entry.durationMinutes) : '',
  );
  /** The subject line of a logged email (user story 15) — optional, like the one above. */
  const [subject, setSubject] = useState(entry?.subject ?? '');
  /**
   * WHICH LEAD OR JOB the entry hangs off — and, on a correction, the control that MOVES it
   * between the two.
   *
   * This is the only route: the shared timeline row's attach/move/detach menu drives a
   * call-record endpoint and is deliberately not extended to manual entries. Seeded from the
   * ENTRY's own anchor rather than from the tab's, so the two cannot silently disagree, and
   * falling back to the tab's when recording a new one.
   *
   * A `ManualCommAnchor` and not two optional ids, so "both" and "neither" are states this form
   * cannot express at all. Detaching is likewise not offered (see CommJobMenu's `allowDetach`):
   * an entry with no anchor could never be read back.
   */
  const [entryAnchor, setEntryAnchor] = useState<ManualCommAnchor>(
    entry?.jobId
      ? { kind: 'job', id: entry.jobId }
      : entry?.leadId
        ? { kind: 'lead', id: entry.leadId }
        : entry?.customerId
          ? { kind: 'customer', id: entry.customerId }
          : anchor,
  );
  /** What the picker says. Null until the user moves it — "this lead" / "this job" until then,
   *  because the entry arrived carrying ids and no labels, and inventing one would be a guess. */
  const [movedTo, setMovedTo] = useState<string | null>(null);
  const attach = useAttachTargets(customerId);
  /**
   * WHO IS OFFERED. Its own capability-scoped roster, not `GET /api/users`.
   *
   * That route is gated on `read User`, which SALES holds in no default grant and does not gain
   * by being allowed to log past communications — so the picker 403'd and rendered EMPTY for
   * exactly the role an admin had just granted the capability to, leaving them unable to credit
   * anyone at all, including themselves.
   */
  const performers = useManualLogPerformers();

  /**
   * Changing the channel CLEARS what the previous one asked, rather than hiding it.
   *
   * A duration typed against a call and then hidden behind an email is still in state, and would
   * still be sent — the API refuses that pairing, so the user would meet a 400 for a field they
   * can no longer see. Worse, if it ever landed it would render: the timeline builds its title
   * out of exactly these columns. Clearing says the honest thing — the answer no longer applies.
   */
  const pickChannel = (next: ManualCommChannel) => {
    if (next === channel) return;
    setChannel(next);
    setDurationText('');
    setSubject('');
  };

  const durationTyped = durationText.trim() !== '';
  const durationMinutes = durationTyped ? Number(durationText) : undefined;
  // A whole number of minutes, zero or more. The API refuses the same values independently — a
  // client guard is what stops the user meeting a raw 400, not what makes the rule true.
  //
  // The API's UPPER bound (a day) is deliberately NOT restated here. Duplicating it would put the
  // same rule in two places that can drift, and it is not a mistake a form can see coming the way
  // a minus sign is — the server names the offending field and `extractApiError` renders that
  // message verbatim, so an absurd value already reads as an explanation rather than as a 400.
  const durationInvalid =
    durationMinutes !== undefined &&
    (!Number.isInteger(durationMinutes) || durationMinutes < 0);

  /**
   * IT CANNOT HAVE HAPPENED YET. The API refuses the same value independently — this is what
   * stops the user meeting a raw 400, not what makes the rule true.
   *
   * ON THE ORG'S CLOCK, and only once that clock is KNOWN. `occurredAt` is a zoneless wall clock
   * (this form never converts one — see the module header), so answering "is it in the future?"
   * takes the organisation's zone. `useOrganization()` has not answered on first paint, and
   * `useScheduleTimezone()` would paper over that with an Eastern GUESS: a user in another zone
   * would then be blocked from saving a conversation that plainly already happened. So the guard
   * stands down until `org.timezone` is real, and the server refuses what slips through.
   *
   * The two-minute grace mirrors the API's own tolerance (FUTURE_TOLERANCE_MS there) so that the
   * form does not refuse a value the server would have taken. Two constants for one rule is a
   * drift risk, and the honest reading is that this one is a HINT: if it ever falls out of step
   * the server's answer is the one that decides.
   */
  const orgTimeZone = useOrganization().data?.timezone;
  const occurredAtIso = orgTimeZone ? pickerValueToIso(occurredAt, orgTimeZone) : undefined;
  const occurredInFuture =
    occurredAtIso !== undefined &&
    new Date(occurredAtIso).getTime() > nowMs + FUTURE_GRACE_MS;

  const complete =
    direction !== '' &&
    occurredAt !== '' &&
    notes.trim() !== '' &&
    !durationInvalid &&
    !occurredInFuture;

  // ONE set of values, sent by whichever mutation this is. The create and the correction describe
  // the same record, so building the payload twice would be two places for a field to be missed.
  const busy = log.isPending || save.isPending || remove.isPending;
  const submitError = editing ? save.error : log.error;
  const failed = editing ? save.isError : log.isError;

  const handleSave = () => {
    if (!complete || busy) return;
    const fields = {
      channel,
      direction: direction as 'in' | 'out',
      occurredAt,
      notes: notes.trim(),
      performedBy,
      durationMinutes,
      subject: subject.trim() === '' ? undefined : subject.trim(),
    };
    if (editing) {
      // The anchor rides the payload on a correction: switching it is what MOVES the entry
      // between a lead and a job, and the API enforces that exactly one is named either way.
      save.mutate({ ...fields, anchor: entryAnchor }, { onSuccess: onClose });
      return;
    }
    log.mutate(fields, { onSuccess: onClose });
  };

  /**
   * REMOVING AN ENTRY ASKS FIRST.
   *
   * The spec does not require a confirmation, and the API needs none - but this is the only
   * control on the drawer that destroys something, and what it destroys is prose somebody typed
   * out from memory, sometimes months after the conversation. There is no undo and no draft to
   * recover it from. Every other destructive action in this product confirms first, through this
   * same `useConfirm` dialog; a hand-typed record is not the place to make the exception.
   */
  const handleDelete = async () => {
    if (busy) return;
    const ok = await confirm({
      title: 'Delete this logged entry?',
      description:
        'The record of this conversation is removed from the timeline. This cannot be undone.',
      confirmLabel: 'Delete',
      tone: 'danger',
    });
    if (!ok) return;
    remove.mutate(undefined, { onSuccess: onClose });
  };

  return (
    <Sheet
      open
      onOpenChange={(o) => {
        if (!o) onClose();
      }}
    >
      <SheetContent side="right" className="flex w-full flex-col gap-0 p-0 sm:max-w-md">
        <div className="border-b border-border px-4 py-3 pr-12">
          <SheetTitle className="text-sm font-semibold">
            {editing ? 'Edit logged communication' : 'Log communication'}
          </SheetTitle>
          <SheetDescription className="text-[11px] text-text-secondary">
            {editing
              ? 'Correct what was recorded about this conversation.'
              : `Record a call, text or email that already happened, so the ${anchor.kind}\u2019s history is complete.`}
          </SheetDescription>
        </div>

        <div className="flex-1 space-y-4 overflow-y-auto px-4 py-4">
          {/* The channel, first: it decides which of the optional fields below even appear, so
              asking it after them would show a duration field to somebody logging an email.
              A toggle group and not a select - three options are shorter than the menu that
              would hide them. Both required rows use RequiredToggleGroup, which owns the
              re-click rule for both of them; see that module for why. */}
          <div>
            <Label>Channel *</Label>
            <RequiredToggleGroup
              variant="pill"
              value={channel}
              onValueChange={(v) => pickChannel(v as ManualCommChannel)}
              aria-label="Channel"
              className="mt-1"
            >
              {MANUAL_COMM_CHANNELS.map((c) => (
                <ToggleGroupItem key={c.value} value={c.value} variant="pill">
                  {c.label}
                </ToggleGroupItem>
              ))}
            </RequiredToggleGroup>
          </div>

          <div>
            <Label>Direction *</Label>
            <RequiredToggleGroup
              variant="pill"
              value={direction}
              onValueChange={(v) => setDirection(v as '' | 'in' | 'out')}
              aria-label="Direction"
              className="mt-1"
            >
              <ToggleGroupItem value="out" variant="pill">
                Outbound
              </ToggleGroupItem>
              <ToggleGroupItem value="in" variant="pill">
                Inbound
              </ToggleGroupItem>
            </RequiredToggleGroup>
          </div>

          {/* Not wrapped in FormField: DateTimePicker has no id prop of its own to receive
              fieldProps - same reason RecordPaymentDialog leaves its date field bare.
              clearable={false} because this field is required: the picker's X has no
              destination here except an invalid form the user must then re-fill, so the
              only thing it can do is undo work. Where the date really is optional - a
              task's Due Date, an inventory stage's Scheduled For, both persisted as null -
              clearing it means something, which is why the opt-out is per call site and not
              a removal of the button for everyone. */}
          <div>
            <Label>When did it happen? *</Label>
            <DateTimePicker
              value={occurredAt}
              onChange={pickOccurredAt}
              clearable={false}
              className="mt-1"
            />
            {/* Rendered here rather than through FormField for the reason the label above is:
                DateTimePicker takes no id, so the pattern component has nothing to associate. The
                `Text` element and its tone are FormField's own, so the two errors on this form
                read identically. */}
            {occurredInFuture ? (
              <Text as="p" size="xs" tone="danger" className="mt-1.5">
                This records a conversation that already happened — choose a time that has passed.
              </Text>
            ) : null}
          </div>

          {/* Not wrapped in FormField, and for the same reason as the field above: AssigneeSelect
              has no id prop to receive fieldProps, so its <Label> cannot be associated with the
              trigger. Hence the explicit ariaLabel - which the trigger needs regardless, because
              its visible text is the chosen PERSON and says nothing about what choosing them
              means. */}
          <div>
            <Label>Who had the conversation?</Label>
            <div className="mt-1">
              <AssigneeSelect
                value={performedBy}
                onChange={setPerformedBy}
                users={performers.data ?? []}
                ariaLabel="Who had the conversation?"
                placeholder="Select a colleague…"
              />
            </div>
          </div>

          {/* HOW LONG THE CALL TOOK — a call only. Optional even there, and it has no reading on
              the other two channels: a text has no length. Not merely disabled but ABSENT,
              because an empty field a user cannot fill is a question they still have to read and
              dismiss. The API refuses the same pairing independently - this is what stops the
              user meeting a 400, not what makes the rule true. */}
          {channel === 'call' && (
            <FormField
              label="How long did it last, in minutes?"
              optional
              error={durationInvalid ? 'Enter a whole number of minutes, 0 or more.' : undefined}
            >
              <Input
                type="number"
                min={0}
                step={1}
                inputMode="numeric"
                placeholder="e.g. 12"
                value={durationText}
                onChange={(e) => setDurationText(e.target.value)}
              />
            </FormField>
          )}

          {/* THE SUBJECT LINE — an email only (user story 15), and optional even there: somebody
              typing up months of history will not remember every subject, and an entry that says
              nothing about the header is a complete entry. */}
          {channel === 'email' && (
            <FormField
              label="Subject"
              optional
              hint="What the email was about."
            >
              <Input
                placeholder="e.g. Revised scope - two garage doors"
                value={subject}
                onChange={(e) => setSubject(e.target.value)}
              />
            </FormField>
          )}

          {/* ATTACHED TO — the move control, on a correction only. There is nothing to move until
              an entry exists, and on a creation the anchor is simply where the user clicked
              "Log communication". Rendered as the picker the rest of the timeline already uses,
              with its detach item suppressed: exactly one of a lead or a job is required, so
              "No job or lead" is not a state this entry can be in. */}
          {editing && (
            <div>
              <Label>Attached to</Label>
              <div className="mt-1">
                <CommJobMenu
                  jobs={attach.jobs}
                  leads={attach.leads}
                  search={attach.search}
                  onSearchChange={attach.setSearch}
                  querying={attach.querying}
                  needsMoreInput={attach.needsMoreInput}
                  loading={attach.loading}
                  allowDetach={false}
                  onPick={(pick) => {
                    if (!pick) return;
                    setEntryAnchor({ kind: pick.kind, id: pick.id });
                    setMovedTo(pick.label);
                  }}
                  /* THE THIRD DIRECTION (#2021). Without it the move is one-way: an entry could
                     be re-pointed OFF the customer onto a lead and never back, so a
                     mis-anchored entry was recoverable in two directions out of three. Offered
                     only where a customer is resolvable - on a lead with none attached there is
                     nothing to move to, and the arm simply does not appear. */
                  customerTarget={
                    customerId
                      ? { id: customerId, label: customerName ?? 'This customer' }
                      : undefined
                  }
                  onPickCustomer={(pick) => {
                    setEntryAnchor({ kind: 'customer', id: pick.id });
                    setMovedTo(pick.label);
                  }}
                >
                  <Button variant="outline" size="sm" aria-label="Attached to">
                    {/* One arm PER ANCHOR. A two-armed ternary over three kinds read "This job"
                        for a customer-anchored entry — naming a record it has no connection to,
                        on the one control whose whole purpose is to say where the entry lives. */}
                    {movedTo ?? ANCHOR_LABEL[entryAnchor.kind]}
                    <ChevronDown className="ml-1.5 h-3.5 w-3.5" />
                  </Button>
                </CommJobMenu>
              </div>
              <p className="mt-1 text-[11px] text-text-soft">
                Moving this entry to another lead, job or customer is how it changes hands
                &mdash; it always belongs to exactly one.
              </p>
            </div>
          )}

          <FormField label="Notes" required>
            <Textarea
              rows={5}
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder="What was discussed?"
            />
          </FormField>

          {failed && (
            <p className="text-sm text-danger">
              {extractApiError(
                submitError,
                editing ? 'Failed to save the correction' : 'Failed to log the communication',
              )}
            </p>
          )}
          {remove.isError && (
            <p className="text-sm text-danger">
              {extractApiError(remove.error, 'Failed to delete the entry')}
            </p>
          )}
        </div>

        <div className="flex items-center gap-2 border-t border-border px-4 py-3">
          {/* DELETE sits apart from the save pair, on the other end of the row: it is the one
              action here that cannot be undone, and putting it beside Cancel is how a mis-click
              destroys a record somebody typed. Offered only on a correction — there is nothing to
              remove until an entry exists. */}
          {editing && (
            <Button variant="ghost" tone="danger" onClick={() => void handleDelete()} disabled={busy}>
              {remove.isPending ? (
                <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
              ) : (
                <Trash2 className="mr-1.5 h-3.5 w-3.5" />
              )}
              Delete
            </Button>
          )}
          <div className="ml-auto flex items-center gap-2">
            <Button variant="ghost" onClick={onClose} disabled={busy}>
              Cancel
            </Button>
            <Button
              variant="solid"
              tone="business"
              onClick={handleSave}
              disabled={!complete || busy}
            >
              {(log.isPending || save.isPending) && (
                <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
              )}
              {editing ? 'Save changes' : 'Log communication'}
            </Button>
          </div>
        </div>
      </SheetContent>
      {confirmDialog}
    </Sheet>
  );
}
