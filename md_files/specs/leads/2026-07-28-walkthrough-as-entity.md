# Walkthrough as an Entity - Lead / Visit Model Redesign

> Spec (reference doc). Status: DRAFT, awaiting Ran's sign-off. Created 2026-07-28.
> Origin: scheduler drag-and-drop failure, "Walkthrough can only be scheduled from CONTACTED or
> WALKTHROUGH_COMPLETED status". Decisions below were settled in a grilling session with Ran on
> 2026-07-28 and supersede the recorded vault rule "NEW -> WALKTHROUGH_SCHEDULED (must contact
> first)" in `Modules/Leads.md`.

## 1. The bug that started this

The scheduler's walkthrough bucket and the schedule endpoint disagree on which lead statuses are legal.

- Bucket (`GET /api/leads?walkthrough_status=needs_scheduling`) returns `NEW`, `CONTACTED`,
  `WALKTHROUGH_COMPLETED` - `backend/src/lib/query/registries/lead.filters.ts:56-66`.
- Endpoint (`POST /api/leads/:id/walkthrough/schedule`) accepts only `CONTACTED`,
  `WALKTHROUGH_COMPLETED`, `WALKTHROUGH_SCHEDULED` - `backend/src/controllers/lead.controller.ts:1448`.

Any `NEW` lead in the bucket renders as a draggable card, survives the drop and the confirm modal,
then 400s. Both drop paths hit the same endpoint (`SchedulePage.tsx:651` plan-mode ghosts,
`SchedulePage.tsx:1286` direct drag). The error string is also stale: `WALKTHROUGH_SCHEDULED` has
been accepted since commit `70c43bff8` but the message was never updated.

Live user feedback confirms this is the top complaint: reps do not understand leads and are blocked
from scheduling.

## 2. Root cause

A walkthrough is a real-world thing - a visit to a lead, with a time, a crew, and an outcome - but it
is modelled as nine loose columns on the Lead row plus two values inside `lead.status`:

```
walkthrough_needed, walkthrough_scheduled_at, walkthrough_duration_minutes,
walkthrough_completed_at, walkthrough_notes, walkthrough_cancelled_at,
walkthrough_cancelled_reason, walkthrough_cancelled_by, walkthrough_customer_email_sent_at
```

Consequences today:

1. A lead can only ever have ONE walkthrough. A second visit overwrites the first.
2. State can go incoherent: scheduling a second visit sets status back to `WALKTHROUGH_SCHEDULED`
   but never clears `walkthrough_completed_at`, so a lead reads as both scheduled and completed.
3. Because visit state lives in `lead.status`, booking a visit is forced to be a pipeline status
   change, so it gets policed by pipeline rules. That is the reported bug.
4. Dead leftovers: `Job.walkthrough_notes` and `Job.walkthrough_completed_at` remain
   (`schema.prisma:717-718`) though the job-level route was removed in the scheduler redesign.

## 3. Settled decisions

