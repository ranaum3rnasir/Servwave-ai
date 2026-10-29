import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { Mock } from 'vitest';
import request from 'supertest';
import app from '../app';
import { prisma } from '../lib/prisma';
import { TEST_USERS, ALPHA_ORG_ID, mockAuthAs, authHeader, CUSTOMER_FIXTURE } from './helpers';

/**
 * HTTP/controller-layer coverage for the customer preview + rename endpoints
 * (editable record IDs). The rename engine itself (cascades, conflict detection,
 * original_number/number_is_custom semantics) is covered exhaustively in
 * record-renumber.test.ts — this file only exercises: the permission gate, 404,
 * request→response shape, the controller's own parent-row lock, and that a
 * conflict/invalid-format thrown by the engine maps to the right HTTP status.
 *
 * record-renumber.ts is NOT globally mocked in setup.ts (confirmed), so these
 * tests call the real engine functions against the house-mocked prisma delegate,
 * same as record-renumber.test.ts itself.
 */

const CUSTOMER_ID = CUSTOMER_FIXTURE.id;

/** A customer row carrying the editable-record-id columns CUSTOMER_FIXTURE (a
 * general-purpose fixture used by many other suites) doesn't itself declare. */
function buildCustomerRow(overrides: Record<string, unknown> = {}) {
  return {
    ...CUSTOMER_FIXTURE,
    organization_id: ALPHA_ORG_ID,
    customer_number: 'C00042',
    number_is_custom: false,
    original_number: null as string | null,
    ...overrides,
  };
}

/**
 * Wires prisma.customer.findFirst to answer the two `where` shapes the controller +
 * computeRenumber/applyRenumber issue against the customer delegate:
 *   - plain `{ id, organization_id }` → parent lookup (controller's pre-transaction
 *     404 check, computeRenumber's parent load, applyRenumber's original_number read).
 *   - `{ id: { not }, customer_number: { equals, mode: 'insensitive' } }` → the parent
 *     conflict check. `conflictRow`, when supplied, answers that shape.
 */
function installCustomerFindFirst(row: Record<string, unknown>, conflictRow?: Record<string, unknown>) {
  (prisma.customer.findFirst as Mock).mockImplementation(
    async ({ where }: { where: { id?: unknown; customer_number?: { equals: unknown } } }) => {
      if (where.id && typeof where.id === 'object' && 'not' in (where.id as object)) {
        if (!conflictRow) return null;
        const wanted = String(where.customer_number?.equals ?? '').toLowerCase();
        const actual = String((conflictRow as { customer_number: string }).customer_number).toLowerCase();
        return wanted === actual ? conflictRow : null;
      }
      return where.id === row.id ? row : null;
    },
  );
}

/** Wires prisma.customer.update to mutate `row` in place, mirroring applyRenumber's write
 * (and letting the test assert on the SAME object afterward — no separate call-args bookkeeping). */
function installCustomerUpdate(row: Record<string, unknown>) {
  (prisma.customer.update as Mock).mockImplementation(
    async ({ where, data }: { where: { id: unknown }; data: Record<string, unknown> }) => {
      if (where.id !== row.id) {
        throw new Error(`mock customer.update: no row matches ${JSON.stringify(where)}`);
      }
      Object.assign(row, data);
      return { ...row };
    },
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  mockAuthAs('admin');
  // Customer has no container-estimate matches and no anchored logistic orders in any of
  // these fixtures — the cascade logic itself is record-renumber.test.ts's job, not this
  // file's. (Customer's labelTargets is [] in RENUMBER_CONFIG, so no delegate is touched
  // for label refreshes at all — nothing to default here.)
  (prisma.estimate.findMany as Mock).mockResolvedValue([]);
  (prisma.$queryRaw as Mock).mockResolvedValue([]);
  // House convention (assign-notify-options.test.ts, automation-wiring.test.ts, et al.):
  // hand the SAME mocked prisma object back as `tx` so every delegate call inside the
  // transaction callback resolves against the exact mocks this file installs.
  (prisma.$transaction as Mock).mockImplementation((fn: (tx: unknown) => unknown) => fn(prisma));
});

describe('POST /api/customers/:id/number/preview', () => {
  it('403s a role without the renumber/Customer grant', async () => {
    mockAuthAs('sales');
    installCustomerFindFirst(buildCustomerRow({ id: CUSTOMER_ID }));

    const res = await request(app)
      .post(`/api/customers/${CUSTOMER_ID}/number/preview`)
      .set(authHeader('sales'))
      .send({ number: 'C00099' });

    expect(res.status).toBe(403);
  });

  it('404s a nonexistent customer id', async () => {
    installCustomerFindFirst(buildCustomerRow({ id: CUSTOMER_ID }));

    const res = await request(app)
      .post('/api/customers/does-not-exist/number/preview')
      .set(authHeader('admin'))
      .send({ number: 'C00099' });

    expect(res.status).toBe(404);
  });

  it('returns the RenumberComputation shape with no conflicts, and writes nothing', async () => {
    installCustomerFindFirst(buildCustomerRow({ id: CUSTOMER_ID, customer_number: 'C00042' }));

    const res = await request(app)
      .post(`/api/customers/${CUSTOMER_ID}/number/preview`)
      .set(authHeader('admin'))
      .send({ number: 'C00099' });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      entity: 'customer',
      parentId: CUSTOMER_ID,
      oldNumber: 'C00042',
      newNumber: 'C00099',
      parentConflict: false,
      hasConflicts: false,
      derived: [],
      labelRefreshes: [],
    });
    expect(prisma.customer.update as Mock).not.toHaveBeenCalled();
  });

  it('surfaces a conflict in the body as a normal 200 (advisory only)', async () => {
    const row = buildCustomerRow({ id: CUSTOMER_ID, customer_number: 'C00042' });
    const conflictRow = buildCustomerRow({ id: 'other-customer', customer_number: 'C00099' });
    installCustomerFindFirst(row, conflictRow);

    const res = await request(app)
      .post(`/api/customers/${CUSTOMER_ID}/number/preview`)
      .set(authHeader('admin'))
      .send({ number: 'C00099' });

    expect(res.status).toBe(200);
    expect(res.body.hasConflicts).toBe(true);
    expect(res.body.parentConflictWithId).toBe('other-customer');
  });

  it('400s an invalid number format (contains a slash)', async () => {
    installCustomerFindFirst(buildCustomerRow({ id: CUSTOMER_ID }));

    const res = await request(app)
      .post(`/api/customers/${CUSTOMER_ID}/number/preview`)
      .set(authHeader('admin'))
      .send({ number: '123/456' });

    expect(res.status).toBe(400);
  });
});

