-- Inventory P5 — staging attachments to Supabase Storage (spec §5.1).
-- Additive + idempotent + portable (no Supabase-only objects): runs on vanilla
-- postgres:16 in CI, on Supabase via Render deploy, and may run twice on the
-- shared staging DB. No data backfill — legacy data-URI rows keep rendering
-- through the dual-generation read path; storage_path is canonical when set.
ALTER TABLE "job_stage_attachments" ADD COLUMN IF NOT EXISTS "storage_path" TEXT;
