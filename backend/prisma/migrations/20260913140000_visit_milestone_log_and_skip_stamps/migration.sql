-- Visit milestone skip stamps and the append-only milestone log (spec
-- md_files/specs/scheduling/2026-09-13-customer-scheduling-notifications-and-visit-milestones.md,
-- "Skip stamps and the milestone log", slice 08).
--
-- A technician who never tapped "On the way" can still tap "Start work". The tap stamps the
-- earlier milestones with the SAME instant and marks them skipped, so the per-visit stamp columns
-- keep meaning "current state" (the status derivation and the job-level mirror read them
-- unchanged) while a report can exclude a skipped stamp instead of reading zero minutes.
--
-- PURE EXPAND. Three additive BOOLEAN columns with a NOT NULL DEFAULT false, which Postgres
-- applies as a catalog default without rewriting the table, and one new table. Nothing is dropped
-- or renamed, so the old instance during the deploy overlap never names a column that has gone
-- (see 20260908120000_manual_comm_customer_anchor's header for the hazard). Every existing visit
-- reads "nothing skipped", which is true: nothing could skip before this migration.
--
-- IDEMPOTENT + portable: every statement is IF NOT EXISTS / guarded, plain DDL, no hosted-platform
-- objects, no auth.* helpers, no TO authenticated / anon / service_role unguarded. Runs on CI's
-- vanilla postgres:16, on the deploy hook's migration step, and possibly twice against the shared
-- staging DB. NEVER apply it by hand from a worktree: the local .env points at staging.

-- ─── 1. Per-milestone skipped markers on the visit ────────────────────────────
--
-- One per SKIPPABLE milestone. Completed is last in lifecycle order and can never be skipped, so
-- it carries no marker. A marker is cleared whenever its milestone is tapped for real or rewound.

ALTER TABLE "visits" ADD COLUMN IF NOT EXISTS "en_route_skipped" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "visits" ADD COLUMN IF NOT EXISTS "on_site_skipped" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "visits" ADD COLUMN IF NOT EXISTS "started_skipped" BOOLEAN NOT NULL DEFAULT false;

-- ─── 2. The two enums behind the log ──────────────────────────────────────────
--
-- Guarded on pg_type: Postgres has no CREATE TYPE IF NOT EXISTS, and the shared staging DB may
-- see this file twice. The milestone values ARE the writer's own keys (VISIT_MILESTONE_COLUMNS),
-- in lifecycle order.

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'VisitMilestoneName') THEN
    CREATE TYPE "VisitMilestoneName" AS ENUM ('en_route', 'on_site', 'started', 'completed');
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'VisitMilestoneLogKind') THEN
    CREATE TYPE "VisitMilestoneLogKind" AS ENUM ('tapped', 'skipped', 'reverted');
  END IF;
END $$;

-- ─── 3. The append-only milestone log ─────────────────────────────────────────
--
-- One row per EVENT: a real tap, a milestone stamped as skipped by a later tap, or a milestone a
-- rewind cleared. The application only ever INSERTs here; a rewind appends `reverted` rows and
-- deletes nothing, so time-to-arrive and time-on-site can be reported off the trace rather than
-- off a stamp that may have been skipped or rewound.
--
-- Org-scoped like `visits` so the same tenant policy reaches it. `actor_id` is nullable only so
-- a deleted user leaves the history standing (SET NULL); every writer sets it. A deleted visit
-- takes its history with it (CASCADE) - the visit row is the anchor the trace is meaningless
-- without.

CREATE TABLE IF NOT EXISTS "visit_milestone_log" (
  "id"              UUID NOT NULL,
  "organization_id" UUID NOT NULL,
  "visit_id"        UUID NOT NULL,
  "milestone"       "VisitMilestoneName" NOT NULL,
  "kind"            "VisitMilestoneLogKind" NOT NULL,
  "occurred_at"     TIMESTAMP(3) NOT NULL,
  "actor_id"        UUID,
  "created_at"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "visit_milestone_log_pkey" PRIMARY KEY ("id")
);

DO $$ BEGIN
  ALTER TABLE "visit_milestone_log" ADD CONSTRAINT "visit_milestone_log_organization_id_fkey"
    FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN null; END $$;

DO $$ BEGIN
  ALTER TABLE "visit_milestone_log" ADD CONSTRAINT "visit_milestone_log_visit_id_fkey"
    FOREIGN KEY ("visit_id") REFERENCES "visits"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN null; END $$;

DO $$ BEGIN
  ALTER TABLE "visit_milestone_log" ADD CONSTRAINT "visit_milestone_log_actor_id_fkey"
    FOREIGN KEY ("actor_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN null; END $$;

-- The report's access pattern is "this visit's trace in order"; the org index serves the tenant
-- policy the same way `visits_organization_id_idx` does one table over.
CREATE INDEX IF NOT EXISTS "visit_milestone_log_visit_id_occurred_at_idx"
  ON "visit_milestone_log"("visit_id", "occurred_at");
CREATE INDEX IF NOT EXISTS "visit_milestone_log_organization_id_idx"
  ON "visit_milestone_log"("organization_id");

-- ─── 4. Tenant RLS, the same fail-closed policy visits carries ────────────────
--
-- Inert until the app connects as a non-BYPASSRLS role AND DB_TENANT_GUARD=on, exactly as for
-- call_tracking_integrations (20260910120000). DROP POLICY IF EXISTS before CREATE keeps a
-- second application a no-op.
ALTER TABLE "visit_milestone_log" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "visit_milestone_log" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "tenant_isolation" ON "visit_milestone_log";
CREATE POLICY "tenant_isolation" ON "visit_milestone_log"
  USING (current_setting('app.bypass_rls', true) = 'on' OR "organization_id" = NULLIF(current_setting('app.current_org_id', true), '')::uuid)
  WITH CHECK (current_setting('app.bypass_rls', true) = 'on' OR "organization_id" = NULLIF(current_setting('app.current_org_id', true), '')::uuid);

-- Strip the PostgREST role grants (the dynamic sweep in 20260708140000 ran before this table
-- existed). Guarded: the two roles exist only on the hosted database, not on CI's postgres:16.
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    EXECUTE 'REVOKE ALL PRIVILEGES ON public.visit_milestone_log FROM anon';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    EXECUTE 'REVOKE ALL PRIVILEGES ON public.visit_milestone_log FROM authenticated';
  END IF;
END $$;
