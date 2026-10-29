# In-app notifications - manual QA checklist

Run on the ServWave demo after the 3 out-of-band SQL artifacts are applied (see "Pre-reqs").
Originally written for `feat/in-app-notifications`. Log in as each role in separate browsers or
tabs to verify scoping.

**Scope.** This is the manual pass, not the catalogue. The full per-verb matrix - all 61 verbs with
their family, timing, recipients and priority - is
`md_files/specs/notifications/notification-scenarios-reference.md`, and `VERB_RULES` in
`backend/src/services/notifications/templates.ts` is authoritative over both. What follows is the
subset worth walking through a browser, plus the checks that only a browser can make.

## The rules being tested

Every verb declares a **family**, which answers who the notification is for:

- **`involvement`** - you are attached to the record (assignee, watcher, owner, performer,
  participant, thread holder).
- **`duty`** - acting on it is your job, by role (dispatcher, admin, the rep who carries the
  customer). Nobody had to attach you.
- **`self`** - it is about your own account, or you asked for it.

And a **timing**, orthogonal to family: `event` (emitted at a call site, carrying an actor when a
signed-in person caused it and null when a webhook, a public door or a system detector did) or
`time` (emitted by a sweep, structurally never carrying one).

**Rule 0: never tell someone about their own action.** It reads *drop the actor when there is
one*, so it needs no branch: it is vacuous for every `time` verb and for every actorless `event`
path just as it is for a staff action. **The `self` family is the single named exception** - a
`self` verb reaches its recipient even when they appear to be the actor. That is a mechanism now,
not a convention: the resolver reads the family. Every check below names the family it exercises,
so a failure can be reported as "wrong family" rather than "wrong person".

## Pre-reqs (out-of-band - Ran applies before QA)
1. Apply migration `20260618000000_add_notifications_tables` (staging, then prod).
2. **Re-run** `backend/scripts/security/2026-06-15-keystone-rls-revoke.sql` so the 2 new tables get
   FORCE RLS and zero anon/authenticated grants (Data-API seal).
3. Apply migration `20260618000100_backfill_notification_grants` (staging, then prod).
4. Apply `backend/scripts/security/2026-06-18-notifications-realtime-rls.sql` and enable Supabase
   **Realtime Authorization (private channels)** on the project; confirm the frontend
   `VITE_SUPABASE_ANON_KEY` is the rotated key.

> NOTE: The create-job-from-lead and schedule-job re-point feature (bottom section) adds **no new
> migration** - it rides on the tables above.

## Core routing (verify each role sees ONLY its events)
- [ ] **Estimate approved** `estimate.approved` (`involvement`, `event`): the sales owner gets
  INTERRUPT (toast plus feed); the dispatcher gets a feed item PINNED under "Needs action" with a
  **"Schedule job"** button; the admin gets a plain feed item with no Schedule button. Sales reps
  who are not the owner, and technicians, see nothing. (The dispatcher and admin are riders on an
  `involvement` verb - the family names the commission owner, which is why a rep who owns nothing
  gets nothing.)
- [ ] **Deposit paid** `estimate.deposit_paid` (`involvement`, `event`, Stripe checkout): same
  recipients as approved; verify the 3 approval paths do NOT produce duplicate notifications
  (dedupe).
- [ ] **Job assigned** `dispatch.job_assigned` (`involvement`, `event`): the assigned techs get
  INTERRUPT; the assigning dispatcher does NOT (**Rule 0** - the actor is dropped); other
  dispatchers get a feed item.
- [ ] **Job started / completed / cancelled / reopened** `job.*` (`duty`, `event`): assignees plus
  dispatchers plus, if sold, the selling rep. `duty` rather than `involvement` because the
  constant across all four is the dispatcher's board - verify a dispatcher who is on none of these
  jobs still receives them.
