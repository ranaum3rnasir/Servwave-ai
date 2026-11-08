-- Automation Center: automation_rules + automation_runs + DISPATCHER grants backfill.
--
-- Idempotent on purpose: the ServWave test-env redeploys against the SHARED
-- staging Supabase DB. NEVER run `prisma migrate` from a worktree (it mutates
-- staging silently). Applied by CI (vanilla postgres:16) + Render deploy;
-- portable: standard Postgres only, no Supabase-only objects. Safe to re-run.

DO $$ BEGIN
  CREATE TYPE "AutomationTriggerType" AS ENUM
    ('JOB_SCHEDULED','JOB_RESCHEDULED','TECH_ASSIGNED','JOB_COMPLETED','JOB_CANCELLED',
     'ESTIMATE_SENT','ESTIMATE_APPROVED','ESTIMATE_DECLINED',
     'INVOICE_SENT','INVOICE_PAID','LEAD_CREATED',
     'BEFORE_JOB_START','AFTER_JOB_COMPLETED','INVOICE_OVERDUE','ESTIMATE_FOLLOW_UP');
EXCEPTION WHEN duplicate_object THEN null; END $$;

DO $$ BEGIN
  CREATE TYPE "AutomationActionType" AS ENUM ('SEND_EMAIL','SEND_SMS','NOTIFY_TEAM');
EXCEPTION WHEN duplicate_object THEN null; END $$;

DO $$ BEGIN
  CREATE TYPE "AutomationSendWindow" AS ENUM ('ANYTIME','BUSINESS_HOURS');
EXCEPTION WHEN duplicate_object THEN null; END $$;

DO $$ BEGIN
  CREATE TYPE "AutomationRunStatus" AS ENUM ('PENDING','SENT','SKIPPED','FAILED');
EXCEPTION WHEN duplicate_object THEN null; END $$;

CREATE TABLE IF NOT EXISTS "automation_rules" (
  "id"                UUID NOT NULL,
  "name"              TEXT NOT NULL,
  "is_enabled"        BOOLEAN NOT NULL DEFAULT true,
  "trigger_type"      "AutomationTriggerType" NOT NULL,
  "trigger_config"    JSONB,
  "action_type"       "AutomationActionType" NOT NULL,
  "action_config"     JSONB NOT NULL,
  "send_window"       "AutomationSendWindow" NOT NULL DEFAULT 'ANYTIME',
  "template_key"      TEXT,
  "created_by_id"     UUID,
  "last_triggered_at" TIMESTAMP(3),
  "trigger_count"     INTEGER NOT NULL DEFAULT 0,
  "created_at"        TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"        TIMESTAMP(3) NOT NULL,
  "organization_id"   UUID NOT NULL,
  CONSTRAINT "automation_rules_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "automation_runs" (
  "id"                UUID NOT NULL,
  "rule_id"           UUID NOT NULL,
  "status"            "AutomationRunStatus" NOT NULL DEFAULT 'PENDING',
  "entity_type"       TEXT NOT NULL,
  "entity_id"         UUID NOT NULL,
  "entity_label"      TEXT,
  "dedupe_key"        TEXT NOT NULL,
  "fire_at"           TIMESTAMP(3) NOT NULL,
  "executed_at"       TIMESTAMP(3),
  "recipient_summary" TEXT,
  "detail"            TEXT,
  "created_at"        TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "organization_id"   UUID NOT NULL,
  CONSTRAINT "automation_runs_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "automation_rules_organization_id_trigger_type_idx"
  ON "automation_rules"("organization_id","trigger_type");
CREATE INDEX IF NOT EXISTS "automation_rules_organization_id_idx"
  ON "automation_rules"("organization_id");

CREATE UNIQUE INDEX IF NOT EXISTS "automation_runs_rule_id_dedupe_key_key"
  ON "automation_runs"("rule_id","dedupe_key");
CREATE INDEX IF NOT EXISTS "automation_runs_organization_id_status_fire_at_idx"
  ON "automation_runs"("organization_id","status","fire_at");
CREATE INDEX IF NOT EXISTS "automation_runs_rule_id_created_at_idx"
  ON "automation_runs"("rule_id","created_at");
CREATE INDEX IF NOT EXISTS "automation_runs_organization_id_created_at_idx"
  ON "automation_runs"("organization_id","created_at");

DO $$ BEGIN
  ALTER TABLE "automation_rules" ADD CONSTRAINT "automation_rules_organization_id_fkey"
    FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN null; END $$;

DO $$ BEGIN
  ALTER TABLE "automation_rules" ADD CONSTRAINT "automation_rules_created_by_id_fkey"
    FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN null; END $$;

DO $$ BEGIN
  ALTER TABLE "automation_runs" ADD CONSTRAINT "automation_runs_rule_id_fkey"
    FOREIGN KEY ("rule_id") REFERENCES "automation_rules"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN null; END $$;

DO $$ BEGIN
  ALTER TABLE "automation_runs" ADD CONSTRAINT "automation_runs_organization_id_fkey"
    FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN null; END $$;

-- ── DISPATCHER grants backfill ────────────────────────────────────────────────
-- The 'Automation' CASL subject ships with this migration; ADMIN reaches it via
-- the code-level "manage all", DISPATCHER needs explicit role_permissions rows.
-- The canonical grant set lives in defaultGrants.ts; this SQL must match it
-- (pinned by backend/src/__tests__/permissions-automation-backfill.test.ts).
-- SALES / TECHNICIAN intentionally have NO Automation grants (org-level config).
INSERT INTO role_permissions (id, organization_id, role, action, subject, conditions, created_at, updated_at)
SELECT
  gen_random_uuid(),
  o.id,
  g.role,
  g.action,
  g.subject,
  g.conditions::jsonb,
  NOW(),
  NOW()
FROM organizations o
CROSS JOIN (VALUES
  ('DISPATCHER','read','Automation',NULL),
  ('DISPATCHER','create','Automation',NULL),
  ('DISPATCHER','update','Automation',NULL),
  ('DISPATCHER','delete','Automation',NULL)
) AS g(role, action, subject, conditions)
ON CONFLICT (organization_id, role, action, subject) DO NOTHING;
