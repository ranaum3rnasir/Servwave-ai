import { test, expect } from '@playwright/test';
import { ApiClient } from '../../helpers/api-client';
import {
  maEstimateSentWithDeposit,
  createMaCustomerWithLocation,
  createSalesUser,
  uniquePhone,
  scheduleJobOnly,
} from '../../helpers/workflow-builders';
import { assertInvoiceReconciles, assertStatementReconciles } from '../../helpers/reconcile';

// ─── Stage 10 — Statement (entity-redesign §9) ───────────────────────────────
// GET /api/statements/job/:jobId and /api/statements/customer/:customerId project the §8
// ledger into a chronological lines[] (each line.type ∈ invoice|credit|deposit_credit|
// payment|refund, with line.running_balance) plus totals{billed,paid,refunded,credited,
// balance}. There is NO top-level body.balance and NO body.entries — read body.totals.balance
// and body.lines[] (each line.running_balance). buildStatement guarantees
//   totals.balance === billed − paid − credited + refunded === lines[last].running_balance,
// where a deposit_credit counts toward `paid` and a refund delta is +amount (raising the gap).

let api: ApiClient;

test.beforeAll(async () => { api = await new ApiClient().init(); });
test.afterAll(async () => { await api.dispose(); });

// ─── Local seeding helpers (documented ApiClient surface only) ───────────────

/**
 * The expected statement balance recomputed from its own totals (the §9 invariant).
 * Post-fix, `paid` (real cash) and `deposit_credit` (the synthetic DEPOSIT-CREDIT drawdown)
 * are SEPARATE accumulators, so both subtract from the balance:
 *   balance === billed − paid − deposit_credit − credited + refunded
 * (statement.controller.ts buildStatement totals section).
 */
function expectedBalanceFromTotals(totals: any): number {
  return (
    Number(totals.billed) - Number(totals.paid) - Number(totals.deposit_credit ?? 0)
    - Number(totals.credited) + Number(totals.refunded)
  );
}

/** Sum the magnitude of every line of a given type. */
function sumLines(lines: any[], type: string): number {
  return lines.filter((l) => l.type === type).reduce((s, l) => s + Number(l.amount), 0);
}

/**
 * Seed a full standard flow with a PAID deposit and a created STANDARD invoice.
 * Mirrors redesign-17's seedStandardInvoiceFromDeposit but keeps the deposit-invoice handle
 * (job_id=null) AND the standard-invoice id so statement scopes can be compared.
 *
 * amount = taxable line total (MA 6.25%); depositPct pins the org deposit %.
 */
async function seedDepositStandardFlow(api: ApiClient, amount: number, depositPct: number) {
  const ctx = await maEstimateSentWithDeposit(api, amount, depositPct);
  const dep = await api.getDepositInvoice(ctx.estimateId); // kind=DEPOSIT, job_id=null
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
  return {
    ...ctx, jobId, depositInvoice: dep, depositTotal: Number(dep.total_amount),
    invoice, invoiceId: invoice.id,
  };
}

/**
 * Drive a NO-deposit standard flow to a created+sent+paid STANDARD invoice for a
 * PRE-EXISTING customer/location (used by STM-03 to give a specific customer an invoice
 * whose invoice.customer_id === that customer). Returns the invoice id.
 */
async function seedPaidInvoiceForCustomer(
  api: ApiClient, customerId: string, locationId: string,
) {
  const { body: leadBody } = await api.createLead({
    customer_id: customerId, service_request: `stm-rollup-${api.suffix}`, service_location_id: locationId,
  });
  const leadId = leadBody.lead.id;
  await api.contactLead(leadId);
  const performerId = await createSalesUser(api); // SALES performer satisfies the walkthrough gate
  await api.scheduleWalkthrough(leadId, {
    walkthrough_scheduled_at: api.futureDate(24),
    performer_ids: [performerId],
  });
  await api.completeWalkthrough(leadId);
  const { body: estBody } = await api.createEstimate({
    lead_id: leadId,
    line_items: [{ description: 'Service', quantity: 1, unit_price: 1000, is_taxable: true }],
  });
  const estimateId = estBody.estimate.id;
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
  await api.completeJob(jobId, 'rollup job done');
  const { body: invBody } = await api.createInvoice(jobId);
  const invoiceId = invBody.invoice.id;
  const { body: paidSentBody } = await api.sendInvoice(invoiceId);
  await api.recordPayment(invoiceId, {
    amount: Number(paidSentBody.invoice.amount_due), method: 'CASH',
  });
  return { leadId, estimateId, jobId, invoiceId };
}

