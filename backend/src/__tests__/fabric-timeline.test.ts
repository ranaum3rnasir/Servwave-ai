import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';
import app from '../app';
import { prisma } from '../lib/prisma';
import { mockAuthAs, authHeader, JOB_FIXTURE, CUSTOMER_FIXTURE } from './helpers';

// Valid UUIDs — required because decideApprovalSchema.id and sendMessageSchema.threadId
// are z.string().uuid(); validate() 400s a non-UUID body before the controller runs.
const SA1_ID = '11111111-1111-1111-1111-111111111111';
const SA2_ID = '22222222-2222-2222-2222-222222222222';
const TH1_ID = '33333333-3333-3333-3333-333333333333';

const mockPrisma = prisma as unknown as {
  stockApproval: { findFirst: ReturnType<typeof vi.fn>; updateMany: ReturnType<typeof vi.fn> };
  purchaseOrder: { findFirst: ReturnType<typeof vi.fn>; update: ReturnType<typeof vi.fn> };
  messageThread: { findFirst: ReturnType<typeof vi.fn>; create: ReturnType<typeof vi.fn> };
  message: { create: ReturnType<typeof vi.fn> };
  timelineEvent: { create: ReturnType<typeof vi.fn> };
  $transaction: ReturnType<typeof vi.fn>;
};

beforeEach(() => {
  vi.clearAllMocks();
  // Phase 1 Task 7 wraps decideStockApproval in prisma.$transaction(async (tx) => …).
  // Passthrough so the callback runs with the same mockPrisma (and tx.timelineEvent.create
  // is the spy asserted below). The approval fixtures below intentionally omit `type`, so
  // Phase 1's type→movement map yields undefined → the applyStockMovement branch is skipped
  // and no stockMovement/stockBalance/priceBookItem mocks are needed.
  mockPrisma.$transaction.mockImplementation((fn: (tx: unknown) => Promise<unknown>) => fn(mockPrisma));
});

// PARKED (P0 §C, QA-902): the decide route answers 404 FEATURE_DISABLED, so the
// handler is unreachable through HTTP. Spec stays for cheap un-parking.
describe.skip('F3 — stock approval decided emits a JOB timeline event', () => {
  it('writes a JOB timeline event when the approval is linked to a job', async () => {
    mockAuthAs('admin');
    mockPrisma.stockApproval.findFirst
      .mockResolvedValueOnce({ id: SA1_ID, status: 'pending', job_id: JOB_FIXTURE.id, item_name: 'Compressor', qty: 2 })
      .mockResolvedValueOnce({ id: SA1_ID, status: 'approved', job_id: JOB_FIXTURE.id, requested_at: new Date(), qty: 2, modifications: [] });
    mockPrisma.stockApproval.updateMany.mockResolvedValue({ count: 1 });

    const res = await request(app)
      .post('/api/inventory/stock-approvals/decide')
      .set(authHeader('admin'))
      .send({ id: SA1_ID, decision: 'approved', reviewedByName: 'Test Admin' });

    expect(res.status).toBe(200);
    const args = mockPrisma.timelineEvent.create.mock.calls[0][0];
    expect(args.data.entity_type).toBe('JOB');
    expect(args.data.entity_id).toBe(JOB_FIXTURE.id);
    expect(args.data.event_type).toBe('STOCK_APPROVAL_DECIDED');
  });

  it('does NOT write a timeline event when the approval has no job link', async () => {
    mockAuthAs('admin');
    mockPrisma.stockApproval.findFirst
      .mockResolvedValueOnce({ id: SA2_ID, status: 'pending', job_id: null, item_name: 'Compressor', qty: 2 })
      .mockResolvedValueOnce({ id: SA2_ID, status: 'approved', job_id: null, requested_at: new Date(), qty: 2, modifications: [] });
    mockPrisma.stockApproval.updateMany.mockResolvedValue({ count: 1 });

    await request(app)
      .post('/api/inventory/stock-approvals/decide')
      .set(authHeader('admin'))
      .send({ id: SA2_ID, decision: 'approved', reviewedByName: 'Test Admin' });

    expect(mockPrisma.timelineEvent.create).not.toHaveBeenCalled();
  });
});

describe('F3 — PO received emits a JOB timeline event', () => {
  it('writes a JOB timeline event when status transitions to received', async () => {
    mockAuthAs('admin');
    mockPrisma.purchaseOrder.findFirst.mockResolvedValue({ id: 'aaaaaaa5-0000-4000-8000-0000000000f3', job_id: JOB_FIXTURE.id, po_number: 'PO-1' });
    mockPrisma.purchaseOrder.update.mockResolvedValue({ id: 'aaaaaaa5-0000-4000-8000-0000000000f3', po_number: 'PO-1', status: 'received', ordered_at: new Date(), lines: [], job: { job_number: 'J00001' } });

    const res = await request(app)
      .patch('/api/inventory/purchase-orders/aaaaaaa5-0000-4000-8000-0000000000f3')
      .set(authHeader('admin'))
      .send({ status: 'received' });

    expect(res.status).toBe(200);
    const args = mockPrisma.timelineEvent.create.mock.calls[0][0];
    expect(args.data.entity_type).toBe('JOB');
    expect(args.data.entity_id).toBe(JOB_FIXTURE.id);
    expect(args.data.event_type).toBe('PO_RECEIVED');
  });

  it('does NOT write a timeline event for a non-received status update', async () => {
    mockAuthAs('admin');
    mockPrisma.purchaseOrder.findFirst.mockResolvedValue({ id: 'aaaaaaa5-0000-4000-8000-0000000000f3', job_id: JOB_FIXTURE.id, po_number: 'PO-1' });
    mockPrisma.purchaseOrder.update.mockResolvedValue({ id: 'aaaaaaa5-0000-4000-8000-0000000000f3', po_number: 'PO-1', status: 'sent', ordered_at: new Date(), lines: [], job: { job_number: 'J00001' } });

    await request(app)
      .patch('/api/inventory/purchase-orders/aaaaaaa5-0000-4000-8000-0000000000f3')
      .set(authHeader('admin'))
      .send({ status: 'sent' });

    expect(mockPrisma.timelineEvent.create).not.toHaveBeenCalled();
  });
});

describe('F3 — outbound SMS emits a CUSTOMER timeline event', () => {
  it('writes a CUSTOMER timeline event when the thread is linked to a customer', async () => {
    mockAuthAs('admin');
    mockPrisma.messageThread.findFirst.mockResolvedValue({ id: TH1_ID, customer_id: CUSTOMER_FIXTURE.id });
    mockPrisma.message.create.mockResolvedValue({ id: 'm1', thread_id: TH1_ID, direction: 'out', body: 'hi', ts: new Date(), status: 'sent', automated: false });

    const res = await request(app)
      .post('/api/communication/sms')
      .set(authHeader('admin'))
      .send({ threadId: TH1_ID, body: 'hi', direction: 'out' });

    expect(res.status).toBe(201);
    const args = mockPrisma.timelineEvent.create.mock.calls[0][0];
    expect(args.data.entity_type).toBe('CUSTOMER');
    expect(args.data.entity_id).toBe(CUSTOMER_FIXTURE.id);
    expect(args.data.event_type).toBe('SMS_SENT');
  });
});
