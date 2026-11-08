import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { Mock } from 'vitest';
import request from 'supertest';
import app from '../app';
import { prisma } from '../lib/prisma';
import { mockAuthAs, authHeader, INVOICE_FIXTURE, ALPHA_ORG_ID } from './helpers';

// Editable Record IDs (SERV10X record-renumber) — invoice HTTP layer.
//
// record-renumber.ts is NOT globally mocked in setup.ts, so computeRenumber/applyRenumber run for
// real against the standard mocked prisma delegates below (same convention every other controller
// test in this repo uses, and the same convention estimate-number.test.ts already established for
// its own entity) — this file is testing the controller/route layer (permission gate, 404, the
// invoice-only precondition, request→response shape, locking-before-write), not the engine's own
// cascade/conflict logic, which record-renumber.test.ts already covers directly.

const mockPrisma = prisma as unknown as {
  invoice: { findUnique: Mock; findFirst: Mock; update: Mock };
  timelineEvent: { create: Mock };
  auditLog: { create: Mock };
  $transaction: Mock;
  $queryRaw: Mock;
  $executeRaw: Mock;
};

const INVOICE_ID = INVOICE_FIXTURE.id;

beforeEach(() => {
  vi.clearAllMocks();
});

/**
 * Wires prisma.invoice.findFirst the way computeRenumber's two internal calls (parent load, then
 * parent-conflict check) and applyRenumber's own follow-up (original_number read) all need: a plain
 * `{ id: parentId, organization_id }` lookup returns `parentRow`, while the conflict-check shape
 * (`id: { not: parentId }, ...`) returns `conflictRow` (default null — no conflict).
 */
function installInvoiceFindFirst(parentRow: Record<string, unknown>, conflictRow: Record<string, unknown> | null = null) {
  (mockPrisma.invoice.findFirst as Mock).mockImplementation(
    async ({ where }: { where: { id?: unknown } }) => {
      const idClause = where.id as { not?: unknown } | string | undefined;
      if (idClause && typeof idClause === 'object' && 'not' in idClause) {
        return conflictRow;
      }
      return parentRow;
    },
  );
}

/** No anchored logistic orders — the common empty-cascade case (invoice has no label targets). */
function installEmptyCascades() {
  mockPrisma.$queryRaw.mockResolvedValue([]);
}

function installTransactionPassthrough() {
  mockPrisma.$transaction.mockImplementation((cb: (tx: typeof prisma) => unknown) => cb(prisma));
  mockPrisma.$executeRaw.mockResolvedValue(1);
}

/** Row shape the invoice-only rename precondition (isInvoiceRenumberLocked) reads. Unsent, with
 * no payment rows by default — i.e. NOT locked, so most tests exercise the happy path unless
 * overridden. */
function buildLockPreconditionRow(overrides: Record<string, unknown> = {}) {
  return {
    id: INVOICE_ID,
    sent_at: null,
    payments: [],
    ...overrides,
  };
}

describe('POST /api/invoices/:id/number/preview', () => {
  it('returns 403 for a role without the renumber/Invoice grant', async () => {
    mockAuthAs('sales');

    const res = await request(app)
      .post(`/api/invoices/${INVOICE_ID}/number/preview`)
      .set(authHeader('sales'))
      .send({ number: 'I00099' });

    expect(res.status).toBe(403);
  });

  it('returns 404 for a nonexistent invoice', async () => {
    mockAuthAs('admin');
    mockPrisma.invoice.findUnique.mockResolvedValue(null);

    const res = await request(app)
      .post(`/api/invoices/nonexistent-id/number/preview`)
      .set(authHeader('admin'))
      .send({ number: 'I00099' });

    expect(res.status).toBe(404);
  });

  it('returns 400 for an invoice that has been sent (isInvoiceRenumberLocked)', async () => {
    mockAuthAs('admin');
    mockPrisma.invoice.findUnique.mockResolvedValue(
      buildLockPreconditionRow({ sent_at: new Date('2026-02-02') }),
    );

    const res = await request(app)
      .post(`/api/invoices/${INVOICE_ID}/number/preview`)
      .set(authHeader('admin'))
      .send({ number: 'I00099' });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe(
      'This invoice has been sent or has a payment on it and can no longer have its number edited',
    );
  });

  it('returns 200 with the RenumberComputation shape and makes no writes', async () => {
    mockAuthAs('admin');
    mockPrisma.invoice.findUnique.mockResolvedValue(buildLockPreconditionRow());
    installInvoiceFindFirst({ id: INVOICE_ID, invoice_number: 'I00001', organization_id: ALPHA_ORG_ID, original_number: null });
    installEmptyCascades();

    const res = await request(app)
      .post(`/api/invoices/${INVOICE_ID}/number/preview`)
      .set(authHeader('admin'))
      .send({ number: 'I00099' });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      entity: 'invoice',
      parentId: INVOICE_ID,
      oldNumber: 'I00001',
      newNumber: 'I00099',
      parentConflict: false,
      hasConflicts: false,
      derived: [],
      labelRefreshes: [],
    });
    expect(mockPrisma.invoice.update).not.toHaveBeenCalled();
    expect(mockPrisma.$transaction).not.toHaveBeenCalled();
  });
});

