# Slice 07 — Notifications: scheduled, moved, cancelled

**Type:** AFK
**Blocked by:** Slice 06 — Member / Technician column placement via `participantUserIds`
**Spec sections:** §5, §7, §9 risk 3

## Superseded — the notify checkbox covers BOTH participant kinds (fix/ce-notify-all-participants)

Product-owner direction, 2026-08-25, after manual QA on staging: *"I noticed that only a customer
will be notified about this event. I actually wanted all participants to be notified."*

Everything below that scopes the EMAIL channel to CUSTOMER participants is superseded. As built:

- The notify checkbox is `Notify participants` and renders whenever the entry has **any**
  participant. `notify_customer` on the wire keeps its name (it is the house key every other
  notify door in `job.controller.ts` / `lead.controller.ts` uses) but governs both kinds — see
  `NotifyChangeArgs.notifyParticipantsEmail`.
- A USER participant is emailed at their own `User.email`, through the same three senders, with
  the same `classifyOutcome` diff. They carry **no** `TransactionalEmailRecord`: that anchor
  files mail against a customer conversation, and a teammate has none to join.
- The two channels stay asymmetric on purpose. In-app notices for teammates remain
  **unconditional** (as for every other domain event in the app); email of either kind is opt-in.
  Unticking the box quiets the mail, never the board.
- `POST /:id/notify-moved` covers both kinds and passes `suppressInAppNotice: true`, so the
  teammate's in-app "moved" notice still fires exactly once — on the PATCH the drag itself sends.