- [ ] **Job created directly** `dispatch.job_created` (`duty`, `event`): dispatchers INTERRUPT,
  assignees INTERRUPT, admin feed. (This verb was once named `dispatch.urgent_job_created`; there
  is no urgent-job entity and the old name should appear nowhere.) A job created by converting an
  estimate raises no "job created" notification at all - verify that too.
- [ ] **Lead assigned / reassigned** `lead.*` (`involvement`, `event`): the new owner INTERRUPT;
  the previous owner gets "reassigned away"; an unassigned-created lead goes to admins and
  dispatchers as feed (`lead.unassigned_created` is `duty` - nobody is attached to an unowned
  lead, which is exactly why claiming it falls to a role).
- [ ] **Walkthrough scheduled** `lead.walkthrough_scheduled` (`involvement`, `event`): performers
  INTERRUPT, lead owner feed, dispatchers feed.
- [ ] **Payment received / partial / refund / dispute / chargeback / void / credit** `billing.*`
  (`duty`, `event`): admin plus dispatcher plus the owning rep (their customer). Refund, dispute
  and chargeback are admin INTERRUPT and are deliberately **not** pinned - the pin count reads the
  recipient row, and `resolveRecipients` sets no pin for those three.
- [ ] **OT override request** `team.ot_override_requested` (`duty`, `event`): admins only,
  INTERRUPT plus PINNED with **Approve / Deny** buttons.
- [ ] **Invite accepted** `team.invite_accepted` (`duty`, `event`): admins get a feed item, once,
  not on every subsequent login.
- [ ] **Inventory** `inventory.*` (`duty`, `event`): stock-approval-request goes to admins
  INTERRUPT plus Approve/Deny; a low-stock crossing (deplete an item below its `min` at a
  location) goes to admins and dispatchers as feed, on the downward crossing only, NOT on every
  movement and NOT on restock; backorder, po-partial, staging-ready and staging-no-area go to
  admins and dispatchers as feed. `inventory.low_stock` is emitted by a system detector with a
  null actor, so it fires no matter who made the movement - verify it still arrives for the person
  who depleted the stock.
- [ ] **Security self-notifications** `security.*` (`self`, `event`): sign in and YOU get a
  "new sign-in" feed item; change your password, enable or disable 2FA, and YOU get the
  corresponding item. No one else sees them.
- [ ] **The `self` exception, exercised directly.** This is the one case where the actor IS the
  recipient and must still be told. Change your own password while signed in, and confirm you
  receive `security.password_changed` even though you performed the action. If Rule 0 ever drops
  this, an attacker holding a session can silence the alert about their own break-in, so this
  check is not optional.
- [ ] **Invoice overdue / due-soon** `billing.invoice_overdue` / `billing.invoice_due_soon`
  (`duty`, **`time`**): the daily sweep, or triggered manually. Admins and the owning rep get a
  feed item PINNED with a **"Send reminder"** button. These are the two `time` verbs: nobody
  triggered them, so there is no actor for Rule 0 to drop and they must arrive for everyone the
  rule names, including whoever last touched the invoice.

## Engagement states
- [ ] Badge shows the **unseen** count in `bg-notify` red; opening the bell marks shown items
  **seen** and the badge clears to 0 immediately.
- [ ] Items stay visually **unread** (bold plus red dot) until clicked or "Mark all read"; clicking
  a row marks it read and deep-links to the entity.
- [ ] **Inline actions work end to end** (the frontend/backend contract area - verify each actually
  hits the backend):
  - [ ] "Schedule job" (estimate approved) navigates to the **lead** page and auto-opens the
    create-job estimate picker, pre-selected to that estimate. **I1 RESOLVED:** it does NOT mark
    itself done on click - it stays PINNED under "Needs action" until a job is actually created
    from that estimate (backend `resolveScheduleJobNotifications`). Legacy payloads without
    `lead_id` fall back to the estimate detail page and still stay pinned. See the dedicated
    section below.
  - [ ] "Approve" / "Deny" (OT) approves or rejects the punch; the row flips to done.
  - [ ] "Approve" / "Deny" (stock) decides the stock approval.
  - [ ] "Send reminder" (overdue invoice) resends the invoice; verify it does NOT 404 - this was
    the C1 fix, it now uses `object_id`.
  - [ ] After an action (except Schedule job), the row leaves "Needs action" and shows the done
    state.
