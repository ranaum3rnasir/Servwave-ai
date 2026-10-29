/**
 * comm-messages-lead.test.ts — PATCH /api/communication/sms/:id/lead.
 *
 * Full job-parity ruling (2026-07-22): lead_id is otherwise only ever stamped
 * at send time (sendMessage's explicit leadId) — a message that missed its
 * lead attribution could never be corrected, unlike jobs (sms/:id/job). This
 * mirrors reassignMessageJob exactly: resolve the message's thread (internal
 * lanes 404) → org-scoped lead resolve → atomic updateMany → refetch;
 * lead_id: null clears. Same-customer rule: a customer-linked thread only
 * attaches to that customer's leads; customer-less (vendor) threads accept
 * any org lead.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { Mock } from 'vitest';
import request from 'supertest';
import app from '../app';
import { prisma } from '../lib/prisma';
import { clearTokenCache } from '../middleware/authenticate';
import { clearPermissionCache } from '../lib/permissions/permissionCache';
import { ALPHA_ORG_ID, ORG_B_ID, mockAuthAs, authHeader, CUSTOMER_FIXTURE } from './helpers';

const mockPrisma = prisma as any;

const LEAD_ID = 'ab000000-0000-0000-0000-000000000088';
const LEAD_ROW = { id: LEAD_ID, lead_number: 'L00088', customer_id: CUSTOMER_FIXTURE.id };
const OTHER_CUSTOMER_ID = 'c0000000-0000-0000-0000-000000000099';
const MSG_ID = '99990000-0000-0000-0000-000000000021';
const VENDOR_ID = 'd0000000-0000-0000-0000-000000000001';

const MESSAGE_ROW = {
  id: MSG_ID,
  direction: 'in',
  body: 'Sounds good',
  ts: new Date('2026-06-09T10:00:00Z'),
  status: 'received',
  automated: false,
  job_id: null,
  job_label: null,
  lead_id: null,
  organization_id: ALPHA_ORG_ID,
};

beforeEach(() => {
  vi.clearAllMocks();
  clearTokenCache();
  clearPermissionCache();
});

function expectOrgScoped(mockFn: Mock, orgId: string) {
  expect(mockFn).toHaveBeenCalledWith(
    expect.objectContaining({ where: expect.objectContaining({ organization_id: orgId }) })
  );
}

function mockMessageThread(overrides: Record<string, unknown> = {}) {
  mockPrisma.messageThread.findFirst.mockResolvedValue({
    kind: null, customer_id: CUSTOMER_FIXTURE.id, ...overrides,
  });
}

describe('PATCH /api/communication/sms/:id/lead — manual attach', () => {
  it('sets lead_id from an org-scoped lead', async () => {
    mockAuthAs('dispatcher');
    mockMessageThread();
    mockPrisma.lead.findUnique.mockResolvedValue(LEAD_ROW);
    mockPrisma.message.updateMany.mockResolvedValue({ count: 1 });
    mockPrisma.message.findMany.mockResolvedValue([{ ...MESSAGE_ROW, lead_id: LEAD_ID }]);

    const res = await request(app)
      .patch(`/api/communication/sms/${MSG_ID}/lead`)
      .set(authHeader('dispatcher'))
      .send({ lead_id: LEAD_ID });

    expect(res.status).toBe(200);
    expect(mockPrisma.messageThread.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ messages: { some: { id: MSG_ID } }, organization_id: ALPHA_ORG_ID }),
      })
    );
    expect(mockPrisma.message.updateMany).toHaveBeenCalledWith({
      where: { id: MSG_ID, organization_id: ALPHA_ORG_ID, thread: { OR: [{ kind: null }, { kind: 'customer' }] } },
      data: { lead_id: LEAD_ID },
    });
    expectOrgScoped(mockPrisma.lead.findUnique as Mock, ALPHA_ORG_ID);
    expect(res.body.message.leadId).toBe(LEAD_ID);
  });

  it('clears lead_id on null without resolving a lead or the thread', async () => {
    mockAuthAs('dispatcher');
    mockPrisma.message.updateMany.mockResolvedValue({ count: 1 });
    mockPrisma.message.findMany.mockResolvedValue([{ ...MESSAGE_ROW, lead_id: null }]);

    const res = await request(app)
      .patch(`/api/communication/sms/${MSG_ID}/lead`)
      .set(authHeader('dispatcher'))
      .send({ lead_id: null });

    expect(res.status).toBe(200);
    expect(mockPrisma.lead.findUnique).not.toHaveBeenCalled();
    expect(mockPrisma.messageThread.findFirst).not.toHaveBeenCalled();
    expect(mockPrisma.message.updateMany).toHaveBeenCalledWith({
      where: { id: MSG_ID, organization_id: ALPHA_ORG_ID, thread: { OR: [{ kind: null }, { kind: 'customer' }] } },
      data: { lead_id: null },
    });
    expect(res.body.message).not.toHaveProperty('leadId');
  });

  it("404s when the lead belongs to a different customer than the message's thread", async () => {
    mockAuthAs('dispatcher');
    mockMessageThread();
    mockPrisma.lead.findUnique.mockResolvedValue({ ...LEAD_ROW, customer_id: OTHER_CUSTOMER_ID });

    const res = await request(app)
      .patch(`/api/communication/sms/${MSG_ID}/lead`)
      .set(authHeader('dispatcher'))
      .send({ lead_id: LEAD_ID });

    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'Lead not found' });
    expect(mockPrisma.message.updateMany).not.toHaveBeenCalled();
  });

  it('a customer-less (vendor) thread accepts any org lead', async () => {
    mockAuthAs('dispatcher');
    mockMessageThread({ customer_id: null, vendor_id: VENDOR_ID });
    mockPrisma.lead.findUnique.mockResolvedValue(LEAD_ROW);
    mockPrisma.message.updateMany.mockResolvedValue({ count: 1 });
    mockPrisma.message.findMany.mockResolvedValue([{ ...MESSAGE_ROW, lead_id: LEAD_ID }]);

    const res = await request(app)
      .patch(`/api/communication/sms/${MSG_ID}/lead`)
      .set(authHeader('dispatcher'))
      .send({ lead_id: LEAD_ID });

    expect(res.status).toBe(200);
    expect(res.body.message.leadId).toBe(LEAD_ID);
  });

  it('404s a reassign of a group-thread message (internal lanes are never lead-tagged)', async () => {
    mockAuthAs('dispatcher');
    mockMessageThread({ kind: 'group', customer_id: null });

    const res = await request(app)
      .patch(`/api/communication/sms/${MSG_ID}/lead`)
      .set(authHeader('dispatcher'))
      .send({ lead_id: LEAD_ID });

    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'Message not found' });
    expect(mockPrisma.lead.findUnique).not.toHaveBeenCalled();
    expect(mockPrisma.message.updateMany).not.toHaveBeenCalled();
  });

  it('404s on a cross-org lead_id without touching the message', async () => {
    mockAuthAs('dispatcher');
    mockMessageThread();
    mockPrisma.lead.findUnique.mockResolvedValue(null);

    const res = await request(app)
      .patch(`/api/communication/sms/${MSG_ID}/lead`)
      .set(authHeader('dispatcher'))
      .send({ lead_id: LEAD_ID });

    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'Lead not found' });
    expect(mockPrisma.message.updateMany).not.toHaveBeenCalled();
  });

  it('404s when the message is cross-org (org scoping)', async () => {
    mockAuthAs('orgB_admin');
    mockPrisma.message.updateMany.mockResolvedValue({ count: 0 });

    const res = await request(app)
      .patch(`/api/communication/sms/${MSG_ID}/lead`)
      .set(authHeader('orgB_admin'))
      .send({ lead_id: null });

    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'Message not found' });
    expectOrgScoped(mockPrisma.message.updateMany as Mock, ORG_B_ID);
  });

  it('403s for a technician (no update Communication grant)', async () => {
    mockAuthAs('technician');

    const res = await request(app)
      .patch(`/api/communication/sms/${MSG_ID}/lead`)
      .set(authHeader('technician'))
      .send({ lead_id: LEAD_ID });

    expect(res.status).toBe(403);
    expect(mockPrisma.message.updateMany).not.toHaveBeenCalled();
  });

  it('403s for SALES (read-only)', async () => {
    mockAuthAs('sales');

    const res = await request(app)
      .patch(`/api/communication/sms/${MSG_ID}/lead`)
      .set(authHeader('sales'))
      .send({ lead_id: null });

    expect(res.status).toBe(403);
    expect(mockPrisma.message.updateMany).not.toHaveBeenCalled();
  });
});
