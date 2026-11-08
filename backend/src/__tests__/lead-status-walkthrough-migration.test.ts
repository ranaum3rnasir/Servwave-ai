import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { LeadStatus } from '@prisma/client';

/**
 * Walkthrough lead statuses, slice 01 - the migration's shape and the generated client, in the
 * ordinary (no database) suite. The behaviour (enum_range order, sort order, re-run is a no-op)
 * is proven against real Postgres in lead-status-walkthrough-migration-db.test.ts.
 */
const MIGRATION = '20261006200000_lead_status_add_walkthrough_values';
const sql = readFileSync(join(__dirname, '../../prisma/migrations', MIGRATION, 'migration.sql'), 'utf8');
// Statements only: the header prose names things the SQL must not do.
const statements = sql
  .split('\n')
  .filter((line) => !line.trim().startsWith('--'))
  .map((l) => l.trim())
  .filter(Boolean);

describe('lead status walkthrough values migration', () => {
  it('does nothing but add the two values, in pipeline position before ESTIMATED, idempotently', () => {
    expect(statements).toEqual([
      `ALTER TYPE "LeadStatus" ADD VALUE IF NOT EXISTS 'WALKTHROUGH_SCHEDULED' BEFORE 'ESTIMATED';`,
      `ALTER TYPE "LeadStatus" ADD VALUE IF NOT EXISTS 'WALKTHROUGH_COMPLETED' BEFORE 'ESTIMATED';`,
    ]);
  });

  it('the generated client carries the two values in pipeline order', () => {
    expect(Object.values(LeadStatus)).toEqual([
      'NEW',
      'CONTACTED',
      'WALKTHROUGH_SCHEDULED',
      'WALKTHROUGH_COMPLETED',
      'ESTIMATED',
      'WON',
      'LOST',
      'CANCELLED',
    ]);
  });

  it('schema.prisma declares the enum in the same order as the migration leaves the database', () => {
    const schema = readFileSync(join(__dirname, '../../prisma/schema.prisma'), 'utf8');
    const body = /enum LeadStatus \{([^}]*)\}/.exec(schema)?.[1] ?? '';
    const values = body.split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('//'));
    expect(values).toEqual(Object.values(LeadStatus));
  });
});