- [ ] "Mark all read" clears bold and dots across the feed.
- [ ] "Show earlier" loads the next page of older notifications.

## Realtime (QA-WATCH - flagged in build)
- [ ] **Two tabs, same user**: trigger an event in tab A and tab B's badge and feed update within
  1 to 2 seconds (Supabase private-channel broadcast, then refetch).
- [ ] **Page reload while logged in**: confirm the realtime channel re-subscribes with a valid
  token (a private channel must authenticate). If broadcast silently fails, the window-focus
  refetch plus the 15s staleTime poll is the fallback - notifications still update on focus, just
  not instantly. If realtime proves troublesome, the SSE fallback (Task R3-alt) is the documented
  contingency.
- [ ] **INTERRUPT toast**: a new INTERRUPT notification fires a toast (destructive variant for
  security and needs-action items); FEED items never toast; no toast on page load for pre-existing
  items; no re-toast on refetch. `INTERRUPT` / `FEED` selects a delivery route, not an appearance.

## Channel ownership (added with ADR 0005)

All five are runnable. The two that were blocked on the legacy-step neutralisation are no
longer: `advanceEnrollment` skips a retired in-app step before dispatch (`enrollment.ts`,
`RETIRED_IN_APP_STEP_DETAIL`), `MESSAGING_STEPS` no longer contains it, and `executeAction` has
no in-app branch left to call. A failure on those two is now a regression and should be filed
as one.

- [ ] **The Automation Center offers no in-app step.** Open the workflow builder in both trees and
  confirm the step picker has no in-app or "notify the team" option, and that the prebuilt gallery
  installs no workflow containing one.
- [ ] **The Test receipt still arrives, and only to you.** Press **Test** with "send to me" ticked
  and confirm you get one `automation.message` bell row (`self` - you asked for the receipt) and
  that no one else in the org gets anything.
- [ ] **A legacy draft is visible and cannot be published.** For an org that still holds a
  pre-retirement in-app step: the automations list and detail page still load, the draft reports
  the issue "Step N no longer sends. In-app notifications now come from the bell, so remove this
  step to publish this automation." against that step - with N the step's own position, so the
  admin does not have to count bubbles - and publishing is blocked until it is removed. The
  generic "no longer supported" sentence is the WRONG copy here and seeing it is a regression. Runnable in both environments - prod
  holds 8 such draft steps across 2 orgs, staging holds 4. Nothing here needs the workflow enabled
  or triggered, so it does not depend on the neutralisation.
- [ ] **The same legacy draft is still editable, and SAVING is not blocked.** Publishing is the only
  blocked action. On that workflow edit a DIFFERENT step - retype the body of a text step - and let
  the builder autosave on blur: it must save. Duplicate the workflow from the list page too: the
  copy is created and carries the same issue rather than failing. A red "Could not save automation"
  toast is the failure, and one quoting an internal label such as `steps.1.step_type: Invalid enum
  value` is the specific regression this check exists for - the builder re-sends every step it
  loaded, so a write tier that refused the retired label would block every save on the workflow and
  would say so in the schema's words rather than the product's. Finish by deleting the in-app step
  and confirming the same automation then publishes with no other change.
- [ ] **A run does not ring the bell.** Enable a workflow, trigger it, and confirm the only things
  delivered are email and text. Nothing about the run appears in any recipient's bell. A workflow
  authored after the retirement cannot hold an in-app step at all, so the check only carries weight
  against a version published before it - see the next item, which is that case.
