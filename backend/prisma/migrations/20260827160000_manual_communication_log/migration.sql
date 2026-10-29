-- Manual Communication Log, slice 1
-- (spec: md_files/specs/communication/2026-08-27-manual-communication-log.md).
--
-- ONE migration, not four. Slice 1 only ever writes channel / direction / occurred_at /
-- performed_by / logged_by / notes / lead_id, but duration_minutes, outcome, subject and job_id
-- are created HERE because slices 3, 5 and 6 need them and four ALTER TABLEs against a table
-- this small buys nothing. All four are nullable, so an entry written today stays valid after
-- those slices ship.
--
-- Storage is a DEDICATED table, deliberately not a provenance flag on call_sessions: nothing in
-- the Communication module reads this table, so the exclusion from the Calls view, Performance,
-- agent metrics and call reports costs no code and cannot be forgotten by a future report.
--
-- The tenant_isolation RLS backstop ships in THIS migration, on the same commit as the table.
-- rls-coverage.test.ts is a ratchet over every table carrying organization_id and would redden
-- the `Database (migrations + RLS)` job the moment this table existed without it - that is
-- issue #1276's exact failure mode (automation_rules / automation_runs / job_line_items /
-- org_tax_rates all reached prod with relrowsecurity=false because table and policy shipped in
-- different PRs).
--
-- Idempotent (IF NOT EXISTS / duplicate_object guards / DROP POLICY IF EXISTS) and portable: the
-- anon/authenticated REVOKEs are guarded behind a role-existence check so this applies cleanly to
-- CI's vanilla postgres:16 as well as to Supabase. NEVER run `prisma migrate` from a worktree -
-- this file is applied by CI, by the Render deploy, or by hand through the Supabase MCP.

-- ─── 1. Enums ─────────────────────────────────────────────────────────────────

DO $$ BEGIN
  CREATE TYPE "ManualCommChannel" AS ENUM ('CALL','SMS','EMAIL');
EXCEPTION WHEN duplicate_object THEN null; END $$;

DO $$ BEGIN
  CREATE TYPE "ManualCommDirection" AS ENUM ('IN','OUT');
EXCEPTION WHEN duplicate_object THEN null; END $$;

DO $$ BEGIN
  CREATE TYPE "ManualCommOutcome" AS ENUM ('CONNECTED','NO_ANSWER','VOICEMAIL','CALLBACK_REQUESTED');
EXCEPTION WHEN duplicate_object THEN null; END $$;

-- ─── 2. Table ─────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS "manual_communication_logs" (
  "id"               UUID                  NOT NULL,
  "organization_id"  UUID                  NOT NULL,
  "channel"          "ManualCommChannel"   NOT NULL DEFAULT 'CALL',
  "direction"        "ManualCommDirection" NOT NULL,
  -- A true instant. Composed against the ORGANISATION's timezone at write time, never the
  -- browser's and never the server's; the API takes a zoneless wall clock for exactly that reason.
  "occurred_at"      TIMESTAMP(3)          NOT NULL,
  -- performed_by: who HAD the conversation. logged_by: who TYPED the entry, set once at creation.
  "performed_by"     UUID                  NOT NULL,
  "logged_by"        UUID                  NOT NULL,
  "notes"            TEXT                  NOT NULL,
  "duration_minutes" INTEGER,
  "outcome"          "ManualCommOutcome",
  "subject"          TEXT,
  "lead_id"          UUID,
  "job_id"           UUID,
  "created_at"       TIMESTAMP(3)          NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"       TIMESTAMP(3)          NOT NULL,
  CONSTRAINT "manual_communication_logs_pkey" PRIMARY KEY ("id")
);

