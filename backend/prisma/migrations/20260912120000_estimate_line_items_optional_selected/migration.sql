-- #2053 slice 1 — optional items on estimates. Sorts after the R5d drop
-- (20260722030000_estimate_line_items_drop_is_optional, `DROP COLUMN IF EXISTS "is_optional"`),
-- so the column name is free. Two ADD COLUMN IF NOT EXISTS, idempotent, portable (no
-- Supabase-only object, so no pg_roles guard needed), no secrets, no data repair — NOT NULL
-- DEFAULT backfills every existing row to is_optional=false, is_selected=true ("nothing was
-- optional, everything counts"), which is the AC8 byte-identical regression floor by
-- construction.
ALTER TABLE "estimate_line_items" ADD COLUMN IF NOT EXISTS "is_optional" boolean NOT NULL DEFAULT false;
ALTER TABLE "estimate_line_items" ADD COLUMN IF NOT EXISTS "is_selected" boolean NOT NULL DEFAULT true;
