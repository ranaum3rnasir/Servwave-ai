# Multi-visit scheduling for jobs and leads

**Status:** scoped, not started. Spec only - no code written.
**Parent issue:** SERV10X-66 (Servwave 10X Readiness, milestone 11).
**Absorbs:** SERV10X-36 (duplicate), SRVW-57 (Walkthrough -> Visit rename, delivered here).
**Author:** scoping session with Ran, 2026-08-17.

---

## Problem Statement

A contractor's work does not always fit in one trip, but ServWave only lets a job or a lead
hold one.

A concrete install needs three visits days apart: pour, wait three days, come back and
finish. A salesperson may need two or three trips to a site before they know enough to write
an estimate. A repair turns out to need a part that arrives Thursday.

Today each of those is a single date and time on the parent record, so the office has two bad
options: overwrite the first trip's schedule with the second, losing the record of what
actually happened and silently telling the board and the customer the wrong thing, or fake
the second trip as a whole separate job, which splits one piece of work across two estimates,
two invoices and two customer conversations.

The knock-on effects show up everywhere the office looks. The job page's progress bar has one
"on site" step, so a three-trip job can only ever show one arrival. "How long did this job
take" is unanswerable. The customer gets one confirmation email and then silence, or a
reschedule notice that refers to "your job" when only one of three appointments moved. Crew
is attached to the job rather than to the trip, so the two techs who poured the concrete are
still listed as the crew for the finish work three days later, whether or not they are the
ones going.

## Solution

A **visit** becomes a first-class thing: one occurrence of people going to a site.

A job or a lead can hold any number of visits. Each visit carries its own date and time, its
own crew, its own arrival and completion timestamps, and its own notes. The parent stays
whole - one job, one estimate, one deposit, one invoice, one customer relationship.

From the office's side:

- Schedule a job with three visits up front, or with one and add two more mid-job. No cap, no
  ordering rule, no separate "add recurrence" mode.
- The job page lists its visits and shows the next upcoming one in the hero.
- The progress bar grows a node per visit: Job Created -> Visit 1 -> Visit 2 -> Visit 3 ->
  Completed -> Invoice Sent -> Payment Received.
- A job is in progress from the moment any visit starts, and stays that way until a human
  marks it complete. Finishing the last visit does not close the job on its own, because only
  the office knows whether a fourth trip is coming.
- Cancelling a visit unschedules that trip. It does not cancel the job.

From the crew's side: a technician sees the visits they are on, not the jobs someone else is
covering, and starting the visit they are standing at is one button.

From the customer's side: one email per visit, so three trips means three confirmations, and
a reschedule notice names the trip that moved rather than "your job".

The same machinery serves lead walkthroughs, because a walkthrough is a visit - the only
difference is its parent and its purpose. That retires the word "walkthrough" from the
platform.

## User Stories

**Creating and shaping visits**

1. As a dispatcher, I want to add a second visit to a job that is already scheduled, so that
   a two-day install lives on one job instead of two.
2. As a dispatcher, I want to add a third and fourth visit to a job whose first visit has
   already been completed, so that discovering more work mid-job does not force me to start
   over.
3. As a dispatcher, I want to schedule three visits at the moment I create the job, so that a
   known multi-day sequence is booked in one sitting.
4. As a dispatcher, I want no limit on how many visits a job holds, so that the software does
   not decide for me how long a job takes.
5. As a dispatcher, I want to create a job with no visits at all, so that I can capture work
   that is not ready to be scheduled.
6. As a salesperson, I want to book a second trip to a site on the same lead, so that a
   two-visit sales process does not need a duplicate lead.
7. As a salesperson, I want a lead to hold several live walkthrough visits at once, so that I
   can pre-book the follow-up while I am still on site for the first.
8. As an office manager, I want each visit labelled by a stable number ("Visit 2"), so that
   the label in a customer's inbox still means the same trip a week later.
9. As an office manager, I want visits displayed in time order but numbered in creation
   order, so that inserting an earlier trip does not renumber a visit the customer has
   already been told about.

**Crew**

10. As a dispatcher, I want to assign a different crew to each visit, so that the two techs
    who pour concrete are not automatically the ones who come back to finish.
11. As a dispatcher, I want to see the union of everyone who worked a job across all its
    visits, so that "who touched this job" is still one question with one answer.
12. As a dispatcher, I want a warning when I book a tech onto two overlapping visits, so that
    I catch the clash myself.
13. As a dispatcher, I want that warning to name the other job or lead, so that I can decide
    which one moves.
