-- Extend the tenant RLS backstop (20260703000100_tenant_rls) to the two tables
-- introduced by the estimate-workspace redesign, which landed on a parallel
-- branch and predate that migration. Same fail-closed pattern: INERT until the
-- app connects as a non-BYPASSRLS role AND DB_TENANT_GUARD=on.
--
-- Portable (vanilla Postgres only) and idempotent (DROP POLICY IF EXISTS before
-- CREATE; ENABLE/FORCE are no-ops on re-run).

-- scope_presets has its own organization_id column (direct check).
ALTER TABLE "scope_presets" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "scope_presets" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "tenant_isolation" ON "scope_presets";
CREATE POLICY "tenant_isolation" ON "scope_presets"
  USING (current_setting('app.bypass_rls', true) = 'on' OR "organization_id" = NULLIF(current_setting('app.current_org_id', true), '')::uuid)
  WITH CHECK (current_setting('app.bypass_rls', true) = 'on' OR "organization_id" = NULLIF(current_setting('app.current_org_id', true), '')::uuid);

-- estimate_version_snapshots has no organization_id of its own — scoped via its
-- parent estimate, same join pattern as estimate_line_items.
ALTER TABLE "estimate_version_snapshots" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "estimate_version_snapshots" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "tenant_isolation" ON "estimate_version_snapshots";
CREATE POLICY "tenant_isolation" ON "estimate_version_snapshots"
  USING (current_setting('app.bypass_rls', true) = 'on' OR EXISTS (SELECT 1 FROM "estimates" par WHERE par."id" = "estimate_version_snapshots"."estimate_id" AND par."organization_id" = NULLIF(current_setting('app.current_org_id', true), '')::uuid))
  WITH CHECK (current_setting('app.bypass_rls', true) = 'on' OR EXISTS (SELECT 1 FROM "estimates" par WHERE par."id" = "estimate_version_snapshots"."estimate_id" AND par."organization_id" = NULLIF(current_setting('app.current_org_id', true), '')::uuid));
