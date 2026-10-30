-- Spider's starting summary (#2794).
--
-- When Spider starts watching something new (switched on, a stage switched on, a limit shortened, more
-- leads under watch), the leads already past their limit are reported once per recipient in a starting
-- summary instead of one alert per lead.
--
--   spider_settings.summary_trigger_at / summary_trigger_kind: the latest starting trigger the sweep has
--     not acted on yet (NULL when nothing is waiting); summary_trigger_since: when it first started
--     waiting, which bounds the wait (and the retries after a failure) to 10 minutes.
--   spider_summaries: one row per company, the latest summary only (the unique company key keeps it so).
--   spider_alerts.kind (ALERTED | SUMMARIZED) and summary_id: a summarized lead's row is still the claim
--     for that stage visit, so it never alerts separately; summary_id is cleared when a newer summary
--     replaces the one it was in.
--
-- Additive: new nullable columns, a text column with a default (plain text with a CHECK, not a Postgres
-- enum), a new table. A backend from before this keeps working: it never reads these columns, and every
-- row it writes takes kind = ALERTED.
--
-- One data step: the sweep no longer counts time in a stage from when Spider was switched on (the clamp
-- held back every lead that entered its stage before then). A company with Spider on at deploy time gets
-- a pending trigger, so that backlog arrives as one starting summary rather than as one alert per lead.
-- Spider is limited to demo companies, so this reaches no real customer.
--
-- Idempotent and portable per .claude/skills/writing-migrations: IF NOT EXISTS everywhere, constraints
-- in duplicate_object guards, DROP POLICY before CREATE POLICY, Supabase roles behind pg_roles guards,
-- and the data step only touches rows with no trigger yet.

ALTER TABLE "spider_settings" ADD COLUMN IF NOT EXISTS "summary_trigger_at" TIMESTAMP(3);
ALTER TABLE "spider_settings" ADD COLUMN IF NOT EXISTS "summary_trigger_kind" TEXT;
ALTER TABLE "spider_settings" ADD COLUMN IF NOT EXISTS "summary_trigger_since" TIMESTAMP(3);

CREATE TABLE IF NOT EXISTS "spider_summaries" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "triggered_at" TIMESTAMP(3) NOT NULL,
    "trigger_kind" TEXT NOT NULL,
    "lead_count" INTEGER NOT NULL DEFAULT 0,
    "recipient_count" INTEGER NOT NULL DEFAULT 0,
    "delivery" JSONB NOT NULL DEFAULT '{}',

    CONSTRAINT "spider_summaries_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "spider_summaries_organization_id_key" ON "spider_summaries"("organization_id");

DO $$ BEGIN
  ALTER TABLE "spider_summaries" ADD CONSTRAINT "spider_summaries_organization_id_fkey"
    FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN null; END $$;

ALTER TABLE "spider_alerts" ADD COLUMN IF NOT EXISTS "kind" TEXT NOT NULL DEFAULT 'ALERTED';
ALTER TABLE "spider_alerts" ADD COLUMN IF NOT EXISTS "summary_id" UUID;

DO $$ BEGIN
  ALTER TABLE "spider_alerts" ADD CONSTRAINT "spider_alerts_kind_check" CHECK ("kind" IN ('ALERTED', 'SUMMARIZED'));
EXCEPTION WHEN duplicate_object THEN null; END $$;

DO $$ BEGIN
  ALTER TABLE "spider_alerts" ADD CONSTRAINT "spider_alerts_summary_id_fkey"
    FOREIGN KEY ("summary_id") REFERENCES "spider_summaries"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN null; END $$;

CREATE INDEX IF NOT EXISTS "spider_alerts_summary_id_idx" ON "spider_alerts"("summary_id");

-- Row-level security: the standard company policy, forced, no Supabase client-role grants (as the
-- other two Spider tables).
ALTER TABLE "spider_summaries" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "spider_summaries" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "tenant_isolation" ON "spider_summaries";
CREATE POLICY "tenant_isolation" ON "spider_summaries"
  USING (current_setting('app.bypass_rls', true) = 'on' OR "organization_id" = NULLIF(current_setting('app.current_org_id', true), '')::uuid)
  WITH CHECK (current_setting('app.bypass_rls', true) = 'on' OR "organization_id" = NULLIF(current_setting('app.current_org_id', true), '')::uuid);

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    EXECUTE 'REVOKE ALL PRIVILEGES ON public.spider_summaries FROM anon';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    EXECUTE 'REVOKE ALL PRIVILEGES ON public.spider_summaries FROM authenticated';
  END IF;
END $$;

-- The backlog the removed clamp held back arrives as one summary (see above).
UPDATE "spider_settings"
SET "summary_trigger_at" = CURRENT_TIMESTAMP, "summary_trigger_kind" = 'SCOPE_WIDENED', "summary_trigger_since" = CURRENT_TIMESTAMP
WHERE "is_active" = true AND "summary_trigger_at" IS NULL;
