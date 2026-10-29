import { test, expect } from '@playwright/test';
import { ApiClient } from '../../helpers/api-client';
import {
  maEstimateSentWithDeposit,
  createMaCustomerWithLocation,
  createTech,
} from '../../helpers/workflow-builders';
import { assertInvoiceReconciles } from '../../helpers/reconcile';

/**
 * Stage 6 — Job (Task C6, rows JOB-01..JOB-14).
 *
 * ONE shared provisioned org, serial. Data accumulates — every assertion is a delta /
 * presence check against a freshly-seeded entity (unique via api.suffix inside the
 * builders), never an absolute list/stat count.
 *
 * Domain facts (facts/job.json) override the plan where they disagree:
 *  - There is NO job-level deposit endpoint. Deposit states are driven through
 *    /api/estimates/:id/record-payment (PAID), /waive-deposit (VOIDED), and
 *    /api/invoices/:depositInvoiceId/refund (PARTIALLY_REFUNDED / REFUNDED).
 *  - amount_invoiced increments by the invoice GROSS total_amount (not amount_due).
 *  - JOB-06 / JOB-07 decrements only fire for STANDARD invoices that are voidable
 *    (SENT/PARTIAL) — a fresh DRAFT invoice MUST be sent first.
 *  - JOB-03 'no urgent toggle': createJobSchema has no urgent field and no .strict(),
 *    so an `urgent:true` key is silently STRIPPED — the job is created 201 as normal.
 *  - cancel() surfaces collected_total / refund_suggested / voided_invoice_ids as
 *    TOP-LEVEL response fields.
 *  - JOB-10 reopen is blocked only by a SENT-or-beyond invoice (DRAFT/VOIDED do not block).
 *  - JOB-14 status guard (UNASSIGNED only) is checked BEFORE the invoice guard.
 */
let api: ApiClient;
test.beforeAll(async () => { api = await new ApiClient().init(); });
test.afterAll(async () => { await api.dispose(); });

/** Drive a fresh estimate→deposit-PAID context and create an UNASSIGNED job from it. */
async function jobFromPaidDepositEstimate(amount = 10_000, pct = 30) {
  const ctx = await maEstimateSentWithDeposit(api, amount, pct);
  await api.markDepositReceived(ctx.estimateId, { payment_method: 'CHECK' }); // deposit PAID, estimate WON
  const { res, body } = await api.createJob({ estimate_id: ctx.estimateId });
  expect(res.status(), 'seed job create').toBe(201);
  return { ctx, jobId: body.job.id as string, job: body.job };
}

/** Assign → start → complete a job so it reaches COMPLETED (start requires SCHEDULED). */
async function completeJob(jobId: string) {
  const techId = await createTech(api);
  await api.assignJob(jobId, {
    assignee_ids: [techId],
    scheduled_start: api.futureDate(48),
    scheduled_end: api.futureDate(50),
  });
  await api.startJob(jobId);
  await api.completeJob(jobId, 'done');
}

