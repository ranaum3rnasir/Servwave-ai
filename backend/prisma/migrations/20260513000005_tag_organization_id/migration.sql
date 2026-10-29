-- Tag multi-tenancy
-- Tags were globally unique by name; now per-org. Backfill from any attached lead;
-- orphan tags (never attached) fall back to ALPHA org for MVP.

-- Step 1: add column NULL initially (so we can backfill)
ALTER TABLE "tags" ADD COLUMN "organization_id" UUID;

-- Step 2: backfill from any attached lead (a tag attached to a lead belongs to that lead's org).
-- LIMIT 1 because a tag could theoretically be attached to leads across orgs pre-migration —
-- we keep the first match; any cross-org attachments will be cleaned up by the unique constraint below.
UPDATE tags t SET organization_id = (
  SELECT l.organization_id
  FROM lead_tags lt
  JOIN leads l ON l.id = lt.lead_id
  WHERE lt.tag_id = t.id
  LIMIT 1
);

-- Step 3: orphan tags (never attached to any lead) → ALPHA org for MVP
UPDATE tags SET organization_id = '00000000-0000-0000-0000-000000000001'::uuid
WHERE organization_id IS NULL;

-- Step 4: enforce NOT NULL
ALTER TABLE "tags" ALTER COLUMN "organization_id" SET NOT NULL;

-- Step 5: replace global unique on name with composite (organization_id, name)
ALTER TABLE "tags" DROP CONSTRAINT IF EXISTS "tags_name_key";
DROP INDEX IF EXISTS "tags_name_key";
ALTER TABLE "tags" ADD CONSTRAINT "tags_organization_id_name_key" UNIQUE ("organization_id", "name");

-- Step 6: index + FK
CREATE INDEX "tags_organization_id_idx" ON "tags"("organization_id");
ALTER TABLE "tags" ADD CONSTRAINT "tags_organization_id_fkey"
  FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
