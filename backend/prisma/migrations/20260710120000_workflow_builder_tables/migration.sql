-- Workflow Builder (Automation Center v2): workflows + workflow_steps +
-- workflow_versions + workflow_enrollments + workflow_step_runs.
--
-- Schema-only foundation for the multi-step successor to AutomationRule/
-- AutomationRun (both untouched — the legacy single-step engine keeps running
-- through the migration). No engine/controller code lands with this migration.
--
-- Idempotent on purpose: the ServWave test-env redeploys against the SHARED
-- staging Supabase DB, and CI's migration-check applies every migration to a
-- fresh vanilla postgres:16 container. NEVER run `prisma migrate` from a
-- worktree (it mutates staging silently). Portable: standard Postgres only,
-- no Supabase-only objects — role-dependent statements are guarded.

-- ── Enums ──────────────────────────────────────────────────────────────────
DO $$ BEGIN
  CREATE TYPE "WorkflowStatus" AS ENUM ('DRAFT', 'PUBLISHED');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE "WorkflowStepType" AS ENUM ('WAIT', 'SEND_TEXT', 'SEND_EMAIL', 'NOTIFY_TEAM', 'STOP_IF');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE "WorkflowEnrollmentStatus" AS ENUM ('ACTIVE', 'COMPLETED', 'STOPPED', 'FAILED');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE "WorkflowStepRunStatus" AS ENUM ('SENT', 'SKIPPED', 'FAILED', 'STOPPED', 'CONTINUED');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ── Tables ─────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "workflows" (
  "id"                    UUID NOT NULL,
  "name"                  TEXT NOT NULL,
  "status"                "WorkflowStatus" NOT NULL DEFAULT 'DRAFT',
  "is_enabled"            BOOLEAN NOT NULL DEFAULT false,
  "trigger_type"          "AutomationTriggerType" NOT NULL,
  "trigger_config"        JSONB,
  "send_window"           "AutomationSendWindow" NOT NULL DEFAULT 'ANYTIME',
  "template_key"          TEXT,
  "legacy_rule_id"        UUID,
  "published_version_id"  UUID,
  "published_at"          TIMESTAMP(3),
  "last_triggered_at"     TIMESTAMP(3),
  "trigger_count"         INTEGER NOT NULL DEFAULT 0,
  "created_by_id"         UUID,
  "created_at"            TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"            TIMESTAMP(3) NOT NULL,
  "organization_id"       UUID NOT NULL,
  CONSTRAINT "workflows_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "workflow_steps" (
  "id"              UUID NOT NULL,
  "workflow_id"     UUID NOT NULL,
  "position"        INTEGER NOT NULL,
  "step_type"       "WorkflowStepType" NOT NULL,
  "config"          JSONB NOT NULL,
  "organization_id" UUID NOT NULL,
  CONSTRAINT "workflow_steps_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "workflow_versions" (
  "id"                UUID NOT NULL,
  "workflow_id"       UUID NOT NULL,
  "version"           INTEGER NOT NULL,
  "definition"        JSONB NOT NULL,
  "published_at"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "published_by_id"   UUID,
  "organization_id"   UUID NOT NULL,
  CONSTRAINT "workflow_versions_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "workflow_enrollments" (
  "id"                   UUID NOT NULL,
  "workflow_id"          UUID NOT NULL,
  "workflow_version_id"  UUID NOT NULL,
  "status"               "WorkflowEnrollmentStatus" NOT NULL DEFAULT 'ACTIVE',
  "entity_type"          TEXT NOT NULL,
  "entity_id"            UUID NOT NULL,
  "entity_label"         TEXT,
  "occurrence_key"       TEXT,
  "dedupe_key"           TEXT NOT NULL,
  "step_cursor"          INTEGER NOT NULL DEFAULT 0,
  "resume_at"            TIMESTAMP(3) NOT NULL,
  "started_at"           TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "finished_at"          TIMESTAMP(3),
  "finished_reason"      TEXT,
  "organization_id"      UUID NOT NULL,
  CONSTRAINT "workflow_enrollments_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "workflow_step_runs" (
  "id"                 UUID NOT NULL,
  "enrollment_id"      UUID NOT NULL,
  "step_index"         INTEGER NOT NULL,
  "step_type"          "WorkflowStepType" NOT NULL,
  "status"             "WorkflowStepRunStatus" NOT NULL,
  "executed_at"        TIMESTAMP(3),
  "recipient_summary"  TEXT,
  "detail"             TEXT,
  "created_at"         TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "organization_id"    UUID NOT NULL,
  CONSTRAINT "workflow_step_runs_pkey" PRIMARY KEY ("id")
);

-- ── Indexes / uniques ──────────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS "workflows_organization_id_trigger_type_is_enabled_idx"
  ON "workflows"("organization_id","trigger_type","is_enabled");
CREATE INDEX IF NOT EXISTS "workflows_organization_id_idx"
  ON "workflows"("organization_id");

CREATE UNIQUE INDEX IF NOT EXISTS "workflow_steps_workflow_id_position_key"
  ON "workflow_steps"("workflow_id","position");
CREATE INDEX IF NOT EXISTS "workflow_steps_workflow_id_idx"
  ON "workflow_steps"("workflow_id");

CREATE UNIQUE INDEX IF NOT EXISTS "workflow_versions_workflow_id_version_key"
  ON "workflow_versions"("workflow_id","version");

CREATE UNIQUE INDEX IF NOT EXISTS "workflow_enrollments_workflow_id_dedupe_key_key"
  ON "workflow_enrollments"("workflow_id","dedupe_key");
