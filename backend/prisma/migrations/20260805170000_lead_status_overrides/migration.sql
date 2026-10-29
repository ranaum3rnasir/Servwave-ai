-- SRVW-111 (label-override shape, per Ran's 2026-08-05 scope call): per-org display
-- overrides for the FIXED LeadStatus enum - rename, reorder, hide, and pick which
-- status a new lead defaults to. Does NOT widen LeadStatus and does NOT let an org
-- add a new value: Servy's advertised lead vocabulary (statusVocabulary('lead') in
-- copilot/tools/toolRegistry.ts) stays the enum, unchanged.
--
-- IDEMPOTENT: IF NOT EXISTS on the CREATE; the FK inside a pg_constraint DO-block guard;
--   DROP POLICY IF EXISTS before CREATE POLICY. A second run on the shared staging DB is a
--   no-op.
-- PORTABLE: vanilla postgres:16 (the CI migration-check job) - the RLS policy has no TO
--   clause (core Postgres), and the only Supabase-role objects are the anon/authenticated
--   REVOKEs, which are guarded by pg_roles checks.
-- ADDITIVE ONLY: no CREATE TYPE (enum "LeadStatus" already exists and is deliberately NOT
--   widened) and no backfill - an org with no rows here simply uses the enum's own labels,
--   declaration order, and NEW as the default (see lead-status-override.ts's resolver).

CREATE TABLE IF NOT EXISTS "lead_status_overrides" (
  "id"              UUID NOT NULL,
  "organization_id" UUID NOT NULL,
  "status"          "LeadStatus" NOT NULL,
  -- NULL = no rename; falls back to the registry's own label for this enum value.
  "label"           TEXT,
  "sort_order"      INTEGER NOT NULL DEFAULT 0,
  "is_default"      BOOLEAN NOT NULL DEFAULT false,
  "hidden"          BOOLEAN NOT NULL DEFAULT false,
  "created_at"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"      TIMESTAMP(3) NOT NULL,
  CONSTRAINT "lead_status_overrides_pkey" PRIMARY KEY ("id")
);

-- One config row per (org, status) - unlike job_sub_statuses this is not a user-created
-- catalog, it is at most 6 rows per org, one per fixed enum member.
CREATE UNIQUE INDEX IF NOT EXISTS "lead_status_overrides_organization_id_status_key"
  ON "lead_status_overrides"("organization_id", "status");

-- organization_id RESTRICT (the tenant row must outlive its children), matching job_sub_statuses.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'lead_status_overrides_organization_id_fkey') THEN
    ALTER TABLE "lead_status_overrides" ADD CONSTRAINT "lead_status_overrides_organization_id_fkey"
      FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;
END $$;

-- ─── Tenant RLS backstop (exact 20260703000100_tenant_rls pattern; fail-closed; INERT until
--     a non-BYPASSRLS role + DB_TENANT_GUARD=on) ────────────────────────────────
ALTER TABLE "lead_status_overrides" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "lead_status_overrides" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "tenant_isolation" ON "lead_status_overrides";
CREATE POLICY "tenant_isolation" ON "lead_status_overrides"
  USING (current_setting('app.bypass_rls', true) = 'on' OR "organization_id" = NULLIF(current_setting('app.current_org_id', true), '')::uuid)
  WITH CHECK (current_setting('app.bypass_rls', true) = 'on' OR "organization_id" = NULLIF(current_setting('app.current_org_id', true), '')::uuid);

-- Defense-in-depth: strip Supabase PostgREST role grants (the global sweep in 20260708140000 only
-- covered tables existing at its run time; a new table must repeat this). pg_roles guards keep this
-- valid on CI's vanilla postgres.
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    EXECUTE 'REVOKE ALL PRIVILEGES ON public.lead_status_overrides FROM anon';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    EXECUTE 'REVOKE ALL PRIVILEGES ON public.lead_status_overrides FROM authenticated';
  END IF;
END $$;
