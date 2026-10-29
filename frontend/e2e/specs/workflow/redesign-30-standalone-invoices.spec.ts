import { test, expect } from '@playwright/test';
import { ApiClient } from '../../helpers/api-client';
import {
  createMaCustomerWithLocation,
  createTaxExemptCustomerWithLocation,
  createTech,
  uniquePhone,
} from '../../helpers/workflow-builders';

/**
 * redesign-30-standalone-invoices — REAL-DB API-tier coverage for the standalone
 * (customer-anchored, no job/estimate) invoice feature shipped in PR #219, plus the
 * estimate-less job-invoice path and DRAFT line-edit endpoints (#223). Named `redesign-30`
 * so the gate filter (`test:qa:api` runs `playwright test … redesign-`) collects it.
 *
 * WHY THIS EXISTS: `backend/src/__tests__/invoices.test.ts` covers the same controller
 * logic comprehensively, but against a MOCKED Prisma. This spec exercises the path through
 * the REAL staging DB to catch mock-vs-real divergence: the real `StateTaxRate` lookup
 * (MA = 6.25%, the asserted global fixture), the real service-location ownership constraint
 * (SEC-2 / DLV-27), real per-org numbering (allocateNumber), and real lifecycle persistence.
 *
 * Shared throwaway org, serial — data accumulates; assert on our own ids/values, never
 * absolute counts. Auth: provisioned-org ADMIN + admin-seeded SALES/TECH (email_confirm:true
 * → instantly loggable). Whole org is torn down by global teardown — no per-row cleanup.
 *
 * Request shape (from invoices.test.ts): POST /api/invoices
 *   { customer_id, line_items:[{description, quantity, unit_price, is_taxable}],
 *     service_location_id? | address? }  → 201 { invoice }
 */

const PASSWORD = 'Test123!@#';
const MA_RATE = 0.0625; // the global StateTaxRate fixture state (Boston, MA)

let admin: ApiClient;
let sales: ApiClient;
let tech: ApiClient;
let dispatcher: ApiClient;
// The seeded technician's user id — ROLE-5 needs it for the per-user permission grant
// (PUT /api/users/:id/permissions) and for job crew membership.
let techId: string;

async function seedRoleUser(role: 'SALES' | 'TECHNICIAN' | 'DISPATCHER', tag: string) {
  const email = `sa-${tag}-${admin.suffix}@e2e-qa.invalid`;
  const { res, body } = await admin.createUser({
    email, password: PASSWORD, first_name: 'Sa', last_name: tag, role,
  });
  expect(res.status(), `seed ${role} user`).toBe(201);
  const client = await new ApiClient().init({ email, password: PASSWORD });
  expect(client.authToken, `login as ${tag}`).toBeTruthy();
  return { id: body.user.id as string, client };
}

/** Create a standalone invoice as ADMIN; returns {res, body, invoice}. */
async function createStandalone(client: ApiClient, data: Record<string, any>) {
  return client.raw('post', '/api/invoices', data);
}

/**
 * Seed a COMPLETED direct (no-estimate) job on a fresh MA customer:
 * create → assign crew → start → complete. Mirrors noEstimateJobWithAttachments
 * (workflow-builders.ts) minus the lead + attachments. `assigneeIds` is the FULL crew
 * (assign is REPLACE semantics) — ROLE-5 passes it explicitly to control whether the
 * seeded tech is in/out of the crew; default is a throwaway tech.
 */
async function seedCompletedDirectJob(assigneeIds?: string[]) {
  const { customerId, locationId } = await createMaCustomerWithLocation(admin);
  const { res, body } = await admin.createJob({ customer_id: customerId, service_location_id: locationId });
  expect(res.status(), 'direct job create').toBe(201);
  const jobId = body.job.id as string;
  const crew = assigneeIds ?? [await createTech(admin)];
  const assigned = await admin.assignJob(jobId, {
    assignee_ids: crew,
    scheduled_start: admin.futureDate(1),
    scheduled_end: admin.futureDate(3),
  });
  expect(assigned.res.ok(), 'assign direct job').toBeTruthy();
  expect((await admin.startJob(jobId)).res.ok(), 'start direct job').toBeTruthy();
  const done = await admin.completeJob(jobId, 'QA: direct-job completion for invoice tests.');
  expect(done.res.ok(), 'complete direct job').toBeTruthy();
  return { jobId, customerId, locationId };
}