| # | Decision | Rationale |
|---|----------|-----------|
| D1 | Walkthrough becomes its own table. A lead has MANY walkthroughs. | Multiple visits are coming (re-measure, re-quote). Flags on the lead cannot express them. |
| D2 | Visit events push the lead forward. The lead status never gates visit actions. | Inverts today's direction. Removes the entire class of "cannot schedule from status X" bugs. |
| D3 | Lead pipeline becomes `NEW`, `CONTACTED`, `ESTIMATED`, `WON`, `LOST`, `CANCELLED`. `WALKTHROUGH_SCHEDULED` and `WALKTHROUGH_COMPLETED` are removed. | With many visits per lead, one status value cannot say WHICH visit it refers to. Any answer misrepresents the others. |
| D4 | Visit state surfaces as a chip on the lead row and lead detail ("Visit Fri 2pm"), filterable. | Status answers "where is this deal". The chip answers "what is happening on it", and carries the date, which a status never could. Rewinding the status to show a visit would erase "estimate sent". |
| D5 | Visit events never pull the lead backward. Booking on `NEW` advances to `CONTACTED`; booking on `ESTIMATED` leaves it `ESTIMATED`. | Rewinding hides facts that really happened and scrambles pipeline reporting. |
| D6 | `CONTACTED` is inferred from OUTBOUND activity, never set by hand. The "mark as contacted" button is removed. | Same principle as D2: things that happen move the status. Outbound = estimate sent, email sent, call placed, text sent, visit booked. Inbound does NOT mark contacted - the metric owners care about is "did we get back to them". |
| D7 | `contacted_at` records FIRST touch only and is retained. | Keeps the dashboard "needs follow-up" metric working (`dashboard.controller.ts:569`). Contact COUNT comes from the activity/timeline ledger, not from a status - a single column can never count touchpoints. |
| D8 | The `require_walkthrough_before_send` estimate gate is REMOVED entirely. | It is unreachable: read in two places, written by no code path anywhere, no settings UI. It has been enforcing nothing. Not enough user signal to justify building it properly. |
| D9 | Replace D8 with silent instrumentation: record on estimate send whether a completed visit existed at that moment. | No modal, no block, invisible to users. In three months it answers "how often do reps estimate without visiting, and do those close worse" with data instead of anecdote. |
| D10 | Bucket is default-IN. Every new lead needs a visit until told otherwise. | Removes the toggle users had to remember. Matches today's `walkthrough_needed @default(true)`. |
| D11 | Bucket exits: one-click manual dismiss (reversible, writes a timeline entry), plus automatic exit on estimate sent / won / lost / cancelled. | Today the bucket has NO manual exit at all, which is why it goes stale. A worklist needs a door. |
| D12 | A cancelled visit with nothing rebooked returns the lead to the bucket. | That is exactly a lead needing scheduling. Dismissable per D11 if not needed. |
| D13 | Walkthroughs get an internal ID only. No user-facing `W00001` number, no `allocateNumber()`. | Humans will refer to "the visit on the 4th", not a code. Cheap to add later if ever wanted. |
| D14 | On the lead detail page: show the CURRENT visit with history behind it. Visit count is a first-class, cheap-to-read number. | Manager needs to see how many visits a lead required. That is a metric. |
| D15 | "Current visit" = the next upcoming SCHEDULED visit; if none upcoming, the most recent visit that happened (completed or cancelled). One rule, used by the detail page, the list chip, and email merge fields. | Avoids two definitions drifting apart. |
| D16 | No manual "log contact" affordance in this scope. | Ran: redundant once the activity log and Communication exist. Accepted consequence in section 7. |

## 4. Target model

**New table `Walkthrough`** (naming TBD at implementation - "Visit" reads better in UI copy but
`Walkthrough` matches existing vocabulary throughout the codebase):

- `id`, `organization_id` (tenant-scoped, every query spreads `tenantWhere(req)`), `lead_id`
- `status`: `REQUESTED` -> `SCHEDULED` -> `COMPLETED` | `CANCELLED`
- `scheduled_at`, `duration_minutes`, `completed_at`, `notes`
- `cancelled_at`, `cancelled_reason`, `cancelled_by`
- `customer_email_sent_at`
- timestamps

`LeadWalkthroughPerformer` repoints from `lead_id` to `walkthrough_id` - crew belongs to a visit,
not to a lead.

**Lead keeps** `status` (pipeline only, per D3), `contacted_at`, `contacted_note`. The nine
`walkthrough_*` columns are retained through backfill and dropped in a LATER, separate change once
the backfill is verified.

**Bucket definition** becomes: walkthroughs in `REQUESTED`. No lead status involved, which is what
structurally deletes the reported bug.

## 5. Disposition of every current lead status gate

Audited in `backend/src/controllers/lead.controller.ts`:

