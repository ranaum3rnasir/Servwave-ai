import { test, expect } from '@playwright/test';
import { ApiClient } from '../../helpers/api-client';
import {
  createMaCustomerWithLocation,
  createContactedLead,
  leadToSentEstimate,
  leadToSentEstimateWithDeposit,
  uniquePhone,
} from '../../helpers/workflow-builders';
import { assertInvoiceReconciles } from '../../helpers/reconcile';

/**
 * redesign-27 — DISPATCHER persona day (catalog X-11) + dispatcher edge/breakage grid
 * (catalog X-12) + dispatcher execution-mismatch probes (DLV-21b/c/d).
 *
 * WRITTEN 2026-06-10, NOT YET EXECUTED — every expectation below is a STATIC
 * PREDICTION derived from controller/grant code, not from a baseline run.
 *
 * WHY: the whole gate runs as the provisioned org ADMIN (CASL manage-all), which
 * BYPASSES the permission layer; redesign-22 covers what roles CANNOT do, but no spec
 * has ever run the dispatcher's POSITIVE operational day under dispatcher credentials.
 * This file is that day (X-11), plus the guards that must still fire on him (X-12),
 * plus the three remaining execution actions the DLV-21 probe family predicted but
 * never exercised (en_route/arrive/complete → DLV-21b/c/d).
 *
 * Per-role auth: `ApiClient.init({email,password})` does an eager POST /api/auth/login.
 * Role users are admin-created via POST /api/users (Supabase admin.createUser with
 * email_confirm:true → instantly loggable). seedRoleUser is copied from redesign-22.
 *
 * DISPATCHER grant facts (backend/src/lib/permissions/defaultGrants.ts:55-114 — the
 * authoritative list; route guard canGuard.ts:10-12 → 403 'Insufficient permissions'):
 *  - Estimate: read + record_payment + waive_deposit ONLY (:73-75). NO create/send/
 *    update/delete/cancel/revise/duplicate → those routes 403 at the guard (X-12c).
 *  - Job: create/read/update/delete/assign/unassign/en_route/arrive/start/complete/
 *    cancel (:77-87) — NO `reopen` ⇒ POST /:id/reopen 403s at the route guard
 *    (job.routes.ts:34 canDo('reopen','Job')) before any controller logic (X-12d).
 *  - Invoice: create/read/update/delete/send/record_payment (:88-93) — NO refund/
 *    credit/void_payment/void (admin-only money levers, invoice.routes.ts:28-31).
 *  - Lead: create/read/update/assign/contact/mark_lost/cancel/delete/
 *    schedule_walkthrough, all UNconditioned (:63-71). Customer: create/read/update/
 *    delete/export/archive (:57-62). `perform Walkthrough` (:72).
 *  - NO be_assigned on Job or Lead → can never be an assignment target himself.
 *
 * Controller facts the predictions lean on (file:line on this tree):
 *  - lead.controller.ts:535 — only SALES auto-assigns self on create ⇒ a dispatcher-
 *    created lead starts UNASSIGNED. :978-980 contact is NEW-only. :1018-1020
 *    schedule-walkthrough needs CONTACTED/WALKTHROUGH_COMPLETED/_SCHEDULED.
 *    :1030-1037 performer must be active + hold `perform Walkthrough` (DISPATCHER and
 *    TECHNICIAN both hold it → both are eligible performers). :1147-1155
 *    walkthrough/complete = status guard, then manage-all OR the assigned performer —
 *    the error string names "Dispatcher" but the CODE checks `manage all`, which
 *    DISPATCHER does NOT have ⇒ a dispatcher can complete ONLY his own walkthroughs
 *    (X-11a step 5b documents the contradiction; X-11c is the positive self-perform).
 *    :891-935 lead-assign has NO status guard; target needs be_assigned Lead (SALES
 *    only) else 400 (:910-913). :856-861 delete blocked when estimates exist.
 *    CASCADES (X-12e): cancelLead :1285-1296 cancels DRAFT/SENT/PENDING estimates via
 *    RAW prisma.estimate.updateMany and :1298-1303 voids unpaid DRAFT/SENT deposit
 *    invoices via voidUnpaidDepositInvoices (:286-304, raw updateMany) — NO ability
 *    check on either sub-step, so the dispatcher's cancel-Lead grant transitively
 *    cancels estimates + voids invoices he holds no grant for. markLost mirrors it
 *    (:1477-1495) and auto-cancels a scheduled walkthrough (:1443-1449).
 *  - estimate.controller.ts:1299-1306 record-payment is DRAFT/SENT/PENDING-only;
 *    WON → 400 'Estimate is already approved/paid'. The paying tx :1325-1379:
 *    Payment row on the kind=DEPOSIT invoice + invoice PAID/amount_due 0 (:1333-1347),
 *    estimate WON (:1351-1358), lead WON (:1374-1379) — the SEL-18 three-way
 *    flip, here executed by a DISPATCHER for the first time. waive :2218-2227: the
 *    ESTIMATE-status guard (SENT/PENDING-only, exact string 'Cannot waive deposit on
 *    a won estimate' — template lower-cases WON) fires BEFORE the
 *    no-active-deposit check, so "waive a PAID deposit" always lands on the estimate
 *    guard (paying a deposit always approves the estimate first). waive tx
 *    :2241-2279: deposit invoice VOIDED 'Deposit waived' + estimate WON + lead
 *    WON. send :1078-1118 creates the deposit invoice SENT inside the tx AFTER the
 *    response row was selected ⇒ the send RESPONSE's estimate.invoices is stale —
 *    always re-fetch the estimate to read the deposit invoice.
 *  - job.controller.ts:463-466 'Estimate must be WON to create a job' fires
 *    BEFORE the deposit gate (:471-479, whose G2 string 'Deposit must be paid or
 *    waived…' is unreachable from a merely-SENT estimate). VOIDED (waived) deposit is
 *    in DEPOSIT_OK (:471) ⇒ job creation passes after a waive. :537-541 second job on
 *    the estimate → P2002 → 409 (the Job.estimate_id unique — even a CANCELLED job
 *    blocks). :731-734 assign needs UNASSIGNED/SCHEDULED; :747-750 target needs
 *    be_assigned Job (TECHNICIAN only). :902-904 unassign is SCHEDULED-only.
 *    start/complete/en_route/arrive all check STATUS FIRST, then manage-all-OR-
 *    assigned-tech (:950-959, :1003-1012, :1251-1259, :1317-1325) — DISPATCHER passes
 *    the route guards (he holds all four action grants) but is neither manage-all nor
 *    ever the assigned tech ⇒ 403 (DLV-21 family). cancel :1078-1081 allows
 *    UNASSIGNED/SCHEDULED/IN_PROGRESS; :1104-1114 voids SENT/PARTIAL invoices RAW
 *    (amount_due forced to 0, no void-grant check); :1093-1101 collected_total
 *    excludes synthetic DEPOSIT-CREDIT rows; response :1160-1165 = {job,
 *    collected_total, refund_suggested, voided_invoice_ids}. reopen :1189-1199 is
 *    COMPLETED-only + no issued invoice (admin-only in practice via the route grant).
 *  - invoice.controller.ts guard ORDER on create: cancelled-job 400 (:324-326) →
 *    one-active 409 (:330-338) → role backstops (:340-345) → no-line-items 400
 *    (:350-353). recordPayment ORDER: 404 → status 400 'Payments can only be recorded
 *    on SENT or PARTIAL invoices' (:930-932) → canAccessInvoice 403 (:937-939;
 *    DISPATCHER is hard-true :96) → 201 {invoice, payment, overpaid} (:1049).
 *    update/remove/send are DRAFT-only with NO canAccess check (:676-677, :699-703 →
 *    204, :717-718) ⇒ the dispatcher's delete-Invoice grant really deletes DRAFTs.
 *    Deposit drawdown: a PAID deposit invoice mints deposit_credit on the STANDARD
 *    invoice + ONE synthetic Payment with reference_number 'DEPOSIT-CREDIT' (:26,
 *    :459-480) — mirrored from redesign-20's settled-gate decomposition.
 *
 * ONE shared org, serial (workers:1, fullyParallel:false — do NOT parallelize); data
 * accumulates — presence/absence by OUR ids only, never counts; money asserts are
 * derived deltas (deposit % is pinned to 50 in beforeAll because earlier specs PATCH
 * the same org AppSetting). assertInvoiceReconciles after every money mutation —
 * EXCEPT freshly-VOIDED invoices: the cancel cascade forces amount_due to 0 by fiat
 * (job.controller.ts:1113), which intentionally breaks the live-invoice ledger
 * formula, so voided rows assert amount_due/status directly instead.
 */

