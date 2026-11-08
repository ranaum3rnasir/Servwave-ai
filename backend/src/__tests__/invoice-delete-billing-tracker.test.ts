import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';
import app from '../app';
import { prisma } from '../lib/prisma';
import {
  TEST_USERS,
  mockAuthAs,
  authHeader,
} from './helpers';

// ─── Typed mocks ──────────────────────────────────────

const mockPrisma = prisma as unknown as {
  invoice: {
    findUnique: ReturnType<typeof vi.fn>;
    delete: ReturnType<typeof vi.fn>;
  };
  invoiceLineItem: {
    findMany: ReturnType<typeof vi.fn>;
  };
  job: {
    update: ReturnType<typeof vi.fn>;
  };
  $transaction: ReturnType<typeof vi.fn>;
};

beforeEach(() => {
  vi.clearAllMocks();
  // Set up $transaction to execute the callback with the mocked tx object
  mockPrisma.$transaction.mockImplementation(async (callback) => {
    return callback(mockPrisma);
  });
});

describe('DELETE /api/invoices/:id — billing tracker', () => {
  beforeEach(() => {
    // The Inventory P1 stock-return path reads this unconditionally inside the transaction;
    // without a default the handler throws on `undefined.length` and every test 500s silently.
    mockPrisma.invoiceLineItem.findMany.mockResolvedValue([]);
  });

  it('decrements the job amount_invoiced by the deleted draft total', async () => {
    mockAuthAs('admin');
    mockPrisma.invoice.findUnique.mockResolvedValue({
      id: 'inv-1', status: 'DRAFT', invoice_number: 'I00031',
      job_id: 'job-1', kind: 'STANDARD', total_amount: 2300, job: { assignees: [] },
    });

    const res = await request(app).delete('/api/invoices/inv-1').set(authHeader('admin'));

    expect(res.status).toBe(204);
    expect(mockPrisma.job.update).toHaveBeenCalledWith({
      where: { id: 'job-1' },
      data: { amount_invoiced: { decrement: 2300 } },
    });
  });

  it('leaves the tracker alone for a DEPOSIT invoice', async () => {
    // kind=DEPOSIT never incremented it (create() is STANDARD-only), so decrementing would drive
    // the job's billed total negative. Mirrors voidInvoice's kind check.
    mockAuthAs('admin');
    mockPrisma.invoice.findUnique.mockResolvedValue({
      id: 'inv-2', status: 'DRAFT', invoice_number: 'I00032',
      job_id: 'job-1', kind: 'DEPOSIT', total_amount: 1000, job: { assignees: [] },
    });

    await request(app).delete('/api/invoices/inv-2').set(authHeader('admin'));

    expect(mockPrisma.job.update).not.toHaveBeenCalled();
  });

  it('leaves the tracker alone for a standalone invoice with no job', async () => {
    mockAuthAs('admin');
    mockPrisma.invoice.findUnique.mockResolvedValue({
      id: 'inv-3', status: 'DRAFT', invoice_number: 'I00033',
      job_id: null, kind: 'STANDARD', total_amount: 500, job: null,
    });

    await request(app).delete('/api/invoices/inv-3').set(authHeader('admin'));

    expect(mockPrisma.job.update).not.toHaveBeenCalled();
  });
});
