import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

/**
 * Per-visit automation enrollment (md_files/specs/scheduling/2026-09-14-per-visit-automation-enrollment.md),
 * criteria 1 and 2.
 *
 * Three cron sweeps emit one candidate PER VISIT and then throw the visit row away, so the
 * enrollment they create records only the parent. At execution time the loader re-derives "which
 * trip" from the parent - the earliest upcoming one - and on any job or lead with more than one
 * trip the customer is told about the wrong one. The column below is what lets the enrollment say
 * which trip it is about.
 *
 * Same assertion style as schema-workflow-enrollment-entity-index.test.ts: the migration SQL and
 * the Prisma model are read as text, because the thing being checked is that the two AGREE. A
 * schema field with no migration behind it produces a client that selects a column Postgres does
 * not have, and the failure lands on the deploy rather than here.
 */
const SQL = readFileSync(
  join(__dirname, '../../prisma/migrations/20260915140000_workflow_enrollment_visit_id/migration.sql'),
  'utf8',
);
const SCHEMA = readFileSync(join(__dirname, '../../prisma/schema.prisma'), 'utf8');

/**
 * The SQL with its `--` prose stripped.
 *
 * The header explains at length why there is no foreign key, no back-fill and no DROP, so a
 * negative assertion read against the raw file matches the explanation and reports the very thing
 * it was written to forbid. Statements are what run; comments are what a reader gets.
 */
const STATEMENTS = SQL.replace(/--[^\n]*/g, '');

const MODEL = SCHEMA.slice(
  SCHEMA.indexOf('model WorkflowEnrollment {'),
  SCHEMA.indexOf('@@map("workflow_enrollments")'),
);

describe('workflow_enrollments.visit_id migration', () => {
  it('adds a nullable uuid column, idempotently (criterion 1)', () => {
    expect(SQL).toContain('ALTER TABLE "workflow_enrollments" ADD COLUMN IF NOT EXISTS "visit_id" UUID');
    // NOT NULL would fail on the first existing row; a default would be a fabricated answer to
    // "which trip", which D10 refuses to guess at.
    expect(STATEMENTS).not.toMatch(/visit_id"?\s+UUID\s+NOT NULL/i);
    expect(STATEMENTS).not.toMatch(/visit_id"?\s+UUID[^;]*DEFAULT/i);
  });

  /**
   * D2: no foreign key, and each of the three referential actions is wrong in its own way.
   * Restrict makes deleting a visit fail for an invisible reason while any enrollment references
   * it; SetNull silently reverts the enrollment to per-entity resolution, which IS the defect;
   * Cascade deletes the enrollment and with it the dedupe guard, so re-creating a visit at the
   * same time re-fires a reminder already sent. With no FK, "the trip is gone" becomes a legible
   * terminal state (D4) instead of a silent fallback.
   */
  it('adds NO foreign key and NO index on the column (D2)', () => {
    expect(STATEMENTS).not.toMatch(/FOREIGN KEY\s*\(\s*"?visit_id"?\s*\)/i);
    expect(STATEMENTS).not.toMatch(/REFERENCES\s+"?visits"?/i);
    // Nothing looks an enrollment up BY visit - the column is read as a field of a row already
    // fetched by id - so an index here would be write cost for no read.
    expect(STATEMENTS).not.toMatch(/CREATE INDEX[^;]*visit_id/i);
  });

  it('is pure expand: it adds and never drops or rewrites (criterion 2)', () => {
    expect(STATEMENTS).not.toMatch(/\bDROP\b/i);
    expect(STATEMENTS).not.toMatch(/\bUPDATE\s+"?workflow_enrollments"?/i);
    // D10: no back-fill. A live enrollment created before this ships has no visit id and cannot
    // get one - inferring it from occurrence_key would be guessing at exactly the ambiguity that
    // causes the bug (two trips, one minute).
    expect(STATEMENTS).not.toMatch(/\bINSERT\b/i);
  });

  it('stays portable plain DDL - nothing Supabase-only, no RLS role grants', () => {
    expect(STATEMENTS).not.toMatch(/\bauth\./i);
    expect(STATEMENTS).not.toMatch(/TO\s+(authenticated|anon|service_role)\b/i);
    expect(STATEMENTS).not.toMatch(/CREATE\s+POLICY/i);
  });

  it('declares the same nullable uuid on the model, so schema and database agree', () => {
    expect(MODEL).toMatch(/visit_id\s+String\?\s+@db\.Uuid/);
    // A Prisma RELATION is what would generate the foreign key D2 refuses. `entity_id` one line
    // up is already a bare @db.Uuid with no relation, for the same polymorphic reason.
    expect(MODEL).not.toMatch(/visit\s+Visit\b/);
    expect(MODEL).not.toContain('@@index([visit_id])');
  });
});
