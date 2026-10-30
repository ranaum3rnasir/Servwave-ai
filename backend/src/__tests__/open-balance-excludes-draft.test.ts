/**
 * Slice 35 (from slice 14): an open-balance sum counts only invoices that can still be paid.
 * A DRAFT invoice has not been sent and a VOIDED one is dead, yet both keep their full
 * amount_due, so a total that includes them overstates what is owed. These cover the three
 * deposit totals that still included DRAFT: the customer record (summary + detail) and the
 * estimate list / stats pending-deposit cards.
 * Prisma is mocked by setup.ts, so what is asserted is the question put to the database.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import type { Mock } from 'vitest';
import request from 'supertest';
import app from '../app';
import { prisma } from '../lib/prisma';
import { mockAuthAs, authHeader, CUSTOMER_FIXTURE } from './helpers';
import { clearTokenCache } from '../middleware/authenticate';

const mockPrisma = prisma as unknown as {
  $queryRaw: Mock;
  estimate: Record<string, Mock>;
  invoice: Record<string, Mock>;
};

describe('customer deposits_pending', () => {
  beforeEach(() => {
    clearTokenCache();
    mockAuthAs('admin');
    (prisma.organization.findUnique as Mock).mockResolvedValue({ timezone: 'America/New_York' });
    (prisma.customer.findUnique as Mock).mockResolvedValue(CUSTOMER_FIXTURE);
    (prisma.note.findMany as Mock).mockResolvedValue([]);
    (prisma.invoice.findMany as Mock).mockResolvedValue([]);
    (prisma.lead.count as Mock).mockResolvedValue(0);
    (prisma.task.count as Mock).mockResolvedValue(0);
    (prisma.tagAssignment.findMany as Mock).mockResolvedValue([]);
    mockPrisma.$queryRaw
      .mockResolvedValueOnce([{ lifetime_revenue: '0', total_invoiced: '0', past_due_balance: '0', due_balance: '0', unpaid_invoice_count: '0', paid_invoice_count: '0' }])
      .mockResolvedValueOnce([{ total: '0', pending: '0', approved: '0', total_value: '0' }])
      .mockResolvedValueOnce([{ deposits_collected: '0', deposits_pending: '0' }]);
  });

  const depositSql = () => {
    const call = mockPrisma.$queryRaw.mock.calls.find((c) => (c[0] as string[]).join('').includes('deposits_pending'));
    return (call![0] as string[]).join('');
  };

  for (const path of ['summary', '']) {
    it(`GET /api/customers/:id/${path} sums only payable deposits, never a DRAFT`, async () => {
      const res = await request(app).get(`/api/customers/${CUSTOMER_FIXTURE.id}/${path}`).set(authHeader('admin'));
      expect(res.status).toBe(200);
      const sql = depositSql();
      expect(sql).not.toContain('DRAFT');
      expect(sql).toContain("'SENT'");
      expect(sql).toContain("'PARTIAL'");
    });
  }
});

describe('estimate pending-deposit cards', () => {
  beforeEach(() => {
    clearTokenCache();
    mockAuthAs('admin');
    mockPrisma.estimate.groupBy?.mockResolvedValue([]);
    mockPrisma.estimate.findMany.mockResolvedValue([]);
    mockPrisma.estimate.count.mockResolvedValue(0);
    mockPrisma.estimate.aggregate.mockResolvedValue({ _count: 0, _sum: { total_amount: 0 } });
    mockPrisma.invoice.aggregate.mockResolvedValue({ _count: 0, _sum: { amount_due: 0 } });
  });

  const depositWhere = () => {
    const call = mockPrisma.invoice.aggregate.mock.calls.map((c) => c[0]).find((a) => a.where.kind === 'DEPOSIT');
    return call.where;
  };

  it('GET /api/estimates totals only SENT and PARTIAL deposits', async () => {
    await request(app).get('/api/estimates').set(authHeader('admin'));
    expect(depositWhere().status).toEqual({ in: ['SENT', 'PARTIAL'] });
  });

  it('GET /api/estimates/stats totals only SENT and PARTIAL deposits', async () => {
    await request(app).get('/api/estimates/stats').set(authHeader('admin'));
    expect(depositWhere().status).toEqual({ in: ['SENT', 'PARTIAL'] });
  });
});
