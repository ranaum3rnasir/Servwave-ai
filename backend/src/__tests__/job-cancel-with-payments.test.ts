// Payments go-live slice 17 (#891): cancelling a job asks before touching paid invoices.
//
// Contract under test (POST /api/jobs/:id/cancel, and the bulk-status / status-change doors):
//   - "Carries payments" = any live SUCCEEDED or PROCESSING payment other than a deposit-credit
//     transfer, whatever has been refunded.
//   - Conductor decision 2026-10-06: when ANY non-VOIDED invoice on the job carries payments, a
//     fully PAID one included, a cancel with no `void_invoices` choice answers 409
//     JOB_CANCEL_HAS_PAYMENTS listing them and changes nothing. In bulk, that job lands in
//     failed[] carrying the same error and code.
//   - With a choice made the cancel goes ahead, and an invoice carrying money is never voided:
//     `void_invoices: false` leaves every invoice untouched; `void_invoices: true` voids only the
//     unpaid open (SENT/PARTIAL) invoices.
//   - A job whose invoices carry no payments cancels exactly as before (open invoices void),
//     and a voided invoice releases any deposit credit drawn onto it.
//   - The void re-checks inside the transaction: a payment landing after the guard read aborts it.
//   - Money figures in the 409 body are gated on reading invoices; invoice numbers are not.
//   - Collected money (amount_paid, collected_total, refund_suggested) is SUCCEEDED payments minus
//     SUCCEEDED refunds. A PROCESSING payment blocks the void but is shown apart, as amount_processing.
import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';
import app from '../app';
import { prisma } from '../lib/prisma';
import { mockAuthAs, mockRoleGrantsWithout, mockRoleSwitches, authHeader, JOB_FIXTURE } from './helpers';
import { clearPermissionCache } from '../lib/permissions/permissionCache';

vi.mock('../services/automations/dispatch', () => ({
  dispatchAutomationEvent: vi.fn(),
}));

const mockPrisma = prisma as unknown as {
  job: { findUnique: ReturnType<typeof vi.fn>; update: ReturnType<typeof vi.fn> };
  invoice: { update: ReturnType<typeof vi.fn> };
  $transaction: ReturnType<typeof vi.fn>;
};

const JOB_ID = JOB_FIXTURE.id;

// The cancel cascade's whole tx surface (mirrors jobs.test.ts wireCancelTx).
function wireCancelTx() {
  // #891: the cascade voids with a CONDITIONAL updateMany (still open, still no money on it).
  // count 1 = voided; count 0 = the invoice changed after the guard read it.
  const txInvoiceUpdate = vi.fn().mockResolvedValue({ count: 1 });
  const txJobUpdate = vi.fn().mockResolvedValue({ ...JOB_FIXTURE, status: 'CANCELLED' });
  const txTimeline = vi.fn().mockResolvedValue({});
  const txCreditReverse = vi.fn().mockResolvedValue({ count: 0 });
  const txPaymentVoid = vi.fn().mockResolvedValue({ count: 0 });
  mockPrisma.$transaction.mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) =>
    fn({
      // #891: the cascade locks the invoices it voids before voiding them.
      $executeRaw: vi.fn().mockResolvedValue(1),
      invoice: { updateMany: txInvoiceUpdate },
      job: { update: txJobUpdate },
      timelineEvent: { create: txTimeline },
      depositCreditApplication: { updateMany: txCreditReverse },
      payment: { updateMany: txPaymentVoid },
      planVisit: { updateMany: vi.fn().mockResolvedValue({ count: 0 }) },
      visit: { updateMany: vi.fn().mockResolvedValue({ count: 0 }) },
      jobLineItem: { findMany: vi.fn().mockResolvedValue([]), updateMany: vi.fn() },
      invoiceLineItem: { findMany: vi.fn().mockResolvedValue([]), updateMany: vi.fn() },
    }),
  );
  return { txInvoiceUpdate, txJobUpdate, txTimeline, txCreditReverse, txPaymentVoid };
}

function invoice(over: Record<string, unknown> = {}) {
  return {
    id: 'inv-open-1',
    invoice_number: 'I00412',
    status: 'PARTIAL',
    kind: 'STANDARD',
    amount_due: 5400,
    total_amount: 8400,
    payments: [],
    refunds: [],
    ...over,
  };
}

// A live card/cash payment row as the cancel select returns it (slice 04 ledger states).
function paid(amount: number, state: 'SUCCEEDED' | 'PROCESSING' | 'FAILED' = 'SUCCEEDED') {
  return { amount, reference_number: null, state };
}