test.describe('Stage 6 — Job (JOB-01..JOB-14)', () => {
  // ─── JOB-01 ──────────────────────────────────────────────────────────────
  test('JOB-01: create-from-approved-estimate — job created, estimate 1:1 linked', async () => {
    const ctx = await maEstimateSentWithDeposit(api, 10_000, 30);
    await api.markDepositReceived(ctx.estimateId, { payment_method: 'CHECK' }); // WON + deposit PAID

    const { res, body } = await api.createJob({ estimate_id: ctx.estimateId });
    expect(res.status()).toBe(201);
    expect(body.job.id).toBeTruthy();
    expect(body.job.status).toBe('UNASSIGNED');
    expect(body.job.estimate.id).toBe(ctx.estimateId);
    expect(body.job.estimate.estimate_number).toBeTruthy();
  });

  // ─── JOB-02 ──────────────────────────────────────────────────────────────
  test('JOB-02: deposit-gate full DEPOSIT_OK set — PAID / VOIDED(waived) / REFUNDED / PARTIALLY_REFUNDED all allow job', async () => {
    // Loops 5 full lead→walkthrough→estimate→deposit seed chains (4 DEPOSIT_OK states + the
    // unpaid-blocked branch); each chain is several serial API calls, so the default 75s isn't
    // enough. The work is finite (no never-true wait) — just raise the per-test budget.
    test.setTimeout(120_000);
    // PAID — record-payment on the estimate (NOT a jobs deposit endpoint).
    {
      const ctx = await maEstimateSentWithDeposit(api, 10_000, 30);
      await api.markDepositReceived(ctx.estimateId, { payment_method: 'CHECK' });
      const { res } = await api.createJob({ estimate_id: ctx.estimateId });
      expect(res.status(), 'DEPOSIT_OK PAID').toBe(201);
    }
    // VOIDED — waive the deposit. The 'waive' action voids the deposit invoice AND flips the
    // SENT estimate to WON in one step, so the estimate must NOT be pre-approved (waive
    // only operates on SENT/PENDING estimates).
    {
      const ctx = await maEstimateSentWithDeposit(api, 10_000, 30);
      const waived = await api.waiveDeposit(ctx.estimateId, 'waive');
      expect(waived.res.status(), 'waive-deposit').toBe(200);
      const dep = await api.getDepositInvoice(ctx.estimateId);
      expect(dep!.status).toBe('VOIDED');
      expect((await api.getEstimate(ctx.estimateId)).status).toBe('WON');
      const { res } = await api.createJob({ estimate_id: ctx.estimateId });
      expect(res.status(), 'DEPOSIT_OK VOIDED(waived)').toBe(201);
    }
    // PARTIALLY_REFUNDED — pay deposit then refund part of it.
    {
      const ctx = await maEstimateSentWithDeposit(api, 10_000, 30);
      await api.markDepositReceived(ctx.estimateId, { payment_method: 'CHECK' });
      const dep = await api.getDepositInvoice(ctx.estimateId);
      const partial = await api.refundInvoice(dep!.id, {
        amount: 100, reason: 'partial', reason_category: 'CUSTOMER_REQUEST',
      });
      expect(partial.res.status(), 'partial refund').toBe(200);
      const depAfter = await api.getInvoice(dep!.id);
      expect(depAfter.status).toBe('PARTIALLY_REFUNDED');
      await assertInvoiceReconciles(api, dep!.id, 'JOB-02 partial-refund');
      const { res } = await api.createJob({ estimate_id: ctx.estimateId });
      expect(res.status(), 'DEPOSIT_OK PARTIALLY_REFUNDED').toBe(201);
    }
    // REFUNDED — pay deposit then refund it in full.
    {
      const ctx = await maEstimateSentWithDeposit(api, 10_000, 30);
      await api.markDepositReceived(ctx.estimateId, { payment_method: 'CHECK' });
      const dep = await api.getDepositInvoice(ctx.estimateId);
      const full = await api.refundInvoice(dep!.id, {
        amount: Number(dep!.total_amount), reason: 'full', reason_category: 'CUSTOMER_REQUEST',
      });
      expect(full.res.status(), 'full refund').toBe(200);
      const depAfter = await api.getInvoice(dep!.id);
      expect(depAfter.status).toBe('REFUNDED');
      await assertInvoiceReconciles(api, dep!.id, 'JOB-02 full-refund');
      const { res } = await api.createJob({ estimate_id: ctx.estimateId });
      expect(res.status(), 'DEPOSIT_OK REFUNDED').toBe(201);
    }
    // Conversely: an estimate whose deposit is unpaid (SENT) cannot become a job — 400. Two guards
    // can fire here (the WON check runs BEFORE the deposit-gate): a deposit-required estimate
    // approved via the non-Stripe public path lands in PENDING (not WON), so the WON
    // guard trips first; an already-WON estimate with an unpaid deposit would trip the
    // deposit-gate. Either way the unpaid deposit blocks job creation — assert the 400 + an
    // expected gate message without over-pinning which guard wins.
    {
      const ctx = await maEstimateSentWithDeposit(api, 10_000, 30);
      const dep = await api.getDepositInvoice(ctx.estimateId);
      expect(['DRAFT', 'SENT', 'PARTIAL']).toContain(dep!.status); // unpaid
      const { res, body } = await api.createJob({ estimate_id: ctx.estimateId });
      expect(res.status(), 'unpaid deposit blocks job').toBe(400);
      expect(String(body.error)).toMatch(/Estimate must be WON|Deposit must be paid or waived/);
    }
  });

  // ─── JOB-03 ──────────────────────────────────────────────────────────────
  test('JOB-03: create-direct/no-estimate — {customer_id, service_location_id} only; no urgent toggle accepted', async () => {
    const { customerId, locationId } = await createMaCustomerWithLocation(api);

    // Happy path: customer + location, plus an unknown `urgent` key that Zod silently strips.
    const created = await api.createJob({
      customer_id: customerId, service_location_id: locationId, urgent: true,
    });
    expect(created.res.status()).toBe(201);
    expect(created.body.job.id).toBeTruthy();
    expect(created.body.job.status).toBe('UNASSIGNED');
    // No estimate linkage on a direct job.
    expect(created.body.job.estimate ?? null).toBeNull();
    // The redesign removed the urgent concept — no urgent flag is surfaced on the job.
    expect((created.body.job as Record<string, unknown>).is_urgent ?? undefined).toBeUndefined();
    expect((created.body.job as Record<string, unknown>).urgent ?? undefined).toBeUndefined();

    // Missing customer_id -> 400 (Zod superRefine requires customer_id + service_location_id together).
    const noCust = await api.createJob({ service_location_id: locationId });
    expect(noCust.res.status()).toBe(400);

    // Missing service_location_id -> 400.
    const noLoc = await api.createJob({ customer_id: customerId });
    expect(noLoc.res.status()).toBe(400);
  });

  // ─── JOB-04 ──────────────────────────────────────────────────────────────
  test('JOB-04: estimate 1:1 unique — second job from same estimate is idempotent (200, same job)', async () => {
    const ctx = await maEstimateSentWithDeposit(api, 10_000, 30);
    await api.markDepositReceived(ctx.estimateId, { payment_method: 'CHECK' });

    const first = await api.createJob({ estimate_id: ctx.estimateId });
    expect(first.res.status()).toBe(201);

    // Bug #23: estimate_id is @unique → idempotent find-or-create. A 2nd create returns the
    // existing job (200), not a dead-end 409 (the old behaviour stranded the UI: "already exists"
    // with no job to navigate to).
    const second = await api.createJob({ estimate_id: ctx.estimateId });
    expect(second.res.status()).toBe(200);
    expect(second.body.job.id).toBe(first.body.job.id);
  });

  // ─── JOB-05 ──────────────────────────────────────────────────────────────
  test('JOB-05: amount_invoiced increments on invoice — rises by the invoice gross total_amount', async () => {
    const { jobId } = await jobFromPaidDepositEstimate(10_000, 30);

    const before = Number((await api.getJob(jobId)).amount_invoiced ?? 0);

    const { res, body } = await api.createInvoice(jobId);
    expect(res.status()).toBe(201);
    const inv = await api.getInvoice(body.invoice.id);
    await assertInvoiceReconciles(api, inv.id, 'JOB-05');

    const after = Number((await api.getJob(jobId)).amount_invoiced ?? 0);
    // Increment uses GROSS total_amount (NOT amount_due — the deposit credit is a Payment).
    expect(Math.round((after - before) * 100) / 100).toBe(Number(inv.total_amount));
  });

  // ─── JOB-06 ──────────────────────────────────────────────────────────────
  test('JOB-06: amount_invoiced decrements on invoice void — must send (DRAFT->SENT) before void', async () => {
    const { jobId } = await jobFromPaidDepositEstimate(10_000, 30);

    const base = Number((await api.getJob(jobId)).amount_invoiced ?? 0);

    const { body: invBody } = await api.createInvoice(jobId);
    const invId = invBody.invoice.id;
    const inv = await api.getInvoice(invId);
    const afterCreate = Number((await api.getJob(jobId)).amount_invoiced ?? 0);
    expect(Math.round((afterCreate - base) * 100) / 100).toBe(Number(inv.total_amount));

    // Voiding a DRAFT invoice is rejected — it must be sent first.
    const draftVoid = await api.voidInvoice(invId, 'too soon');
    expect(draftVoid.res.status()).toBe(400);

    await api.sendInvoice(invId); // DRAFT -> SENT
    const voided = await api.voidInvoice(invId, 'mistake');
    expect(voided.res.status()).toBe(200);
    expect(voided.body.invoice.status).toBe('VOIDED');

    const afterVoid = Number((await api.getJob(jobId)).amount_invoiced ?? 0);
    // Decrement returns amount_invoiced to its pre-invoice baseline.
    expect(Math.round((afterVoid - base) * 100) / 100).toBe(0);
  });

  // ─── JOB-07 ──────────────────────────────────────────────────────────────
  test('JOB-07: amount_invoiced decrements on job cancel — cancel voids the SENT invoice and decrements', async () => {
    const { jobId } = await jobFromPaidDepositEstimate(10_000, 30);

    const base = Number((await api.getJob(jobId)).amount_invoiced ?? 0);
    const { body: invBody } = await api.createInvoice(jobId);
    const invId = invBody.invoice.id;
    const inv = await api.getInvoice(invId);
    await api.sendInvoice(invId); // SENT so the cancel cascade can void it

    const afterInvoice = Number((await api.getJob(jobId)).amount_invoiced ?? 0);
    expect(Math.round((afterInvoice - base) * 100) / 100).toBe(Number(inv.total_amount));

    const { res, body } = await api.cancelJob(jobId, 'scheduling conflict');
    expect(res.status()).toBe(200);
    expect(body.voided_invoice_ids).toContain(invId);
    // jobDetailSelect in the cancel response carries the decremented amount_invoiced.
    expect(Math.round(Number(body.job.amount_invoiced ?? 0) * 100) / 100).toBe(
      Math.round(base * 100) / 100,
    );
  });

  // ─── JOB-08 ──────────────────────────────────────────────────────────────
  test('JOB-08: location edit -> tax_warning + accretes + timeline + NOT synced to lead', async () => {
    const { ctx, jobId } = await jobFromPaidDepositEstimate(10_000, 30); // MA service location

    // The lead and the job SHARE the same customer. Editing the job's location accretes a new
    // location onto that shared customer (it will appear in customer.service_locations), so a
    // full lead-JSON equality would falsely fail. "NOT synced to lead" means the LEAD's OWN
    // as-sold fields (service_state + legacy service_address_*) are untouched — assert THOSE,
    // not the whole customer blob. (getLead's leadDetailSelect does not surface
    // service_location_id, so we pin the as-sold scalars it DOES return.)
    const leadBefore = await api.getLead(ctx.leadId);
    const asSoldBefore = {
      service_state: leadBefore.service_state ?? null,
      service_address_line1: leadBefore.service_address_line1 ?? null,
      service_city: leadBefore.service_city ?? null,
      service_zip: leadBefore.service_zip ?? null,
    };

    // Patch the job to a DIFFERENT-state (NH) address -> tax_warning present.
    const patched = await api.updateJob(jobId, {
      address: { address_line1: '7 Elm St', city: 'Nashua', state: 'NH', zip: '03060' },
    });
    expect(patched.res.status()).toBe(200);
    expect(patched.body.tax_warning).toBeTruthy();
    expect(patched.body.tax_warning.new_state).toBe('NH');

    // The new location accreted onto the job's customer and is now the job's service_location.
    const jobAfter = await api.getJob(jobId);
    expect(jobAfter.service_location?.state).toBe('NH');

    // A JOB_LOCATION_CHANGED timeline event was written.
    const tl = await api.getJobTimeline(jobId);
    const events: any[] = tl.events ?? [];
    expect(events.some((e) => e.event_type === 'JOB_LOCATION_CHANGED')).toBe(true);

    // The originating lead's OWN service location/state is NEVER touched (lead = as-sold,
    // job = as-executed). The lead still reads MA (or its original null), not NH.
    const leadAfter = await api.getLead(ctx.leadId);
    expect({
      service_state: leadAfter.service_state ?? null,
      service_address_line1: leadAfter.service_address_line1 ?? null,
      service_city: leadAfter.service_city ?? null,
      service_zip: leadAfter.service_zip ?? null,
    }).toEqual(asSoldBefore);
    // And the lead never reports the NH state on any of its own as-sold fields.
    expect(leadAfter.service_state ?? '').not.toBe('NH');

    // The accretion DID land on the shared customer (proving the location moved on the customer,
    // not on the lead): an NH location is now present in the customer's service_locations.
    const customerLocs: any[] = leadAfter.customer?.service_locations ?? [];
    expect(customerLocs.some((l) => l.state === 'NH')).toBe(true);
  });

  // ─── JOB-09 ──────────────────────────────────────────────────────────────
  test('JOB-09: tax_warning absent when state unchanged — same-state (MA) edit -> no warning', async () => {
    const { jobId } = await jobFromPaidDepositEstimate(10_000, 30); // MA service location

    // Patch to a DIFFERENT MA address (same state) -> buildLocationTaxWarning returns null,
    // and the controller omits the key entirely.
    const patched = await api.updateJob(jobId, {
      address: { address_line1: '99 Newbury St', city: 'Boston', state: 'MA', zip: '02116' },
    });
    expect(patched.res.status()).toBe(200);
    expect(patched.body.tax_warning ?? null).toBeNull();
    // Location still changed (accreted), just no cross-state tax warning.
    expect((await api.getJob(jobId)).service_location?.state).toBe('MA');
  });

  // ─── JOB-10 ──────────────────────────────────────────────────────────────
  test('JOB-10: reopen (admin, COMPLETED->IN_PROGRESS) ok pre-invoice; blocked once a SENT invoice exists', async () => {
    // Two full deposit chains, each followed by completeJob (tech create + assign + start +
    // complete) — many serial calls, finite work. Raise the budget above the default 75s.
    test.setTimeout(120_000);
    // (a) COMPLETED job with NO issued invoice -> reopen succeeds.
    {
      const { jobId } = await jobFromPaidDepositEstimate(10_000, 30);
      await completeJob(jobId);
      const reopened = await api.reopenJob(jobId);
      expect(reopened.res.status()).toBe(200);
      expect(reopened.body.job.status).toBe('IN_PROGRESS');
      expect(reopened.body.job.completed_at ?? null).toBeNull();
    }
    // (b) COMPLETED job with a SENT invoice -> reopen blocked 400.
    {
      const { jobId } = await jobFromPaidDepositEstimate(10_000, 30);
      await completeJob(jobId);
      const { body: invBody } = await api.createInvoice(jobId);
      await api.sendInvoice(invBody.invoice.id); // SENT-or-beyond blocks reopen (DRAFT/VOIDED do not)
      const blocked = await api.reopenJob(jobId);
      expect(blocked.res.status()).toBe(400);
      expect(blocked.body.error).toBe('Cannot reopen a job with an issued invoice');
    }
  });

  // ─── JOB-11 ──────────────────────────────────────────────────────────────
  test('JOB-11: cancelled-job-deposit independence — deposit money NOT in job collected_total, still refundable', async () => {
    const ctx = await maEstimateSentWithDeposit(api, 10_000, 30);
    await api.markDepositReceived(ctx.estimateId, { payment_method: 'CHECK' }); // deposit PAID, estimate WON

    const { body: jobBody } = await api.createJob({ estimate_id: ctx.estimateId });
    const { res: cancelRes, body: cancel } = await api.cancelJob(jobBody.job.id, 'scheduling');
    expect(cancelRes.status()).toBe(200);
    // Deposit anchors to the ESTIMATE invoice, not the job -> the job has no collected cash.
    expect(Number(cancel.collected_total ?? 0)).toBe(0);
    expect(cancel.refund_suggested).toBe(false);

    // The deposit is still independently refundable via its own (PAID) deposit invoice.
    const dep = (await api.getEstimate(ctx.estimateId)).invoices[0];
    const refund = await api.refundInvoice(dep.id, {
      amount: 1000, reason: 'x', reason_category: 'CUSTOMER_REQUEST',
    });
    expect(refund.res.status()).toBe(200);
    await assertInvoiceReconciles(api, dep.id, 'JOB-11');
  });

  // ─── JOB-12 ──────────────────────────────────────────────────────────────
  test('JOB-12: cancel cascade — voids open invoices to $0, surfaces collected, ->CANCELLED; blocked once COMPLETED; deposit-credit not counted as cash', async () => {
    // Full deposit chain + invoice/send/payment/cancel, then a second chain + completeJob for the
    // blocked-when-COMPLETED branch — many serial calls, finite. Raise the budget above 75s.
    test.setTimeout(120_000);
    // Cascade: job with a SENT STANDARD invoice carrying a real cash payment AND a synthetic
    // DEPOSIT-CREDIT (from drawing down a PAID deposit). collected_total must count ONLY the cash.
    const ctx = await maEstimateSentWithDeposit(api, 10_000, 30);
    await api.markDepositReceived(ctx.estimateId, { payment_method: 'CHECK' }); // deposit PAID
    const dep = await api.getDepositInvoice(ctx.estimateId);
    const depositAmount = Number(dep!.total_amount); // synthetic DEPOSIT-CREDIT amount on the standard invoice

    const { body: jobBody } = await api.createJob({ estimate_id: ctx.estimateId });
    const jobId = jobBody.job.id;

    const { body: invBody } = await api.createInvoice(jobId); // STANDARD invoice, deposit drawn down
    const invId = invBody.invoice.id;
    await api.sendInvoice(invId); // SENT so cancel can void it
    const sent = await api.getInvoice(invId);

    // Record a real cash partial payment (less than amount_due so the invoice stays open/PARTIAL).
    const cashAmount = 500;
    const pay = await api.recordPayment(invId, { amount: cashAmount, method: 'CASH' });
    expect(pay.res.status()).toBe(201); // recordPayment -> 201 Created
    await assertInvoiceReconciles(api, invId, 'JOB-12 pre-cancel');

    const { res, body: cancel } = await api.cancelJob(jobId, 'customer backed out');
    expect(res.status()).toBe(200);
    expect(cancel.job.status).toBe('CANCELLED');
    // The open (PARTIAL) invoice was voided to $0.
    expect(cancel.voided_invoice_ids).toContain(invId);
    const voidedInv = await api.getInvoice(invId);
    expect(voidedInv.status).toBe('VOIDED');
    expect(Number(voidedInv.amount_due)).toBe(0);
    // collected_total counts the real cash but NOT the synthetic DEPOSIT-CREDIT payment.
    expect(Number(cancel.collected_total)).toBe(cashAmount);
    expect(Number(cancel.collected_total)).not.toBe(cashAmount + depositAmount);
    expect(cancel.refund_suggested).toBe(true);
    expect(Number(sent.total_amount)).toBeGreaterThan(0); // sanity: standard invoice had a real bill

    // Blocked once COMPLETED.
    const { jobId: completedJobId } = await jobFromPaidDepositEstimate(10_000, 30);
    await completeJob(completedJobId);
    const blocked = await api.cancelJob(completedJobId, 'too late');
    expect(blocked.res.status()).toBe(400);
    expect(String(blocked.body.error)).toBe('Cannot cancel a completed job');
  });

  // ─── JOB-13 ──────────────────────────────────────────────────────────────
  test('JOB-13: invoice-on-CANCELLED-job blocked -> 400', async () => {
    const { jobId } = await jobFromPaidDepositEstimate(10_000, 30);
    const cancelled = await api.cancelJob(jobId, 'no longer needed');
    expect(cancelled.res.status()).toBe(200);
    expect(cancelled.body.job.status).toBe('CANCELLED');

    const { res, body } = await api.createInvoice(jobId);
    expect(res.status()).toBe(400);
    expect(body.error).toBe('Cannot invoice a cancelled job');
  });

  // ─── JOB-14 ──────────────────────────────────────────────────────────────
  test('JOB-14: delete only UNASSIGNED + no non-voided invoice — assigned/invoiced -> 400 (status guard before invoice guard)', async () => {
    // Three sub-blocks, two of which run a full deposit chain (+ tech/assign or invoice) — many
    // serial calls, finite work. Raise the budget above the default 75s.
    test.setTimeout(120_000);
    // (a) UNASSIGNED, no invoice -> delete succeeds.
    {
      const { customerId, locationId } = await createMaCustomerWithLocation(api);
      const { body } = await api.createJob({ customer_id: customerId, service_location_id: locationId });
      const del = await api.deleteJob(body.job.id);
      expect(del.status).toBe(200);
      // The job is gone — a follow-up GET 404s.
      const probe = await api.raw('get', `/api/jobs/${body.job.id}`);
      expect(probe.res.status()).toBe(404);
    }
    // (b) SCHEDULED (assigned) job -> blocked by the status guard FIRST.
    {
      const { jobId } = await jobFromPaidDepositEstimate(10_000, 30);
      const techId = await createTech(api);
      await api.assignJob(jobId, {
        assignee_ids: [techId],
        scheduled_start: api.futureDate(48),
        scheduled_end: api.futureDate(50),
      });
      const del = await api.deleteJob(jobId);
      expect(del.status).toBe(400);
    }
    // (c) UNASSIGNED job that has a non-voided invoice -> blocked by the invoice guard.
    //     createInvoice works on a non-CANCELLED job regardless of status, so the job stays UNASSIGNED.
    {
      const { jobId } = await jobFromPaidDepositEstimate(10_000, 30);
      const { res: invRes } = await api.createInvoice(jobId);
      expect(invRes.status()).toBe(201);
      expect((await api.getJob(jobId)).status).toBe('UNASSIGNED'); // creating an invoice does not change job status
      const del = await api.deleteJob(jobId);
      expect(del.status).toBe(400);
    }
  });
});