const PASSWORD = 'Test123!@#'; // same as the workflow-builders role users
const DEPOSIT_CREDIT_REF = 'DEPOSIT-CREDIT'; // invoice.controller.ts:26
const round2 = (n: number) => Math.round(n * 100) / 100;

let admin: ApiClient;
let dispatcher: ApiClient;
let sales: ApiClient;
let tech: ApiClient;
let dispatcherId: string;
let salesId: string;
let techId: string;

/** Admin-create a role user (Supabase Auth email_confirm:true → instantly loggable),
 *  then open a SEPARATE ApiClient session as that user. (Copied from redesign-22.) */
async function seedRoleUser(role: 'SALES' | 'TECHNICIAN' | 'DISPATCHER', tag: string) {
  const email = `x27-${tag}-${admin.suffix}@e2e-qa.invalid`;
  const { res, body } = await admin.createUser({
    email, password: PASSWORD, first_name: 'DispDay', last_name: tag, role,
  });
  expect(res.status(), `seed ${role} user (${tag})`).toBe(201);
  const client = await new ApiClient().init({ email, password: PASSWORD });
  expect(client.authToken, `login as ${tag} (${role})`).toBeTruthy();
  return { id: body.user.id as string, client };
}

test.beforeAll(async () => {
  admin = await new ApiClient().init(); // provisioned throwaway-org admin

  ({ id: dispatcherId, client: dispatcher } = await seedRoleUser('DISPATCHER', 'dispatcher'));
  ({ id: salesId, client: sales } = await seedRoleUser('SALES', 'sales'));
  ({ id: techId, client: tech } = await seedRoleUser('TECHNICIAN', 'tech'));

  // Pin the org deposit % to 50: estimate.send derives the deposit from the org
  // AppSetting `deposit_percentage` (estimate.controller.ts:1010-1011, 1034) and
  // earlier serial specs PATCH the same key (workflow-builders maEstimateSentWithDeposit)
  // — without the pin a 100% leftover would zero amount_due and sever X-11a's pay tail.
  // Admin-side: the route is canDo('update','AppSetting') (settings.routes.ts:13) and
  // DISPATCHER only holds read AppSetting (defaultGrants.ts:100).
  const pin = await admin.raw('patch', '/api/settings/deposit_percentage', { value: '50' });
  expect(pin.res.status(), 'pin org deposit_percentage to 50').toBe(200);
});

test.afterAll(async () => {
  for (const c of [dispatcher, sales, tech, admin]) {
    try { await c?.dispose(); } catch { /* partial beforeAll failure — nothing to dispose */ }
  }
});

// ── shared seed helpers ───────────────────────────────────────────────────────

/** Standalone (no-estimate) job on a fresh admin-owned customer. UNASSIGNED.
 *  (Copied from redesign-22 — admin-side seeding keeps probe setup canonical.) */
async function adminStandaloneJob() {
  const { customerId, locationId } = await createMaCustomerWithLocation(admin);
  const { res, body } = await admin.createJob({
    customer_id: customerId, service_location_id: locationId,
  });
  expect(res.status(), 'seed standalone job').toBe(201);
  return { customerId, locationId, jobId: body.job.id as string };
}

/** Approved (no-deposit) estimate: leadToSentEstimate + public approval ⇒ WON,
 *  no kind=DEPOSIT invoice, the job-create deposit gate has nothing to gate. */
async function adminApprovedEstimate() {
  const ctx = await leadToSentEstimate(admin); // deposit: false by default
  const approved = await admin.approveEstimatePublic(ctx.estimateId, ctx.publicToken, {
    signature_data: admin.testSignature,
  });
  expect(approved.res.status(), 'seed public approval').toBe(200);
  expect((await admin.getEstimate(ctx.estimateId)).status).toBe('WON');
  return ctx;
}

/**
 * The dispatcher intake half of the day, compressed (X-11b/X-11c reuse; X-11a runs the
 * same chain INLINE with per-hop asserts — it is the gate spine):
 * admin customer/location → dispatcher lead → contact → walkthrough scheduled on the
 * seeded TECH → TECH completes (the dispatcher CANNOT complete someone else's
 * walkthrough, lead.controller.ts:1153) → dispatcher assigns the lead to SALES →
 * SALES creates + sends the estimate with a deposit. Returns ids.
 */
async function dispatcherIntakeToSalesSentEstimate(methods: string[]) {
  const { customerId, locationId } = await createMaCustomerWithLocation(admin);
  const lead = await dispatcher.createLead({
    customer_id: customerId,
    service_request: `x27-intake-${admin.suffix}`,
    service_location_id: locationId,
  });
  expect(lead.res.status(), 'dispatcher lead').toBe(201);
  const leadId = lead.body.lead.id as string;
  expect((await dispatcher.contactLead(leadId)).res.status(), 'dispatcher contact').toBe(200);
  expect((await dispatcher.scheduleWalkthrough(leadId, {
    walkthrough_scheduled_at: admin.futureDate(30),
    performer_ids: [techId],
  })).res.status(), 'dispatcher schedules walkthrough').toBe(200);
  expect((await tech.completeWalkthrough(leadId)).res.status(), 'tech completes walkthrough').toBe(200);
  expect((await dispatcher.assignLead(leadId, salesId)).res.status(), 'dispatcher assigns lead to sales').toBe(200);

  const est = await sales.createEstimate({
    lead_id: leadId,
    line_items: [{ description: 'Dispatcher-day work', quantity: 1, unit_price: 800, is_taxable: true }],
  });
  expect(est.res.status(), 'sales creates estimate on own lead').toBe(201);
  const estimateId = est.body.estimate.id as string;
  const sent = await sales.sendEstimate(estimateId, { deposit_required: true, payment_methods: methods });
  expect(sent.res.status(), 'sales sends estimate with deposit').toBe(200);
  expect(sent.body.estimate.status).toBe('SENT');
  return { customerId, locationId, leadId, estimateId };
}