function jobWith(invoices: unknown[]) {
  return { ...JOB_FIXTURE, status: 'IN_PROGRESS', source_plan_id: null, invoices };
}

function cancel(body: Record<string, unknown>, as: 'admin' | 'dispatcher' = 'admin') {
  return request(app).post(`/api/jobs/${JOB_ID}/cancel`).set(authHeader(as)).send(body);
}

beforeEach(() => {
  vi.clearAllMocks();
  // clearAllMocks keeps queued *Once values; drain them so one test's reads never feed the next.
  mockPrisma.job.findUnique.mockReset();
  clearPermissionCache();
  mockAuthAs('admin');
});

describe('POST /api/jobs/:id/cancel - invoices with payments (#891)', () => {
  it('answers 409 with the affected invoices and changes nothing when an open invoice is paid', async () => {
    mockPrisma.job.findUnique.mockResolvedValue(
      jobWith([invoice({ payments: [paid(3000)] })]),
    );
    const { txInvoiceUpdate, txJobUpdate } = wireCancelTx();

    const res = await cancel({ cancel_reason_code: 'OTHER', cancelled_reason: 'Customer called off' });

    expect(res.status).toBe(409);
    expect(res.body.code).toBe('JOB_CANCEL_HAS_PAYMENTS');
    expect(res.body.error).toContain('I00412');
    expect(res.body.invoices).toEqual([
      { id: 'inv-open-1', invoice_number: 'I00412', status: 'PARTIAL', has_payments: true, amount_paid: 3000, amount_due: 5400 },
    ]);
    expect(mockPrisma.$transaction).not.toHaveBeenCalled();
    expect(txInvoiceUpdate).not.toHaveBeenCalled();
    expect(txJobUpdate).not.toHaveBeenCalled();
    expect(mockPrisma.invoice.update).not.toHaveBeenCalled();
    expect(mockPrisma.job.update).not.toHaveBeenCalled();
  });

  it('cancels the job and leaves every invoice untouched when the caller chooses to keep them', async () => {
    mockPrisma.job.findUnique.mockResolvedValue(
      jobWith([
        invoice({ payments: [paid(3000)] }),
        invoice({ id: 'inv-open-2', invoice_number: 'I00413', status: 'SENT' }),
      ]),
    );
    const { txInvoiceUpdate, txJobUpdate } = wireCancelTx();

    const res = await cancel({ cancel_reason_code: 'OTHER', cancelled_reason: 'Customer called off', void_invoices: false });

    expect(res.status).toBe(200);
    expect(txJobUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: 'CANCELLED' }) }),
    );
    expect(txInvoiceUpdate).not.toHaveBeenCalled();
    expect(res.body.voided_invoice_ids).toEqual([]);
    // The collected money is still surfaced for the separate refund action.
    expect(res.body.collected_total).toBe(3000);
  });

  it('never voids an invoice carrying payments, even when the caller chooses to void', async () => {
    // Conductor decision 2026-10-06: making the choice lets the cancel go ahead; the invoice
    // with money on it is kept.
    mockPrisma.job.findUnique.mockResolvedValue(
      jobWith([invoice({ payments: [paid(3000)] })]),
    );
    const { txInvoiceUpdate, txJobUpdate } = wireCancelTx();

    const res = await cancel({ cancel_reason_code: 'OTHER', cancelled_reason: 'Customer called off', void_invoices: true });

    expect(res.status).toBe(200);
    expect(txJobUpdate).toHaveBeenCalled();
    expect(txInvoiceUpdate).not.toHaveBeenCalled();
    expect(res.body.voided_invoice_ids).toEqual([]);
  });

  it('cancels as before when no open invoice carries payments: open invoices are voided', async () => {
    mockPrisma.job.findUnique.mockResolvedValue(jobWith([invoice({ status: 'SENT' })]));
    const { txInvoiceUpdate } = wireCancelTx();

    const res = await cancel({ cancel_reason_code: 'OTHER', cancelled_reason: 'Customer called off' });

    expect(res.status).toBe(200);
    expect(txInvoiceUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: 'inv-open-1' }),
        data: expect.objectContaining({ status: 'VOIDED', amount_due: 0 }),
      }),
    );
    expect(res.body.voided_invoice_ids).toEqual(['inv-open-1']);
  });

  it('blocks the cancel on a PROCESSING payment: money on its way still counts', async () => {
    mockPrisma.job.findUnique.mockResolvedValue(
      jobWith([invoice({ payments: [paid(3000, 'PROCESSING')] })]),
    );
    const { txInvoiceUpdate } = wireCancelTx();

    const res = await cancel({ cancel_reason_code: 'OTHER', cancelled_reason: 'Customer called off' });

    expect(res.status).toBe(409);
    expect(res.body.code).toBe('JOB_CANCEL_HAS_PAYMENTS');
    expect(res.body.invoices[0]).toMatchObject({ invoice_number: 'I00412', has_payments: true });
    expect(txInvoiceUpdate).not.toHaveBeenCalled();
  });

  it('names a PROCESSING payment as processing in the 409, never as money paid', async () => {
    mockPrisma.job.findUnique.mockResolvedValue(
      jobWith([invoice({ payments: [paid(1000), paid(3000, 'PROCESSING')] })]),
    );
    wireCancelTx();

    const res = await cancel({ cancel_reason_code: 'OTHER', cancelled_reason: 'Customer called off' });

    expect(res.status).toBe(409);
    expect(res.body.invoices).toEqual([
      { id: 'inv-open-1', invoice_number: 'I00412', status: 'PARTIAL', has_payments: true, amount_paid: 1000, amount_processing: 3000, amount_due: 5400 },
    ]);
  });

  it('counts only settled money as collected when the invoices are kept: a PROCESSING payment suggests no refund', async () => {
    mockPrisma.job.findUnique.mockResolvedValue(
      jobWith([invoice({ payments: [paid(3000, 'PROCESSING')] })]),
    );
    const { txTimeline } = wireCancelTx();

    const res = await cancel({ cancel_reason_code: 'OTHER', cancelled_reason: 'Customer called off', void_invoices: false });

    expect(res.status).toBe(200);
    expect([res.body.collected_total, res.body.refund_suggested]).toEqual([0, false]);
    expect(txTimeline).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        event_type: 'CANCELLED',
        metadata: expect.objectContaining({ collected_total: 0 }),
      }),
    }));
  });

  it('does not count a FAILED payment: the job cancels as today and its open invoice is voided', async () => {
    mockPrisma.job.findUnique.mockResolvedValue(
      jobWith([invoice({ payments: [paid(3000, 'FAILED')] })]),
    );
    wireCancelTx();

    const res = await cancel({ cancel_reason_code: 'OTHER', cancelled_reason: 'Customer called off' });

    expect(res.status).toBe(200);
    expect(res.body.voided_invoice_ids).toEqual(['inv-open-1']);
  });

  it('still blocks the cancel when the payment was refunded, whatever the refund state', async () => {
    // Refunds never unlock a void (slice 18's rule for the invoice void door): only voided
    // payments do. A PENDING or FAILED refund has not even returned the money.
    mockPrisma.job.findUnique.mockResolvedValue(
      jobWith([
        invoice({ payments: [paid(300)], refunds: [{ amount: 300, state: 'SUCCEEDED' }] }),
        invoice({ id: 'inv-open-2', invoice_number: 'I00413', payments: [paid(500)], refunds: [{ amount: 500, state: 'PENDING' }] }),
        invoice({ id: 'inv-open-3', invoice_number: 'I00414', payments: [paid(700)], refunds: [{ amount: 700, state: 'FAILED' }] }),
      ]),
    );
    const { txInvoiceUpdate } = wireCancelTx();

    const res = await cancel({ cancel_reason_code: 'OTHER', cancelled_reason: 'Customer called off' });

    expect(res.status).toBe(409);
    expect(res.body.invoices.map((i: { invoice_number: string; has_payments: boolean }) => [i.invoice_number, i.has_payments])).toEqual([
      ['I00412', true],
      ['I00413', true],
      ['I00414', true],
    ]);
    expect(txInvoiceUpdate).not.toHaveBeenCalled();
  });

  it('voids an open invoice carrying only a deposit credit and releases that credit back to the deposit', async () => {
    // The deposit's real money sits on the DEPOSIT invoice, not here. Voiding the drawn-on
    // invoice must un-apply the credit (as the invoice void door does), or the deposit stays
    // consumed by a VOIDED invoice and a phantom credit shows on the statement.
    mockPrisma.job.findUnique.mockResolvedValue(
      jobWith([invoice({ payments: [{ amount: 500, reference_number: 'DEPOSIT-CREDIT', state: 'SUCCEEDED' }] })]),
    );
    const { txCreditReverse, txPaymentVoid, txTimeline } = wireCancelTx();
    txCreditReverse.mockResolvedValue({ count: 1 });
    txPaymentVoid.mockResolvedValue({ count: 1 });

    const res = await cancel({ cancel_reason_code: 'OTHER', cancelled_reason: 'Customer called off' });

    expect(res.status).toBe(200);
    expect(res.body.voided_invoice_ids).toEqual(['inv-open-1']);
    expect(txCreditReverse).toHaveBeenCalledWith({
      where: { target_invoice_id: 'inv-open-1', reversed_at: null, organization_id: expect.any(String) },
      data: { reversed_at: expect.any(Date) },
    });
    expect(txPaymentVoid).toHaveBeenCalledWith({
      where: { invoice_id: 'inv-open-1', reference_number: 'DEPOSIT-CREDIT', voided_at: null },
      data: expect.objectContaining({ voided_at: expect.any(Date), voided_reason: 'Invoice voided' }),
    });
    expect(txTimeline).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ event_type: 'DEPOSIT_CREDIT_REVERSED', entity_id: 'inv-open-1' }) }),
    );
  });

  it('leaves deposit credits alone on the keep path, where nothing is voided', async () => {
    mockPrisma.job.findUnique.mockResolvedValue(
      jobWith([
        invoice({ payments: [paid(3000), { amount: 500, reference_number: 'DEPOSIT-CREDIT', state: 'SUCCEEDED' }] }),
      ]),
    );
    const { txCreditReverse, txPaymentVoid } = wireCancelTx();

    const res = await cancel({ cancel_reason_code: 'OTHER', cancelled_reason: 'Customer called off', void_invoices: false });

    expect(res.status).toBe(200);
    expect(txCreditReverse).not.toHaveBeenCalled();
    expect(txPaymentVoid).not.toHaveBeenCalled();
  });

  it('answers 409 naming a fully PAID invoice and changes nothing when no choice is made', async () => {
    // Conductor decision 2026-10-06: the guard covers every non-VOIDED invoice carrying money,
    // PAID included, not only the SENT/PARTIAL ones the cascade would void.
    mockPrisma.job.findUnique.mockResolvedValue(
      jobWith([invoice({ status: 'PAID', amount_due: 0, payments: [paid(8400)] })]),
    );
    const { txInvoiceUpdate, txJobUpdate } = wireCancelTx();

    const res = await cancel({ cancel_reason_code: 'OTHER', cancelled_reason: 'Customer called off' });

    expect(res.status).toBe(409);
    expect(res.body.code).toBe('JOB_CANCEL_HAS_PAYMENTS');
    expect(res.body.error).toContain('I00412');
    expect(res.body.invoices).toEqual([
      { id: 'inv-open-1', invoice_number: 'I00412', status: 'PAID', has_payments: true, amount_paid: 8400, amount_due: 0 },
    ]);
    expect(mockPrisma.$transaction).not.toHaveBeenCalled();
    expect(txInvoiceUpdate).not.toHaveBeenCalled();
    expect(txJobUpdate).not.toHaveBeenCalled();
    expect(mockPrisma.invoice.update).not.toHaveBeenCalled();
  });

  it('answers 409 for a PAID invoice whose payment is still PROCESSING', async () => {
    mockPrisma.job.findUnique.mockResolvedValue(
      jobWith([invoice({ status: 'PAID', amount_due: 0, payments: [paid(8400, 'PROCESSING')] })]),
    );
    wireCancelTx();

    const res = await cancel({ cancel_reason_code: 'OTHER', cancelled_reason: 'Customer called off' });

    expect(res.status).toBe(409);
    expect(res.body.invoices[0]).toMatchObject({ invoice_number: 'I00412', status: 'PAID', has_payments: true, amount_processing: 8400 });
  });

  it.each([false, true])('cancels the job with a choice made (void_invoices: %s) and the PAID invoice stays PAID', async (voidInvoices) => {
    mockPrisma.job.findUnique.mockResolvedValue(
      jobWith([invoice({ status: 'PAID', amount_due: 0, payments: [paid(8400)] })]),
    );
    const { txInvoiceUpdate, txJobUpdate } = wireCancelTx();

    const res = await cancel({ cancel_reason_code: 'OTHER', cancelled_reason: 'Customer called off', void_invoices: voidInvoices });

    expect(res.status).toBe(200);
    expect(txJobUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: 'CANCELLED' }) }),
    );
    expect(txInvoiceUpdate).not.toHaveBeenCalled();
    expect(mockPrisma.invoice.update).not.toHaveBeenCalled();
    expect(res.body.voided_invoice_ids).toEqual([]);
    expect(res.body.collected_total).toBe(8400);
  });

  it('with "void" chosen, voids only the unpaid open invoices and keeps every invoice carrying money', async () => {
    mockPrisma.job.findUnique.mockResolvedValue(
      jobWith([
        invoice({ id: 'inv-paid', invoice_number: 'I00411', status: 'PAID', amount_due: 0, payments: [paid(8400)] }),
        invoice({ id: 'inv-partial', payments: [paid(3000)] }),
        invoice({ id: 'inv-unpaid', invoice_number: 'I00413', status: 'SENT' }),
      ]),
    );
    const { txInvoiceUpdate } = wireCancelTx();

    const res = await cancel({ cancel_reason_code: 'OTHER', cancelled_reason: 'Customer called off', void_invoices: true });

    expect(res.status).toBe(200);
    expect(res.body.voided_invoice_ids).toEqual(['inv-unpaid']);
    expect(txInvoiceUpdate).toHaveBeenCalledTimes(1);
    expect(txInvoiceUpdate).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ id: 'inv-unpaid' }) }));
  });

  it('leaves VOIDED invoices out of the guard: an already voided invoice never blocks the cancel', async () => {
    mockPrisma.job.findUnique.mockResolvedValue(
      jobWith([invoice({ status: 'VOIDED', amount_due: 0, payments: [paid(500)] })]),
    );
    wireCancelTx();

    const res = await cancel({ cancel_reason_code: 'OTHER', cancelled_reason: 'Customer called off' });

    expect(res.status).toBe(200);
  });

  it('voids only while the invoice is still open and still carries no money, scoped to the org', async () => {
    // The guard reads before the transaction; the void itself re-checks inside it, so a
    // payment that lands in between can never be overwritten to VOIDED / $0.
    mockPrisma.job.findUnique.mockResolvedValue(jobWith([invoice({ status: 'SENT' })]));
    const { txInvoiceUpdate } = wireCancelTx();

    const res = await cancel({ cancel_reason_code: 'OTHER', cancelled_reason: 'Customer called off' });

    expect(res.status).toBe(200);
    expect(txInvoiceUpdate).toHaveBeenCalledWith(expect.objectContaining({
      where: {
        id: 'inv-open-1',
        organization_id: expect.any(String),
        // Slice 29: PAID too, for an invoice paid only by deposit credit; money still keeps it.
        status: { in: ['SENT', 'PARTIAL', 'PAID'] },
        payments: {
          none: {
            voided_at: null,
            state: { in: ['SUCCEEDED', 'PROCESSING'] },
            OR: [{ reference_number: null }, { reference_number: { not: 'DEPOSIT-CREDIT' } }],
          },
        },
      },
    }));
  });

  it('answers 409 and cancels nothing when a payment lands on an open invoice after the guard read it', async () => {
    mockPrisma.job.findUnique
      // The guard's read: no payments yet.
      .mockResolvedValueOnce(jobWith([invoice({ status: 'SENT' })]))
      // The re-read after the conditional void found the invoice changed: a payment landed.
      .mockResolvedValueOnce(jobWith([invoice({ status: 'PARTIAL', payments: [paid(3000)] })]));
    const { txInvoiceUpdate, txJobUpdate } = wireCancelTx();
    txInvoiceUpdate.mockResolvedValue({ count: 0 });

    const res = await cancel({ cancel_reason_code: 'OTHER', cancelled_reason: 'Customer called off' });

    expect(res.status).toBe(409);
    expect(res.body.code).toBe('JOB_CANCEL_HAS_PAYMENTS');
    expect(res.body.invoices).toEqual([
      { id: 'inv-open-1', invoice_number: 'I00412', status: 'PARTIAL', has_payments: true, amount_paid: 3000, amount_due: 5400 },
    ]);
    expect(txJobUpdate).not.toHaveBeenCalled();
  });

  it('names an invoice paid in full after the guard read it, so the user can make the choice', async () => {
    // A completed checkout flips the invoice to PAID; a PAID invoice with money is in the guard too.
    mockPrisma.job.findUnique
      .mockResolvedValueOnce(jobWith([invoice({ status: 'SENT' })]))
      .mockResolvedValueOnce(jobWith([invoice({ status: 'PAID', amount_due: 0, payments: [paid(8400)] })]));
    const { txInvoiceUpdate, txJobUpdate } = wireCancelTx();
    txInvoiceUpdate.mockResolvedValue({ count: 0 });

    const res = await cancel({ cancel_reason_code: 'OTHER', cancelled_reason: 'Customer called off' });

    expect(res.status).toBe(409);
    expect(res.body.code).toBe('JOB_CANCEL_HAS_PAYMENTS');
    expect(res.body.invoices).toEqual([
      { id: 'inv-open-1', invoice_number: 'I00412', status: 'PAID', has_payments: true, amount_paid: 8400, amount_due: 0 },
    ]);
    expect(txJobUpdate).not.toHaveBeenCalled();
  });

  it('answers 409 asking for a retry when a choice was made and a payment landed after the guard read it', async () => {
    // The choice already covers invoices carrying money (they are kept), so a retry goes through.
    mockPrisma.job.findUnique
      .mockResolvedValueOnce(jobWith([invoice({ status: 'SENT' })]))
      .mockResolvedValueOnce(jobWith([invoice({ status: 'PAID', amount_due: 0, payments: [paid(8400)] })]));
    const { txInvoiceUpdate, txJobUpdate } = wireCancelTx();
    txInvoiceUpdate.mockResolvedValue({ count: 0 });

    const res = await cancel({ cancel_reason_code: 'OTHER', cancelled_reason: 'Customer called off', void_invoices: true });

    expect(res.status).toBe(409);
    expect(res.body.code).toBe('JOB_CANCEL_INVOICES_CHANGED');
    expect(res.body.error).toMatch(/try again/i);
    expect(txJobUpdate).not.toHaveBeenCalled();
  });

  it('hides money figures in the 409 from a caller who cannot read invoices, but still names the invoices', async () => {
    // A dispatcher holding Cancel jobs; with View invoices off it is the real caller who cannot read the money
    // (ADMIN reaches every invoice through manage-all, so it can't be narrowed this way). See financial data
    // covers costs only and has no part in it.
    mockAuthAs('dispatcher');
    mockRoleSwitches({ cancel_jobs: true, view_invoices: false });
    mockPrisma.job.findUnique.mockResolvedValue(
      jobWith([invoice({ payments: [paid(3000)] })]),
    );
    wireCancelTx();

    const res = await cancel({ cancel_reason_code: 'OTHER', cancelled_reason: 'Customer called off' }, 'dispatcher');

    expect(res.status).toBe(409);
    expect(res.body.invoices).toEqual([
      { id: 'inv-open-1', invoice_number: 'I00412', status: 'PARTIAL', has_payments: true },
    ]);
    expect(res.body.error).not.toMatch(/\$|3000|3,000/);
  });
});

