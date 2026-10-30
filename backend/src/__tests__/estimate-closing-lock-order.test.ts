/**
 * Payments go-live slice 27 (slice 15 review 3) - lock order in the estimate-closing paths.
 *
 * The checkout webhook locks the deposit invoice FIRST and then updates the estimate (WON). Every
 * door that closes an estimate must therefore take the deposit lock before it writes the estimate
 * row, or the two transactions wait on each other. The assertion is the order of the two calls
 * inside the transaction.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';
import app from '../app';
import { prisma } from '../lib/prisma';
import { ESTIMATE_SENT_FIXTURE, ALPHA_ORG_ID, TEST_USERS, mockAuthAs, authHeader } from './helpers';

const mockPrisma = prisma as unknown as Record<string, any>;
const ID = ESTIMATE_SENT_FIXTURE.id;

function armTransaction() {
  const order: string[] = [];
  mockPrisma.$transaction.mockImplementation((fn: (tx: unknown) => Promise<unknown>) =>
    fn({
      $executeRaw: vi.fn().mockImplementation(() => { order.push('lock-deposit'); return Promise.resolve(0); }),
      estimate: { update: vi.fn().mockImplementation(() => { order.push('estimate-update'); return Promise.resolve({ ...ESTIMATE_SENT_FIXTURE, status: 'DECLINED' }); }) },
      timelineEvent: { create: vi.fn().mockResolvedValue({}) },
      estimateSendConfig: { deleteMany: vi.fn().mockResolvedValue({ count: 0 }) },
      invoice: { findMany: vi.fn().mockResolvedValue([]), updateMany: vi.fn().mockResolvedValue({ count: 0 }) },
    }),
  );
  return order;
}

const staffEstimate = {
  id: ID, status: 'SENT', estimate_number: ESTIMATE_SENT_FIXTURE.estimate_number, lead_id: ESTIMATE_SENT_FIXTURE.lead_id,
  lead: { lead_assignees: [{ user_id: TEST_USERS.sales.id }], commission_owner_id: null },
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe('closing an estimate locks its deposit before writing the estimate', () => {
  it('on staff cancel', async () => {
    mockAuthAs('admin');
    mockPrisma.estimate.findUnique.mockResolvedValue(staffEstimate);
    const order = armTransaction();

    const res = await request(app).post(`/api/estimates/${ID}/cancel`).set(authHeader('admin')).send({ cancelled_reason: 'x' });

    expect(res.status).toBe(200);
    expect(order.slice(0, 2)).toEqual(['lock-deposit', 'estimate-update']);
  });

  it('on staff decline', async () => {
    mockAuthAs('admin');
    mockPrisma.estimate.findUnique.mockResolvedValue(staffEstimate);
    const order = armTransaction();

    const res = await request(app).post(`/api/estimates/${ID}/decline-internal`).set(authHeader('admin')).send({ lost_reason: 'PRICE' });

    expect(res.status).toBe(200);
    expect(order.slice(0, 2)).toEqual(['lock-deposit', 'estimate-update']);
  });

  it('on the customer decline', async () => {
    mockPrisma.estimate.findFirst.mockResolvedValue({
      id: ID, status: 'SENT', estimate_number: ESTIMATE_SENT_FIXTURE.estimate_number,
      lead_id: ESTIMATE_SENT_FIXTURE.lead_id, organization_id: ALPHA_ORG_ID, lead: { commission_owner_id: null },
    });
    mockPrisma.estimate.findUnique.mockResolvedValue(null);
    const order = armTransaction();

    const res = await request(app).post(`/api/estimates/${ID}/decline?token=${ESTIMATE_SENT_FIXTURE.public_token}`).send({});

    expect(res.status).toBe(200);
    expect(order.slice(0, 2)).toEqual(['lock-deposit', 'estimate-update']);
  });
});
