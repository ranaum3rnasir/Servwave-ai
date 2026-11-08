-- Structured CTM transcript turns (SERV10X-65), additive/nullable, no backfill.
ALTER TABLE "call_sessions" ADD COLUMN IF NOT EXISTS "transcript_turns" JSONB;
