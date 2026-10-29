import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { DEFAULT_GRANTS } from '../lib/permissions/defaultGrants';

// Pins the ServicePlan grant backfill (20260609120300) to defaultGrants.ts, the same way
// permissions-emanuel-modules.test.ts pins 20260602000000. The canonical grant set is the code;
// the migration SQL must mirror it row-for-row so existing orgs' dispatchers get the new subject.
describe('service-plan grants backfill migration', () => {
  const MIGRATION = join(
    __dirname,
    '../../prisma/migrations/20260609120300_backfill_service_plan_grants/migration.sql',
  );
  const sql = readFileSync(MIGRATION, 'utf8');

  it('inserts across every org (FROM organizations + CROSS JOIN VALUES)', () => {
    expect(sql).toMatch(/FROM organizations/i);
    expect(sql).toMatch(/CROSS JOIN \(VALUES/i);
  });

  it('uses the idempotent ON CONFLICT DO NOTHING guard', () => {
    expect(sql).toContain('ON CONFLICT (organization_id, role, action, subject) DO NOTHING');
  });

  it('contains a VALUES row for every non-admin ServicePlan grant in defaultGrants', () => {
    // DEFAULT_GRANTS never contains ADMIN rows (admin = manage-all), so subject is the only filter.
    const expected = DEFAULT_GRANTS.filter((g) => g.subject === 'ServicePlan');
    expect(expected.length).toBe(4); // DISPATCHER read/create/update/delete
    for (const g of expected) {
      const row = `('${g.role}','${g.action}','${g.subject}',NULL)`;
      expect(sql, `missing migration row: ${row}`).toContain(row);
    }
  });
});
