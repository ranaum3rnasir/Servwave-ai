import { test, expect } from '@playwright/test';
import { ApiClient } from '../helpers/api-client';
import {
  createTech,
  fullStandardFlowCompleted,
  fullStandardFlow,
  leadToSentEstimateWithDeposit,
  urgentJobWithAttachments,
} from '../helpers/workflow-builders';

test.describe('Invoice Workflow', () => {
  let api: ApiClient;

  test.beforeAll(async () => {
    api = await new ApiClient().init();
  });

  test.afterAll(async () => {
    await api.dispose();
  });

  // ─── Standard Flow ──────────────────────────────────────

  test.describe('Standard Flow', () => {
    let invoiceId: string;
    let publicToken: string;
    let amountDue: number;

    test('create invoice from completed job', async () => {
      const ctx = await fullStandardFlowCompleted(api);
      const { res, body } = await api.createInvoice(ctx.jobId);

      expect(res.status()).toBe(201);
      const invoice = body.invoice;
      invoiceId = invoice.id;

      expect(invoice.status).toBe('DRAFT');
      expect(Number(invoice.subtotal)).toBeGreaterThan(0);
      expect(Number(invoice.tax_amount)).toBeGreaterThanOrEqual(0);
      expect(Number(invoice.total_amount)).toBeGreaterThan(0);
      expect(Number(invoice.amount_due)).toBeGreaterThan(0);
      // total_amount = subtotal - discount + tax
      const expectedTotal = Number(invoice.subtotal) - Number(invoice.discount_amount || 0) + Number(invoice.tax_amount);
      expect(Number(invoice.total_amount)).toBeCloseTo(expectedTotal, 2);
      // DRAFT should not have public_token or sent_at
      expect(invoice.sent_at).toBeNull();
      amountDue = Number(invoice.amount_due);
    });

    test('send invoice', async () => {
      const { res, body } = await api.sendInvoice(invoiceId);

      expect(res.status()).toBe(200);
      const invoice = body.invoice;

      expect(invoice.status).toBe('SENT');
      expect(invoice.public_token).toBeTruthy();
      expect(invoice.sent_at).toBeTruthy();
      expect(invoice.due_date).toBeTruthy();
      publicToken = invoice.public_token;
    });

    test('record full payment', async () => {
      const { res, body } = await api.recordPayment(invoiceId, {
        amount: amountDue,
        method: 'CASH',
        notes: 'Collected on-site by technician',
      });

      expect(res.status()).toBe(201);
      const invoice = body.invoice;

      expect(invoice.status).toBe('PAID');
      expect(Number(invoice.amount_due)).toBe(0);
      expect(invoice.paid_at).toBeTruthy();
      expect(body.payment).toBeTruthy();
      expect(Number(body.payment.amount)).toBe(amountDue);
    });

    test('verify public invoice access', async () => {
      const { res, body } = await api.getPublicInvoice(invoiceId, publicToken);

      expect(res.status()).toBe(200);
      expect(body.invoice).toBeTruthy();
      expect(body.invoice.id).toBe(invoiceId);
      expect(body.invoice.invoice_number).toBeTruthy();
      expect(Number(body.invoice.total_amount)).toBeGreaterThan(0);
    });
  });

  // ─── No-Estimate (formerly Urgent) Flow ─────────────────
  //
  // Entity-redesign Phase D: the urgent flow + JobCharge are retired. A no-estimate job's
  // invoice snapshots NO lines (the Invoice owns lines, and there is no API to add lines to a
  // no-estimate job's invoice), so subtotal/amount_due are 0. The old $435-charges assertions
  // are replaced with the empty-orphan-invoice reality (DRAFT, subtotal 0, deposit_credit 0).

  test.describe('No-Estimate Flow', () => {
    test('create invoice from a no-estimate job → empty DRAFT (no owned lines)', async () => {
      const ctx = await urgentJobWithAttachments(api);
      const { res, body } = await api.createInvoice(ctx.jobId);

      expect(res.status()).toBe(201);
      const invoice = body.invoice;

      expect(invoice.status).toBe('DRAFT');
      // No charges + no estimate snapshot ⇒ empty invoice.
      expect(Number(invoice.subtotal)).toBe(0);
      expect(Number(invoice.deposit_credit)).toBe(0);
    });

    test('send a no-estimate invoice → SENT with amount_due 0', async () => {
      const ctx = await urgentJobWithAttachments(api);
      const { body: invBody } = await api.createInvoice(ctx.jobId);
      const invoiceId = invBody.invoice.id;

      // Send
      const { res: sendRes, body: sentBody } = await api.sendInvoice(invoiceId);
      expect(sendRes.status()).toBe(200);
      expect(sentBody.invoice.status).toBe('SENT');
      // Empty invoice ⇒ nothing owed; there is no positive payment to record.
      expect(Number(sentBody.invoice.amount_due)).toBe(0);
    });
  });

  // ─── Deposit Credit Regression (KI-018) ─────────────────

  test.describe('Deposit Credit Regression', () => {
    test('invoice includes deposit-applied payment row when deposit was paid before job completion', async () => {
      const ctx = await leadToSentEstimateWithDeposit(api, ['CHECK', 'CASH', 'CARD']);

      const approve = await api.approveEstimatePublic(ctx.estimateId, ctx.publicToken, {
        signature_data: api.testSignature,
        payment_method: 'CHECK',
      });
      expect(approve.res.status()).toBe(200);

      const markDeposit = await api.markDepositReceived(ctx.estimateId, {
        reference_number: `DEP-${api.suffix}`,
        notes: 'Deposit collected before scheduling',
      });
      expect(markDeposit.res.status()).toBe(200);

      const { body: jobBody } = await api.createJob({ estimate_id: ctx.estimateId });
      const jobId = jobBody.job.id as string;
      const techId = await createTech(api);

      await api.assignJob(jobId, {
        assigned_to: techId,
        scheduled_start: api.futureDate(24),
        scheduled_end: api.futureDate(26),
      });
      await api.startJob(jobId);
      await api.completeJob(jobId, 'Completed work after confirmed deposit payment.');

      const { res, body } = await api.createInvoice(jobId);
      expect(res.status()).toBe(201);

      const invoice = body.invoice;
      expect(Number(invoice.deposit_credit)).toBeGreaterThan(0);
      expect(Number(invoice.amount_due)).toBeLessThan(Number(invoice.total_amount));

      const invoiceDetail = await api.getInvoice(invoice.id);
      const depositPayment = (invoiceDetail.payments || []).find(
        (p: any) => p.reference_number === 'DEPOSIT-CREDIT',
      );

      expect(depositPayment).toBeTruthy();
      expect(Number(depositPayment.amount)).toBeCloseTo(Number(invoice.deposit_credit), 2);
    });
  });

  // ─── Partial Payment ───────────────────────────────────

  test.describe('Partial Payment', () => {
    let invoiceId: string;
    let totalDue: number;

    test('partial payment transitions to PARTIAL', async () => {
      const ctx = await fullStandardFlowCompleted(api);
      const { body: invBody } = await api.createInvoice(ctx.jobId);
      invoiceId = invBody.invoice.id;

      await api.sendInvoice(invoiceId);
      const sent = await api.getInvoice(invoiceId);
      totalDue = Number(sent.amount_due);

      // Pay 50%
      const halfPayment = Math.round(totalDue * 50) / 100;
      const { res, body } = await api.recordPayment(invoiceId, {
        amount: halfPayment,
        method: 'CASH',
        notes: 'Partial payment collected on-site',
      });

      expect(res.status()).toBe(201);
      expect(body.invoice.status).toBe('PARTIAL');
      expect(Number(body.invoice.amount_due)).toBeGreaterThan(0);

      const expectedRemaining = Math.round((totalDue - halfPayment) * 100) / 100;
      expect(Number(body.invoice.amount_due)).toBeCloseTo(expectedRemaining, 2);
    });

    test('second payment completes invoice', async () => {
      // Get current amount_due
      const invoice = await api.getInvoice(invoiceId);
      const remaining = Number(invoice.amount_due);

      const { res, body } = await api.recordPayment(invoiceId, {
        amount: remaining,
        method: 'CHECK',
        reference_number: `CHK-${api.suffix}`,
        notes: 'Final balance paid by check',
      });

      expect(res.status()).toBe(201);
      expect(body.invoice.status).toBe('PAID');
      expect(Number(body.invoice.amount_due)).toBe(0);
      expect(body.invoice.paid_at).toBeTruthy();
    });
  });

  // ─── Void Flow ──────────────────────────────────────────

  test.describe('Void Flow', () => {
    test('void sent invoice', async () => {
      const ctx = await fullStandardFlowCompleted(api);
      const { body: invBody } = await api.createInvoice(ctx.jobId);
      const invoiceId = invBody.invoice.id;

      await api.sendInvoice(invoiceId);

      const { res, body } = await api.voidInvoice(invoiceId, 'Customer disputed charges — issuing credit');

      expect(res.status()).toBe(200);
      expect(body.invoice.status).toBe('VOIDED');
      expect(body.invoice.voided_at).toBeTruthy();
      expect(body.invoice.voided_reason).toBe('Customer disputed charges — issuing credit');
    });

    test('cannot void paid invoice', async () => {
      const ctx = await fullStandardFlowCompleted(api);
      const { body: invBody } = await api.createInvoice(ctx.jobId);
      const invoiceId = invBody.invoice.id;

      const { body: sentBody } = await api.sendInvoice(invoiceId);
      await api.recordPayment(invoiceId, {
        amount: Number(sentBody.invoice.amount_due),
        method: 'CASH',
      });

      const { res } = await api.voidInvoice(invoiceId, 'Trying to void after payment');
      expect(res.status()).toBe(400);
    });
  });

  // ─── Guards ─────────────────────────────────────────────

  test.describe('Guards', () => {
    test('cannot create invoice on non-completed job', async () => {
      // fullStandardFlow creates a SCHEDULED job (not completed)
      const ctx = await fullStandardFlow(api);
      const { res } = await api.createInvoice(ctx.jobId);
      expect(res.status()).toBe(400);
    });

    test('cannot record payment on draft invoice', async () => {
      const ctx = await fullStandardFlowCompleted(api);
      const { body: invBody } = await api.createInvoice(ctx.jobId);
      const invoiceId = invBody.invoice.id;

      // Invoice is DRAFT — attempt to pay without sending
      const { res } = await api.recordPayment(invoiceId, {
        amount: 100,
        method: 'CASH',
      });
      expect(res.status()).toBe(400);
    });

    test('cannot overpay', async () => {
      const ctx = await fullStandardFlowCompleted(api);
      const { body: invBody } = await api.createInvoice(ctx.jobId);
      const invoiceId = invBody.invoice.id;

      const { body: sentBody } = await api.sendInvoice(invoiceId);
      const amountDue = Number(sentBody.invoice.amount_due);

      const { res } = await api.recordPayment(invoiceId, {
        amount: amountDue + 0.01,
        method: 'CASH',
      });
      expect(res.status()).toBe(400);
    });

    test('cannot delete sent invoice', async () => {
      const ctx = await fullStandardFlowCompleted(api);
      const { body: invBody } = await api.createInvoice(ctx.jobId);
      const invoiceId = invBody.invoice.id;

      await api.sendInvoice(invoiceId);

      const { status } = await api.deleteInvoice(invoiceId);
      expect(status).toBe(400);
    });
  });

  // ─── Notes ──────────────────────────────────────────────

  test.describe('Notes', () => {
    test('add and retrieve invoice notes', async () => {
      const ctx = await fullStandardFlowCompleted(api);
      const { body: invBody } = await api.createInvoice(ctx.jobId);
      const invoiceId = invBody.invoice.id;

      // Add two notes
      const { res: note1Res } = await api.addInvoiceNote(invoiceId, 'Customer requested itemized breakdown');
      expect(note1Res.status()).toBe(201);

      const { res: note2Res } = await api.addInvoiceNote(invoiceId, 'Sent updated PDF via email');
      expect(note2Res.status()).toBe(201);

      // Retrieve notes
      const notesResult = await api.getInvoiceNotes(invoiceId);
      expect(notesResult.notes.length).toBeGreaterThanOrEqual(2);

      const contents = notesResult.notes.map((n: any) => n.content);
      expect(contents).toContain('Customer requested itemized breakdown');
      expect(contents).toContain('Sent updated PDF via email');
    });
  });

  // ─── Stripe Invoice Payment ─────────────────────────────

  test.describe('Stripe Invoice Payment', () => {
    test('stripe webhook pays invoice', async () => {
      const ctx = await fullStandardFlowCompleted(api);
      const { body: invBody } = await api.createInvoice(ctx.jobId);
      const invoiceId = invBody.invoice.id;

      const { body: sentBody } = await api.sendInvoice(invoiceId);
      const amountDue = Number(sentBody.invoice.amount_due);

      // Fire stripe webhook — amount_total is in cents
      const { res, body } = await api.fireStripeInvoiceWebhook({
        invoiceId,
        amount_total: Math.round(amountDue * 100),
      });

      expect(res.status()).toBe(200);

      // Verify invoice is now PAID
      const invoice = await api.getInvoice(invoiceId);
      expect(invoice.status).toBe('PAID');
      expect(Number(invoice.amount_due)).toBe(0);
      expect(invoice.paid_at).toBeTruthy();
    });
  });
});
