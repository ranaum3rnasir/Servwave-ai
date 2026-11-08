-- Staff profile photos, phase 2 of
-- md_files/plans/frontend/2026-08-04-user-avatars-initials-and-upload.md
--
-- Stores the Supabase Storage OBJECT PATH for a staff member's uploaded profile photo, never a
-- URL: the `attachments` bucket is private, so every response mints a short-lived signed URL from
-- this path (decision 1 - profile photos render only inside authenticated ServWave, never in
-- email/PDF/public token pages, so a stored public URL would be wrong here even if the bucket
-- were public).
--
-- Lifetime tracks the user row (decision 8): NULL while unset, cleared on remove/replace, kept
-- through deactivation, removed only alongside the row on permanent delete.
--
-- IDEMPOTENT: ADD COLUMN is guarded with IF NOT EXISTS, so a second application against the
--   shared staging DB is a no-op.
-- PORTABLE: vanilla postgres:16 (CI migration-check) - no Supabase-only objects here.

ALTER TABLE "users"
  ADD COLUMN IF NOT EXISTS "avatar_path" TEXT;
