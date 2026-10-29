/**
 * lead-number.test.ts
 *
 * HTTP/controller-layer coverage for the Lead slice of Editable Record IDs:
 *   POST  /api/leads/:id/number/preview
 *   PATCH /api/leads/:id/number
 *
 * The rename ENGINE (RENUMBER_CONFIG, computeRenumber, applyRenumber, validateNumberFormat)
 * is unit-tested exhaustively in record-renumber.test.ts and is NOT re-tested here — this
 * file only exercises the permission gate, 404, request -> response shape, the parent-row
 * lock, and that the controller calls the real (unmocked — see setup.ts, which does not
 * `vi.mock('../lib/record-renumber')`) engine functions against the standard mocked prisma
 * delegates, the same way every other controller test in this repo does.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { Mock } from 'vitest';
import request from 'supertest';
import app from '../app';
import { prisma } from '../lib/prisma';
import { TEST_USERS, mockAuthAs, authHeader, LEAD_FIXTURE } from './helpers';
import { clearPermissionCache } from '../lib/permissions/permissionCache';

const ORG_ID = TEST_USERS.admin.organization_id;

// ─────────────────────────────────────────────────────────────────────────
// Tiny in-memory Prisma-delegate emulator — same technique record-renumber.test.ts
// uses for the engine's own unit tests, reproduced here (not imported — that file
// owns no exports) so this controller-layer suite can drive the REAL engine against
// realistic fixture rows instead of a canned per-test answer. Only wires the calls
// the `lead` entity's RENUMBER_CONFIG actually makes (no label targets on lead, so
// no label-target tables to install).
// ─────────────────────────────────────────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function matchesWhere(row: Row, where: Row): boolean {
  for (const [key, cond] of Object.entries(where)) {
    if (key === 'OR') {
      if (!(cond as Row[]).some((sub) => matchesWhere(row, sub))) return false;
      continue;
    }
    if (key === 'AND') {
      if (!(cond as Row[]).every((sub) => matchesWhere(row, sub))) return false;
      continue;
    }
    if (cond !== null && typeof cond === 'object' && !Array.isArray(cond)) {
      if ('equals' in cond) {
        const want = (cond as { equals: unknown; mode?: string }).equals;
        if ((cond as { mode?: string }).mode === 'insensitive') {
          if (String(row[key] ?? '').toLowerCase() !== String(want ?? '').toLowerCase()) return false;
        } else if (row[key] !== want) {
          return false;
        }
        continue;
      }
      if ('not' in cond) {
        if (row[key] === (cond as { not: unknown }).not) return false;
        continue;
      }
    }
    if (row[key] !== cond) return false;
  }
  return true;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function installTable(model: any, rows: Row[]): Row[] {
  const findFirst = model.findFirst as Mock | undefined;
  const findUnique = model.findUnique as Mock | undefined;
  const findMany = model.findMany as Mock | undefined;
  const update = model.update as Mock | undefined;

  if (findFirst) {
    findFirst.mockImplementation(async ({ where }: { where: Row }) => rows.find((r) => matchesWhere(r, where)) ?? null);
  }
  if (findUnique) {
    findUnique.mockImplementation(async ({ where }: { where: Row }) => rows.find((r) => matchesWhere(r, where)) ?? null);
  }
  if (findMany) {
    findMany.mockImplementation(async ({ where }: { where: Row }) => rows.filter((r) => matchesWhere(r, where)));
  }
  if (update) {
    update.mockImplementation(async ({ where, data }: { where: Row; data: Row }) => {
      const row = rows.find((r) => matchesWhere(r, where));
      if (!row) throw new Error(`mock update: no row matches ${JSON.stringify(where)}`);
      Object.assign(row, data);
      return { ...row };
    });
  }
  return rows;
}

/** Lead has no label targets and the anchored-LO cascade is exercised elsewhere
 * (record-renumber.test.ts) — every test here installs an empty LO result set. */
function installEmptyAnchoredLoQueryRaw(): void {
  (prisma.$queryRaw as Mock).mockResolvedValue([]);
}