test.beforeAll(async () => {
  admin = await new ApiClient().init();
  ({ client: sales } = await seedRoleUser('SALES', 'sales'));
  ({ id: techId, client: tech } = await seedRoleUser('TECHNICIAN', 'tech'));
  ({ client: dispatcher } = await seedRoleUser('DISPATCHER', 'dispatch'));
});

test.afterAll(async () => {
  for (const c of [sales, tech, dispatcher, admin]) {
    try { await c?.dispose(); } catch { /* partial beforeAll */ }
  }
});

test.describe('standalone invoices — real-DB create + tax (SA/TX)', () => {
  test('SA-1/SA-4: existing MA customer, omit location → tax from PRIMARY location (6.25%)', async () => {
    const { customerId } = await createMaCustomerWithLocation(admin);
    const { res, body } = await createStandalone(admin, {
      customer_id: customerId,
      line_items: [{ description: 'Diagnostic fee', quantity: 1, unit_price: 100, is_taxable: true }],
    });
    expect(res.status(), 'standalone create 201').toBe(201);
    const inv = body.invoice;
    expect(inv.status).toBe('DRAFT');
    expect(inv.kind ?? 'STANDARD').toBe('STANDARD');
    expect(inv.job_id ?? null).toBeNull();
    expect(inv.customer_id).toBe(customerId);
    expect(String(inv.invoice_number)).toMatch(/^I\d+$/);
    expect(Number(inv.subtotal)).toBe(100);
    expect(Number(inv.tax_amount)).toBeCloseTo(100 * MA_RATE, 2); // 6.25
    expect(Number(inv.total_amount)).toBeCloseTo(106.25, 2);
    expect(Number(inv.amount_due)).toBeCloseTo(106.25, 2);
  });

  test('SA-6/TX-4: new customer, NO location, taxable line → $0 tax (no location resolves)', async () => {
    const customer = await admin.createCustomer({
      first_name: 'QA', last_name: `NoLoc-${admin.suffix}`,
      email: `noloc-${admin.suffix}-${Date.now()}@e2e-qa.invalid`, phone: uniquePhone(),
    });
    const { res, body } = await createStandalone(admin, {
      customer_id: customer.id,
      line_items: [{ description: 'Service', quantity: 1, unit_price: 200, is_taxable: true }],
    });
    expect(res.status(), 'no-location create 201').toBe(201);
    expect(Number(body.invoice.subtotal)).toBe(200);
    expect(Number(body.invoice.tax_amount)).toBe(0);
    expect(Number(body.invoice.total_amount)).toBe(200);
  });

  test('TX-1: tax-exempt customer → $0 tax regardless of location', async () => {
    const { customerId } = await createTaxExemptCustomerWithLocation(admin);
    const { res, body } = await createStandalone(admin, {
      customer_id: customerId,
      line_items: [{ description: 'Service', quantity: 1, unit_price: 500, is_taxable: true }],
    });
    expect(res.status(), 'exempt create 201').toBe(201);
    expect(Number(body.invoice.subtotal)).toBe(500);
    expect(Number(body.invoice.tax_amount)).toBe(0);
  });

  test('TX-5/VAL-5: mixed taxable + non-taxable → tax on the taxable subtotal only', async () => {
    // NOTE: the issue text frames TX-5 as 'preview-vs-server tax resolution'. That framing is
    // deliberately repurposed here as the mixed-taxable case because no invoice tax-PREVIEW API
    // endpoint exists — the FE computes previews client-side from GET /api/state-tax-rates.
    // The TX-5 label reuse is intentional, not drift.
    const { customerId } = await createMaCustomerWithLocation(admin);
    const { res, body } = await createStandalone(admin, {
      customer_id: customerId,
      line_items: [
        { description: 'Labor (taxable)', quantity: 1, unit_price: 100, is_taxable: true },
        { description: 'Permit (non-taxable)', quantity: 1, unit_price: 100, is_taxable: false },
      ],
    });
    expect(res.status()).toBe(201);
    expect(Number(body.invoice.subtotal)).toBe(200);
    expect(Number(body.invoice.tax_amount)).toBeCloseTo(100 * MA_RATE, 2); // 6.25, taxable line only
  });

  test('VAL-7: fractional quantity 2.5 × $10 → line money-rounded to $25.00', async () => {
    const { customerId } = await createTaxExemptCustomerWithLocation(admin);
    const { res, body } = await createStandalone(admin, {
      customer_id: customerId,
      line_items: [{ description: 'Hours', quantity: 2.5, unit_price: 10, is_taxable: false }],
    });
    expect(res.status()).toBe(201);
    expect(Number(body.invoice.subtotal)).toBeCloseTo(25, 2);
  });

  test('TX-3: customer whose only location has NO StateTaxRate row (OR) → 201, tax 0', async () => {
    // lookupStateTaxRate returns 0 when the state has no StateTaxRate row (Oregon: no sales tax).
    const customer = await admin.createCustomer({
      first_name: 'QA', last_name: `Oregon-${admin.suffix}`,
      email: `or-${admin.suffix}-${Date.now()}@e2e-qa.invalid`, phone: uniquePhone(),
    });
    await admin.addLocation(customer.id, {
      address_line1: '100 SW Main St', city: 'Portland', state: 'OR', zip: '97204', is_primary: true,
    });
    const { res, body } = await createStandalone(admin, {
      customer_id: customer.id,
      line_items: [{ description: 'Svc', quantity: 1, unit_price: 300, is_taxable: true }],
    });
    expect(res.status(), 'no-rate-state create 201').toBe(201);
    expect(Number(body.invoice.subtotal)).toBe(300);
    expect(Number(body.invoice.tax_amount), 'no StateTaxRate row → tax 0').toBe(0);
    expect(Number(body.invoice.total_amount)).toBe(300);
  });

  test('VAL-6: MA customer, ALL lines non-taxable → tax 0 explicit', async () => {
    const { customerId } = await createMaCustomerWithLocation(admin);
    const { res, body } = await createStandalone(admin, {
      customer_id: customerId,
      line_items: [
        { description: 'Permit', quantity: 1, unit_price: 150, is_taxable: false },
        { description: 'Disposal fee', quantity: 1, unit_price: 50, is_taxable: false },
      ],
    });
    expect(res.status()).toBe(201);
    expect(Number(body.invoice.subtotal)).toBe(200);
    expect(Number(body.invoice.tax_amount), 'taxable base is empty → 0 despite MA location').toBe(0);
    expect(Number(body.invoice.total_amount)).toBe(200);
  });

  test('VAL-8: $0 line alongside a $100 line → 201, both lines kept, subtotal 100', async () => {
    // unit_price min(0) is allowed by both the create schema and addLineSchema — a free/comped
    // line is a legal row, not a validation error.
    const { customerId } = await createTaxExemptCustomerWithLocation(admin);
    const { res, body } = await createStandalone(admin, {
      customer_id: customerId,
      line_items: [
        { description: 'Free inspection', quantity: 1, unit_price: 0, is_taxable: false },
        { description: 'Repair', quantity: 1, unit_price: 100, is_taxable: false },
      ],
    });
    expect(res.status()).toBe(201);
    expect(body.invoice.line_items.length, 'both lines persisted').toBe(2);
    expect(Number(body.invoice.subtotal)).toBe(100);
  });
});

