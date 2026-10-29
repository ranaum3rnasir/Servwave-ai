import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

// Pins the backfill + supersede + drop migration. Replaces the dynamic cross-check that lived in
// permissions-casl-backfill.test.ts (removed in TG3 because it pinned the now-superseded redesign_11
// shape). Verified 2026-06-10 against the live shared-staging role_permissions rows.
const SQL = readFileSync(
  join(__dirname, '../../prisma/migrations/20260610120100_assignment_backfill_supersede_drop/migration.sql'),
  'utf8',
);

describe('assignment backfill + supersede + drop migration', () => {
  it('backfills each join table from the legacy FK columns with a NOT EXISTS idempotency guard', () => {
    for (const [table, parent, fk] of [
      ['job_assignees', 'jobs', 'assigned_to'],
      ['lead_assignees', 'leads', 'assigned_to'],
      ['lead_walkthrough_performers', 'leads', 'walkthrough_assigned_to'],
    ] as const) {
      expect(SQL).toContain(`INSERT INTO ${table}`);
      // each backfill is guarded so a re-run inserts nothing
      expect(SQL).toMatch(new RegExp(`NOT EXISTS \\(SELECT 1 FROM ${table}\\b`));
      expect(SQL).toContain(`.${fk} IS NOT NULL`);
      void parent;
    }
  });

  it('backfills commission_owner_id from the old single lead owner (data continuity), guarded', () => {
    expect(SQL).toMatch(/UPDATE leads SET commission_owner_id = assigned_to\s+WHERE assigned_to IS NOT NULL AND commission_owner_id IS NULL/);
  });

  it('supersedes the bare assigned_to CASL condition SUBJECT-QUALIFIED (Lead→lead_assignees, Job→assignees)', () => {
    // The bare {"assigned_to":"{{userId}}"} value exists on both Lead and Job; without the subject
    // qualifier the first UPDATE would consume the other subject's rows (privilege-scope bug).
    expect(SQL).toMatch(/SET conditions = '\{"lead_assignees":\{"some":\{"user_id":"\{\{userId\}\}"\}\}\}'::jsonb\s+WHERE conditions = '\{"assigned_to":"\{\{userId\}\}"\}'::jsonb AND subject = 'Lead'/);
    expect(SQL).toMatch(/SET conditions = '\{"assignees":\{"some":\{"user_id":"\{\{userId\}\}"\}\}\}'::jsonb\s+WHERE conditions = '\{"assigned_to":"\{\{userId\}\}"\}'::jsonb AND subject = 'Job'/);
  });

  it('supersedes the nested invoice/estimate/walkthrough CASL shapes to the crew shape, idempotently', () => {
    expect(SQL).toContain('\'{"job":{"assignees":{"some":{"user_id":"{{userId}}"}}}}\'::jsonb');
    expect(SQL).toContain('WHERE conditions = \'{"job":{"assigned_to":"{{userId}}"}}\'::jsonb');
    expect(SQL).toContain('\'{"walkthrough_performers":{"some":{"user_id":"{{userId}}"}}}\'::jsonb');
    expect(SQL).toContain('WHERE conditions = \'{"walkthrough_assigned_to":"{{userId}}"}\'::jsonb');
    // every supersede is keyed on the OLD shape, so a re-run is a no-op (idempotent)
    expect(SQL).not.toMatch(/UPDATE role_permissions SET conditions[^;]*WHERE\s+1\s*=\s*1/i);
  });

  it('deletes the removed be_assigned/perform eligibility grant rows', () => {
    expect(SQL).toMatch(/DELETE FROM role_permissions WHERE action IN \('be_assigned','perform'\)/);
  });

  it('drops the four legacy FK columns with IF EXISTS (after the backfill)', () => {
    for (const col of [
      ['leads', 'assigned_to'],
      ['leads', 'walkthrough_assigned_to'],
      ['jobs', 'assigned_to'],
      ['jobs', 'walkthrough_assigned_to'],
    ] as const) {
      expect(SQL).toMatch(new RegExp(`ALTER TABLE "${col[0]}"\\s+DROP COLUMN IF EXISTS "${col[1]}"`));
    }
    // the drop must come AFTER the backfill inserts (order matters — backfill reads the columns)
    expect(SQL.indexOf('INSERT INTO job_assignees')).toBeLessThan(SQL.indexOf('DROP COLUMN IF EXISTS "assigned_to"'));
  });
});
