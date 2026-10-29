# Phase 3 — cutover: retire the hard-coded senders

**Status: DONE, PR open.** All three slices implemented, tested, and committed on
`feat/automation-migration-phase1`. PR: https://github.com/ranro1/ALPHA_CRM/pull/1003
(against `staging`). Post-merge seeder run and live staging verification are still
outstanding — see the PR checklist below.

**Owner ruling (2026-07-21):** migrate everything in the job workflow so admins control what the
platform sends on its own. Receipts, refunds, MFA, invites, roles/permissions stay hard-coded.

**Owner ruling (2026-07-27):** for the `JOB_SCHEDULED` / `JOB_RESCHEDULED` gate mismatch, take
**option 1 — narrow the dispatch** so the trigger fires exactly where the email sends today.

---

**Owner ruling (2026-07-27), on message content:** the merge fields are effectively the same across
all 13 — "no need to send any specific thing other than the text that we want to send to customers."
So the registry's ported subject/body is the whole deliverable. Do **not** open new merge-field work
during the cutover; if a body wants a field that does not exist for its trigger, cut the field from
the copy rather than extending the engine mid-slice.

## The hard rule

**Enable the default and delete the hard-coded sender in the same change.** Seeding a default while
the built-in still fires gives every customer two emails. This is the one sequencing mistake that is
customer-visible, so it is a rule, not a preference.

---

## Two decisions to make before writing code

Both are consequences of Phase 2 seeding `is_enabled: false`, which was correct then and is now in
the way.

### D1 — how does a seeded workflow become enabled?

`seedDefaultAutomationsForOrg` is idempotent by *skip*: if a row with that `(organization_id,
builtin_key)` exists it is left completely alone. So a workflow seeded disabled can never be turned
on by re-running the seeder. Something has to enable it.

