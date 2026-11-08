-- Extend the tenant RLS backstop (20260703000100_tenant_rls) to the four org-scoped
-- tables that shipped without it and reached PROD with relrowsecurity=false and zero
-- policies: automation_rules, automation_runs, job_line_items, org_tax_rates (#1276).
--
-- Same fail-closed pattern as every other org-scoped table, and INERT for the same
-- reason: until the app connects as a non-BYPASSRLS role AND DB_TENANT_GUARD=on, a
-- BYPASSRLS role ignores RLS entirely, so applying this changes no app behaviour.
-- See docs/rls-activation-runbook.md.
--
-- Safe to FORCE: all four columns are `organization_id uuid NOT NULL`, and both
-- staging and prod were checked for NULLs before writing this (0 in every table).
-- A NULL there would be invisible under this policy - that is the failure mode
-- 20260707000100_disable_rls_global_reference_tables had to clean up after.
--
-- Why these four were missed, recorded so the next table does not repeat it: the
-- tenant_rls migration enumerates its tables by hand, and nothing enumerated the
-- real schema to check that list. rls-isolation.test.ts proves the POLICY SHAPE
-- against a synthetic table it builds itself, so a real table with no policy at all
-- passed CI untouched. src/__tests__/rls-coverage.test.ts, added alongside this
-- migration, is that missing check.
--
-- NOT included: email_suppressions, which also has an organization_id but is global
-- BY DESIGN - a hard bounce belongs to the address, not to the org that triggered
-- it, and the suppression gate reads it with no org filter. Full rationale lives in
-- the GLOBAL_BY_DESIGN entry in rls-coverage.test.ts.
--
-- Portable (vanilla Postgres: current_setting/NULLIF/uuid are core; the policy is
-- TO public so no Supabase role is required) and idempotent (DROP POLICY IF EXISTS
-- before CREATE; ENABLE/FORCE are no-ops on re-run).

ALTER TABLE "automation_rules" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "automation_rules" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "tenant_isolation" ON "automation_rules";
CREATE POLICY "tenant_isolation" ON "automation_rules"
  USING (current_setting('app.bypass_rls', true) = 'on' OR "organization_id" = NULLIF(current_setting('app.current_org_id', true), '')::uuid)
  WITH CHECK (current_setting('app.bypass_rls', true) = 'on' OR "organization_id" = NULLIF(current_setting('app.current_org_id', true), '')::uuid);

ALTER TABLE "automation_runs" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "automation_runs" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "tenant_isolation" ON "automation_runs";
CREATE POLICY "tenant_isolation" ON "automation_runs"
  USING (current_setting('app.bypass_rls', true) = 'on' OR "organization_id" = NULLIF(current_setting('app.current_org_id', true), '')::uuid)
  WITH CHECK (current_setting('app.bypass_rls', true) = 'on' OR "organization_id" = NULLIF(current_setting('app.current_org_id', true), '')::uuid);

ALTER TABLE "job_line_items" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "job_line_items" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "tenant_isolation" ON "job_line_items";
CREATE POLICY "tenant_isolation" ON "job_line_items"
  USING (current_setting('app.bypass_rls', true) = 'on' OR "organization_id" = NULLIF(current_setting('app.current_org_id', true), '')::uuid)
  WITH CHECK (current_setting('app.bypass_rls', true) = 'on' OR "organization_id" = NULLIF(current_setting('app.current_org_id', true), '')::uuid);

ALTER TABLE "org_tax_rates" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "org_tax_rates" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "tenant_isolation" ON "org_tax_rates";
CREATE POLICY "tenant_isolation" ON "org_tax_rates"
  USING (current_setting('app.bypass_rls', true) = 'on' OR "organization_id" = NULLIF(current_setting('app.current_org_id', true), '')::uuid)
  WITH CHECK (current_setting('app.bypass_rls', true) = 'on' OR "organization_id" = NULLIF(current_setting('app.current_org_id', true), '')::uuid);

-- Defense-in-depth, mirroring 20260708140000_revoke_api_roles_on_tenant_tables. That
-- migration computes its scope dynamically and is documented as covering "any tenant
-- table added later" - but it only selects tables that ALREADY have RLS enabled and
-- forced, and it has already run, so it never covered these four. Re-stating the
-- revoke here is what actually closes that gap.
--
-- Portable: anon/authenticated exist only on Supabase, not the vanilla postgres image
-- CI runs against - guarded behind a role-existence check. Idempotent: REVOKE of an
-- absent privilege is a no-op. Each role is guarded SEPARATELY, not with one combined
-- REVOKE ... FROM anon, authenticated: a single statement naming both fails outright
-- if only one of the two roles exists. Same shape as the precedent for that reason.
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['automation_rules', 'automation_runs', 'job_line_items', 'org_tax_rates'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
      EXECUTE format('REVOKE ALL PRIVILEGES ON public.%I FROM anon', t);
    END IF;
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
      EXECUTE format('REVOKE ALL PRIVILEGES ON public.%I FROM authenticated', t);
    END IF;
  END LOOP;
END $$;