14. As a dispatcher, I want the double-booking warning never to block the save, so that a
    real-world scheduling call does not get pushed out of the software and into a text
    message.
15. As a salesperson, I want lead ownership to stay separate from who attends a walkthrough
    visit, so that sending a colleague to a site does not hand them my lead.

**Lifecycle**

16. As a technician, I want to start the visit I am standing at with one button, so that the
    office sees my arrival without me having to find the right job first.
17. As a technician, I want any member of the visit's crew to be able to start it, so that
    the trip is not blocked on one person's phone.
18. As a dispatcher, I want to start or complete a visit on the crew's behalf, so that a dead
    phone or no signal does not lose the record.
19. As an office manager, I want completing the last visit not to complete the job, so that
    the job stays open when I already know another trip is coming.
20. As an office manager, I want to mark the job complete explicitly, so that closing the job
    is a decision rather than a side effect.
21. As an office manager, I want a job with no visits to read "unscheduled" rather than
    "cancelled", so that work waiting to be booked is not confused with work called off.
22. As an office manager, I want a job to read "in progress" from the moment any visit
    starts, so that the board reflects that work has begun regardless of which trip it was.
23. As an office manager, I want to reopen a completed job, so that a callback does not need
    a new job record.
24. As a dispatcher, I want to cancel one visit and leave the rest of the job intact, so that
    a single postponed trip does not disturb the schedule around it.
25. As a dispatcher, I want cancelling the job to cancel its outstanding visits, so that
    nothing is left on the board for work that is off.
26. As a dispatcher, I want completed visits to survive a job cancellation as history, so
    that the work already done is not erased.
27. As an office manager, I want cancelled visits kept and greyed rather than deleted, so
    that a customer holding an email about "Visit 2" can still be answered.
28. As an owner, I want a lead's walkthrough visits to behave exactly like a job's work
    visits, so that my staff learn one thing rather than two.

**Seeing the work**

29. As an office manager, I want a node on the job's progress bar for every visit, so that a
    three-trip job shows three arrivals instead of one.
30. As an office manager, I want each visit's node to show its own state and date, so that I
    can see at a glance which trips are done and which are still ahead.
31. As an office manager, I want a stage marked reached only if it actually happened, so that
    a future visit sitting after a completed one does not backfill the bar with things that
    have not occurred.
32. As an office manager, I want the job page hero to show the next upcoming visit, so that
    the first thing I read is the thing about to happen.
33. As a dispatcher, I want every visit to appear on the schedule board, so that visit three
    is not invisible until visit one is done.
34. As a dispatcher, I want to drag a visit on the board to reschedule it, so that moving a
    trip is the same gesture it is today.
35. As an owner, I want to see when a job's first visit started and its last visit ended, so
    that I can tell how long the job really took end to end.
36. As a dispatcher, I want both the current and the newer schedule surfaces to show visits
    identically, so that the two views do not disagree about what is booked.

**Customer communication**

37. As a customer, I want a confirmation email for each visit, so that three trips means
    three appointments in my calendar rather than one.
38. As a customer, I want a reschedule notice that names the trip that moved, so that I do
    not think my whole job has shifted.
39. As a customer, I want to be told when a visit is cancelled, so that I am not waiting in
    for a crew that is not coming.
40. As a dispatcher, I want the scheduling dialog to tell me who is about to be emailed, so
    that I am not surprised by a message going out in my name.
41. As a dispatcher, I want to decline that email with a checkbox, so that a correction I am
    making seconds after a mistake does not spam the customer.
42. As a dispatcher, I want that checkbox to default to sending, so that the normal case
    stays one click and nobody is silently left uninformed.

**Automations and permissions**

43. As an owner, I want automations to fire per visit, so that a rule that texts the customer
    the morning of the appointment fires on all three mornings.
44. As an owner, I want visit three's notification not to be swallowed as a duplicate of
    visit one's, so that automation coverage does not silently degrade on multi-visit jobs.
45. As an owner, I want a "visit scheduled" automation to fire when the office adds a visit to
    a job already under way, so that late additions are announced like any other.
46. As an owner, I want completing a job to be a dispatcher and admin capability by default,
    so that the decision to close out work sits with the office.
47. As an owner, I want to grant job completion to technicians from Roles and Permissions, so
    that a shop that trusts its crew can run that way.
48. As an existing customer of ServWave, I want my technicians to keep the completion
    permission they have today, so that a platform upgrade does not quietly take a capability
    away from my staff.

