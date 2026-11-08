import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { DEFAULT_GRANTS } from '../lib/permissions/defaultGrants';

// Pins the Task grant backfill (20260618000000) to defaultGrants.ts, the same way
// permissions-service-plan-backfill.test.ts pins 20260609120300. The canonical grant set is the
// code; the migration SQL must mirror it row-for-row so existing orgs' non-admin users get access
// to the new Task subject.
describe('task grants backfill migration', () => {
  const MIGRATION = join(
    __dirname,
    '../../prisma/migrations/20260618000000_task_grants_backfill/migration.sql',
  );
  const sql = readFileSync(MIGRATION, 'utf8');

  it('inserts across every org (FROM organizations + CROSS JOIN VALUES)', () => {
    expect(sql).toMatch(/FROM organizations/i);
    expect(sql).toMatch(/CROSS JOIN \(VALUES/i);
  });

  it('uses the idempotent ON CONFLICT DO NOTHING guard', () => {
    expect(sql).toContain('ON CONFLICT (organization_id, role, action, subject) DO NOTHING');
  });

  it('contains a VALUES row for every non-admin Task grant in defaultGrants', () => {
    // DEFAULT_GRANTS never contains ADMIN rows (admin = manage-all), so subject is the only filter.
    const expected = DEFAULT_GRANTS.filter((g) => g.subject === 'Task');
    // SALES: read/create/update/delete (4)
    // DISPATCHER: read/create/update/delete (4)
    // TECHNICIAN: read/create/update (3, no delete by design)
    expect(expected.length).toBe(11);
    for (const g of expected) {
      const row = `('${g.role}','${g.action}','${g.subject}',NULL)`;
      expect(sql, `missing migration row: ${row}`).toContain(row);
    }
  });

  it('does NOT include a delete:Task row for TECHNICIAN', () => {
    expect(sql).not.toContain("('TECHNICIAN','delete','Task',NULL)");
  });
});
