-- Roles & Permissions Overhaul, PRD 1, slice S01.20: a role remembers the role it was made from.
--
-- Save as role (a person's switches turned into a new role) records the role the person was based on, so the
-- Roles screen can name it in the new role's header. A nullable column; a role made before this has no source.
--
-- PURE EXPAND. One new nullable column, no backfill, nothing existing is dropped or narrowed.
-- IDEMPOTENT + portable (plain DDL, no Supabase-only objects). NEVER run `prisma migrate` from a worktree.

ALTER TABLE "custom_roles" ADD COLUMN IF NOT EXISTS "made_from_role_key" TEXT;
