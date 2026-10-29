# Calendar Entries ("Events") on the scheduler

**Date:** 2026-08-24
**Status:** Design locked, not started
**Glossary:** [CONTEXT.md](../../../CONTEXT.md) — *Calendar Entry*, *Participant*
**Decision record:** [ADR 0002](../../../docs/adr/0002-calendar-entries-sit-on-the-board-without-joining-the-assignment-model.md)

---

## 1. What this is

A `CalendarEntry` — shown to users as an **Event** — is something on the scheduler that is not the
work itself: a meeting with a customer who is not yet a lead, a reminder, a birthday, a day off.
It is anchored to no lead, no job and no estimate, produces no revenue and moves no pipeline.

Two use cases drove it:

1. **A pre-lead customer meeting.** A user meets someone before any lead or job exists. A user
   participant runs the meeting; the customer is attached and emailed.
2. **An org-wide notice.** "Dave is off Thursday." Nobody is attached — the title carries it — and
   it exists so dispatchers see it on the board.

The name is split deliberately: users read **"Event"**, code says **`CalendarEntry`**, because
`TimelineEvent`, `StripeEvent`/`CtmEvent`/`AssetEvent` and the scheduler's own
`SchedulableEvent`/`BoardEvent`/`EventType` already claim the word four times over.

## 2. Data model

```
model CalendarEntry {
  id, organization_id, title, description,
  start, end, is_all_day,
  rrule String?, recurrence_until DateTime?,   // RESERVED — written null, never read in v1
  created_by, created_at, updated_at
}

model CalendarEntryParticipant {
  id, calendar_entry_id, kind (USER | CUSTOMER), user_id?, customer_id?, notified_at?
}
```

- **One entry spans multiple days.** `start` + `end` + `is_all_day`; "Dave is on vacation Mon–Fri"
  is one row rendering as one continuous bar, not five rows.
- **Participants are optional and mixed.** One field, users and customers together, 0..N of each.
  A zero-participant entry is normal and expected.
- **The creator is not a participant.** `created_by` is a plain column. Auto-attaching the creator
  would put a card in a dispatcher's own column for every entry they type on someone else's behalf.
- **No record number.** `SchedulableEvent.number` is required by the board interface, so the
  adapter passes `''` and the card renders the title alone. Minting `E00012` would mean hooking
  into the record-ID/renumber machinery for an entity nobody will quote over the phone.
- **Recurrence columns ship null and unread.** Birthdays are annual and someone will ask. Two
  nullable columns in the first migration make recurrence an additive change later instead of a
  migration against live rows. See §8 for why recurrence itself is out.

## 3. Board behaviour

Everything here is **additive** to [scheduleModel.ts](../../../frontend/src/components/schedule/scheduleModel.ts).
Job and walkthrough behaviour must stay byte-identical; the existing `scheduleModel.test.ts` suite
is the proof. No schema change to `Job` or `Walkthrough`, no touching their controllers.

| Surface | Behaviour |
|---|---|
| `EventType` | gains `'calendar-entry'` |
| `EVENT_TYPE_META` | new entry with a **muted** scheme — reads as "on the calendar", not "assigned work" |
| Standard view | all entries appear; all-day ones ride the existing all-day strip (`allDayAccessor`) |
| Member / Technician view | an entry appears in a member's column **iff a user participant matches that column**. Otherwise it does not appear in member views at all — those views answer "what is this person doing", not "when is Dave off" |
| `isOnBoardFor` | `crew.includes(id) \|\| (participantUserIds ?? []).includes(id)` — participants are added as a *separate* field, never folded into `crew` |
| `eventDangerState` | early `return null` for calendar entries. Without it every entry paints red as state 4 "needs assignment", because every entry has an empty crew |
| `conflictedEventIds` | entries excluded on **both** axes — an entry neither reports a double-booking nor causes one |
| `isAllDayEvent` | new branch reading `raw.is_all_day` |
| Plan Mode | entries excluded entirely. No ghosts, no draft state; "schedule all drafts" never touches them |
| Drag | draggable, direct save, **no** `RescheduleConfirmDialog` and no crew prompt. Followed by a non-blocking "notify participants of the new time?" toast — see §5 |
| Schedule search | entries match on **title** |

**The deliberate consequence:** attaching Dave says nothing about Dave's availability. A dispatcher
can book a real job over an entry naming Dave and the board shows no warning. This is intended;
the reasoning and the rejected alternative are in ADR 0002.

## 4. Permissions

