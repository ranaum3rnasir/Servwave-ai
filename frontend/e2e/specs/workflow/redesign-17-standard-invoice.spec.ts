import { test, expect } from '@playwright/test';
import { ApiClient } from '../../helpers/api-client';
import {
  maEstimateSentWithDeposit,
  createMaCustomerWithLocation,
  createTaxExemptCustomerWithLocation,
  createSalesUser,
  createCustomerWithLocation,
  scheduleJobOnly,
} from '../../helpers/workflow-builders';
import { assertInvoiceReconciles } from '../../helpers/reconcile';
import { flagKnownBug } from '../../helpers/known-bug';

let api: ApiClient;

test.beforeAll(async () => { api = await new ApiClient().init(); });
test.afterAll(async () => { await api.dispose(); });

// ─── Local helpers (use documented ApiClient surface only) ───────────────────

/**
 * Parse the numeric part of an invoice_number (e.g. "I00042" -> 42, "INV-2026-0042" -> 20260042).
 * Strips EVERY non-digit before Number() so an alpha/dashed prefix never yields NaN, and returns
 * a sentinel of -1 for a null/blank/no-digit value so a baseline reduce is never poisoned by NaN.
 */
function invNum(invoiceNumber: string | null | undefined): number {
  const digits = String(invoiceNumber ?? '').replace(/\D+/g, '');
  return digits.length ? Number(digits) : -1;
}

/**
 * Seed a STANDARD invoice on a fully completed job that has a paid deposit.
 * Returns the deposit/estimate/job context plus the created STANDARD invoice (re-GET'd).
 *
 * amount = taxable line total; depositPct pins the org deposit %.
 */
async function seedStandardInvoiceFromDeposit(
  api: ApiClient, amount: number, depositPct: number,
) {
  const ctx = await maEstimateSentWithDeposit(api, amount, depositPct);
  const dep = await api.getDepositInvoice(ctx.estimateId);
  // Pay the deposit on its tax-inclusive total via the real record-payment endpoint.
  await api.markDepositReceived(ctx.estimateId, {
    payment_method: 'CHECK', amount: Number(dep.total_amount),
  });
  const { body: jobBody } = await api.createJob({ estimate_id: ctx.estimateId });
  const jobId = jobBody.job.id;
  await scheduleJobOnly(api, jobId);
  await api.startJob(jobId);
  await api.completeJob(jobId, 'work completed');
  const { body: invBody } = await api.createInvoice(jobId);
  const invoice = await api.getInvoice(invBody.invoice.id);
  return { ...ctx, jobId, depositInvoice: dep, invoice, invoiceId: invoice.id };
}

/**
 * Build a tax-EXEMPT MA-region estimate (sent, no deposit) through the walkthrough gate,
 * approve it, create + complete the job, and return the completed job id + estimate.
 */
async function taxExemptCompletedJob(api: ApiClient, amount: number) {
  const { customerId, locationId } = await createTaxExemptCustomerWithLocation(api);
  const { body: leadBody } = await api.createLead({
    customer_id: customerId, service_request: `taxexempt-${api.suffix}`, service_location_id: locationId,
  });
  const leadId = leadBody.lead.id;
  await api.contactLead(leadId);
  const performerId = await createSalesUser(api);
  await api.scheduleWalkthrough(leadId, {
    walkthrough_scheduled_at: api.futureDate(24),
    performer_ids: [performerId],
  });
  await api.completeWalkthrough(leadId);
  const { body: estBody } = await api.createEstimate({
    lead_id: leadId,
    line_items: [{ description: 'Full job', quantity: 1, unit_price: amount, is_taxable: true }],
  });
  const estimateId = estBody.estimate.id;
  // No deposit required.
  const { body: sentBody } = await api.sendEstimate(estimateId, {
    deposit_required: false, payment_methods: ['CHECK', 'CASH'],
  });
  await api.approveEstimatePublic(estimateId, sentBody.estimate.public_token, {
    signature_data: api.testSignature,
  });
  const { body: jobBody } = await api.createJob({ estimate_id: estimateId });
  const jobId = jobBody.job.id;
  await scheduleJobOnly(api, jobId);
  await api.startJob(jobId);
  await api.completeJob(jobId, 'tax-exempt job done');
  return { customerId, locationId, leadId, estimateId, jobId };
}

