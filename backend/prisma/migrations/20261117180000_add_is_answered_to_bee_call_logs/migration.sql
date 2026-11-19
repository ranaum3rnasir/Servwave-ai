-- AlterTable
ALTER TABLE "bee_call_logs" ADD COLUMN IF NOT EXISTS "is_answered" BOOLEAN NOT NULL DEFAULT false;

-- Backfill is_answered for existing records based on outcome
UPDATE "bee_call_logs"
SET "is_answered" = true
WHERE "outcome" NOT ILIKE '%no_answer%'
  AND "outcome" NOT ILIKE '%voicemail%'
  AND "outcome" NOT ILIKE '%failed%'
  AND "outcome" NOT ILIKE '%wrong_number%'
  AND "outcome" NOT ILIKE '%needs_review%'
  AND "outcome" NOT ILIKE '%call_initiated%'
  AND "outcome" NOT ILIKE '%in_progress%';

-- CreateIndex
CREATE INDEX IF NOT EXISTS "bee_call_logs_organization_id_is_answered_idx" ON "bee_call_logs"("organization_id", "is_answered");
