-- Department multi-tenancy
-- Departments were globally unique by name; now per-org. Backfill from any assigned user;
-- orphan departments (no users) fall back to ALPHA org for MVP.

-- Step 1: add column NULL initially (so we can backfill)
ALTER TABLE "departments" ADD COLUMN "organization_id" UUID;

-- Step 2: backfill from any assigned user (a department's org is the org of its users)
UPDATE departments d SET organization_id = (
  SELECT u.organization_id
  FROM users u
  WHERE u.department_id = d.id
  LIMIT 1
);

-- Step 3: orphan departments (no users assigned) → ALPHA org for MVP
UPDATE departments SET organization_id = '00000000-0000-0000-0000-000000000001'::uuid
WHERE organization_id IS NULL;

-- Step 4: enforce NOT NULL
ALTER TABLE "departments" ALTER COLUMN "organization_id" SET NOT NULL;

-- Step 5: replace global unique on name with composite (organization_id, name)
ALTER TABLE "departments" DROP CONSTRAINT IF EXISTS "departments_name_key";
DROP INDEX IF EXISTS "departments_name_key";
ALTER TABLE "departments" ADD CONSTRAINT "departments_organization_id_name_key" UNIQUE ("organization_id", "name");

-- Step 6: index + FK
CREATE INDEX "departments_organization_id_idx" ON "departments"("organization_id");
ALTER TABLE "departments" ADD CONSTRAINT "departments_organization_id_fkey"
  FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