| Gate | Line | Disposition |
|------|------|-------------|
| "Can only mark NEW leads as contacted" | 1355 | REMOVED - the whole handler goes (D6) |
| "Walkthrough can only be scheduled from..." | 1449 | REMOVED (D2) - the reported bug |
| "Cannot disable walkthrough while one is scheduled" | 1002 | REMOVED - bucket intent and visit state are separate concerns now |
| "Can only unschedule a scheduled walkthrough" | 1678 | MOVES onto the visit's own status |
| "Can only complete a scheduled walkthrough" | 1724 | MOVES onto the visit's own status |
| "Can only cancel a scheduled walkthrough" | 1789 | MOVES onto the visit's own status |
| "Cannot cancel a won/lost/cancelled lead" | 1853 | UNCHANGED - correct terminal guard |
| "Cannot mark a won/lost/cancelled lead as lost" | 2100 | UNCHANGED - correct terminal guard |

The three that MOVE are integrity rules, not workflow blocks: you cannot complete a visit that was
cancelled. They were only ever expressed against the lead because there was nowhere else to put them.

## 6. Things that do NOT change

- **Automations are unaffected.** `WALKTHROUGH_SCHEDULED` / `WALKTHROUGH_COMPLETED` in
  `services/automations/catalog.ts:216,228` are EVENT trigger types ("a walkthrough was scheduled"),
  not lead status values. Events survive and improve - each can name a specific visit.
- **Conflict detection stays a warning, not a block** (recorded decision
  `Decisions/Conflict-As-Warning-Not-Block`). It repoints from `Lead.walkthrough_scheduled_at` to
  the new table.
- **Permissions keep their current shape.** `schedule_walkthrough` / `perform_walkthrough`, the
  per-user capability grants, and the SALES own-leads row scope must behave exactly as they do
  today, re-expressed against the visit. Verified against `canAccessRow` usage before implementation.
- **Estimate send** already gates on `walkthrough_needed` + `walkthrough_completed_at`, NOT on
  `lead.status` (`estimate.controller.ts:1908`), so it survives D3 untouched - and is then removed
  outright per D8.

## 7. Accepted consequences

- **Follow-up over-reporting for orgs without Communication.** `phone` is PRO and is written OFF by
  default for every new org (`/onboard-org` sets `feature_overrides: {"phone": false}`). Transactional
  email (estimate/invoice/walkthrough notifications) still sends regardless, so estimate-sent and
  visit-booked always infer contact. But a rep who phones a customer from a personal cell and neither
  books nor estimates leaves the lead at `NEW`, so "needs follow-up" over-reports until the org
  enables Communication. Accepted (D16). Adding a "log a call" affordance later is cheap.
- **Merge fields change meaning.** Customer emails reference `{{lead.walkthrough_date}}`. These must
  resolve to the CURRENT visit per D15. This is a real change to live email content.
- **Visible status wording change.** Leads currently sitting in `WALKTHROUGH_SCHEDULED` /
  `WALKTHROUGH_COMPLETED` map to `CONTACTED` and gain a visit chip. Owners will notice. Needs a
  release note.

## 8. Live-user migration plan

We have real customers. The migration is non-destructive and staged:

1. Create the `Walkthrough` table. Backfill one row per lead that has any walkthrough data, deriving
   its status from the existing columns. Leads with `walkthrough_needed = true` and no scheduled_at
   become `REQUESTED`.
2. Repoint `LeadWalkthroughPerformer`, preserving existing crew rows.
3. Remap the two retired lead statuses to `CONTACTED`. Update the status badge map, the lead list
   status filter, saved filters, and dashboard counts TOGETHER or the lead list renders blanks.
4. Verify the backfill against staging data before touching prod.
5. ONLY THEN, as a separate change, drop the nine `Lead.walkthrough_*` columns and the two dead
   `Job.walkthrough_*` columns.

Migrations must be portable and idempotent, per the `writing-migrations` skill.

## 9. Phasing

**Phase 1 - immediate, ships independently.** Fix the reported bug on the current schema: allow
scheduling from `NEW`, stamp `contacted_at`, advance to `CONTACTED`, write the timeline entry, correct
the stale error message. Same behaviour the new model specifies, implemented on the old shape, so it
is not throwaway work. Backend TDD, failing test first. PR into `staging`.

**Phase 2 - this spec.** The table, the pipeline change, the bucket rules, activity-inferred contact,
removal of the estimate gate plus its replacement instrumentation, the backfill.

