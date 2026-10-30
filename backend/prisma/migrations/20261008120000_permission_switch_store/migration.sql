-- Roles & Permissions Overhaul, PRD 1, slice S01.1: the per-person switch store (M2).
--
-- Three new tables hold a role's switch values, a person's switch values and an append-only log of
-- every change to either; users gains the role a person was last given (based_on_role_key) and
-- custom_roles gains a marker for a role made from blank. The switch catalog itself is code, not data.
--
-- PURE EXPAND. Three new tables, two new nullable/defaulted columns, indexes, foreign keys and the
-- tenant RLS backstop. Nothing existing is dropped, renamed or narrowed, so the old instance running
-- during the deploy overlap never names anything that has gone. No backfill: a person with no stored
-- values resolves through their role and the built-in preset, and the programme's preset migration
-- (a later slice) is what fills real people.
--
-- IDEMPOTENT + portable: every CREATE is IF NOT EXISTS, every constraint tolerates a re-run, every
-- policy is dropped before it is created, and the Supabase-only roles sit behind a pg_roles guard.
-- Runs on CI's vanilla postgres:16, on the Render deploy, and possibly twice against the shared
-- staging DB. NEVER run `prisma migrate` from a worktree.

ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "based_on_role_key" TEXT;
ALTER TABLE "custom_roles" ADD COLUMN IF NOT EXISTS "made_from_blank" BOOLEAN NOT NULL DEFAULT false;

CREATE TABLE IF NOT EXISTS "permission_role_switches" (
  "id"              UUID NOT NULL,
  "organization_id" UUID NOT NULL,
  "role_key"        TEXT NOT NULL,
  "switch_key"      TEXT NOT NULL,
  "value"           JSONB NOT NULL,
  "created_at"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"      TIMESTAMP(3) NOT NULL,
  CONSTRAINT "permission_role_switches_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "permission_user_switches" (
  "id"              UUID NOT NULL,
  "organization_id" UUID NOT NULL,
  "user_id"         UUID NOT NULL,
  "switch_key"      TEXT NOT NULL,
  "value"           JSONB NOT NULL,
  "created_at"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"      TIMESTAMP(3) NOT NULL,
  CONSTRAINT "permission_user_switches_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "permission_change_log" (
  "id"              UUID NOT NULL,
  "organization_id" UUID NOT NULL,
  "target_type"     TEXT NOT NULL,
  "target_id"       TEXT NOT NULL,
  "switch_key"      TEXT NOT NULL,
  "from_value"      JSONB,
  "to_value"        JSONB,
  "actor_id"        UUID,
  "reason"          TEXT NOT NULL,
  "created_at"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "permission_change_log_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "permission_role_switches_org_role_switch_key"
  ON "permission_role_switches"("organization_id", "role_key", "switch_key");
CREATE INDEX IF NOT EXISTS "permission_role_switches_organization_id_role_key_idx"
  ON "permission_role_switches"("organization_id", "role_key");
CREATE UNIQUE INDEX IF NOT EXISTS "permission_user_switches_user_id_switch_key_key"
  ON "permission_user_switches"("user_id", "switch_key");
CREATE INDEX IF NOT EXISTS "permission_user_switches_organization_id_idx"
  ON "permission_user_switches"("organization_id");
CREATE INDEX IF NOT EXISTS "permission_change_log_org_target_idx"
  ON "permission_change_log"("organization_id", "target_type", "target_id", "created_at");

-- Foreign keys: the org CASCADEs (an org purge takes its permission records with it) and so does the
-- person (their own switch values go with them). The change log keeps its actor and target as plain
-- ids, so the history of who changed what outlives a deleted user.
DO $$ BEGIN
  ALTER TABLE "permission_role_switches" ADD CONSTRAINT "permission_role_switches_organization_id_fkey"
    FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN null; END $$;

DO $$ BEGIN
  ALTER TABLE "permission_user_switches" ADD CONSTRAINT "permission_user_switches_organization_id_fkey"
    FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN null; END $$;

DO $$ BEGIN
  ALTER TABLE "permission_user_switches" ADD CONSTRAINT "permission_user_switches_user_id_fkey"
    FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN null; END $$;

DO $$ BEGIN
  ALTER TABLE "permission_change_log" ADD CONSTRAINT "permission_change_log_organization_id_fkey"
    FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN null; END $$;

-- Tenant RLS backstop, the same fail-closed pattern every org-scoped table carries
-- (20260703000100_tenant_rls). rls-coverage.test.ts requires it of every table with an
-- organization_id column.
ALTER TABLE "permission_role_switches" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "permission_role_switches" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "tenant_isolation" ON "permission_role_switches";
CREATE POLICY "tenant_isolation" ON "permission_role_switches"
  USING (current_setting('app.bypass_rls', true) = 'on' OR "organization_id" = NULLIF(current_setting('app.current_org_id', true), '')::uuid)
  WITH CHECK (current_setting('app.bypass_rls', true) = 'on' OR "organization_id" = NULLIF(current_setting('app.current_org_id', true), '')::uuid);

ALTER TABLE "permission_user_switches" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "permission_user_switches" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "tenant_isolation" ON "permission_user_switches";
CREATE POLICY "tenant_isolation" ON "permission_user_switches"
  USING (current_setting('app.bypass_rls', true) = 'on' OR "organization_id" = NULLIF(current_setting('app.current_org_id', true), '')::uuid)
  WITH CHECK (current_setting('app.bypass_rls', true) = 'on' OR "organization_id" = NULLIF(current_setting('app.current_org_id', true), '')::uuid);

ALTER TABLE "permission_change_log" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "permission_change_log" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "tenant_isolation" ON "permission_change_log";
CREATE POLICY "tenant_isolation" ON "permission_change_log"
  USING (current_setting('app.bypass_rls', true) = 'on' OR "organization_id" = NULLIF(current_setting('app.current_org_id', true), '')::uuid)
  WITH CHECK (current_setting('app.bypass_rls', true) = 'on' OR "organization_id" = NULLIF(current_setting('app.current_org_id', true), '')::uuid);

-- Strip PostgREST role grants: the dynamic sweep in 20260708140000 ran long before these tables
-- existed. Guarded - anon/authenticated exist only on Supabase.
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    EXECUTE 'REVOKE ALL PRIVILEGES ON public.permission_role_switches FROM anon';
    EXECUTE 'REVOKE ALL PRIVILEGES ON public.permission_user_switches FROM anon';
    EXECUTE 'REVOKE ALL PRIVILEGES ON public.permission_change_log FROM anon';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    EXECUTE 'REVOKE ALL PRIVILEGES ON public.permission_role_switches FROM authenticated';
    EXECUTE 'REVOKE ALL PRIVILEGES ON public.permission_user_switches FROM authenticated';
    EXECUTE 'REVOKE ALL PRIVILEGES ON public.permission_change_log FROM authenticated';
  END IF;
END $$;