describe('POST /api/jobs/bulk-status {action:cancel} - the same guard (#891)', () => {
  // bulk-status validates `ids` as uuids, and JOB_FIXTURE.id is not one.
  const BULK_PAID = 'a0000000-0000-0000-0000-00000000000a';
  const BULK_FREE = 'a0000000-0000-0000-0000-00000000000b';

  it('fails the job with a paid open invoice in isolation and voids nothing on it', async () => {
    (prisma as unknown as { job: { findFirst: ReturnType<typeof vi.fn> } }).job.findFirst.mockResolvedValue({ id: BULK_PAID });
    mockPrisma.job.findUnique
      .mockResolvedValueOnce({ ...jobWith([invoice({ payments: [paid(3000)] })]), id: BULK_PAID })
      .mockResolvedValueOnce({ ...jobWith([]), id: BULK_FREE });
    const { txInvoiceUpdate } = wireCancelTx();

    const res = await request(app)
      .post('/api/jobs/bulk-status')
      .set(authHeader('admin'))
      .send({ ids: [BULK_PAID, BULK_FREE], action: 'cancel', cancel_reason_code: 'OTHER', cancelled_reason: 'Customer called off' });

    expect(res.status).toBe(200);
    expect(res.body.updated).toEqual([BULK_FREE]);
    expect(res.body.failed).toHaveLength(1);
    // The failure is the payments conflict itself, not a generic crash of the handler.
    expect(res.body.failed[0]).toMatchObject({
      id: BULK_PAID,
      code: 'JOB_CANCEL_HAS_PAYMENTS',
      error: expect.stringContaining('I00412'),
    });
    expect(res.body.failed[0].error).not.toBe('Failed to cancel job');
    expect(txInvoiceUpdate).not.toHaveBeenCalled();
  });

  it('fails a job whose invoice is fully PAID when no choice is sent', async () => {
    (prisma as unknown as { job: { findFirst: ReturnType<typeof vi.fn> } }).job.findFirst.mockResolvedValue({ id: BULK_PAID });
    mockPrisma.job.findUnique
      .mockResolvedValueOnce({ ...jobWith([invoice({ status: 'PAID', amount_due: 0, payments: [paid(8400)] })]), id: BULK_PAID });
    wireCancelTx();

    const res = await request(app)
      .post('/api/jobs/bulk-status')
      .set(authHeader('admin'))
      .send({ ids: [BULK_PAID], action: 'cancel', cancel_reason_code: 'OTHER', cancelled_reason: 'Customer called off' });

    expect(res.status).toBe(200);
    expect(res.body.updated).toEqual([]);
    expect(res.body.failed).toEqual([
      expect.objectContaining({ id: BULK_PAID, code: 'JOB_CANCEL_HAS_PAYMENTS' }),
    ]);
  });

  it('with "void" chosen, cancels a job whose invoice is PAID and leaves that invoice alone', async () => {
    (prisma as unknown as { job: { findFirst: ReturnType<typeof vi.fn> } }).job.findFirst.mockResolvedValue({ id: BULK_PAID });
    mockPrisma.job.findUnique
      .mockResolvedValueOnce({ ...jobWith([invoice({ status: 'PAID', amount_due: 0, payments: [paid(8400)] })]), id: BULK_PAID });
    const { txInvoiceUpdate } = wireCancelTx();

    const res = await request(app)
      .post('/api/jobs/bulk-status')
      .set(authHeader('admin'))
      .send({ ids: [BULK_PAID], action: 'cancel', cancel_reason_code: 'OTHER', cancelled_reason: 'Customer called off', void_invoices: true });

    expect(res.status).toBe(200);
    expect(res.body.updated).toEqual([BULK_PAID]);
    expect(res.body.voided_invoice_ids).toEqual([]);
    expect(txInvoiceUpdate).not.toHaveBeenCalled();
  });

  it('carries the keep choice to every job in the batch, so a paid job cancels with its invoices untouched', async () => {
    (prisma as unknown as { job: { findFirst: ReturnType<typeof vi.fn> } }).job.findFirst.mockResolvedValue({ id: BULK_PAID });
    mockPrisma.job.findUnique
      .mockResolvedValueOnce({ ...jobWith([invoice({ payments: [paid(3000)] })]), id: BULK_PAID })
      .mockResolvedValueOnce({ ...jobWith([invoice({ id: 'inv-open-2', invoice_number: 'I00413', status: 'SENT' })]), id: BULK_FREE });
    const { txInvoiceUpdate } = wireCancelTx();

    const res = await request(app)
      .post('/api/jobs/bulk-status')
      .set(authHeader('admin'))
      .send({ ids: [BULK_PAID, BULK_FREE], action: 'cancel', cancel_reason_code: 'OTHER', cancelled_reason: 'Customer called off', void_invoices: false });

    expect(res.status).toBe(200);
    expect(res.body.updated).toEqual([BULK_PAID, BULK_FREE]);
    expect(res.body.failed).toEqual([]);
    expect(res.body.voided_invoice_ids).toEqual([]);
    expect(txInvoiceUpdate).not.toHaveBeenCalled();
  });
});