test.describe('standalone invoices — security + numbering (SEC)', () => {
  test('SEC-2/DLV-27: service_location_id NOT on the customer → 400 ownership reject', async () => {
    const { customerId } = await createMaCustomerWithLocation(admin);
    // A location belonging to a DIFFERENT customer.
    const { locationId: foreignLocId } = await createMaCustomerWithLocation(admin);
    const { res } = await createStandalone(admin, {
      customer_id: customerId,
      service_location_id: foreignLocId,
      line_items: [{ description: 'X', quantity: 1, unit_price: 50, is_taxable: true }],
    });
    expect(res.status(), 'foreign location rejected').toBe(400);
  });

  test('SEC-1: unknown customer_id → 404 (tenant-scoped lookup)', async () => {
    // NOTE: this probe uses a NONEXISTENT UUID, so it exercises the tenant-scoped lookup shape
    // (tenantWhere spread at invoice.controller.ts:703) only INDIRECTLY. The TRUE cross-org
    // probe — a REAL customer id from a second org → 404 — lives in redesign-24-tenancy, which
    // owns cross-org proofs suite-wide; this test is NOT the cross-org proof.
    const { res } = await createStandalone(admin, {
      customer_id: '00000000-0000-0000-0000-0000000000aa',
      line_items: [{ description: 'X', quantity: 1, unit_price: 50, is_taxable: true }],
    });
    expect(res.status()).toBe(404);
  });

  test('SEC-3/SEC-4: same customer can have MULTIPLE standalone invoices; numbers are sequential within org', async () => {
    const { customerId } = await createMaCustomerWithLocation(admin);
    const a = await createStandalone(admin, {
      customer_id: customerId, line_items: [{ description: 'A', quantity: 1, unit_price: 10, is_taxable: false }],
    });
    const b = await createStandalone(admin, {
      customer_id: customerId, line_items: [{ description: 'B', quantity: 1, unit_price: 10, is_taxable: false }],
    });
    expect(a.res.status(), 'first standalone').toBe(201);
    expect(b.res.status(), 'second standalone (no job-style 409)').toBe(201);
    const nA = Number(String(a.body.invoice.invoice_number).replace(/\D/g, ''));
    const nB = Number(String(b.body.invoice.invoice_number).replace(/\D/g, ''));
    expect(nB, 'second number is later').toBeGreaterThan(nA);
  });
});

