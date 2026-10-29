import { test, expect } from '@playwright/test';
import { ApiClient } from '../../helpers/api-client';
import {
  createCustomerWithLocation,
  createTech,
  fullStandardFlow,
  fullStandardFlowCompleted,
  fullStandardFlowToInvoiceSent,
  fullStandardFlowToInvoicePaid,
} from '../../helpers/workflow-builders';

// ──────────────────────────────────────────────────────────
// Day 8 — End of day: Guards, edge cases, math verification.
// Business rules enforcement and precise financial math.
// ──────────────────────────────────────────────────────────

test.describe('Day 8 — End of Day Edge Cases', () => {
  test.describe.configure({ timeout: 120_000 });

  let api: ApiClient;
  let baselineLeadStats: any;
  let baselineJobStats: any;

  test.beforeAll(async ({ }, testInfo) => {
    testInfo.setTimeout(120_000);
    api = await new ApiClient().init();
    await api.cleanup();

    // Capture baseline stats before tests create data
    baselineLeadStats = await api.getLeadStats();
    baselineJobStats = await api.getJobStats();
  });

  test.afterAll(async () => {
    await api.dispose();
  });

  test('overdue invoice — late payment still accepted', async () => {
    test.slow();
    const ctx = await fullStandardFlowToInvoiceSent(api);

    // Record payment with paid_at set 2 days in the future (past due_date for COD)
    const { res: payRes, body: payBody } = await api.recordPayment(ctx.invoiceId, {
      amount: Number(ctx.invoice.amount_due),
      method: 'CASH',
      paid_at: api.futureDate(48),
      notes: 'Late payment — accepted after due date',
    });
    expect(payRes.status()).toBe(201);
    expect(payBody.invoice.status).toBe('PAID');
  });

  test('cannot overpay an invoice', async () => {
    const ctx = await fullStandardFlowToInvoiceSent(api);

    // Attempt to pay more than amount_due
    const { res: payRes } = await api.recordPayment(ctx.invoiceId, {
      amount: Number(ctx.invoice.amount_due) + 100,
      method: 'CASH',
    });
    expect(payRes.status()).toBe(400);
  });

  test('cannot void a PAID invoice', async () => {
    const ctx = await fullStandardFlowToInvoicePaid(api);

    // Attempt to void a PAID invoice
    const { res: voidRes } = await api.voidInvoice(ctx.invoiceId, 'Trying to void after payment');
    expect(voidRes.status()).toBe(400);
  });

  test('cannot create invoice on non-COMPLETED job', async () => {
    // fullStandardFlow gives a SCHEDULED job (not completed)
    const ctx = await fullStandardFlow(api);

    // Attempt to create invoice on a SCHEDULED job — expect 400
    const { res: invRes } = await api.createInvoice(ctx.jobId);
    expect(invRes.status()).toBe(400);
  });

  test('cannot pay a DRAFT invoice', async () => {
    const ctx = await fullStandardFlowCompleted(api);

    // Create invoice but do NOT send it (stays DRAFT)
    const { body: invBody } = await api.createInvoice(ctx.jobId);
    const invoiceId = invBody.invoice.id;

    // Attempt to pay a DRAFT invoice — expect 400
    const { res: payRes } = await api.recordPayment(invoiceId, {
      amount: 100,
      method: 'CASH',
    });
    expect(payRes.status()).toBe(400);
  });

  test('cannot delete a SENT invoice', async () => {
    const ctx = await fullStandardFlowToInvoiceSent(api);

    // Attempt to delete a SENT invoice — expect 400
    const { res: delRes } = await api.deleteInvoice(ctx.invoiceId);
    expect(delRes.status()).toBe(400);
  });

  test('cannot mark WON lead as LOST', async () => {
    // fullStandardFlow creates a WON lead (estimate approved → job created)
    const ctx = await fullStandardFlow(api);

    // Verify lead is WON
    const lead = await api.getLead(ctx.leadId);
    expect(lead.status).toBe('WON');

    // Attempt to mark a WON lead as LOST — expect 400
    const { res: lostRes } = await api.markLeadLost(ctx.leadId, 'test reason');
    expect(lostRes.status()).toBe(400);
  });

  test('end-of-day stats reflect operations', async () => {
    const currentLeadStats = await api.getLeadStats();
    const currentJobStats = await api.getJobStats();

    // Tests in this file created data — counts should be greater than baseline
    const baselineLeadTotal = baselineLeadStats.total ?? 0;
    const currentLeadTotal = currentLeadStats.total ?? 0;
    expect(currentLeadTotal).toBeGreaterThan(baselineLeadTotal);

    const baselineJobTotal = baselineJobStats.total ?? 0;
    const currentJobTotal = currentJobStats.total ?? 0;
    expect(currentJobTotal).toBeGreaterThan(baselineJobTotal);
  });

  test('mixed taxable/non-taxable invoice math verification', async () => {
    test.slow();

    // Inline full chain with specific line items for math verification
    const { customerId } = await createCustomerWithLocation(api);
    const { res: leadRes, body: leadBody } = await api.createLead({
      customer_id: customerId,
      service_request: 'Water heater replacement — 50gal tank',
    });
    expect(leadRes.status()).toBe(201);
    const leadId = leadBody.lead.id;

    await api.contactLead(leadId);

    // Create estimate with specific mixed taxable/non-taxable items
    const { body: estBody } = await api.createEstimate({
      lead_id: leadId,
      line_items: [
        { description: 'Equipment — Rheem 50gal water heater', quantity: 1, unit_price: 850, is_taxable: false },
        { description: 'Installation labor', quantity: 4, unit_price: 125, is_taxable: true },
        { description: 'Expansion tank + supply lines', quantity: 1, unit_price: 185, is_taxable: true },
      ],
      tax_rate: 0.0825,
      scope_notes: 'Full water heater replacement with expansion tank',
    });
    const estimateId = estBody.estimate.id;

    // Send estimate (no deposit)
    const { body: sentBody } = await api.sendEstimate(estimateId, { deposit_required: false });
    const publicToken = sentBody.estimate.public_token;

    // Customer approves
    const { res: approveRes } = await api.approveEstimatePublic(estimateId, publicToken, {
      signature_data: api.testSignature,
    });
    expect(approveRes.status()).toBe(200);

    // Create job, assign tech, start, complete
    const { body: jobBody } = await api.createJob({ estimate_id: estimateId });
    const jobId = jobBody.job.id;

    const techId = await createTech(api);
    await api.assignJob(jobId, {
      assigned_to: techId,
      scheduled_start: api.futureDate(24),
      scheduled_end: api.futureDate(28),
    });
    await api.startJob(jobId);
    await api.completeJob(jobId, 'Water heater installed. Expansion tank and supply lines connected. No leaks.');

    // Create invoice
    const { body: invBody } = await api.createInvoice(jobId);
    const invoiceId = invBody.invoice.id;

    // Get invoice and verify math precisely
    const invoice = await api.getInvoice(invoiceId);

    // Expected calculations:
    // subtotal = 850 + (4 * 125) + 185 = 850 + 500 + 185 = 1535
    // taxable_base = (4 * 125) + 185 = 500 + 185 = 685
    // tax_amount = 685 * 0.0825 = 56.5125 → rounded to 56.51
    // total = 1535 + 56.51 = 1591.51
    // amount_due = 1591.51

    const subtotal = Number(invoice.subtotal);
    const taxAmount = Number(invoice.tax_amount);
    const totalAmount = Number(invoice.total_amount);
    const amountDue = Number(invoice.amount_due);

    expect(subtotal).toBeCloseTo(1535, 2);
    expect(taxAmount).toBeCloseTo(56.51, 2);
    expect(totalAmount).toBeCloseTo(1591.51, 2);
    expect(amountDue).toBeCloseTo(1591.51, 2);
  });
});