## Implementation Decisions

### Domain language

**Visit** - one occurrence of people going to a site, for either purpose. A visit belongs to
exactly one parent (a Job or a Lead) and carries a time, a crew, a status and notes. It never
carries money, an address of its own, or a signature.

The word "walkthrough" retires platform-wide. A visit on a lead is a visit whose purpose is
`WALKTHROUGH`; a visit on a job is a visit whose purpose is `WORK`. This is what closes
SRVW-57.

### Shape

| # | Decision |
|---|---|
| D1 | A second slot is a **distinct visit under the same job**. Not recurrence (service plans already own that, with a real rrule engine), not sibling jobs (declined as SRVW-181). |
| D2 | **No cap and no ordering rule.** The user adds one visit up front, or three, or adds a fourth mid-job. Their choice, any time. |
| D3 | Job visits and lead walkthroughs are **one concept**. A visit is a visit; only the parent and the purpose differ. |
| D4 | A visit is **an occurrence only**: time, crew, status, notes. No per-visit address, line items, billing or signature. The invoice, the estimate and the deposit stay anchored on the Job. This keeps SRVW-181 declined rather than reopened by accident. |
| D5 | **One `visits` table.** Nullable `job_id` and `lead_id` with a DB CHECK that exactly one is set. Not polymorphic `parent_type`/`parent_id` - that gives up FK integrity and cascade, and makes the tenant-scoping joins painful. |
| D6 | **Crew lives on the visit.** The job-assignee and lead-walkthrough-performer join tables collapse into one `visit_assignees`. "The job's crew" becomes a derived union. Lead assignment is untouched - it is sales ownership, not a visit crew. |
| D13 | **Stable creation-order numbering.** `visit_seq` per parent, mirroring the existing `J00007-1` estimate-sequence idiom. Sort by time everywhere, label by creation order. The number appears in customer email, so renumbering would rewrite history the customer already received. |

### Lifecycle

| # | Decision |
|---|---|
| D7 | Arrival and completion timestamps (`en_route_at`, `on_site_at`, `started_at`, `completed_at`) **move to the visit**. Completing the last visit does **not** auto-complete the job. |
| D11 | The job lifecycle bar becomes **Job Created -> Visit 1 -> Visit 2 -> ... -> Completed -> Invoice Sent -> Payment Received.** Visits replace the fixed Scheduled and On Site nodes, which were only ever visit 1's properties. Each visit node carries its own state and date. |
| D11a | **Forward-fill dies.** The lifecycle module currently marks a stage reached if any *later* stage has a timestamp. With a future visit sitting after a completed one that is false. `reached` becomes per-node truth. |
| D12/D17 | `JobStatus` becomes **UNSCHEDULED / SCHEDULED / IN_PROGRESS / COMPLETED / CANCELLED**. UNSCHEDULED = no visits. SCHEDULED = visits exist, none started. IN_PROGRESS = any visit started. COMPLETED and CANCELLED are explicit and human-set. `EN_ROUTE` and `ON_SITE` retire from `JobStatus` and live on `VisitStatus`; existing rows in those states migrate to IN_PROGRESS. The derived values are written as a cache in the same transaction, since the board, filters, reports and automations all read the column. Spec B1's unordered rule survives: COMPLETED stays reachable and reversible from anywhere. |
| D12a | This makes jobs **symmetric with leads**, which already work this way - the walkthrough redesign removed the walkthrough states from `LeadStatus`, leaving it purely pipeline. `LeadStatus` needs nothing new. |
| D22 | **One shared `VisitStatus`** for both purposes: `SCHEDULED / EN_ROUTE / ON_SITE / IN_PROGRESS / COMPLETED / CANCELLED`. **`REQUESTED` retires.** |
| D22a | Consequence of retiring REQUESTED: leads stop being minted with a placeholder visit row, and the three needs-scheduling queries flip from "has a REQUESTED walkthrough" to "has no non-cancelled visit". Three read sites: the lead filter registry, the dashboard controller, and the demo seeder. |
| D16 | **Unscheduled means no live visits**, for jobs and leads alike. A job is only CANCELLED when a dispatcher or admin cancels the job itself. Cancelling a visit unschedules that visit; it does not cancel the job. |
| D19 | **Reschedule and Cancel visit are two distinct actions.** Reschedule = same row, new time, "rescheduled" email. Cancel visit = row kept as CANCELLED, greyed on the bar, customer told it is off. Rows are never deleted - the customer holds an email referencing "Visit 2", and deletion would make the first-time-fix / callback data (SRVW-41) unrecoverable. Cancelling the **job** cancels its not-yet-completed visits and leaves completed ones as history; un-cancelling the job does not auto-revive them. |
| D21 | Crew double-booking **warns, never blocks**. The existing crew-conflict detector stays advisory and names the conflicting job or lead. A hard block just moves scheduling out of the software. |