**Phase 3 - deferred, needs its own design pass.** The multi-visit frontend beyond the detail page
(Ran: "how it's going to look and feel" is a later conversation), and touchpoint/contact-count
analytics built on the activity ledger.

## 10. Naming: stays "walkthrough" in this scope (D17)

Decided 2026-07-28. The product vocabulary SHOULD eventually be "visit", but the rename is
deliberately scoped OUT of this work and tracked separately.

**In this spec, everything stays "walkthrough"** - the new table is `Walkthrough`, all code, all UI
copy, all identifiers. No mixed vocabulary, no half-rename.

Rationale: a partial rename is worse than none. The word is stored in live customer data in three
places that each need their own migration:

- `AutomationTriggerType` is a Postgres enum and `trigger_type` is a live column on automation and
  workflow rows (`schema.prisma:3865`, `:3975`) - an enum migration plus rewriting every customer's
  saved automations.
- `schedule_walkthrough` / `perform_walkthrough` are stored as plain strings in `role_permissions`,
  per org (`lib/permissions/catalog.ts:84-85`, seeded from `defaultGrants.ts:64-65`, plus the
  `OWN_WALKTHROUGH` condition at `:223`) - rewrites permission rows for every organization, against
  an existing CI role-permission drift gate.
- Historical `TimelineEvent.event_type` values (`WALKTHROUGH_UNSCHEDULED` and friends) are already
  written into past records.

Doing that migration correctly is a project, not a step inside this one, and it must not block the
model fix that live users are hitting today.

**Tracked as:** Linear project "Rename Walkthrough to Visit (platform-wide)" on the ServWave team -
https://linear.app/alpha-fsm/project/rename-walkthrough-to-visit-platform-wide-5915035a4051

## 11. Activity set that infers CONTACTED (D6, refined)

Stated as a RULE, not a list, so new features inherit it: **anything outbound and customer-directed,
plus booking a visit.**

Included today:
- Estimate sent (the primary signal at lead stage).
- Visit scheduled or rescheduled - including the booking itself when no customer email is sent
  (the existing rule suppresses that email when there are zero performers).
- With Communication enabled: outbound call, SMS, WhatsApp, email.

Explicitly EXCLUDED:
- **Invoice sent.** An invoice hangs off a job and a customer, long past lead contact. Also a no-op
  under D5, which forbids backward movement.
- **Performer assigned / removed emails.** These go to internal technicians, not to the customer.
  Counting them would produce false "we contacted the client" signals.
- **All inbound activity** (D6). An unanswered inbound message should arguably make a lead MORE
  urgent in the follow-up list, not drop it out.

## 12. Reports - verified clear, no action needed

Checked all twelve report services (`activity`, `ar-aging`, `communication-tracking`,
`estimate-conversion`, `estimates`, `inventory-usage`, `invoices`, `jobs`, `leads`, `payment-fees`,
`payments`, `revenue`) plus `report.controller.ts` and the frontend report surfaces. ZERO references
to `WALKTHROUGH_SCHEDULED` / `WALKTHROUGH_COMPLETED`. `leads-report.ts` does not touch them.

The only hit anywhere in the metrics layer is `dashboard-metrics.ts:314`, which builds a DISPLAY
string for the schedule widget rather than filtering on lead status. Phase 2 already touches it.

No separate cleanup issue is warranted for reports.

## 13. Still open

- Nothing blocking. Remaining items are implementation-time details covered by the phases above.

## 14. Decision update (2026-07-29, PR-D2)

D11's proposed one-click manual dismiss for the scheduling bucket was considered at PR-D2 time and
explicitly NOT built. Ran chose to delete the `walkthrough_needed` concept outright instead -
removing the toggle, its backend read/write paths, and every UI surface for it - rather than add a
new dismiss action on top of it. Accepted consequence: every lead now stays in the scheduling
bucket until an actual visit is scheduled or the lead exits the pipeline (won, lost, cancelled, or
estimated); there is no more manual opt-out.
