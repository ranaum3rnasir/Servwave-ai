import { test, expect } from '@playwright/test';
import { ApiClient } from '../../helpers/api-client';
import {
  createMaCustomerWithLocation,
  leadToSentEstimate,
  fullStandardFlowToInvoicePaid,
} from '../../helpers/workflow-builders';
import { assertInvoiceReconciles } from '../../helpers/reconcile';

/**
 * redesign-22 — RBAC role grid (catalog X-02) + SALES scoping (INT-30) +
 * TECHNICIAN scoping (DLV-20) + dispatcher-execution probe (DLV-21).
 *
 * WRITTEN 2026-06-10, NOT YET EXECUTED — every expectation below is a STATIC
 * PREDICTION derived from controller/grant code, not from a baseline run.
 *
 * The suite ran 100% as the provisioned org ADMIN until now; this file is the first
 * systematic role-based spec. ONE shared org, serial (workers:1, fullyParallel:false);
 * data accumulates — all list assertions are presence/absence of our own unique-suffix
 * ids, never absolute counts.
 *
 * Per-role auth mechanism: `ApiClient.init(creds?)` performs an EAGER login
 * (POST /api/auth/login) — pass `{email, password}` to act as a non-admin user.
 * Role users are created by the admin via POST /api/users (user.controller.ts create:
 * Supabase Auth admin.createUser with `email_confirm: true`), so admin-created
 * SALES/TECHNICIAN/DISPATCHER users can log in immediately — no email confirmation,
 * no blocker. The builders' createTech/createSalesUser return only the user id (not
 * creds), so this spec seeds its role users directly to keep the email+password.
 *
 * Grant source of truth (backend/src/lib/permissions/defaultGrants.ts; ADMIN =
 * manage-all via defineAbility.ts; route guard canGuard.ts → 403 'Insufficient
 * permissions'):
 *  - SALES: no create Customer / Job / Invoice; create+send Estimate (controller
 *    restricts to OWN lead); Lead grants conditioned OWN_LEAD; be_assigned Lead ✓.
 *  - DISPATCHER: no create/send Estimate; CAN create Customer/Job/Invoice +
 *    record_payment; NO refund/credit/void_payment/void Invoice grants (admin-only
 *    money levers); has start/complete Job route grants BUT the controller requires
 *    manage-all-OR-assigned-tech (job.controller.ts start/complete) → 403 (DLV-21);
 *    no be_assigned Job → can never become the assigned tech either.
 *  - TECHNICIAN: create Job (controller 403s the estimate_id branch,
 *    job.controller.ts:433-437 — fires BEFORE any estimate-state validation);
 *    read/update/start/complete Job conditioned OWN_JOB (type-level canDo passes,
 *    instance enforcement in controllers); create Invoice + record_payment Invoice
 *    conditioned OWN_INVOICE_VIA_JOB (canAccessInvoice); be_assigned Job ✓,
 *    no be_assigned Lead.
 *
 * Controller facts the assertions lean on (file:line refs on this tree):
 *  - lead.controller.ts:422-424 SALES list hard-filter `where.assigned_to = self`;
 *    :542 SALES auto-assigns self on create; :716/:736 instance CASL read/update →
 *    403 (same-org other-owner lead → 403, NOT 404; 404 is cross-org/tenantWhere);
 *    :743-745 SALES status key silently stripped on PATCH; :918-919 lead-assign
 *    eligibility → 400 'This user is not eligible to be assigned as a lead owner'.
 *  - estimate.controller.ts:646-675 create guard ORDER: terminal 400 → SALES-not-owner
 *    403 (D8/D9, PR-B2: create never gates on walkthrough state at all - that guard
 *    was removed entirely, so ownership is the only remaining blocker to probe).
 *  - job.controller.ts:256-265 canAccessJob (ADMIN/DISPATCHER true, TECH own,
 *    SALES via estimate.lead); :285-291 TECH list hard-filter; :771-772 job-assign
 *    eligibility → 400 'This user is not eligible to be assigned as job technician';
 *    start (:991ish)/complete: STATUS 400 fires BEFORE the manage-all-or-assigned
 *    403 — so 403 probes use status-legal jobs (start on SCHEDULED, complete on
 *    IN_PROGRESS).
 *  - invoice.controller.ts:340-345 create: TECH-not-assigned 403 / SALES hard-403
 *    (route guard already 403s SALES before this backstop); recordPayment: 404 →
 *    status 400 (SENT/PARTIAL only) → canAccessInvoice 403 'Not authorized' → 201.
 *  - invoice.routes.ts: refund/credit/void-payment/void each behind canDo of an
 *    action NO default role holds → admin-only; dispatcher 403s at the route guard.
 */

