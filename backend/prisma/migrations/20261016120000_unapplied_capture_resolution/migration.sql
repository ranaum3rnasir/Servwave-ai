-- V7-05b (BE-4): who closed an unapplied payment, when, and why. Four nullable columns, no foreign key
-- (resolved_by is a plain uuid). Old rows stay null; the Resolved view
-- falls back to updated_at and "Marked resolved" for them. Additive, safe while the old code runs.
ALTER TABLE "unapplied_captures" ADD COLUMN IF NOT EXISTS "resolved_at" TIMESTAMP(3);
ALTER TABLE "unapplied_captures" ADD COLUMN IF NOT EXISTS "resolved_by" UUID;
ALTER TABLE "unapplied_captures" ADD COLUMN IF NOT EXISTS "resolved_by_name" TEXT;
ALTER TABLE "unapplied_captures" ADD COLUMN IF NOT EXISTS "resolution_note" TEXT;
