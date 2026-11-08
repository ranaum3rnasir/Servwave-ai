-- Comm caller-ID overhaul slice 2: many-to-many User<->PhoneNumber mapping +
-- an org-level default caller ID. `resolveOutboundNumber` reads these to pick
-- the from-number for the click-to-call bridge and outbound SMS:
--   user's default assignment -> org default -> legacy oldest-active.
--
-- Idempotent + portable on purpose: this runs on CI's vanilla postgres:16, on
-- Render deploy, and possibly twice against the SHARED staging Supabase DB.
-- NEVER run `prisma migrate` from a worktree. Supabase-only roles are
-- existence-guarded so the SQL stays valid on core Postgres.

-- Org-level fallback caller ID (app enforces <=1 true per org).
ALTER TABLE "phone_numbers" ADD COLUMN IF NOT EXISTS "is_org_default" BOOLEAN NOT NULL DEFAULT false;

-- Many-to-many join: which org numbers a user may present, and their default.
CREATE TABLE IF NOT EXISTS "user_phone_numbers" (
  "user_id"         UUID NOT NULL,
  "phone_number_id" UUID NOT NULL,
  "is_default"      BOOLEAN NOT NULL DEFAULT false,
  "created_at"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "user_phone_numbers_pkey" PRIMARY KEY ("user_id", "phone_number_id")
);

CREATE INDEX IF NOT EXISTS "user_phone_numbers_phone_number_id_idx"
  ON "user_phone_numbers"("phone_number_id");

DO $$ BEGIN
  ALTER TABLE "user_phone_numbers" ADD CONSTRAINT "user_phone_numbers_user_id_fkey"
    FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN null; END $$;

DO $$ BEGIN
  ALTER TABLE "user_phone_numbers" ADD CONSTRAINT "user_phone_numbers_phone_number_id_fkey"
    FOREIGN KEY ("phone_number_id") REFERENCES "phone_numbers"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN null; END $$;

-- Tenant RLS backstop. The join table has no organization_id of its own, so it
-- scopes through the linked phone_number's org (same fail-closed pattern as
-- phone_numbers / pending_call_attributions: INERT until the app connects as a
-- non-BYPASSRLS role AND DB_TENANT_GUARD=on).
ALTER TABLE "user_phone_numbers" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "user_phone_numbers" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "tenant_isolation" ON "user_phone_numbers";
CREATE POLICY "tenant_isolation" ON "user_phone_numbers"
  USING (
    current_setting('app.bypass_rls', true) = 'on'
    OR EXISTS (
      SELECT 1 FROM "phone_numbers" pn
      WHERE pn."id" = "user_phone_numbers"."phone_number_id"
        AND pn."organization_id" = NULLIF(current_setting('app.current_org_id', true), '')::uuid
    )
  )
  WITH CHECK (
    current_setting('app.bypass_rls', true) = 'on'
    OR EXISTS (
      SELECT 1 FROM "phone_numbers" pn
      WHERE pn."id" = "user_phone_numbers"."phone_number_id"
        AND pn."organization_id" = NULLIF(current_setting('app.current_org_id', true), '')::uuid
    )
  );

-- Defense-in-depth: strip Supabase PostgREST role grants from the new table.
-- The dynamic sweep in 20260708140000_revoke_api_roles_on_tenant_tables ran
-- before this table existed, so it needs its own revoke. Guarded:
-- anon/authenticated exist only on Supabase, not CI's vanilla postgres.
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    EXECUTE 'REVOKE ALL PRIVILEGES ON public.user_phone_numbers FROM anon';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    EXECUTE 'REVOKE ALL PRIVILEGES ON public.user_phone_numbers FROM authenticated';
  END IF;
END $$;