describe('POST /api/jobs/:id/status {status:CANCELLED} - the same choice (#891)', () => {
  it('passes the keep choice through to the cancel', async () => {
    mockPrisma.job.findUnique.mockResolvedValue(jobWith([invoice({ payments: [paid(3000)] })]));
    const { txInvoiceUpdate, txJobUpdate } = wireCancelTx();

    const res = await request(app)
      .post(`/api/jobs/${JOB_ID}/status`)
      .set(authHeader('admin'))
      .send({ status: 'CANCELLED', cancel_reason_code: 'OTHER', cancelled_reason: 'Customer called off', void_invoices: false });

    expect(res.status).toBe(200);
    expect(txJobUpdate).toHaveBeenCalled();
    expect(txInvoiceUpdate).not.toHaveBeenCalled();
  });

  it('refuses with the payments conflict when no choice is sent', async () => {
    mockPrisma.job.findUnique.mockResolvedValue(jobWith([invoice({ payments: [paid(3000)] })]));
    wireCancelTx();

    const res = await request(app)
      .post(`/api/jobs/${JOB_ID}/status`)
      .set(authHeader('admin'))
      .send({ status: 'CANCELLED', cancel_reason_code: 'OTHER', cancelled_reason: 'Customer called off' });

    expect(res.status).toBe(409);
    expect(res.body.code).toBe('JOB_CANCEL_HAS_PAYMENTS');
  });
});

