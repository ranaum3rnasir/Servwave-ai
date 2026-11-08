-- Multi-visit spec slice S8 - DROP THE SCAFFOLDING.
-- Spec: md_files/specs/scheduling/2026-08-17-multi-visit.md. Decisions: D14 (two DIFFERENT
-- derived column pairs - the backward-looking duration span stays, the forward-looking mirror
-- goes), D6 (crew lives on the visit; the job-assignee table folds into visit_assignees and is
-- dropped at the end), D5 (one visits table, exactly one parent).
--
-- PORTABLE: vanilla postgres:16 runs this unchanged. No Supabase-only roles, no auth.*, no
-- extensions, no SECURITY DEFINER. Plain UPDATE / ALTER TABLE / DROP guarded by
-- information_schema lookups.
--
-- IDEMPOTENT: every step is guarded on the state it is about to change. The conditions UPDATEs
-- match the exact historical JSONB value, so a repaired row stops matching, and re-running cannot
-- nest `visits` inside `visits`; every drop is IF EXISTS. A second application on the shared
-- staging DB is a no-op.
-- (An earlier draft of this line also claimed ADD COLUMN IF NOT EXISTS guards and a null-guarded
-- backfill. Those belong to sections 2-4, which this file does not carry - see the next block.
-- The claim is removed rather than left standing, because a header that describes steps the file
-- does not contain is exactly how a reader concludes the teardown is complete when it is not.)
--
-- ─────────────────────────────────────────────────────────────────────────────────────────────
-- WHAT THIS FILE CARRIES, AND WHAT IT DOES NOT.
--
-- S8's full scope also retires the FORWARD-LOOKING mirror (`jobs.scheduled_start` /
-- `scheduled_end` / `is_all_day`), the two dead milestone stamps (`en_route_at` / `on_site_at`),
-- and adds the BACKWARD-LOOKING span (`first_visit_start` / `last_visit_end`). Those are sections
-- 2, 3 and 4 and are NOT in this file: their readers - the six dashboard date windows, search's
-- schedule range, JOB_SORT_FIELDS, the two automation sweeps - have not been repointed yet, and a
-- migration that drops a column live code still selects takes the app down at deploy. They land
-- as their own change, on top of this one. The section numbers below are left at 5 and 6 rather
-- than renumbered, precisely so the gap is visible.
--
-- ORDER IS A CORRECTNESS PROPERTY, not a stylistic choice:
--
--   1. Repoint role_permissions.conditions FIRST, before any drop. A stale row would make
--      scopeWhereFor build a Prisma `where` against a relation that no longer exists - which
--      THROWS, it does not fail open. Repointing first means the worst ordering hazard inside
--      this file is "new condition, old code" rather than "old condition, no table".
--   5. Drop visit_assignees.lead_id LAST among the column drops, after all seven readers move -
--      two of them being attachment ACCESS checks.
--   6. Drop job_assignees last of all, after nothing writes it and nothing names it in JSONB.
--
-- THE DEPLOY WINDOW IS NOT SAFE ON PROD, AND THIS FILE MUST NOT BE READ AS SAYING IT IS.
-- An earlier draft of the paragraph above argued the window degrades gracefully because "the old
-- code still resolves Job.visits, S1 created that relation". That is true of STAGING, where S1-S7
-- are already applied and their code is already deployed. It is FALSE of production. Verified
-- read-only against prod (redacted-prod-ref) on 2026-08-20:
--     SELECT to_regclass('public.visits'), to_regclass('public.visit_assignees');  -> NULL, NULL
-- and `origin/main` carries no Visit model, so S1..S8 all land there in ONE `prisma migrate
-- deploy` - which runs from the build/start command while the PREVIOUS instance is still taking
-- traffic. In that window the still-serving old client has no `visits` field on Job at all, so
-- the moment section 1 commits, prod's 20 stored rows on literal (a) and 5 on literal (b) hand
-- scopeWhereFor a fragment its client rejects: a thrown 500 on every technician GET /api/jobs,
-- /jobs/:id, start, arrive and complete until the new instance takes over. Section 6's DROP TABLE
-- compounds it - the old jobListSelect still names `assignees`.
-- S8 does not CREATE that hazard: S1's own RENAME of lead_walkthrough_performers breaks the old
-- client in the same window. The point is that the prod release of S1-S8 needs a maintenance
-- window (or the instance out of rotation), NOT a rolling deploy, and nobody should schedule it
-- as one on the strength of a sentence in this header.
--
-- ─────────────────────────────────────────────────────────────────────────────────────────────
-- RLS. No policy or grant work is needed here and none is done. `jobs`, `visits` and
-- `visit_assignees` already carry their tenant_isolation policies from
-- 20260703000100_tenant_rls and later coverage migrations; dropping a COLUMN does not touch a
-- policy. Section 6's DROP TABLE job_assignees takes that table's own tenant_isolation policy
-- with it, which is correct and is said out loud here rather than left for a reader to worry
-- about. Nothing below issues a GRANT or a CREATE POLICY - as the S1 header warns, a duplicate
-- GRANT or POLICY is exactly what would make a re-run non-idempotent.
--
-- ─────────────────────────────────────────────────────────────────────────────────────────────
-- JSONB. This project has been bitten three times by values persisted as JSON strings that a
-- schema change cannot reach. There are THREE such stores in scope here. One needs a rewrite;
-- two are verified as NOT needing one, and that is recorded here so the next reader does not
-- re-derive it.
--
--   (a) role_permissions.conditions  - REWRITTEN, section 1 below. Six literals.
--
--   (b) user_table_preferences.config - NOT REACHED. The jobs-list column identity stays
--       `scheduled` (frontend jobsColumns.tsx `id: 'scheduled'`) and the filter params stay
--       `scheduled_after` / `scheduled_before`; only the Prisma field NAME inside
--       JOB_SORT_FIELDS moves, and that name never appears in a saved preference. Verified:
--         SELECT count(*) FROM user_table_preferences
--          WHERE config::text LIKE '%scheduled_start%'
--             OR config::text LIKE '%is_all_day%'
--             OR config::text LIKE '%assignees%';
--       -> 0 rows on staging, 2026-08-19. If that query returns rows at deploy time, add a
--       guarded UPDATE here rather than softening this paragraph.
--
--   (c) workflows.trigger_config / workflow_steps.config / workflow_versions.definition -
--       NOT REWRITTEN, deliberately, and NOT rewritten by the follow-up either. They hold the
--       automation AnchorKey as the literal string 'job.scheduled_start'. That string is FROZEN
--       as an opaque vocabulary token: it is pinned by a z.enum (workflowValidation.ts) and
--       mirrored in the frontend, and when the mirror column goes only its RESOLVER moves (to the
--       job's next upcoming live visit, which is precisely what the mirror held). Renaming it
--       would need a three-table JSONB rewrite plus an enum change for zero behavioural gain.
--       Verified:
--         SELECT count(*) FROM workflow_steps WHERE config::text LIKE '%job.scheduled_start%';
--       -> 1 row on staging, 2026-08-19, and it keeps working unchanged.

-- ─── 1. Repoint the stored OWN_JOB / OWN_INVOICE_VIA_JOB row scope onto the visits path ───────
--
-- role_permissions.conditions names a Prisma relation path by string. Section 6 drops
-- job_assignees, so every row still naming `assignees` on Job would point at a dead relation.
-- The precedent in FORM is 20260817140000_repoint_own_walkthrough_to_visits: match the exact
-- historical value, unfiltered by role, idempotent because a repaired row stops matching.
--
-- THIS IS NOT THAT PRECEDENT'S EQUIVALENCE-PRESERVING RENAME, and the difference matters.
-- 20260817140000 could argue "any row holding that exact path means the same thing before and
-- after" because walkthroughs -> visits was a pure rename. Here it is not: `Job.assignees` is
-- S3's ADD-ONLY UNION SUPERSET, and `Job.visits.some.assignees` is a STRICT SUBSET of it. Some
-- principals lose access, and the failure mode is a silent 403, never an error.
--
-- RESIDUE MEASURED AT AUTHORING TIME (staging redacted-staging-ref, 2026-08-19):
--     job_assignees rows                                   539
--     ...not reachable through any visit crew row             6   (across 5 distinct jobs)
--     jobs with no visit row at all                          75
-- Those 6 rows are the exact, silent access loss. TECHNICIAN's `read Job` is the OR shape, so
-- its created_by_id arm rescues a CREATOR; nothing rescues a plan-assigned technician, which is
-- why S8 also books a real visit for a service-plan visit-job (behaviour 9) - that closes the
-- second orphan class by construction rather than by hope.
-- PROD's residue is NOT this number, and it is measured HERE rather than deferred, because the
-- same deploy DROPS job_assignees - after the release `SELECT ... FROM job_assignees` errors and
-- the lost assignments become unnameable. An earlier draft of this paragraph said "re-run the
-- union-completeness query against prod after that deploy"; that plan cannot execute.
--
-- Prod has no visits table yet, so the whole S1-S8 series lands in one `prisma migrate deploy`
-- and S2/S3's backfills run minutes before this file. S2 only creates a visit
-- `WHERE j.scheduled_start IS NOT NULL`, and S3's fold is a LATERAL join onto an EXISTING visit -
-- so a job_assignees row on a job with a null scheduled_start reaches no visit and is deleted
-- outright by section 6. That predicate is computable now, and was, read-only against prod
-- (redacted-prod-ref) on 2026-08-20:
--     job_assignees rows                                        508
--     ...on jobs with scheduled_start IS NULL                    40   (40 jobs, 13 users)
--     ...of those, NOT rescued by the created_by_id arm          35
--   by role/status: ADMIN/UNASSIGNED 15, SALES/UNASSIGNED 9, SALES/COMPLETED 6,
--   DISPATCHER/UNASSIGNED 5, SALES/ON_SITE 1, SALES/IN_PROGRESS 1, ADMIN/COMPLETED 1,
--   ADMIN/CANCELLED 1, TECHNICIAN/COMPLETED 1.
--
-- Said plainly, because the honest number is small and the vague one is not: exactly ONE of the
-- 40 is a TECHNICIAN, and that job is COMPLETED - so the PERMISSION loss on prod is one row on
-- finished work. The other 39 are office staff who read org-wide anyway; what they lose is the
-- crew list rendered on 29 jobs still sitting in UNASSIGNED status, which will simply empty in
-- the UI after deploy with no error. If that is not acceptable, snapshot the table
-- (`CREATE TABLE job_assignees_pre_s8 AS SELECT * FROM job_assignees`) BEFORE the release - it
-- cannot be reconstructed afterwards.
--
-- This migration is guarded on STATE, never on either environment's arithmetic.
--
-- DELIBERATELY UNFILTERED BY ROLE. check-role-permission-drift.ts keys on
-- `role::action::subject` and only compares rows whose key exists in DEFAULT_GRANTS, which
-- lists SALES / DISPATCHER / TECHNICIAN only. Staging's custom roles qa-bug-repro,
-- qa-bug-repro-2 and zz-reachability-probe hold 12 byte-identical rows CI can never see. A
-- role predicate on these UPDATEs would leave them broken and silent.
--
-- SIX literals, not one. Measured on staging today: 49 rows on (a) and 11 on (b). (c)-(f) hold
-- zero rows today, but roleViewModel.ts emits them on any Roles-and-Permissions Save, so an
-- admin who saves between this migration and the code deploy creates one. They are matched here
-- so that row is repaired on the next run rather than left dead.
--
-- REJECTED ALTERNATIVE: a jsonb_path / regexp rewrite that repoints ANY occurrence of the
-- `assignees` key under a Job condition. It would also rewrite a genuinely customised condition
-- an operator authored by hand, and it cannot distinguish Job's `assignees` from a future
-- subject's. Six exact-value matches are verbose and boring, which is the point.
--
-- WITHOUT THE EXACT-VALUE GUARD a second run corrupts nothing here (the new value does not match
-- the old predicate), but a BROADER predicate would: re-running a `LIKE '%assignees%'` rewrite
-- over already-repaired rows would nest `visits` inside `visits`.

-- (a) the bare OWN_JOB shape - arrive / complete / start / update / read Job
UPDATE role_permissions
SET conditions = '{"visits":{"some":{"assignees":{"some":{"user_id":"{{userId}}"}}}}}'::jsonb,
    updated_at = NOW()
WHERE conditions = '{"assignees":{"some":{"user_id":"{{userId}}"}}}'::jsonb;

-- (b) the OR read shape (OWN_OR_CREATED_JOB). Missing this one is the consequential mistake:
--     it is `read Job`, so a technician would keep start/arrive/complete on a job that renders
--     404. 11 rows across 8 staging orgs, 5 rows across 5 prod orgs.
UPDATE role_permissions
SET conditions = '{"OR":[{"visits":{"some":{"assignees":{"some":{"user_id":"{{userId}}"}}}}},{"created_by_id":"{{userId}}"}]}'::jsonb,
    updated_at = NOW()
WHERE conditions = '{"OR":[{"assignees":{"some":{"user_id":"{{userId}}"}}},{"created_by_id":"{{userId}}"}]}'::jsonb;

-- (c) OWN_INVOICE_VIA_JOB - the Invoice row scope nests through the job, so the table drop
--     breaks it identically. Zero rows on staging today; the editor can create one.
UPDATE role_permissions
SET conditions = '{"job":{"visits":{"some":{"assignees":{"some":{"user_id":"{{userId}}"}}}}}}'::jsonb,
    updated_at = NOW()
WHERE conditions = '{"job":{"assignees":{"some":{"user_id":"{{userId}}"}}}}'::jsonb;

-- (d) Job scope chip "Team"
UPDATE role_permissions
SET conditions = '{"visits":{"some":{"assignees":{"some":{"user":{"department_id":"{{teamId}}"}}}}}}'::jsonb,
    updated_at = NOW()
WHERE conditions = '{"assignees":{"some":{"user":{"department_id":"{{teamId}}"}}}}'::jsonb;

-- (e) Job scope chip "Location"
UPDATE role_permissions
SET conditions = '{"visits":{"some":{"assignees":{"some":{"user":{"location_id":"{{locationId}}"}}}}}}'::jsonb,
    updated_at = NOW()
WHERE conditions = '{"assignees":{"some":{"user":{"location_id":"{{locationId}}"}}}}'::jsonb;

-- (f) Invoice scope chips "Team" and "Location"
UPDATE role_permissions
SET conditions = '{"job":{"visits":{"some":{"assignees":{"some":{"user":{"department_id":"{{teamId}}"}}}}}}}'::jsonb,
    updated_at = NOW()
WHERE conditions = '{"job":{"assignees":{"some":{"user":{"department_id":"{{teamId}}"}}}}}'::jsonb;

UPDATE role_permissions
SET conditions = '{"job":{"visits":{"some":{"assignees":{"some":{"user":{"location_id":"{{locationId}}"}}}}}}}'::jsonb,
    updated_at = NOW()
WHERE conditions = '{"job":{"assignees":{"some":{"user":{"location_id":"{{locationId}}"}}}}}'::jsonb;

-- ─── 5. DROP visit_assignees.lead_id - LAST among the column drops ─────────────────────────────
--
-- S3 made this column nullable and DELIBERATELY kept it, because seven select sites read Lead's
-- `visit_assignees` back-relation through it - and TWO of them (attachment.controller.ts, the
-- SALES and TECHNICIAN lead-attachment checks) are ACCESS decisions, not rendering. Dropping it
-- before those moved would have been a permission hole for no behavioural gain, which is exactly
-- what the S3 header said.
--
-- All seven now traverse `lead.visits[].assignees`: lead.controller (list select, detail select,
-- the remove() include), estimate.controller, job.controller (estimate.lead), and the two
-- attachment checks. The PROJECTED wire key on the lead payload is still `visit_assignees`,
-- flattened WITHOUT dedupe, so a person on two of the lead's visits still appears twice - exactly
-- as today. Nothing on the client changes.
--
-- The index goes before the column, because dropping a column silently drops its index and
-- naming the drop keeps the ledger honest about what left.
--
-- REJECTED ALTERNATIVE: keep the column and stop writing it. A permanently-null FK that nothing
-- reads is scaffolding nobody will ever come back for, and this is the last slice - there is no
-- later one to tidy it in.
--
-- WITHOUT THE GUARD a second run errors on a column that is already gone; IF EXISTS is what makes
-- the re-run a no-op rather than a failed migration.
DROP INDEX IF EXISTS "visit_assignees_lead_id_idx";

ALTER TABLE "visit_assignees" DROP COLUMN IF EXISTS "lead_id";

-- ─── 6. DROP TABLE job_assignees ──────────────────────────────────────────────────────────────
--
-- D6's end state: crew lives on the visit, and "the job's crew" is a derived union over its
-- trips. Nothing writes this table any more - replaceJobCrew and syncJobCrewUnion are deleted,
-- the four self-assign-on-create sites write nothing (a create path that booked no visit has no
-- trip for the creator to be on, and OWN_OR_CREATED_JOB's created_by_id arm carries their access
-- instead), and the job payload's `assignees` key is projected from the visit set.
--
-- RLS: this DROP takes the table's `tenant_isolation` policy from 20260703000100_tenant_rls with
-- it, which is correct and is said out loud here rather than left for a reader to wonder about.
-- No GRANT or CREATE POLICY is issued anywhere in this file - a duplicate of either is what would
-- make a re-run non-idempotent.
--
-- ORDER: this runs AFTER section 1, and that is the whole reason section 1 is first. A stored
-- condition still naming `assignees` on Job after this point would make scopeWhereFor build a
-- Prisma `where` against a relation that no longer exists, which THROWS - it does not fail open.
--
-- REJECTED ALTERNATIVE: leave the table in place, unwritten, as a rollback cushion. It would be a
-- false one: the rows stop being maintained the moment the code deploys, so a revert would
-- restore the code onto a table that has been drifting - worse than no cushion at all. The real
-- rollback story is the tag, not the table.
DROP TABLE IF EXISTS "job_assignees";
