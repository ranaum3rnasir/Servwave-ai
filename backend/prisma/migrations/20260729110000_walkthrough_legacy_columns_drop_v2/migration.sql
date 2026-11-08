-- Walkthrough-as-entity redesign, PR-D2 (spec md_files/specs/leads/2026-07-28-walkthrough-as-entity.md,
-- plan md_files/plans/leads/2026-07-28-walkthrough-as-entity-phase-2.md). Final cleanup step: drops
-- the 9 legacy Lead.walkthrough_* columns (+ the walkthrough_canceller FK/relation) that PR-A2
-- backfilled off of and PR-B2 repointed every read/write away from, plus the 2 dead
-- Job.walkthrough_* columns orphaned when the job-level walkthrough route was removed in the
-- scheduler redesign. Every write path onto these columns (the dual-write helper
-- stampLegacyWalkthroughColumns) is deleted in the same PR, so nothing writes them anymore.
--
-- Does NOT touch Organization.default_walkthrough_duration_min - a separate org-level UI default,
-- not one of the 9 Lead columns.
--
-- IDEMPOTENT: every DROP CONSTRAINT / DROP COLUMN below is guarded with IF EXISTS, following the
--   precedent set by 20260610120100_assignment_backfill_supersede_drop (the equivalent
--   walkthrough_assigned_to cleanup) - the constraint is dropped before the column it lives on, and
--   a second application of this file against an already-migrated DB is a no-op.
-- PORTABLE: vanilla postgres:16 (CI migration-check) - no Supabase-only objects are touched here at
--   all (no roles, no auth.uid(), no RLS policy edits), so no pg_roles guard is needed.

-- 1. Drop the FK constraint before the column it lives on.
ALTER TABLE "leads" DROP CONSTRAINT IF EXISTS "leads_walkthrough_cancelled_by_fkey";

-- 2. Drop the 9 legacy Lead.walkthrough_* columns.
ALTER TABLE "leads" DROP COLUMN IF EXISTS "walkthrough_scheduled_at";
ALTER TABLE "leads" DROP COLUMN IF EXISTS "walkthrough_completed_at";
ALTER TABLE "leads" DROP COLUMN IF EXISTS "walkthrough_notes";
ALTER TABLE "leads" DROP COLUMN IF EXISTS "walkthrough_duration_minutes";
ALTER TABLE "leads" DROP COLUMN IF EXISTS "walkthrough_needed";
ALTER TABLE "leads" DROP COLUMN IF EXISTS "walkthrough_cancelled_at";
ALTER TABLE "leads" DROP COLUMN IF EXISTS "walkthrough_cancelled_reason";
ALTER TABLE "leads" DROP COLUMN IF EXISTS "walkthrough_cancelled_by";
ALTER TABLE "leads" DROP COLUMN IF EXISTS "walkthrough_customer_email_sent_at";

-- 3. Drop the 2 dead Job.walkthrough_* columns (orphaned, job-level route already removed).
ALTER TABLE "jobs" DROP COLUMN IF EXISTS "walkthrough_notes";
ALTER TABLE "jobs" DROP COLUMN IF EXISTS "walkthrough_completed_at";
