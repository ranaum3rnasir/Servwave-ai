/**
 * Payments go-live slice 27 (slice 21 review) - revising an estimate copies its per-estimate deposit
 * policy. The revision is an exact clone of the sent document, so an estimate sent as "pay later"
 * must not quietly come back as "required before approval" (the org default).
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';
import app from '../app';
import { prisma } from '../lib/prisma';
import { TEST_USERS, mockAuthAs, authHeader, ESTIMATE_FIXTURE, LEAD_FIXTURE } from './helpers';

const mockPrisma = prisma as unknown as Record<string, any>;

const source = (deposit_policy: string | null) => ({
  id: ESTIMATE_FIXTURE.id,
  status: 'SENT',
  estimate_number: ESTIMATE_FIXTURE.estimate_number,
  lead_id: LEAD_FIXTURE.id,
  organization_id: TEST_USERS.admin.organization_id,
  customer_id: null,
  service_location_id: null,
  created_by: TEST_USERS.admin.id,
  name: null, scope_name: null, scope_notes: 'Scope', scopes: null,
  tax_rate: 0, discount_type: null, discount_value: null, discount_name: null, discount_amount: 0,
  deposit_type: 'PERCENTAGE', deposit_value: 50, deposit_policy,
  subtotal: 1000, tax_amount: 0, total_amount: 1000,
  line_items: [],
  lead: { lead_assignees: [{ user_id: TEST_USERS.admin.id }] },
});

let created: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.clearAllMocks();
  mockAuthAs('admin');
  created = vi.fn().mockResolvedValue({ ...ESTIMATE_FIXTURE, id: 'new-est-1', status: 'DRAFT' });
  mockPrisma.$transaction.mockImplementation((fn: (tx: unknown) => Promise<unknown>) =>
    fn({
      estimate: { create: created, update: vi.fn().mockResolvedValue({}) },
      invoice: { updateMany: vi.fn().mockResolvedValue({ count: 0 }) },
      timelineEvent: { create: vi.fn().mockResolvedValue({}) },
    }),
  );
});

describe('POST /api/estimates/:id/revise - the deposit policy travels', () => {
  it.each(['PAY_LATER', 'REQUIRED_BEFORE_APPROVAL', null])('copies a %s policy onto the revision', async (policy) => {
    mockPrisma.estimate.findUnique.mockResolvedValue(source(policy));

    const res = await request(app).post(`/api/estimates/${ESTIMATE_FIXTURE.id}/revise`).set(authHeader('admin'));

    expect(res.status).toBe(200);
    expect(created.mock.calls[0][0].data.deposit_policy).toBe(policy);
  });
});
