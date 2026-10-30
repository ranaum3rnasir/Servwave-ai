-- Roles & Permissions alignment, AL-03 (P15, M1): Admin becomes a flag on the person, never a role name.
--
-- Until now a person was an Admin when users.role was ADMIN and they had no custom role. From this release every
-- "is this an admin" check reads users.is_admin. The backfill sets it for exactly the people who were Admins, so
-- nobody gains or loses access: role = ADMIN and custom_role_id IS NULL.
--
-- IDEMPOTENT: ADD COLUMN IF NOT EXISTS, and the backfill only ever sets true for the same people. Portable plain
-- PostgreSQL. NEVER run `prisma migrate` from a worktree.

ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "is_admin" BOOLEAN NOT NULL DEFAULT false;

DO $al_03$
BEGIN
  -- The users table carries FORCE ROW LEVEL SECURITY; a role that does not bypass it would update nothing.
  PERFORM set_config('app.bypass_rls', 'on', true);

  UPDATE "users" SET "is_admin" = true
   WHERE "role" = 'ADMIN' AND "custom_role_id" IS NULL AND "is_admin" = false;
END
$al_03$;
