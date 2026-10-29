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

// Drives the REAL PUT handler (not a re-derived expression - see the "THE ACTUAL GATE" warning in
// catalog.ts) to confirm MANAGED_KEYS picks up the 5 new (renumber, subject) keys automatically
// from buildFullGrantSet()/viewModelToGrants, with no manual edit to MANAGED_KEYS itself.
describe('PUT /api/roles/:role/permissions - editRecordIds round-trips through the real gate', () => {
  const upsert = vi.fn();
  const deleteMany = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    clearPermissionCache();
    upsert.mockResolvedValue({});
    deleteMany.mockResolvedValue({ count: 0 });
    (prisma.rolePermission.findMany as unknown as ReturnType<typeof vi.fn>).mockResolvedValue([]);
    (prisma.$transaction as unknown as ReturnType<typeof vi.fn>).mockImplementation((fn: (tx: unknown) => unknown) =>
      fn({ rolePermission: { deleteMany, upsert } }),
    );
    mockAuthAs('admin');
  });

  const persisted = () =>
    upsert.mock.calls.map((c) => ({ action: c[0].create.action as string, subject: c[0].create.subject as string }));

  it('editRecordIds:true persists exactly the 5 renumber grants', async () => {
    const res = await request(app)
      .put('/api/roles/DISPATCHER/permissions')
      .set(authHeader('admin'))
      .send({
        matrix: {},
        sensitive: { seeFinancials: false, managePayments: false, viewReports: false, editRecordIds: true, assignOthers: false },
        toggles: {},
        scope: {},
        general: { description: '' },
      });

    expect(res.status).toBe(200);
    const renumberGrants = persisted().filter((g) => g.action === 'renumber').map((g) => g.subject).sort();
    expect(renumberGrants).toEqual(['Customer', 'Estimate', 'Invoice', 'Job', 'Lead']);
  });

  it('editRecordIds:false persists none of the renumber grants', async () => {
    const res = await request(app)
      .put('/api/roles/DISPATCHER/permissions')
      .set(authHeader('admin'))
      .send({
        matrix: {},
        sensitive: { seeFinancials: false, managePayments: false, viewReports: false, editRecordIds: false, assignOthers: false },
        toggles: {},
        scope: {},
        general: { description: '' },
      });

    expect(res.status).toBe(200);
    expect(persisted().filter((g) => g.action === 'renumber')).toEqual([]);
  });

  it('a pre-existing renumber grant is DELETED when a Save turns editRecordIds off (MANAGED_KEYS covers it)', async () => {
    (prisma.rolePermission.findMany as unknown as ReturnType<typeof vi.fn>).mockResolvedValue([
      { action: 'renumber', subject: 'Job', conditions: null },
    ]);

    const res = await request(app)
      .put('/api/roles/DISPATCHER/permissions')
      .set(authHeader('admin'))
      .send({
        matrix: {},
        sensitive: { seeFinancials: false, managePayments: false, viewReports: false, editRecordIds: false, assignOthers: false },
        toggles: {},
        scope: {},
        general: { description: '' },
      });

    expect(res.status).toBe(200);
    expect(deleteMany).toHaveBeenCalled();
    const deletedOr = deleteMany.mock.calls[0][0].where.OR as { action: string; subject: string }[];
    expect(deletedOr).toContainEqual({ action: 'renumber', subject: 'Job' });
  });
});
