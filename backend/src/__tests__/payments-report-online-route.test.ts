// Payments go-live slice 35 - GET /api/reports/payments marks a customer-paid (webhook-written) payment as Online.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import app from '../app';
import { prisma } from '../lib/prisma';
import { mockAuthAs, authHeader } from './helpers';

const mockPrisma = prisma as unknown as { payment: { findMany: ReturnType<typeof vi.fn> } };

const row = (over: Record<string, unknown>) => ({
  id: 'p1', amount: 100, method: 'ACH', paid_at: new Date('2026-10-01T12:00:00Z'), refunded_at: null, refunded_amount: null,
  voided_at: null, reference_number: null, tip_amount: null, wallet: null, card_brand: null, card_last4: null,
  bank_name: 'Test Bank', bank_last4: '6789', created_by_source: 'CLIENT',
  invoice: { kind: 'STANDARD', customer: { email: 'a@b.test', company_name: null, first_name: 'Ann', last_name: 'Lee' } },
  collector: null, ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  mockAuthAs('admin');
});

describe('GET /api/reports/payments', () => {
  it('reads an online bank payment as Online with no technician, and a keyed one as Keyed with its collector', async () => {
    mockPrisma.payment.findMany.mockResolvedValue([
      row({ id: 'online' }),
      row({ id: 'keyed', method: 'CASH', created_by_source: 'USER', collector: { first_name: 'Tess', last_name: 'Tech' } }),
    ]);
    const res = await request(app).get('/api/reports/payments').set(authHeader('admin'));
    expect(res.status).toBe(200);
    const byId = new Map((res.body.payments as Array<{ id: string; txnKind: string; technician: string }>).map((p) => [p.id, p]));
    expect(byId.get('online')).toMatchObject({ txnKind: 'Online', technician: '' });
    expect(byId.get('keyed')).toMatchObject({ txnKind: 'Keyed', technician: 'Tess Tech' });
  });

  it('reads a payment lost to a dispute as Charged back and any other void as Voided (slice 33b)', async () => {
    mockPrisma.payment.findMany.mockResolvedValue([
      row({ id: 'cb', voided_at: new Date('2026-10-02T12:00:00Z'), void_category: 'CHARGEBACK' }),
      row({ id: 'bounced', voided_at: new Date('2026-10-02T12:00:00Z'), void_category: 'BOUNCED' }),
    ]);
    const res = await request(app).get('/api/reports/payments').set(authHeader('admin'));
    const byId = new Map((res.body.payments as Array<{ id: string; status: string }>).map((p) => [p.id, p.status]));
    expect(byId.get('cb')).toBe('Charged back');
    expect(byId.get('bounced')).toBe('Voided');
  });
});
