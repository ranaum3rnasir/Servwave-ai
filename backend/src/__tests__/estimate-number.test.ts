import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { Mock } from 'vitest';
import request from 'supertest';
import app from '../app';
import { prisma } from '../lib/prisma';
import { mockAuthAs, authHeader, ESTIMATE_FIXTURE, ALPHA_ORG_ID } from './helpers';

// Editable Record IDs (SERV10X record-renumber) - estimate HTTP layer.
//
// record-renumber.ts is NOT globally mocked in setup.ts, so computeRenumber/applyRenumber run for
// real against the standard mocked prisma delegates below (same convention every other controller
// test in this repo uses) - this file is testing the controller/route layer (permission gate, 404,
// request->response shape, locking-before-write), not the engine's own cascade/conflict logic,
// which record-renumber.test.ts already covers directly.

const mockPrisma = prisma as unknown as {
  estimate: { findUnique: Mock; findFirst: Mock; update: Mock };
  estimateReservation: { findMany: Mock; updateMany: Mock };
  timelineEvent: { create: Mock };
  auditLog: { create: Mock };
  $transaction: Mock;
  $queryRaw: Mock;
  $executeRaw: Mock;
};

const ESTIMATE_ID = ESTIMATE_FIXTURE.id;

beforeEach(() => {
  vi.clearAllMocks();
});

/**
 * Wires prisma.estimate.findFirst the way computeRenumber's two internal calls (parent load, then
 * parent-conflict check) and applyRenumber's own follow-up (original_number read) all need: a plain
 * `{ id: parentId, organization_id }` lookup returns `parentRow`, while the conflict-check shape
 * (`id: { not: parentId }, ...`) returns `conflictRow` (default null - no conflict).
 */
function installEstimateFindFirst(parentRow: Record<string, unknown>, conflictRow: Record<string, unknown> | null = null) {
  (mockPrisma.estimate.findFirst as Mock).mockImplementation(
    async ({ where }: { where: { id?: unknown } }) => {
      const idClause = where.id as { not?: unknown } | string | undefined;
      if (idClause && typeof idClause === 'object' && 'not' in idClause) {
        return conflictRow;
      }
      return parentRow;
    },
  );
}

/** No anchored logistic orders, no estimate_reservations rows - the common empty-cascade case. */
function installEmptyCascades() {
  mockPrisma.$queryRaw.mockResolvedValue([]);
  mockPrisma.estimateReservation.findMany.mockResolvedValue([]);
  mockPrisma.estimateReservation.updateMany.mockResolvedValue({ count: 0 });
}

function installTransactionPassthrough() {
  mockPrisma.$transaction.mockImplementation((cb: (tx: typeof prisma) => unknown) => cb(prisma));
  mockPrisma.$executeRaw.mockResolvedValue(1);
}

describe('POST /api/estimates/:id/number/preview', () => {
  it('returns 403 for a role without the renumber/Estimate grant', async () => {
    mockAuthAs('sales');

    const res = await request(app)
      .post(`/api/estimates/${ESTIMATE_ID}/number/preview`)
      .set(authHeader('sales'))
      .send({ number: 'E00099' });

    expect(res.status).toBe(403);
  });

  it('returns 404 for a nonexistent estimate', async () => {
    mockAuthAs('admin');
    mockPrisma.estimate.findUnique.mockResolvedValue(null);

    const res = await request(app)
      .post(`/api/estimates/nonexistent-id/number/preview`)
      .set(authHeader('admin'))
      .send({ number: 'E00099' });

    expect(res.status).toBe(404);
  });

  it('returns 200 with the RenumberComputation shape and makes no writes', async () => {
    mockAuthAs('admin');
    mockPrisma.estimate.findUnique.mockResolvedValue({ id: ESTIMATE_ID });
    installEstimateFindFirst({ id: ESTIMATE_ID, estimate_number: 'E00001', organization_id: ALPHA_ORG_ID, original_number: null });
    installEmptyCascades();

    const res = await request(app)
      .post(`/api/estimates/${ESTIMATE_ID}/number/preview`)
      .set(authHeader('admin'))
      .send({ number: 'E00099' });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      entity: 'estimate',
      parentId: ESTIMATE_ID,
      oldNumber: 'E00001',
      newNumber: 'E00099',
      parentConflict: false,
      hasConflicts: false,
      derived: [],
      labelRefreshes: [],
    });
    expect(mockPrisma.estimate.update).not.toHaveBeenCalled();
    expect(mockPrisma.$transaction).not.toHaveBeenCalled();
  });
});

