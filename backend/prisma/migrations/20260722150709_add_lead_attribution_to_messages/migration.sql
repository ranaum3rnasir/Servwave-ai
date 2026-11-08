-- Communication ↔ Leads: per-MESSAGE lead attribution.
--
-- Mirrors 20260610120000_add_job_attribution_to_comm_messages (job_id), per
-- Ran's 2026-07-22 ruling: lead-scoped communication must behave exactly like
-- job-scoped communication. Adds nullable lead_id (FK -> leads, ON DELETE
-- SET NULL) to messages. MessageThread already carries lead_id (thread-level,
-- unused for lead scoping going forward); this is the message-level column
-- getLeadCommunications will filter on, same as job_id today.
--
-- Idempotent on purpose: the ServWave test-env redeploys against the SHARED
-- staging Supabase DB, so every statement must converge from either starting
-- state without P3009 drift.

-- AlterTable (idempotent)
ALTER TABLE "messages"
  ADD COLUMN IF NOT EXISTS "lead_id" UUID;

-- CreateIndex (idempotent)
CREATE INDEX IF NOT EXISTS "messages_lead_id_idx" ON "messages"("lead_id");

-- AddForeignKey (idempotent — duplicate_object guard; shared staging DB may already have it)
DO $$ BEGIN
  ALTER TABLE "messages" ADD CONSTRAINT "messages_lead_id_fkey"
    FOREIGN KEY ("lead_id") REFERENCES "leads"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;