describe('PATCH /api/customers/:id/number', () => {
  it('403s a role without the renumber/Customer grant', async () => {
    mockAuthAs('sales');
    installCustomerFindFirst(buildCustomerRow({ id: CUSTOMER_ID }));

    const res = await request(app)
      .patch(`/api/customers/${CUSTOMER_ID}/number`)
      .set(authHeader('sales'))
      .send({ number: 'C00099' });

    expect(res.status).toBe(403);
  });

  it('404s a nonexistent customer id', async () => {
    installCustomerFindFirst(buildCustomerRow({ id: CUSTOMER_ID }));

    const res = await request(app)
      .patch('/api/customers/does-not-exist/number')
      .set(authHeader('admin'))
      .send({ number: 'C00099' });

    expect(res.status).toBe(404);
  });

  it('renames cleanly: writes the row, a timeline event, an audit row, and returns old/new + derived list', async () => {
    const row = buildCustomerRow({ id: CUSTOMER_ID, customer_number: 'C00042' });
    installCustomerFindFirst(row);
    installCustomerUpdate(row);

    const res = await request(app)
      .patch(`/api/customers/${CUSTOMER_ID}/number`)
      .set(authHeader('admin'))
      .send({ number: 'C00099' });

    expect(res.status).toBe(200);
    expect(res.body.old_number).toBe('C00042');
    expect(res.body.new_number).toBe('C00099');
    expect(res.body.derived).toEqual([]);
    expect(res.body.label_refreshes).toEqual([]);
    expect(res.body.customer).toMatchObject({
      customer_number: 'C00099',
      number_is_custom: true,
      original_number: 'C00042',
    });

    // The row the mocked delegate actually holds was written, not just echoed back.
    expect(row.customer_number).toBe('C00099');
    expect(row.number_is_custom).toBe(true);
    expect(row.original_number).toBe('C00042');

    expect(prisma.timelineEvent.create as Mock).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          organization_id: ALPHA_ORG_ID,
          entity_type: 'CUSTOMER',
          entity_id: CUSTOMER_ID,
          event_type: 'CUSTOMER_RENUMBERED',
          metadata: expect.objectContaining({ old_number: 'C00042', new_number: 'C00099', derived_count: 0 }),
          created_by: TEST_USERS.admin.id,
        }),
      }),
    );

    expect(prisma.auditLog.create as Mock).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          action: 'customer.renumbered',
          resource_type: 'Customer',
          resource_id: CUSTOMER_ID,
        }),
      }),
    );
  });

  it('409s on a conflicting number, writes nothing, and reports the conflict', async () => {
    const row = buildCustomerRow({ id: CUSTOMER_ID, customer_number: 'C00042' });
    const conflictRow = buildCustomerRow({ id: 'other-customer', customer_number: 'C00099' });
    installCustomerFindFirst(row, conflictRow);
    installCustomerUpdate(row);

    const res = await request(app)
      .patch(`/api/customers/${CUSTOMER_ID}/number`)
      .set(authHeader('admin'))
      .send({ number: 'C00099' });

    expect(res.status).toBe(409);
    expect(res.body.hasConflicts).toBe(true);
    expect(res.body.parentConflictWithId).toBe('other-customer');
    expect(row.customer_number).toBe('C00042'); // unchanged
    expect(prisma.customer.update as Mock).not.toHaveBeenCalled();
    expect(prisma.timelineEvent.create as Mock).not.toHaveBeenCalled();
  });

  it('400s an invalid number format (contains a slash) and writes nothing', async () => {
    const row = buildCustomerRow({ id: CUSTOMER_ID, customer_number: 'C00042' });
    installCustomerFindFirst(row);
    installCustomerUpdate(row);

    const res = await request(app)
      .patch(`/api/customers/${CUSTOMER_ID}/number`)
      .set(authHeader('admin'))
      .send({ number: '123/456' });

    expect(res.status).toBe(400);
    expect(row.customer_number).toBe('C00042'); // unchanged
    expect(prisma.customer.update as Mock).not.toHaveBeenCalled();
    expect(prisma.timelineEvent.create as Mock).not.toHaveBeenCalled();
  });
});
