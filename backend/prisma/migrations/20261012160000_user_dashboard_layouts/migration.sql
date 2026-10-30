-- Dashboard layouts saved on the server (Roles & Permissions, PRD 9, S09.4): one row per person holding their home-page
-- layout, the ordered tile ids with, per tile, whether it shows, its size and its time-range choice. Until now the layout
-- lived in one browser; a person on a new laptop or phone started from the factory layout again.
--
-- PURE EXPAND. One new table, nothing existing is touched, so the previous backend still serving for the few minutes
-- after Render applies this file never names anything that has changed. No backfill: a person with no row is given
-- their role's default layout (fixed data in the tile catalog), and a layout already saved in a browser is carried over
-- by a later slice.
--
-- The person owns the row (one per person, deleted with the person) and the company owns it too, so the company purge
-- and the tenant RLS backstop both reach it through organization_id.
--
-- Idempotent and portable per .claude/skills/writing-migrations: IF NOT EXISTS everywhere, FKs in duplicate_object
-- guards, DROP POLICY before CREATE POLICY, Supabase roles behind pg_roles guards. NEVER run `prisma migrate` from a
-- worktree.

CREATE TABLE IF NOT EXISTS "user_dashboard_layouts" (
    "user_id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "layout" JSONB NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "user_dashboard_layouts_pkey" PRIMARY KEY ("user_id")
);

CREATE INDEX IF NOT EXISTS "user_dashboard_layouts_organization_id_idx" ON "user_dashboard_layouts"("organization_id");

DO $$ BEGIN
  ALTER TABLE "user_dashboard_layouts" ADD CONSTRAINT "user_dashboard_layouts_user_id_fkey"
    FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN null; END $$;

DO $$ BEGIN
  ALTER TABLE "user_dashboard_layouts" ADD CONSTRAINT "user_dashboard_layouts_organization_id_fkey"
    FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN null; END $$;

-- Row-level security: the standard company policy, forced, no Supabase client-role grants.
ALTER TABLE "user_dashboard_layouts" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "user_dashboard_layouts" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "tenant_isolation" ON "user_dashboard_layouts";
CREATE POLICY "tenant_isolation" ON "user_dashboard_layouts"
  USING (current_setting('app.bypass_rls', true) = 'on' OR "organization_id" = NULLIF(current_setting('app.current_org_id', true), '')::uuid)
  WITH CHECK (current_setting('app.bypass_rls', true) = 'on' OR "organization_id" = NULLIF(current_setting('app.current_org_id', true), '')::uuid);

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    EXECUTE 'REVOKE ALL PRIVILEGES ON public.user_dashboard_layouts FROM anon';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    EXECUTE 'REVOKE ALL PRIVILEGES ON public.user_dashboard_layouts FROM authenticated';
  END IF;
END $$;
