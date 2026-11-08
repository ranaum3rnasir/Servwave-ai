-- SRVW-138 phase one: org-defined custom roles.
--
-- Adds `custom_roles` and `users.custom_role_id`. The `Role` enum is UNCHANGED and
-- users.role keeps its meaning as the BASE role; a custom role supplies the GRANT set
-- (its `key` is written into role_permissions.role, which is already a free-form
-- String column scoped per org).
--
-- Purely additive: no backfill, no data migration. Every existing user has
-- custom_role_id NULL and resolves exactly as before.
--
-- Portable (core Postgres only - no Supabase roles, no auth.*) and idempotent
-- (IF NOT EXISTS throughout, DROP POLICY IF EXISTS before CREATE POLICY).

-- Column defaults match what `prisma migrate diff` emits for this model, so the
-- migrations dir stays drift-free against schema.prisma: `id` (@default(uuid())) and
-- `updated_at` (@updatedAt) are supplied by the Prisma client, NOT by the database.
CREATE TABLE IF NOT EXISTS "custom_roles" (
  "id"              UUID         NOT NULL,
  "organization_id" UUID         NOT NULL,
  "key"             TEXT         NOT NULL,
  "label"           TEXT         NOT NULL,
  "description"     TEXT         NOT NULL DEFAULT '',
  "base_role"       "Role"       NOT NULL,
  "archived_at"     TIMESTAMP(3),
  "created_at"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"      TIMESTAMP(3) NOT NULL,
  CONSTRAINT "custom_roles_pkey" PRIMARY KEY ("id")
);

-- A custom role's key shares the role_permissions.role column with the four system
-- role names, so a collision would silently merge its grants into a system role's.
-- Enforced in the API (effectiveRole.ts isReservedRoleKey) and here, so a raw INSERT
-- or a future migration cannot bypass it.
DO $$ BEGIN
  ALTER TABLE "custom_roles"
    ADD CONSTRAINT "custom_roles_key_not_reserved"
    CHECK (upper("key") NOT IN ('ADMIN', 'SALES', 'DISPATCHER', 'TECHNICIAN'));
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS "custom_roles_organization_id_key_key"
  ON "custom_roles" ("organization_id", "key");
CREATE INDEX IF NOT EXISTS "custom_roles_organization_id_idx"
  ON "custom_roles" ("organization_id");

DO $$ BEGIN
  ALTER TABLE "custom_roles"
    ADD CONSTRAINT "custom_roles_organization_id_fkey"
    FOREIGN KEY ("organization_id") REFERENCES "organizations" ("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "custom_role_id" UUID;

-- ON DELETE SET NULL, not CASCADE: deleting a role must never delete people. The
-- user falls back to their base role, which is the conservative outcome. (The API
-- blocks archiving a role that still has users assigned; this is the DB backstop.)
DO $$ BEGIN
  ALTER TABLE "users"
    ADD CONSTRAINT "users_custom_role_id_fkey"
    FOREIGN KEY ("custom_role_id") REFERENCES "custom_roles" ("id")
    ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

CREATE INDEX IF NOT EXISTS "users_custom_role_id_idx" ON "users" ("custom_role_id");

-- ─── Tenant isolation RLS backstop ───
-- Same shape as every org-scoped table in 20260703000100_tenant_rls. Applied here at
-- table-creation time so custom_roles does not repeat the gap tracked as #1276, where
-- four tables reached prod with relrowsecurity=false and zero policies. Inert until
-- the app connects as a non-BYPASSRLS role AND DB_TENANT_GUARD=on.
ALTER TABLE "custom_roles" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "custom_roles" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "tenant_isolation" ON "custom_roles";
CREATE POLICY "tenant_isolation" ON "custom_roles"
  USING (current_setting('app.bypass_rls', true) = 'on' OR "organization_id" = NULLIF(current_setting('app.current_org_id', true), '')::uuid)
  WITH CHECK (current_setting('app.bypass_rls', true) = 'on' OR "organization_id" = NULLIF(current_setting('app.current_org_id', true), '')::uuid);
