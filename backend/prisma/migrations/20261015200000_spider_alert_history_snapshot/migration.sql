-- Spider History (slice S3): what the contractor's alert log stored at alert time, on our alert table.
--
-- Each alert now keeps a copy of what it was raised about and what it sent, so the History tab shows
-- the lead, customer and address as they were when the alert went out, and the preview drawer shows
-- the messages that were actually sent:
--   lead_number, customer_id, customer_name, company_name, service_request, service_location,
--   stage_name, elapsed_value + elapsed_unit (time in the stage, in the limit's unit),
--   channels (per channel: enabled, SENT / FAILED / SKIPPED, sent / skipped / failed counts, the
--   failure wording, and the email sender), recipients ([{id, name, email, role, type}] - never a
--   phone number), email_subject, email_body, sms_message, in_app_message.
--
-- Additive only: every column is nullable with no default, so rows written before this migration
-- keep NULL and the History tab shows what they do hold. Nothing is backfilled.
--
-- Idempotent and portable per .claude/skills/writing-migrations: ADD COLUMN IF NOT EXISTS,
-- CREATE INDEX IF NOT EXISTS, no Supabase roles. The table's RLS policy and grants are unchanged.

ALTER TABLE "spider_alerts" ADD COLUMN IF NOT EXISTS "lead_number" TEXT;
ALTER TABLE "spider_alerts" ADD COLUMN IF NOT EXISTS "customer_id" UUID;
ALTER TABLE "spider_alerts" ADD COLUMN IF NOT EXISTS "customer_name" TEXT;
ALTER TABLE "spider_alerts" ADD COLUMN IF NOT EXISTS "company_name" TEXT;
ALTER TABLE "spider_alerts" ADD COLUMN IF NOT EXISTS "service_request" TEXT;
ALTER TABLE "spider_alerts" ADD COLUMN IF NOT EXISTS "service_location" TEXT;
ALTER TABLE "spider_alerts" ADD COLUMN IF NOT EXISTS "stage_name" TEXT;
ALTER TABLE "spider_alerts" ADD COLUMN IF NOT EXISTS "elapsed_value" INTEGER;
ALTER TABLE "spider_alerts" ADD COLUMN IF NOT EXISTS "elapsed_unit" TEXT;
ALTER TABLE "spider_alerts" ADD COLUMN IF NOT EXISTS "channels" JSONB;
ALTER TABLE "spider_alerts" ADD COLUMN IF NOT EXISTS "recipients" JSONB;
ALTER TABLE "spider_alerts" ADD COLUMN IF NOT EXISTS "email_subject" TEXT;
ALTER TABLE "spider_alerts" ADD COLUMN IF NOT EXISTS "email_body" TEXT;
ALTER TABLE "spider_alerts" ADD COLUMN IF NOT EXISTS "sms_message" TEXT;
ALTER TABLE "spider_alerts" ADD COLUMN IF NOT EXISTS "in_app_message" TEXT;

-- The Customers filter.
CREATE INDEX IF NOT EXISTS "spider_alerts_organization_id_customer_id_idx" ON "spider_alerts"("organization_id", "customer_id");
