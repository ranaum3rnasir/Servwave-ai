import { test, expect } from '@playwright/test';
import { ApiClient } from '../../helpers/api-client';
import { createSalesUser, createTech, uniquePhone } from '../../helpers/workflow-builders';
import { assertInvoiceReconciles } from '../../helpers/reconcile';
import { flagKnownBug } from '../../helpers/known-bug';

/**
 * Stage 1 — Customer & Organization (Task C1, rows CUST-01..CUST-20).
 *
 * ONE shared org, serial: data accumulates. Never assert absolute list counts —
 * we capture baselines / assert presence of OUR seeded id (unique via api.suffix).
 *
 * Stage notes (from facts/customer-org.json — FACTS WIN over the plan):
 *  - "org" in CUST-11/15/19 = a PARENT CUSTOMER billing group (parent_id/bill_to).
 *    There is NO Organization-tenant CRUD endpoint; all org-membership rows use /api/customers.
 *  - CUST-06 (multi-primary not deduped), CUST-08 (billing_terms not wired to due_date),
 *    CUST-12 (bill_to=self is VALID on PATCH), CUST-18 (no money-gate, only confirm+members),
 *    CUST-20 (anonymize 501 stub) are corrected/known-bug rows.
 */
let api: ApiClient;
test.beforeAll(async () => { api = await new ApiClient().init(); });
test.afterAll(async () => { await api.dispose(); });

// ─── small local helper (no api-client edits): full chain → created (DRAFT) invoice ───
// Builds Lead → contacted → walkthrough(SALES) → completed → estimate → SENT → approve →
// Job → assign → start → complete → createInvoice, anchored to a customer we own (so we can
// control fields like payment_type / tax_exempt and own the customer id for purge tests).
async function chainToCreatedInvoice(
  api: ApiClient,
  customerId: string,
  locationId: string,
  lineItems: Array<{ description: string; quantity: number; unit_price: number; is_taxable?: boolean }>,
) {
  const { body: leadBody } = await api.createLead({
    customer_id: customerId, service_request: `chain-${api.suffix}`, service_location_id: locationId,
  });
  const leadId = leadBody.lead.id;
  await api.contactLead(leadId);
  const performerId = await createSalesUser(api);
  await api.scheduleWalkthrough(leadId, {
    walkthrough_scheduled_at: api.futureDate(24), performer_ids: [performerId],
  });
  await api.completeWalkthrough(leadId);
  const { body: estBody } = await api.createEstimate({ lead_id: leadId, line_items: lineItems });
  const estimateId = estBody.estimate.id;
  const { body: sentBody } = await api.sendEstimate(estimateId, { deposit_required: false });
  await api.approveEstimatePublic(estimateId, sentBody.estimate.public_token, { signature_data: api.testSignature });
  const { body: jobBody } = await api.createJob({ estimate_id: estimateId });
  const jobId = jobBody.job.id;
  const techId = await createTech(api);
  await api.assignJob(jobId, {
    assignee_ids: [techId], scheduled_start: api.futureDate(48), scheduled_end: api.futureDate(50),
  });
  await api.startJob(jobId);
  await api.completeJob(jobId, 'chain complete');
  const { body: invBody } = await api.createInvoice(jobId);
  return { leadId, estimateId, jobId, invoice: invBody.invoice };
}

