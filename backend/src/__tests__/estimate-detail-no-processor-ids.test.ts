/**
 * Payments go-live slice 33 (fix round 1) - the estimate detail response carries its deposit
 * invoice's payments; the processor payment-intent id must not reach the browser's network tab.
 * Each payment carries a neutral `paid_through_processor` boolean instead.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';
import app from '../app';
import { prisma } from '../lib/prisma';
import { TEST_USERS, mockAuthAs, authHeader } from './helpers';
import { clearPermissionCache } from '../lib/permissions/permissionCache';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockPrisma = prisma as unknown as Record<string, any>;

const ESTIMATE_ID = 'f3300000-0000-0000-0000-000000000001';
const CUSTOMER_ID = 'c3300000-0000-0000-0000-000000000001';

beforeEach(() => {
  vi.clearAllMocks();
  clearPermissionCache();
});

const pay = (id: string, over: Record<string, unknown>) => ({
  id, amount: '100.00', method: 'CARD', paid_at: '2026-10-01T10:00:00.000Z',
  reference_number: null, state: 'SUCCEEDED', voided_at: null, ...over,
});

describe('GET /api/estimates/:id - no processor ids', () => {
  it('replaces each deposit payment intent id with a paid_through_processor boolean', async () => {
    mockAuthAs('admin');
    mockPrisma.estimate.findUnique.mockResolvedValue({
      id: ESTIMATE_ID, lead_id: null, customer_id: CUSTOMER_ID, job_id: null, job: null, job_link: null,
      estimate_number: 'E03300', status: 'DRAFT', created_by: TEST_USERS.admin.id,
      customer: { id: CUSTOMER_ID, first_name: 'Test', last_name: 'Customer', email: 'a@b.test', phone: '555' },
      lead: null, line_items: [], scope_photos: [],
      creator: { id: TEST_USERS.admin.id, first_name: 'Test', last_name: 'Admin' },
      invoices: [{
        id: 'inv-1', invoice_number: 'D-1', status: 'PAID', kind: 'DEPOSIT',
        payments: [
          pay('p1', { stripe_payment_intent_id: 'pi_secret_est_1' }),
          pay('p2', { method: 'CHECK', stripe_payment_intent_id: null }),
        ],
      }],
    });

    const res = await request(app).get(`/api/estimates/${ESTIMATE_ID}`).set(authHeader('admin'));

    expect(res.status).toBe(200);
    const body = JSON.stringify(res.body);
    expect(body).not.toContain('pi_secret_est_1');
    expect(body).not.toContain('stripe_payment_intent_id');
    expect(res.body.estimate.invoices[0].payments.map((p: { paid_through_processor: boolean }) => p.paid_through_processor)).toEqual([true, false]);
  });
});
