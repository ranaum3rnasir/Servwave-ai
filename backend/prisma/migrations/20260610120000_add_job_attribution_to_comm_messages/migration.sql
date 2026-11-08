-- Communication ↔ Jobs: per-MESSAGE job attribution.
--
-- Adds nullable job_id (FK → jobs, ON DELETE SET NULL) + denormalized job_label
-- to messages / emails / whatsapp_messages. CallSession already has both.
-- Threads/chats stay customer-scoped on purpose (one customer SMS thread spans
-- multiple jobs — attribution lives on the message, not the thread).
--
-- Idempotent on purpose: the ServWave test-env redeploys against the SHARED
-- staging Supabase DB (see MEMORY Shared-Staging-DB-Migration-Drift), so every
-- statement must converge from either starting state without P3009 drift.

-- AlterTable (idempotent): emails.ts was INT4 but stores epoch-ms (Date.now()),
-- which overflows 32-bit — every insert through the compose path or the new
-- transactional persistence would fail at runtime. Widen to BIGINT.
-- (Re-running ALTER TYPE BIGINT on an already-BIGINT column is a harmless no-op cast.)
ALTER TABLE "emails" ALTER COLUMN "ts" TYPE BIGINT;

-- AlterTable (idempotent)
ALTER TABLE "messages"
  ADD COLUMN IF NOT EXISTS "job_id" UUID,
  ADD COLUMN IF NOT EXISTS "job_label" TEXT;

ALTER TABLE "emails"
  ADD COLUMN IF NOT EXISTS "job_id" UUID,
  ADD COLUMN IF NOT EXISTS "job_label" TEXT;

ALTER TABLE "whatsapp_messages"
  ADD COLUMN IF NOT EXISTS "job_id" UUID,
  ADD COLUMN IF NOT EXISTS "job_label" TEXT;

-- CreateIndex (idempotent)
CREATE INDEX IF NOT EXISTS "messages_job_id_idx" ON "messages"("job_id");
CREATE INDEX IF NOT EXISTS "emails_job_id_idx" ON "emails"("job_id");
CREATE INDEX IF NOT EXISTS "whatsapp_messages_job_id_idx" ON "whatsapp_messages"("job_id");

-- AddForeignKey (idempotent — duplicate_object guard; shared staging DB may already have them)
DO $$ BEGIN
  ALTER TABLE "messages" ADD CONSTRAINT "messages_job_id_fkey"
    FOREIGN KEY ("job_id") REFERENCES "jobs"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
  ALTER TABLE "emails" ADD CONSTRAINT "emails_job_id_fkey"
    FOREIGN KEY ("job_id") REFERENCES "jobs"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
  ALTER TABLE "whatsapp_messages" ADD CONSTRAINT "whatsapp_messages_job_id_fkey"
    FOREIGN KEY ("job_id") REFERENCES "jobs"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;