CREATE INDEX IF NOT EXISTS "workflow_enrollments_status_resume_at_idx"
  ON "workflow_enrollments"("status","resume_at");
CREATE INDEX IF NOT EXISTS "workflow_enrollments_organization_id_status_started_at_idx"
  ON "workflow_enrollments"("organization_id","status","started_at");

CREATE UNIQUE INDEX IF NOT EXISTS "workflow_step_runs_enrollment_id_step_index_key"
  ON "workflow_step_runs"("enrollment_id","step_index");
CREATE INDEX IF NOT EXISTS "workflow_step_runs_organization_id_created_at_idx"
  ON "workflow_step_runs"("organization_id","created_at");

-- ── Foreign keys (idempotent via DO/EXCEPTION — no ADD CONSTRAINT IF NOT EXISTS in PG) ──
DO $$ BEGIN
  ALTER TABLE "workflow_steps" ADD CONSTRAINT "workflow_steps_workflow_id_fkey"
    FOREIGN KEY ("workflow_id") REFERENCES "workflows"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "workflow_versions" ADD CONSTRAINT "workflow_versions_workflow_id_fkey"
    FOREIGN KEY ("workflow_id") REFERENCES "workflows"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "workflow_enrollments" ADD CONSTRAINT "workflow_enrollments_workflow_id_fkey"
    FOREIGN KEY ("workflow_id") REFERENCES "workflows"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "workflow_enrollments" ADD CONSTRAINT "workflow_enrollments_workflow_version_id_fkey"
    FOREIGN KEY ("workflow_version_id") REFERENCES "workflow_versions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "workflow_step_runs" ADD CONSTRAINT "workflow_step_runs_enrollment_id_fkey"
    FOREIGN KEY ("enrollment_id") REFERENCES "workflow_enrollments"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ── Row-Level Security ─────────────────────────────────────────────────────
-- DB_TENANT_GUARD is ON in staging/prod — an un-policied table returns 0 rows
-- once the app connects as a non-BYPASSRLS role. Same fail-closed pattern as
-- 20260707120000_estimate_workspace_rls_backstop: direct organization_id
-- check (every table here carries its own organization_id column).
ALTER TABLE "workflows" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "workflows" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "tenant_isolation" ON "workflows";
CREATE POLICY "tenant_isolation" ON "workflows"
  USING (current_setting('app.bypass_rls', true) = 'on' OR "organization_id" = NULLIF(current_setting('app.current_org_id', true), '')::uuid)
  WITH CHECK (current_setting('app.bypass_rls', true) = 'on' OR "organization_id" = NULLIF(current_setting('app.current_org_id', true), '')::uuid);

ALTER TABLE "workflow_steps" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "workflow_steps" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "tenant_isolation" ON "workflow_steps";
CREATE POLICY "tenant_isolation" ON "workflow_steps"
  USING (current_setting('app.bypass_rls', true) = 'on' OR "organization_id" = NULLIF(current_setting('app.current_org_id', true), '')::uuid)
  WITH CHECK (current_setting('app.bypass_rls', true) = 'on' OR "organization_id" = NULLIF(current_setting('app.current_org_id', true), '')::uuid);

ALTER TABLE "workflow_versions" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "workflow_versions" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "tenant_isolation" ON "workflow_versions";
CREATE POLICY "tenant_isolation" ON "workflow_versions"
  USING (current_setting('app.bypass_rls', true) = 'on' OR "organization_id" = NULLIF(current_setting('app.current_org_id', true), '')::uuid)
  WITH CHECK (current_setting('app.bypass_rls', true) = 'on' OR "organization_id" = NULLIF(current_setting('app.current_org_id', true), '')::uuid);

ALTER TABLE "workflow_enrollments" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "workflow_enrollments" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "tenant_isolation" ON "workflow_enrollments";
CREATE POLICY "tenant_isolation" ON "workflow_enrollments"
  USING (current_setting('app.bypass_rls', true) = 'on' OR "organization_id" = NULLIF(current_setting('app.current_org_id', true), '')::uuid)
  WITH CHECK (current_setting('app.bypass_rls', true) = 'on' OR "organization_id" = NULLIF(current_setting('app.current_org_id', true), '')::uuid);

ALTER TABLE "workflow_step_runs" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "workflow_step_runs" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "tenant_isolation" ON "workflow_step_runs";
CREATE POLICY "tenant_isolation" ON "workflow_step_runs"
  USING (current_setting('app.bypass_rls', true) = 'on' OR "organization_id" = NULLIF(current_setting('app.current_org_id', true), '')::uuid)
  WITH CHECK (current_setting('app.bypass_rls', true) = 'on' OR "organization_id" = NULLIF(current_setting('app.current_org_id', true), '')::uuid);

-- ── Defense-in-depth: revoke default PostgREST grants ─────────────────────
-- The app never connects as anon/authenticated (it uses app_rls/postgres),
-- and RLS above already blocks them — this removes the reliance on RLS
-- staying enabled (mirrors 20260708140000_revoke_api_roles_on_tenant_tables).
-- Portable: anon/authenticated exist only on Supabase, guarded behind a
-- role-existence check so vanilla postgres:16 (CI) is unaffected. Idempotent:
-- REVOKE of an already-absent privilege is a no-op.
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    EXECUTE 'REVOKE ALL PRIVILEGES ON public.workflows, public.workflow_steps, public.workflow_versions, public.workflow_enrollments, public.workflow_step_runs FROM anon';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    EXECUTE 'REVOKE ALL PRIVILEGES ON public.workflows, public.workflow_steps, public.workflow_versions, public.workflow_enrollments, public.workflow_step_runs FROM authenticated';
  END IF;
END $$;