### Permissions

| # | Decision |
|---|---|
| D7a | **Completing a job** is a dispatcher/admin capability by default. **Starting a visit** is a crew action: any crew member on the visit can start it, with admins and dispatchers as the fallback when the tech on site cannot press the button. |
| D15 | Technicians are **not losing** `complete Job`. It becomes a toggle: **on for existing orgs, off by default for new ones.** Mechanism: role grants are per-org `role_permissions` rows seeded from the default-grants table **only at org creation**, so removing the `{ role: 'TECHNICIAN', action: 'complete', subject: 'Job' }` entry produces exactly this shape with **no data migration**. |
| D15a | Two consequences to handle in the same PR: the role-permission drift checker will report the row on live orgs as "extra - not in DEFAULT_GRANTS", and the reset-role-to-defaults endpoint would strip it from an org that resets. Both are one-liners. |

### Scheduling data

| # | Decision |
|---|---|
| D14 | Two **different** derived column pairs, not one. (i) `first_visit_start` / `last_visit_end` on Job - a backward-looking **duration span** for "how long did this job really take". (ii) `scheduled_start` / `scheduled_end` / `is_all_day` kept temporarily as a forward-looking **write-through mirror of the next upcoming visit**, so the existing call sites keep working while reads are repointed surface by surface, then dropped. Conflating them would silently hide every later visit from the board until the repoint lands - a wrong-data window in prod, not just a refactor. |
| D14a | The job page hero KPI becomes **Next Visit** (upcoming), not "Schedule". |
| D24 | `UNASSIGNED` -> `UNSCHEDULED` is a real enum rename (Postgres enum, Prisma schema, every string literal, saved filters), shipped as **its own small PR ahead of the feature**. Rationale strengthens under this design: crew now lives on the visit, so a job with no visits has no crew and "unassigned" describes nothing. |

### Notifications and automations

| # | Decision |
|---|---|
| D10 | **One email per visit**, not one itinerary email. A reschedule email is about the visit that moved, not the job. |
| D18 | **Automations fire per visit**, and the automation dedupe module's occurrence key is re-keyed to include the **visit id**. Left keyed on a job-level timestamp, visit 2's notification is silently swallowed as a duplicate of visit 1's. A "scheduled" automation fires when the office adds visit 3 to an in-flight job. |
| D23 | Every scheduling dialog **states who will be emailed and offers an opt-out checkbox, defaulted to on.** This is the SRVW-243 shape (in progress): a customer admin complained the current dialog hardcodes "Confirm & Notify" with no way to decline. Label-only would re-land the bug a customer just reported. |

### Schema

The shape below encodes the decisions above more precisely than prose:

```
visits
  id, organization_id
  job_id   uuid null  \  CHECK: exactly one of the two is set
  lead_id  uuid null  /
  purpose        WORK | WALKTHROUGH        (derivable from the parent; stored for query clarity)
  visit_seq      int                       per parent, stable, drives the "Visit 2" label
  status         VisitStatus
  scheduled_start, scheduled_end, is_all_day
  en_route_at, on_site_at, started_at, completed_at
  cancelled_at, cancelled_reason, cancelled_by
  notes
  customer_email_sent_at
  created_at, updated_at

visit_assignees
  id, organization_id, visit_id, user_id
  @@unique([visit_id, user_id])
```

`visits` is the renamed and widened `walkthroughs` table. `visit_assignees` is the widened
walkthrough-performer join; the job-assignee table folds into it and is dropped at the end.

Retired: `Job.scheduled_start/scheduled_end/is_all_day` (after the repoint),
`Job.en_route_at/on_site_at/started_at`, `JobStatus.EN_ROUTE`, `JobStatus.ON_SITE`,
`WalkthroughStatus.REQUESTED`, the job-assignee table, the walkthrough-performer table.

Added to Job: `first_visit_start`, `last_visit_end`.
`Job.completed_at` stays - it is a job-level fact, explicitly set.

### API contracts

- Visits are a nested collection on their parent: create, list, patch, cancel and reschedule
  under the parent job or lead, plus `start` / `arrive` / `complete` actions on the visit
  itself. This follows the platform's existing `/api/{resource}` + `POST :id/{action}` shape.
