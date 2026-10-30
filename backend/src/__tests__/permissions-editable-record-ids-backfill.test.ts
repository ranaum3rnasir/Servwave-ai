/**
 * Editable record IDs - DISPATCHER `renumber` role default + backfill (plan decision #7,
 * md_files/plans/numbering/2026-08-19-editable-record-ids.md).
 *
 * This PR only adds the permission plumbing for a NOT-YET-BUILT capability (the PATCH
 * .../:id/number endpoints ship in a later PR): a new 'renumber' action on Customer/Lead/
 * Estimate/Job/Invoice, on by default for ADMIN (automatic, via the manage-all bypass - no row
 * needed) and DISPATCHER (an explicit DEFAULT_GRANTS entry per subject).
 *
 * Pins the backfill migration to defaultGrants.ts the same way
 * permissions-technician-pricebook-backfill.test.ts pins 20260717120000: the canonical grant set
 * is the code; the SQL must mirror it row-for-row so existing orgs' dispatchers get the toggle
 * too, not just new orgs.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import request from 'supertest';
import app from '../app';
import { prisma } from '../lib/prisma';
import { DEFAULT_GRANTS } from '../lib/permissions/defaultGrants';
import { mockAuthAs, authHeader } from './helpers';
import { clearPermissionCache } from '../lib/permissions/permissionCache';

describe('editable-record-ids DISPATCHER renumber backfill migration', () => {
  const MIGRATION = join(
    __dirname,
    '../../prisma/migrations/20260819230000_editable_record_ids_dispatcher_backfill/migration.sql',
  );
  const sql = readFileSync(MIGRATION, 'utf8');

  it('inserts across every org (FROM organizations + CROSS JOIN VALUES)', () => {
    expect(sql).toMatch(/FROM organizations/i);
    expect(sql).toMatch(/CROSS JOIN \(VALUES/i);
  });

  it('uses the idempotent ON CONFLICT DO NOTHING guard', () => {
    expect(sql).toContain('ON CONFLICT (organization_id, role, action, subject) DO NOTHING');
  });

  it('mirrors defaultGrants: exactly 5 DISPATCHER renumber grants, one per subject, unconditional', () => {
    const expected = DEFAULT_GRANTS.filter((g) => g.role === 'DISPATCHER' && g.action === 'renumber');
    expect(expected).toEqual([
      { role: 'DISPATCHER', action: 'renumber', subject: 'Customer' },
      { role: 'DISPATCHER', action: 'renumber', subject: 'Lead' },
      { role: 'DISPATCHER', action: 'renumber', subject: 'Estimate' },
      { role: 'DISPATCHER', action: 'renumber', subject: 'Job' },
      { role: 'DISPATCHER', action: 'renumber', subject: 'Invoice' },
    ]);
    for (const g of expected) {
      const row = `('${g.role}','${g.action}','${g.subject}',NULL)`;
      expect(sql, `missing migration row: ${row}`).toContain(row);
    }
  });

  it('grants ONLY DISPATCHER - no SALES/TECHNICIAN/ADMIN renumber rows sneak in', () => {
    for (const role of ['SALES', 'TECHNICIAN', 'ADMIN']) {
      expect(sql).not.toContain(`('${role}','renumber',`);
    }
  });
});
