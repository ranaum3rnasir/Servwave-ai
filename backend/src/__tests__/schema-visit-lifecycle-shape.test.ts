import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

/**
 * Multi-visit slice S4's migration, pinned by TEXT.
 *
 * BE HONEST ABOUT THE SEAM: this is a ratchet against accidental edits, not a behaviour driven
 * through a public interface. Prisma is fully mocked across the backend suite and no test in this
 * repo executes migration SQL, so a green run here is NOT evidence the migration works. The real
 * verification is manual: apply the whole ledger twice against a scratch vanilla postgres:16 and
 * confirm the second run is a no-op.
 *
 * A NEW SIBLING, deliberately, rather than an edit to schema-visit-crew-shape.test.ts or any of
 * the other 26 files that pin a dated migration directory. Those pin LITERAL historical names and
 * must stay byte-identical: their whole job is to catch a rename sweep that reached back into
 * shipped migrations.
 */
const SQL = readFileSync(
  join(__dirname, '../../prisma/migrations/20260819120000_visit_lifecycle_multi_visit_s4/migration.sql'),
  'utf8',
);

/**
 * The ONE SQL statement that starts with `marker`, from that marker to its terminating semicolon.
 *
 * Every assertion about the sub-status collision fix has to be scoped this way: the election
 * predicate appears in both the repoint and the delete, so a file-wide substring match cannot tell
 * which of the two carries it.
 */
function statementContaining(marker: string): string {
  const start = SQL.indexOf(marker);
  expect(start).toBeGreaterThan(-1);
  const end = SQL.indexOf(';', start);
  expect(end).toBeGreaterThan(start);
  return SQL.slice(start, end + 1);
}

/** The whole `DO $$ ... END $$;` block that contains `marker`. */
function doBlockContaining(marker: string): string {
  const at = SQL.indexOf(marker);
  expect(at).toBeGreaterThan(-1);
  const start = SQL.lastIndexOf('DO $$', at);
  const end = SQL.indexOf('END $$;', at);
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  return SQL.slice(start, end + 'END $$;'.length);
}