describe('PATCH /api/invoices/:id/number', () => {
  it('returns 403 for a role without the renumber/Invoice grant', async () => {
    mockAuthAs('sales');

    const res = await request(app)
      .patch(`/api/invoices/${INVOICE_ID}/number`)
      .set(authHeader('sales'))
      .send({ number: 'I00099' });

    expect(res.status).toBe(403);
  });

  it('returns 404 for a nonexistent invoice', async () => {
    mockAuthAs('admin');
    mockPrisma.invoice.findUnique.mockResolvedValue(null);

    const res = await request(app)
      .patch(`/api/invoices/nonexistent-id/number`)
      .set(authHeader('admin'))
      .send({ number: 'I00099' });

    expect(res.status).toBe(404);
    expect(mockPrisma.$transaction).not.toHaveBeenCalled();
  });

  it('returns 400 for an invoice that has been sent, and 200 for one that is neither sent nor paid', async () => {
    mockAuthAs('admin');
    mockPrisma.invoice.findUnique.mockResolvedValue(
      buildLockPreconditionRow({ sent_at: new Date('2026-02-02') }),
    );

    const res = await request(app)
      .patch(`/api/invoices/${INVOICE_ID}/number`)
      .set(authHeader('admin'))
      .send({ number: 'I00099' });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe(
      'This invoice has been sent or has a payment on it and can no longer have its number edited',
    );
    expect(mockPrisma.$transaction).not.toHaveBeenCalled();
  });

  it('returns 400 for an invoice that has a payment on it', async () => {
    mockAuthAs('admin');
    mockPrisma.invoice.findUnique.mockResolvedValue(
      buildLockPreconditionRow({ payments: [{ voided_at: null }] }),
    );

    const res = await request(app)
      .patch(`/api/invoices/${INVOICE_ID}/number`)
      .set(authHeader('admin'))
      .send({ number: 'I00099' });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe(
      'This invoice has been sent or has a payment on it and can no longer have its number edited',
    );
    expect(mockPrisma.$transaction).not.toHaveBeenCalled();
  });

  // I00118 on staging is the live shape of this: VOIDED, never sent, no payment rows, and
  // amount_due zeroed by the void. The residual arithmetic the predicate used to run read that
  // zero as "the whole total was collected" and refused the rename.
  it('renames a voided invoice that was never sent and has no payments', async () => {
    mockAuthAs('admin');
    mockPrisma.invoice.findUnique.mockResolvedValue(buildLockPreconditionRow());
    installTransactionPassthrough();
    installInvoiceFindFirst({ id: INVOICE_ID, invoice_number: 'I00008', organization_id: ALPHA_ORG_ID, original_number: null });
    installEmptyCascades();
    mockPrisma.invoice.update.mockResolvedValue({ id: INVOICE_ID, invoice_number: 'WZ-INV-8' });
    mockPrisma.timelineEvent.create.mockResolvedValue({});
    mockPrisma.auditLog.create.mockResolvedValue({});

    const res = await request(app)
      .patch(`/api/invoices/${INVOICE_ID}/number`)
      .set(authHeader('admin'))
      .send({ number: 'WZ-INV-8' });

    expect(res.status).toBe(200);
    expect(res.body.new_number).toBe('WZ-INV-8');
  });

  it('returns 400 for an invalid number format (contains a slash)', async () => {
    mockAuthAs('admin');
    mockPrisma.invoice.findUnique.mockResolvedValue(buildLockPreconditionRow());
    installTransactionPassthrough();

    const res = await request(app)
      .patch(`/api/invoices/${INVOICE_ID}/number`)
      .set(authHeader('admin'))
      .send({ number: '123/456' });

    expect(res.status).toBe(400);
    expect(mockPrisma.invoice.update).not.toHaveBeenCalled();
    expect(mockPrisma.timelineEvent.create).not.toHaveBeenCalled();
  });

  it('returns 409 with conflict details when the new number is already taken, and writes nothing', async () => {
    mockAuthAs('admin');
    mockPrisma.invoice.findUnique.mockResolvedValue(buildLockPreconditionRow());
    installTransactionPassthrough();
    installInvoiceFindFirst(
      { id: INVOICE_ID, invoice_number: 'I00001', organization_id: ALPHA_ORG_ID, original_number: null },
      { id: 'other-invoice-id', invoice_number: 'I00099', organization_id: ALPHA_ORG_ID },
    );
    installEmptyCascades();

    const res = await request(app)
      .patch(`/api/invoices/${INVOICE_ID}/number`)
      .set(authHeader('admin'))
      .send({ number: 'I00099' });

    expect(res.status).toBe(409);
    expect(res.body.computation).toMatchObject({
      hasConflicts: true,
      parentConflict: true,
      parentConflictWithId: 'other-invoice-id',
    });
    expect(mockPrisma.invoice.update).not.toHaveBeenCalled();
    expect(mockPrisma.timelineEvent.create).not.toHaveBeenCalled();
    expect(mockPrisma.auditLog.create).not.toHaveBeenCalled();
  });

  it('on a clean rename: locks the row, writes the new number, and records ONE timeline event + audit call', async () => {
    mockAuthAs('admin');
    mockPrisma.invoice.findUnique.mockResolvedValue(buildLockPreconditionRow());
    installTransactionPassthrough();
    installInvoiceFindFirst({ id: INVOICE_ID, invoice_number: 'I00001', organization_id: ALPHA_ORG_ID, original_number: null });
    installEmptyCascades();
    mockPrisma.invoice.update.mockResolvedValue({ id: INVOICE_ID, invoice_number: 'I00099' });
    mockPrisma.timelineEvent.create.mockResolvedValue({});
    mockPrisma.auditLog.create.mockResolvedValue({});

    const res = await request(app)
      .patch(`/api/invoices/${INVOICE_ID}/number`)
      .set(authHeader('admin'))
      .send({ number: 'I00099' });

    expect(res.status).toBe(200);
    expect(res.body.old_number).toBe('I00001');
    expect(res.body.new_number).toBe('I00099');
    expect(res.body.derived).toEqual([]);
    expect(res.body.label_refreshes).toEqual([]);

    // The row was locked (FOR NO KEY UPDATE — matches allocateAnchoredNumber's own lock strength
    // on the invoices table, since invoice is a LogisticOrder ANCHOR) BEFORE the engine's
    // read/write, all inside one transaction.
    expect(mockPrisma.$executeRaw).toHaveBeenCalledTimes(1);

    expect(mockPrisma.invoice.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: INVOICE_ID },
        data: expect.objectContaining({ invoice_number: 'I00099', number_is_custom: true, original_number: 'I00001' }),
      }),
    );

    expect(mockPrisma.timelineEvent.create).toHaveBeenCalledTimes(1);
    const timelineArgs = (mockPrisma.timelineEvent.create as Mock).mock.calls[0][0];
    expect(timelineArgs.data).toMatchObject({
      organization_id: ALPHA_ORG_ID,
      entity_type: 'INVOICE',
      entity_id: INVOICE_ID,
      event_type: 'INVOICE_RENUMBERED',
      metadata: { old_number: 'I00001', new_number: 'I00099', derived_count: 0 },
    });

    expect(mockPrisma.auditLog.create).toHaveBeenCalledTimes(1);
    const auditArgs = (mockPrisma.auditLog.create as Mock).mock.calls[0][0];
    expect(auditArgs.data).toMatchObject({
      action: 'invoice.renumbered',
      resource_type: 'Invoice',
      resource_id: INVOICE_ID,
      metadata: { old_number: 'I00001', new_number: 'I00099' },
    });
  });
});