- New permission subject **`CalendarEntry`** (read / create / update / delete) in
  [catalog.ts](../../../backend/src/lib/permissions/catalog.ts) and
  [defaultGrants.ts](../../../backend/src/lib/permissions/defaultGrants.ts).
- **Default grant: ADMIN + DISPATCHER.** A SALES user who needs it gets it through
  `UserPermissionOverride`, not by role.
- **Visibility is org-wide.** No private flag. Every example the feature exists for — PTO,
  birthdays, a client meeting — exists so other people see it. A private event is a `Task` with
  extra steps, and Tasks already exist (and are private by default, per
  [tasks/visibility.ts](../../../backend/src/lib/tasks/visibility.ts)).
- **Drag is gated by the same grant**, not by `boardCapabilitiesFor` — that returns
  `readOnly: false` for SALES, who must not be able to drag an entry they cannot create.
- ⚠️ **Grants live in `role_permissions` per organization.** The migration must **backfill every
  existing org** or nobody gets the grant. This has already bitten this project once, with the
  DISPATCHER `renumber` grant.
- **Not gated by plan tier.** Part of the core scheduler for every tier.

## 5. Notifications

Three outcomes, and the sender must select by **what actually changed** — never by reading a
status value. Issue #1550 is the precedent: a moved job told the customer it had been
"scheduled" because the notification path checked `status === 'SCHEDULED'`.

| Outcome | Content | Trigger |
|---|---|---|
| **Scheduled** | **Free text**, seeded from the entry's own title and description, editable in the send dialog before it goes | On create, per the notify checkbox |
| **Moved** | Short fixed system email stating the new time | On any `start`/`end` change, incl. drag |
| **Cancelled** | Short fixed system email | On delete |

- **The checkbox re-appears on every save, and is one decision for the whole entry** — it
  governs whether any customer email is attempted, not who receives one. *Who* receives *what* is
  decided per participant, by the diff: someone who has never been emailed about this entry gets
  **Scheduled**, someone who has gets **Moved** only if the time changed, and someone whose state
  didn't change gets nothing. A single save can legitimately send a Scheduled to one participant
  and a Moved to another in the same request.
- **Pre-ticked when at least one current customer participant would actually receive something** —
  anyone who has never been notified (they would get *Scheduled*), or who was notified before and
  whose time just changed (*Moved*). A description typo pre-ticks nothing, because every
  participant classifies to "none" (unchanged time, already known). Note this is **not** "time
  changed AND previously notified" — that AND has no branch for a participant hearing about the
  entry for the first time, and silently drops spec §1's own primary use case (attach a single
  pre-lead customer, change nothing else) to unticked.
- **Accepted limit: the checkbox is all-or-nothing, not per-recipient.** With two or more customer
  participants, the dispatcher cannot email one and deliberately not the other on the same save —
  untick the whole box, or send twice (add the second participant on its own save). This is a
  capability gap, not a correctness bug: the outcome classifier runs per participant regardless of
  the flag, so whoever *does* get mail always gets the *right* mail. Multi-customer entries are the
  tail case; if per-recipient suppression is ever asked for, it arrives as
  `notify_participant_ids: string[]` replacing `notify_customer`, additively.
- **Deleting prompts** ("notify participants?"), pre-ticked for customer participants, unticked
  for user participants.
- **Route through [notificationService](../../../backend/src/services/notifications/notificationService.ts)**
  rather than a bespoke sender — that is where templates, `Notification`/`NotificationRecipient`
  rows and the Reply-To fix live. A hand-rolled sender in the entries controller would be the
  fifth place this app sends mail from, and the one that forgets Reply-To again.
- **Address: `Customer.email`** — the legacy scalar, matching
  [estimate.controller.ts:1954](../../../backend/src/controllers/estimate.controller.ts:1954) and
  every other sender. `customer_emails` has no `is_primary` and nothing sends from it; that
  inconsistency is a real defect but it is **its own change** and must not ride in on this feature.
- **No email on file:** attach the customer anyway — the participant row is what puts the entry on
  their customer page — and disable the notify checkbox with "no email on file".

### Why there is no CC field

The job and walkthrough doors carry `notify_cc_emails` because they address exactly one customer,
and CC is the only way to also copy someone else in on that one send. An Event addresses 0..N
customer participants across up to N separate sends, where CC has no coherent meaning: copying the
list on every send produces N near-duplicate emails landing in one person's inbox, and copying it
on only the first send is arbitrary — neither reading is better than doing nothing. Events don't
need the workaround anyway: the thing CC approximates is "this person should also hear about it",
and here that already has a real answer — they are just another participant. The accepted cost is
that someone who is neither a `User` nor a `Customer` record (an external assistant, a spouse at a
different address) cannot be copied in; the same limit already exists everywhere else a participant
model, not a CC field, is the way to add a recipient.

