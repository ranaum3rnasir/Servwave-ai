-- Defense-in-depth: revoke the default `anon`/`authenticated` PostgREST grants from every
-- RLS-tenant-isolated table. The app never connects as `anon`/`authenticated` (it uses
-- `app_rls`/`postgres`), and RLS already blocks those roles from reading real rows — but
-- Supabase's default grants leave them one accidental `DISABLE ROW LEVEL SECURITY` away from
-- a live PII/financial leak via the public Data API (exactly what happened to
-- state_tax_rates/stripe_events in 20260707140000). Revoking removes that reliance entirely:
-- even if RLS is ever mistakenly disabled on one of these tables, `anon`/`authenticated` still
-- have no grant to read it.
--
-- Scope is generated dynamically (every table with RLS enabled + forced + at least one
-- policy) rather than hardcoded, so it automatically covers any tenant table added later by
-- a future migration.
--
-- Portable: `anon`/`authenticated` exist only on Supabase, not the vanilla postgres image
-- CI's migration-check runs against — guarded behind a role-existence check.
-- Idempotent: REVOKE of an already-absent privilege is a no-op, so re-runs are safe.
DO $$
DECLARE
  t RECORD;
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon')
     OR EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    FOR t IN
      SELECT c.relname
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relkind = 'r'
        AND c.relrowsecurity = true AND c.relforcerowsecurity = true
        AND EXISTS (SELECT 1 FROM pg_policies p WHERE p.schemaname = 'public' AND p.tablename = c.relname)
    LOOP
      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
        EXECUTE format('REVOKE ALL PRIVILEGES ON public.%I FROM anon', t.relname);
      END IF;
      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
        EXECUTE format('REVOKE ALL PRIVILEGES ON public.%I FROM authenticated', t.relname);
      END IF;
    END LOOP;
  END IF;
END $$;
