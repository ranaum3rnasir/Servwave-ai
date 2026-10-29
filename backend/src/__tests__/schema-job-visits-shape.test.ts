import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

/**
 * Multi-visit slice S2's migration, pinned by TEXT.
 *
 * BE HONEST ABOUT THE SEAM: this is a ratchet against accidental edits, not a behaviour driven
 * through a public interface. Prisma is fully mocked across the backend suite and no test in this
 * repo executes migration SQL, so a green run here is NOT evidence the migration works. The real
 * verification is manual and is reported alongside this slice: apply the whole ledger twice
 * against a scratch vanilla postgres:16, confirm the second run is a no-op, and confirm one
 * `visits` row per already-scheduled job.
 *
 * Mirrors the assertion style of schema-walkthrough-entity-shape.test.ts.
 */
const SQL = readFileSync(
  join(__dirname, '../../prisma/migrations/20260818120000_job_visits_multi_visit_s2/migration.sql'),
  'utf8',
);

describe('job visits migration (multi-visit S2)', () => {
  it('adds the job-shaped time columns idempotently', () => {
    expect(SQL).toContain('ADD COLUMN IF NOT EXISTS "scheduled_end"');
    expect(SQL).toContain('ADD COLUMN IF NOT EXISTS "is_all_day"');
  });

  it('backfills one WORK visit per already-scheduled job', () => {
    // Without this, every job already holding a time would show an EMPTY visit list beside a hero
    // reading a real one - D14's wrong-data window, made visible on the page rather than only on
    // the board.
    expect(SQL).toContain('INSERT INTO "visits"');
    expect(SQL).toContain("'WORK'");
    // Idempotent by the guard, not by luck: a second application must insert nothing.
    expect(SQL).toContain('NOT EXISTS (SELECT 1 FROM "visits" v WHERE v."job_id" = j."id")');
  });

  it('leaves the pre-S2 backfill of scheduled_end to LEAD rows, so a second run is the promised no-op', () => {
    // Step 2 fills in the end on rows that only ever stored a duration. Its IS NULL guard is not
    // enough on its own: step 3 inserts job visits in the same file, and `jobs.scheduled_end` is
    // very often null, so a second application of the whole file would match those fresh rows and
    // stamp an INVENTED 60-minute end on an open-ended job - which the next visit write then
    // mirrors back onto the job itself.
    const step2 = SQL.slice(SQL.indexOf('UPDATE "visits"'), SQL.indexOf('INSERT INTO "visits"'));
    expect(step2).toContain('"job_id" IS NULL');
  });

  it('gives every backfilled job visit BOTH representations of its span', () => {
    // The invariant createJobVisit and rescheduleVisitRow maintain: scheduled_end and
    // duration_minutes are written together from one span. A backfilled row holding neither
    // opens the reschedule dialog with end == start (the dialog seeds the end from
    // `scheduled_end ?? scheduled_at`), and saving it collapses the job to a 1-minute window.
    const insert = SQL.slice(SQL.indexOf('INSERT INTO "visits"'));
    expect(insert).toContain('"duration_minutes"');
    expect(SQL).toMatch(/COALESCE\(j\."scheduled_end", j\."scheduled_start" \+ interval '60 minutes'\)/);
  });

  it('says out loud what it does with a job that is UNSCHEDULED but holds a time', () => {
    // 133 such rows exist on staging, so the file's original claim that the WHERE made them
    // unreachable was simply false, and they were being mapped to a SCHEDULED visit by an ELSE
    // branch nobody had decided on. The mapping may well be right - it is the silence that is
    // not, since S4 derives job status FROM its visits.
    expect(SQL).toContain("WHEN 'UNSCHEDULED'");
    expect(SQL).not.toContain('UNSCHEDULED cannot reach here at all');
  });

  it('never destroys visit history', () => {
    // D19: rows are kept. The customer holds an email referencing "Visit 2", and deletion would
    // make the first-time-fix / callback data (SRVW-41) unrecoverable.
    expect(SQL).not.toMatch(/DELETE FROM "visits"/);
    expect(SQL).not.toMatch(/DROP COLUMN/);
  });
});