const PASSWORD = 'Test123!@#'; // same as the workflow-builders role users

let admin: ApiClient;
let sales1: ApiClient;
let sales2: ApiClient;
let tech1: ApiClient;
let tech2: ApiClient;
let dispatcher: ApiClient;
let sales1Id: string;
let sales2Id: string;
let tech1Id: string;
let tech2Id: string;
let dispatcherId: string;

/** Admin-create a role user (Supabase Auth email_confirm:true → instantly loggable),
 *  then open a SEPARATE ApiClient session as that user. */
async function seedRoleUser(role: 'SALES' | 'TECHNICIAN' | 'DISPATCHER', tag: string) {
  const email = `rbac-${tag}-${admin.suffix}@e2e-qa.invalid`;
  const { res, body } = await admin.createUser({
    email, password: PASSWORD, first_name: 'Rbac', last_name: tag, role,
  });
  expect(res.status(), `seed ${role} user (${tag})`).toBe(201);
  const client = await new ApiClient().init({ email, password: PASSWORD });
  expect(client.authToken, `login as ${tag} (${role})`).toBeTruthy();
  return { id: body.user.id as string, client };
}

test.beforeAll(async () => {
  admin = await new ApiClient().init(); // provisioned throwaway-org admin

  ({ id: sales1Id, client: sales1 } = await seedRoleUser('SALES', 'sales1'));
  ({ id: sales2Id, client: sales2 } = await seedRoleUser('SALES', 'sales2'));
  ({ id: tech1Id, client: tech1 } = await seedRoleUser('TECHNICIAN', 'tech1'));
  ({ id: tech2Id, client: tech2 } = await seedRoleUser('TECHNICIAN', 'tech2'));
  ({ id: dispatcherId, client: dispatcher } = await seedRoleUser('DISPATCHER', 'dispatcher'));
});

test.afterAll(async () => {
  for (const c of [sales1, sales2, tech1, tech2, dispatcher, admin]) {
    try { await c?.dispose(); } catch { /* partial beforeAll failure — nothing to dispose */ }
  }
});

// ── shared seed helpers (all seeding is done AS ADMIN) ───────────────────────

/** Standalone (no-estimate) job on a fresh admin-owned customer. UNASSIGNED. */
async function adminStandaloneJob() {
  const { customerId, locationId } = await createMaCustomerWithLocation(admin);
  const { res, body } = await admin.createJob({
    customer_id: customerId, service_location_id: locationId,
  });
  expect(res.status(), 'seed standalone job').toBe(201);
  return { customerId, locationId, jobId: body.job.id as string };
}

/** Approved (no-deposit) estimate: leadToSentEstimate + public approval ⇒ WON,
 *  no kind=DEPOSIT invoice, G2 has nothing to gate. */
async function adminApprovedEstimate() {
  const ctx = await leadToSentEstimate(admin); // deposit: false by default
  const approved = await admin.approveEstimatePublic(ctx.estimateId, ctx.publicToken, {
    signature_data: admin.testSignature,
  });
  expect(approved.res.status(), 'seed public approval').toBe(200);
  expect((await admin.getEstimate(ctx.estimateId)).status).toBe('WON');
  return ctx;
}

/** Approved estimate → job assigned to `techUserId` → STANDARD invoice SENT.
 *  Invoice creation needs estimate line items + non-CANCELLED job (completion NOT
 *  required), so the chain stops at SCHEDULED. `force:true` dodges 409 schedule
 *  conflicts as the same tech accumulates jobs across this serial file. */