describe('PATCH /api/estimates/:id/number', () => {
  it('returns 403 for a role without the renumber/Estimate grant', async () => {
    mockAuthAs('sales');

    const res = await request(app)
      .patch(`/api/estimates/${ESTIMATE_ID}/number`)
      .set(authHeader('sales'))
      .send({ number: 'E00099' });

    expect(res.status).toBe(403);
  });

  it('returns 404 for a nonexistent estimate', async () => {
    mockAuthAs('admin');
    mockPrisma.estimate.findUnique.mockResolvedValue(null);

    const res = await request(app)
      .patch(`/api/estimates/nonexistent-id/number`)
      .set(authHeader('admin'))
      .send({ number: 'E00099' });

    expect(res.status).toBe(404);
    expect(mockPrisma.$transaction).not.toHaveBeenCalled();
  });

  it('returns 400 for an invalid number format (contains a slash)', async () => {
    mockAuthAs('admin');
    mockPrisma.estimate.findUnique.mockResolvedValue({ id: ESTIMATE_ID });
    installTransactionPassthrough();

    const res = await request(app)
      .patch(`/api/estimates/${ESTIMATE_ID}/number`)
      .set(authHeader('admin'))
      .send({ number: '123/456' });

    expect(res.status).toBe(400);
    expect(mockPrisma.estimate.update).not.toHaveBeenCalled();
    expect(mockPrisma.timelineEvent.create).not.toHaveBeenCalled();
  });

  it('returns 409 with conflict details when the new number is already taken, and writes nothing', async () => {
    mockAuthAs('admin');
    mockPrisma.estimate.findUnique.mockResolvedValue({ id: ESTIMATE_ID });
    installTransactionPassthrough();
    installEstimateFindFirst(
      { id: ESTIMATE_ID, estimate_number: 'E00001', organization_id: ALPHA_ORG_ID, original_number: null },
      { id: 'other-estimate-id', estimate_number: 'E00099', organization_id: ALPHA_ORG_ID },
    );
    installEmptyCascades();

    const res = await request(app)
      .patch(`/api/estimates/${ESTIMATE_ID}/number`)
      .set(authHeader('admin'))
      .send({ number: 'E00099' });

    expect(res.status).toBe(409);
    expect(res.body.computation).toMatchObject({
      hasConflicts: true,
      parentConflict: true,
      parentConflictWithId: 'other-estimate-id',
    });
    expect(mockPrisma.estimate.update).not.toHaveBeenCalled();
    expect(mockPrisma.timelineEvent.create).not.toHaveBeenCalled();
    expect(mockPrisma.auditLog.create).not.toHaveBeenCalled();
  });

  it('on a clean rename: locks the row, writes the new number, and records ONE timeline event + audit call', async () => {
    mockAuthAs('admin');
    mockPrisma.estimate.findUnique.mockResolvedValue({ id: ESTIMATE_ID });
    installTransactionPassthrough();
    installEstimateFindFirst({ id: ESTIMATE_ID, estimate_number: 'E00001', organization_id: ALPHA_ORG_ID, original_number: null });
    installEmptyCascades();
    mockPrisma.estimate.update.mockResolvedValue({ id: ESTIMATE_ID, estimate_number: 'E00099' });
    mockPrisma.timelineEvent.create.mockResolvedValue({});
    mockPrisma.auditLog.create.mockResolvedValue({});

    const res = await request(app)
      .patch(`/api/estimates/${ESTIMATE_ID}/number`)
      .set(authHeader('admin'))
      .send({ number: 'E00099' });

    expect(res.status).toBe(200);
    expect(res.body.old_number).toBe('E00001');
    expect(res.body.new_number).toBe('E00099');
    expect(res.body.derived).toEqual([]);
    expect(res.body.label_refreshes).toEqual([]);

    // The row was locked (FOR NO KEY UPDATE - matches allocateAnchoredNumber's own lock strength
    // on the estimates table) BEFORE the engine's read/write, all inside one transaction.
    expect(mockPrisma.$executeRaw).toHaveBeenCalledTimes(1);

    expect(mockPrisma.estimate.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: ESTIMATE_ID },
        data: expect.objectContaining({ estimate_number: 'E00099', number_is_custom: true, original_number: 'E00001' }),
      }),
    );

    expect(mockPrisma.timelineEvent.create).toHaveBeenCalledTimes(1);
    const timelineArgs = (mockPrisma.timelineEvent.create as Mock).mock.calls[0][0];
    expect(timelineArgs.data).toMatchObject({
      organization_id: ALPHA_ORG_ID,
      entity_type: 'ESTIMATE',
      entity_id: ESTIMATE_ID,
      event_type: 'ESTIMATE_RENUMBERED',
      metadata: { old_number: 'E00001', new_number: 'E00099', derived_count: 0 },
    });

    expect(mockPrisma.auditLog.create).toHaveBeenCalledTimes(1);
    const auditArgs = (mockPrisma.auditLog.create as Mock).mock.calls[0][0];
    expect(auditArgs.data).toMatchObject({
      action: 'estimate.renumbered',
      resource_type: 'Estimate',
      resource_id: ESTIMATE_ID,
      metadata: { old_number: 'E00001', new_number: 'E00099' },
    });
  });
});
