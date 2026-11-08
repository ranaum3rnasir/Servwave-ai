-- Dedicated Migration for Bee Agent (AI Warranty Upseller)
CREATE TABLE IF NOT EXISTS "bee_settings" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organization_id" UUID NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "call_window_start" TEXT NOT NULL DEFAULT '10:00',
    "call_window_end" TEXT NOT NULL DEFAULT '19:00',
    "timezone" TEXT NOT NULL DEFAULT 'America/New_York',
    "max_retries" INTEGER NOT NULL DEFAULT 2,
    "retry_interval_hours" INTEGER NOT NULL DEFAULT 48,
    "default_lead_owner_id" UUID,
    "alert_email" TEXT,
    "alert_phone" TEXT,
    "voice_provider" TEXT NOT NULL DEFAULT 'simulated',
    "voice_provider_api_key" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "bee_settings_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "bee_warranty_plans" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organization_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "duration_months" INTEGER NOT NULL,
    "price" DECIMAL(10,2) NOT NULL,
    "billing_interval" TEXT NOT NULL DEFAULT 'one_time',
    "description" TEXT,
    "inclusions" JSONB NOT NULL DEFAULT '[]',
    "eligible_job_types" JSONB NOT NULL DEFAULT '[]',
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "bee_warranty_plans_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "bee_voice_agents" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organization_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "persona_name" TEXT NOT NULL DEFAULT 'Emma',
    "voice_id" TEXT NOT NULL DEFAULT 'friendly_female_1',
    "trade_focus" TEXT NOT NULL DEFAULT 'General',
    "trigger_days_before" INTEGER NOT NULL DEFAULT 30,
    "eligible_job_types" JSONB NOT NULL DEFAULT '[]',
    "warranty_offer_pitch" TEXT,
    "new_work_pitch" TEXT,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "bee_voice_agents_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "bee_warranty_records" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organization_id" UUID NOT NULL,
    "job_id" UUID NOT NULL,
    "customer_id" UUID NOT NULL,
    "job_type" TEXT,
    "job_completed_at" TIMESTAMP(3) NOT NULL,
    "warranty_start_date" TIMESTAMP(3) NOT NULL,
    "warranty_end_date" TIMESTAMP(3) NOT NULL,
    "warranty_started_on" TEXT,
    "status" TEXT NOT NULL DEFAULT 'active',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "bee_warranty_records_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "bee_queue_items" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organization_id" UUID NOT NULL,
    "warranty_record_id" UUID NOT NULL,
    "customer_id" UUID NOT NULL,
    "customer_name" TEXT NOT NULL,
    "customer_phone" TEXT NOT NULL,
    "agent_id" UUID,
    "status" TEXT NOT NULL DEFAULT 'scheduled',
    "attempt_count" INTEGER NOT NULL DEFAULT 0,
    "scheduled_for" TIMESTAMP(3) NOT NULL,
    "warranty_started_on" TEXT,
    "original_scheduled_for" TIMESTAMP(3),
    "is_rescheduled" BOOLEAN NOT NULL DEFAULT false,
    "rescheduled_at" TIMESTAMP(3),
    "customer_timezone" TEXT,
    "timezone_source" TEXT,
    "is_timezone_estimated" BOOLEAN NOT NULL DEFAULT false,
    "last_attempted_at" TIMESTAMP(3),
    "skip_reason" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "bee_queue_items_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "bee_call_logs" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organization_id" UUID NOT NULL,
    "queue_item_id" UUID,
    "agent_id" UUID,
    "customer_id" UUID NOT NULL,
    "customer_name" TEXT NOT NULL,
    "customer_phone" TEXT NOT NULL,
    "duration_seconds" INTEGER NOT NULL DEFAULT 0,
    "outcome" TEXT NOT NULL,
    "transcript" JSONB,
    "ai_summary" TEXT,
    "audio_url" TEXT,
    "lead_id" UUID,
    "needs_human_alert" BOOLEAN NOT NULL DEFAULT false,
    "cost_estimate" DECIMAL(6,4),
    "called_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "bee_call_logs_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "bee_dnc_entries" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organization_id" UUID NOT NULL,
    "phone_number" TEXT NOT NULL,
    "reason" TEXT,
    "source" TEXT NOT NULL DEFAULT 'voice_opt_out',
    "call_log_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "bee_dnc_entries_pkey" PRIMARY KEY ("id")
);