- Every visit write carries the optional `notify` object already established by the
  assign-notify contract, so the opt-out checkbox has a backend to talk to and omitting it
  preserves today's behaviour.
- `Job.status` is never settable to a derived value by the client. Clients set COMPLETED and
  CANCELLED; UNSCHEDULED / SCHEDULED / IN_PROGRESS are recomputed server-side in the same
  transaction as any visit write.
- Every visit query and write spreads the tenant scope, per the standing multi-tenancy rule.

### Delivery: vertical slices

Vertical tracer-bullet slices, not horizontal layers: each slice cuts DB -> API -> UI for one
capability and is shippable on its own. The bullet goes through the **riskiest** ground
first.

**S0. `UNASSIGNED` -> `UNSCHEDULED` rename.** Standalone, ahead of everything (D24).

**S0b. Collapse the three schedule-card renderers.** Prerequisite, roughly a day. The data
shaping is already unified in the schedule event-adapter module; only the card's visual body
is triplicated - the same `isWalk ? customer : title` branch in the member week board, the
technician grid view, and the path fed from the schedule page. Multi-visit invalidates that
branch in all three, so collapsing first turns three edits into one. This is the first half
of SRVW-147 only - see Out of Scope.

**S1. Tracer bullet: a lead holds two live visits.** Leads first, deliberately: the
walkthrough side has roughly six readers against the job side's 228 `scheduled_start`
references, it is already an entity with its own status and performers join, and lifting the
one-active-row invariant is a service-layer change rather than a schema invention. Rename
`walkthroughs` -> `visits`, add the nullable `job_id` + CHECK, drop the "at most one
non-terminal row per lead by construction" rule in the walkthrough service, retire REQUESTED
and its three bucket queries, and render multiple visits on the lead page. Doing this first
makes the unified table real from day one instead of a promise - the alternative runs two
parallel visit implementations for weeks, which is exactly the drift #1551 spent a PR undoing
between the v1 and v2 schedule trees.

**S2. Job visits on the job page.** Hang `job_id` visits off the proven table. Job detail
page lists them, adds them, reschedules them. `Job.scheduled_start` dual-written as the
next-upcoming mirror (D14).

**S3. Crew per visit.** `visit_assignees`; the job-assignee table dual-written as the union so
its readers keep working.

**S4. Visit lifecycle.** `VisitStatus` plus the four timestamps on the visit; `Job.status`
derived per D12; start/arrive/complete repointed to the visit.

**S5. Lifecycle bar rewrite.** Per-visit nodes, forward-fill removed (D11, D11a).

**S6. The schedule board reads visits.** Date-range query repointed off the job's
`scheduled_start`; the two schedule pages, the drop modal and the collapsed card renderer
follow. Both the v1 and v2 trees move together through the shared four-field module from
#1551, or v2 silently reverts v1 again.

**S7. Notifications and automations per visit.** Visit-scoped dedupe key, per-visit emails,
the opt-out checkbox (D10, D18, D23).

**S8. Drop the scaffolding.** Remove `Job.scheduled_start/end/is_all_day` and the job-assignee
table; add `first_visit_start` / `last_visit_end`.

## Testing Decisions

### What makes a good test here

A test asserts **observable behaviour through a public interface** - an HTTP request in and
its response plus its persisted effect out, or a rendered screen and what a user can do to
it. It never reaches for an internal function's shape. A test that breaks when a helper is
renamed, a service is split, or a query is restructured was testing implementation, and under
a change this size that failure mode would be constant noise.

Backend work is strict TDD: one failing test, then the implementation that passes it, then
the next. Never all the tests followed by all the code.

### Seams

No new seams. Both seams this feature needs already exist and carry the majority of the
suite:

1. **Backend: the HTTP API through the real Express app**, driven by supertest against a
   fully-mocked Prisma, with the shared test helpers supplying users, auth headers and job /
   lead fixtures. 191 of 327 backend test files already use it. This is the highest seam
   available - it exercises authenticate -> authorize -> validate -> controller -> service in
   one assertion - and it is where every behaviour in this spec should be tested by default.
   Prior art: the assign-notify-options suite covers almost exactly the notify-opt-out
   contract that D23 extends.

2. **Frontend: the rendered component**, via the shared render-with-providers helper and
   Testing Library, with stores and hooks mocked at their module boundary. 229 files. Used
   only for the two surfaces where the behaviour genuinely is visual: the lifecycle bar's
   per-node truth and the scheduling dialog's opt-out.

