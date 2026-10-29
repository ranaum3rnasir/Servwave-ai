// Golden chains — catalog GLD-01..05 (md_files/specs/testing/lifecycle-regression-catalog.md). WRITTEN 2026-06-10, NOT YET EXECUTED — first baseline run validates.
import { test, expect } from '@playwright/test';
import { ApiClient } from '../../helpers/api-client';
import {
  createMaCustomerWithLocation,
  maEstimateSentWithDeposit,
  createSalesUser,
  createTech,
} from '../../helpers/workflow-builders';
import { assertInvoiceReconciles, assertStatementReconciles } from '../../helpers/reconcile';

/**
 * The five canonical end-to-end "golden chains" anchoring the lifecycle regression gate.
 * Each chain walks the §3 golden-path spine (md_files/specs/testing/job-lifecycle-e2e-map.md)
 * through ONE deposit-settlement variant (§4 D4) and ends on the same data-level SETTLED
 * definition (md_files/specs/testing/segments/04-collect-invoice-payment.md §2 Step 4),
 * asserted once by the local assertSettled() helper:
 *
 *  GLD-01  no deposit (single-step public approve)         — EVERY stage asserted (diagnostic spine)
 *  GLD-02  Stripe CARD deposit via the webhook test door   — invoice draws the deposit credit
 *  GLD-03  CHECK deposit (approve → PENDING → record)      — settled by two partial payments
 *  GLD-04  deposit waived (→ VOIDED)                       — job gate passes, NO credit drawn
 *  GLD-05  final invoice paid via public Stripe checkout   — webhook door, face-value amount verified
 *
 * Stripe reality: staging Stripe is OFF, so no live checkout / public CARD approval is ever
 * attempted. Card money moves by replaying checkout.session.completed through the boot-guarded
 * /api/test/stripe-webhook door (the post-signature money code) with amount_total =
 * api.checkoutCents(amount_due) — exactly like SMOKE / DEP-07 / redesign-19's seedPaidByCardWebhook.
 *
 * ONE shared org, serial (workers:1 — do NOT parallelize). Assert presence/status of YOUR OWN
 * seeded ids only, never absolute list counts. All seeded emails are @e2e-qa.invalid (builders).
 * Reconcile (assertInvoiceReconciles) after every money mutation.
 */
let api: ApiClient;
test.beforeAll(async () => { api = await new ApiClient().init(); });
test.afterAll(async () => { await api.dispose(); });

const round2 = (n: number) => Math.round(n * 100) / 100;
/** The synthetic drawdown payment's reference (invoice.controller.ts:26 / segments/04 §1). */
const DEPOSIT_CREDIT_REF = 'DEPOSIT-CREDIT';

// ─── Local helpers (documented ApiClient surface only) ───────────────────────

/**
 * Execute a freshly created job: assign a new TECHNICIAN with dates → SCHEDULED → start →
 * IN_PROGRESS → complete → COMPLETED, asserting the status at each hop. The assign hop is NOT
 * optional: start() only accepts SCHEDULED|ON_SITE (job.controller.ts:985), so an UNASSIGNED
 * job cannot be started.
 */
async function driveJobToCompleted(api: ApiClient, jobId: string, label: string) {
  const techId = await createTech(api);
  const { res: assignRes, body: assignBody } = await api.assignJob(jobId, {
    assignee_ids: [techId],
    scheduled_start: api.futureDate(48),
    scheduled_end: api.futureDate(50),
  });
  expect(assignRes.status(), `${label}: assign accepted`).toBe(200);
  expect(assignBody.job.status, `${label}: job SCHEDULED after assign`).toBe('SCHEDULED');

  const { res: startRes, body: startBody } = await api.startJob(jobId);
  expect(startRes.status(), `${label}: start accepted`).toBe(200);
  expect(startBody.job.status, `${label}: job IN_PROGRESS after start`).toBe('IN_PROGRESS');

  const { res: doneRes, body: doneBody } = await api.completeJob(jobId, `${label} completion ${api.suffix}`);
  expect(doneRes.status(), `${label}: complete accepted`).toBe(200);
  expect(doneBody.job.status, `${label}: job COMPLETED after complete`).toBe('COMPLETED');
  expect(doneBody.job.completed_at, `${label}: completed_at stamped`).toBeTruthy();
  return { techId, completedAt: String(doneBody.job.completed_at) };
}

