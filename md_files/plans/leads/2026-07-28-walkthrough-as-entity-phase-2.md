# Phase 2 - Walkthrough as an Entity

## Context

A walkthrough (a site visit to a lead) is a real-world thing with a time, a crew and an outcome, but
today it is modelled as 9 loose columns on the `Lead` row plus two values inside `lead.status`
(`WALKTHROUGH_SCHEDULED`, `WALKTHROUGH_COMPLETED`). Three consequences bite live users:

1. A lead can have only ONE walkthrough - a second visit overwrites the first.
2. State goes incoherent - rescheduling sets the status back to `WALKTHROUGH_SCHEDULED` but never
   clears `walkthrough_completed_at`, so a lead reads as both scheduled and completed.
3. Because visit state lives in `lead.status`, booking a visit is a pipeline status change, so it is
   policed by pipeline rules. That is the reported bug reps complain about most.

Phase 1 (PR #1037, merged to staging) fixed the immediate symptom on the old shape. Phase 2 removes
the class of bug: walkthroughs become their own table, visit events push the lead forward rather than
lead status gating visit actions, and the two walkthrough statuses leave `LeadStatus`.

Design decisions D1-D17 are settled in
`md_files/specs/leads/2026-07-28-walkthrough-as-entity.md`. This plan is the execution order for them.
Phase 3 (multi-visit UI beyond the detail page, touchpoint analytics) stays out of scope.

**Ships as 4 sequential PRs into `staging`, each independently revertible and verifiable.**
**Legacy columns are dual-written until PR-D**, so a revert on live customer data still leaves the
old columns current and the app working.

---

## Target model

New `Walkthrough` table, shaped on `PlanVisit` (`backend/prisma/schema.prisma:1029-1049`) - the
house template for a tenant-scoped child with its own status enum:

- `id`, `organization_id` (first, per the newer convention), `lead_id`
- `status: WalkthroughStatus` - `REQUESTED | SCHEDULED | COMPLETED | CANCELLED`
- `scheduled_at`, `duration_minutes`, `completed_at`, `notes`
- `cancelled_at`, `cancelled_reason`, `cancelled_by`
- `customer_email_sent_at`, `created_at`, `updated_at`
- indexes on `lead_id`, `organization_id`, and `(organization_id, status)` for the bucket query

`LeadWalkthroughPerformer` repoints `lead_id` -> `walkthrough_id`. **Its unique constraint is a
blocker**: `@@unique([lead_id, user_id])` (`schema.prisma:189`) permits one row per (lead, user), so
the same tech visiting twice would be rejected. It must become `@@unique([walkthrough_id, user_id])`.

**Bucket definition becomes `Walkthrough.status = REQUESTED`** - no lead status involved, which is
what structurally deletes the reported bug.

**Permissions keep the `Lead` subject.** `schedule_walkthrough` / `perform_walkthrough` stay as-is,
and `OWN_WALKTHROUGH` (`lib/permissions/defaultGrants.ts:28`) is re-expressed as a nested relation
predicate: `{ walkthroughs: { some: { performers: { some: { user_id: '{{userId}}' } } } } }`.
Introducing a `Walkthrough` CASL subject would mean rewriting `role_permissions` rows for every org
against the CI role-permission drift gate - the same cost that scoped the rename out (D17). Not worth
it. `ScopeResource` (`lib/permissions/scopeWhereFor.ts:12`) therefore needs no change.

---

## PR-A - table + backfill, no behavior change

New table exists and is populated; nothing reads it yet. Fully revertible.

**Migration** (`backend/prisma/migrations/<ts>_walkthrough_entity/migration.sql`) - follow
`20260720120000_logistic_orders_foundations/migration.sql` idiom for idiom, per the
`writing-migrations` skill:

- `DO $$ ... pg_type` guard around `CREATE TYPE "WalkthroughStatus"`.
- `CREATE TABLE IF NOT EXISTS "walkthroughs"`, `TIMESTAMP(3)`, PK `walkthroughs_pkey`.
- FKs in their own `pg_constraint`-guarded `DO $$` blocks, Prisma-generated names
  (`walkthroughs_lead_id_fkey` etc.), `ON UPDATE CASCADE` on every one; `ON DELETE CASCADE` for
  `lead_id`, `RESTRICT` for `organization_id`, `SET NULL` for `cancelled_by`.
- Indexes named exactly as Prisma generates them, so `migrate diff` sees no drift.
- The standard RLS block verbatim (`ENABLE` + `FORCE` + `DROP POLICY IF EXISTS` + `tenant_isolation`
  with the `app.bypass_rls` / `app.current_org_id` predicate) plus the `pg_roles`-guarded REVOKE for
  `anon` / `authenticated`. The global sweep in `20260708140000` only covered tables that existed at
  its run time, so a new table must repeat this.
- **Backfill**, one row per lead with any walkthrough data, status derived:
  `walkthrough_cancelled_at IS NOT NULL` -> `CANCELLED`; else `walkthrough_completed_at IS NOT NULL`
  -> `COMPLETED`; else `walkthrough_scheduled_at IS NOT NULL` -> `SCHEDULED`; else
  `walkthrough_needed = true` -> `REQUESTED`.
- **Repoint performers**: add `walkthrough_id`, backfill from each lead's synthesized row, swap the
  unique constraint, drop `lead_id`. Leads with performers but no walkthrough row get a `REQUESTED`
  row so no crew is orphaned.

`schema.prisma`: add `Walkthrough` + `WalkthroughStatus`, `Lead.walkthroughs Walkthrough[]`, repoint
`LeadWalkthroughPerformer`. Legacy columns untouched.

**Verify:** apply to staging via Supabase MCP (never `prisma migrate` from a worktree - local `.env`
points at staging), then count-check backfilled rows against the legacy columns per status bucket,
and confirm zero orphaned performers.

---

## PR-B - repoint backend reads and writes

All walkthrough behavior sources from the new table; lead statuses are still written, so the frontend
is untouched and CI stays green. **Backend TDD, failing test first, strict.**

`backend/src/controllers/lead.controller.ts` is the bulk (87 walkthrough refs). Extract a
`backend/src/services/walkthrough.service.ts` holding the lifecycle so the controller thins out:

| Handler | Lines | Change |
|---|---|---|
| `scheduleWalkthrough` | 1434-1590 | Creates or updates a `Walkthrough` row instead of stamping the lead. **Status guard deleted (D2).** Advances lead `NEW -> CONTACTED` only (D5 - never pulls backward). |
| `completeWalkthrough` | 1715-1771 | Guard moves onto the visit's own status. Replace its hand-rolled `manage all \|\| is-performer` check (1729-1732) - it never calls `canAccessRow`, unlike every sibling. |
| `cancelWalkthrough` | 1775-1835 | Guard moves onto the visit. Per D12, a cancelled visit with nothing rebooked leaves a `REQUESTED` row so the lead returns to the bucket. |
| `unscheduleWalkthrough` | 1663-1711 | Guard moves onto the visit; row returns to `REQUESTED`, performers retained. |
| `setPerformers` | 1596-1656 | Currently has **no** status guard - performers can be swapped on a WON/LOST lead. Add a guard rejecting terminal (`COMPLETED`/`CANCELLED`) visits. |
| `contactLead` | 1341-1389 | **Handler and route deleted (D6)** - contact is inferred from outbound activity. |
| `update` | 1000-1004 | "Cannot disable walkthrough while one is scheduled" guard deleted. |
| `cancelLead` / `markLost` | 1857-1864, 2104-2110 | Auto-cancel writes the visit row rather than lead columns. |

`replaceWalkthroughPerformers` (368-394) keys on `walkthrough_id`; note its `findMany`/`deleteMany`
are not tenant-filtered today (safe only because the caller tenant-checked the lead) - keep that
invariant explicit.

Also repoint, all reading the legacy columns or the two statuses:

- `lead.filters.ts:53-65` - `walkthrough_status` facet becomes `walkthroughs: { some: { status: 'REQUESTED' } }`. The array-order dependency on `status` disappears with it.
- `lead.controller.ts:500-506` - hand-rolled `walkthrough_after`/`_before`; move onto the relation.
- `detectPerformerConflicts` (418-475) and its mirror `job.controller.ts:537-548`.
- `dashboard.controller.ts:256-262` + `664-673` (attention item) and `300-326` (schedule widget).
- `dashboard-metrics.ts:308-322` - synthetic display string, derived from the timestamp not the status, so nearly free.
- `automations/context.ts:269-317` - **merge fields `lead.walkthrough_date` / `_time` / `performer_names` resolve against the CURRENT visit per D15** (next upcoming SCHEDULED; else most recent that happened). This changes live customer email content - flag in the release note.
- `automations/terminalStale.ts:243-251` and `129-163` - the staleness guard reads `state.leadStatus`; repoint to the visit's status.
- `automations/dateAnchorSweep.ts:67-86` and `anchors.ts` - `lead.walkthrough_scheduled_at` anchor.
- `automations/dedupe.ts:21-29` - occurrence key.

**Automation trigger types are unaffected** - `WALKTHROUGH_SCHEDULED` etc. in
`automations/catalog.ts:216-248` are `AutomationTriggerType` values fired explicitly at write time,
not lead statuses. They survive and improve (each can name a specific visit). Do not collapse them.

**D8/D9 - remove `require_walkthrough_before_send`** (`estimate.controller.ts:1904-1918`, duplicated
verbatim at `2558-2570`). It is written by no code path and has been enforcing nothing. Replace with
silent instrumentation: on estimate send, record on the timeline whether a `COMPLETED` visit existed
at that moment. No modal, no block.

**Behavior shift to flag:** three divergent definitions of "needs scheduling" exist today
(`lead.filters.ts:57-64`, `dashboard.controller.ts:256-262`, and the frontend's `WALKTHROUGH_FILTERS`).
`status = REQUESTED` collapses all three. They are not currently equivalent, so the dashboard
attention list will surface more leads than before - which is the D11/D12 intent, but it is visible.

Timeline writes currently sit **outside** the `$transaction` at 1522, 1691, 1743, 1806 - move them
inside while the code is being rewritten anyway.

**Dual-write:** every lifecycle write also stamps the legacy columns, in one helper so PR-D deletes it
in a single place.

---

## PR-C - the enum change (backend + frontend, one commit)

`WALKTHROUGH_SCHEDULED` / `WALKTHROUGH_COMPLETED` leave `LeadStatus`; existing leads remap to
`CONTACTED`. **The backend and frontend halves cannot be split**:
`frontend/src/design-system/__tests__/status-registry-schema-guard.test.ts` parses
`backend/prisma/schema.prisma` and asserts a bijection with `STATUS_REGISTRY.lead`, so either half
alone reddens CI in both directions.

Backend: enum migration + remap; `OPEN_LEAD_STATUSES` (`dashboard.controller.ts:19-25`,
`customer.controller.ts:23`), `shouldTransitionLead` (`estimate.controller.ts:1840`), `getStats`
(`lead.controller.ts:1944`), `backfill-lead-estimated-status.ts`, `seed-demo-alpha.ts`.

Frontend:
- `design-system/status-registry.ts:134-148` - drop the two entries. This narrows
  `statusVocabulary('lead')`, which is the Copilot's advertised filter vocabulary
  (`copilot/tools/toolRegistry.ts:56`) - intended, and asserted by the guard test.
- `lib/filters/registries/leads.ts:19-28` (the only source of the Status facet options) and
  `WALKTHROUGH_FILTERS` at 38-43.
- `LeadDetailPage.tsx` - `SETTABLE_LEAD_STATUSES:97`, `isWalkthroughScheduled:731` and its four
  consumers (753, 880, 1077, 1232), `WalkthroughDot:175-183`, `WalkthroughTabContent:187-568`
  branching on `lead.status === 'WALKTHROUGH_SCHEDULED'` at 211. Per D14, the tab shows the CURRENT
  visit with history behind it and a visit count.
- `LeadsPage.tsx` - `getWalkthroughDisplay:91-96` becomes the **visit chip** (D4: carries the date, e.g.
  "Visit Fri 2pm"), plus `ACTIVE_STATUSES:87`.
- `SchedulePage.tsx:1539` unschedule gate, `scheduleModel.ts:123` `COMPLETED_STATUSES`,
  `TodaySchedule.tsx:50`, `NewEstimateDialog.tsx:47`.
- **Free deletions:** `components/jobs/WalkthroughTab.tsx` (zero importers) and
  `LeadsPage.tsx:89` `WALKTHROUGH_SCHEDULABLE_STATUSES` (zero references) - both carry retired-value logic.
- Do **not** touch `lib/workflows/triggerModel.ts:53-58` or `lib/api/workflows.ts:13-14` - those are
  `AutomationTriggerType`, a different enum.
- Copilot `toolRegistry.ts:208-230` hardcodes "must be CONTACTED ... never NEW" in its description -
  now false, update it.

Also remove the "Mark Contacted" menu item (`LeadDetailPage.tsx:730`) - D6, its handler went in PR-B.

Release note required (spec §7): owners will see leads move out of the two statuses, and
walkthrough merge fields in customer emails now resolve to the current visit.

---

## PR-D - drop the legacy columns

Only after PR-C is verified on staging. Drops the 9 `Lead.walkthrough_*` columns (`schema.prisma:357-364`
plus `walkthrough_customer_email_sent_at:401`), the `walkthrough_canceller` relation, the two dead
`Job.walkthrough_notes` / `walkthrough_completed_at` (`717-718`, orphaned when the job-level route was
removed), and the dual-write helper.

---

## Verification

Per PR, before claiming done: `npx tsc --noEmit` (frontend) and `npm test --workspace=backend`, and
report the real result. Note the 4 pre-existing vitest-globals typecheck failures on `main`
(`lead.filters.test.ts`, `tenant-guard.test.ts`, `filterEngine.test.ts`, `parseArrayParam.test.ts`) -
unrelated, confirm via `git stash` that the count has not grown.

Test surface to expect: 45 backend test files reference walkthroughs, ~128 `it()` blocks name one.
`backend/src/__tests__/leads.test.ts` alone has 13 walkthrough describe-blocks and 34 named tests.
`backend/src/__tests__/helpers.ts` is a shared lead factory stamping walkthrough fields - changing it
breaks every suite that uses it, so update it first. `permissions-parity.test.ts` asserts catalog
<-> defaultGrants parity and fails on any action rename. Frontend: `lead-detail-walkthrough-dot.test.tsx`
asserts the dot over the full `LeadStatus` x `completedAt` matrix and will need rewriting in PR-C.

End-to-end on staging after PR-C, against a test org:

1. Schedule a walkthrough on a `NEW` lead - succeeds, lead advances to `CONTACTED`, chip shows the date.
2. Complete it, then schedule a SECOND visit with the SAME technician - the old
   `@@unique([lead_id, user_id])` would have rejected this; it must now succeed.
3. Cancel a visit with nothing rebooked - lead reappears in the scheduler bucket (D12).
4. Send an estimate - no walkthrough gate fires, and the timeline records whether a completed visit existed.
5. Confirm a `walkthrough-reminder-1d` automation fires against the current visit's time.
6. Drag a `NEW` lead onto the scheduler board from both drop paths (`SchedulePage.tsx:654` ghost
   confirm and `:1305` direct drag) - both must succeed, no 400.

Verify migrations on staging first via Supabase MCP, never `prisma migrate` from a worktree. Do not
move the DB ahead of the merged branch - a column or enum present in staging but absent from the code
500s both typed and untyped queries.

## Branching

Each PR from a worktree off `main` under `../alpha_crm-worktrees/`, into `staging`; promote to `main`
only after the staging PR merges. PR-B starts from PR-A's merge, and so on.