test.describe('Stage 1 — Customer & Organization', () => {
  test('CUST-01: create PERSON with kind+segment+multi phone; single primary persisted', async () => {
    const s = api.suffix;
    const c = await api.createCustomer({
      first_name: `P-${s}`, last_name: 'Person', email: `p-${s}@e2e-qa.invalid`, phone: uniquePhone(),
      kind: 'PERSON', segment: 'RESIDENTIAL',
      // field key is `phone` (NOT `number`); exactly ONE is_primary so single-primary holds.
      phones: [
        { phone: '6175550001', label: 'mobile', is_primary: true },
        { phone: '6175550002', label: 'work', extension: '12' },
      ],
    });
    const fetched = await api.getCustomer(c.id);
    expect(fetched.kind).toBe('PERSON');
    expect(fetched.segment).toBe('RESIDENTIAL');
    expect(fetched.first_name).toBe(`P-${s}`);
    expect(fetched.last_name).toBe('Person');
    const primaries = (fetched.phones ?? []).filter((p: any) => p.is_primary);
    expect(primaries.length).toBe(1);
  });

  test('CUST-02: create COMPANY — names+company_name all blank → 400; with company_name → 201', async () => {
    const s = api.suffix;
    // personOrCompany refine does NOT branch on kind: a 400 fires only when BOTH (first+last)
    // AND company_name are absent. So omit all name fields to provoke the 400.
    const bad = await api.raw('post', '/api/customers', {
      kind: 'COMPANY', segment: 'COMMERCIAL', email: `co-bad-${s}@e2e-qa.invalid`, phone: uniquePhone(),
    });
    expect(bad.res.status()).toBe(400);
    expect(bad.body.error).toBe('Validation failed');

    // Positive: same body + company_name persists as a COMPANY.
    const good = await api.createCustomer({
      kind: 'COMPANY', segment: 'COMMERCIAL', company_name: `Acme Co ${s}`,
      email: `co-${s}@e2e-qa.invalid`, phone: uniquePhone(),
    });
    const fetched = await api.getCustomer(good.id);
    expect(fetched.kind).toBe('COMPANY');
    expect(fetched.company_name).toBe(`Acme Co ${s}`);
  });

  test('CUST-03: segment RESIDENTIAL vs COMMERCIAL persists', async () => {
    const s = api.suffix;
    const res = await api.createCustomer({
      first_name: `R-${s}`, last_name: 'Resi', email: `r-${s}@e2e-qa.invalid`, phone: uniquePhone(),
      kind: 'PERSON', segment: 'RESIDENTIAL',
    });
    const com = await api.createCustomer({
      first_name: `C-${s}`, last_name: 'Comm', company_name: `BizCo ${s}`,
      email: `cc-${s}@e2e-qa.invalid`, phone: uniquePhone(), kind: 'COMPANY', segment: 'COMMERCIAL',
    });
    expect((await api.getCustomer(res.id)).segment).toBe('RESIDENTIAL');
    expect((await api.getCustomer(com.id)).segment).toBe('COMMERCIAL');
  });

  test('CUST-04: top-level email is primary; extra_emails carry no primary flag', async () => {
    const s = api.suffix;
    const c = await api.createCustomer({
      first_name: `E-${s}`, last_name: 'Mailer', email: `primary-${s}@e2e-qa.invalid`, phone: uniquePhone(),
      kind: 'PERSON', segment: 'RESIDENTIAL',
      extra_emails: [{ email: `second-${s}@e2e-qa.invalid`, label: 'work' }],
    });
    const fetched = await api.getCustomer(c.id);
    // "One primary" = the single top-level customer.email; extra_emails[] are non-primary.
    expect(fetched.email).toBe(`primary-${s}@e2e-qa.invalid`);
    expect((fetched.extra_emails ?? []).length).toBe(1);
    expect(fetched.extra_emails[0].email).toBe(`second-${s}@e2e-qa.invalid`);
  });

  test('CUST-05: phones[] persist with label + extension', async () => {
    const s = api.suffix;
    const c = await api.createCustomer({
      first_name: `Ph-${s}`, last_name: 'Ones', email: `ph-${s}@e2e-qa.invalid`, phone: uniquePhone(),
      kind: 'PERSON', segment: 'RESIDENTIAL',
      phones: [
        { phone: '6175550021', label: 'mobile', is_primary: true },
        { phone: '6175550022', label: 'work', extension: '12' },
      ],
    });
    const fetched = await api.getCustomer(c.id);
    expect((fetched.phones ?? []).length).toBe(2);
    const work = fetched.phones.find((p: any) => p.label === 'work');
    expect(work).toBeTruthy();
    // Response key is `extension` (NOT `ext`).
    expect(work.extension).toBe('12');
  });

  test('CUST-06: multi-primary deduped — server collapses to exactly one primary (the first)', async () => {
    const s = api.suffix;
    const c = await api.createCustomer({
      first_name: `MP-${s}`, last_name: 'Dual', email: `mp-${s}@e2e-qa.invalid`, phone: uniquePhone(),
      kind: 'PERSON', segment: 'RESIDENTIAL',
      phones: [
        { phone: '6175550031', label: 'a', is_primary: true },
        { phone: '6175550032', label: 'b', is_primary: true },
      ],
    });
    const fetched = await api.getCustomer(c.id);
    const primaries = (fetched.phones ?? []).filter((p: any) => p.is_primary);
    // FIXED: normalizePhones keeps a SINGLE primary — the first phone sent is_primary:true wins,
    // the rest are forced false. Exactly one primary persists; it's phone 'a'.
    expect(primaries.length).toBe(1);
    expect(primaries[0].phone).toBe('6175550031');
    const a = fetched.phones.find((p: any) => p.label === 'a');
    const b = fetched.phones.find((p: any) => p.label === 'b');
    expect(a.is_primary).toBe(true);
    expect(b.is_primary).toBe(false);
  });

  test('CUST-07: billing_same_as_service_location copies primary location into billing_*', async () => {
    const s = api.suffix;
    const c = await api.createCustomer({
      first_name: `B-${s}`, last_name: 'Copy', email: `b-${s}@e2e-qa.invalid`, phone: uniquePhone(),
      kind: 'PERSON', segment: 'RESIDENTIAL',
      locations: [{ address_line1: '10 Main', address_line2: 'Apt 2', city: 'Boston', state: 'MA', zip: '02108', is_primary: true }],
      billing_same_as_service_location: true,
    });
    const fetched = await api.getCustomer(c.id);
    expect(fetched.billing_address_line1).toBe('10 Main');
    expect(fetched.billing_city).toBe('Boston');
    expect(fetched.billing_state).toBe('MA');
    expect(fetched.billing_zip).toBe('02108');
    // address_line2 is intentionally NOT copied — do not assert it.
  });

  test('CUST-08: invoice due_date driven by legacy payment_type (NET 15); billing_terms ignored (known bug)', async () => {
    const s = api.suffix;
    // Spec-as-written says billing_terms drives due_date; REAL code computes
    // due_date = calculateDueDate(customer.payment_type, now). We assert the REAL behavior
    // (payment_type='NET 15' → now + 15 days) and flag that billing_terms is unwired.
    const c = await api.createCustomer({
      first_name: `T-${s}`, last_name: 'Terms', email: `t-${s}@e2e-qa.invalid`, phone: uniquePhone(),
      kind: 'COMPANY', segment: 'COMMERCIAL', company_name: `Terms Co ${s}`,
      payment_type: 'NET 15', billing_terms: 'Net 15 days',
    });
    const loc = await api.addLocation(c.id, {
      address_line1: '20 Beacon St', city: 'Boston', state: 'MA', zip: '02108', is_primary: true,
    });
    const { invoice } = await chainToCreatedInvoice(api, c.id, loc.id, [
      { description: 'Service', quantity: 1, unit_price: 1000, is_taxable: true },
    ]);
    // Invoice created with due_date = created_at + 15 days (NET 15). Compare day-deltas to avoid
    // sub-second clock skew between request issue and DB write.
    const created = new Date(invoice.created_at).getTime();
    const due = new Date(invoice.due_date).getTime();
    const deltaDays = Math.round((due - created) / 86_400_000);
    expect(deltaDays).toBe(15);
    await assertInvoiceReconciles(api, invoice.id, 'CUST-08');
    flagKnownBug(test.info(), {
      id: 'CUST-08', spec: '§3',
      current: 'invoice due_date computed from legacy customer.payment_type via calculateDueDate; billing_terms stored/echoed but never read',
      expected: 'billing_terms drives invoice due_date',
    });
  });

  test('CUST-09: ad_source persists', async () => {
    const s = api.suffix;
    const c = await api.createCustomer({
      first_name: `S-${s}`, last_name: 'Source', email: `s-${s}@e2e-qa.invalid`, phone: uniquePhone(),
      kind: 'PERSON', segment: 'RESIDENTIAL', ad_source: 'Google',
    });
    expect((await api.getCustomer(c.id)).ad_source).toBe('Google');
  });

  test('CUST-10: tax_exempt true persists (0-tax effect covered by STD-EXEMPT)', async () => {
    const s = api.suffix;
    const c = await api.createCustomer({
      first_name: `X-${s}`, last_name: 'Exempt', email: `x-${s}@e2e-qa.invalid`, phone: uniquePhone(),
      kind: 'COMPANY', segment: 'COMMERCIAL', company_name: `Gov ${s}`, tax_exempt: true,
    });
    expect((await api.getCustomer(c.id)).tax_exempt).toBe(true);
  });

  test('CUST-11: set parent → member.parent_id set; parenting to a non-top-level customer rejected', async () => {
    const s = api.suffix;
    const parentA = await api.createCustomer({
      first_name: `PA-${s}`, last_name: 'Group', company_name: `Group A ${s}`,
      email: `pa-${s}@e2e-qa.invalid`, phone: uniquePhone(), kind: 'COMPANY', segment: 'COMMERCIAL', is_parent: true,
    });
    const member = await api.createCustomer({
      first_name: `M-${s}`, last_name: 'Member', email: `m-${s}@e2e-qa.invalid`, phone: uniquePhone(),
      kind: 'PERSON', segment: 'RESIDENTIAL',
    });
    // Positive: member joins parentA.
    const setRes = await api.updateCustomerRaw(member.id, { parent_id: parentA.id });
    expect(setRes.res.status()).toBe(200);
    expect((await api.getCustomer(member.id)).parent_id).toBe(parentA.id);

    // Rejection: a customer that is itself a member (member.parent_id !== null) cannot be a parent.
    const someone = await api.createCustomer({
      first_name: `Z-${s}`, last_name: 'Other', email: `z-${s}@e2e-qa.invalid`, phone: uniquePhone(),
      kind: 'PERSON', segment: 'RESIDENTIAL',
    });
    const rejected = await api.updateCustomerRaw(someone.id, { parent_id: member.id });
    expect(rejected.res.status()).toBe(400);
    expect(rejected.body.error).toBe('Parent must be a top-level customer (billing group)');
    flagKnownBug(test.info(), {
      id: 'CUST-11', spec: '§3',
      current: 'parent_id is a single scalar; "second parent" is structurally impossible — rejection tested is parenting to a non-top-level customer',
      expected: 'human to confirm the intended reading of "member in exactly one org / second parent rejected"',
    });
  });

  test('CUST-12: self-parent rejected; bill_to to an unrelated third customer rejected', async () => {
    const s = api.suffix;
    const a = await api.createCustomer({
      first_name: `A-${s}`, last_name: 'Co', company_name: `A Co ${s}`,
      email: `a12-${s}@e2e-qa.invalid`, phone: uniquePhone(), kind: 'COMPANY', segment: 'COMMERCIAL',
    });
    // self-parent → 400
    const selfParent = await api.updateCustomerRaw(a.id, { parent_id: a.id });
    expect(selfParent.res.status()).toBe(400);
    expect(selfParent.body.error).toBe('A customer cannot be its own parent');

    // bill_to=self is ACCEPTED on PATCH (isSelf true) — so to get a 400 we use an UNRELATED
    // third customer as bill_to (not in {self, parent}).
    const stranger = await api.createCustomer({
      first_name: `St-${s}`, last_name: 'Ranger', email: `st-${s}@e2e-qa.invalid`, phone: uniquePhone(),
      kind: 'PERSON', segment: 'RESIDENTIAL',
    });
    const badBillTo = await api.updateCustomerRaw(a.id, { bill_to_customer_id: stranger.id });
    expect(badBillTo.res.status()).toBe(400);
    expect(badBillTo.body.error).toBe('bill_to must be the customer itself or its parent billing group');
  });

  test('CUST-13: bill_to_customer_id persists to self and to parent', async () => {
    const s = api.suffix;
    const parent = await api.createCustomer({
      first_name: `P13-${s}`, last_name: 'Group', company_name: `P13 ${s}`,
      email: `p13-${s}@e2e-qa.invalid`, phone: uniquePhone(), kind: 'COMPANY', segment: 'COMMERCIAL', is_parent: true,
    });
    const member = await api.createCustomer({
      first_name: `M13-${s}`, last_name: 'Member', email: `m13-${s}@e2e-qa.invalid`, phone: uniquePhone(),
      kind: 'PERSON', segment: 'RESIDENTIAL', parent_id: parent.id,
    });
    // bill_to → self
    const toSelf = await api.updateCustomerRaw(member.id, { bill_to_customer_id: member.id });
    expect(toSelf.res.status()).toBe(200);
    expect((await api.getCustomer(member.id)).bill_to_customer_id).toBe(member.id);
    // bill_to → parent
    const toParent = await api.updateCustomerRaw(member.id, { bill_to_customer_id: parent.id });
    expect(toParent.res.status()).toBe(200);
    expect((await api.getCustomer(member.id)).bill_to_customer_id).toBe(parent.id);
  });

  test('CUST-14: re-parent to a different group resets the now-stale bill_to to null', async () => {
    const s = api.suffix;
    const groupA = await api.createCustomer({
      first_name: `GA-${s}`, last_name: 'A', company_name: `GA ${s}`,
      email: `ga-${s}@e2e-qa.invalid`, phone: uniquePhone(), kind: 'COMPANY', segment: 'COMMERCIAL', is_parent: true,
    });
    const groupB = await api.createCustomer({
      first_name: `GB-${s}`, last_name: 'B', company_name: `GB ${s}`,
      email: `gb-${s}@e2e-qa.invalid`, phone: uniquePhone(), kind: 'COMPANY', segment: 'COMMERCIAL', is_parent: true,
    });
    const member = await api.createCustomer({
      first_name: `M14-${s}`, last_name: 'Member', email: `m14-${s}@e2e-qa.invalid`, phone: uniquePhone(),
      kind: 'PERSON', segment: 'RESIDENTIAL', parent_id: groupA.id, bill_to_customer_id: groupA.id,
    });
    // Re-parent to B WITHOUT restating bill_to → stale A bill_to is reset to null.
    const reparent = await api.updateCustomerRaw(member.id, { parent_id: groupB.id });
    expect(reparent.res.status()).toBe(200);
    const after = await api.getCustomer(member.id);
    expect(after.parent_id).toBe(groupB.id);
    expect(after.bill_to_customer_id).toBeNull();
    // Clearing parent entirely also nulls bill_to.
    await api.updateCustomerRaw(member.id, { bill_to_customer_id: groupB.id });
    const cleared = await api.updateCustomerRaw(member.id, { parent_id: null });
    expect(cleared.res.status()).toBe(200);
    expect((await api.getCustomer(member.id)).bill_to_customer_id).toBeNull();
  });

  test('CUST-15: group statement rolls up a member invoice (bill_to=parent); billing-address rendering is a PDF concern', async () => {
    const s = api.suffix;
    const org = await api.createCustomer({
      first_name: `Org-${s}`, last_name: 'Parent', company_name: `Org ${s}`,
      email: `org-${s}@e2e-qa.invalid`, phone: uniquePhone(), kind: 'COMPANY', segment: 'COMMERCIAL', is_parent: true,
      billing_address_line1: '1 Org Plaza', billing_city: 'Boston', billing_state: 'MA', billing_zip: '02108',
    });
    const member = await api.createCustomer({
      first_name: `M15-${s}`, last_name: 'Member', email: `m15-${s}@e2e-qa.invalid`, phone: uniquePhone(),
      kind: 'COMPANY', segment: 'COMMERCIAL', company_name: `Member Co ${s}`,
      parent_id: org.id, bill_to_customer_id: org.id,
    });
    const loc = await api.addLocation(member.id, {
      address_line1: '30 Member Way', city: 'Boston', state: 'MA', zip: '02108', is_primary: true,
    });
    // Seed an invoice on the MEMBER, then read the ORG/group statement.
    const { invoice } = await chainToCreatedInvoice(api, member.id, loc.id, [
      { description: 'Service', quantity: 1, unit_price: 500, is_taxable: true },
    ]);
    await assertInvoiceReconciles(api, invoice.id, 'CUST-15');

    const { res, body } = await api.getCustomerStatement(org.id);
    expect(res.status()).toBe(200);
    expect(body.scope).toBe('customer');
    // Member rolls up into the group statement (members[] includes the member; lines include the invoice).
    const memberIds = (body.members ?? []).map((m: any) => m.id);
    expect(memberIds).toContain(member.id);
    expect((body.lines ?? []).length).toBeGreaterThan(0);
    // The statement JSON carries NO billing ADDRESS — only names/email — so "billing party = org
    // address" is a render/PDF concern, not assertable here.
    expect(body.customer.billing_address_line1).toBeUndefined();
    flagKnownBug(test.info(), {
      id: 'CUST-15', spec: '§9',
      current: 'group statement rolls up member invoices but the statement JSON exposes no billing ADDRESS (names/email only); deposit invoice customer_id is the lead customer, not re-resolved through bill_to',
      expected: 'billing party / address on the statement & invoice equals the org (parent) — verify in the PDF/UI tier',
    });
  });

  test('CUST-16: archive hides from default list; visible via include_archived + direct GET; unarchive restores', async () => {
    const s = api.suffix;
    const c = await api.createCustomer({
      first_name: `Ar-${s}`, last_name: 'Chive', email: `ar-${s}@e2e-qa.invalid`, phone: uniquePhone(),
      kind: 'PERSON', segment: 'RESIDENTIAL',
    });
    const arch = await api.archiveCustomer(c.id);
    expect(arch.res.status()).toBe(200);
    expect(arch.body.customer.is_active).toBe(false);
    expect(arch.body.customer.archived_at).toBeTruthy();

    // Default list (no params) hides the archived id. Use a high limit to scan our seeded id.
    const def = await api.raw('get', '/api/customers?limit=200');
    const defIds = (def.body.customers ?? []).map((x: any) => x.id);
    expect(defIds).not.toContain(c.id);

    // include_archived=true surfaces it. Search by our unique email guarantees a small page.
    const inc = await api.raw('get', `/api/customers?include_archived=true&search=ar-${s}@e2e-qa.invalid`);
    const incIds = (inc.body.customers ?? []).map((x: any) => x.id);
    expect(incIds).toContain(c.id);

    // Direct GET still works (no is_active filter on getById).
    expect((await api.getCustomer(c.id)).id).toBe(c.id);

    // Unarchive restores active state + reappears in default list.
    const un = await api.unarchiveCustomer(c.id);
    expect(un.res.status()).toBe(200);
    expect(un.body.customer.is_active).toBe(true);
    expect(un.body.customer.archived_at).toBeNull();
    const def2 = await api.raw('get', '/api/customers?limit=200');
    expect((def2.body.customers ?? []).map((x: any) => x.id)).toContain(c.id);
  });

  test('CUST-17: force-purge a no-payment subtree — clean cascade, GET → 404', async () => {
    const s = api.suffix;
    const c = await api.createCustomer({
      first_name: `Pu-${s}`, last_name: 'Rge', email: `pu-${s}@e2e-qa.invalid`, phone: uniquePhone(),
      kind: 'PERSON', segment: 'RESIDENTIAL',
    });
    const full = await api.getCustomer(c.id);
    // confirm MUST equal customer_number (not the id).
    const purged = await api.purgeCustomer(c.id, { confirm: full.customer_number });
    expect(purged.res.status()).toBe(200);
    expect(purged.body.purged).toBe(true);
    expect(purged.body.warning).toBeUndefined(); // no payment → no money warning
    const gone = await api.raw('get', `/api/customers/${c.id}`);
    expect(gone.res.status()).toBe(404);
  });

  test('CUST-18: force-purge with payment — no money gate; wrong confirm 400; correct confirm purges + surfaces warning', async () => {
    const s = api.suffix;
    const c = await api.createCustomer({
      first_name: `Pd-${s}`, last_name: 'Paid', email: `pd-${s}@e2e-qa.invalid`, phone: uniquePhone(),
      kind: 'COMPANY', segment: 'COMMERCIAL', company_name: `Paid Co ${s}`,
    });
    const loc = await api.addLocation(c.id, {
      address_line1: '40 Pay St', city: 'Boston', state: 'MA', zip: '02108', is_primary: true,
    });
    const { invoice } = await chainToCreatedInvoice(api, c.id, loc.id, [
      { description: 'Service', quantity: 1, unit_price: 1000, is_taxable: true },
    ]);
    await api.sendInvoice(invoice.id);
    const fresh = await api.getInvoice(invoice.id);
    const pay = await api.recordPayment(invoice.id, { amount: Number(fresh.amount_due), method: 'CARD' });
    expect(pay.res.status()).toBeLessThan(300);
    await assertInvoiceReconciles(api, invoice.id, 'CUST-18');
    // Tag the payment with a Stripe PI so has_stripe_charge surfaces in the purge warning.
    await api.seedPaymentIntent(invoice.id, `pi_cust18_${s}`);

    const full = await api.getCustomer(c.id);
    // The ONLY 4xx blockers are a wrong confirm string and existing members — NOT a money gate.
    const wrong = await api.purgeCustomer(c.id, { confirm: 'NOPE' });
    expect(wrong.res.status()).toBe(400);

    const ok = await api.purgeCustomer(c.id, { confirm: full.customer_number });
    expect(ok.res.status()).toBe(200);
    expect(ok.body.purged).toBe(true);
    // Money surfaced (not blocked): warning + payment_total present, Stripe PI → has_stripe_charge.
    expect(ok.body.warning).toBeTruthy();
    expect(Number(ok.body.payment_total)).toBeGreaterThan(0);
    expect(ok.body.has_stripe_charge).toBe(true);
    const gone = await api.raw('get', `/api/customers/${c.id}`);
    expect(gone.res.status()).toBe(404);
  });

  test('CUST-19: purge a billing-group parent blocked while members exist', async () => {
    const s = api.suffix;
    const parent = await api.createCustomer({
      first_name: `GrP-${s}`, last_name: 'Parent', company_name: `Grp ${s}`,
      email: `grp-${s}@e2e-qa.invalid`, phone: uniquePhone(), kind: 'COMPANY', segment: 'COMMERCIAL', is_parent: true,
    });
    await api.createCustomer({
      first_name: `GrM-${s}`, last_name: 'Member', email: `grm-${s}@e2e-qa.invalid`, phone: uniquePhone(),
      kind: 'PERSON', segment: 'RESIDENTIAL', parent_id: parent.id,
    });
    const full = await api.getCustomer(parent.id);
    // Send the CORRECT confirm so the 400 proves the MEMBER gate (not the confirm gate).
    const blocked = await api.purgeCustomer(parent.id, { confirm: full.customer_number });
    expect(blocked.res.status()).toBe(400);
    expect(blocked.body.error).toBe('Cannot purge a billing group with members — detach members first');
  });

  test('CUST-20: anonymize is a 501 deferred stub; PII unchanged (known limitation §10)', async () => {
    const s = api.suffix;
    const c = await api.createCustomer({
      first_name: `An-${s}`, last_name: 'Onymous', email: `an-${s}@e2e-qa.invalid`, phone: uniquePhone(),
      kind: 'PERSON', segment: 'RESIDENTIAL',
    });
    const resp = await api.anonymizeCustomer(c.id);
    expect(resp.res.status()).toBe(501);
    expect(resp.body.deferred).toBe(true);
    expect(resp.body.error).toBe('Not Implemented');
    // PII untouched.
    const after = await api.getCustomer(c.id);
    expect(after.first_name).toBe(`An-${s}`);
    expect(after.last_name).toBe('Onymous');
    expect(after.email).toBe(`an-${s}@e2e-qa.invalid`);
    flagKnownBug(test.info(), {
      id: 'CUST-20', spec: '§10',
      current: 'anonymize returns 501 stub; customer row is not mutated',
      expected: 'PII scrubbed to tombstone',
    });
  });
});
