import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

/**
 * Multi-visit slice S3's migration, pinned by TEXT.
 *
 * BE HONEST ABOUT THE SEAM: this is a ratchet against accidental edits, not a behaviour driven
 * through a public interface. Prisma is fully mocked across the backend suite and no test in this
 * repo executes migration SQL, so a green run here is NOT evidence the migration works. The real
 * verification is manual and is reported alongside this slice: apply the whole ledger twice
 * against a scratch vanilla postgres:16 and confirm the second run is a no-op.
 *
 * A NEW SIBLING, deliberately, rather than an edit to schema-job-visits-shape.test.ts,
 * schema-assignment-shape.test.ts, schema-walkthrough-entity-shape.test.ts or
 * permissions-crew-backfill.test.ts: those pin LITERAL historical names ('lead_walkthrough_performers',
 * 'walkthrough_performers', 'walkthrough_assigned_to') and must stay byte-identical, because their
 * whole job is to catch a rename sweep that reached back into shipped migrations.
 */
const SQL = readFileSync(
  join(__dirname, '../../prisma/migrations/20260818140000_visit_crew_multi_visit_s3/migration.sql'),
  'utf8',
);

describe('visit crew migration (multi-visit S3)', () => {
  it('drops the NOT NULL on visit_assignees.lead_id, guarded on the state it changes', () => {
    // The blocker the whole slice turns on: a job visit has no lead, so a crew row on one fails at
    // INSERT against real Postgres while typechecking clean and passing every mocked test.
    expect(SQL).toContain('ALTER TABLE "visit_assignees" ALTER COLUMN "lead_id" DROP NOT NULL');
    expect(SQL).toContain("is_nullable = 'NO'");
  });

  it('does NOT drop the lead_id column', () => {
    // The spec's target shape has no lead_id, but seven select sites read Lead's visit_assignees
    // back-relation through it - two of them attachment OWNERSHIP checks. The drop is S8.
    expect(SQL).not.toMatch(/ALTER TABLE "visit_assignees"[\s\S]{0,80}DROP COLUMN/);
  });

  it('folds existing job crew onto the job FIRST visit only', () => {
    expect(SQL).toContain('INSERT INTO "visit_assignees"');
    // LATERAL ... LIMIT 1 is what stops one job-level assignee fanning out across every visit
    // S2's backfill created. Over-crewing a visit is not cosmetic under the union - it is read
    // access to that job for someone who was never on the trip.
    expect(SQL).toContain('JOIN LATERAL');
    expect(SQL).toContain('LIMIT 1');
  });

  it('is idempotent against the (visit_id, user_id) unique index', () => {
    // Without the NOT EXISTS a second application does not duplicate - it ABORTS on the
    // constraint and takes the rest of the file down with it.
    expect(SQL).toContain('WHERE NOT EXISTS');
    expect(SQL).toMatch(/va\."visit_id" = v\."id" AND va\."user_id" = ja\."user_id"/);
  });

  it('writes a NULL lead on every folded row', () => {
    // A job-parented visit with a lead_id set would violate the spirit of
    // visits_exactly_one_parent on the join table and surface the job under a lead's performers.
    expect(SQL).toMatch(/ja\."user_id", NULL, ja\."created_at"/);
  });

  it('rewrites no JSONB, and says why', () => {
    // role_permissions.conditions stores OWN_JOB as a literal JSON path per org. S3 does not
    // repoint it - job_assignees stays the union its readers read - so there is nothing for
    // check-role-permission-drift --strict to catch. Stating it is the point: this is the class
    // that has bitten the project three times.
    expect(SQL).not.toContain('UPDATE "role_permissions"');
    expect(SQL).toContain('NO JSONB REWRITE');
  });

  it('states the portability and idempotency promises the house idiom requires', () => {
    expect(SQL).toContain('Portable:');
    expect(SQL).toContain('Idempotent:');
    expect(SQL).toContain('postgres:16');
  });
});
