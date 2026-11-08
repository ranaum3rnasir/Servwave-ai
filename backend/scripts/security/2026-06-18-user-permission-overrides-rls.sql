-- =====================================================================================
-- ServWave Security — deny-all FORCE RLS on `user_permission_overrides`   (issue #239)
--
-- ⚠️  APPLY = RAN, OUT-OF-BAND.  Like 2026-06-15-keystone-rls-revoke.sql, this is deliberately
--     NOT a Prisma migration: it uses FORCE ROW LEVEL SECURITY and references the Supabase-only
--     roles anon/authenticated, which would error on the vanilla-Postgres CI migration-check (those
--     roles don't exist there). Run it via the Supabase SQL editor on EACH project (STAGING first,
--     then PROD), or with psql against the project's DATABASE_URL. IDEMPOTENT — safe to re-run.
--
-- WHY: `user_permission_overrides` (#227) stores per-user ALLOW/DENY capability grants — a direct
-- privilege-escalation target if it is writable through the Supabase Data API (PostgREST). The
-- 2026-06-15 keystone sweep enabled + FORCED RLS on every public table THEN PRESENT and revoked the
-- anon/authenticated grants, but this table was created AFTERWARDS (migration 20260617000000), so on
-- any project where the keystone ran earlier it is NOT yet covered. This re-asserts deny-all on it
-- specifically. (Equivalent alternative: re-run the keystone sweep — it is data-driven over
-- pg_tables and so would also pick this table up. This file is the targeted, auditable version.)
--
-- ROLE MODEL: identical to the keystone. Prisma connects as `postgres` — NOT a superuser but a
-- MEMBER of anon, so a plain ENABLE ROW LEVEL SECURITY is bypassed by the table owner. FORCE is
-- MANDATORY. The app is unaffected: it reaches Postgres directly as postgres/service-role (never the
-- anon PostgREST API). NO permissive policy is created → deny-all for every non-owner role. Tenancy
-- stays enforced in Express/Prisma via tenantWhere + the per-user override loader.
-- =====================================================================================

-- 1) Enable + FORCE row-level security (deny-all; no policy). FORCE so the owner `postgres` cannot
--    bypass it. Both statements are idempotent (no-op if already set).
ALTER TABLE public.user_permission_overrides ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.user_permission_overrides FORCE  ROW LEVEL SECURITY;

-- 2) Strip every grant on the table from the API roles. Guarded on role existence so this file is
--    ALSO safe to run against a non-Supabase database (a no-op there). The table's PK is a uuid
--    default (no sequence), so there is no sequence grant to revoke.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon')
     AND EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    REVOKE ALL ON TABLE public.user_permission_overrides FROM anon, authenticated;
  END IF;
END $$;

-- 3) VERIFY after applying:
--    SELECT relrowsecurity, relforcerowsecurity
--    FROM pg_class WHERE oid = 'public.user_permission_overrides'::regclass;   -- expect t, t
--
--    SELECT grantee FROM information_schema.role_table_grants
--    WHERE table_schema = 'public' AND table_name = 'user_permission_overrides'
--      AND grantee IN ('anon','authenticated');                               -- expect 0 rows.