-- ─── 3. Exactly-one-anchor CHECK ──────────────────────────────────────────────
--
-- The invariant Prisma cannot express, and the reason an entry can be neither orphaned nor
-- double-counted. num_nonnulls is a Postgres builtin, so this stays one expression rather than a
-- pair of OR'd null tests. Same shape as `visits_exactly_one_parent` (multi-visit S1, D5).

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'manual_communication_logs_exactly_one_anchor') THEN
    ALTER TABLE "manual_communication_logs"
      ADD CONSTRAINT "manual_communication_logs_exactly_one_anchor"
      CHECK (num_nonnulls("lead_id", "job_id") = 1);
  END IF;
END $$;

-- ─── 4. Indexes ───────────────────────────────────────────────────────────────
--
-- Organisation, lead and job: the three access patterns of the three aggregators in
-- lib/job-communications.ts. Slice 1 wires only the lead-scoped one; the other two indexes ship
-- with the columns they serve rather than trailing them by two slices.

CREATE INDEX IF NOT EXISTS "manual_communication_logs_organization_id_idx"
  ON "manual_communication_logs"("organization_id");
CREATE INDEX IF NOT EXISTS "manual_communication_logs_lead_id_idx"
  ON "manual_communication_logs"("lead_id");
CREATE INDEX IF NOT EXISTS "manual_communication_logs_job_id_idx"
  ON "manual_communication_logs"("job_id");

-- ─── 5. Foreign keys ──────────────────────────────────────────────────────────
--
-- lead/job CASCADE, not SET NULL: an entry names exactly one anchor, so nulling that anchor
-- would leave a row violating the CHECK above. The two user seats RESTRICT - a user with logged
-- history cannot be hard-deleted out from under it (users are deactivated, not deleted).

DO $$ BEGIN
  ALTER TABLE "manual_communication_logs" ADD CONSTRAINT "manual_communication_logs_organization_id_fkey"
    FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN null; END $$;

DO $$ BEGIN
  ALTER TABLE "manual_communication_logs" ADD CONSTRAINT "manual_communication_logs_lead_id_fkey"
    FOREIGN KEY ("lead_id") REFERENCES "leads"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN null; END $$;

DO $$ BEGIN
  ALTER TABLE "manual_communication_logs" ADD CONSTRAINT "manual_communication_logs_job_id_fkey"
    FOREIGN KEY ("job_id") REFERENCES "jobs"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN null; END $$;

DO $$ BEGIN
  ALTER TABLE "manual_communication_logs" ADD CONSTRAINT "manual_communication_logs_performed_by_fkey"
    FOREIGN KEY ("performed_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN null; END $$;

DO $$ BEGIN
  ALTER TABLE "manual_communication_logs" ADD CONSTRAINT "manual_communication_logs_logged_by_fkey"
    FOREIGN KEY ("logged_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN null; END $$;

-- ─── 6. Tenant RLS backstop (20260824190000_calendar_entries_crud shape) ──────
--
-- ENABLE + FORCE + the canonical tenant_isolation predicate, verbatim. rls-coverage.test.ts
-- compares the normalized qual AND with_check strings against a constant, so this pair must not
-- be paraphrased.

ALTER TABLE "manual_communication_logs" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "manual_communication_logs" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "tenant_isolation" ON "manual_communication_logs";
CREATE POLICY "tenant_isolation" ON "manual_communication_logs"
  USING (current_setting('app.bypass_rls', true) = 'on' OR "organization_id" = NULLIF(current_setting('app.current_org_id', true), '')::uuid)
  WITH CHECK (current_setting('app.bypass_rls', true) = 'on' OR "organization_id" = NULLIF(current_setting('app.current_org_id', true), '')::uuid);

-- Defense in depth, mirroring 20260708140000_revoke_api_roles_on_tenant_tables. Each role is
-- guarded SEPARATELY, never one combined REVOKE naming both: a single statement naming two roles
-- fails outright if only one exists, and vanilla postgres:16 has neither. Idempotent - revoking
-- an absent privilege is a no-op.
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    EXECUTE 'REVOKE ALL PRIVILEGES ON public.manual_communication_logs FROM anon';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    EXECUTE 'REVOKE ALL PRIVILEGES ON public.manual_communication_logs FROM authenticated';
  END IF;
END $$;
