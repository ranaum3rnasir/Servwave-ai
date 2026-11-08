-- workflow_enrollments (entity_type, entity_id) index.
--
-- WHY. The dashboard's "customer not told" needs-attention item (scheduling-notifications PRD,
-- md_files/specs/scheduling/2026-09-13-customer-scheduling-notifications-and-visit-milestones.md)
-- reads the workflow ledger directly on every dashboard load: for the jobs and leads with a live
-- visit in the next 48 hours, "is there a scheduling enrollment on this entity whose send step
-- reached the customer". That is `WHERE entity_type = ? AND entity_id IN (...)`, and the
-- enrollment table carried no index on that pair, so the lookup was a scan of the org's
-- enrollments. The rearm-on-reschedule path (enrollment.ts rearmAnchoredWaits) filters on the
-- same pair and benefits for free.
--
-- IDEMPOTENT: CREATE INDEX IF NOT EXISTS, so a second application against the shared staging DB
--   is a no-op.
-- PORTABLE: vanilla postgres:16 (the CI migration-check job); no Supabase-only objects, no roles.
-- NO TABLE REWRITE, NO DATA CHANGE. The name is the one Prisma derives for
--   `@@index([entity_type, entity_id])` on the model, so `prisma migrate diff` sees no drift.

CREATE INDEX IF NOT EXISTS "workflow_enrollments_entity_type_entity_id_idx" ON "workflow_enrollments"("entity_type", "entity_id");