/**
 * The data-level SETTLED gate (segments/04 §2 Step 4), asserted in one place so all five
 * chains end on the identical definition:
 *  1. invoice: status PAID, amount_due 0, paid_at set, voided_at null, total_refunded 0;
 *  2. payment conservation: Σ non-voided payments == total_amount — decomposed, when a deposit
 *     credit was drawn, as exactly ONE synthetic DEPOSIT-CREDIT payment of deposit_credit
 *     (the API-visible face of the DepositCreditApplication ledger row, mirroring PAY-03)
 *     plus real payments totaling total − credit;
 *  3. the funding deposit invoice (pass depositInvoiceId only when the credit came from a PAID
 *     deposit — NOT for waived/VOIDED ones): kind DEPOSIT, still PAID, amount_due 0, reconciles;
 *  4. job statement zeroes out: totals.balance === 0, headline == last running_balance;
 *  5. the job stays COMPLETED with completed_at set — payment never touches Job (pass
 *     completedAtBefore to prove the stamp is byte-identical to the pre-payment value);
 *  6. the invoice ledger invariant (assertInvoiceReconciles).
 */
async function assertSettled(
  api: ApiClient,
  opts: { jobId: string; invoiceId: string; depositInvoiceId?: string; completedAtBefore?: string },
  label = 'settled',
) {
  // (1) Invoice terminal-paid shape.
  const inv = await api.getInvoice(opts.invoiceId);
  expect(inv.status, `${label}: invoice PAID`).toBe('PAID');
  expect(Number(inv.amount_due), `${label}: amount_due 0`).toBe(0);
  expect(inv.paid_at, `${label}: paid_at set`).toBeTruthy();
  expect(inv.voided_at ?? null, `${label}: voided_at null`).toBeNull();
  expect(Number(inv.total_refunded ?? 0), `${label}: total_refunded 0`).toBe(0);

  // (2) Payment conservation + deposit decomposition.
  const live: any[] = (inv.payments ?? []).filter((p: any) => !p.voided_at);
  const paidSum = live.reduce((s: number, p: any) => s + Number(p.amount), 0);
  expect(round2(paidSum), `${label}: Σ non-voided payments == total_amount`)
    .toBe(round2(Number(inv.total_amount)));

  const credit = Number(inv.deposit_credit ?? 0);
  const syntheticRows = live.filter((p: any) => p.reference_number === DEPOSIT_CREDIT_REF);
  if (credit > 0) {
    expect(syntheticRows, `${label}: exactly one DEPOSIT-CREDIT payment`).toHaveLength(1);
    expect(round2(Number(syntheticRows[0].amount)), `${label}: synthetic amount == deposit_credit`)
      .toBe(round2(credit));
    const realSum = live
      .filter((p: any) => p.reference_number !== DEPOSIT_CREDIT_REF)
      .reduce((s: number, p: any) => s + Number(p.amount), 0);
    expect(round2(realSum), `${label}: real payments == total − credit`)
      .toBe(round2(Number(inv.total_amount) - credit));
  } else {
    expect(syntheticRows, `${label}: no DEPOSIT-CREDIT payment without a credit`).toHaveLength(0);
  }

  // (3) The funding (PAID) deposit invoice, when this chain drew one.
  if (opts.depositInvoiceId) {
    const dep = await api.getInvoice(opts.depositInvoiceId);
    expect(dep.kind, `${label}: funding invoice kind DEPOSIT`).toBe('DEPOSIT');
    expect(dep.status, `${label}: deposit stays PAID`).toBe('PAID');
    expect(Number(dep.amount_due), `${label}: deposit amount_due 0`).toBe(0);
    await assertInvoiceReconciles(api, opts.depositInvoiceId, `${label} (deposit)`);
  }

  // (4) Job statement zeroes out (the job-less deposit invoice never appears directly; its
  //     drawdown shows as the synthetic deposit_credit line on the STANDARD invoice).
  const { body: stmt } = await api.getJobStatement(opts.jobId);
  expect(Number(stmt.totals?.balance), `${label}: statement balance 0`).toBe(0);
  await assertStatementReconciles(api, { jobId: opts.jobId }, label);

  // (5) The job is untouched by payment.
  const job = await api.getJob(opts.jobId);
  expect(job.status, `${label}: job stays COMPLETED`).toBe('COMPLETED');
  expect(job.completed_at, `${label}: completed_at set`).toBeTruthy();
  if (opts.completedAtBefore) {
    expect(String(job.completed_at), `${label}: completed_at unchanged by payment`)
      .toBe(String(opts.completedAtBefore));
  }

  // (6) Ledger invariant.
  await assertInvoiceReconciles(api, opts.invoiceId, label);
  return inv;
}