function leadRow(overrides: Row = {}): Row {
  return {
    id: LEAD_FIXTURE.id,
    lead_number: 'L00001',
    organization_id: ORG_ID,
    original_number: null,
    ...overrides,
  };
}

beforeEach(() => {
  vi.resetAllMocks();
  clearPermissionCache();
  // No grant rows by default — a role reaching a handler without an explicit
  // rolePermission mock (or ADMIN's unconditional fast path) gets 403.
  (prisma.rolePermission.findMany as any).mockResolvedValue([]);
  // Rename opens `prisma.$transaction(async (tx) => ...)` — hand the SAME mocked
  // `prisma` object back as `tx`, mirroring leads.test.ts's own convention, so the
  // `installTable` wiring above (on the top-level mocked delegates) is what the
  // transaction body actually sees.
  (prisma.$transaction as any).mockImplementation((fn: (tx: unknown) => Promise<unknown>) => fn(prisma));
  (prisma.$executeRaw as any).mockResolvedValue(0);
  (prisma.timelineEvent.create as any).mockResolvedValue({});
  (prisma.auditLog.create as any).mockResolvedValue({});
  installTable(prisma.estimate, []);
  installTable(prisma.logisticOrder, []);
  installEmptyAnchoredLoQueryRaw();
});

// ═══════════════════════════════════════════════════════
// POST /api/leads/:id/number/preview
// ═══════════════════════════════════════════════════════

describe('POST /api/leads/:id/number/preview', () => {
  it('returns 403 for a role without the renumber Lead grant', async () => {
    mockAuthAs('sales');
    installTable(prisma.lead, [leadRow()]);

    const res = await request(app)
      .post(`/api/leads/${LEAD_FIXTURE.id}/number/preview`)
      .set(authHeader('sales'))
      .send({ number: 'L-NEW' });

    expect(res.status).toBe(403);
  });

  it('returns 404 for a nonexistent lead', async () => {
    mockAuthAs('admin');
    installTable(prisma.lead, []);

    const res = await request(app)
      .post(`/api/leads/does-not-exist/number/preview`)
      .set(authHeader('admin'))
      .send({ number: 'L-NEW' });

    expect(res.status).toBe(404);
  });

  it('returns the computation shape on a clean, no-conflict preview', async () => {
    mockAuthAs('admin');
    installTable(prisma.lead, [leadRow()]);

    const res = await request(app)
      .post(`/api/leads/${LEAD_FIXTURE.id}/number/preview`)
      .set(authHeader('admin'))
      .send({ number: 'L-NEW' });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      entity: 'lead',
      parentId: LEAD_FIXTURE.id,
      oldNumber: 'L00001',
      newNumber: 'L-NEW',
      parentConflict: false,
      hasConflicts: false,
      derived: [],
      labelRefreshes: [],
    });
    // Read-only — no write and no lock statement issued.
    expect(prisma.lead.update).not.toHaveBeenCalled();
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(prisma.$executeRaw).not.toHaveBeenCalled();
  });

  it('flags a conflict in the preview without writing anything', async () => {
    mockAuthAs('admin');
    installTable(prisma.lead, [leadRow(), leadRow({ id: 'other-lead', lead_number: 'L-TAKEN' })]);

    const res = await request(app)
      .post(`/api/leads/${LEAD_FIXTURE.id}/number/preview`)
      .set(authHeader('admin'))
      .send({ number: 'L-TAKEN' });

    expect(res.status).toBe(200);
    expect(res.body.parentConflict).toBe(true);
    expect(res.body.parentConflictWithId).toBe('other-lead');
    expect(res.body.hasConflicts).toBe(true);
    expect(prisma.lead.update).not.toHaveBeenCalled();
  });
});

// ═══════════════════════════════════════════════════════
// PATCH /api/leads/:id/number
// ═══════════════════════════════════════════════════════

