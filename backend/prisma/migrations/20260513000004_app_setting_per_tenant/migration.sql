-- AppSetting per-tenant: composite PK (organization_id, key)
-- Only Alpha org exists pre-migration; backfill all rows with Alpha's org_id.

-- Step 1: add column with temp default for backfill
ALTER TABLE "app_settings" ADD COLUMN "organization_id" UUID NOT NULL
  DEFAULT '00000000-0000-0000-0000-000000000001'::uuid;

-- Step 2: swap primary key from (key) → (organization_id, key)
ALTER TABLE "app_settings" DROP CONSTRAINT "app_settings_pkey";
ALTER TABLE "app_settings" ADD CONSTRAINT "app_settings_pkey" PRIMARY KEY ("organization_id", "key");

-- Step 3: drop temp default (new orgs must set explicitly)
ALTER TABLE "app_settings" ALTER COLUMN "organization_id" DROP DEFAULT;

-- Step 4: FK to organizations
ALTER TABLE "app_settings" ADD CONSTRAINT "app_settings_organization_id_fkey"
  FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