- The §5 copy is gone on the same direction (*"no need for more sentences or more description…
  No hints"*): the sub-line under the heading, the helper text under Message, the
  "Will be emailed:" recipient manifest, and the Title field's `Dave is off Thursday` placeholder.

Browser-verified against the staging DB by `frontend/e2e/specs/redesign/qa-notify-all.spec.ts`.

## What to build

Three outcomes, and **the sender selects by what actually changed — never by reading a status
value.** #1550 is the precedent: a moved job told the customer it had been "scheduled" because
the notification path checked `status === 'SCHEDULED'`. A Calendar Entry has no status column at
all, so the only correct selector is a diff of the previous and next `start`/`end`.

| Outcome | Content | Trigger |
|---|---|---|
| **Scheduled** | **Free text**, seeded from the entry's own title and description, editable in the send dialog before it goes | On create, per the notify checkbox |
| **Moved** | Short fixed system email stating the new time | On any `start`/`end` change |
| **Cancelled** | Short fixed system email | On delete |

**Where the mail comes from.** Three new senders in `backend/src/lib/email.ts`, mirroring the
existing `sendJobScheduledEmail` / `sendJobRescheduledEmail` / `sendJobVisitCancelledEmail`
trio, so they inherit `orgSendingIdentity`, the org-branded template and — critically — the
`replyTo` resolution those three already carry. A hand-rolled sender in the entries controller
would be the fifth place this app sends mail from, and the one that forgets Reply-To again
(#1594 → #1603 was exactly that outage).

**In-app notifications for user participants** go through
`backend/src/services/notifications/notificationService.ts`'s `emit()` — new verbs
`calendar_entry.scheduled` / `calendar_entry.moved` / `calendar_entry.cancelled` registered in
`templates.ts` (`renderTemplate` throws for an unregistered verb and `isKnownVerb` silently
skips it, so an unregistered verb is a silent no-op, not an error) and resolved in
`resolveRecipients.ts` to the entry's user participants. `emit()` never throws — a failed
notification must not break the create/update/delete.

**Address for customers: `Customer.email`**, the legacy scalar, matching
`estimate.controller.ts` and every other sender. `customer_emails` has no `is_primary` and
nothing sends from it; that inconsistency is a real defect but it is **its own change** and must
not ride in on this feature.

**No email on file:** attach the customer anyway — the participant row is what puts the entry on
their customer page — and disable the notify checkbox with the text "no email on file".

**The checkbox rules** (§5, corrected post-implementation review — the original wording below
described only the *Moved* branch and silently dropped *Scheduled*, which under-notified §1's own
primary use case; see the implementer's report for the concrete defect this produced):

- It re-appears on **every** save and is **one decision for the whole entry** — it governs whether
  any customer email is attempted, not who receives one. *Who* gets *what* is decided per
  participant by the diff (`notify.ts`'s `classifyOutcome`): never-notified → *Scheduled*;
  notified before + time changed → *Moved*; notified before + time unchanged → nothing.
- **Pre-ticked when at least one current customer participant would receive something** — i.e.
  when at least one participant's outcome is not "none". This is `!notified_at || timeChanged`
  per participant, ORed across the customer participants — **not** `timeChanged && notified_at`,
  which has no branch for "never notified" and defaults OFF for exactly the case that most needs
  it (attach one pre-lead customer, save, say nothing else).
- **Accepted limit:** the checkbox is all-or-nothing across customer participants — there is no
  per-recipient suppression in v1. With two or more customer participants the dispatcher cannot
  email one and deliberately withhold the other on the same save. This is a capability gap, not a
  correctness bug, because `classifyOutcome` runs inside the send loop regardless of the flag:
  whoever the flag does reach always gets the *right* template. Deferred until asked for; the
  additive path is `notify_participant_ids: string[]` replacing `notify_customer`.
- **Deleting prompts** "notify participants?", pre-ticked for customer participants, unticked for
  user participants.
- `notified_at` is stamped on the participant row on a successful send. It is per-participant, so
  a customer added to an existing entry gets the *scheduled* email on the next save, not *moved*.

**No `EmailTemplate` table and no template settings screen** (§5). Free text where it is genuinely
free, fixed wording where it is genuinely fixed. The cost is that an org cannot reword or brand
the moved/cancelled notices; that is accepted, and unwinding it later costs no migration.

**No CC field** (§5). The job/walkthrough doors carry `notify_cc_emails` because they address
exactly one customer; an Event addresses 0..N across up to N separate sends, where CC has no
coherent meaning (copy every send = near-duplicates; copy only the first = arbitrary). The
participant model already is the mechanism — "should also hear about it" is just another
participant. The three new senders in `lib/email.ts` therefore take **no `cc` parameter at all**
(a prior draft of this doc's own commit message claimed they inherit "the CC path" from the
`sendJob*` family — they don't; they inherit Reply-To and org branding, not CC).

The send dialog does **not** reuse `frontend/src/pages/v2/_shared/notifyComposeFields.tsx` /
`NotifyCompose` verbatim — that shape assumes exactly one overridable recipient ("To" + CC),
which doesn't fit "0..N customer participants, address always pinned to `Customer.email`, never
overridable" (§5's own address rule). It is a purpose-built block in `eventEntryDialog.tsx`
instead, so nothing here grows a second compose surface for a shape the shared component was
never designed to hold.

## Acceptance criteria

- [ ] A backend test proves template selection is driven by the **diff**: `PATCH`ing only
      `description` on an entry whose participants were previously notified sends **nothing**;
      `PATCH`ing `start` sends the *moved* mail; creating sends the *scheduled* mail. No code path
      reads a status value to pick a template — grep the controller for `status` and find nothing.
- [ ] The *scheduled* mail body is the composer's free text and defaults to the entry's title and
      description; the *moved* and *cancelled* bodies are fixed strings the caller cannot supply.
- [ ] All three senders set `replyTo` — asserted on the dispatch payload, the way the existing
      job-email tests do. This is the one assertion that would have caught #1594.
- [ ] A customer participant with a null/empty `Customer.email` is still saved as a participant,
      and the notify checkbox for them renders disabled with "no email on file"; no send is
      attempted for that address.
- [ ] `notified_at` is stamped per participant on success and left null on a send failure.
- [ ] The checkbox pre-tick matrix is covered: never notified + time unchanged → **ticked**
      (the corrected primary-use-case rule); never notified + time changed → ticked; previously
      notified + time changed → ticked; previously notified + time unchanged → unticked (the
      checkbox still appears, just unticked).
- [ ] Delete prompts, pre-ticked for customers and unticked for users, and cancelling the prompt
      still deletes (the prompt governs the email, not the delete).
- [ ] `emit()` failure is swallowed: a `notificationService` throw does not fail the request.

## Out of scope for this slice

- `.ics` attachments. §8: an .ics that cannot be updated or cancelled properly leaves a stale
  copy in the customer's own calendar that you can never reach.
- Any `EmailTemplate` model or settings screen.
- RSVP / accept / decline — nothing about an entry is a question put to anyone.
- The drag-triggered notify toast — Slice 08 (it reuses this slice's *moved* path).
- Fixing `customer_emails` / `is_primary`.

## Verification

`cd backend && npm test -- calendar-entries` (extended) plus the new notification test file, and
`cd frontend && npm test -- eventEntryDialog`. On staging, using a `delivered+...@resend.dev`
blackhole address as the customer email: create an Event with the box ticked and confirm the
*scheduled* mail arrives org-branded with a working Reply-To; edit only the description and
confirm nothing sends; move it an hour and confirm the *moved* mail; delete it and confirm the
*cancelled* mail. Confirm the user participant's bell shows three in-app rows and no email.
