-- Close the PostgREST (Data API) exposure on the RLS-exempt reference tables.
--
-- state_tax_rates, stripe_events and _prisma_migrations run with RLS DISABLED so the
-- non-bypass `app_rls` role can read them (enabling RLS with no policy denies that role
-- every row — the incident that motivated 20260703000100 / 20260707000100). With RLS off,
-- Supabase's default `anon`/`authenticated` grants would let anyone with the public anon
-- key read/mutate these tables through PostgREST. The app never uses those API roles
-- (it connects as `app_rls` / `postgres`), so revoking their grants closes the hole with
-- zero app impact. `app_rls`'s own grants are untouched.
--
-- Portable: `anon`/`authenticated` exist only on Supabase, not the vanilla postgres image
-- CI's migration-check runs against — guard each REVOKE behind a role-existence check.
-- Idempotent: REVOKE of an absent privilege is a no-op, so re-runs are safe.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    EXECUTE 'REVOKE ALL PRIVILEGES ON public.state_tax_rates, public.stripe_events, public._prisma_migrations FROM anon';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    EXECUTE 'REVOKE ALL PRIVILEGES ON public.state_tax_rates, public.stripe_events, public._prisma_migrations FROM authenticated';
  END IF;
END $$;
