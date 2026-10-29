-- Extend the tenant RLS backstop (20260703000100_tenant_rls) to custom_field_definitions,
-- which was added by 20260806130000_custom_fields_mvp (SRVW-114 slice 1) and shipped without
-- it. Same fail-closed pattern as every other org-scoped table: INERT until the app connects
-- as a non-BYPASSRLS role AND DB_TENANT_GUARD=on, so applying this changes no app behaviour.
--
-- Why it was missed, recorded so the next table does not repeat it: the tenant_rls migration
-- enumerates tables explicitly, and nothing enumerates real tables to check coverage.
-- rls-isolation.test.ts proves the POLICY SHAPE against a synthetic table it builds itself,
-- so a new table with no policy at all passes CI untouched.
--
-- Portable (vanilla Postgres only) and idempotent (DROP POLICY IF EXISTS before CREATE;
-- ENABLE/FORCE are no-ops on re-run).

ALTER TABLE "custom_field_definitions" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "custom_field_definitions" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "tenant_isolation" ON "custom_field_definitions";
CREATE POLICY "tenant_isolation" ON "custom_field_definitions"
  USING (current_setting('app.bypass_rls', true) = 'on' OR "organization_id" = NULLIF(current_setting('app.current_org_id', true), '')::uuid)
  WITH CHECK (current_setting('app.bypass_rls', true) = 'on' OR "organization_id" = NULLIF(current_setting('app.current_org_id', true), '')::uuid);

-- Defense-in-depth, mirroring 20260708140000_revoke_api_roles_on_tenant_tables. That migration
-- computes its scope dynamically and is documented as covering "any tenant table added later" -
-- but it only selects tables that ALREADY have RLS enabled + forced, and it has already run, so
-- it never covered this one. Re-stating the revoke here is what actually closes that gap.
--
-- Portable: anon/authenticated exist only on Supabase, not the vanilla postgres image CI runs
-- against - guarded behind a role-existence check. Idempotent: REVOKE of an absent privilege
-- is a no-op.
-- Each role is guarded SEPARATELY, not with one combined REVOKE ... FROM anon, authenticated:
-- a single statement naming both fails outright if only one of the two roles exists. Same
-- shape as the precedent for that reason.
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    EXECUTE 'REVOKE ALL PRIVILEGES ON public.custom_field_definitions FROM anon';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    EXECUTE 'REVOKE ALL PRIVILEGES ON public.custom_field_definitions FROM authenticated';
  END IF;
END $$;
