-- Polymorphic defense-in-depth: add organization_id to Attachment, Note, JobCharge.
-- Previously safe via parent-entity tenant checks; now safe at the column level too.

-- ─── JobCharge: parent is always Job (single-table backfill) ───────────
ALTER TABLE "job_charges" ADD COLUMN "organization_id" UUID;
UPDATE job_charges jc SET organization_id = (SELECT j.organization_id FROM jobs j WHERE j.id = jc.job_id);
UPDATE job_charges SET organization_id = '00000000-0000-0000-0000-000000000001'::uuid WHERE organization_id IS NULL;
ALTER TABLE "job_charges" ALTER COLUMN "organization_id" SET NOT NULL;
CREATE INDEX "job_charges_organization_id_idx" ON "job_charges"("organization_id");
ALTER TABLE "job_charges" ADD CONSTRAINT "job_charges_organization_id_fkey"
  FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ─── Attachment: polymorphic over LEAD/ESTIMATE/JOB/INVOICE ────────────
ALTER TABLE "attachments" ADD COLUMN "organization_id" UUID;
UPDATE attachments a SET organization_id = COALESCE(
  CASE WHEN a.entity_type = 'LEAD'     THEN (SELECT organization_id FROM leads     WHERE id = a.entity_id) END,
  CASE WHEN a.entity_type = 'ESTIMATE' THEN (SELECT organization_id FROM estimates WHERE id = a.entity_id) END,
  CASE WHEN a.entity_type = 'JOB'      THEN (SELECT organization_id FROM jobs      WHERE id = a.entity_id) END,
  CASE WHEN a.entity_type = 'INVOICE'  THEN (SELECT organization_id FROM invoices  WHERE id = a.entity_id) END
);
UPDATE attachments SET organization_id = '00000000-0000-0000-0000-000000000001'::uuid WHERE organization_id IS NULL;
ALTER TABLE "attachments" ALTER COLUMN "organization_id" SET NOT NULL;
CREATE INDEX "attachments_organization_id_idx" ON "attachments"("organization_id");
ALTER TABLE "attachments" ADD CONSTRAINT "attachments_organization_id_fkey"
  FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ─── Note: polymorphic over CUSTOMER/LEAD/ESTIMATE/JOB/INVOICE ─────────
ALTER TABLE "notes" ADD COLUMN "organization_id" UUID;
UPDATE notes n SET organization_id = COALESCE(
  CASE WHEN n.entity_type = 'CUSTOMER' THEN (SELECT organization_id FROM customers WHERE id = n.entity_id) END,
  CASE WHEN n.entity_type = 'LEAD'     THEN (SELECT organization_id FROM leads     WHERE id = n.entity_id) END,
  CASE WHEN n.entity_type = 'ESTIMATE' THEN (SELECT organization_id FROM estimates WHERE id = n.entity_id) END,
  CASE WHEN n.entity_type = 'JOB'      THEN (SELECT organization_id FROM jobs      WHERE id = n.entity_id) END,
  CASE WHEN n.entity_type = 'INVOICE'  THEN (SELECT organization_id FROM invoices  WHERE id = n.entity_id) END
);
UPDATE notes SET organization_id = '00000000-0000-0000-0000-000000000001'::uuid WHERE organization_id IS NULL;
ALTER TABLE "notes" ALTER COLUMN "organization_id" SET NOT NULL;
CREATE INDEX "notes_organization_id_idx" ON "notes"("organization_id");
ALTER TABLE "notes" ADD CONSTRAINT "notes_organization_id_fkey"
  FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