// ═════════════════════════════════════════════════════════════════════════════
test.describe('redesign-27 dispatcher day — X-11 operational spine (run AS dispatcher)', () => {
  // ── X-11a ──────────────────────────────────────────────────────────────────
  test('X-11a: full day-chain — intake → walkthrough → sales estimate → dispatcher records deposit (SEL-18 flip) → job → tech executes → dispatcher invoices + collects CHECK', async () => {
    // Two seeded role-user logins already exist; the chain itself is ~20 serial calls
    // incl. a deposit + a full invoice payment — raise the budget like GLD-01 does.
    test.setTimeout(180_000);

    // 1. Dispatcher creates the customer himself (create Customer grant,
    //    defaultGrants.ts:57). kind/segment included — Zod-optional but Prisma
    //    NOT-NULL; uniquePhone() dodges the duplicate-customer guard (PR #135).
    const cust = await dispatcher.raw('post', '/api/customers', {
      kind: 'PERSON', segment: 'RESIDENTIAL',
      first_name: 'DispDay', last_name: 'Customer',
      email: `x27-day-${admin.suffix}@e2e-qa.invalid`, phone: uniquePhone(),
    });
    expect(cust.res.status(), 'step 1: dispatcher creates customer').toBe(201);
    const customerId = cust.body.customer.id as string;

    // 2. Dispatcher adds the service location — POST /:id/locations rides the
    //    update-Customer grant (customer.routes.ts:45), which DISPATCHER holds.
    //    MA so the estimate tax derives from the global 6.25% fixture.
    const loc = await dispatcher.raw('post', `/api/customers/${customerId}/locations`, {
      address_line1: `${Math.floor(Math.random() * 9999)} Harbor Way`,
      city: 'Boston', state: 'MA', zip: '02110', is_primary: true,
    });
    expect(loc.res.status(), 'step 2: dispatcher adds location').toBe(201);
    const locationId = loc.body.location.id as string;

    // 3. Dispatcher creates the lead. Only SALES auto-assigns self on create
    //    (lead.controller.ts:535) — a dispatcher-created lead starts UNASSIGNED.
    const lead = await dispatcher.createLead({
      customer_id: customerId,
      service_request: `x27-day-${admin.suffix}`,
      service_location_id: locationId,
    });
    expect(lead.res.status(), 'step 3: dispatcher creates lead').toBe(201);
    const leadId = lead.body.lead.id as string;
    expect(lead.body.lead.commission_owner, 'dispatcher lead starts unassigned').toBeNull();
    expect(lead.body.lead.status).toBe('NEW');

    // 4. Contact (NEW-only guard, lead.controller.ts:978; dispatcher's contact grant
    //    is unconditioned).
    const contacted = await dispatcher.contactLead(leadId);
    expect(contacted.res.status(), 'step 4: dispatcher contacts lead').toBe(200);
    expect(contacted.body.lead.status).toBe('CONTACTED');

    // 5. Schedule the walkthrough with the TECH as performer — TECHNICIAN holds
    //    `perform Walkthrough` (defaultGrants.ts:119) so the controller eligibility
    //    check (lead.controller.ts:1034-1037) passes. The client wrapper defaults
    //    force:true (dodges 409s as the tech accumulates bookings in this serial run).
    const wt = await dispatcher.scheduleWalkthrough(leadId, {
      walkthrough_scheduled_at: admin.futureDate(26),
      performer_ids: [techId],
    });
    expect(wt.res.status(), 'step 5: dispatcher schedules walkthrough').toBe(200);
    expect(wt.body.lead.status).toBe('WALKTHROUGH_SCHEDULED');

    // 5b. The dispatcher CANNOT complete a walkthrough performed by someone else:
    //     the controller requires manage-all OR the assigned performer
    //     (lead.controller.ts:1153) and DISPATCHER is neither. The 403 string
    //     literally names "Dispatcher" as allowed — message/code contradiction,
    //     asserted verbatim so a baseline flip is loud. (X-11c proves the positive:
    //     he CAN complete his OWN walkthrough.)
    const wrongComplete = await dispatcher.completeWalkthrough(leadId);
    expect(wrongComplete.res.status(), 'step 5b: dispatcher cannot complete tech walkthrough').toBe(403);
    expect(String(wrongComplete.body.error))
      .toBe('Only the assigned performer, Admin, or Dispatcher can complete this walkthrough');

    // 6. The assigned TECH completes it (route canDo('perform','Walkthrough'),
    //    lead.routes.ts:37; controller passes — he IS the performer).
    const done = await tech.completeWalkthrough(leadId);
    expect(done.res.status(), 'step 6: tech completes walkthrough').toBe(200);
    expect(done.body.lead.status).toBe('WALKTHROUGH_COMPLETED');

    // 7. Dispatcher assigns the lead to SALES (assign Lead grant; SALES holds
    //    be_assigned Lead — defaultGrants.ts:26; no status guard on assign).
    const owner = await dispatcher.assignLead(leadId, salesId);
    expect(owner.res.status(), 'step 7: dispatcher assigns lead to sales').toBe(200);
    expect(owner.body.lead.commission_owner.id).toBe(salesId);

    // 8. SALES creates the estimate on the now-own lead (estimate.controller.ts:672
    //    owner check passes; the walkthrough gate is satisfied — WALKTHROUGH_COMPLETED
    //    is not a blocked status, :666-670).
    const est = await sales.createEstimate({
      lead_id: leadId,
      line_items: [{ description: 'Door install (dispatcher day)', quantity: 1, unit_price: 800, is_taxable: true }],
    });
    expect(est.res.status(), 'step 8: sales creates estimate').toBe(201);
    const estimateId = est.body.estimate.id as string;

    // 9. SALES sends WITH a deposit; CHECK among the methods (the customer will mail
    //    a check — no public approval in this chain). First send: estimate → SENT,
    //    lead → ESTIMATED (estimate.controller.ts:1172-1192), kind=DEPOSIT invoice
    //    created SENT (:1078-1118). The send RESPONSE selects the estimate BEFORE the
    //    deposit-invoice insert in the same tx (:1036 vs :1088) — re-fetch to see it.
    const sent = await sales.sendEstimate(estimateId, {
      deposit_required: true, payment_methods: ['CHECK', 'CASH'],
    });
    expect(sent.res.status(), 'step 9: sales sends estimate').toBe(200);
    expect(sent.body.estimate.status).toBe('SENT');
    expect((await dispatcher.getLead(leadId)).status, 'lead ESTIMATED after send').toBe('ESTIMATED');

    const estAfterSend = await dispatcher.getEstimate(estimateId); // dispatcher read Estimate ✓
    const depInv = estAfterSend.invoices?.[0];
    expect(depInv, 'deposit invoice exists after send').toBeTruthy();
    expect(depInv.kind).toBe('DEPOSIT');
    expect(depInv.status).toBe('SENT');
    const estimateTotal = Number(estAfterSend.total_amount);
    const depositAmount = Number(depInv.total_amount);
    // Derived, not absolute: deposit = 50% of the estimate total (the pinned org %).
    expect(round2(depositAmount), 'deposit is the pinned 50%').toBe(round2(estimateTotal / 2));

    // 10. THE P0 MOMENT (SEL-18 as a non-admin for the first time): the customer
    //     mails a check; the DISPATCHER records the deposit payment on the estimate
    //     (route canDo('record_payment','Estimate') — defaultGrants.ts:74). One call
    //     must flip all three documents (estimate.controller.ts:1325-1379).
    const rec = await dispatcher.markDepositReceived(estimateId, {
      amount: depositAmount, payment_method: 'CHECK', reference_number: `CHK-${admin.suffix}`,
    });
    expect(rec.res.status(), 'step 10: dispatcher records deposit payment').toBe(200);
    expect(rec.body.estimate.status, 'flip 1/3: estimate WON').toBe('WON');

    const depInvPaid = await dispatcher.getInvoice(depInv.id); // dispatcher read Invoice ✓ (:96)
    expect(depInvPaid.status, 'flip 2/3: deposit invoice PAID').toBe('PAID');
    expect(Number(depInvPaid.amount_due)).toBe(0);
    expect((await dispatcher.getLead(leadId)).status, 'flip 3/3: lead WON').toBe('WON');
    await assertInvoiceReconciles(admin, depInv.id, 'X-11a deposit paid');

    // 11. Dispatcher creates the job from the estimate (create Job grant; estimate
    //     WON + deposit PAID ⇒ both job-create gates pass, job.controller.ts:463,471).
    const job = await dispatcher.createJob({ estimate_id: estimateId });
    expect(job.res.status(), 'step 11: dispatcher creates job').toBe(201);
    const jobId = job.body.job.id as string;
    expect(job.body.job.status).toBe('UNASSIGNED');

    // 12. Dispatcher assigns the TECH with dates (+force — accumulated bookings).
    const assigned = await dispatcher.assignJob(jobId, {
      assignee_ids: [techId],
      scheduled_start: admin.futureDate(140),
      scheduled_end: admin.futureDate(142),
      force: true,
    });
    expect(assigned.res.status(), 'step 12: dispatcher assigns tech').toBe(200);
    expect(assigned.body.job.status).toBe('SCHEDULED');

    // 13. The TECH executes his own job (own-job start/complete — the dispatcher
    //     could NOT do these two, see DLV-21/DLV-21d).
    expect((await tech.startJob(jobId)).res.status(), 'step 13: tech starts').toBe(200);
    const completed = await tech.completeJob(jobId, 'Dispatcher-day completion (X-11a)');
    expect(completed.res.status(), 'step 13: tech completes').toBe(200);
    expect(completed.body.job.status).toBe('COMPLETED');

    // 14. Dispatcher creates the invoice. The PAID deposit draws down as
    //     deposit_credit + ONE synthetic DEPOSIT-CREDIT payment row
    //     (invoice.controller.ts:421-435, 459-480) — the same decomposition the
    //     redesign-20 settled gate asserts.
    const inv = await dispatcher.createInvoice(jobId);
    expect(inv.res.status(), 'step 14: dispatcher creates invoice').toBe(201);
    const invoiceId = inv.body.invoice.id as string;
    const invTotal = Number(inv.body.invoice.total_amount);
    expect(round2(invTotal), 'invoice bills the estimate total').toBe(round2(estimateTotal));
    expect(round2(Number(inv.body.invoice.deposit_credit)), 'deposit credit drawn').toBe(round2(depositAmount));
    expect(round2(Number(inv.body.invoice.amount_due)), 'amount_due = total − credit')
      .toBe(round2(invTotal - depositAmount));
    // The create-invoice RESPONSE snapshots the invoice BEFORE the synthetic
    // DEPOSIT-CREDIT payment is inserted (invoice.controller.ts:443 select vs :475
    // insert), so inv.body.invoice.payments is empty here — re-fetch via GET to see it.
    const full = await dispatcher.getInvoice(invoiceId);
    const synthetic = (full.payments ?? [])
      .filter((p: any) => p.reference_number === DEPOSIT_CREDIT_REF);
    expect(synthetic, 'exactly one synthetic DEPOSIT-CREDIT payment').toHaveLength(1);
    expect(round2(Number(synthetic[0].amount))).toBe(round2(depositAmount));
    await assertInvoiceReconciles(admin, invoiceId, 'X-11a invoice created (credit applied)');

    // 15. Dispatcher sends it (send Invoice grant; DRAFT-only guard,
    //     invoice.controller.ts:718 — no canAccess check on send).
    const sentInv = await dispatcher.sendInvoice(invoiceId);
    expect(sentInv.res.status(), 'step 15: dispatcher sends invoice').toBe(200);
    expect(sentInv.body.invoice.status).toBe('SENT');
    const amountDue = Number(sentInv.body.invoice.amount_due);
    expect(amountDue).toBeGreaterThan(0);

    // 16. Dispatcher records the customer's CHECK for the full balance
    //     (record_payment Invoice grant; canAccessInvoice is DISPATCHER-true, :96).
    const pay = await dispatcher.recordPayment(invoiceId, {
      amount: amountDue, method: 'CHECK', reference_number: `CHK2-${admin.suffix}`,
      notes: 'Final balance check (X-11a)',
    });
    expect(pay.res.status(), 'step 16: dispatcher records final payment').toBe(201);
    expect(pay.body.invoice.status).toBe('PAID');
    expect(Number(pay.body.invoice.amount_due)).toBe(0);
    expect(pay.body.invoice.paid_at).toBeTruthy();

    // Settled decomposition: real payments == total − credit; synthetic row intact.
    const finalInv = await dispatcher.getInvoice(invoiceId);
    const live = (finalInv.payments ?? []).filter((p: any) => !p.voided_at);
    const realSum = live
      .filter((p: any) => p.reference_number !== DEPOSIT_CREDIT_REF)
      .reduce((s: number, p: any) => s + Number(p.amount), 0);
    expect(round2(realSum), 'real payments == total − deposit credit').toBe(round2(invTotal - depositAmount));
    await assertInvoiceReconciles(admin, invoiceId, 'X-11a settled');
  });

  // ── X-11b ──────────────────────────────────────────────────────────────────
  test('X-11b: waive variant — dispatcher waives the deposit (invoice VOIDED + estimate WON + lead WON) → invoice carries NO deposit credit', async () => {
    test.setTimeout(120_000); // one full intake chain + invoice payment

    const ctx = await dispatcherIntakeToSalesSentEstimate(['CHECK']);

    // Deposit invoice exists SENT (re-fetch — the send response's invoices[] is stale).
    const estSent = await dispatcher.getEstimate(ctx.estimateId);
    const depInv = estSent.invoices?.[0];
    expect(depInv?.status, 'deposit invoice SENT before waive').toBe('SENT');

    // Dispatcher waives (route canDo('waive_deposit','Estimate') — defaultGrants.ts:75).
    // waive tx (estimate.controller.ts:2241-2279): deposit invoice → VOIDED
    // 'Deposit waived', estimate → WON, lead → WON.
    const waived = await dispatcher.waiveDeposit(ctx.estimateId, 'waive');
    expect(waived.res.status(), 'dispatcher waives deposit').toBe(200);
    expect(waived.body.estimate.status).toBe('WON');

    const depAfter = await dispatcher.getInvoice(depInv.id);
    expect(depAfter.status, 'deposit invoice VOIDED by waive').toBe('VOIDED');
    expect(String(depAfter.voided_reason)).toBe('Deposit waived'); // :2248
    expect((await dispatcher.getLead(ctx.leadId)).status, 'lead WON after waive').toBe('WON');

    // Job creation passes the deposit gate — VOIDED is in DEPOSIT_OK (job.controller.ts:471).
    const job = await dispatcher.createJob({ estimate_id: ctx.estimateId });
    expect(job.res.status(), 'job after waive').toBe(201);
    const jobId = job.body.job.id as string;

    // Invoice on the UNASSIGNED job (only a CANCELLED job blocks invoicing,
    // invoice.controller.ts:326 — scheduling/completion are NOT required): no PAID
    // deposit exists ⇒ deposit_credit 0, NO synthetic payment row (:424-431).
    const inv = await dispatcher.createInvoice(jobId);
    expect(inv.res.status(), 'invoice after waive').toBe(201);
    const invoiceId = inv.body.invoice.id as string;
    expect(Number(inv.body.invoice.deposit_credit), 'no deposit credit after waive').toBe(0);
    expect(
      (inv.body.invoice.payments ?? []).filter((p: any) => p.reference_number === DEPOSIT_CREDIT_REF),
      'no synthetic DEPOSIT-CREDIT row',
    ).toHaveLength(0);
    expect(round2(Number(inv.body.invoice.amount_due)), 'amount_due == full total')
      .toBe(round2(Number(inv.body.invoice.total_amount)));

    // Send + collect the full balance as dispatcher; reconcile.
    const sentInv = await dispatcher.sendInvoice(invoiceId);
    expect(sentInv.res.status()).toBe(200);
    const due = Number(sentInv.body.invoice.amount_due);
    const pay = await dispatcher.recordPayment(invoiceId, { amount: due, method: 'CHECK' });
    expect(pay.res.status(), 'dispatcher collects full balance').toBe(201);
    expect(pay.body.invoice.status).toBe('PAID');
    await assertInvoiceReconciles(admin, invoiceId, 'X-11b settled (no credit)');
  });

  // ── X-11c ──────────────────────────────────────────────────────────────────
  test('X-11c: walkthrough performer eligibility — dispatcher-self rejected (400), eligible performer accepted (200)', async () => {
    // M2M model (assignableRoles.ts: ASSIGNABLE_ROLES = [ADMIN, SALES, TECHNICIAN]):
    // a DISPATCHER is NOT an eligible walkthrough performer, so scheduling himself is
    // rejected; an eligible TECHNICIAN performer is accepted.
    const { customerId, locationId } = await createMaCustomerWithLocation(admin);
    const lead = await dispatcher.createLead({
      customer_id: customerId,
      service_request: `x27-wt-elig-${admin.suffix}`,
      service_location_id: locationId,
    });
    expect(lead.res.status()).toBe(201);
    const leadId = lead.body.lead.id as string;
    expect((await dispatcher.contactLead(leadId)).res.status()).toBe(200);

    // Dispatcher schedules HIMSELF → 400 (ineligible role).
    const self = await dispatcher.scheduleWalkthrough(leadId, {
      walkthrough_scheduled_at: admin.futureDate(28),
      performer_ids: [dispatcherId],
    });
    expect(self.res.status(), 'dispatcher-self performer is ineligible').toBe(400);
    expect(String(self.body.error)).toBe('This user is not eligible to perform walkthroughs');

    // Dispatcher schedules an ELIGIBLE performer (the TECH) → 200.
    const wt = await dispatcher.scheduleWalkthrough(leadId, {
      walkthrough_scheduled_at: admin.futureDate(28),
      performer_ids: [techId],
    });
    expect(wt.res.status(), 'dispatcher schedules an eligible performer').toBe(200);
    expect(wt.body.lead.status).toBe('WALKTHROUGH_SCHEDULED');
    expect(wt.body.lead.walkthrough_performers.some((p: any) => p.user_id === techId)).toBe(true);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
test.describe('redesign-27 dispatcher day — X-12 edge grid (what must still break)', () => {
  // ── X-12a ──────────────────────────────────────────────────────────────────
  test('X-12a: granted-but-state-guarded — deposit re-pay 400, waive-after-paid 400, DRAFT-invoice pay 400, 2nd job 409, 2nd invoice 409, cancelled-job invoice 400, SENT-estimate job 400', async () => {
    test.setTimeout(120_000); // two full admin seed chains

    // Seed A: deposit estimate, deposit PAID by ADMIN ⇒ estimate WON + lead WON.
    const a = await leadToSentEstimateWithDeposit(admin, ['CHECK']);
    expect((await admin.markDepositReceived(a.estimateId)).res.status(), 'seed A: deposit paid').toBe(200);

    // (1) Record the deposit AGAIN as dispatcher → 400. Status guard is
    //     DRAFT/SENT/PENDING-only; WON gets the dedicated string
    //     (estimate.controller.ts:1299-1306).
    const rePay = await dispatcher.markDepositReceived(a.estimateId, { amount: 10, payment_method: 'CHECK' });
    expect(rePay.res.status(), 'deposit re-pay').toBe(400);
    expect(String(rePay.body.error)).toBe('Estimate is already approved/paid');

    // (2) Waive after the deposit was PAID → 400. Paying always approves the estimate
    //     first, so the ESTIMATE-status guard (SENT/PENDING-only, :2218-2221) fires
    //     BEFORE the no-active-deposit check (:2223-2227) — exact template string
    //     (lower-cased status, including the 'a won' grammar).
    const waive = await dispatcher.waiveDeposit(a.estimateId, 'waive');
    expect(waive.res.status(), 'waive after paid').toBe(400);
    expect(String(waive.body.error)).toBe('Cannot waive deposit on a won estimate');

    // Dispatcher converts seed A to a job + DRAFT invoice (both granted + state-legal).
    const job = await dispatcher.createJob({ estimate_id: a.estimateId });
    expect(job.res.status(), 'seed A job').toBe(201);
    const jobId = job.body.job.id as string;
    const inv = await dispatcher.createInvoice(jobId);
    expect(inv.res.status(), 'seed A invoice (DRAFT)').toBe(201);
    const invoiceId = inv.body.invoice.id as string;
    await assertInvoiceReconciles(admin, invoiceId, 'X-12a DRAFT invoice w/ deposit credit');

    // (3) Record a payment on the DRAFT invoice → 400 (status guard fires before the
    //     access check — invoice.controller.ts:930-932).
    const draftPay = await dispatcher.recordPayment(invoiceId, { amount: 10, method: 'CASH' });
    expect(draftPay.res.status(), 'pay DRAFT invoice').toBe(400);
    expect(String(draftPay.body.error)).toBe('Payments can only be recorded on SENT or PARTIAL invoices');

    // (4) Second job from the same estimate → idempotent find-or-create returns the EXISTING
    //     job (200), not 409 (Bug #23 — job.controller.ts:636-646; estimate_id is @unique).
    const secondJob = await dispatcher.createJob({ estimate_id: a.estimateId });
    expect(secondJob.res.status(), 'second job on estimate (idempotent)').toBe(200);
    expect(secondJob.body.job.id, 'returns the existing job').toBe(jobId);

    // (5) Second ACTIVE invoice on the job → 409 (the DRAFT is non-VOIDED ⇒ active;
    //     invoice.controller.ts:330-338 — string embeds the invoice number, so match
    //     the stable fragment only).
    const secondInv = await dispatcher.createInvoice(jobId);
    expect(secondInv.res.status(), 'second active invoice').toBe(409);
    expect(String(secondInv.body.error)).toContain('already has an invoice');

    // (6) Dispatcher cancels the (UNASSIGNED) job — allowed status, reason required
    //     (cancelJobSchema). The DRAFT invoice is NOT voided by the cascade
    //     (openToVoid is SENT/PARTIAL only, job.controller.ts:1086).
    const cancel = await dispatcher.cancelJob(jobId, 'X-12a cancelled for the invoice guard');
    expect(cancel.res.status(), 'cancel job').toBe(200);
    expect(cancel.body.job.status).toBe('CANCELLED');

    //     Invoice on the CANCELLED job → 400 — and the cancelled-job guard fires
    //     BEFORE the one-active 409 (invoice.controller.ts:324-326 vs :330), so the
    //     surviving DRAFT does not mask it.
    const cancelledInv = await dispatcher.createInvoice(jobId);
    expect(cancelledInv.res.status(), 'invoice on cancelled job').toBe(400);
    expect(String(cancelledInv.body.error)).toBe('Cannot invoice a cancelled job');

    // Seed B: a merely-SENT (no-deposit) estimate.
    // (7) Job from a SENT estimate → 400. The WON gate (job.controller.ts:463-466)
    //     fires here; the deposit-gate G2 string (:477) sits BEHIND it and is
    //     unreachable from this state (paying/waiving a deposit always approves first).
    const b = await leadToSentEstimate(admin);
    const sentJob = await dispatcher.createJob({ estimate_id: b.estimateId });
    expect(sentJob.res.status(), 'job from SENT estimate').toBe(400);
    expect(String(sentJob.body.error)).toBe('Estimate must be WON to create a job');
  });

  // ── X-12b ──────────────────────────────────────────────────────────────────
  test('X-12b: assignment + lead-state guards as dispatcher actor — ineligible targets 400, completed-job assign 400, unassign-unassigned 400, re-contact 400, delete-with-estimate 400', async () => {
    test.setTimeout(120_000); // one tech execution + one admin estimate seed

    const { customerId, locationId } = await createMaCustomerWithLocation(admin);

    // Dispatcher's own standalone job (create Job grant — the no-estimate branch has
    // no role restriction, job.controller.ts:383-431).
    const job = await dispatcher.createJob({ customer_id: customerId, service_location_id: locationId });
    expect(job.res.status(), 'dispatcher standalone job').toBe(201);
    const jobId = job.body.job.id as string;

    // Unassign an UNASSIGNED job → 400 (SCHEDULED-only, job.controller.ts:902-904).
    const unassign = await dispatcher.unassignJob(jobId);
    expect(unassign.res.status(), 'unassign unassigned').toBe(400);
    expect(String(unassign.body.error)).toBe('Only scheduled jobs can be unassigned');

    // Assign the job to a DISPATCHER → 400: only ASSIGNABLE_ROLES
    // ([ADMIN, SALES, TECHNICIAN] — assignableRoles.ts) are crew-eligible. SALES is now
    // crew-eligible (Decision #4), so DISPATCHER is the ineligible target here.
    const toIneligible = await dispatcher.assignJob(jobId, {
      assignee_ids: [dispatcherId],
      scheduled_start: admin.futureDate(150), scheduled_end: admin.futureDate(152),
      force: true,
    });
    expect(toIneligible.res.status(), 'assign job to DISPATCHER (ineligible)').toBe(400);
    expect(String(toIneligible.body.error)).toBe('This user is not eligible to be assigned as job crew');

    // Positive contrast on the same job: the TECH is eligible → 200 SCHEDULED.
    const toTech = await dispatcher.assignJob(jobId, {
      assignee_ids: [techId],
      scheduled_start: admin.futureDate(150), scheduled_end: admin.futureDate(152),
      force: true,
    });
    expect(toTech.res.status(), 'assign job to TECH').toBe(200);
    expect(toTech.body.job.status).toBe('SCHEDULED');

    // Tech executes; then assigning a COMPLETED job → 400 (status guard template,
    // job.controller.ts:731-734).
    expect((await tech.startJob(jobId)).res.status()).toBe(200);
    expect((await tech.completeJob(jobId, 'X-12b completion')).res.status()).toBe(200);
    const reassign = await dispatcher.assignJob(jobId, {
      assignee_ids: [techId],
      scheduled_start: admin.futureDate(160), scheduled_end: admin.futureDate(162),
      force: true,
    });
    expect(reassign.res.status(), 'assign completed job').toBe(400);
    expect(String(reassign.body.error)).toBe('Cannot assign a completed job');

    // Lead-side: dispatcher lead on the same customer.
    const lead = await dispatcher.createLead({
      customer_id: customerId,
      service_request: `x27-grid-${admin.suffix}`,
      service_location_id: locationId,
    });
    expect(lead.res.status()).toBe(201);
    const leadId = lead.body.lead.id as string;

    // Assign the lead to the TECH → 200: TECH IS lead-owner-eligible (Bug #11 —
    // OWNER_ELIGIBLE_ROLES = ASSIGNABLE_ROLES = [ADMIN, SALES, TECHNICIAN]; only DISPATCHER is
    // excluded, assignableRoles.ts:7). No status guard on lead-assign, so a NEW lead is fine.
    const leadToTech = await dispatcher.assignLead(leadId, techId);
    expect(leadToTech.res.status(), 'assign lead to TECH (eligible, Bug #11)').toBe(200);
    expect(leadToTech.body.lead.commission_owner.id).toBe(techId);

    // Positive contrast: SALES target → 200.
    const leadToSales = await dispatcher.assignLead(leadId, salesId);
    expect(leadToSales.res.status(), 'assign lead to SALES').toBe(200);
    expect(leadToSales.body.lead.commission_owner.id).toBe(salesId);

    // Contact once → 200; re-contact a CONTACTED lead → 400 (NEW-only,
    // lead.controller.ts:978-980).
    expect((await dispatcher.contactLead(leadId)).res.status(), 'first contact').toBe(200);
    const reContact = await dispatcher.contactLead(leadId);
    expect(reContact.res.status(), 're-contact').toBe(400);
    expect(String(reContact.body.error)).toBe('Can only mark NEW leads as contacted');

    // Give the lead an estimate (ADMIN creates it — the dispatcher CANNOT, no create
    // Estimate grant). D8/D9 (PR-B2) removed the walkthrough gate on create entirely,
    // so no gate-clearing setup is needed here.
    const est = await admin.createEstimate({
      lead_id: leadId,
      line_items: [{ description: 'X-12b estimate', quantity: 1, unit_price: 100, is_taxable: true }],
    });
    expect(est.res.status(), 'admin estimate on the lead').toBe(201);

    // Delete a lead that has an estimate → 400 (lead.controller.ts:856-861); the
    // dispatcher's delete-Lead grant passes the route guard, the data guard refuses.
    // (deleteLead returns {res,status} without a parsed body — parse it here once.)
    const del = await dispatcher.deleteLead(leadId);
    expect(del.status, 'delete lead with estimate').toBe(400);
    const delBody = await del.res.json().catch(() => ({}));
    expect(String(delBody.error)).toBe('Lead has estimates — cancel or mark lost instead');
    expect((await admin.getLead(leadId)).id, 'lead survives the blocked delete').toBe(leadId);
  });

  // ── X-12c ──────────────────────────────────────────────────────────────────
  test('X-12c: ungranted estimate actions → 403 route-guard; refund on a kind=DEPOSIT invoice → 403', async () => {
    test.setTimeout(120_000); // two admin seed chains

    // A SENT estimate: send/cancel/revise are all status-legal on it, so for every
    // probe below the GRANT is the only refusal. DISPATCHER holds read/record_payment/
    // waive_deposit on Estimate ONLY (defaultGrants.ts:73-75); update/delete/cancel/
    // revise/duplicate routes are each canDo-guarded (estimate.routes.ts:29-30,34-36)
    // → 403 'Insufficient permissions' (canGuard.ts:10-12) before any controller code.
    const ctx = await leadToSentEstimate(admin);

    const upd = await dispatcher.raw('patch', `/api/estimates/${ctx.estimateId}`, {
      scope_notes: 'dispatcher must not edit',
    });
    expect(upd.res.status(), 'estimate update').toBe(403);
    expect(String(upd.body.error)).toBe('Insufficient permissions');

    const del = await dispatcher.raw('delete', `/api/estimates/${ctx.estimateId}`);
    expect(del.res.status(), 'estimate delete').toBe(403);

    const cancel = await dispatcher.raw('post', `/api/estimates/${ctx.estimateId}/cancel`, {
      cancelled_reason: 'dispatcher must not cancel',
    });
    expect(cancel.res.status(), 'estimate cancel').toBe(403);

    const revise = await dispatcher.raw('post', `/api/estimates/${ctx.estimateId}/revise`, {});
    expect(revise.res.status(), 'estimate revise').toBe(403);

    const dup = await dispatcher.raw('post', `/api/estimates/${ctx.estimateId}/duplicate`, {});
    expect(dup.res.status(), 'estimate duplicate').toBe(403);

    // Nothing moved: still SENT with its public token intact (revise would null it).
    const after = await admin.getEstimate(ctx.estimateId);
    expect(after.status, 'estimate untouched by the five 403s').toBe('SENT');
    expect(after.public_token).toBeTruthy();

    // Refund on a kind=DEPOSIT invoice → 403. X-02b (redesign-22) probed refund on a
    // STANDARD invoice; this is the deposit-document complement. Route guard
    // canDo('refund','Invoice') (invoice.routes.ts:29) — no default role holds refund.
    // Seed a PAID deposit (refund would be money-legal) so the grant is provably the
    // only blocker.
    const dep = await leadToSentEstimateWithDeposit(admin, ['CHECK']);
    expect((await admin.markDepositReceived(dep.estimateId)).res.status(), 'seed deposit paid').toBe(200);
    const depInv = (await admin.getEstimate(dep.estimateId)).invoices?.[0];
    expect(depInv?.status).toBe('PAID');

    const refund = await dispatcher.refundInvoice(depInv.id, {
      amount: 10, reason: 'x27 probe', reason_category: 'CUSTOMER_REQUEST',
    });
    expect(refund.res.status(), 'dispatcher refund on DEPOSIT invoice').toBe(403);
    expect(String(refund.body.error)).toBe('Insufficient permissions');

    // Untouched and still reconciled.
    const depAfter = await admin.getInvoice(depInv.id);
    expect(depAfter.status).toBe('PAID');
    expect(Number(depAfter.total_refunded ?? 0)).toBe(0);
    await assertInvoiceReconciles(admin, depInv.id, 'X-12c deposit untouched');
  });

  // ── X-12d ──────────────────────────────────────────────────────────────────
  test('X-12d: job reopen 403 (no reopen grant) with admin positive contrast; invoice delete — DRAFT 204 as dispatcher, SENT 400', async () => {
    test.setTimeout(120_000); // tech execution chain + approved-estimate seed

    // ── reopen ──
    // Route: POST /:id/reopen behind canDo('reopen','Job') (job.routes.ts:34).
    // The DISPATCHER grant list (defaultGrants.ts:77-87) has NO `reopen` row ⇒ the
    // ROUTE guard 403s before the controller. Seed a genuinely reopen-legal job
    // (COMPLETED, zero invoices — reopen guards at job.controller.ts:1189-1199) so
    // the admin contrast proves the dispatcher refusal was purely the grant.
    const { customerId, locationId } = await createMaCustomerWithLocation(admin);
    const job = await dispatcher.createJob({ customer_id: customerId, service_location_id: locationId });
    expect(job.res.status()).toBe(201);
    const jobId = job.body.job.id as string;
    expect((await dispatcher.assignJob(jobId, {
      assignee_ids: [techId],
      scheduled_start: admin.futureDate(170), scheduled_end: admin.futureDate(172),
      force: true,
    })).res.status()).toBe(200);
    expect((await tech.startJob(jobId)).res.status()).toBe(200);
    expect((await tech.completeJob(jobId, 'X-12d completion')).res.status()).toBe(200);

    const reopen = await dispatcher.raw('post', `/api/jobs/${jobId}/reopen`, {});
    expect(reopen.res.status(), 'dispatcher reopen').toBe(403);
    expect(String(reopen.body.error)).toBe('Insufficient permissions');
    expect((await admin.getJob(jobId)).status, 'job untouched by the 403').toBe('COMPLETED');

    // Positive contrast: ADMIN (manage-all) reopens the same job → 200 IN_PROGRESS —
    // the state WAS legal; only the grant separated the two actors.
    const adminReopen = await admin.reopenJob(jobId);
    expect(adminReopen.res.status(), 'admin reopen contrast').toBe(200);
    expect(adminReopen.body.job.status).toBe('IN_PROGRESS');

    // ── invoice delete ──
    // DISPATCHER holds delete Invoice (defaultGrants.ts:91; route invoice.routes.ts:23)
    // and the controller is DRAFT-only → 204 (invoice.controller.ts:699-703 — no
    // canAccess check). Seed via a NO-deposit approved estimate: a deposit-credit
    // invoice would carry a synthetic Payment row and Payment.invoice is
    // onDelete:Restrict — the clean DRAFT here has zero payments.
    const ctx = await adminApprovedEstimate();
    const j2 = await dispatcher.createJob({ estimate_id: ctx.estimateId });
    expect(j2.res.status()).toBe(201);
    const job2Id = j2.body.job.id as string;
    const inv1 = await dispatcher.createInvoice(job2Id);
    expect(inv1.res.status(), 'DRAFT invoice').toBe(201);

    const delDraft = await dispatcher.deleteInvoice(inv1.body.invoice.id);
    expect(delDraft.status, 'dispatcher deletes DRAFT invoice').toBe(204);

    // The deleted row no longer blocks: a fresh invoice creates (the one-active 409
    // counts only existing non-VOIDED rows), is sent, and then delete → 400.
    const inv2 = await dispatcher.createInvoice(job2Id);
    expect(inv2.res.status(), 'recreate after delete').toBe(201);
    const inv2Id = inv2.body.invoice.id as string;
    expect((await dispatcher.sendInvoice(inv2Id)).res.status()).toBe(200);

    const delSent = await dispatcher.deleteInvoice(inv2Id);
    expect(delSent.status, 'delete SENT invoice').toBe(400);
    expect((await admin.getInvoice(inv2Id)).status, 'SENT invoice survives').toBe('SENT');
  });

  // ── X-12e ──────────────────────────────────────────────────────────────────
  test('X-12e: cascade-acquired powers — lead cancel voids the deposit invoice; job cancel voids a SENT invoice (+refund_suggested shape); mark-lost auto-cancels the walkthrough', async () => {
    test.setTimeout(150_000); // three admin seed chains (two with Auth-user creation)

    // (1) Lead cancel cascade. The dispatcher holds cancel Lead but NEITHER cancel
    //     Estimate NOR void Invoice — yet cancelLead cancels DRAFT/SENT/PENDING
    //     estimates via RAW prisma.estimate.updateMany (lead.controller.ts:1285-1296)
    //     and voids unpaid DRAFT/SENT deposit invoices via voidUnpaidDepositInvoices
    //     (:1298-1303 → :286-304), with NO ability check on either sub-step. This is
    //     BY DESIGN (documented, not moralized): the cascade keeps the document tree
    //     consistent under the one cancel grant.
    const a = await leadToSentEstimateWithDeposit(admin, ['CHECK']);
    const depInvA = (await admin.getEstimate(a.estimateId)).invoices?.[0];
    expect(depInvA?.status, 'seed: unpaid deposit invoice SENT').toBe('SENT');

    const cancelLead = await dispatcher.cancelLead(a.leadId, 'X-12e cascade probe');
    expect(cancelLead.res.status(), 'dispatcher cancels lead').toBe(200);
    expect(cancelLead.body.lead.status).toBe('CANCELLED');

    expect((await admin.getEstimate(a.estimateId)).status, 'estimate ARCHIVED by cascade').toBe('ARCHIVED');
    const depInvAAfter = await admin.getInvoice(depInvA.id);
    expect(depInvAAfter.status, 'deposit invoice VOIDED by cascade (no void grant held)').toBe('VOIDED');
    // No reconcile on the voided row — it never carried money (DRAFT/SENT + zero
    // payments is exactly what voidUnpaidDepositInvoices targets).

    // (2) Job cancel cascade + response shape. Dispatcher cancels a SCHEDULED job
    //     carrying a SENT (unpaid) invoice: the cascade voids it RAW and forces
    //     amount_due to 0 (job.controller.ts:1104-1114) — again no void grant
    //     involved. Response shape (:1160-1165): collected_total counts only REAL
    //     non-voided payments (synthetic DEPOSIT-CREDIT rows excluded, :1093-1101) —
    //     nothing was collected here ⇒ collected_total 0 and refund_suggested false.
    const b = await adminApprovedEstimate();
    const jobB = await dispatcher.createJob({ estimate_id: b.estimateId });
    expect(jobB.res.status()).toBe(201);
    const jobBId = jobB.body.job.id as string;
    expect((await dispatcher.assignJob(jobBId, {
      assignee_ids: [techId],
      scheduled_start: admin.futureDate(180), scheduled_end: admin.futureDate(182),
      force: true,
    })).res.status(), 'job SCHEDULED').toBe(200);
    const invB = await dispatcher.createInvoice(jobBId);
    expect(invB.res.status()).toBe(201);
    const invBId = invB.body.invoice.id as string;
    expect((await dispatcher.sendInvoice(invBId)).res.status(), 'invoice SENT').toBe(200);

    const cancelJob = await dispatcher.cancelJob(jobBId, 'X-12e job-cancel cascade probe');
    expect(cancelJob.res.status(), 'dispatcher cancels scheduled job').toBe(200);
    expect(cancelJob.body.job.status).toBe('CANCELLED');
    expect(cancelJob.body.voided_invoice_ids, 'cascade reports the voided invoice').toContain(invBId);
    expect(cancelJob.body.refund_suggested, 'no real money ⇒ no refund suggestion').toBe(false);
    expect(Number(cancelJob.body.collected_total)).toBe(0);

    const invBAfter = await admin.getInvoice(invBId);
    expect(invBAfter.status, 'SENT invoice VOIDED by the job-cancel cascade').toBe('VOIDED');
    expect(String(invBAfter.voided_reason)).toBe('Job cancelled'); // :1111
    expect(Number(invBAfter.amount_due), 'amount_due forced to 0 by the cascade').toBe(0);
    // No assertInvoiceReconciles here: the cascade zeroes amount_due by fiat (:1113),
    // which deliberately breaks the live-invoice formula — VOIDED rows are asserted
    // directly instead.

    // (3) mark-lost auto-cancels a scheduled walkthrough (lead.controller.ts:1443-1449,
    //     reason fixed to 'Lead marked as lost'). Performer = the seeded TECH (no new
    //     Auth user); admin schedules to keep the dispatcher's mark_lost the act under
    //     test.
    const c = await createContactedLead(admin);
    expect((await admin.scheduleWalkthrough(c.leadId, {
      walkthrough_scheduled_at: admin.futureDate(34),
      performer_ids: [techId],
    })).res.status(), 'seed: walkthrough scheduled').toBe(200);

    const lost = await dispatcher.markLeadLost(c.leadId, 'X-12e mark-lost cascade probe');
    expect(lost.res.status(), 'dispatcher mark-lost').toBe(200);
    expect(lost.body.lead.status).toBe('LOST');
    expect(lost.body.lead.walkthrough_scheduled_at, 'walkthrough unscheduled').toBeNull();
    expect(lost.body.lead.walkthrough_cancelled_at, 'walkthrough cancel stamped').toBeTruthy();
    expect(String(lost.body.lead.walkthrough_cancelled_reason)).toBe('Lead marked as lost');
  });
});

// ═════════════════════════════════════════════════════════════════════════════
test.describe('redesign-27 dispatcher day — DLV-21 extensions (dispatcher execution honored, #188)', () => {
  // en_route/arrive/complete share the SAME controller pattern as start — status guard
  // first, then the role check. Since Option A (#188) the DISPATCHER role is folded into
  // isOrgManager (job.controller.ts), so each status-legal transition now succeeds (200)
  // for a dispatcher even on a job assigned to someone else.

  /** Standalone admin job assigned to the seeded TECH → SCHEDULED. */
  async function scheduledTechJob(startHours: number) {
    const { jobId } = await adminStandaloneJob();
    const assigned = await admin.assignJob(jobId, {
      assignee_ids: [techId],
      scheduled_start: admin.futureDate(startHours),
      scheduled_end: admin.futureDate(startHours + 2),
      force: true,
    });
    expect(assigned.res.status(), 'seed assign tech').toBe(200);
    expect(assigned.body.job.status).toBe('SCHEDULED');
    return jobId;
  }

  test('DLV-21b: dispatcher en_route on a tech-assigned SCHEDULED job → 200 EN_ROUTE (#188)', async () => {
    // en_route requires SCHEDULED (status-legal here); Option A (#188) honors the dispatcher → 200.
    const jobId = await scheduledTechJob(190);

    const enRoute = await dispatcher.raw('post', `/api/jobs/${jobId}/en-route`);
    expect(enRoute.res.status(), 'dispatcher /en-route on tech job').toBe(200);
    expect(enRoute.body.job.status).toBe('EN_ROUTE');

    expect((await admin.getJob(jobId)).status, 'dispatcher advanced job to EN_ROUTE').toBe('EN_ROUTE');
  });

  test('DLV-21c: dispatcher arrive on a tech EN_ROUTE job → 200 ON_SITE (#188)', async () => {
    // arrive requires EN_ROUTE — the TECH (own job) drives it there first; Option A (#188) then honors the dispatcher → 200.
    const jobId = await scheduledTechJob(200);
    const techEnRoute = await tech.raw('post', `/api/jobs/${jobId}/en-route`);
    expect(techEnRoute.res.status(), 'tech drives own job EN_ROUTE').toBe(200);

    const arrive = await dispatcher.raw('post', `/api/jobs/${jobId}/arrive`);
    expect(arrive.res.status(), 'dispatcher /arrive on tech job').toBe(200);
    expect(arrive.body.job.status).toBe('ON_SITE');

    expect((await admin.getJob(jobId)).status, 'dispatcher advanced job to ON_SITE').toBe('ON_SITE');
  });

  test('DLV-21d: dispatcher complete on a tech IN_PROGRESS job → 200 COMPLETED (#188)', async () => {
    // complete requires a completable status — the TECH drives en-route → arrive → start; Option A (#188) then honors the dispatcher → 200.
    const jobId = await scheduledTechJob(210);
    expect((await tech.raw('post', `/api/jobs/${jobId}/en-route`)).res.status()).toBe(200);
    expect((await tech.raw('post', `/api/jobs/${jobId}/arrive`)).res.status()).toBe(200);
    expect((await tech.startJob(jobId)).res.status(), 'tech starts own job').toBe(200);

    const complete = await dispatcher.completeJob(jobId, 'DLV-21d dispatcher completion probe');
    expect(complete.res.status(), 'dispatcher /complete on tech job').toBe(200);
    expect(complete.body.job.status).toBe('COMPLETED');

    expect((await admin.getJob(jobId)).status, 'dispatcher completed the job').toBe('COMPLETED');
  });
});
