-- Spider lead watcher (#2619): per-company settings and the alert log.
--
-- spider_settings: one row per company - on/off, activated_at, per-status limits, channels,
-- recipients, and "watch all open leads" (default on) with the selected lead ids.
--
-- spider_alerts: one row per lead per status visit Spider alerted on. The unique key
-- (organization_id, lead_id, status, entered_status_at) is the duplicate-prevention claim: the
-- sweep inserts this row first and only a successful insert sends. The limit is not part of the
-- key, so editing a limit never re-alerts. Recipients are stored as user ids only.
--
-- Idempotent and portable per .claude/skills/writing-migrations: IF NOT EXISTS everywhere, FKs in
-- duplicate_object guards, DROP POLICY before CREATE POLICY, Supabase roles behind pg_roles guards.

CREATE TABLE IF NOT EXISTS "spider_settings" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT false,
    "activated_at" TIMESTAMP(3),
    "status_limits" JSONB NOT NULL DEFAULT '{}',
    "channels" JSONB NOT NULL DEFAULT '{}',
    "recipients" JSONB NOT NULL DEFAULT '{}',
    "watch_all_leads" BOOLEAN NOT NULL DEFAULT true,
    "selected_lead_ids" UUID[] DEFAULT ARRAY[]::UUID[],
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "spider_settings_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "spider_alerts" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "lead_id" UUID NOT NULL,
    "status" "LeadStatus" NOT NULL,
    "entered_status_at" TIMESTAMP(3) NOT NULL,
    "counted_from" TIMESTAMP(3) NOT NULL,
    "limit_value" INTEGER NOT NULL,
    "limit_unit" TEXT NOT NULL,
    "alerted_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "recipient_ids" UUID[] DEFAULT ARRAY[]::UUID[],
    "delivery" JSONB NOT NULL DEFAULT '{}',
    "texts_sent" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "spider_alerts_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "spider_settings_organization_id_key" ON "spider_settings"("organization_id");
CREATE INDEX IF NOT EXISTS "spider_alerts_organization_id_alerted_at_idx" ON "spider_alerts"("organization_id", "alerted_at");
CREATE INDEX IF NOT EXISTS "spider_alerts_lead_id_idx" ON "spider_alerts"("lead_id");
CREATE UNIQUE INDEX IF NOT EXISTS "spider_alerts_organization_id_lead_id_status_entered_status_key" ON "spider_alerts"("organization_id", "lead_id", "status", "entered_status_at");

DO $$ BEGIN
  ALTER TABLE "spider_settings" ADD CONSTRAINT "spider_settings_organization_id_fkey"
    FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN null; END $$;

DO $$ BEGIN
  ALTER TABLE "spider_alerts" ADD CONSTRAINT "spider_alerts_organization_id_fkey"
    FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN null; END $$;

DO $$ BEGIN
  ALTER TABLE "spider_alerts" ADD CONSTRAINT "spider_alerts_lead_id_fkey"
    FOREIGN KEY ("lead_id") REFERENCES "leads"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN null; END $$;

-- Row-level security: the standard company policy, forced, no Supabase client-role grants.
ALTER TABLE "spider_settings" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "spider_settings" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "tenant_isolation" ON "spider_settings";
CREATE POLICY "tenant_isolation" ON "spider_settings"
  USING (current_setting('app.bypass_rls', true) = 'on' OR "organization_id" = NULLIF(current_setting('app.current_org_id', true), '')::uuid)
  WITH CHECK (current_setting('app.bypass_rls', true) = 'on' OR "organization_id" = NULLIF(current_setting('app.current_org_id', true), '')::uuid);

ALTER TABLE "spider_alerts" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "spider_alerts" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "tenant_isolation" ON "spider_alerts";
CREATE POLICY "tenant_isolation" ON "spider_alerts"
  USING (current_setting('app.bypass_rls', true) = 'on' OR "organization_id" = NULLIF(current_setting('app.current_org_id', true), '')::uuid)
  WITH CHECK (current_setting('app.bypass_rls', true) = 'on' OR "organization_id" = NULLIF(current_setting('app.current_org_id', true), '')::uuid);

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    EXECUTE 'REVOKE ALL PRIVILEGES ON public.spider_settings FROM anon';
    EXECUTE 'REVOKE ALL PRIVILEGES ON public.spider_alerts FROM anon';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    EXECUTE 'REVOKE ALL PRIVILEGES ON public.spider_settings FROM authenticated';
    EXECUTE 'REVOKE ALL PRIVILEGES ON public.spider_alerts FROM authenticated';
  END IF;
END $$;
