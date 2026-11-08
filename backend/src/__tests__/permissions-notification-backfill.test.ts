import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { DEFAULT_GRANTS } from '../lib/permissions/defaultGrants';

// Pins the Notification grant backfill (20260618000100) to defaultGrants.ts, the same way
// permissions-service-plan-backfill.test.ts pins 20260609120300. The canonical grant set is the
// code; the migration SQL must mirror it row-for-row so existing orgs' non-admin users get
// own-row inbox access on the new Notification subject.
describe('notification grants backfill migration', () => {
  const MIGRATION = join(
    __dirname,
    '../../prisma/migrations/20260618000100_backfill_notification_grants/migration.sql',
  );
  const sql = readFileSync(MIGRATION, 'utf8');

  it('inserts across every org (FROM organizations + CROSS JOIN VALUES)', () => {
    expect(sql).toMatch(/FROM organizations/i);
    expect(sql).toMatch(/CROSS JOIN \(VALUES/i);
  });

  it('uses the idempotent ON CONFLICT DO NOTHING guard', () => {
    expect(sql).toContain('ON CONFLICT (organization_id, role, action, subject) DO NOTHING');
  });

  it('contains a VALUES row for every non-admin Notification grant, as this migration wrote it', () => {
    // role/action/subject are still live off DEFAULT_GRANTS (unchanged since this migration) —
    // only the enumeration of WHICH grants exist. The condition JSON is frozen to what THIS
    // migration actually inserted on 2026-06-18, not read from DEFAULT_GRANTS.conditions: a
    // migration is a historical artifact, and #925 corrected the live OWN_NOTIFICATION shape
    // to a different value. Pinning against the live constant made this test fail on every
    // legitimate future change to that constant, for a subject the migration has no opinion on
    // anymore. See 20260722010000_repair_notification_grant_conditions for the row-level backfill of
    // existing persisted data to the corrected shape.
    const HISTORICAL_CONDITION = '{"recipient_id":"{{userId}}"}';
    const expected = DEFAULT_GRANTS.filter((g) => g.subject === 'Notification');
    expect(expected.length).toBe(9); // SALES/DISPATCHER/TECHNICIAN × read/update/delete
    for (const g of expected) {
      const row = `('${g.role}','${g.action}','${g.subject}','${HISTORICAL_CONDITION}')`;
      expect(sql, `missing migration row: ${row}`).toContain(row);
    }
  });
});
