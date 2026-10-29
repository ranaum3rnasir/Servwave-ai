-- TimelineEvent multi-tenancy
-- Step 1: add column NULL initially (so we can backfill)
ALTER TABLE "timeline_events" ADD COLUMN "organization_id" UUID;

-- Step 2: backfill from parent entity (JOB/LEAD/ESTIMATE/INVOICE/CUSTOMER)
UPDATE timeline_events te SET organization_id = COALESCE(
  CASE WHEN te.entity_type = 'JOB'      THEN (SELECT organization_id FROM jobs       WHERE id = te.entity_id) END,
  CASE WHEN te.entity_type = 'LEAD'     THEN (SELECT organization_id FROM leads      WHERE id = te.entity_id) END,
  CASE WHEN te.entity_type = 'ESTIMATE' THEN (SELECT organization_id FROM estimates  WHERE id = te.entity_id) END,
  CASE WHEN te.entity_type = 'INVOICE'  THEN (SELECT organization_id FROM invoices   WHERE id = te.entity_id) END,
  CASE WHEN te.entity_type = 'CUSTOMER' THEN (SELECT organization_id FROM customers  WHERE id = te.entity_id) END
);

-- Step 3: orphans (parent entity already deleted) → ALPHA org for MVP
UPDATE timeline_events SET organization_id = '00000000-0000-0000-0000-000000000001'::uuid
WHERE organization_id IS NULL;

-- Step 4: enforce NOT NULL + index + FK
ALTER TABLE "timeline_events" ALTER COLUMN "organization_id" SET NOT NULL;
CREATE INDEX "timeline_events_organization_id_created_at_idx"
  ON "timeline_events"("organization_id", "created_at");
ALTER TABLE "timeline_events" ADD CONSTRAINT "timeline_events_organization_id_fkey"
  FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