/**
 * Drive a NO-deposit standard flow to a created + SENT (NOT yet paid) STANDARD invoice for a
 * PRE-EXISTING customer/location. Used by STM-05: a SENT (or PARTIAL) invoice is the only state
 * voidInvoice accepts — a fully-PAID invoice is rejected with 400 (invoice.controller.ts:827).
 * Returns the invoice id and its SENT amount_due so the caller can record a partial payment.
 */
async function seedSentInvoiceForCustomer(
  api: ApiClient, customerId: string, locationId: string,
) {
  const { body: leadBody } = await api.createLead({
    customer_id: customerId, service_request: `stm-void-${api.suffix}`, service_location_id: locationId,
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
    line_items: [{ description: 'Service', quantity: 1, unit_price: 1000, is_taxable: true }],
  });
  const estimateId = estBody.estimate.id;
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
  await api.completeJob(jobId, 'void job done');
  const { body: invBody } = await api.createInvoice(jobId);
  const invoiceId = invBody.invoice.id;
  const { body: invSentBody } = await api.sendInvoice(invoiceId);
  return { leadId, estimateId, jobId, invoiceId, sentAmountDue: Number(invSentBody.invoice.amount_due) };
}

test.describe('Stage 10 — Statement (§9)', () => {
  test('STM-01: job statement — every event line + correct running balance', async () => {
    // Seed: deposit-bearing standard flow → STANDARD invoice (carries a synthetic
    // DEPOSIT-CREDIT payment), then add a real payment, a credit, and a refund.
    const { jobId, invoiceId, depositTotal } = await seedDepositStandardFlow(api, 100_000, 30);

    const invBeforePay = await api.getInvoice(invoiceId);
    const amountDue = Number(invBeforePay.amount_due); // 74_375 after deposit credit
    expect(amountDue).toBeGreaterThan(0);

    // Send the invoice so payments may be recorded (recordPayment requires SENT/PARTIAL).
    await api.sendInvoice(invoiceId);

    // (a) a credit on the invoice WHILE a balance is owed — this is the only path that emits
    //     a real `credit` ledger line (on a fully-paid invoice the give-back becomes a refund,
    //     not a credit). The credit lowers amount_due and drops the status to PARTIAL.
    const creditAmount = 1_000;
    const { res: creditRes } = await api.creditInvoice(invoiceId, {
      amount: creditAmount, reason: 'STM-01 goodwill credit', category: 'GOODWILL',
    });
    expect(creditRes.status()).toBe(200);
    await assertInvoiceReconciles(api, invoiceId, 'STM-01-after-credit');

    // (b) a real payment of the FULL remaining balance → the invoice reaches PAID (a precondition
    //     for the refund guard). recordPayment returns 201 (resource created), not 200.
    const dueAfterCredit = Number((await api.getInvoice(invoiceId)).amount_due);
    expect(dueAfterCredit).toBeGreaterThan(0);
    const { res: payRes } = await api.recordPayment(invoiceId, { amount: dueAfterCredit, method: 'CASH' });
    expect(payRes.status()).toBe(201);
    await assertInvoiceReconciles(api, invoiceId, 'STM-01-after-payment');

    // (c) a partial refund against the recorded payment — refundInvoice requires PAID/
    //     PARTIALLY_REFUNDED, which the full payment above satisfied. Returns 200.
    const refundAmount = 500;
    const { res: refundRes } = await api.refundInvoice(invoiceId, {
      amount: refundAmount, reason: 'STM-01 partial refund', reason_category: 'CUSTOMER_REQUEST',
    });
    expect(refundRes.status()).toBe(200);
    await assertInvoiceReconciles(api, invoiceId, 'STM-01-after-refund');

    // Statement (JOB scope): one line per ledger event with a running balance.
    const { res, body } = await api.getJobStatement(jobId);
    expect(res.status()).toBe(200);
    expect(body.scope).toBe('job');
    expect(Array.isArray(body.lines)).toBe(true);
    expect(body.lines.length).toBeGreaterThan(0);

    const lines: any[] = body.lines;
    // Job scope excludes the job_id=null DEPOSIT invoice; the single STANDARD invoice contributes
    // exactly one `invoice` billed line.
    expect(sumLines(lines, 'invoice')).toBeCloseTo(Number(body.totals.billed), 2);
    // The deposit shows up as exactly one synthetic DEPOSIT-CREDIT payment line (== deposit total).
    const depositCreditLines = lines.filter((l) => l.type === 'deposit_credit');
    expect(depositCreditLines.length).toBe(1);
    expect(Number(depositCreditLines[0].amount)).toBeCloseTo(depositTotal, 2);
    // A real payment line, a credit line, and a refund line each appear.
    expect(lines.some((l) => l.type === 'payment')).toBe(true);
    expect(lines.some((l) => l.type === 'credit')).toBe(true);
    expect(lines.some((l) => l.type === 'refund')).toBe(true);
    expect(sumLines(lines, 'credit')).toBeCloseTo(Number(body.totals.credited), 2);
    expect(sumLines(lines, 'refund')).toBeCloseTo(Number(body.totals.refunded), 2);
    // `paid` is real cash only; the synthetic deposit credit is its own total now (STM-02 fix).
    expect(sumLines(lines, 'payment')).toBeCloseTo(Number(body.totals.paid), 2);
    expect(sumLines(lines, 'deposit_credit')).toBeCloseTo(Number(body.totals.deposit_credit), 2);

    // Running balance: last line === headline === billed − paid − credited + refunded.
    const last = lines[lines.length - 1];
    expect(Number(last.running_balance)).toBeCloseTo(Number(body.totals.balance), 2);
    expect(Number(body.totals.balance)).toBeCloseTo(expectedBalanceFromTotals(body.totals), 2);

    // The shared reconcile helper (reads totals.balance + lines[last].running_balance).
    await assertStatementReconciles(api, { jobId }, 'STM-01');
  });

  test('STM-02: deposit counted ONCE — totals.paid is real cash only; deposit_credit holds the drawdown', async () => {
    // Deposit-bearing standard flow. Deposit D is paid (real cash on the kind=DEPOSIT invoice);
    // the STANDARD invoice receives its synthetic DEPOSIT-CREDIT payment for the same magnitude.
    // FIXED behavior (statement.controller buildStatement): the two are kept in SEPARATE
    // accumulators — real cash → totals.paid, the synthetic drawdown → totals.deposit_credit —
    // so the deposit is counted exactly ONCE in `paid`, NOT doubled. balance subtracts both.
    const { jobId, customerId, invoiceId, depositTotal } = await seedDepositStandardFlow(api, 100_000, 30);
    await assertInvoiceReconciles(api, invoiceId, 'STM-02-seed');

    // JOB scope: the job_id=null DEPOSIT invoice is excluded — only the STANDARD invoice + its
    // synthetic DEPOSIT-CREDIT payment appear. No real cash hit the STANDARD invoice.
    const { res: jobRes, body: jobBody } = await api.getJobStatement(jobId);
    expect(jobRes.status()).toBe(200);
    const jobLines: any[] = jobBody.lines;
    const jobDepositCreditLines = jobLines.filter((l) => l.type === 'deposit_credit');
    expect(jobDepositCreditLines.length).toBe(1);
    // Job scope: no real cash payment → totals.paid is 0; the drawdown lives in deposit_credit.
    expect(Number(jobBody.totals.paid)).toBeCloseTo(0, 2);
    expect(Number(jobBody.totals.deposit_credit)).toBeCloseTo(depositTotal, 2);
    expect(sumLines(jobLines, 'deposit_credit')).toBeCloseTo(depositTotal, 2);
    // Job-scope balance is the §9 invariant (billed − paid − deposit_credit − credited + refunded).
    expect(Number(jobBody.totals.balance)).toBeCloseTo(expectedBalanceFromTotals(jobBody.totals), 2);
    await assertStatementReconciles(api, { jobId }, 'STM-02-job');

    // CUSTOMER scope: the DEPOSIT invoice (customer_id === this customer, job_id=null) IS included,
    // so its REAL deposit payment is the only `payment` (real cash) entry, while the STANDARD
    // invoice's synthetic DEPOSIT-CREDIT is the only `deposit_credit` entry. The deposit money is
    // therefore represented ONCE in each accumulator — never doubled inside totals.paid.
    const { res: custRes, body: custBody } = await api.getCustomerStatement(customerId);
    expect(custRes.status()).toBe(200);
    const custLines: any[] = custBody.lines;

    // FIXED: totals.paid is REAL CASH ONLY — exactly the single deposit payment (counted once,
    // NOT doubled). The synthetic drawdown is NOT folded in.
    expect(Number(custBody.totals.paid)).toBeCloseTo(depositTotal, 2);
    expect(sumLines(custLines, 'payment')).toBeCloseTo(depositTotal, 2);
    expect(custLines.filter((l) => l.type === 'payment').length).toBe(1);

    // FIXED: totals.deposit_credit holds the drawdown magnitude (the synthetic DEPOSIT-CREDIT
    // applied to the STANDARD invoice) — the deposit appears once HERE, separate from `paid`.
    expect(Number(custBody.totals.deposit_credit)).toBeCloseTo(depositTotal, 2);
    expect(sumLines(custLines, 'deposit_credit')).toBeCloseTo(depositTotal, 2);
    expect(custLines.filter((l) => l.type === 'deposit_credit').length).toBe(1);

    // The DEPOSIT invoice also contributes a +D `invoice` billed line, so customer-scope billed
    // exceeds job-scope billed by exactly D.
    expect(Number(custBody.totals.billed)).toBeCloseTo(Number(jobBody.totals.billed) + depositTotal, 2);

    // BALANCE is unchanged by the split and STILL CORRECT in BOTH scopes: it equals the §9
    // invariant (now subtracting both paid AND deposit_credit) and the final running_balance,
    // and the two scopes agree (the DEPOSIT invoice's +D billed line offsets its real payment).
    expect(Number(custBody.totals.balance)).toBeCloseTo(expectedBalanceFromTotals(custBody.totals), 2);
    expect(Number(custBody.totals.balance)).toBeCloseTo(Number(jobBody.totals.balance), 2);
    const custLast = custLines[custLines.length - 1];
    expect(Number(custBody.totals.balance)).toBeCloseTo(Number(custLast.running_balance), 2);
    await assertStatementReconciles(api, { customerId }, 'STM-02-customer');
  });

  test('STM-03: customer roll-up keys on bill_to_customer_id (not parent_id)', async () => {
    test.setTimeout(120_000); // two full lead→…→paid-invoice seed chains (childA + childB)
    // Parent / billing-group payer P (top-level: its own parent_id is null).
    const sP = api.suffix;
    const parent = await api.createCustomer({
      kind: 'COMPANY', segment: 'COMMERCIAL', phone: uniquePhone(), is_parent: true, // 2026-06-10: dup-guard fix (was '6175550100' — collides with redesign-11 CUST-13)
      company_name: `Rollup Parent ${sP}`, email: `rollup-parent-${sP}@e2e-qa.invalid`,
    });

    // Child A: parent_id=P AND bill_to_customer_id=P → A's invoices roll INTO P's statement.
    const sA = api.suffix;
    const childA = await api.createCustomer({
      kind: 'COMPANY', segment: 'COMMERCIAL', phone: uniquePhone(), // 2026-06-10: dup-guard fix (was '6175550101' — collides with redesign-11 CUST-13)
      company_name: `Rollup ChildA ${sA}`, email: `rollup-a-${sA}@e2e-qa.invalid`,
      parent_id: parent.id, bill_to_customer_id: parent.id,
    });
    const locAObj = await api.addLocation(childA.id, {
      address_line1: '10 Beacon St', city: 'Boston', state: 'MA', zip: '02108', is_primary: true,
    });

    // Child B: parent_id=P but bill_to omitted (bill_to defaults to self/null) →
    // B's invoices DO NOT roll into P's statement. (bill_to=self cannot be set on create —
    // selfId is unknown at create time — so omitting it is the canonical "bills itself" case.)
    const sB = api.suffix;
    const childB = await api.createCustomer({
      kind: 'COMPANY', segment: 'COMMERCIAL', phone: uniquePhone(), // 2026-06-10: dup-guard fix (was '6175550102' — collides with redesign-11 CUST-13)
      company_name: `Rollup ChildB ${sB}`, email: `rollup-b-${sB}@e2e-qa.invalid`,
      parent_id: parent.id,
    });
    const locBObj = await api.addLocation(childB.id, {
      address_line1: '20 Beacon St', city: 'Boston', state: 'MA', zip: '02108', is_primary: true,
    });

    // Sanity on the seeded grouping keys.
    const reReadA = await api.getCustomer(childA.id);
    const reReadB = await api.getCustomer(childB.id);
    expect(reReadA.bill_to_customer_id).toBe(parent.id);
    expect(reReadB.bill_to_customer_id === null || reReadB.bill_to_customer_id === childB.id).toBe(true);

    // Give each child an invoice whose invoice.customer_id === that child.
    const a = await seedPaidInvoiceForCustomer(api, childA.id, locAObj.id);
    const b = await seedPaidInvoiceForCustomer(api, childB.id, locBObj.id);

    // P's customer statement: members = exactly the customers whose bill_to_customer_id === P.
    const { res, body } = await api.getCustomerStatement(parent.id);
    expect(res.status()).toBe(200);
    expect(body.scope).toBe('customer');
    expect(body.customer?.id).toBe(parent.id);

    const memberIds: string[] = (body.members ?? []).map((m: any) => m.id);
    expect(memberIds).toContain(childA.id); // A bills to P → member
    expect(memberIds).not.toContain(childB.id); // B bills itself → NOT a member

    // POSITIVE: A's invoice rolls into P's statement lines.
    const lineInvoiceIds = new Set((body.lines ?? []).map((l: any) => l.invoice_id));
    expect(lineInvoiceIds.has(a.invoiceId)).toBe(true);
    // NEGATIVE: B's invoice does NOT appear in P's statement.
    expect(lineInvoiceIds.has(b.invoiceId)).toBe(false);

    // The statement still satisfies the §9 balance invariant.
    expect(Number(body.totals.balance)).toBeCloseTo(expectedBalanceFromTotals(body.totals), 2);
    await assertStatementReconciles(api, { customerId: parent.id }, 'STM-03');
  });

  test('STM-04: no cross-tenant leak — foreign / unknown job & customer ids 404', async () => {
    // Tenant scope is enforced on every hop via tenantWhere(req). A job/customer id that is not
    // in the requester's org fails the scoped findUnique → 404 (never 200 with foreign data).
    // Use a random UUID (no second org provisionable from a worker) — same scoped-miss path.
    const foreignJobId = '00000000-0000-4000-8000-000000000abc';
    const foreignCustomerId = '00000000-0000-4000-8000-000000000def';

    const { res: jobRes, body: jobBody } = await api.getJobStatement(foreignJobId);
    expect(jobRes.status()).toBe(404);
    expect(String(jobBody.error)).toMatch(/job not found/i);

    const { res: custRes, body: custBody } = await api.getCustomerStatement(foreignCustomerId);
    expect(custRes.status()).toBe(404);
    expect(String(custBody.error)).toMatch(/customer not found/i);

    // POSITIVE control: a real in-org job/customer returns 200 with only this org's rows.
    const { jobId, customerId } = await seedDepositStandardFlow(api, 50_000, 30);
    const { res: okJobRes, body: okJobBody } = await api.getJobStatement(jobId);
    expect(okJobRes.status()).toBe(200);
    expect(okJobBody.job?.id).toBe(jobId);
    // Every line in this org's job statement references this job's own customer.
    for (const l of okJobBody.lines ?? []) {
      expect(l.customer_id).toBe(customerId);
    }
    const { res: okCustRes, body: okCustBody } = await api.getCustomerStatement(customerId);
    expect(okCustRes.status()).toBe(200);
    expect(okCustBody.customer?.id).toBe(customerId);
  });

  test('STM-05: VOIDED invoice contributes no billed line; running balance can go negative', async () => {
    // Seed a plain MA customer + a no-deposit standard flow to a SENT invoice, record a PARTIAL
    // payment, then void the invoice. voidInvoice only accepts a non-terminal invoice — it
    // rejects a fully-PAID (or already-VOIDED/DRAFT) invoice with 400 (invoice.controller.ts:827),
    // so the invoice must be SENT/PARTIAL when voided. A partial payment leaves it PARTIAL.
    // The void un-bills (no `invoice` line) but the prior payment line stays → the running
    // balance goes NEGATIVE (money owed back).
    const { customerId, locationId } = await createMaCustomerWithLocation(api);
    const { jobId, invoiceId, sentAmountDue } = await seedSentInvoiceForCustomer(api, customerId, locationId);

    // Record a PARTIAL payment (half the SENT balance) → invoice stays PARTIAL (voidable).
    const partialPaid = Math.round(sentAmountDue * 0.5 * 100) / 100;
    expect(partialPaid).toBeGreaterThan(0);
    const { res: payRes } = await api.recordPayment(invoiceId, { amount: partialPaid, method: 'CASH' });
    expect(payRes.status()).toBe(201);
    await assertInvoiceReconciles(api, invoiceId, 'STM-05-after-partial-payment');

    // Confirm the invoice was billed and is PARTIAL (a remaining balance) before the void.
    const partInv = await api.getInvoice(invoiceId);
    const billedTotal = Number(partInv.total_amount);
    expect(billedTotal).toBeGreaterThan(0);
    expect(partInv.status).toBe('PARTIAL');
    expect(Number(partInv.amount_due)).toBeGreaterThan(0);

    // Statement BEFORE void: balance = billed − partialPaid (still positive, owed).
    const { body: preBody } = await api.getJobStatement(jobId);
    expect(preBody.lines.some((l: any) => l.type === 'invoice')).toBe(true);
    expect(Number(preBody.totals.balance)).toBeCloseTo(billedTotal - partialPaid, 2);

    // Void the invoice (still PARTIAL, so void is allowed → 200).
    const { res: voidRes, body: voidBody } = await api.voidInvoice(invoiceId, 'STM-05 void after partial payment');
    expect(voidRes.status()).toBe(200);
    expect(voidBody.invoice.status).toBe('VOIDED');

    // Statement AFTER void:
    const { res, body } = await api.getJobStatement(jobId);
    expect(res.status()).toBe(200);
    const lines: any[] = body.lines;

    // (1) The VOIDED invoice produces NO `invoice` billed line → totals.billed === 0.
    expect(lines.some((l) => l.type === 'invoice')).toBe(false);
    expect(Number(body.totals.billed)).toBeCloseTo(0, 2);

    // (2) The prior real (non-voided) payment line STILL appears (the void only suppresses the
    //     billed line, not settlements).
    expect(lines.some((l) => l.type === 'payment')).toBe(true);
    expect(Number(body.totals.paid)).toBeCloseTo(partialPaid, 2);

    // (3) Running balance goes NEGATIVE: billed(0) − paid(partialPaid) → −partialPaid (owed back).
    expect(Number(body.totals.balance)).toBeLessThan(0);
    expect(Number(body.totals.balance)).toBeCloseTo(-partialPaid, 2);
    const last = lines[lines.length - 1];
    expect(Number(last.running_balance)).toBeCloseTo(Number(body.totals.balance), 2);
    expect(Number(body.totals.balance)).toBeCloseTo(expectedBalanceFromTotals(body.totals), 2);

    await assertStatementReconciles(api, { jobId }, 'STM-05');
  });
});
