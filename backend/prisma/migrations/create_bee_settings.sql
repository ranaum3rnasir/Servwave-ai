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

CREATE UNIQUE INDEX IF NOT EXISTS "bee_settings_organization_id_key" ON "bee_settings"("organization_id");
CREATE INDEX IF NOT EXISTS "bee_settings_organization_id_idx" ON "bee_settings"("organization_id");

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'bee_settings_organization_id_fkey') THEN
        ALTER TABLE "bee_settings" ADD CONSTRAINT "bee_settings_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
    END IF;
END $$;