test.describe('standalone invoices — DRAFT line-edit endpoints (DRAFT)', () => {
  async function freshDraft() {
    const { customerId } = await createMaCustomerWithLocation(admin);
    const { res, body } = await createStandalone(admin, {
      customer_id: customerId,
      line_items: [{ description: 'Base', quantity: 1, unit_price: 100, is_taxable: true }],
    });
    expect(res.status()).toBe(201);
    return body.invoice.id as string;
  }

  test('DRAFT-1/2/3: add → edit → remove a line, totals recompute each time', async () => {
    const id = await freshDraft();
    // add
    const add = await admin.raw('post', `/api/invoices/${id}/line-items`, {
      description: 'Extra part', quantity: 2, unit_price: 50, is_taxable: true,
    });
    // addLine responds res.json(...) → 200, not 201 (invoice-lines.controller.ts addLine).
    expect(add.res.status(), 'add line').toBe(200);
    let inv = (await admin.getInvoice(id));
    expect(Number(inv.subtotal), 'subtotal after add = 100 + 100').toBeCloseTo(200, 2);
    const lines = inv.line_items;
    const addedId = lines[lines.length - 1].id;
    // edit
    const edit = await admin.raw('patch', `/api/invoices/${id}/line-items/${addedId}`, { unit_price: 25 });
    expect(edit.res.status(), 'edit line').toBe(200);
    inv = await admin.getInvoice(id);
    expect(Number(inv.subtotal), 'subtotal after edit = 100 + 50').toBeCloseTo(150, 2);
    // remove
    const del = await admin.raw('delete', `/api/invoices/${id}/line-items/${addedId}`);
    expect(del.res.status(), 'remove line').toBe(200);
    inv = await admin.getInvoice(id);
    expect(Number(inv.subtotal), 'subtotal after remove = 100').toBeCloseTo(100, 2);
  });

  test('DRAFT-4: deleting the LAST remaining line → 200, totals recompute to $0', async () => {
    // The qa-map expected 400 here, but deleteLine has NO last-line guard (invoice-lines.controller.ts
    // deleteLine: invoice-scoped deleteMany + recompute): the delete succeeds and the invoice
    // recomputes to $0. Pinned as shipped behavior — a last-line guard, if wanted, is a separate
    // product issue.
    const id = await freshDraft();
    const inv = await admin.getInvoice(id);
    const onlyLine = inv.line_items[0].id;
    const del = await admin.raw('delete', `/api/invoices/${id}/line-items/${onlyLine}`);
    expect(del.res.status(), 'last-line delete succeeds').toBe(200);
    const after = await admin.getInvoice(id);
    expect(after.line_items.length, 'no lines remain').toBe(0);
    expect(Number(after.subtotal)).toBe(0);
    expect(Number(after.total_amount)).toBe(0);
    expect(Number(after.amount_due)).toBe(0);
  });

  test('DRAFT-5: billing tax_rate change recomputes tax (PATCH /:id/billing)', async () => {
    // The qa-map's DRAFT-9 'foreign location → 400 on PATCH /:id/tax-location' is NOT runnable:
    // that route was never shipped — it was replaced by the numeric-only PATCH /:id/billing
    // (updateBillingSchema: tip / discount_amount / tax_rate FRACTION; invoice.routes.ts). There
    // is no location id in the billing payload, so no API surface exists through which a foreign
    // location can reach invoice tax; SEC-2 pins the ONLY location-accepting path
    // (create-time service_location_id → 400 ownership reject).
    const { customerId } = await createMaCustomerWithLocation(admin);
    const { res, body } = await createStandalone(admin, {
      customer_id: customerId,
      line_items: [{ description: 'Svc', quantity: 1, unit_price: 100, is_taxable: true }],
    });
    expect(res.status()).toBe(201);
    expect(Number(body.invoice.tax_amount)).toBeCloseTo(6.25, 2);
    const id = body.invoice.id as string;
    // Jurisdiction change to "No tax" (rate fraction 0) …
    const zero = await admin.raw('patch', `/api/invoices/${id}/billing`, { tax_rate: 0 });
    expect(zero.res.status(), 'billing tax_rate 0').toBe(200);
    expect(Number(zero.body.invoice.tax_amount), 'tax recomputed to 0').toBe(0);
    // … and back to the MA rate.
    const ma = await admin.raw('patch', `/api/invoices/${id}/billing`, { tax_rate: MA_RATE });
    expect(ma.res.status(), 'billing tax_rate back to 6.25%').toBe(200);
    expect(Number(ma.body.invoice.tax_amount)).toBeCloseTo(6.25, 2);
    expect(Number(ma.body.invoice.total_amount)).toBeCloseTo(106.25, 2);
  });

  test('DRAFT-6: editable-until-PAID — SENT accepts line edits; PAID → 400 locked', async () => {
    // Editable-until-PAID shipped 2026-06-27 (lib/invoice-editable.ts): DRAFT/SENT/PARTIAL are
    // editable; only PAID/VOIDED/REFUNDED/PARTIALLY_REFUNDED/DISPUTED lock. The qa-map's old
    // 'line edit on SENT → 400' is stale — SENT now accepts the edit.
    const id = await freshDraft();
    expect((await admin.sendInvoice(id)).res.status(), 'send').toBe(200);
    const addOnSent = await admin.raw('post', `/api/invoices/${id}/line-items`, {
      description: 'late add on SENT', quantity: 1, unit_price: 10, is_taxable: false,
    });
    expect(addOnSent.res.status(), 'SENT is still editable').toBe(200);
    // Settle in full → PAID locks the invoice.
    const inv = await admin.getInvoice(id);
    const pay = await admin.recordPayment(id, { amount: Number(inv.amount_due), method: 'CASH' });
    expect(pay.res.status(), 'full payment').toBe(201);
    expect((await admin.getInvoice(id)).status).toBe('PAID');
    const addOnPaid = await admin.raw('post', `/api/invoices/${id}/line-items`, {
      description: 'late add on PAID', quantity: 1, unit_price: 10, is_taxable: false,
    });
    expect(addOnPaid.res.status(), 'PAID invoice is locked').toBe(400);
  });

  test('DRAFT-7: line edit as SALES → 403', async () => {
    const id = await freshDraft();
    const add = await sales.raw('post', `/api/invoices/${id}/line-items`, {
      description: 'sales add', quantity: 1, unit_price: 10, is_taxable: false,
    });
    expect(add.res.status()).toBe(403);
  });

  test('DRAFT-8: foreign lineId — cross-invoice PATCH → 404; DELETE → silent 200 no-op', async () => {
    const idA = await freshDraft();
    const idB = await freshDraft();
    const invB = await admin.getInvoice(idB);
    const lineIdOfB = invB.line_items[0].id;
    // PATCH invoice A with B's line id: updateLine's in-tx findFirst is scoped to invoice_id
    // (invoice-lines.controller.ts updateLine) → null → 404, and NO cross-invoice write happens.
    const cross = await admin.raw('patch', `/api/invoices/${idA}/line-items/${lineIdOfB}`, { unit_price: 999 });
    expect(cross.res.status(), 'cross-invoice PATCH rejected').toBe(404);
    expect(cross.body.error).toBe('Line item not found');
    const invBAfter = await admin.getInvoice(idB);
    expect(Number(invBAfter.line_items[0].unit_price), "B's line untouched").toBe(100);
    // DELETE with a foreign lineId is a SILENT 200 no-op: deleteLine uses an invoice-scoped
    // deleteMany, so a foreign id matches 0 rows and the handler recomputes + responds 200.
    // The 200-not-404 shape is current shipped behavior, pinned deliberately — if a later
    // product change makes it 404, update this assertion.
    const delCross = await admin.raw('delete', `/api/invoices/${idA}/line-items/${lineIdOfB}`);
    expect(delCross.res.status(), 'foreign-line DELETE is a no-op 200').toBe(200);
    const invBFinal = await admin.getInvoice(idB);
    expect(invBFinal.line_items.length, "B's line still exists").toBe(1);
    const invAFinal = await admin.getInvoice(idA);
    expect(Number(invAFinal.subtotal), "A's subtotal unchanged").toBeCloseTo(100, 2);
  });
});