// ─── The five chains ──────────────────────────────────────────────────────────

test.describe('Golden chains — lifecycle regression gate (GLD-01..GLD-05)', () => {
  test('GLD-01: standard chain, no deposit — every stage asserted end-to-end, then settled', async () => {
    // The gate's diagnostic spine: fully manual (no composite seed builder) and asserted at
    // every hop, so a red names the broken stage. Heaviest single-chain seed in this file
    // (two Supabase Auth users: walkthrough performer + tech) — legitimate seeding cost,
    // not a hang (mirrors PAY-02's budget note).
    test.setTimeout(120_000);
    const AMOUNT = 1_000; // MA 6.25% → subtotal 1000, tax 62.5, total 1062.5

    // Stage 1 — customer with a primary MA service location (deterministic StateTaxRate).
    const { customerId, locationId } = await createMaCustomerWithLocation(api);
    expect(customerId, 'stage 1: customer created').toBeTruthy();
    expect(locationId, 'stage 1: primary service location created').toBeTruthy();

    // Stage 2 — lead → NEW.
    const { res: leadRes, body: leadBody } = await api.createLead({
      customer_id: customerId,
      service_request: `gld01-${api.suffix}`,
      service_location_id: locationId,
    });
    expect(leadRes.status(), 'stage 2: lead create accepted').toBe(201);
    const leadId = leadBody.lead.id as string;
    expect((await api.getLead(leadId)).status, 'stage 2: lead NEW').toBe('NEW');

    // Stage 3 — contact → CONTACTED.
    const { res: contactRes } = await api.contactLead(leadId);
    expect(contactRes.status(), 'stage 3: contact accepted').toBe(200);
    expect((await api.getLead(leadId)).status, 'stage 3: lead CONTACTED').toBe('CONTACTED');

    // Stage 4 — schedule the walkthrough (SALES performer; the wrapper defaults
    // send_email:false + force:true) → WALKTHROUGH_SCHEDULED.
    const performerId = await createSalesUser(api);
    const { res: schedRes } = await api.scheduleWalkthrough(leadId, {
      walkthrough_scheduled_at: api.futureDate(24),
      performer_ids: [performerId],
    });
    expect(schedRes.status(), 'stage 4: schedule accepted').toBe(200);
    expect((await api.getLead(leadId)).status, 'stage 4: lead WALKTHROUGH_SCHEDULED')
      .toBe('WALKTHROUGH_SCHEDULED');

    // Stage 5 — complete the walkthrough → WALKTHROUGH_COMPLETED (opens estimate gate G1).
    const { res: wtRes } = await api.completeWalkthrough(leadId);
    expect(wtRes.status(), 'stage 5: walkthrough complete accepted').toBe(200);
    expect((await api.getLead(leadId)).status, 'stage 5: lead WALKTHROUGH_COMPLETED')
      .toBe('WALKTHROUGH_COMPLETED');

    // Stage 6 — estimate → DRAFT.
    const { res: estRes, body: estBody } = await api.createEstimate({
      lead_id: leadId,
      line_items: [{ description: 'Full job', quantity: 1, unit_price: AMOUNT, is_taxable: true }],
    });
    expect(estRes.status(), 'stage 6: estimate create accepted').toBe(201);
    const estimateId = estBody.estimate.id as string;
    expect((await api.getEstimate(estimateId)).status, 'stage 6: estimate DRAFT').toBe('DRAFT');

    // Stage 7 — send WITHOUT a deposit → SENT + public_token; lead auto-flips ESTIMATED;
    // no kind=DEPOSIT invoice may spawn.
    const { res: sendRes, body: sendBody } = await api.sendEstimate(estimateId, {
      deposit_required: false, payment_methods: ['CHECK', 'CASH'],
    });
    expect(sendRes.status(), 'stage 7: send accepted').toBe(200);
    expect(sendBody.estimate.status, 'stage 7: estimate SENT').toBe('SENT');
    const publicToken = sendBody.estimate.public_token as string;
    expect(publicToken, 'stage 7: public_token minted').toBeTruthy();
    expect((await api.getLead(leadId)).status, 'stage 7: lead ESTIMATED').toBe('ESTIMATED');
    expect(await api.getDepositInvoice(estimateId), 'stage 7: no deposit invoice spawned').toBeFalsy();

    // Stage 8 — public approve, signature only (Branch 1: no deposit ⇒ single-step approval)
    // → estimate WON + lead WON.
    const { res: approveRes } = await api.approveEstimatePublic(estimateId, publicToken, {
      signature_data: api.testSignature,
    });
    expect(approveRes.status(), 'stage 8: public approve accepted').toBe(200);
    const approved = await api.getEstimate(estimateId);
    expect(approved.status, 'stage 8: estimate WON').toBe('WON');
    expect(approved.approved_at, 'stage 8: approved_at stamped').toBeTruthy();
    expect((await api.getLead(leadId)).status, 'stage 8: lead WON').toBe('WON');

    // Stage 9 — job → UNASSIGNED; strictly 1:1 with the estimate (2nd create 409s on the
    // DB-unique Job.estimate_id — gate G2's "one job per estimate").
    const { res: jobRes, body: jobBody } = await api.createJob({ estimate_id: estimateId });
    expect(jobRes.status(), 'stage 9: job create accepted').toBe(201);
    const jobId = jobBody.job.id as string;
    expect(jobBody.job.status, 'stage 9: job UNASSIGNED').toBe('UNASSIGNED');
    const { res: dupRes, body: dupBody } = await api.createJob({ estimate_id: estimateId });
    // Bug #23: 1:1 is enforced by idempotent find-or-create — the 2nd create returns the SAME job (200).
    expect(dupRes.status(), 'stage 9: 2nd job on the same estimate is idempotent').toBe(200);
    expect(dupBody.job.id, 'stage 9: 1:1 returns the existing job').toBe(jobId);

    // Stages 10–12 — assign w/ dates → SCHEDULED; start → IN_PROGRESS; complete → COMPLETED.
    const { completedAt } = await driveJobToCompleted(api, jobId, 'GLD-01 stages 10-12');

    // Stage 13 — invoice → DRAFT; estimate lines snapshotted verbatim; NO deposit credit.
    const { res: invRes, body: invBody } = await api.createInvoice(jobId);
    expect(invRes.status(), 'stage 13: invoice create accepted').toBe(201);
    const invoiceId = invBody.invoice.id as string;
    const draft = await api.getInvoice(invoiceId);
    expect(draft.status, 'stage 13: invoice DRAFT').toBe('DRAFT');
    const estLines: any[] = approved.line_items ?? [];
    const invLines: any[] = draft.line_items ?? [];
    expect(invLines.length, 'stage 13: line count snapshotted').toBe(estLines.length);
    expect(String(invLines[0].description), 'stage 13: line description snapshotted').toBe('Full job');
    expect(Number(invLines[0].unit_price), 'stage 13: line price snapshotted').toBe(AMOUNT);
    expect(Number(draft.subtotal), 'stage 13: subtotal').toBe(AMOUNT);
    expect(Number(draft.tax_amount), 'stage 13: 6.25% tax charged once').toBe(round2(AMOUNT * 0.0625));
    expect(Number(draft.total_amount), 'stage 13: total').toBe(round2(AMOUNT * 1.0625));
    expect(Number(draft.deposit_credit), 'stage 13: deposit_credit 0').toBe(0);
    expect(Number(draft.amount_due), 'stage 13: amount_due == total').toBe(Number(draft.total_amount));
    await assertInvoiceReconciles(api, invoiceId, 'GLD-01 stage 13 (created)');

    // Stage 14 — send → SENT (payable).
    const { res: sendInvRes, body: sendInvBody } = await api.sendInvoice(invoiceId);
    expect(sendInvRes.status(), 'stage 14: invoice send accepted').toBe(200);
    expect(sendInvBody.invoice.status, 'stage 14: invoice SENT').toBe('SENT');

    // Stage 15 — ONE full CASH payment → PAID, amount_due 0.
    const due = Number((await api.getInvoice(invoiceId)).amount_due);
    expect(due, 'stage 15: positive balance to collect').toBeGreaterThan(0);
    const { res: payRes, body: payBody } = await api.recordPayment(invoiceId, { amount: due, method: 'CASH' });
    expect(payRes.status(), 'stage 15: payment accepted').toBe(201);
    expect(payBody.invoice.status, 'stage 15: invoice PAID').toBe('PAID');
    expect(Number(payBody.invoice.amount_due), 'stage 15: amount_due 0').toBe(0);

    // Stage 16 — SETTLED.
    await assertSettled(api, { jobId, invoiceId, completedAtBefore: completedAt }, 'GLD-01');
  });

  test('GLD-02: Stripe-deposit chain — webhook door pays the deposit, invoice draws the credit, one CHECK settles the remainder', async () => {
    // Worked MA numbers (10000 @ 30%): estimate total 10625 (tax-inclusive); deposit 3187.5;
    // STANDARD invoice: subtotal 10000, tax 625, total 10625, deposit_credit 3187.5, due 7437.5.
    const ctx = await maEstimateSentWithDeposit(api, 10_000, 30, ['CARD', 'CHECK']);
    const dep = await api.getDepositInvoice(ctx.estimateId);
    expect(dep, 'deposit invoice spawned on send').toBeTruthy();
    expect(dep!.kind).toBe('DEPOSIT');
    expect(dep!.status).toBe('SENT');
    expect(Number(dep!.total_amount), 'deposit = 30% of the tax-inclusive total').toBe(3_187.5);

    // Staging Stripe is OFF — no public CARD approval/checkout is attempted. The test door pays
    // the SENT deposit invoice directly; the webhook's kind=DEPOSIT branch flips
    // estimate→WON + lead→WON (mirror DEP-07 / SMOKE).
    const ev = api.depositPaidEvent(dep!.id, api.checkoutCents(Number(dep!.amount_due)), {
      eventId: `evt_gld02_${api.suffix}`,
    });
    const fired = await api.fireStripeEvent(ev);
    expect(fired.res.status(), 'webhook door accepted').toBe(200);
    expect(fired.body.received, 'event processed').toBe(true);

    const depPaid = await api.getInvoice(dep!.id);
    expect(depPaid.status, 'deposit PAID via webhook').toBe('PAID');
    expect(Number(depPaid.amount_due), 'deposit amount_due 0').toBe(0);
    await assertInvoiceReconciles(api, dep!.id, 'GLD-02 deposit paid');
    expect((await api.getEstimate(ctx.estimateId)).status, 'estimate WON by the webhook').toBe('WON');
    expect((await api.getLead(ctx.leadId)).status, 'lead WON').toBe('WON');

    // Job (G2 passes on the PAID deposit) → executed to COMPLETED.
    const { res: jobRes, body: jobBody } = await api.createJob({ estimate_id: ctx.estimateId });
    expect(jobRes.status(), 'job create accepted').toBe(201);
    const jobId = jobBody.job.id as string;
    expect(jobBody.job.status, 'job UNASSIGNED').toBe('UNASSIGNED');
    const { completedAt } = await driveJobToCompleted(api, jobId, 'GLD-02');

    // Invoice draws the FULL deposit credit. The drawdown's API-visible face is the synthetic
    // DEPOSIT-CREDIT payment (mirror PAY-03/STD-05 — DepositCreditApplication itself is not
    // surfaced on the invoice detail).
    const { res: invRes, body: invBody } = await api.createInvoice(jobId);
    expect(invRes.status(), 'invoice create accepted').toBe(201);
    const invoiceId = invBody.invoice.id as string;
    const inv = await api.getInvoice(invoiceId);
    expect(inv.status, 'invoice DRAFT').toBe('DRAFT');
    expect(Number(inv.subtotal)).toBe(10_000);
    expect(Number(inv.tax_amount), 'tax charged once on the base').toBe(625);
    expect(Number(inv.total_amount)).toBe(10_625);
    expect(Number(inv.deposit_credit), 'credit == the paid deposit').toBe(Number(depPaid.total_amount));
    expect(Number(inv.amount_due), 'due == total − credit')
      .toBe(round2(Number(inv.total_amount) - Number(inv.deposit_credit)));
    const synthetic = (inv.payments ?? []).find((p: any) => p.reference_number === DEPOSIT_CREDIT_REF);
    expect(synthetic, 'synthetic DEPOSIT-CREDIT payment recorded').toBeTruthy();
    expect(Number(synthetic.amount), 'synthetic payment carries the credit amount')
      .toBe(Number(inv.deposit_credit));
    await assertInvoiceReconciles(api, invoiceId, 'GLD-02 invoice created');

    // Send, then settle the remainder with ONE CHECK payment of exactly amount_due.
    const { body: sentBody } = await api.sendInvoice(invoiceId);
    expect(sentBody.invoice.status, 'invoice SENT').toBe('SENT');
    const due = Number((await api.getInvoice(invoiceId)).amount_due);
    expect(due, 'worked remainder').toBe(7_437.5);
    const { res: payRes, body: payBody } = await api.recordPayment(invoiceId, { amount: due, method: 'CHECK' });
    expect(payRes.status(), 'remainder payment accepted').toBe(201);
    expect(payBody.invoice.status, 'invoice PAID').toBe('PAID');

    await assertSettled(
      api,
      { jobId, invoiceId, depositInvoiceId: dep!.id, completedAtBefore: completedAt },
      'GLD-02',
    );
  });

  test('GLD-03: check-deposit chain — approve CHECK → PENDING → record-payment, settled by two partials', async () => {
    // Worked MA numbers (2000 @ 25%): estimate total 2125; deposit 531.25;
    // invoice total 2125, deposit_credit 531.25, due 1593.75 → partials 796.88 + 796.87.
    const ctx = await maEstimateSentWithDeposit(api, 2_000, 25, ['CHECK']);
    const dep = await api.getDepositInvoice(ctx.estimateId);
    expect(dep, 'deposit invoice spawned on send').toBeTruthy();
    expect(dep!.status).toBe('SENT');
    expect(Number(dep!.total_amount), 'deposit = 25% of the tax-inclusive total').toBe(531.25);

    // Public approve with a non-Stripe method → Branch 3: signature captured, estimate parks
    // at PENDING (money not yet collected; deposit invoice stays SENT).
    const { res: approveRes } = await api.approveEstimatePublic(ctx.estimateId, ctx.publicToken, {
      signature_data: api.testSignature, payment_method: 'CHECK',
    });
    expect(approveRes.status(), 'public approve accepted').toBe(200);
    expect((await api.getEstimate(ctx.estimateId)).status, 'estimate PENDING after CHECK approval')
      .toBe('PENDING');

    // Back-office records the received check → deposit PAID + estimate WON + lead WON
    // (the three-way flip, mirror DEP-05).
    const { res: recRes } = await api.markDepositReceived(ctx.estimateId, {
      amount: Number(dep!.total_amount), payment_method: 'CHECK',
    });
    expect(recRes.status(), 'deposit record-payment accepted').toBe(200);
    const depPaid = await api.getInvoice(dep!.id);
    expect(depPaid.status, 'deposit PAID').toBe('PAID');
    expect(Number(depPaid.amount_due), 'deposit amount_due 0').toBe(0);
    await assertInvoiceReconciles(api, dep!.id, 'GLD-03 deposit paid');
    expect((await api.getEstimate(ctx.estimateId)).status, 'estimate WON').toBe('WON');
    expect((await api.getLead(ctx.leadId)).status, 'lead WON').toBe('WON');

    // Job → executed; invoice draws the credit; send.
    const { res: jobRes, body: jobBody } = await api.createJob({ estimate_id: ctx.estimateId });
    expect(jobRes.status(), 'job create accepted').toBe(201);
    const jobId = jobBody.job.id as string;
    const { completedAt } = await driveJobToCompleted(api, jobId, 'GLD-03');

    const { res: invRes, body: invBody } = await api.createInvoice(jobId);
    expect(invRes.status(), 'invoice create accepted').toBe(201);
    const invoiceId = invBody.invoice.id as string;
    await assertInvoiceReconciles(api, invoiceId, 'GLD-03 invoice created');
    const { body: sentBody } = await api.sendInvoice(invoiceId);
    expect(sentBody.invoice.status, 'invoice SENT').toBe('SENT');

    // TWO partial payments: PARTIAL after the first, PAID after the second.
    const due = Number((await api.getInvoice(invoiceId)).amount_due);
    expect(due, 'worked balance after credit').toBe(1_593.75);
    const first = round2(due / 2);
    const second = round2(due - first);

    const { res: p1Res, body: p1 } = await api.recordPayment(invoiceId, { amount: first, method: 'CHECK' });
    expect(p1Res.status(), 'first partial accepted').toBe(201);
    expect(p1.invoice.status, 'PARTIAL after first partial').toBe('PARTIAL');
    expect(Number(p1.invoice.amount_due), 'remaining balance after first partial').toBe(second);
    await assertInvoiceReconciles(api, invoiceId, 'GLD-03 after first partial');

    const { res: p2Res, body: p2 } = await api.recordPayment(invoiceId, { amount: second, method: 'CASH' });
    expect(p2Res.status(), 'second partial accepted').toBe(201);
    expect(p2.invoice.status, 'PAID after second partial').toBe('PAID');
    expect(Number(p2.invoice.amount_due), 'amount_due 0').toBe(0);

    await assertSettled(
      api,
      { jobId, invoiceId, depositInvoiceId: dep!.id, completedAtBefore: completedAt },
      'GLD-03',
    );
  });

  test('GLD-04: waived-deposit chain — waive → VOIDED + WON + WON, invoice draws NO credit, settled in full', async () => {
    // Worked MA numbers (3000 @ 20%): deposit 637.5 (waived → VOIDED, never paid);
    // invoice subtotal 3000, tax 187.5, total 3187.5, deposit_credit 0, due 3187.5.
    const ctx = await maEstimateSentWithDeposit(api, 3_000, 20, ['CHECK', 'CASH']);
    const dep = await api.getDepositInvoice(ctx.estimateId);
    expect(dep, 'deposit invoice spawned on send').toBeTruthy();
    expect(dep!.status).toBe('SENT'); // unpaid (DRAFT/SENT) → waivable
    expect(Number(dep!.total_amount)).toBe(637.5);

    // Waive → deposit invoice VOIDED + estimate WON + lead WON (mirror DEP-08).
    const { res: waiveRes } = await api.waiveDeposit(ctx.estimateId, 'waive');
    expect(waiveRes.status(), 'waive accepted').toBe(200);
    const depVoided = await api.getInvoice(dep!.id);
    expect(depVoided.status, 'deposit invoice VOIDED by waive').toBe('VOIDED');
    expect(depVoided.voided_at, 'voided_at stamped').toBeTruthy();
    expect(String(depVoided.voided_reason ?? ''), 'waive reason recorded').toContain('waived');
    expect((await api.getEstimate(ctx.estimateId)).status, 'estimate WON by waive').toBe('WON');
    expect((await api.getLead(ctx.leadId)).status, 'lead WON').toBe('WON');

    // G2 passes on VOIDED (waived): the job is creatable.
    const { res: jobRes, body: jobBody } = await api.createJob({ estimate_id: ctx.estimateId });
    expect(jobRes.status(), 'job gate passes on a VOIDED (waived) deposit').toBe(201);
    const jobId = jobBody.job.id as string;
    const { completedAt } = await driveJobToCompleted(api, jobId, 'GLD-04');

    // Invoice: a VOIDED deposit funds nothing — deposit_credit 0, no synthetic payment,
    // amount_due == total (the credit lookup requires a PAID deposit invoice).
    const { res: invRes, body: invBody } = await api.createInvoice(jobId);
    expect(invRes.status(), 'invoice create accepted').toBe(201);
    const invoiceId = invBody.invoice.id as string;
    const inv = await api.getInvoice(invoiceId);
    expect(inv.status, 'invoice DRAFT').toBe('DRAFT');
    expect(Number(inv.deposit_credit), 'NO credit from a voided deposit').toBe(0);
    expect(
      (inv.payments ?? []).filter((p: any) => p.reference_number === DEPOSIT_CREDIT_REF),
      'no synthetic DEPOSIT-CREDIT payment',
    ).toHaveLength(0);
    expect(Number(inv.total_amount)).toBe(3_187.5);
    expect(Number(inv.amount_due), 'amount_due == full total').toBe(Number(inv.total_amount));
    await assertInvoiceReconciles(api, invoiceId, 'GLD-04 invoice created');

    // Send → ONE full payment → settled. No depositInvoiceId here: the deposit is VOIDED,
    // not PAID — its VOIDED state was asserted above.
    const { body: sentBody } = await api.sendInvoice(invoiceId);
    expect(sentBody.invoice.status, 'invoice SENT').toBe('SENT');
    const due = Number((await api.getInvoice(invoiceId)).amount_due);
    expect(due).toBe(3_187.5);
    const { res: payRes, body: payBody } = await api.recordPayment(invoiceId, { amount: due, method: 'CHECK' });
    expect(payRes.status(), 'full payment accepted').toBe(201);
    expect(payBody.invoice.status, 'invoice PAID').toBe('PAID');

    await assertSettled(api, { jobId, invoiceId, completedAtBefore: completedAt }, 'GLD-04');
  });

  test('GLD-05: final invoice paid by the customer via public Stripe checkout (webhook door, face-value amount verified)', async () => {
    // Manual no-deposit spine + the exact pay-by-card mechanism of redesign-19's
    // seedPaidByCardWebhook: a checkout.session.completed door event whose amount_total is
    // api.checkoutCents(amount_due) — amount_due in cents, face value, which the webhook verifies
    // before recording money — carrying a seeded payment_intent. Two Supabase Auth users seeded
    // (performer + tech) — legitimate seeding cost, not a hang.
    test.setTimeout(120_000);
    const AMOUNT = 1_500; // MA: subtotal 1500, tax 93.75, total/due 1593.75

    const { customerId, locationId } = await createMaCustomerWithLocation(api);
    const { body: leadBody } = await api.createLead({
      customer_id: customerId,
      service_request: `gld05-${api.suffix}`,
      service_location_id: locationId,
    });
    const leadId = leadBody.lead.id as string;
    await api.contactLead(leadId);
    const performerId = await createSalesUser(api);
    await api.scheduleWalkthrough(leadId, {
      walkthrough_scheduled_at: api.futureDate(24),
      performer_ids: [performerId],
    });
    await api.completeWalkthrough(leadId);
    const { body: estBody } = await api.createEstimate({
      lead_id: leadId,
      line_items: [{ description: 'Full job', quantity: 1, unit_price: AMOUNT, is_taxable: true }],
    });
    const estimateId = estBody.estimate.id as string;
    const { body: sentEstBody } = await api.sendEstimate(estimateId, {
      deposit_required: false, payment_methods: ['CHECK', 'CASH', 'CARD'],
    });
    const { res: approveRes } = await api.approveEstimatePublic(estimateId, sentEstBody.estimate.public_token, {
      signature_data: api.testSignature,
    });
    expect(approveRes.status(), 'public approve accepted').toBe(200);
    expect((await api.getEstimate(estimateId)).status, 'estimate WON').toBe('WON');

    const { res: jobRes, body: jobBody } = await api.createJob({ estimate_id: estimateId });
    expect(jobRes.status(), 'job create accepted').toBe(201);
    const jobId = jobBody.job.id as string;
    const { completedAt } = await driveJobToCompleted(api, jobId, 'GLD-05');

    const { res: invRes, body: invBody } = await api.createInvoice(jobId);
    expect(invRes.status(), 'invoice create accepted').toBe(201);
    const invoiceId = invBody.invoice.id as string;
    await assertInvoiceReconciles(api, invoiceId, 'GLD-05 invoice created');
    const { body: sentInvBody } = await api.sendInvoice(invoiceId);
    expect(sentInvBody.invoice.status, 'invoice SENT').toBe('SENT');

    // Customer pays the FULL balance by card through the door (public checkout always bills
    // the full amount_due, face value; partial online payment does not exist).
    const due = Number((await api.getInvoice(invoiceId)).amount_due);
    expect(due, 'worked balance').toBe(1_593.75);
    const pi = `pi_gld05_${api.suffix}`;
    const ev = api.depositPaidEvent(invoiceId, api.checkoutCents(due), {
      eventId: `evt_gld05_${api.suffix}`, paymentIntent: pi,
    });
    const fired = await api.fireStripeEvent(ev);
    expect(fired.res.status(), 'webhook door accepted').toBe(200);
    expect(fired.body.received, 'event processed').toBe(true);

    // Assert the EFFECT (never received:true alone): PAID, amount_due 0, and ONE CARD payment
    // carrying the seeded PI whose Payment.amount equals amount_due exactly (face value —
    // that's the full amount charged in Stripe too).
    const inv = await api.getInvoice(invoiceId);
    expect(inv.status, 'invoice PAID via checkout webhook').toBe('PAID');
    expect(Number(inv.amount_due), 'amount_due 0').toBe(0);
    const cardPay = (inv.payments ?? []).find((p: any) => p.stripe_payment_intent_id === pi);
    expect(cardPay, 'CARD payment carrying the seeded PI exists').toBeTruthy();
    expect(cardPay.method, 'payment method CARD').toBe('CARD');
    expect(Number(cardPay.amount), 'payment records amount_due, the face-value charge').toBe(due);

    await assertSettled(api, { jobId, invoiceId, completedAtBefore: completedAt }, 'GLD-05');
  });
});