async function adminSentInvoiceOnTechJob(techUserId: string, startHours: number) {
  const ctx = await adminApprovedEstimate();
  const { res: jobRes, body: jobBody } = await admin.createJob({ estimate_id: ctx.estimateId });
  expect(jobRes.status(), 'seed job from estimate').toBe(201);
  const jobId = jobBody.job.id as string;
  const assigned = await admin.assignJob(jobId, {
    assignee_ids: [techUserId],
    scheduled_start: admin.futureDate(startHours),
    scheduled_end: admin.futureDate(startHours + 2),
    force: true,
  });
  expect(assigned.res.status(), 'seed assign tech').toBe(200);
  const { res: invRes, body: invBody } = await admin.createInvoice(jobId);
  expect(invRes.status(), 'seed invoice create').toBe(201);
  const invoiceId = invBody.invoice.id as string;
  const { res: sendRes, body: sendBody } = await admin.sendInvoice(invoiceId);
  expect(sendRes.status(), 'seed invoice send').toBe(200);
  return { ...ctx, jobId, invoiceId, amountDue: Number(sendBody.invoice.amount_due) };
}

// ═════════════════════════════════════════════════════════════════════════════
test.describe('redesign-22 RBAC — SALES (INT-30 scoping + X-02a grid)', () => {
  // ── INT-30a ────────────────────────────────────────────────────────────────
  test('INT-30a: SALES auto-assigns self on create; list hard-filtered to own; cross-owner read/update/contact 403', async () => {
    // SALES-1 creates a lead on an admin-owned customer (SALES cannot create
    // customers — X-02a — so the customer/location seed is admin's).
    const a = await createMaCustomerWithLocation(admin);
    const own = await sales1.createLead({
      customer_id: a.customerId,
      service_request: `rbac-own-${admin.suffix}`,
      service_location_id: a.locationId,
    });
    expect(own.res.status()).toBe(201);
    const ownLeadId = own.body.lead.id as string;
    // Auto-assign: lead.controller.ts:542 — SALES creator becomes commission_owner.
    expect(own.body.lead.commission_owner.id).toBe(sales1Id);

    // Admin creates a second lead and assigns it to SALES-2 (admin-created leads
    // start unassigned; ownership lands via POST /:id/assign).
    const b = await createMaCustomerWithLocation(admin);
    const other = await admin.createLead({
      customer_id: b.customerId,
      service_request: `rbac-other-${admin.suffix}`,
      service_location_id: b.locationId,
    });
    expect(other.res.status()).toBe(201);
    const otherLeadId = other.body.lead.id as string;
    const assignRes = await admin.assignLead(otherLeadId, sales2Id);
    expect(assignRes.res.status()).toBe(200);
    expect(assignRes.body.lead.commission_owner.id).toBe(sales2Id);

    // SALES-1's list: hard server-side filter (assigned_to = self) — own lead
    // present, SALES-2's absent. Presence-by-id, never counts; both leads are NEW
    // so the open-pipeline default list shows them.
    const s1List = await sales1.listLeads();
    const s1Ids = (s1List.body.leads as any[]).map((l) => l.id);
    expect(s1Ids).toContain(ownLeadId);
    expect(s1Ids).not.toContain(otherLeadId);
    // Stronger invariant: EVERY row in a SALES list is their own.
    for (const l of s1List.body.leads as any[]) {
      expect(l.commission_owner?.id, `SALES-1 list leaked lead ${l.id}`).toBe(sales1Id);
    }
    // Contrast: SALES-2 sees their lead.
    const s2List = await sales2.listLeads();
    expect((s2List.body.leads as any[]).map((l) => l.id)).toContain(otherLeadId);

    // SALES-1 GET on SALES-2's lead → 403 (same-org row found, instance CASL
    // read fails — lead.controller.ts:716. 404 would mean cross-org).
    const read = await sales1.raw('get', `/api/leads/${otherLeadId}`);
    expect(read.res.status()).toBe(403);

    // SALES-1 update on SALES-2's lead → 403 (instance CASL, :736).
    const upd = await sales1.updateLead(otherLeadId, { notes: `rbac-upd-${admin.suffix}` });
    expect(upd.res.status()).toBe(403);

    // SALES-1 contact on SALES-2's lead → 403. The lead is NEW (status-legal for
    // contact), so the only possible refusal is the OWN_LEAD ability check.
    const contact = await sales1.contactLead(otherLeadId);
    expect(contact.res.status()).toBe(403);
  });

  // ── INT-30b ────────────────────────────────────────────────────────────────
  test('INT-30b: SALES estimate-create — own lead 201, other-owner lead 403', async () => {
    // OWN lead: estimate creates straight from NEW — D8/D9 (PR-B2) removed the
    // walkthrough gate on create entirely, so no gate-clearing setup is needed here.
    const a = await createMaCustomerWithLocation(admin);
    const own = await sales1.createLead({
      customer_id: a.customerId,
      service_request: `rbac-est-own-${admin.suffix}`,
      service_location_id: a.locationId,
    });
    expect(own.res.status()).toBe(201);
    const ownLeadId = own.body.lead.id as string;

    const ownEst = await sales1.createEstimate({
      lead_id: ownLeadId,
      line_items: [{ description: 'RBAC own-lead work', quantity: 1, unit_price: 400, is_taxable: true }],
    });
    expect(ownEst.res.status(), 'SALES creates estimate on OWN lead').toBe(201);

    // OTHER-owner lead: admin seeds + assigns to SALES-2 — the create-guard order is
    // terminal-400 → SALES-owner-403 (estimate.controller.ts:660-675), so ownership
    // alone determines the result probed below.
    const b = await createMaCustomerWithLocation(admin);
    const other = await admin.createLead({
      customer_id: b.customerId,
      service_request: `rbac-est-other-${admin.suffix}`,
      service_location_id: b.locationId,
    });
    expect(other.res.status()).toBe(201);
    const otherLeadId = other.body.lead.id as string;
    expect((await admin.assignLead(otherLeadId, sales2Id)).res.status()).toBe(200);

    const crossEst = await sales1.createEstimate({
      lead_id: otherLeadId,
      line_items: [{ description: 'RBAC cross-lead work', quantity: 1, unit_price: 400, is_taxable: true }],
    });
    expect(crossEst.res.status(), 'SALES-1 on SALES-2 lead').toBe(403);
    expect(String(crossEst.body.error)).toBe('Insufficient permissions');

    // Ownership (not lead state) was the blocker: the owner CAN create on it.
    const ownerEst = await sales2.createEstimate({
      lead_id: otherLeadId,
      line_items: [{ description: 'RBAC owner work', quantity: 1, unit_price: 400, is_taxable: true }],
    });
    expect(ownerEst.res.status(), 'owner (SALES-2) on the same lead').toBe(201);
  });

  // ── X-02a ──────────────────────────────────────────────────────────────────
  test('X-02a: SALES grid — customer create 403, job create 403, invoice create 403', async () => {
    // POST /api/customers → 403 at the route guard (SALES has read/update/export
    // Customer but NO create grant). kind/segment included so that if the guard ever
    // regressed, the request wouldn't trip the unrelated NOT-NULL 500.
    const cust = await sales1.raw('post', '/api/customers', {
      kind: 'PERSON', segment: 'RESIDENTIAL',
      first_name: 'Nope', last_name: 'Sales',
      email: `rbac-snc-${admin.suffix}@e2e-qa.invalid`, phone: '5550001111',
    });
    expect(cust.res.status()).toBe(403);
    expect(String(cust.body.error)).toBe('Insufficient permissions'); // canGuard string

    // POST /api/jobs → 403 (no create Job grant; guard fires before the body is
    // looked at — a real admin-owned customer/location is sent anyway for honesty).
    const { customerId, locationId, jobId } = await adminStandaloneJob();
    const job = await sales1.createJob({ customer_id: customerId, service_location_id: locationId });
    expect(job.res.status()).toBe(403);

    // POST /api/invoices → 403. Route guard (no create Invoice grant) fires first;
    // invoice.controller.ts:343 keeps a SALES hard-403 backstop behind it.
    const inv = await sales1.createInvoice(jobId);
    expect(inv.res.status()).toBe(403);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
test.describe('redesign-22 RBAC — DISPATCHER (X-02b grid + DLV-21 probe)', () => {
  // ── X-02b ──────────────────────────────────────────────────────────────────
  test('X-02b: DISPATCHER grid — no estimate create/send; CAN create customer + job-from-estimate; money levers 403', async () => {
    // Several full admin seed-chains (approved estimate + paid-invoice flow) —
    // finite serial work, raise the budget like JOB-02/JOB-10 do.
    test.setTimeout(120_000);

    // Seed a SENT (no-deposit) estimate as admin. Send on a SENT estimate is
    // status-legal (resend), so the ONLY refusal left for the dispatcher is the grant.
    const ctx = await leadToSentEstimate(admin);

    // POST /api/estimates → 403 (no create Estimate grant — map §2 G1 "not DISPATCHER").
    const est = await dispatcher.createEstimate({
      lead_id: ctx.leadId,
      line_items: [{ description: 'RBAC dispatcher est', quantity: 1, unit_price: 100 }],
    });
    expect(est.res.status()).toBe(403);

    // POST /api/estimates/:id/send → 403 (no send Estimate grant).
    const send = await dispatcher.sendEstimate(ctx.estimateId, { deposit_required: false });
    expect(send.res.status()).toBe(403);

    // CAN create a customer (create Customer grant) → 201.
    const cust = await dispatcher.raw('post', '/api/customers', {
      kind: 'PERSON', segment: 'RESIDENTIAL',
      first_name: 'Dispatch', last_name: 'Creates',
      email: `rbac-dc-${admin.suffix}@e2e-qa.invalid`, phone: '5550002222',
    });
    expect(cust.res.status(), 'dispatcher creates customer').toBe(201);
    expect(cust.body.customer?.id).toBeTruthy();

    // CAN create a job from an approved estimate → 201 (create Job grant; the
    // TECH-only estimate-path 403 in job.controller does not apply to DISPATCHER).
    const approved = await admin.approveEstimatePublic(ctx.estimateId, ctx.publicToken, {
      signature_data: admin.testSignature,
    });
    expect(approved.res.status(), 'admin approves seed estimate').toBe(200);
    const job = await dispatcher.createJob({ estimate_id: ctx.estimateId });
    expect(job.res.status(), 'dispatcher creates job from approved estimate').toBe(201);
    expect(job.body.job.status).toBe('UNASSIGNED');

    // Money levers are ADMIN-only (no role holds refund/credit/void_payment/void
    // Invoice grants) → 403 at the route guard for all four. Seed a PAID invoice
    // as admin (CASH payment → void-payment would otherwise be manual-method-legal,
    // so the grant is provably the only blocker).
    const paid = await fullStandardFlowToInvoicePaid(admin);
    await assertInvoiceReconciles(admin, paid.invoiceId, 'X-02b seed (money moved)');

    const refund = await dispatcher.refundInvoice(paid.invoiceId, {
      amount: 50, reason: 'rbac probe', reason_category: 'CUSTOMER_REQUEST',
    });
    expect(refund.res.status(), 'dispatcher refund').toBe(403);
    expect(String(refund.body.error)).toBe('Insufficient permissions');

    const credit = await dispatcher.creditInvoice(paid.invoiceId, { amount: 25, reason: 'rbac probe' });
    expect(credit.res.status(), 'dispatcher credit').toBe(403);

    const voidPay = await dispatcher.voidPayment(paid.invoiceId, {
      payment_id: paid.payment.id, void_category: 'ERROR', reason: 'rbac probe',
    });
    expect(voidPay.res.status(), 'dispatcher void-payment').toBe(403);

    const voidInv = await dispatcher.voidInvoice(paid.invoiceId, 'rbac probe');
    expect(voidInv.res.status(), 'dispatcher void invoice').toBe(403);

    // Nothing moved: invoice still PAID and reconciled.
    const after = await admin.getInvoice(paid.invoiceId);
    expect(after.status).toBe('PAID');
    expect(Number(after.total_refunded ?? 0)).toBe(0);
    await assertInvoiceReconciles(admin, paid.invoiceId, 'X-02b post-403s');
  });

  // ── DLV-21 ─────────────────────────────────────────────────────────────────
  test('DLV-21: dispatcher start on a tech-assigned SCHEDULED job → 200 IN_PROGRESS (Option A, #188)', async () => {
    // Admin seeds a SCHEDULED job assigned to TECH-1. start from SCHEDULED is
    // status-legal, so the controller's manage-all-OR-assigned-tech check is the
    // only gate left. DISPATCHER passes the ROUTE guard (it holds a start Job
    // grant) but is neither manage-all nor the assigned tech — and can never BE
    // the assigned tech (no be_assigned Job grant, see the eligibility row below).
    //
    // Option A (#188): DISPATCHER is treated as org-manager (job.controller.ts isOrgManager,
    // start guard) so start advances SCHEDULED → IN_PROGRESS.
    const { jobId } = await adminStandaloneJob();
    const assigned = await admin.assignJob(jobId, {
      assignee_ids: [tech1Id],
      scheduled_start: admin.futureDate(120),
      scheduled_end: admin.futureDate(122),
      force: true,
    });
    expect(assigned.res.status()).toBe(200);
    expect(assigned.body.job.status).toBe('SCHEDULED');

    const start = await dispatcher.startJob(jobId);
    expect(start.res.status(), 'dispatcher /start on tech-assigned job').toBe(200);
    expect(start.body.job.status).toBe('IN_PROGRESS');

    // The dispatcher's start persisted.
    expect((await admin.getJob(jobId)).status).toBe('IN_PROGRESS');
  });
});

// ═════════════════════════════════════════════════════════════════════════════
test.describe('redesign-22 RBAC — TECHNICIAN (X-02c grid + DLV-20 scoping)', () => {
  // ── X-02c (create surface) ─────────────────────────────────────────────────
  test('X-02c: TECHNICIAN create surface — standalone job 201, estimate-path 403', async () => {
    test.setTimeout(120_000); // one full approved-estimate seed chain

    // Standalone job ({customer_id, service_location_id}) — the direct branch has
    // NO technician restriction → 201.
    const { customerId, locationId } = await createMaCustomerWithLocation(admin);
    const direct = await tech1.createJob({ customer_id: customerId, service_location_id: locationId });
    expect(direct.res.status(), 'tech standalone job').toBe(201);
    expect(direct.body.job.status).toBe('UNASSIGNED');

    // estimate_id branch → 403 (job.controller.ts:433-437; the role check fires
    // BEFORE any estimate-state validation). Seed a genuinely job-able WON
    // estimate so the follow-up proves the 403 was the role, not the estimate.
    const ctx = await adminApprovedEstimate();
    const fromEst = await tech1.createJob({ estimate_id: ctx.estimateId });
    expect(fromEst.res.status(), 'tech job-from-estimate').toBe(403);
    expect(String(fromEst.body.error)).toBe('Insufficient permissions');

    // Sanity contrast: the SAME estimate converts fine for a permitted role.
    const adminJob = await admin.createJob({ estimate_id: ctx.estimateId });
    expect(adminJob.res.status(), 'same estimate as admin').toBe(201);
  });

  // ── X-02c + DLV-20 (visibility) ────────────────────────────────────────────
  test('X-02c/DLV-20: TECHNICIAN visibility — job list hard-filtered to assigned; cross-tech GET 403', async () => {
    // Admin seeds two standalone jobs on two distinct customers: A → TECH-1, B → TECH-2.
    const a = await adminStandaloneJob();
    const b = await adminStandaloneJob();
    expect((await admin.assignJob(a.jobId, {
      assignee_ids: [tech1Id],
      scheduled_start: admin.futureDate(24), scheduled_end: admin.futureDate(26),
      force: true,
    })).res.status()).toBe(200);
    expect((await admin.assignJob(b.jobId, {
      assignee_ids: [tech2Id],
      scheduled_start: admin.futureDate(24), scheduled_end: admin.futureDate(26),
      force: true,
    })).res.status()).toBe(200);

    // TECH-1's list (server hard-filter assigned_to=self, job.controller.ts:285-287):
    // contains A, never B — presence by id (TECH-1's scoped list only holds jobs this
    // spec assigned to them, so the default page suffices).
    const t1List = await tech1.listJobs();
    const t1Ids = (t1List.body.jobs as any[]).map((j) => j.id);
    expect(t1Ids).toContain(a.jobId);
    expect(t1Ids).not.toContain(b.jobId);
    for (const j of t1List.body.jobs as any[]) {
      expect(
        (j.assignees as any[])?.some((a: any) => a.user.id === tech1Id),
        `TECH-1 list leaked job ${j.id}`,
      ).toBe(true);
    }
    // Contrast: TECH-2 sees B.
    const t2List = await tech2.listJobs();
    expect((t2List.body.jobs as any[]).map((j) => j.id)).toContain(b.jobId);

    // Direct GET on the other tech's job → canAccessJob 403 (job.controller.ts:591).
    const cross = await tech1.raw('get', `/api/jobs/${b.jobId}`);
    expect(cross.res.status()).toBe(403);
    // (GET /api/jobs/my-today also filters assigned_to=self but is date-windowed —
    //  asserting it would be midnight-flaky, so the hard-filtered list carries DLV-20.)
  });

  // ── X-02c + DLV-20 (execution) ─────────────────────────────────────────────
  test('X-02c/DLV-20: TECHNICIAN execution — own job start/complete 200; other tech\'s job 403', async () => {
    // Fresh pair: jobA → TECH-1, jobB → TECH-2 (both SCHEDULED; staggered window
    // + force to dodge accumulated-schedule 409s in this serial file).
    const a = await adminStandaloneJob();
    const b = await adminStandaloneJob();
    expect((await admin.assignJob(a.jobId, {
      assignee_ids: [tech1Id],
      scheduled_start: admin.futureDate(48), scheduled_end: admin.futureDate(50),
      force: true,
    })).res.status()).toBe(200);
    expect((await admin.assignJob(b.jobId, {
      assignee_ids: [tech2Id],
      scheduled_start: admin.futureDate(48), scheduled_end: admin.futureDate(50),
      force: true,
    })).res.status()).toBe(200);

    // start on TECH-2's SCHEDULED job: status-legal (start allows SCHEDULED/ON_SITE),
    // so only the assigned-tech check can fire → 403.
    const crossStart = await tech1.startJob(b.jobId);
    expect(crossStart.res.status(), 'TECH-1 start on TECH-2 job').toBe(403);

    // complete needs IN_PROGRESS to get past the status guard (it runs BEFORE the
    // role check) — admin (manage-all) starts B, then TECH-1's complete → clean 403.
    expect((await admin.startJob(b.jobId)).res.status()).toBe(200);
    const crossComplete = await tech1.completeJob(b.jobId, 'rbac cross-complete probe');
    expect(crossComplete.res.status(), 'TECH-1 complete on TECH-2 job').toBe(403);
    expect((await admin.getJob(b.jobId)).status).toBe('IN_PROGRESS'); // untouched

    // Own job: full own-tech happy path.
    expect((await tech1.startJob(a.jobId)).res.status(), 'own start').toBe(200);
    const ownComplete = await tech1.completeJob(a.jobId, 'RBAC own-job completion');
    expect(ownComplete.res.status(), 'own complete').toBe(200);
    expect(ownComplete.body.job.status).toBe('COMPLETED');
  });

  // ── X-02c + DLV-20 (record_payment) ────────────────────────────────────────
  test('X-02c/DLV-20: TECHNICIAN record_payment — own-job invoice 201, other tech\'s 403', async () => {
    test.setTimeout(120_000); // two full approved-estimate→invoice seed chains

    // Standalone jobs can't be invoiced on this tree (no estimate lines → 400
    // "no line items", map §6.2), so both seeds are estimate-derived jobs.
    // Job completion is NOT required for invoicing — the chains stop at SCHEDULED.
    const own = await adminSentInvoiceOnTechJob(tech1Id, 72);
    const other = await adminSentInvoiceOnTechJob(tech2Id, 76);

    // Own-job invoice: route grant record_payment Invoice (OWN_INVOICE_VIA_JOB —
    // type-level canDo passes) + canAccessInvoice(job.assigned_to === self) → 201.
    expect(own.amountDue).toBeGreaterThan(0);
    const pay = await tech1.recordPayment(own.invoiceId, {
      amount: own.amountDue, method: 'CASH', notes: 'Collected on-site (RBAC X-02c)',
    });
    expect(pay.res.status(), 'tech pays own-job invoice').toBe(201);
    expect(pay.body.invoice.status).toBe('PAID');
    await assertInvoiceReconciles(admin, own.invoiceId, 'X-02c own-job payment (money moved)');

    // Other tech's job invoice: SENT (status-legal), so canAccessInvoice is the
    // only gate → 403 'Not authorized' (invoice.controller recordPayment backstop).
    const crossPay = await tech1.recordPayment(other.invoiceId, { amount: 10, method: 'CASH' });
    expect(crossPay.res.status(), 'tech pays other-tech invoice').toBe(403);
    expect(String(crossPay.body.error)).toBe('Not authorized');

    // Untouched: still SENT with the full balance open.
    const otherAfter = await admin.getInvoice(other.invoiceId);
    expect(otherAfter.status).toBe('SENT');
    expect(Number(otherAfter.amount_due)).toBe(other.amountDue);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
test.describe('redesign-22 RBAC — assignment eligibility (X-02 grid rows)', () => {
  test('X-02d: assign job to DISPATCHER → 400 (job-crew ineligible); assign lead to TECH/SALES → 200 (both owner-eligible, Bug #11)', async () => {
    // Job assignment: target must hold be_assigned Job (TECHNICIAN only) —
    // job.controller.ts:771-772.
    const { jobId } = await adminStandaloneJob();
    const toDispatcher = await admin.assignJob(jobId, {
      assignee_ids: [dispatcherId],
      scheduled_start: admin.futureDate(96), scheduled_end: admin.futureDate(98),
      force: true,
    });
    expect(toDispatcher.res.status()).toBe(400);
    expect(String(toDispatcher.body.error)).toBe('This user is not eligible to be assigned as job crew');

    // Positive contrast on the same job: a TECHNICIAN target is eligible.
    const toTech = await admin.assignJob(jobId, {
      assignee_ids: [tech1Id],
      scheduled_start: admin.futureDate(96), scheduled_end: admin.futureDate(98),
      force: true,
    });
    expect(toTech.res.status()).toBe(200);
    expect(toTech.body.job.assignees.some((a: any) => a.user.id === tech1Id)).toBe(true);

    // Lead ownership: target must hold be_assigned Lead (SALES only; TECHNICIAN
    // lacks it) — lead.controller.ts:918-919.
    const c = await createMaCustomerWithLocation(admin);
    const lead = await admin.createLead({
      customer_id: c.customerId,
      service_request: `rbac-elig-${admin.suffix}`,
      service_location_id: c.locationId,
    });
    expect(lead.res.status()).toBe(201);
    const leadId = lead.body.lead.id as string;

    // TECH IS lead-owner-eligible (Bug #11 — OWNER_ELIGIBLE_ROLES includes TECHNICIAN; only
    // DISPATCHER is excluded). Assigning a lead to a TECH succeeds (200).
    const toTechOwner = await admin.assignLead(leadId, tech1Id);
    expect(toTechOwner.res.status()).toBe(200);
    expect(toTechOwner.body.lead.commission_owner.id).toBe(tech1Id);

    // Positive contrast: a SALES target is eligible.
    const toSalesOwner = await admin.assignLead(leadId, sales1Id);
    expect(toSalesOwner.res.status()).toBe(200);
    expect(toSalesOwner.body.lead.commission_owner.id).toBe(sales1Id);
  });
});