test.describe('Stage 7 — Standard invoice (redesign §5/§6)', () => {
  test('STD-01: first STANDARD invoice snapshots the estimate line items', async () => {
    const { estimateId, invoice } = await seedStandardInvoiceFromDeposit(api, 100_000, 30);
    const estimate = await api.getEstimate(estimateId);
    const estLines: any[] = estimate.line_items ?? [];
    const invLines: any[] = invoice.line_items ?? [];

    expect(invLines.length).toBeGreaterThan(0);
    expect(invLines.length).toBe(estLines.length);
    // Field parity: description/quantity/unit_price/is_taxable are snapshotted verbatim.
    const estByDesc = new Map(estLines.map((l) => [l.description, l]));
    for (const il of invLines) {
      const el = estByDesc.get(il.description);
      expect(el, `estimate line for "${il.description}"`).toBeTruthy();
      expect(Number(il.quantity)).toBe(Number(el.quantity));
      expect(Number(il.unit_price)).toBe(Number(el.unit_price));
      expect(Boolean(il.is_taxable)).toBe(Boolean(el.is_taxable));
    }
    await assertInvoiceReconciles(api, invoice.id, 'STD-01');
  });

  test('STD-02: a second invoice on the same job is BLOCKED with 409 — one active invoice per job, no double-billing', async () => {
    // FIXED (invoice.controller.ts create): a 2nd invoice on a job that already has a non-VOIDED
    // STANDARD invoice is rejected with HTTP 409 naming the existing invoice_number, and no second
    // invoice row is created — closing the double-billing path. (A VOIDED prior still allows one;
    // see STD-03/STD-10.)
    const { jobId, invoiceId, invoice } = await seedStandardInvoiceFromDeposit(api, 80_000, 30);

    const { res: secondRes, body: secondBody } = await api.createInvoice(jobId);
    expect(secondRes.status()).toBe(409);
    // The error names the existing invoice so the user knows what to void/edit.
    expect(String(secondBody.error)).toMatch(/already has an invoice/i);
    expect(String(secondBody.error)).toContain(invoice.invoice_number);
    // No second invoice was minted — the 409 body carries no invoice payload.
    expect(secondBody.invoice).toBeUndefined();

    // The job still resolves to exactly ONE invoice — the seeded first invoice (the deposit
    // invoice is anchored to the estimate, not the job, so the job carries only the STANDARD one).
    const job = await api.getJob(jobId);
    const jobInvoices: any[] = job.invoices ?? [];
    expect(jobInvoices.length).toBe(1);
    expect(jobInvoices[0].id).toBe(invoiceId);
    await assertInvoiceReconciles(api, invoiceId, 'STD-02');
  });

  test('STD-03: voiding the first STANDARD lets a re-created invoice re-snapshot', async () => {
    const { jobId, estimateId, invoiceId } = await seedStandardInvoiceFromDeposit(api, 60_000, 30);
    const estimate = await api.getEstimate(estimateId);
    const estLineCount = (estimate.line_items ?? []).length;
    expect(estLineCount).toBeGreaterThan(0);

    // DRAFT cannot be voided ("Use DELETE") — must SEND first, then void.
    await api.sendInvoice(invoiceId);
    const { res: voidRes, body: voidBody } = await api.voidInvoice(invoiceId, 'void to re-issue');
    expect(voidRes.status()).toBe(200);
    expect(voidBody.invoice.status).toBe('VOIDED');

    // With no non-voided prior STANDARD, the re-create re-snapshots the estimate lines.
    const { body: reBody } = await api.createInvoice(jobId);
    const reissued = await api.getInvoice(reBody.invoice.id);
    expect((reissued.line_items ?? []).length).toBe(estLineCount);
    await assertInvoiceReconciles(api, reissued.id, 'STD-03');
  });

  test('STD-04: invoice change-order lines are UNVERIFIABLE — no line-add API', async () => {
    // There is NO endpoint to add/edit invoice line items. PATCH /api/invoices/:id only
    // accepts due_date (DRAFT only). Assert the real limitation: a non-due_date PATCH on a
    // DRAFT invoice does not add a line item (the field is ignored / rejected).
    const { invoiceId, invoice } = await seedStandardInvoiceFromDeposit(api, 50_000, 30);
    const beforeCount = (invoice.line_items ?? []).length;

    // Attempt to push an extra line item via PATCH — the editInvoiceSchema only knows due_date.
    await api.updateInvoice(invoiceId, {
      line_items: [{ description: 'Change order', quantity: 1, unit_price: 1234, is_taxable: true }],
    });
    const after = await api.getInvoice(invoiceId);
    // The line count is unchanged: there is no owned-line-add path.
    expect((after.line_items ?? []).length).toBe(beforeCount);
    await assertInvoiceReconciles(api, invoiceId, 'STD-04');

    flagKnownBug(test.info(), {
      id: 'STD-04',
      spec: '§5/§6',
      current: 'no API to add/edit invoice line items; PATCH /api/invoices/:id accepts only due_date (DRAFT). Change-order lines cannot be added via the API.',
      expected: 'owned-line / change-order editing on the invoice that raises total + reconciles (Phase 8 UI per spec §5/§6).',
    });
  });

  test('STD-05: tax-once worked example — subtotal 100000, tax 6250, amount_due 74375', async () => {
    const ctx = await maEstimateSentWithDeposit(api, 100_000, 30); // MA 6.25%, 30% deposit
    const dep = await api.getDepositInvoice(ctx.estimateId);
    // Deposit % applies to the TAX-INCLUSIVE estimate total: 100000 * 1.0625 * 30% = 31875.
    expect(Number(dep.total_amount)).toBe(31_875);
    // tax_amount is not selected on the estimate's deposit invoice; the deposit is non-taxable.
    expect(Number(dep.tax_amount ?? 0)).toBe(0);

    await api.markDepositReceived(ctx.estimateId, {
      payment_method: 'CHECK', amount: Number(dep.total_amount),
    });

    const { body: jobBody } = await api.createJob({ estimate_id: ctx.estimateId });
    await scheduleJobOnly(api, jobBody.job.id);
    await api.startJob(jobBody.job.id);
    await api.completeJob(jobBody.job.id, 'done');
    const { body: invBody } = await api.createInvoice(jobBody.job.id);
    const inv = await api.getInvoice(invBody.invoice.id);

    expect(Number(inv.subtotal)).toBe(100_000);        // full base taxed once
    expect(Number(inv.tax_amount)).toBe(6_250);        // 6.25% of 100,000, charged ONCE
    expect(Number(inv.deposit_credit)).toBe(31_875);   // tax-inclusive 30% deposit credited
    expect(Number(inv.total_amount)).toBe(106_250);    // 100,000 + 6,250
    expect(Number(inv.amount_due)).toBe(74_375);        // 106,250 − 31,875 (NOT 76,250)
    await assertInvoiceReconciles(api, inv.id, 'STD-05');
  });

  test('STD-06: tax-exempt customer end-to-end — tax 0, amount_due 100000', async () => {
    const { jobId } = await taxExemptCompletedJob(api, 100_000);
    const { body: invBody } = await api.createInvoice(jobId);
    const inv = await api.getInvoice(invBody.invoice.id);

    expect(Number(inv.subtotal)).toBe(100_000);
    expect(Number(inv.tax_amount)).toBe(0);            // tax_exempt guard short-circuits
    expect(Number(inv.deposit_credit)).toBe(0);        // no deposit
    expect(Number(inv.total_amount)).toBe(100_000);
    expect(Number(inv.amount_due)).toBe(100_000);      // == subtotal
    await assertInvoiceReconciles(api, inv.id, 'STD-06');
  });

  test('STD-07: a second invoice cannot double-tax the job — the 2nd create is BLOCKED with 409 (one active invoice per job)', async () => {
    // True proportional progress billing (two partial invoices each carrying a tax SLICE) is
    // intentionally not built. Rather than letting a 2nd invoice re-derive the FULL tax from the
    // estimate and tax the job twice, create() now BLOCKS the 2nd invoice with HTTP 409 while the
    // first STANDARD invoice is non-VOIDED. This row is a positive control for "one active invoice
    // per job — the job is taxed once, never twice."
    const { jobId, invoice } = await seedStandardInvoiceFromDeposit(api, 100_000, 30);
    expect(Number(invoice.tax_amount)).toBe(6_250); // the single invoice carries the full tax once

    const { res: secondRes, body: secondBody } = await api.createInvoice(jobId);
    expect(secondRes.status()).toBe(409);
    expect(String(secondBody.error)).toMatch(/already has an invoice/i);
    expect(String(secondBody.error)).toContain(invoice.invoice_number);
    // No second invoice was minted, so no second 6,250 tax charge exists.
    expect(secondBody.invoice).toBeUndefined();

    const job = await api.getJob(jobId);
    const jobInvoices: any[] = job.invoices ?? [];
    expect(jobInvoices.length).toBe(1); // the job is taxed exactly once via this one invoice
    expect(jobInvoices[0].id).toBe(invoice.id);
    await assertInvoiceReconciles(api, invoice.id, 'STD-07');
  });

  test('STD-08: no double deposit-credit — a 2nd invoice on a job is blocked, so credit cannot be reused', async () => {
    const { jobId, depositInvoice, invoice } = await seedStandardInvoiceFromDeposit(api, 100_000, 30);
    const depositTotal = Number(depositInvoice.total_amount); // 31875
    const firstCredit = Number(invoice.deposit_credit);
    expect(firstCredit).toBeGreaterThan(0);

    // A 2nd invoice on the same job is now BLOCKED (one active invoice per job), so the deposit
    // credit drawn by the first invoice can never be re-applied by a second → no double-credit
    // is possible by construction.
    const { res: secondRes, body: secondBody } = await api.createInvoice(jobId);
    expect(secondRes.status()).toBe(409);
    expect(String(secondBody.error)).toMatch(/already has an invoice/i);

    // Invariant holds: the only STANDARD invoice draws ≤ the deposit total.
    expect(firstCredit).toBeLessThanOrEqual(depositTotal + 0.001);
    await assertInvoiceReconciles(api, invoice.id, 'STD-08');
  });

  test('STD-09: only due_date is editable on DRAFT; PATCH on SENT is rejected', async () => {
    // The "edit lines pre-send" half is not implementable (no line-edit API). The only editable
    // field is due_date, and update() rejects any non-DRAFT invoice.
    const { invoiceId } = await seedStandardInvoiceFromDeposit(api, 40_000, 30);

    // DRAFT: due_date edit succeeds.
    const newDue = api.futureDate(24 * 14);
    const { res: draftRes } = await api.updateInvoice(invoiceId, { due_date: newDue });
    expect(draftRes.status()).toBe(200);

    // Send it, then a due_date PATCH must be rejected (non-DRAFT).
    await api.sendInvoice(invoiceId);
    const { res: sentRes, body: sentBody } = await api.updateInvoice(invoiceId, { due_date: api.futureDate(24 * 21) });
    expect(sentRes.status()).toBe(400);
    expect(String(sentBody.error)).toMatch(/DRAFT/i);
    await assertInvoiceReconciles(api, invoiceId, 'STD-09');

    flagKnownBug(test.info(), {
      id: 'STD-09',
      spec: '§5/§6',
      current: 'no invoice line-edit API; only due_date is editable (DRAFT only). The "edit lines until sent" half is not implementable as written.',
      expected: 'edit-lines-until-sent semantics with line editing allowed pre-send and rejected post-send (spec §5/§6).',
    });
  });

  test('STD-10: void + reissue — voided invoice becomes VOIDED, reissue gets a new number', async () => {
    const { jobId, invoiceId, invoice } = await seedStandardInvoiceFromDeposit(api, 55_000, 30);
    const voidedNumber = invNum(invoice.invoice_number);

    await api.sendInvoice(invoiceId);
    const { res: voidRes, body: voidBody } = await api.voidInvoice(invoiceId, 'void + reissue');
    expect(voidRes.status()).toBe(200);
    expect(voidBody.invoice.status).toBe('VOIDED');

    const { body: reBody } = await api.createInvoice(jobId);
    const reissued = await api.getInvoice(reBody.invoice.id);
    expect(reissued.invoice_number).not.toBe(invoice.invoice_number);
    expect(invNum(reissued.invoice_number)).toBeGreaterThan(voidedNumber);
    await assertInvoiceReconciles(api, reissued.id, 'STD-10');
  });

  test('STD-11: invoice numbers are strictly monotonic (deposit + standard share one counter)', async () => {
    // Capture a baseline max across existing invoices (deltas only — never absolute counts).
    const { body: listBefore } = await api.listInvoices();
    const beforeRows: any[] = listBefore.invoices ?? listBefore.data ?? [];
    const baselineMax = beforeRows.reduce((mx, r) => Math.max(mx, invNum(r.invoice_number)), 0);

    // A fresh deposit + standard pair allocates from the same per-org counter.
    const { depositInvoice, invoice } = await seedStandardInvoiceFromDeposit(api, 33_000, 30);
    // The estimate.invoices[0] projection omits invoice_number — read the deposit's full record.
    const depFull = await api.getInvoice(depositInvoice.id);
    const depNum = invNum(depFull.invoice_number);
    const stdNum = invNum(invoice.invoice_number);

    // Every newly created invoice number is strictly greater than the baseline max.
    expect(depNum).toBeGreaterThan(baselineMax);
    expect(stdNum).toBeGreaterThan(baselineMax);
    // The standard invoice (created later) outranks the deposit invoice (created at send).
    expect(stdNum).toBeGreaterThan(depNum);
    await assertInvoiceReconciles(api, invoice.id, 'STD-11');
  });

  test('STD-12: orphan / customer-only invoice — both POST paths 400 (known limitation)', async () => {
    // Path A: a job with NO estimate (no lines) -> 400 "Cannot create invoice with no line items".
    const { customerId, locationId } = await createCustomerWithLocation(api);
    const { lead } = (await (async () => {
      const { body } = await api.createLead({
        customer_id: customerId, service_request: `orphan-${api.suffix}`, service_location_id: locationId,
      });
      return { lead: body.lead };
    })());
    await api.contactLead(lead.id);
    const { body: jobBody } = await api.createJob({
      customer_id: customerId, service_location_id: locationId,
    });
    const noLineJobId = jobBody.job.id;
    const { res: noLineRes, body: noLineBody } = await api.createInvoice(noLineJobId);
    expect(noLineRes.status()).toBe(400);
    expect(String(noLineBody.error)).toMatch(/no line items/i);

    // Path B: a customer-only POST (no job_id) -> 400 (Zod, job_id required).
    const { res: zodRes } = await api.raw('post', '/api/invoices', { customer_id: customerId });
    expect(zodRes.status()).toBe(400);

    flagKnownBug(test.info(), {
      id: 'STD-12',
      spec: '§5/§6',
      current: 'no owned-line invoice API; 400 on no lines (invoice.controller.ts:340) and no customer-only invoice POST path (job_id required by Zod).',
      expected: 'direct-job / orphan (customer-only) billing per spec §5/§6.',
    });
  });
});
