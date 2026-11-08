import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { DEFAULT_GRANTS } from '../lib/permissions/defaultGrants';
import { PERMISSION_CATALOG } from '../lib/permissions/catalog';

// Pins the Automation grant backfill (20260703164043) to defaultGrants.ts, the same way
// permissions-service-plan-backfill.test.ts pins 20260609120300. The canonical grant set is the
// code; the migration SQL must mirror it row-for-row so existing orgs' dispatchers get the new
// subject without redeploy-order surprises.
describe('automation grants backfill migration', () => {
  const MIGRATION = join(
    __dirname,
    '../../prisma/migrations/20260703164043_automation_center/migration.sql',
  );
  const sql = readFileSync(MIGRATION, 'utf8');

  it('inserts across every org (FROM organizations + CROSS JOIN VALUES)', () => {
    expect(sql).toMatch(/FROM organizations/i);
    expect(sql).toMatch(/CROSS JOIN \(VALUES/i);
  });

  it('uses the idempotent ON CONFLICT DO NOTHING guard', () => {
    expect(sql).toContain('ON CONFLICT (organization_id, role, action, subject) DO NOTHING');
  });

  it('contains a VALUES row for every non-admin Automation grant in defaultGrants', () => {
    // DEFAULT_GRANTS never contains ADMIN rows (admin = manage-all), so subject is the only filter.
    const expected = DEFAULT_GRANTS.filter((g) => g.subject === 'Automation');
    expect(expected.length).toBe(4); // DISPATCHER read/create/update/delete — org-level config
    for (const g of expected) {
      expect(g.role).toBe('DISPATCHER'); // SALES/TECHNICIAN must NOT manage automations
      expect(g.conditions).toBeUndefined(); // org-level, never own-scoped
      const row = `('${g.role}','${g.action}','${g.subject}',NULL)`;
      expect(sql, `missing migration row: ${row}`).toContain(row);
    }
  });

  it('registers Automation in the permission catalog for read/create/update/delete', () => {
    const entries = PERMISSION_CATALOG.filter((e) => e.subject === 'Automation');
    const actions = entries.map((e) => e.action).sort();
    expect(actions).toEqual(['create', 'delete', 'read', 'update']);
  });
});
