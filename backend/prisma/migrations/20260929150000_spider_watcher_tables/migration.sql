-- Spider Watcher settings and alert logs with row-level security
-- Migration: 20260929150000_spider_watcher_tables

-- ─── 1. Spider Alert Logs ───────────────────────────────────────────────────

CREATE TABLE "spider_alert_logs" (
  "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "organization_id" UUID NOT NULL REFERENCES "organizations"("id") ON DELETE CASCADE,
  "lead_id" UUID REFERENCES "leads"("id") ON DELETE SET NULL,
  "lead_number" TEXT NOT NULL,
  "customer_id" UUID REFERENCES "customers"("id") ON DELETE SET NULL,
  "customer_name" TEXT NOT NULL,
  "company_name" TEXT,
  "service_request" TEXT,
  "service_location" TEXT,
  "stage_name" TEXT NOT NULL,
  "inactive_days" INT NOT NULL DEFAULT 0,
  "inactive_unit" TEXT NOT NULL DEFAULT 'Day',
  "channels" JSONB NOT NULL DEFAULT '{}'::jsonb,
  "recipients" JSONB NOT NULL DEFAULT '[]'::jsonb,
  "email_subject" TEXT,
  "email_body" TEXT,
  "sms_message" TEXT,
  "in_app_message" TEXT,
  "dedupe_key" TEXT,
  "status" TEXT NOT NULL DEFAULT 'SENT',
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX "spider_alert_logs_dedupe_key_key"
  ON "spider_alert_logs"("dedupe_key");

CREATE INDEX "spider_alert_logs_organization_id_created_at_idx"
  ON "spider_alert_logs"("organization_id", "created_at" DESC);

CREATE INDEX "spider_alert_logs_lead_id_idx"
  ON "spider_alert_logs"("lead_id");

ALTER TABLE "spider_alert_logs" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "spider_alert_logs" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "spider_alert_logs"
  USING (current_setting('app.bypass_rls', true) = 'on' OR "organization_id" = NULLIF(current_setting('app.current_org_id', true), '')::uuid)
  WITH CHECK (current_setting('app.bypass_rls', true) = 'on' OR "organization_id" = NULLIF(current_setting('app.current_org_id', true), '')::uuid);

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    EXECUTE 'REVOKE ALL PRIVILEGES ON public.spider_alert_logs FROM anon';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    EXECUTE 'REVOKE ALL PRIVILEGES ON public.spider_alert_logs FROM authenticated';
  END IF;
END $$;

-- ─── 2. Spider Watcher Configs ──────────────────────────────────────────────

CREATE TABLE "spider_watcher_configs" (
  "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "organization_id" UUID NOT NULL UNIQUE REFERENCES "organizations"("id") ON DELETE CASCADE,
  "is_active" BOOLEAN NOT NULL DEFAULT false,
  "auto_enroll_all_leads" BOOLEAN NOT NULL DEFAULT true,
  "selected_lead_ids" JSONB NOT NULL DEFAULT '[]'::jsonb,
  "stage_thresholds" JSONB NOT NULL DEFAULT '{}'::jsonb,
  "notifications" JSONB NOT NULL DEFAULT '{}'::jsonb,
  "assignments" JSONB NOT NULL DEFAULT '{}'::jsonb,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT NOW(),
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT NOW()
);

CREATE INDEX "spider_watcher_configs_organization_id_idx"
  ON "spider_watcher_configs"("organization_id");

ALTER TABLE "spider_watcher_configs" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "spider_watcher_configs" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "spider_watcher_configs"
  USING (current_setting('app.bypass_rls', true) = 'on' OR "organization_id" = NULLIF(current_setting('app.current_org_id', true), '')::uuid)
  WITH CHECK (current_setting('app.bypass_rls', true) = 'on' OR "organization_id" = NULLIF(current_setting('app.current_org_id', true), '')::uuid);

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    EXECUTE 'REVOKE ALL PRIVILEGES ON public.spider_watcher_configs FROM anon';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    EXECUTE 'REVOKE ALL PRIVILEGES ON public.spider_watcher_configs FROM authenticated';
  END IF;
END $$;
