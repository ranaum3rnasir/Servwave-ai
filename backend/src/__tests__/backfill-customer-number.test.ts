/**
 * Tests for the customer_number backfill script.
 *
 * Strategy: mock prisma + allocateNumber, import the exported runBackfill
 * function, and verify:
 *   1. Only NULL-numbered rows are assigned (per org, ordered created_at ASC, id ASC)
 *   2. allocateNumber is called once per customer needing a number
 *   3. customer.update is called with the allocated number
 *   4. A second run is a no-op (idempotent — no NULL rows found)
 *   5. DRY_RUN=true logs but makes no writes
 *   6. Two orgs are handled independently, each in their own transaction
 *   7. Partial-numbered orgs: already-numbered customers are skipped
 *
 * The script discovers affected org IDs by querying customer rows with
 * customer_number IS NULL using distinct — no separate organization.findMany call.
 * The per-org findMany runs INSIDE the transaction on the tx client.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { Mock } from 'vitest';
import { prisma } from '../lib/prisma';
import { allocateNumber } from '../lib/numbering';

const mockAllocate = allocateNumber as unknown as Mock;
const mockPrisma = prisma as unknown as {
  customer: { findMany: Mock; update: Mock };
  $transaction: Mock;
};

// Helper to build a minimal customer fixture
function makeCustomer(
  id: string,
  orgId: string,
  createdAt: Date,
  customerNumber: string | null = null,
) {
  return {
    id,
    organization_id: orgId,
    customer_number: customerNumber,
    created_at: createdAt,
    first_name: 'Test',
    last_name: 'User',
  };
}

const ORG_A = '00000000-0000-0000-0000-000000000001';
const ORG_B = '00000000-0000-0000-0000-000000000002';

// Build a tx mock that proxies findMany/update — used by $transaction implementations
function makeTxMock(findManyResult: unknown[]) {
  return {
    customer: {
      findMany: vi.fn().mockResolvedValue(findManyResult),
      update: vi.fn().mockResolvedValue({}),
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  delete process.env.DRY_RUN;
});

async function importRunBackfill() {
  // Dynamic import so we get the already-mocked module
  const mod = await import('../scripts/backfill-customer-number.js');
  return mod.runBackfill;
}

describe('backfill-customer-number — runBackfill', () => {
  it('assigns numbers to NULL customers ordered created_at ASC, id ASC', async () => {
    const c1 = makeCustomer('aaa', ORG_A, new Date('2024-01-01'));
    const c2 = makeCustomer('bbb', ORG_A, new Date('2024-01-02'));

    // First call: distinct org IDs lookup (on prisma, outside tx)
    mockPrisma.customer.findMany.mockResolvedValueOnce([{ organization_id: ORG_A }]);

    const txMock = makeTxMock([c1, c2]);
    mockPrisma.$transaction.mockImplementation((fn: (tx: unknown) => unknown) => fn(txMock));

    mockAllocate.mockResolvedValueOnce('C00001').mockResolvedValueOnce('C00002');

    const runBackfill = await importRunBackfill();
    await runBackfill();

    // tx.customer.findMany should query for null-numbered customers in org A, ordered deterministically
    expect(txMock.customer.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ organization_id: ORG_A, customer_number: null }),
        orderBy: [{ created_at: 'asc' }, { id: 'asc' }],
      }),
    );

    expect(mockAllocate).toHaveBeenCalledTimes(2);
    expect(mockAllocate).toHaveBeenNthCalledWith(1, txMock, 'customer', ORG_A);
    expect(mockAllocate).toHaveBeenNthCalledWith(2, txMock, 'customer', ORG_A);

    expect(txMock.customer.update).toHaveBeenCalledTimes(2);
    expect(txMock.customer.update).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ where: { id: c1.id }, data: { customer_number: 'C00001' } }),
    );
    expect(txMock.customer.update).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ where: { id: c2.id }, data: { customer_number: 'C00002' } }),
    );
  });

  it('is idempotent — no NULL rows means no allocations or updates', async () => {
    // No customers with null numbers found at all
    mockPrisma.customer.findMany.mockResolvedValueOnce([]); // distinct orgs → empty

    const runBackfill = await importRunBackfill();
    await runBackfill();

    expect(mockAllocate).not.toHaveBeenCalled();
    expect(mockPrisma.customer.update).not.toHaveBeenCalled();
    expect(mockPrisma.$transaction).not.toHaveBeenCalled();
  });

  it('handles two orgs independently with separate transactions', async () => {
    const cA = makeCustomer('ccc', ORG_A, new Date('2024-01-01'));
    const cB = makeCustomer('ddd', ORG_B, new Date('2024-01-01'));

    // Distinct org IDs lookup
    mockPrisma.customer.findMany.mockResolvedValueOnce([
      { organization_id: ORG_A },
      { organization_id: ORG_B },
    ]);

    const txMockA = makeTxMock([cA]);
    const txMockB = makeTxMock([cB]);

    mockPrisma.$transaction
      .mockImplementationOnce((fn: (tx: unknown) => unknown) => fn(txMockA))
      .mockImplementationOnce((fn: (tx: unknown) => unknown) => fn(txMockB));

    mockAllocate
      .mockResolvedValueOnce('C00001')  // org A
      .mockResolvedValueOnce('C00001'); // org B (independent counter)

    const runBackfill = await importRunBackfill();
    await runBackfill();

    expect(mockPrisma.$transaction).toHaveBeenCalledTimes(2);
    expect(mockAllocate).toHaveBeenCalledTimes(2);
    expect(mockAllocate).toHaveBeenNthCalledWith(1, txMockA, 'customer', ORG_A);
    expect(mockAllocate).toHaveBeenNthCalledWith(2, txMockB, 'customer', ORG_B);
    expect(txMockA.customer.update).toHaveBeenCalledTimes(1);
    expect(txMockB.customer.update).toHaveBeenCalledTimes(1);
  });

  it('skips orgs where all customers are already numbered (idempotent per-org)', async () => {
    // Distinct query returns org A. But per-org null lookup inside tx returns empty.
    mockPrisma.customer.findMany.mockResolvedValueOnce([{ organization_id: ORG_A }]);

    const txMock = makeTxMock([]); // no null-numbered customers inside tx
    mockPrisma.$transaction.mockImplementation((fn: (tx: unknown) => unknown) => fn(txMock));

    const runBackfill = await importRunBackfill();
    await runBackfill();

    // Transaction was opened but no allocations or updates happened
    expect(mockPrisma.$transaction).toHaveBeenCalledTimes(1);
    expect(mockAllocate).not.toHaveBeenCalled();
    expect(txMock.customer.update).not.toHaveBeenCalled();
  });

  it('DRY_RUN=true logs but makes no writes', async () => {
    process.env.DRY_RUN = 'true';

    const c1 = makeCustomer('fff', ORG_A, new Date('2024-01-01'));
    mockPrisma.customer.findMany
      .mockResolvedValueOnce([{ organization_id: ORG_A }]) // distinct orgs
      .mockResolvedValueOnce([c1]);                        // null-numbered (dry-run path)

    const runBackfill = await importRunBackfill();
    await runBackfill();

    expect(mockAllocate).not.toHaveBeenCalled();
    expect(mockPrisma.customer.update).not.toHaveBeenCalled();
    expect(mockPrisma.$transaction).not.toHaveBeenCalled();

    delete process.env.DRY_RUN;
  });

  it('wraps each org in a $transaction', async () => {
    const c1 = makeCustomer('ggg', ORG_A, new Date('2024-01-01'));

    mockPrisma.customer.findMany.mockResolvedValueOnce([{ organization_id: ORG_A }]);

    const txMock = makeTxMock([c1]);
    mockPrisma.$transaction.mockImplementation((fn: (tx: unknown) => unknown) => fn(txMock));

    mockAllocate.mockResolvedValueOnce('C00001');

    const runBackfill = await importRunBackfill();
    await runBackfill();

    expect(mockPrisma.$transaction).toHaveBeenCalledTimes(1);
  });

  it('partial-numbered org: skips already-numbered customers, assigns only to null ones', async () => {
    // Customer A already has a number; customer B does not.
    // The distinct query found this org because it has at least one null row.
    // The tx.findMany (which filters customer_number: null) returns only B.
    const cB = makeCustomer('hhh', ORG_A, new Date('2024-01-02'), null);

    mockPrisma.customer.findMany.mockResolvedValueOnce([{ organization_id: ORG_A }]);

    // tx.findMany only returns the null-numbered customer (B); A is filtered out by the where clause
    const txMock = makeTxMock([cB]);
    mockPrisma.$transaction.mockImplementation((fn: (tx: unknown) => unknown) => fn(txMock));

    mockAllocate.mockResolvedValueOnce('C00002');

    const runBackfill = await importRunBackfill();
    await runBackfill();

    // allocateNumber called exactly once — only for customer B
    expect(mockAllocate).toHaveBeenCalledTimes(1);
    expect(mockAllocate).toHaveBeenCalledWith(txMock, 'customer', ORG_A);

    // update called only for customer B
    expect(txMock.customer.update).toHaveBeenCalledTimes(1);
    expect(txMock.customer.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: cB.id }, data: { customer_number: 'C00002' } }),
    );
  });
});
