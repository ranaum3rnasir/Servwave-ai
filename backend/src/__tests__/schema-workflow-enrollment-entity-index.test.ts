import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

// Scheduling-notifications slice 06: the dashboard's "customer not told" item reads the
// workflow ledger by entity (`WHERE entity_type = ? AND entity_id IN (...)`) on every dashboard
// load. workflow_enrollments carried no index on that pair, so the lookup was a scan of the
// org's enrollments. Same assertion style as schema-walkthrough-entity-shape.test.ts.
const SQL = readFileSync(
  join(__dirname, '../../prisma/migrations/20260913130000_workflow_enrollments_entity_index/migration.sql'),
  'utf8',
);
const SCHEMA = readFileSync(join(__dirname, '../../prisma/schema.prisma'), 'utf8');

describe('workflow_enrollments (entity_type, entity_id) index migration', () => {
  it('creates the index idempotently, under the name Prisma derives for the pair', () => {
    expect(SQL).toContain(
      'CREATE INDEX IF NOT EXISTS "workflow_enrollments_entity_type_entity_id_idx" ON "workflow_enrollments"("entity_type", "entity_id")',
    );
  });

  it('declares the same index on the WorkflowEnrollment model so schema and database agree', () => {
    const model = SCHEMA.slice(SCHEMA.indexOf('model WorkflowEnrollment {'), SCHEMA.indexOf('@@map("workflow_enrollments")'));
    expect(model).toContain('@@index([entity_type, entity_id])');
  });
});