**DECIDED (Ran, 2026-07-27): never seed disabled in the first place.** Nothing has been seeded on staging yet
(the migration isn't applied — see "Blocked on" below), so there is no back-fill problem to solve.
Ship all of Phase 3 as **one PR**, then run the seeder **once**, after it merges, with every entry
seeding enabled. No activation pass is ever needed and the skip-if-exists semantics stay honest.

Concretely: add `seed_enabled: boolean` to the registry entry type, set it `true` for the 13
migrated keys, and have the seeder write `is_enabled: def.seed_enabled` instead of a hardcoded
`false`. Keep a test asserting that an entry with `seed_enabled: false` really does seed disabled,
so the safety property is still expressed in code rather than by convention.

The alternative — ship slices as separate deploys and add an activation pass that enables a key only
if the org has never edited it — is more machinery and introduces a "has the org touched this?"
heuristic we would have to get right. Not worth it for a one-time cutover.

### D2 — the gap between deploy and seed

Between the deploy that removes the hard-coded senders and the moment the seeder runs, **no email
goes out at all** for these 13 events. On staging that is harmless. On the eventual promotion to
`main` it is not.

Options, in order of preference:
1. **Seed as part of the release, before the deploy that removes the senders.** Requires D1's
   "seed enabled" to be safe on its own — it is, because the seeded automation and the hard-coded
   sender would then briefly both fire (duplicates for minutes, rather than silence). Trade one
   failure mode for the other.
2. Run the seeder immediately post-deploy and accept a short silent window.
3. Make seeding automatic on boot. Rejected — a startup task that writes workflows to every org is
   too much hidden behaviour for the gain.

**DECIDED (Ran, 2026-07-27): (2) for staging. Prod sequencing is deliberately NOT decided now** — it
is a different risk conversation and staging will teach us things first. To stop that from
evaporating, it is carried as an explicit **open item in the PR body** (see checklist), to be
resolved before any `staging → main` promotion is opened. An unresolved risk written into the PR is
tracked; one held in conversation is lost the moment the session ends.

---

## Blocked on

`workflows.builtin_key` **does not exist on staging.** Verified read-only against the staging DB on
2026-07-27: the column is absent, and `_prisma_migrations` is missing both
`20260721140000_automation_removed_recipient_triggers` and `20260721150000_workflow_builtin_key`.
Staging's newest applied migration is `20260724000000_sales_estimate_read_scope_leadless` — it
tracks `staging`, as it should.

Both migration files exist on this branch, are idempotent and portable, and reach staging the normal
way: PR merges → Render `startCommand` runs `prisma migrate deploy`. **Do not hand-apply them via
Supabase MCP** — that puts staging's schema ahead of its code, and CLAUDE.md forbids running
`prisma migrate` from a worktree (local `.env` points at staging).

So the seeder run is a **post-merge step**, tracked on the PR (see checklist below).

---

## Correction found during implementation (2026-07-27): `assigned_team` is the wrong audience for TECH_ASSIGNED / WALKTHROUGH_PERFORMER_ASSIGNED

Verified while wiring slice 1: `assigned_team` resolves to `ctx.assignees`, which `context.ts` builds fresh from the **live, full crew** at execution time (`job.assignees` / `lead.walkthrough_performers`). But `TECH_ASSIGNED` and `WALKTHROUGH_PERFORMER_ASSIGNED` dispatch **once per newly-added person**. If `default-tech-assigned` / `default-walkthrough-performer-assigned` used `assigned_team`, adding one tech to a job that already has two would re-email BOTH existing techs "you have been assigned" — a real regression (repeat/incorrect notifications), not merely a content gap. The hard-coded senders they replace email only the one person just added.

**Conservative fix, following the precedent already in this codebase:** `removed_user` exists for exactly this shape of problem — "the automation needs the *specific individual the event concerns*, not whoever the live entity currently lists" — and resolves from `ctx.eventRecipient`, itself sourced from `event_payload.recipient` (already fully generic — see `context.ts:92,113`, `dispatch.ts:33-34`). Added a symmetric `assigned_user` key that reads the same `ctx.eventRecipient` field, legal only on `TECH_ASSIGNED` / `WALKTHROUGH_PERFORMER_ASSIGNED` (mirroring how `removed_user` is legal only on the two REMOVED triggers). `default-tech-assigned` and `default-walkthrough-performer-assigned` now specify `recipients: ['assigned_user']` instead of `['assigned_team']`. The dispatch sites now carry `eventPayload: { recipient: <the added user> }`, mirroring `dispatchTechUnassigned`.

This is infrastructure correctness (who the email goes to), not new merge-field content, so it does not conflict with the "no new merge-field work" ruling. Touches: `recipients.ts`, `catalog.ts`, `workflowValidation.ts`, `job.controller.ts`, `lead.controller.ts`, `defaultAutomations.ts`, and the two FE mirrors (`lib/api/workflows.ts`, `describeWorkflow.ts`).

## Slice 1 — jobs

Narrowing and cutover ship together. Narrowing alone would silently break any `JOB_SCHEDULED`
automation an org has already built, with nothing replacing it.

### 1a. Narrow the dispatch

In `backend/src/controllers/job.controller.ts`, the dispatch at **:1794-1801** currently fires on
`newStart && timeChanged`, regardless of crew. The emails are gated more tightly:

| | Dispatch fires | Email sends |
|---|---|---|
| `JOB_SCHEDULED` | `newStart && timeChanged && !existing.scheduled_start` | `existing.status === 'UNASSIGNED' && assignee_ids.length > 0 && scheduled_start` (`isFirstScheduleWithCrew`, **:1667**) |
| `JOB_RESCHEDULED` | `newStart && timeChanged && existing.scheduled_start` | `status === 'SCHEDULED' && assignee_ids.length > 0 && customer_scheduled_email_sent_at != null && scheduled_start && timeChanged` (**:1846-1853**) |

Make the dispatch conditions match the email conditions exactly. Tests must cover both directions:
a 0-crew first schedule dispatches **nothing**, and a reschedule of a job whose customer never got
the "scheduled" email dispatches **nothing**.

Leave a comment at the dispatch site naming *why* the conditions are duplicated — the next person
will want to simplify it, and the reason (parity with the message that used to be hard-coded) is not
recoverable from the code.

### 1b. Delete the senders, enable the defaults

Each sender has exactly one call site — verified 2026-07-27.

| builtin_key | Sender | Call site | Delete from |
|---|---|---|---|
| `default-job-scheduled` | `sendJobScheduledEmail` | `job.controller.ts:1826` | `email.ts:999` |
| `default-job-rescheduled` | `sendJobRescheduledEmail` | `job.controller.ts:1854` | `email.ts:1751` |
| `default-tech-assigned` | `sendJobAssignmentEmail` | `job.controller.ts:1558` | `email.ts:937` |
| `default-tech-unassigned` | `sendJobUnassignedEmail` | `job.controller.ts:1577` | `email.ts:973` |
| `default-job-en-route` | `sendTechnicianEnRouteEmail` | `job.controller.ts:2697` | `email.ts:2039` |

`sendJobAssignmentEmail` / `sendJobUnassignedEmail` are both called from `emailJobCrewDiff`
(`job.controller.ts:~1539`). If that helper does nothing else afterwards, delete the helper too
rather than leaving an empty shell — and remove its call sites and the now-unused imports at
`job.controller.ts:10`.

Check whether `customer_scheduled_email_sent_at` still has a purpose once `sendJobScheduledEmail` is
gone. If the only remaining reader was the reschedule gate — which after 1a lives in the dispatch
condition — it stays, but say so explicitly. Do not drop the column in this PR either way; a schema
change on a flag this load-bearing deserves its own slice.

## Slice 2 — walkthroughs

| builtin_key | Sender | Call site | Delete from |
|---|---|---|---|
| `default-walkthrough-scheduled` | `sendWalkthroughCustomerScheduledEmail` | `lead.controller.ts:1701` | `email.ts:1638` |
| `default-walkthrough-rescheduled` | same sender, reschedule path | `lead.controller.ts:1701` | — |
| `default-walkthrough-performer-assigned` | `sendWalkthroughPerformerAssignedEmail` | `lead.controller.ts:1516` | `email.ts:1674` |
| `default-walkthrough-performer-removed` | `sendWalkthroughPerformerRemovedEmail` | `lead.controller.ts:1534` | `email.ts:1699` |
| `default-walkthrough-completed` | `sendWalkthroughCompletedEmail` | `lead.controller.ts:1906` | `email.ts:1605` |
| `default-walkthrough-cancelled` | `sendWalkthroughCancelledEmail` | `lead.controller.ts:1976` | `email.ts:1570` |

### 2a. Narrow the dispatch — walkthroughs have the same mismatch as jobs

**Correction (2026-07-27):** an earlier reading of this plan claimed only jobs had a gate mismatch.
That was wrong, verified first-hand:

| | Dispatch fires (`lead.controller.ts:1668`) | Email sends (`:1699`) |
|---|---|---|
| `WALKTHROUGH_SCHEDULED` / `_RESCHEDULED` | unconditionally on any schedule | `send_email !== false` **and** `hasPerformers` (`:1614`) **and** customer has an email |

Same shape as jobs: a 0-performer walkthrough schedule fires the trigger but deliberately sends
nothing today (`:1700` — "suppress the state-4 0-performer case"). Narrow the dispatch to match,
with tests both ways, exactly as in slice 1a.

### 2b. Cutover

Three more things specific to this slice:

- **The cancellation reason.** `sendWalkthroughCancelledEmail` takes `reason` from
  `req.body.cancelled_reason`. The replacement automation reads it via `{{event.reason}}`, carried
  on `event_payload` (built in Phase 1E, already wired at `lead.controller.ts` cancel path). Verify
  end-to-end that a cancelled walkthrough's email actually renders the reason — this is the single
  most likely place for the migration to silently degrade.
- **Inconsistent suppression, now resolved.** `scheduleWalkthrough` honours `send_email: false`;
  `completeWalkthrough` and `cancelWalkthrough` ignore it. After migration the automation's
  enabled/disabled state is the switch. Decide whether `send_email: false` should suppress the
  *dispatch* too, or whether it becomes dead input — and if dead, remove it rather than leaving a
  flag that no longer does anything.
- `sendWalkthroughScheduledEmail` and `sendWalkthroughRescheduledEmail` are already dead (no
  callers). Delete them here.

## Cross-cutting — the per-request suppression flags

Two request-level "don't send this one" flags exist today with **no automation equivalent**. An
automation is on or off for the whole org; it cannot be waived for a single request. Decide these
deliberately in the slice that touches them — silently dropping either is a feature regression.

| Flag | Where | What it suppresses |
|---|---|---|
| `notify.email: false` (#361) | `job.controller.ts:279`, applied `:2001` | the assign popover's per-request toggle — suppresses **only** the added-crew assignment emails; removals stay unconditional |
| `send_email: false` | `lead.controller.ts:1692` | the whole walkthrough-scheduled email block. Honoured by `scheduleWalkthrough`; **ignored** by `completeWalkthrough` and `cancelWalkthrough` |

**DECIDED (2026-07-27): (a) — suppress the dispatch too, keeping behaviour exactly as it is today.**

These are **per-request** controls ("don't email on *this* assignment"), a different thing from the
org-level "should we ever send this" that the Automation Center owns. The owner's ruling that orgs
decide what goes out does not reach them: an org enabling the automation still wants the one-off
opt-out when they are handing the job to a tech standing in front of them. It is a one-line
condition, it preserves a control users already have, and it is trivially reversible later if the
toggles turn out to be unused.

Rejected: letting them become dead input. A switch in the UI that silently does nothing is worse
than either keeping it or removing it.

## Cross-cutting — test fallout of deleting the senders

Deleting a sender is not just deleting its own tests. Verified 2026-07-27 — nine test files
reference these twelve senders, and most use them as a **representative example** of some other
behaviour rather than testing the sender itself:

| Test file | Uses senders to test |
|---|---|
| `email-timezone.test.ts` | timezone rendering (job scheduled/rescheduled, en route) |
| `email-escaping.test.ts` | HTML escaping (job assignment, walkthrough cancelled) |
| `email-org-toggle.test.ts` | the org-level email kill switch (job assignment) |
| `comm-persist.test.ts` | communication-record persistence (job scheduled) |
| `assign-notify-options.test.ts` | the `notify` flag above (job assignment/unassignment) |
| `jobs.test.ts`, `leads.test.ts` | the controller paths themselves |

**Re-point these at a surviving hard-coded sender rather than deleting them.** Timezone rendering,
HTML escaping and the org kill switch are all still real behaviours after the migration — losing
their coverage because the example they happened to use went away is a silent coverage regression,
and the kind that does not show up as a failing test. Only `jobs.test.ts` / `leads.test.ts`
assertions that specifically assert "this sender was called" should be rewritten to assert the
dispatch instead.

Also update the global email mock in `src/__tests__/setup.ts` (it lists the senders explicitly at
`:193`, `:196`, `:202`) — a stale entry there is harmless, a missing one 500s any test that hits the
path, which is how the `sendTechnicianEnRouteEmail` gap surfaced in Phase 1.

## Slice 3 — estimates

| builtin_key | Sender | Call site | Delete from |
|---|---|---|---|
| `default-estimate-approved-notify-creator` | `sendApprovedNotification` | `estimate.controller.ts:2915` | `email.ts:724` |
| `default-estimate-declined-notify-creator` | `sendDeclinedNotification` | `estimate.controller.ts:3067` | `email.ts:914` |

Both are **internal, to the estimate creator** — not customer-facing. Lower blast radius than slices
1-2, but **not** free of behaviour change:

**`ESTIMATE_APPROVED` fires from three doors; the creator email sends from one.** Verified
2026-07-27 — dispatch sites at `:1967` (internal approve), `:2685` (`approvePublic`), `:3227`
(`waiveDeposit`), and the code comments confirm this is intentional ("dedupe collapses the 3 approval
paths"). But `sendApprovedNotification` is only reachable via `fireAndForgetApprovalEmails`, whose
sole caller is `:2695` inside `approvePublic`.

So enabling `default-estimate-approved-notify-creator` **starts notifying the creator on approval
paths where they are silent today** — internal approvals and deposit waivers.

**DECIDED (Ran, 2026-07-27): accept the wider notification. Do not narrow this dispatch.**
> "Since invoices and estimates can be sent as part of the workflow, that's okay. If someone wants
> to have another email sent, we should allow this thing for the organizations to decide."

The org's own enable/disable switch is the control; the current one-door asymmetry looks accidental
rather than designed. Note the change in the PR body so it is disclosed rather than discovered — but
do not spend a slice on strict parity here.

`ESTIMATE_DECLINED` has no such mismatch: one dispatch (`:3046`), one send (`:3067`), same handler.
The only gate is `creator?.email`, which the `creator` audience resolver reproduces naturally (no
address → no recipient).

`sendApprovedNotification` is called from `fireAndForgetApprovalEmails`
(`estimate.controller.ts:2891`), which also sends `sendApprovalConfirmationToCustomer`. **That
customer half is the subject of the separate duplicate-email fix**
(`md_files/plans/invoices/2026-07-27-duplicate-customer-emails-prompt.md`). Whoever lands second
rebases. Do not fix both in one PR — they are different problems and reviewing them together would
obscure both.

## Staying hard-coded — do not touch

- `sendEstimateEmail` / `sendEstimateWithDepositEmail` — a **hard gate**, not fire-and-forget: the
  estimate only flips `DRAFT→SENT` once the send is confirmed (`estimate.controller.ts:~1428`), the
  fix for the B&G bug named at `:1341-1345`. Routing this through a fire-and-forget automation
  reintroduces that bug. Also carries a PDF and a CC list, which `sendAutomationEmail` cannot do.
- `sendEstimateApprovedNotification` — exists to deliver the **signed PDF**. No attachment support.
- All receipts, refunds, deposit confirmations, payment alerts, POs, invites, MFA, timeclock.

Both estimate-send cases only fire when a human presses Send. Admins still control everything the
platform sends *on its own*, which is what the ruling asked for.

---

## Verification

Automated:
- Every deleted sender's tests are deleted or rewritten — not left asserting a function that no
  longer exists.
- New tests assert the **dispatch** fires with the right payload where the email used to send, and
  does **not** fire where it used to be suppressed (the 0-crew and never-emailed cases).
- Full backend + frontend suites, `tsc --noEmit` both workspaces, `npm run build` both.

Live, on staging after the seeder runs — automated tests cannot prove this part:
- Each of the 13 appears in the Automation Center, enabled, with sane copy.
- Schedule a real job → customer gets exactly **one** email, and it is the automation's.
- Cancel a walkthrough with a reason → the reason appears in the email body.
- Disable one automation → that email stops. This is the whole point of the migration; prove it.

---

## PR checklist

- [x] Base branch is `staging`, not `main` (CLAUDE.md rule 11)
- [x] No AI attribution in commits, title or body (rule 8)
- [x] PR body notes that **two migrations ship with it** —
      `20260721140000_automation_removed_recipient_triggers` and `20260721150000_workflow_builtin_key`
      — and that neither is on staging yet, so the deploy applies them
- [x] PR body carries the **post-merge step**, called out explicitly so it is not forgotten:
      `npm run automations:seed-defaults -- --dry-run` then without the flag, run once after
      Render finishes deploying
- [x] PR body states the behaviour change in plain terms: these 13 emails become org-editable
      defaults, and an org that disables one stops receiving it
- [x] PR body carries an **OPEN ITEM: prod cutover sequencing (D2), unresolved** — on staging we
      accept a short window where the senders are gone and the seeder has not run yet, so nothing
      sends. That is not acceptable in prod. Before any `staging → main` promotion is opened, decide
      whether to seed *before* the sender-removal deploy (brief duplicates) or *after* it (brief
      silence). Written here on purpose so it is resolved deliberately rather than discovered.
- [ ] Live verification above completed on staging **before** any promotion to `main` is opened
      — BLOCKED until the post-merge seeder step runs; not done in this PR.

PR: https://github.com/ranro1/ALPHA_CRM/pull/1003