test.describe('estimate-less job invoices (JI/RG)', () => {
  // ONE shared completed direct job for this block. Test order matters (serial, workers:1):
  // the empty-lines guard MUST run before JI-2 creates the first invoice (the one-ACTIVE-invoice
  // 409 check precedes the empty-lines 400 in invoice.controller.ts create()).
  // SEQUENCING: JI-5's final POST leaves this job carrying an ACTIVE invoice — later tests
  // (ROLE-5) must NEVER reuse it; they seed their own fresh jobs.
  //
  // NOT seedable through the public API (both remain unit-covered in
  // backend/src/__tests__/invoices.test.ts):
  //   - RG-3 (estimate with ZERO lines → 400 at invoice create): createEstimate's schema
  //     requires min 1 line_item, so an empty-lined estimate cannot exist via the API.
  //   - JI-8 (location-less direct job → unguarded job.service_location.state): createJobSchema
  //     requires service_location_id or new_location for a customer-anchored job, so a
  //     location-less direct job cannot exist via the API.
  let jiJobId: string;
  let jiFirstInvoiceId: string;

  test.beforeAll(async () => {
    ({ jobId: jiJobId } = await seedCompletedDirectJob());
  });

  test('JI job-path empty-lines guard: POST {job_id} with no line_items → 400', async () => {
    const { res, body } = await admin.raw('post', '/api/invoices', { job_id: jiJobId });
    expect(res.status(), 'estimate-less job + no authored lines').toBe(400);
    expect(String(body.error)).toContain('no line items');
  });

  test("JI-2: authored line_items on an estimate-less job → 201, tax from the job's MA service location", async () => {
    const { res, body } = await admin.raw('post', '/api/invoices', {
      job_id: jiJobId,
      line_items: [{ description: 'Emergency labor', quantity: 1, unit_price: 400, is_taxable: true }],
    });
    expect(res.status(), 'job-anchored authored-lines create').toBe(201);
    jiFirstInvoiceId = body.invoice.id as string;
    expect(Number(body.invoice.subtotal)).toBe(400);
    expect(Number(body.invoice.tax_amount), 'tax = 400 × 6.25% from job.service_location.state').toBeCloseTo(400 * MA_RATE, 2);
    expect(Number(body.invoice.total_amount)).toBeCloseTo(425, 2);
  });

  test('JI-4: second invoice on the same job → 409 (one ACTIVE invoice per job)', async () => {
    const { res, body } = await admin.raw('post', '/api/invoices', {
      job_id: jiJobId,
      line_items: [{ description: 'Double bill attempt', quantity: 1, unit_price: 10, is_taxable: false }],
    });
    expect(res.status(), 'second active invoice blocked').toBe(409);
    expect(String(body.error)).toContain('already has an invoice');
  });

  test('JI-5: void the first invoice, then POST again → 201 (VOIDED does not block reissue)', async () => {
    const voided = await admin.voidInvoice(jiFirstInvoiceId, 'QA void for reissue');
    expect(voided.res.status(), 'void first job invoice').toBe(200);
    const { res, body } = await admin.raw('post', '/api/invoices', {
      job_id: jiJobId,
      line_items: [{ description: 'Reissued labor', quantity: 1, unit_price: 400, is_taxable: true }],
    });
    expect(res.status(), 'reissue after void').toBe(201);
    expect(Number(body.invoice.total_amount)).toBeCloseTo(425, 2);
  });
});