- [ ] **A published legacy version keeps running without ringing the bell.** An already-published
  version containing the retired step keeps running, with that step recording a skipped send
  reading "In-app notifications now come from the bell - this step no longer sends." in the
  Activity tab, instead of a bell row. Confirm the Activity tab never shows the words "Unknown
  action type", and that on a TECH_ASSIGNED workflow the reason is that one rather than
  "Technician is no longer assigned to this job". Prod has no exercisable case (8 draft steps
  across 2 orgs, every containing workflow disabled, 0 published versions, 0 runs ever);
  **staging has 1 published version containing the step, so this check must be run there.**

## Rule 0 in the Automation Center
- [ ] **Your own action does not email you.** With `default-estimate-approved-notify-creator`
  enabled, approve your own estimate and confirm you receive no email about it. Someone else
  approving the same estimate must still email you.
- [ ] **The wait does not defeat the rule.** Put a WAIT step ahead of the send, trigger it
  yourself, let the cron sweeper resume the parked enrollment, and confirm you still get no email.
  The actor rides `workflow_enrollments.event_payload`, so it must survive the park.
- [ ] **An audience emptied by the drop says so.** The step run records SKIPPED with plain-English
  copy in the Activity tab, not a failure and not a silent send to nobody. An audience that was
  already empty for its own reason keeps its own reason (an unassigned job still says nobody is
  assigned).
- [ ] Announce before QA, because these are seeded, enabled defaults and the change is visible: a
  technician who self-assigns stops getting the assignment email, a salesperson who schedules
  their own walkthrough stops getting theirs, and in a single-admin org every `all_admins` workflow
  stops emailing that admin whenever they were the one who acted.

## Mobile
- [ ] On a phone or narrow viewport, the bell opens a **bottom sheet** (not the desktop popover);
  content scrolls; comms chips remain separate.

## Isolation and security
- [ ] No role ever sees a notification for an entity it cannot access (a sales rep does not get
  notifications for another rep's lead or estimate). This is the fail-closed per-recipient access
  check, and it applies **after** the family has already named the recipient - a `duty` verb still
  loses a recipient who cannot see the row.
- [ ] Confirm the notification tables are NOT reachable via the Supabase Data API (anon or
  authenticated key): `select` on `notifications` / `notification_recipients` through the REST API
  must be denied.

## Create-job-from-lead and schedule-job re-point (2026-06-18)
- [ ] Lead page (admin or dispatcher): a sage **"Create Job"** button shows in the header. Sales
  does NOT see it.
- [ ] Click it and the modal lists the lead's estimates with status and amount. An APPROVED,
  un-converted estimate is selectable; "Create job" converts it and lands on `/jobs/:id`.
- [ ] An already-converted estimate shows its J##### and links to the job (not selectable). A
  non-approved estimate is shown but not selectable.
- [ ] No approved estimate: the modal explains "No approved estimate to convert yet" and
  "Create job" is disabled. "New estimate" (admin or sales) opens `/estimates/new?lead_id=...` and
  does NOT convert.
- [ ] Empty lead (no estimates): "No estimates yet"; "New estimate" is available to create one.
- [ ] **Notification re-point:** approve an estimate, and the dispatcher's "Schedule job"
  notification, when clicked, opens the **lead** with the picker pre-selected to that estimate (not
  the estimate page). The notification stays pinned under "Needs action".
- [ ] After actually creating the job from that estimate, the dispatcher's "Schedule job"
  notification leaves "Needs action" (resolved). The sales and admin informational copies are
  unchanged.
- [ ] A legacy notification with no `lead_id` still falls back to the estimate page.
- [ ] **Preselect hygiene:** after the deep link opens the modal pre-selected and you close it
  WITHOUT converting, the `?createJob=` param is gone from the URL; a hard refresh does NOT reopen
  the modal; clicking "Create Job" manually opens with a clean, non-stale selection.