-- Indexes and Constraints
CREATE UNIQUE INDEX IF NOT EXISTS "bee_settings_organization_id_key" ON "bee_settings"("organization_id");
CREATE INDEX IF NOT EXISTS "bee_settings_organization_id_idx" ON "bee_settings"("organization_id");
CREATE INDEX IF NOT EXISTS "bee_warranty_plans_organization_id_idx" ON "bee_warranty_plans"("organization_id");
CREATE INDEX IF NOT EXISTS "bee_voice_agents_organization_id_idx" ON "bee_voice_agents"("organization_id");
CREATE INDEX IF NOT EXISTS "bee_warranty_records_organization_id_status_idx" ON "bee_warranty_records"("organization_id", "status");
CREATE INDEX IF NOT EXISTS "bee_warranty_records_organization_id_warranty_end_date_idx" ON "bee_warranty_records"("organization_id", "warranty_end_date");
CREATE INDEX IF NOT EXISTS "bee_queue_items_organization_id_status_scheduled_for_idx" ON "bee_queue_items"("organization_id", "status", "scheduled_for");
CREATE INDEX IF NOT EXISTS "bee_call_logs_organization_id_called_at_idx" ON "bee_call_logs"("organization_id", "called_at");
CREATE INDEX IF NOT EXISTS "bee_call_logs_organization_id_outcome_idx" ON "bee_call_logs"("organization_id", "outcome");
CREATE INDEX IF NOT EXISTS "bee_dnc_entries_organization_id_idx" ON "bee_dnc_entries"("organization_id");
CREATE UNIQUE INDEX IF NOT EXISTS "bee_dnc_entries_organization_id_phone_number_key" ON "bee_dnc_entries"("organization_id", "phone_number");

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'bee_settings_organization_id_fkey') THEN
        ALTER TABLE "bee_settings" ADD CONSTRAINT "bee_settings_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'bee_warranty_plans_organization_id_fkey') THEN
        ALTER TABLE "bee_warranty_plans" ADD CONSTRAINT "bee_warranty_plans_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'bee_voice_agents_organization_id_fkey') THEN
        ALTER TABLE "bee_voice_agents" ADD CONSTRAINT "bee_voice_agents_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'bee_warranty_records_organization_id_fkey') THEN
        ALTER TABLE "bee_warranty_records" ADD CONSTRAINT "bee_warranty_records_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'bee_queue_items_organization_id_fkey') THEN
        ALTER TABLE "bee_queue_items" ADD CONSTRAINT "bee_queue_items_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'bee_queue_items_warranty_record_id_fkey') THEN
        ALTER TABLE "bee_queue_items" ADD CONSTRAINT "bee_queue_items_warranty_record_id_fkey" FOREIGN KEY ("warranty_record_id") REFERENCES "bee_warranty_records"("id") ON DELETE CASCADE ON UPDATE CASCADE;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'bee_call_logs_organization_id_fkey') THEN
        ALTER TABLE "bee_call_logs" ADD CONSTRAINT "bee_call_logs_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'bee_call_logs_queue_item_id_fkey') THEN
        ALTER TABLE "bee_call_logs" ADD CONSTRAINT "bee_call_logs_queue_item_id_fkey" FOREIGN KEY ("queue_item_id") REFERENCES "bee_queue_items"("id") ON DELETE SET NULL ON UPDATE CASCADE;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'bee_dnc_entries_organization_id_fkey') THEN
        ALTER TABLE "bee_dnc_entries" ADD CONSTRAINT "bee_dnc_entries_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
    END IF;
END $$;

-- Idempotent column additions for existing deployments
ALTER TABLE "bee_warranty_records" ADD COLUMN IF NOT EXISTS "warranty_started_on" TEXT;
ALTER TABLE "bee_queue_items" ADD COLUMN IF NOT EXISTS "warranty_started_on" TEXT;
ALTER TABLE "bee_queue_items" ADD COLUMN IF NOT EXISTS "original_scheduled_for" TIMESTAMP(3);
ALTER TABLE "bee_queue_items" ADD COLUMN IF NOT EXISTS "is_rescheduled" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "bee_queue_items" ADD COLUMN IF NOT EXISTS "rescheduled_at" TIMESTAMP(3);