describe('visit lifecycle migration (multi-visit S4)', () => {
  it('adds the three milestone stamps to visits, idempotently', () => {
    // D7: en_route_at / on_site_at / started_at move to the visit. completed_at was already there.
    expect(SQL).toContain('ALTER TABLE "visits" ADD COLUMN IF NOT EXISTS "en_route_at" TIMESTAMP(3)');
    expect(SQL).toContain('ALTER TABLE "visits" ADD COLUMN IF NOT EXISTS "on_site_at" TIMESTAMP(3)');
    expect(SQL).toContain('ALTER TABLE "visits" ADD COLUMN IF NOT EXISTS "started_at" TIMESTAMP(3)');
  });

  it('backfills the job-level stamps onto the LOWEST visit_seq row, guarded on NULL', () => {
    // Those three job columns described the single trip that existed before S2 minted the visit
    // rows, so visit 1 is the row they belong to; the NULL guard is what makes a re-run a no-op.
    expect(SQL).toContain('AND v."en_route_at" IS NULL');
    expect(SQL).toContain('AND v."on_site_at" IS NULL');
    expect(SQL).toContain('AND v."started_at" IS NULL');
    // ...and never onto a trip that was called off. The lowest visit_seq row can perfectly well be
    // a CANCELLED one (start visit 1, cancel it, rebook as visit 2 - staging holds 263 cancelled
    // job visits today), and stamping a dead row writes a start time onto a trip nobody made,
    // where it stays as that job's per-visit history for ever. Both halves of the predicate have
    // to exclude it, or the MIN picks a row the row-filter then refuses and the stamp is silently
    // dropped instead.
    for (const statement of ['en_route_at', 'on_site_at', 'started_at'].map((c) => statementContaining(`UPDATE "visits" v\nSET "${c}"`))) {
      expect(statement).toContain(`AND v2."status" <> 'CANCELLED'`);
      expect(statement).toContain(`AND v."status" <> 'CANCELLED'`);
    }
  });

  it('moves the rows before it moves the type (D12)', () => {
    expect(SQL).toContain(`UPDATE "jobs" SET "status" = 'IN_PROGRESS' WHERE "status" IN ('EN_ROUTE', 'ON_SITE')`);
  });

  it('re-parents job_sub_statuses and resolves the unique collision first', () => {
    // JobSubStatus.parent is a USAGE of JobStatus with @@unique([organization_id, parent, label]),
    // so re-parenting onto IN_PROGRESS can collide with an existing row in the same org. Repoint,
    // delete, then re-parent - in that order.
    expect(SQL).toContain('FROM "job_sub_statuses" doomed');
    expect(SQL).toContain('DELETE FROM "job_sub_statuses" doomed');
    expect(SQL).toContain(`UPDATE "job_sub_statuses" SET "parent" = 'IN_PROGRESS' WHERE "parent" IN ('EN_ROUTE', 'ON_SITE')`);
  });

  it('elects one survivor across BOTH retired parents, not just against an existing IN_PROGRESS row', () => {
    // The collision a doomed-vs-survivor-only rewrite MISSES: an org holding the same label under
    // EN_ROUTE and under ON_SITE, with no IN_PROGRESS row at all. Neither doomed row has a
    // survivor to be repointed at or deleted against, so both fall through to the final re-parent
    // and collide WITH EACH OTHER on (organization_id, 'IN_PROGRESS', label) - aborting the
    // migration on a live database while passing on an empty one, which is exactly the failure
    // mode this block was written to prevent.
    //
    // The fix elects one survivor per (organization_id, label) across the union of the rows that
    // will END UP at IN_PROGRESS - the row already there wins, otherwise the lowest-id retired row
    // - and keys both the repoint and the delete on that election.
    //
    // Asserted INSIDE each statement rather than against the whole file. Both strings occur twice
    // - once in (a)'s LATERAL and once in (b)'s subquery - so a file-wide `toContain` stays green
    // when only (b) is reverted to the pre-fix `s."parent" = 'IN_PROGRESS'`, which is precisely
    // the half that leaves two doomed rows alive to collide in (c).
    for (const statement of [statementContaining('UPDATE "jobs" j'), statementContaining('DELETE FROM "job_sub_statuses" doomed')]) {
      expect(statement).toContain(`s."parent" IN ('EN_ROUTE', 'ON_SITE', 'IN_PROGRESS')`);
      expect(statement).toContain(`ORDER BY (s."parent" = 'IN_PROGRESS') DESC, s."id"`);
    }
  });

  it('swaps the enum for BOTH columns that use it, because Postgres cannot drop a label', () => {
    expect(SQL).toContain(`CREATE TYPE "JobStatus_new" AS ENUM`);
    expect(SQL).toContain(`('UNSCHEDULED', 'SCHEDULED', 'IN_PROGRESS', 'COMPLETED', 'CANCELLED')`);
    expect(SQL).toContain('ALTER TABLE "jobs" ALTER COLUMN "status" TYPE "JobStatus_new" USING "status"::text::"JobStatus_new"');
    // Missing this second column leaves the old type undroppable and the schema disagreeing.
    expect(SQL).toContain('ALTER TABLE "job_sub_statuses" ALTER COLUMN "parent" TYPE "JobStatus_new" USING "parent"::text::"JobStatus_new"');
    expect(SQL).toContain('DROP TYPE "JobStatus"');
    expect(SQL).toContain('ALTER TYPE "JobStatus_new" RENAME TO "JobStatus"');
  });

  it('makes every step of the enum swap self-closing, so a second application is a no-op', () => {
    // The idempotency contract at the top of the file, on the one step that could not honour it.
    // `IF NOT EXISTS (typname = 'JobStatus_new')` closes only until the rename at the end of the
    // step renames that type to 'JobStatus' - after which a second application finds the guard TRUE
    // again, re-creates the temp type, and rewrites `jobs` (9,507 rows on staging, more in prod)
    // plus `jobs_status_idx` under ACCESS EXCLUSIVE. Worse, the moment any later migration adds a
    // second dependent on the enum, pass two reaches `DROP TYPE "JobStatus"` with that dependency
    // still attached and aborts - leaving `jobs.status` typed `JobStatus_new`, a name Prisma does
    // not know.
    //
    // Each block is therefore guarded on state that the FIRST application actually consumes: the
    // retired label for the create, the temp type's existence for the two column moves.
    expect(doBlockContaining('CREATE TYPE "JobStatus_new"')).toContain(`e.enumlabel = 'ON_SITE'`);
    for (const table of ['jobs', 'job_sub_statuses']) {
      const block = doBlockContaining(`ALTER TABLE "${table}" ALTER COLUMN`);
      expect(block).toContain(`typname = 'JobStatus_new'`);
    }
  });

  it('rebuilds a saved status array rather than string-replacing it', () => {
    // Two retired values map onto ONE surviving value, so a REPLACE would duplicate a token in an
    // array that already held IN_PROGRESS. The S0 precedent's REPLACE is rejected in the file for
    // exactly that reason.
    expect(SQL).toContain('jsonb_array_elements_text');
    expect(SQL).toContain('jsonb_agg(DISTINCT mapped)');
    expect(SQL).not.toContain(`REPLACE("config"::text, '"EN_ROUTE"'`);
  });

  it('states the standing portability and idempotency contract', () => {
    expect(SQL).toContain('Portable: no Supabase-only roles, no auth.*');
    expect(SQL).toContain('Idempotent: every step is guarded on the state it is about to change');
  });
});
