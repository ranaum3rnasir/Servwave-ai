import { test, expect } from '@playwright/test';
import { ApiClient } from '../../helpers/api-client';
import {
  fullStandardFlowCompleted,
  urgentJobWithAttachments,
  createTaxExemptCustomerWithLocation,
  createNewLead,
  createTech,
  leadToSentEstimateWithDeposit,
  fullStandardFlowToInvoiceSent,
} from '../../helpers/workflow-builders';

// ──────────────────────────────────────────────────────────
// Day 6 — Late afternoon: Marcus creates invoices.
// Multiple payment scenarios: CASH, partial, Stripe webhook,
// void, tax-exempt, public portal access — plus the urgent
// (no-estimate) invoicing gap (rejected until Phase 8).
// ──────────────────────────────────────────────────────────

test.describe('Day 6 — Invoicing & Payments', () => {
  test.describe.configure({ timeout: 120_000 });

  let api: ApiClient;
  let stripeAvailable = false;

  // Standard flow completed (tests 1-3)
  let sarahJobId: string;
  let sarahInvoiceId: string;
  let sarahInvoice: any;
  let sarahPublicToken: string;

  // Urgent flow (tests 4-5)
  // 2026-06-10 catalog-§5 contradiction fix (§5.1): urgentInvoiceId/urgentInvoice removed —
  // the no-estimate invoice is rejected by the current backend, so no invoice exists to share.
  // — verify at baseline run
  let urgentJobId: string;

  // Tax-exempt (tests 6-7)
  let taxExemptInvoiceId: string;
  let taxExemptInvoice: any;

  // Partial payment + Stripe (tests 8-9)
  let apexInvoiceId: string;
  let apexInvoice: any;

  test.beforeAll(async ({ }, testInfo) => {
    testInfo.setTimeout(120_000);
    api = await new ApiClient().init();
    await api.cleanup();

    // Standard flow → COMPLETED job for tests 1-3
    const stdCtx = await fullStandardFlowCompleted(api);
    sarahJobId = stdCtx.jobId;

    // Urgent flow → COMPLETED job with attachments for tests 4-5
    const urgentCtx = await urgentJobWithAttachments(api);
    urgentJobId = urgentCtx.jobId;

    // Probe Stripe availability
    try {
      const probeCtx = await leadToSentEstimateWithDeposit(api, ['CARD']);
      const { res } = await api.approveEstimatePublic(probeCtx.estimateId, probeCtx.publicToken, {
        signature_data: api.testSignature,
        payment_method: 'CARD',
      });
      stripeAvailable = res.status() === 200;
    } catch {
      stripeAvailable = false;
    }
  });

  test.afterAll(async () => {
    await api.dispose();
  });

  // ─── Tests 1-3: Sarah's HVAC invoice — CASH payment ─────

  test('create invoice from Sarah\'s completed HVAC job', async () => {
    const { res, body } = await api.createInvoice(sarahJobId);
    expect(res.status()).toBe(201);

    sarahInvoiceId = body.invoice.id;
    sarahInvoice = body.invoice;

    expect(body.invoice.status).toBe('DRAFT');
    expect(Number(body.invoice.subtotal)).toBeGreaterThan(0);
    expect(Number(body.invoice.tax_amount)).toBeGreaterThan(0);
    // fullStandardFlowCompleted has no deposit, so deposit_credit = 0
    expect(Number(body.invoice.deposit_credit)).toBe(0);
    expect(Number(body.invoice.amount_due)).toBe(Number(body.invoice.total_amount));
  });

  test('send Sarah\'s invoice — due today (COD)', async () => {
    const { res, body } = await api.sendInvoice(sarahInvoiceId);
    expect(res.status()).toBe(200);

    sarahInvoice = body.invoice;
    sarahPublicToken = body.invoice.public_token;

    expect(body.invoice.status).toBe('SENT');
    expect(body.invoice.public_token).toBeTruthy();
    expect(body.invoice.sent_at).toBeTruthy();

    // Residential customer — COD, due_date should be same day as sent_at
    const sentDate = new Date(body.invoice.sent_at).toISOString().slice(0, 10);
    const dueDate = new Date(body.invoice.due_date).toISOString().slice(0, 10);
    expect(dueDate).toBe(sentDate);
  });

  test('Sarah pays remaining balance with CASH — invoice PAID', async () => {
    const { res, body } = await api.recordPayment(sarahInvoiceId, {
      amount: Number(sarahInvoice.amount_due),
      method: 'CASH',
      notes: 'Collected on-site by technician',
    });
    expect(res.status()).toBe(201);
    expect(body.invoice.status).toBe('PAID');
    expect(Number(body.invoice.amount_due)).toBe(0);
  });

  // ─── Tests 4-5: Urgent plumbing job — invoicing severed (Phase-8 gap) ──

  test('no-estimate plumbing invoice rejected — 400 no line items (Phase-8 gap)', async () => {
    // 2026-06-10 catalog-§5 contradiction fix (§5.1): invoice.controller.ts create 400s when the
    // job has no estimate lines — every no-estimate job. The old row expected a 201 empty invoice
    // (subtotal 0) and sent it; urgent invoicing stays severed until Phase 8 ships invoice-owned
    // lines (catalog COL-04/P3, mirrors active STD-12). — verify at baseline run
    const { res: createRes, body: createBody } = await api.createInvoice(urgentJobId);
    expect(createRes.status()).toBe(400);
    expect(createBody.error).toBe('Cannot create invoice with no line items');
  });

  test('no-estimate job stays uninvoiced — nothing billed', async () => {
    // 2026-06-10 catalog-§5 contradiction fix (§5.1): this row consumed the empty SENT invoice
    // (asserted amount_due 0). No invoice exists now — assert the job's billing state instead:
    // COMPLETED with amount_invoiced untouched. — verify at baseline run
    const job = await api.getJob(urgentJobId);
    expect(job.status).toBe('COMPLETED');
    expect(Number(job.amount_invoiced ?? 0)).toBe(0);
  });

  // ─── Tests 6-7: Tax-exempt Austin ISD invoice ────────────

  test('tax-exempt invoice — Austin ISD, zero tax', async () => {
    test.slow();

    // Create tax-exempt customer
    const { customerId, locationId } = await createTaxExemptCustomerWithLocation(api);

    // Create and contact lead
    const { lead } = await createNewLead(api, customerId);
    await api.contactLead(lead.id);

    // Walkthrough
    const salesId = (await api.createUser({
      email: `sales-isd.${api.suffix}@e2e.local`,
      password: 'Test123!@#',
      first_name: 'Jennifer',
      last_name: 'Adams',
      role: 'SALES',
    })).body.user.id;
    await api.scheduleWalkthrough(lead.id, {
      walkthrough_scheduled_at: api.futureDate(24),
      walkthrough_assigned_to: salesId,
    });
    await api.completeWalkthrough(lead.id);

    // Create estimate with 0 tax
    const { body: estBody } = await api.createEstimate({
      lead_id: lead.id,
      line_items: [
        { description: 'Commercial HVAC maintenance — 4 rooftop units', quantity: 1, unit_price: 1200, is_taxable: false },
        { description: 'Filter replacement (4x 20x25x4 MERV 13)', quantity: 4, unit_price: 45, is_taxable: false },
      ],
      tax_rate: 0,
      scope_notes: 'Quarterly preventive maintenance — Austin ISD Building C',
    });
    const estimateId = estBody.estimate.id;

    // Send estimate (no deposit for government)
    const { body: sentEstBody } = await api.sendEstimate(estimateId, {
      deposit_required: false,
    });
    const publicToken = sentEstBody.estimate.public_token;

    // Approve
    await api.approveEstimatePublic(estimateId, publicToken, {
      signature_data: api.testSignature,
    });

    // Create job, assign, start, complete
    const { body: jobBody } = await api.createJob({ estimate_id: estimateId });
    const jobId = jobBody.job.id;
    const techId = await createTech(api);
    await api.assignJob(jobId, {
      assigned_to: techId,
      scheduled_start: api.futureDate(48),
      scheduled_end: api.futureDate(52),
    });
    await api.startJob(jobId);
    await api.completeJob(jobId,
      'Completed quarterly PM on all 4 rooftop Carrier units (Bldg C). Replaced MERV 13 filters, ' +
      'checked refrigerant levels, cleaned condenser coils, verified economizer operation. All units nominal.',
    );

    // Create invoice
    const { res: invRes, body: invBody } = await api.createInvoice(jobId);
    expect(invRes.status()).toBe(201);

    taxExemptInvoiceId = invBody.invoice.id;
    taxExemptInvoice = invBody.invoice;

    expect(Number(invBody.invoice.tax_amount)).toBe(0);
  });

  test('send Austin ISD invoice — due NET 60', async () => {
    const { res, body } = await api.sendInvoice(taxExemptInvoiceId);
    expect(res.status()).toBe(200);
    expect(body.invoice.status).toBe('SENT');
    taxExemptInvoice = body.invoice;

    // Verify due_date is approximately sent_at + 60 days
    const sentAt = new Date(body.invoice.sent_at);
    const dueDate = new Date(body.invoice.due_date);
    const diffDays = Math.round((dueDate.getTime() - sentAt.getTime()) / (1000 * 60 * 60 * 24));
    expect(diffDays).toBeGreaterThanOrEqual(59);
    expect(diffDays).toBeLessThanOrEqual(61);
  });

  // ─── Tests 8-9: Apex partial payment + Stripe remainder ──

  test('Apex partial payment (50%) — status PARTIAL', async () => {
    test.slow();

    const ctx = await fullStandardFlowToInvoiceSent(api);
    apexInvoiceId = ctx.invoiceId;
    apexInvoice = ctx.invoice;

    const halfAmount = Math.floor(Number(apexInvoice.amount_due) / 2);
    const { res, body } = await api.recordPayment(apexInvoiceId, {
      amount: halfAmount,
      method: 'CHECK',
      reference_number: `CHK-${api.suffix}`,
      notes: 'Partial payment — 50% upfront per agreement',
    });
    expect(res.status()).toBe(201);
    expect(body.invoice.status).toBe('PARTIAL');
    expect(Number(body.invoice.amount_due)).toBeGreaterThan(0);
    apexInvoice = body.invoice;
  });

  test('Apex remainder via Stripe webhook — invoice PAID', async () => {
    if (!stripeAvailable) {
      test.skip();
      return;
    }

    const remainingCents = Math.round(Number(apexInvoice.amount_due) * 100);
    const { res, body } = await api.fireStripeInvoiceWebhook({
      invoiceId: apexInvoiceId,
      amount_total: remainingCents,
    });
    expect(res.status()).toBe(200);

    // Fetch the invoice to verify final state
    const invoice = await api.getInvoice(apexInvoiceId);
    expect(invoice.status).toBe('PAID');
    expect(Number(invoice.amount_due)).toBe(0);
  });

  // ─── Test 10: Void a sent invoice ────────────────────────

  test('void a sent invoice — customer disputes charges', async () => {
    test.slow();

    const ctx = await fullStandardFlowToInvoiceSent(api);
    const { res, body } = await api.voidInvoice(
      ctx.invoiceId,
      'Customer disputes scope of work — requested re-estimate',
    );
    expect(res.status()).toBe(200);
    expect(body.invoice.status).toBe('VOIDED');
    expect(body.invoice.voided_reason).toBeTruthy();
  });

  // ─── Test 11: Public invoice portal access ───────────────

  test('public invoice access via customer portal', async () => {
    // Use Sarah's PAID invoice from test 3
    const { res, body } = await api.getPublicInvoice(sarahInvoiceId, sarahPublicToken);
    expect(res.status()).toBe(200);
    expect(body.invoice).toBeDefined();
    expect(body.invoice.id).toBe(sarahInvoiceId);
  });
});
