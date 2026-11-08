-- =====================================================================================
-- ServWave Security Keystone — deny-all RLS + revoke anon/authenticated grants +
-- revoke default privileges.   (Security audit 2026-06-15 · item B-01 · cluster RC-1)
--
-- ⚠️  APPLY = RAN, OUT-OF-BAND.  This is deliberately NOT a Prisma migration: it
--     references the Supabase-only roles anon/authenticated and uses FORCE ROW LEVEL
--     SECURITY, which would (a) error on the vanilla-Postgres CI migration-check (those
--     roles don't exist there) and (b) block that job's seed step. Run it via the
--     Supabase SQL editor on EACH project (STAGING first, then PROD), or with psql against
--     the project's DATABASE_URL. It is IDEMPOTENT — safe to run more than once.
--
-- WHY: the Supabase Data API (PostgREST) is reachable and the anon/authenticated roles hold
-- full DML on every public table while RLS is OFF, so the bundled anon key reads/writes ALL
-- PII + financials and self-escalates to admin, bypassing Express/Prisma/CASL. This removes
-- the DB-layer exposure. FULLY closing it ALSO requires these DASHBOARD steps (not SQL):
--   1. Disable the Data API:  Project Settings → API → remove `public` from exposed schemas
--      (or toggle the Data API off).
--   2. Rotate the anon / publishable key (it has been shipped in the JS bundle); update the
--      SUPABASE_ANON_KEY / VITE_SUPABASE_ANON_KEY everywhere FE/BE read it.
--   3. Disable "Allow new users to sign up" (Auth → Providers) — confirmed ON; off unless
--      self-signup is actually needed.
--   4. Run the opt-in lockout test against each project AFTER applying (proves anon is shut
--      out — see backend/src/__tests__/anon-postgrest-lockout.test.ts):
--        RUN_ANON_LOCKOUT_TEST=1 SUPABASE_URL=<proj-url> SUPABASE_ANON_KEY=<rotated-anon> \
--          npx vitest run src/__tests__/anon-postgrest-lockout.test.ts
--
-- ROLE MODEL: Prisma connects as `postgres` — NOT a superuser but a MEMBER of anon, so a
-- plain ENABLE ROW LEVEL SECURITY is bypassed by the table owner. FORCE is MANDATORY. The
-- app is unaffected: it reaches Postgres directly as postgres/service-role (never the anon
-- PostgREST API), and these REVOKEs only target anon/authenticated. Tenancy stays enforced
-- in Express/Prisma via tenantWhere.
-- =====================================================================================

-- 1) Enable + FORCE row-level security on every base table in `public`. FORCE so the owner
--    `postgres` cannot bypass. `_prisma_migrations` is excluded so the migrator never locks
--    itself out of its own bookkeeping. NO permissive policy is created → deny-all for every
--    non-owner role. Data-driven over pg_tables so it covers new tables + skips dropped ones.
DO $$
DECLARE
  r RECORD;
BEGIN
  FOR r IN
    SELECT tablename
    FROM pg_tables
    WHERE schemaname = 'public'
      AND tablename <> '_prisma_migrations'
  LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY;', r.tablename);
    EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY;', r.tablename);
  END LOOP;
END $$;

-- 2) Strip every existing grant from the API roles, remove their schema usage, and stop
--    FUTURE objects created by `postgres` from auto-granting to them (closes "new table
--    inherits anon grants", F-60). Guarded on role existence so this file is ALSO safe to
--    run against a non-Supabase database (a no-op there).
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon')
     AND EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    REVOKE ALL ON ALL TABLES    IN SCHEMA public FROM anon, authenticated;
    REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM anon, authenticated;
    REVOKE ALL ON ALL FUNCTIONS IN SCHEMA public FROM anon, authenticated;
    REVOKE USAGE  ON SCHEMA public FROM anon, authenticated;
    REVOKE CREATE ON SCHEMA public FROM anon, authenticated;
    ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public REVOKE ALL ON TABLES    FROM anon, authenticated;
    ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public REVOKE ALL ON SEQUENCES FROM anon, authenticated;
    ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public REVOKE ALL ON FUNCTIONS FROM anon, authenticated;
  END IF;
END $$;

-- 3) VERIFY after applying — every domain table should report rls + force = true:
--    SELECT relname, relrowsecurity, relforcerowsecurity
--    FROM pg_class
--    WHERE relnamespace = 'public'::regnamespace AND relkind = 'r'
--    ORDER BY relname;
--
--    And confirm anon/authenticated hold no table grants:
--    SELECT grantee, count(*) FROM information_schema.role_table_grants
--    WHERE table_schema = 'public' AND grantee IN ('anon','authenticated')
--    GROUP BY grantee;   -- expect 0 rows.

-- NOTE (deferred, intentionally NOT in this file): dropping the vestigial users.password_hash
-- column (F-59/F-70) is coupled to a schema.prisma change + client regen, and a destructive
-- DROP on the SHARED staging DB would break any sibling branch still writing it. Do it as a
-- coordinated normal Prisma migration once servwave is the single source — see the plan.
