-- R5a (2026-07-21) -- scope-preset category (free-text grouping tag, not a relational model).
-- Idempotent (IF NOT EXISTS) so it's safe to run twice on the shared staging DB. Portable --
-- plain ALTER TABLE, no Supabase-only objects, no RLS/policy statements.
ALTER TABLE "scope_presets" ADD COLUMN IF NOT EXISTS "category" VARCHAR(100);