test.describe('standalone invoices — lifecycle + role gating (DS/ROLE)', () => {
  async function draftFor(amount: number) {
    const { customerId } = await createTaxExemptCustomerWithLocation(admin); // exempt → predictable total
    const { res, body } = await createStandalone(admin, {
      customer_id: customerId,
      line_items: [{ description: 'Svc', quantity: 1, unit_price: amount, is_taxable: false }],
    });
    expect(res.status()).toBe(201);
    return body.invoice.id as string;
  }

  test('DS-1/2/3: send → partial payment (PARTIAL) → full payment (PAID)', async () => {
    const id = await draftFor(200);
    expect((await admin.sendInvoice(id)).res.status()).toBe(200);
    const partial = await admin.recordPayment(id, { amount: 50, method: 'CASH' });
    expect(partial.res.status(), 'partial payment').toBe(201);
    expect((await admin.getInvoice(id)).status).toBe('PARTIAL');
    const full = await admin.recordPayment(id, { amount: 150, method: 'CASH' });
    expect(full.res.status(), 'final payment').toBe(201);
    const inv = await admin.getInvoice(id);
    expect(inv.status).toBe('PAID');
    expect(Number(inv.amount_due)).toBe(0);
  });

  test('DS-5: void a standalone invoice → VOIDED', async () => {
    const id = await draftFor(100);
    expect((await admin.sendInvoice(id)).res.status()).toBe(200);
    const voided = await admin.voidInvoice(id, 'QA void');
    expect(voided.res.status(), 'void').toBe(200);
    expect((await admin.getInvoice(id)).status).toBe('VOIDED');
  });

  test('DS-7: delete DRAFT → 204; delete a non-DRAFT → 400', async () => {
    const draftId = await draftFor(100);
    const delDraft = await admin.deleteInvoice(draftId);
    expect(delDraft.res.status(), 'delete DRAFT').toBe(204);
    const sentId = await draftFor(100);
    expect((await admin.sendInvoice(sentId)).res.status()).toBe(200);
    const delSent = await admin.deleteInvoice(sentId);
    expect(delSent.res.status(), 'delete non-DRAFT blocked').toBe(400);
  });

  test('ROLE-3/4: SALES and TECHNICIAN cannot create a standalone invoice → 403', async () => {
    const { customerId } = await createMaCustomerWithLocation(admin);
    const body = { customer_id: customerId, line_items: [{ description: 'X', quantity: 1, unit_price: 10, is_taxable: false }] };
    expect((await sales.raw('post', '/api/invoices', body)).res.status(), 'SALES 403').toBe(403);
    expect((await tech.raw('post', '/api/invoices', body)).res.status(), 'TECH 403').toBe(403);
  });

  test('ROLE-2: DISPATCHER creates a standalone invoice → 201', async () => {
    // createStandaloneInvoice allows ADMIN + DISPATCHER only (invoice.controller.ts).
    const { customerId } = await createMaCustomerWithLocation(admin);
    const { res, body } = await dispatcher.raw('post', '/api/invoices', {
      customer_id: customerId,
      line_items: [{ description: 'Dispatcher-billed service', quantity: 1, unit_price: 50, is_taxable: false }],
    });
    expect(res.status(), 'dispatcher standalone create').toBe(201);
    expect(body.invoice.status).toBe('DRAFT');
    expect(Number(body.invoice.subtotal)).toBe(50);
  });

  test('ROLE-5: TECHNICIAN job-anchored invoice — per-user grant + own-job scope', async () => {
    // GUARD ORDERING (invoice.controller.ts create()): on the job-anchored path the
    // one-ACTIVE-invoice 409 runs BEFORE the per-instance ownership 403 — so sub-tests (c)
    // and (d) MUST each use a FRESH completed direct job with NO active invoice (never the
    // JI block's shared job, which ends that block carrying an ACTIVE invoice), or they
    // would get 409 instead of the asserted 201/403.
    const lineItems = [{ description: 'Tech labor', quantity: 1, unit_price: 100, is_taxable: false }];

    // (a) bare TECHNICIAN (no create-Invoice grant since Phase B #253): route-level canDo 403.
    // This 403 precedes even the 409, so the (not-yet-invoiced) fresh job below is reusable in (d).
    const { jobId: foreignJob } = await seedCompletedDirectJob(); // crew does NOT include techId
    const bare = await tech.raw('post', '/api/invoices', { job_id: foreignJob, line_items: lineItems });
    expect(bare.res.status(), 'bare tech 403 (route canDo)').toBe(403);

    // (b) ADMIN grants the per-user create-Invoice capability (own-scoped via job assignment —
    // userCapabilities.ts OWN_INVOICE_VIA_JOB, impliesRead).
    const grant = await admin.raw('put', `/api/users/${techId}/permissions`, {
      overrides: [{ action: 'create', subject: 'Invoice', effect: 'allow' }],
    });
    expect(grant.res.ok(), 'grant create-Invoice override').toBeTruthy();

    // (c) fresh completed direct job WITH the tech in the crew → 201.
    const { jobId: ownJob } = await seedCompletedDirectJob([techId]);
    const own = await tech.raw('post', '/api/invoices', { job_id: ownJob, line_items: lineItems });
    expect(own.res.status(), 'granted tech on OWN job').toBe(201);
    expect(own.body.invoice.job_id).toBe(ownJob);

    // (d) fresh completed direct job WITHOUT the tech in the crew → 403 (own-scope
    // per-instance check; the grant is own-job-scoped, not org-wide).
    const foreign = await tech.raw('post', '/api/invoices', { job_id: foreignJob, line_items: lineItems });
    expect(foreign.res.status(), 'granted tech on unassigned job').toBe(403);
  });
});