### Why there is no template settings screen

The stated reason for wanting editable templates was "so they don't need to repeat themselves". The
*scheduled* email has nothing to repeat: the entry's title and description **are** the email, and
they are different every time. The *moved* and *cancelled* emails are system facts nobody wants to
hand-write — and forcing free text there means a dispatcher skips the compose step and the customer
never learns the time changed, which is #1550 arriving through the UI instead of through a status
check. So: free text where it is genuinely free, fixed wording where it is genuinely fixed, and no
`EmailTemplate` table in v1.

Unlike the recurrence columns, deferring this costs nothing to unwind — there is no migration to
regret. If orgs later want their own voice on the reschedule wording, `EmailTemplate` arrives then,
as its own project, and picks up the rest of [email.ts](../../../backend/src/lib/email.ts) with it.
The one thing v1 loses: an org cannot reword or brand the moved/cancelled notices.

## 6. Customer page

Attaching a customer participant makes the entry visible on that customer's page.

Requested shape: **one combined "Schedule" tab** listing jobs, walkthroughs and events for that
customer together, rather than making the user jump between tabs to see what is booked with a
client. This is read-only aggregation — no schema change to jobs or walkthroughs — but it is its
own slice and should not block the rest of the feature.

## 7. UI constraints

- **The participants field is one field.** Users and customers in the same picker.
- **A customer is picked as a customer.** No contact drill-down, no email picker, no "which person
  at the company". `kind = COMPANY` gets no special handling. None of this is exposed in the
  frontend — do not build a half-finished contact surface.
- **Pre-lead prospects** are handled by reusing
  [CustomerPickerWithCreate](../../../frontend/src/components/crm/CustomerPickerWithCreate.tsx) /
  [PickOrCreateCustomer](../../../frontend/src/components/crm/PickOrCreateCustomer.tsx) — create the
  customer inline from the participants field. **No free-text participants**: they would be a second
  contact concept that never links up when that person does become a customer.
- **Delete is a hard delete**, behind a warning, with the cancellation email to customer
  participants.

## 8. Explicitly out of scope

- **Recurrence.** Columns reserved, never read. Birthdays are re-created annually in v1.
- **`.ics` attachments.** An .ics that cannot be updated or cancelled properly leaves a stale copy
  in the customer's own calendar that you can never reach. Later, with `SEQUENCE`/`METHOD:CANCEL`
  handled properly, or not at all.
- **`EmailTemplate` / template settings screen.** See §5.
- **A `blocks_availability` flag.** The escape hatch if ADR 0002 proves wrong — not v1.
- **Walkthrough all-day.** `Walkthrough` has no `is_all_day` column; `isAllDayEvent` fakes it with
  `duration >= 1440`. A real gap, but fixing it means a schema change and touching the lead
  pipeline's read paths.
- **RSVP / accept / decline.** Nothing about an entry is a question put to anyone.
- **Private events.** See §4.

## 9. Risks and sequencing

1. **Rendering-path collision.** Entries use `start`/`end` + `is_all_day` on the same all-day strip
   and the same react-big-calendar config as the multi-day work happening in a separate session.
   **Sequence them; do not run both at once.**
2. **The per-org grant backfill** (§4) is the most likely thing to ship broken and be invisible in
   testing, because the developer's own org will have the grant.
3. **Template selection by status** (§5) is the #1550 trap. Select by what changed.
4. **The muted card is a soft lie.** A dispatcher seeing a 2–3pm card in Dave's column will read it
   as "Dave is busy" even though nothing blocks. Accepted knowingly; the mitigation is purely
   visual distinctness.

## 10. Suggested vertical slices

1. Model + migration (incl. reserved recurrence columns + **per-org grant backfill**) + CRUD API,
   permission-gated.
2. Board read path: adapter, `EVENT_TYPE_META`, the three guards, Standard view rendering.
3. Create/edit UI: the entry dialog, one participants field, `CustomerPickerWithCreate` reuse.
4. Member/Technician column placement via `participantUserIds`.
5. Notifications: three outcomes, send dialog, delete prompt.
6. Drag + notify toast; Plan Mode exclusion.
7. Schedule search by title.
8. Combined customer Schedule tab.
