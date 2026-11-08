-- The per-org estimate decline reason list (decline-reasons slice B; plan:
-- md_files/issues/estimates/02-let-admins-decide-the-decline-reasons.md).
--
-- An admin manages the reasons an estimate can be declined for, so a cabinet business can add
-- "Designer" and "Quality" - categories the five built-in codes have no home for. The table is
-- modelled on `uom_options`: a per-org option list keyed on a CODE STRING that the owning row
-- stores verbatim, never by foreign key. `estimates.lost_reason` holds that code.
--
-- PURE EXPAND, AND NOTHING ELSE. One new table, its indexes, its FK and the RLS backstop.
-- Nothing is dropped, renamed or backfilled, so the old instance running during the deploy
-- overlap never names a column that has gone (see 20260908120000_manual_comm_customer_anchor's
-- header for that hazard).
--
-- NO SEED ROWS, ON PURPOSE (decision D3). An organisation with zero rows here resolves to the
-- five built-in reasons in code; its FIRST save materialises all five at once. Writing five rows
-- into every organisation would have made this migration a backfill over the whole tenant table,
-- would have to be repeated for every organisation created afterwards, and would still need the
-- code-side fallback for the window between the two. The fallback alone is the whole mechanism.
--
-- IDEMPOTENT + portable: every statement is IF NOT EXISTS or guarded, plain DDL, no
-- Supabase-only objects. Runs on CI's vanilla postgres:16, on the Render deploy, and possibly
-- twice against the shared staging DB. NEVER run `prisma migrate` from a worktree.

CREATE TABLE IF NOT EXISTS "lost_reason_options" (
  "id"              UUID NOT NULL,
  -- The stored value. Immutable after create: declined estimates already hold this string.
  "code"            TEXT NOT NULL,
  -- The words BOTH pickers show. Renameable, and renaming rewrites no estimate.
  "label"           TEXT NOT NULL,
  -- Deactivated, never deleted (D4). A declined estimate keeps reporting its reason and the
  -- conversion report keeps grouping on the code; it simply stops being offered.
  "is_active"       BOOLEAN NOT NULL DEFAULT true,
  "sort_order"      INTEGER NOT NULL DEFAULT 0,
  "created_at"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"      TIMESTAMP(3) NOT NULL,
  "organization_id" UUID NOT NULL,
  CONSTRAINT "lost_reason_options_pkey" PRIMARY KEY ("id")
);

-- One row per code per org. This is also what makes materialisation safe under a race: two
-- admins saving at once both try to insert the five built-ins, and the second insert is skipped
-- on the conflict instead of doubling the list.
CREATE UNIQUE INDEX IF NOT EXISTS "lost_reason_options_organization_id_code_key"
  ON "lost_reason_options"("organization_id", "code");

-- Every read of this table is "this org's list, in the admin's order".
CREATE INDEX IF NOT EXISTS "lost_reason_options_organization_id_sort_order_idx"
  ON "lost_reason_options"("organization_id", "sort_order");

DO $$ BEGIN
  ALTER TABLE "lost_reason_options" ADD CONSTRAINT "lost_reason_options_organization_id_fkey"
    FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN null; END $$;

-- Tenant RLS backstop, the same fail-closed pattern every org-scoped table carries
-- (20260703000100_tenant_rls, and 20260910120000_call_tracking_integrations for a table added
-- after it). Inert until the app connects as a non-BYPASSRLS role AND DB_TENANT_GUARD=on, but
-- rls-coverage.test.ts requires it of every table with an organization_id column - a new table
-- without it is exactly how org_tax_rates and custom_field_definitions reached prod unprotected
-- (issue #1276).
ALTER TABLE "lost_reason_options" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "lost_reason_options" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "tenant_isolation" ON "lost_reason_options";
CREATE POLICY "tenant_isolation" ON "lost_reason_options"
  USING (current_setting('app.bypass_rls', true) = 'on' OR "organization_id" = NULLIF(current_setting('app.current_org_id', true), '')::uuid)
  WITH CHECK (current_setting('app.bypass_rls', true) = 'on' OR "organization_id" = NULLIF(current_setting('app.current_org_id', true), '')::uuid);

-- Strip PostgREST role grants: the dynamic sweep in 20260708140000 ran long before this table
-- existed, so nothing else revokes them. Guarded - anon/authenticated exist only on Supabase.
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    EXECUTE 'REVOKE ALL PRIVILEGES ON public.lost_reason_options FROM anon';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    EXECUTE 'REVOKE ALL PRIVILEGES ON public.lost_reason_options FROM authenticated';
  END IF;
END $$;