describe('PATCH /api/leads/:id/number', () => {
  it('returns 403 for a role without the renumber Lead grant', async () => {
    mockAuthAs('sales');
    installTable(prisma.lead, [leadRow()]);

    const res = await request(app)
      .patch(`/api/leads/${LEAD_FIXTURE.id}/number`)
      .set(authHeader('sales'))
      .send({ number: 'L-NEW' });

    expect(res.status).toBe(403);
  });

  it('returns 404 for a nonexistent lead', async () => {
    mockAuthAs('admin');
    installTable(prisma.lead, []);

    const res = await request(app)
      .patch(`/api/leads/does-not-exist/number`)
      .set(authHeader('admin'))
      .send({ number: 'L-NEW' });

    expect(res.status).toBe(404);
  });

  it('returns 400 for an invalid number format (contains a slash)', async () => {
    mockAuthAs('admin');
    installTable(prisma.lead, [leadRow()]);

    const res = await request(app)
      .patch(`/api/leads/${LEAD_FIXTURE.id}/number`)
      .set(authHeader('admin'))
      .send({ number: 'L/NEW' });

    expect(res.status).toBe(400);
    // Rejected before any lock/transaction was opened.
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(prisma.lead.update).not.toHaveBeenCalled();
  });

  it('renames on a clean, no-conflict case: locks the row, writes the number, logs a timeline event and an audit entry', async () => {
    mockAuthAs('admin');
    const rows = installTable(prisma.lead, [leadRow()]);

    const res = await request(app)
      .patch(`/api/leads/${LEAD_FIXTURE.id}/number`)
      .set(authHeader('admin'))
      .send({ number: 'L-NEW' });

    expect(res.status).toBe(200);
    expect(res.body.old_number).toBe('L00001');
    expect(res.body.new_number).toBe('L-NEW');
    expect(res.body.derived).toEqual([]);
    expect(res.body.lead).toMatchObject({ id: LEAD_FIXTURE.id, lead_number: 'L-NEW' });

    // The actual write happened, inside the (mocked) transaction, and the row lock
    // statement was issued before it.
    expect(rows[0]).toMatchObject({ lead_number: 'L-NEW', number_is_custom: true, original_number: 'L00001' });
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(prisma.$executeRaw).toHaveBeenCalledTimes(1);
    const lockSql = (prisma.$executeRaw as Mock).mock.calls[0][0].join('');
    expect(lockSql).toMatch(/FROM leads/i);
    expect(lockSql).toMatch(/FOR NO KEY UPDATE/i);

    // Timeline event.
    expect(prisma.timelineEvent.create).toHaveBeenCalledTimes(1);
    const timelineArgs = (prisma.timelineEvent.create as Mock).mock.calls[0][0];
    expect(timelineArgs.data).toMatchObject({
      organization_id: ORG_ID,
      entity_type: 'LEAD',
      entity_id: LEAD_FIXTURE.id,
      event_type: 'LEAD_RENUMBERED',
      metadata: { old_number: 'L00001', new_number: 'L-NEW', derived_count: 0 },
    });

    // Audit trail.
    expect(prisma.auditLog.create).toHaveBeenCalledTimes(1);
    const auditArgs = (prisma.auditLog.create as Mock).mock.calls[0][0];
    expect(auditArgs.data).toMatchObject({
      action: 'lead.renumbered',
      resource_type: 'Lead',
      resource_id: LEAD_FIXTURE.id,
      metadata: { old_number: 'L00001', new_number: 'L-NEW' },
    });
  });

  it('returns 409 on a conflicting number and writes nothing', async () => {
    mockAuthAs('admin');
    const rows = installTable(prisma.lead, [leadRow(), leadRow({ id: 'other-lead', lead_number: 'L-TAKEN' })]);

    const res = await request(app)
      .patch(`/api/leads/${LEAD_FIXTURE.id}/number`)
      .set(authHeader('admin'))
      .send({ number: 'L-TAKEN' });

    expect(res.status).toBe(409);
    expect(rows[0].lead_number).toBe('L00001');
    expect(prisma.timelineEvent.create).not.toHaveBeenCalled();
    expect(prisma.auditLog.create).not.toHaveBeenCalled();
  });
});