One pure-module seam is used where a derivation is genuinely pure and shared: the job
lifecycle module already has its own test file, and the schedule four-field module from
#1551 already exists precisely so v1 and v2 cannot drift. Extending those two is preferred
to inventing a third pure module.

### Cycle ordering, hardest-won first

1. A parent holds multiple live visits at once - the invariant being lifted.
2. `Job.status` derives correctly: UNSCHEDULED with no visits, SCHEDULED with unstarted ones,
   IN_PROGRESS the moment any visit starts, and **not** COMPLETED when the last visit
   finishes.
3. Cancelling one visit leaves the other visits and the job intact.
4. The emailed visit and the persisted visit are the same row.
5. Automation dedupe does not swallow visit 2's notification.
6. Crew conflicts warn and do not block.
7. A technician on the visit can start it; a technician not on it cannot; an admin can start
   it on their behalf.
8. Removing the technician completion grant leaves existing orgs' technicians able to
   complete and new orgs' unable, with no migration.

(2) and (4) are non-negotiable. (2) is the unordered-status bug class that has now bitten
twice - PR #1550's "Service Scheduled" email on a moved job, and the estimate status work.
(4) is the class behind #1522, where the emailed token was not the persisted token and
customers got dead links. Prior art for (4) is that PR's test, which compares the emitted
link against the row that was actually written.

### Operational note

This adds a substantial number of backend cases to what is already the long pole in CI. Cap
vitest workers per the existing note on parallel runs starving each other; the backend config
already reads `VITEST_MAX_WORKERS` for this reason.

## Out of Scope

- **Recurrence.** Service plans already own repeating work with a real rrule engine. Visits
  are explicitly created, never generated from a rule.
- **Per-visit money.** No per-visit line items, charges, deposits, invoices or pricing. One
  job, one estimate, one invoice. This is what keeps SRVW-181 declined.
- **Per-visit address.** A visit happens at the parent's address. Multi-site work is a
  different feature.
- **Per-visit signature or job report.** Those stay job-level for now.
- **SRVW-147's second half** - org-templated schedule-card content with the 14 Workiz merge
  tokens. **Deferred and unscheduled, not declined.** It is parity for parity's sake and
  competes for attention with a capability Workiz does not have. Ran is explicitly undecided
  on whether it is wanted at all; it remains an open question and needs a separate decision.
  Only the first half (collapsing the three renderers) is in scope, as prerequisite slice
  S0b.
- **Projects / job grouping** (SRVW-181) stays declined. D4's boundary is what keeps it
  declined rather than reopened by accident.
- **Customer-facing self-reschedule.** Visits are scheduled by the office.

## Further Notes

### Issue housekeeping (already applied)

- **SERV10X-66** - parent, carries this spec.
- **SERV10X-36** - closed as duplicate of SERV10X-66.
- **SRVW-57** (Walkthrough -> Visit rename) - closed, absorbed here at the DB level.
- **SRVW-147** - split; first half promoted to slice S0b, second half deferred as above.
- **SRVW-181** (declined multi-day Projects grouping) - noted that the multi-day need it
  cited as only partially covered is now actually covered.

### Open items to handle before or during implementation

- **SRVW-243** is in progress and owns the notify opt-out. S7 must land on top of it, not
  race it.
- The schema comment above the old `Walkthrough` model is **stale** - it claims nothing reads
  the table, while five controllers and the walkthrough service do. Fix while renaming.
- The job-milestones module documents a live pre-existing bug: completing a job cascades a
  linked service-plan visit to COMPLETED but reopening never reverts it, so `visits_remaining`
  stays permanently decremented. Per-visit completion will hit this path far more often. Fix
  or file separately before S4.

### Evidence, as of 2026-08-17

These counts drove the slice ordering and are worth re-deriving rather than trusting if this
spec is picked up much later: 228 non-test references to `Job.scheduled_start` (142 backend,
86 frontend) against roughly six readers on the walkthrough side; three schedule-card
renderers carrying the same `isWalk` branch; three queries reading the REQUESTED bucket.

### Standing constraints that apply to every PR here

Branch from `staging` and PR into `staging` - the `main`-ancestor gate is currently non-zero.
Never promote to `main` without Ran asking in-session. Migrations portable and idempotent,
never run from a worktree. Design tokens only, no raw hex or palette classes. No real
customer PII in fixtures or seeds. `npx tsc --noEmit` plus the backend suite before claiming
done.