describe('GET /api/jobs/cancel-preview - what a bulk cancel keeps (#891)', () => {
  // The bulk cancel dialog has no per-job invoice list of its own; this read names the invoices
  // carrying money that the cancel will keep, PAID included, before the user confirms.
  const JOB_A = 'a0000000-0000-0000-0000-00000000000a';
  const JOB_B = 'a0000000-0000-0000-0000-00000000000b';
  const findMany = (prisma as unknown as { job: { findMany: ReturnType<typeof vi.fn> } }).job.findMany;

  function preview(ids: string, as: 'admin' | 'dispatcher' = 'admin') {
    return request(app).get('/api/jobs/cancel-preview').query({ ids }).set(authHeader(as));
  }

  it('lists every invoice carrying money on the selected jobs, PAID included, with what was paid', async () => {
    findMany.mockResolvedValue([
      { ...jobWith([
        invoice({ id: 'inv-paid', invoice_number: 'I00411', status: 'PAID', amount_due: 0, payments: [paid(8400)] }),
        invoice({ id: 'inv-unpaid', invoice_number: 'I00413', status: 'SENT' }),
      ]), id: JOB_A, job_number: 'J-1001' },
      { ...jobWith([invoice({ id: 'inv-part', invoice_number: 'I00412', payments: [paid(1000), paid(500, 'PROCESSING')] })]), id: JOB_B, job_number: 'J-1002' },
    ]);

    const res = await preview(`${JOB_A},${JOB_B}`);

    expect(res.status).toBe(200);
    expect(res.body.invoices).toEqual([
      { job_id: JOB_A, job_number: 'J-1001', id: 'inv-paid', invoice_number: 'I00411', status: 'PAID', amount_paid: 8400 },
      { job_id: JOB_B, job_number: 'J-1002', id: 'inv-part', invoice_number: 'I00412', status: 'PARTIAL', amount_paid: 1000, amount_processing: 500 },
    ]);
    expect(findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ id: { in: [JOB_A, JOB_B] }, organization_id: expect.any(String) }),
    }));
  });

  it('does not list a Done job\'s invoices as kept: the cancel refuses that job and keeps nothing of it', async () => {
    findMany.mockResolvedValue([
      { ...jobWith([invoice({ id: 'inv-done', invoice_number: 'I00420', status: 'PAID', amount_due: 0, payments: [paid(500)] })]), id: JOB_A, job_number: 'J-1001', status: 'DONE' },
      { ...jobWith([invoice({ id: 'inv-live', invoice_number: 'I00421', status: 'PAID', amount_due: 0, payments: [paid(300)] })]), id: JOB_B, job_number: 'J-1002' },
    ]);

    const res = await preview(`${JOB_A},${JOB_B}`);

    expect(res.status).toBe(200);
    expect(res.body.invoices.map((i: { id: string }) => i.id)).toEqual(['inv-live']);
  });

  it('names the invoices but withholds the amounts from a caller who cannot read invoices', async () => {
    mockAuthAs('dispatcher');
    mockRoleSwitches({ cancel_jobs: true, view_invoices: false });
    findMany.mockResolvedValue([
      { ...jobWith([invoice({ id: 'inv-paid', invoice_number: 'I00411', status: 'PAID', amount_due: 0, payments: [paid(8400)] })]), id: JOB_A, job_number: 'J-1001' },
    ]);

    const res = await preview(JOB_A, 'dispatcher');

    expect(res.status).toBe(200);
    expect(res.body.invoices).toEqual([
      { job_id: JOB_A, job_number: 'J-1001', id: 'inv-paid', invoice_number: 'I00411', status: 'PAID' },
    ]);
  });

  it('refuses a caller who cannot cancel jobs', async () => {
    mockAuthAs('dispatcher');
    mockRoleGrantsWithout('DISPATCHER', ['cancel', 'Job']);

    const res = await preview(JOB_A, 'dispatcher');

    expect(res.status).toBe(403);
    expect(findMany).not.toHaveBeenCalled();
  });

  it('rejects ids that are not uuids', async () => {
    const res = await preview('not-a-uuid');

    expect(res.status).toBe(400);
    expect(findMany).not.toHaveBeenCalled();
  });
});
