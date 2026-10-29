import { test, expect } from '@playwright/test';
import { ApiClient } from '../../helpers/api-client';
import { createMaCustomerWithLocation, leadToSentEstimate, uniquePhone } from '../../helpers/workflow-builders';

/**
 * redesign-29 — entry-point creation contracts (catalog rows DLV-26, DLV-27a/b, DLV-28,
 * COL-24, INT-32, INT-33, INT-34, SEL-37).
 *
 * WRITTEN 2026-06-10, NOT YET EXECUTED — first baseline run validates every prediction.
 *
 * Origin: the 2026-06-10 entry-point mapping enumerated every way lifecycle entities come
 * into existence and found these creation contracts untested. Each assert below is a
 * STATIC PREDICTION grounded in controller/schema code read from the working tree.
 *
 * Cheat-sheet of code-verified contract facts (file:line, re-verified 2026-06-10):
 *  - job.controller.ts createJobSchema :146-164 — estimate_id/customer_id/
 *    service_location_id all optional; the superRefine (:154-163) requires
 *    customer+location ONLY when estimate_id is absent. NOTHING rejects
 *    estimate_id + customer_id together (DLV-26).
 *  - job.controller.ts create() :379-548 —
 *      STANDALONE branch: customer tenant-miss :385-389 → 404 'Customer not found';
 *      ownership-scoped location findFirst :391-398 → 404 'Service location not found or
 *      does not belong to customer' (DLV-28).
 *      ESTIMATE branch: customer resolved from estimate.lead.customer_id :482, written
 *      :511 — the body customer_id is NEVER read on this branch (DLV-26); location
 *      precedence :496 = body service_location_id || lead anchor || customer primary,
 *      with NO ownership/existence check on the body value (the standalone branch
 *      validates :391-398, the estimate branch does not — DLV-27); P2002 → 409
 *      'A job already exists for this estimate' :537-539; catch-all → 500
 *      'Failed to create job' :544-547 (the surface DLV-27b's P2003 dies on).
 *  - lead.controller.ts createLeadSchema :188-199 — customer_id XOR new_customer;
 *    new_location (:179, locationSchema :153-159) is the MODERN inline-location key
 *    (precedence: service_location_id > new_location > legacy service_address_*).
 *    create() existing-customer branch :643-646 — tenant-scoped customer miss → 400
 *    'Customer not found' (a **400**, unlike the job path's 404 for the identical
 *    condition — INT-32a/INT-33 pin the asymmetry). resolveOrAccreteLocation wired at
 *    :662-670; LocationResolutionError → 400 :688-691.
 *  - lib/service-location.ts resolveOrAccreteLocation :72-140 — explicit id validated
 *    against the customer :77-90; address path normalizes (normalizeLine1 :47-49 =
 *    trim+lowercase+collapse-spaces; normalizeZip :52-54 = digits only) then
 *    find-or-creates :92-137. The SQL narrowing :101-109 is insensitive `contains` on
 *    the TRIMMED raw line1 + a zip-prefix, then the exact normalized confirm :111-122 —
 *    so only case/padding line1 variants dedupe end-to-end (internal-whitespace variants
 *    pass normalizeLine1 but MISS the narrowing and would accrete a duplicate; zip+4
 *    variants fail normalizeZip equality). Accreted rows get is_primary:false :132.
 *  - lead.controller.ts leadDetailSelect :82-149 — does NOT expose the lead's
 *    service_location_id (only legacy service_address_* + customer.service_locations),
 *    so INT-34 proves accrete/dedupe on the customer's location set, not on the lead row.
 *  - estimate.controller.ts createEstimateSchema :236-244 — NO customer_id key; create()
 *    :646-763 destructures lead_id only; lead tenant-miss :654-658 → 404 'Lead not found'
 *    (INT-32c); create is NOT walkthrough-gated (D8/D9, PR-B2 removed that guard
 *    entirely) so SEL-37 creates straight from a NEW lead with no setup beyond it.
 *    estimateDetailSelect carries lead_id :43 + lead.customer.id :69-104 (the SEL-37
 *    linkage shape) + the 1:1 job backrelation :127-129 (the DLV-27b rollback probe).
 *  - invoice.controller.ts createInvoiceSchema :32-34 = {job_id} ONLY; create() :306-511
 *    destructures job_id alone and never sets kind/estimate_id in the create data
 *    :437-457; job tenant-miss :311-324 → 404 'Job not found' (INT-32d).
 *    invoiceDetailSelect exposes kind :112 + estimate_id :113 → COL-24 asserts
 *    estimate_id === null (selected and unset), not undefined.
 *  - middleware/validate.ts :7 — req.body = schema.parse(req.body); bare z.object STRIPS
 *    unknown keys. All four creates are wrapped: lead.routes.ts:19, invoice.routes.ts:20,
 *    job.routes.ts:21, estimate.routes.ts:27.
 *  - schema.prisma — Job.estimate_id @unique :396 (ONE job per estimate ⇒ DLV-26/27a/27b
 *    each seed their own approved estimate); Job.service_location relation :426 (the
 *    DLV-27b FK); Invoice.kind @default(STANDARD) :476 + estimate_id nullable :477;
 *    ServiceLocation :206-225 has NO organization_id column — org reach is only via the
 *    customer relation (the DLV-27 cross-org implication).
 *  - customer.controller.ts getById :486-497 — returns ALL service_locations
 *    (locationSelect :56-67: id/address_line1/…/is_primary) + _count {leads, jobs}
 *    (relation counts, NO org filter — they catch a row mis-written in ANY org).
 *
 * Conventions: serial (workers:1, data accumulates); unique api.suffix data;
 * @e2e-qa.invalid emails; uniquePhone() per customer (the duplicate guard matches
 * org-wide); presence/delta asserts only; exact error strings only where verified above;
 * probes carry flip instructions.
 */
let api: ApiClient; // org A — the run org: all seeding + describe-1 probes
test.beforeAll(async () => { api = await new ApiClient().init(); });
test.afterAll(async () => { await api?.dispose(); });

/**
 * Approved (no-deposit) estimate — redesign-22's adminApprovedEstimate pattern.
 * deposit:false ⇒ the public approve lands WON immediately and the job-create
 * deposit gate (job.controller.ts:468-479) has nothing to gate. Returns the builder ctx
 * (customerId = the estimate's lead customer, locationId = the lead's anchored location).
 */
async function approvedEstimateNoDeposit(client: ApiClient) {
  const ctx = await leadToSentEstimate(client); // deposit:false by default
  const approved = await client.approveEstimatePublic(ctx.estimateId, ctx.publicToken, {
    signature_data: client.testSignature,
  });
  expect(approved.res.status(), 'seed: public approval').toBe(200);
  return ctx;
}

/** Mirrors lib/service-location.ts normalizeLine1 (:47-49) for the INT-34 dedupe assert. */
function normLine1(line1: string): string {
  return line1.trim().toLowerCase().replace(/\s+/g, ' ');
}

test.describe('redesign-29 entry-points — creation contracts', () => {
  // ─── DLV-26 (P0): both estimate_id AND customer_id — estimate branch silently wins ──
  test('DLV-26: job create with BOTH estimate_id AND customer_id → 201 anchored to the estimate lead customer (body customer ignored)', async () => {
    test.setTimeout(120_000); // full approved-estimate chain on a possibly-cold backend
    const s = api.suffix;
    const ctx = await approvedEstimateNoDeposit(api);
    // Second, unrelated same-org customer — the body value the branch must ignore.
    const other = await api.createCustomer({
      first_name: `Dlv26-${s}`, last_name: 'Bystander',
      email: `dlv26-${s}@e2e-qa.invalid`, phone: uniquePhone(),
    });
    expect(other?.id, 'seed: bystander customer').toBeTruthy();

    // superRefine fires only when estimate_id is ABSENT (:154-163), so both keys pass
    // validation; create() branches on estimate_id (:383) and resolves the customer from
    // estimate.lead.customer_id (:482/:511) — the body customer_id is never read.
    // CONTRACT NOTE: a 400 ('provide estimate_id OR customer_id, not both') is arguably
    // the better contract — this pins TODAY'S silent-winner behavior; if a refinement
    // ever lands, this 201 flips to that 400.
    const { res, body } = await api.raw('post', '/api/jobs', {
      estimate_id: ctx.estimateId,
      customer_id: other.id,
    });
    expect(res.status()).toBe(201);
    // jobDetailSelect exposes the customer as a relation (customer.id), not a scalar FK.
    expect(body.job.customer.id, 'estimate branch wins: job belongs to the lead customer').toBe(ctx.customerId);
    expect(body.job.customer.id).not.toBe(other.id);
    expect(body.job.estimate.id).toBe(ctx.estimateId);
  });

  // ─── COL-24 (P2): invoice kind is not client-settable ───────────────────────────────
  test('COL-24: invoice create strips client kind/estimate_id → 201 kind=STANDARD with estimate_id null', async () => {
    test.setTimeout(120_000); // approved-estimate chain + job + invoice
    const ctx = await approvedEstimateNoDeposit(api);
    const { res: jobRes, body: jobBody } = await api.createJob({ estimate_id: ctx.estimateId });
    expect(jobRes.status(), 'seed: job from estimate').toBe(201);
    const jobId = jobBody.job.id as string;

    // createInvoiceSchema = {job_id} only (:32-34); validate() (:7) strips kind +
    // estimate_id before the controller, and create() never sets either (:437-457) →
    // Prisma defaults kind=STANDARD (schema.prisma:476) and estimate_id stays null
    // (:477) even though this job DID come from an estimate — standard invoices reach
    // the estimate via job→estimate; invoice.estimate_id is the kind=DEPOSIT anchor.
    const { res, body } = await api.raw('post', '/api/invoices', {
      job_id: jobId,
      kind: 'DEPOSIT',           // stripped
      estimate_id: ctx.estimateId, // stripped
    });
    expect(res.status()).toBe(201);
    expect(body.invoice.kind).toBe('STANDARD');
    // estimate_id IS selected by invoiceDetailSelect (:113) → present and null.
    expect(body.invoice.estimate_id).toBeNull();
    expect(body.invoice.job?.id).toBe(jobId);
  });

  // ─── INT-33 (P2): lead-create FK-miss contract is 400, not 404 ──────────────────────
  test('INT-33: lead create with a well-formed nonexistent customer_id → 400 Customer not found (not 404)', async () => {
    // lead.controller.ts:643-646 returns **400** for the tenant-scoped customer miss,
    // while job.controller.ts:385-389 returns **404** for the identical condition
    // (DLV-28a below — the contrast pair). Pinned deliberately: if product later
    // normalizes the lead path to 404, this assert is the tripwire (update catalog
    // INT-33 + INT-32a together when it flips).
    const { res, body } = await api.raw('post', '/api/leads', {
      customer_id: crypto.randomUUID(),
      service_request: `INT-33 ghost customer ${api.suffix}`,
    });
    expect(res.status()).toBe(400);
    expect(body.error).toBe('Customer not found');
    expect(body.lead).toBeUndefined();
  });

  // ─── INT-34 (P1): location accrete + dedupe at lead-CREATE time ─────────────────────
  test('INT-34: lead-create new_location accretes one non-primary location, then dedupes a normalize-equal re-send', async () => {
    const s = api.suffix;
    const { customerId, locationId: primaryId } = await createMaCustomerWithLocation(api);
    const addr = `55 Accrete Way ${s}`; // unique per run; stored RAW (service-location.ts:127)

    const before = await api.getCustomer(customerId);
    const countBefore = (before.service_locations as any[]).length;

    // Create #1: new_location, no service_location_id → the address path of
    // resolveOrAccreteLocation accretes a fresh ServiceLocation and anchors the lead to
    // it. The anchor column itself is NOT exposed by leadDetailSelect (:82-149), so
    // accretion/dedupe is proven on the customer's location set — count-deltas on that
    // list are sound here because THIS SPEC OWNS the customer (fresh builder seed; no
    // other test touches it).
    const lead1 = await api.createLead({
      customer_id: customerId,
      service_request: `INT-34 accrete ${s}`,
      new_location: { address_line1: addr, city: 'Boston', state: 'MA', zip: '02108' },
    });
    expect(lead1.res.status(), 'create #1 (accrete)').toBe(201);

    const rows1: any[] = (await api.getCustomer(customerId)).service_locations;
    expect(rows1.length, 'accretion adds exactly one location').toBe(countBefore + 1);
    const accreted = rows1.find((r) => r.address_line1 === addr);
    expect(accreted, 'accreted row exists, raw address preserved').toBeTruthy();
    expect(accreted.is_primary, 'accreted rows are never primary (service-location.ts:132)').toBe(false);
    expect(accreted.id).not.toBe(primaryId);

    // Create #2: normalize-EQUAL variant — UPPERCASED + leading/trailing padding, zip
    // identical. Chosen to satisfy BOTH dedupe stages (service-location.ts): the SQL
    // narrowing (:101-109, insensitive `contains` on the TRIMMED line1 + zip prefix) AND
    // the exact normalized confirm (:111-122). Do NOT "strengthen" this with an
    // internal-whitespace or zip+4 variant: those pass/fail the two stages differently
    // and accrete a duplicate today (a separate, unpinned hole).
    const lead2 = await api.createLead({
      customer_id: customerId,
      service_request: `INT-34 dedupe ${s}`,
      new_location: { address_line1: `  ${addr.toUpperCase()}  `, city: 'Boston', state: 'MA', zip: '02108' },
    });
    expect(lead2.res.status(), 'create #2 (dedupe)').toBe(201);

    const rows2: any[] = (await api.getCustomer(customerId)).service_locations;
    expect(rows2.length, 'dedupe: location count delta is 0 on the second create').toBe(rows1.length);
    const matches = rows2.filter((r) => normLine1(r.address_line1) === normLine1(addr));
    expect(matches.length, 'exactly one normalize-equal row — the resolver reused it').toBe(1);
    expect(matches[0].id).toBe(accreted.id);
  });

  // ─── DLV-28 (P2): standalone-job 404 pair (legacy UJ-02/03 ported to the active tier) ──
  test('DLV-28: standalone job create 404 pair — ghost customer_id; real customer with a foreign-customer location', async () => {
    const a = await createMaCustomerWithLocation(api);
    const b = await createMaCustomerWithLocation(api);

    // (a) Well-formed ghost customer_id → the customer tenant-lookup misses FIRST
    // (job.controller.ts:385-389); the location value is never evaluated.
    const ghost = await api.raw('post', '/api/jobs', {
      customer_id: crypto.randomUUID(),
      service_location_id: a.locationId,
    });
    expect(ghost.res.status()).toBe(404);
    expect(ghost.body.error).toBe('Customer not found');

    // (b) Real customer A + customer B's location (same org) → the ownership-scoped
    // findFirst (:391-398) misses. This is exactly the validation the ESTIMATE branch
    // lacks — DLV-27a in the next describe is the contrast probe.
    const foreign = await api.raw('post', '/api/jobs', {
      customer_id: a.customerId,
      service_location_id: b.locationId,
    });
    expect(foreign.res.status()).toBe(404);
    expect(foreign.body.error).toBe('Service location not found or does not belong to customer');
    expect(foreign.body.job).toBeUndefined();
  });

  // ─── SEL-37 (P2): estimate create strips customer_id ────────────────────────────────
  test('SEL-37: estimate create strips customer_id → 201 linked to the lead customer, decoy never enters the graph', async () => {
    const s = api.suffix;
    const { customerId: custA, locationId: locA } = await createMaCustomerWithLocation(api);
    const { res: leadRes, body: leadBody } = await api.createLead({
      customer_id: custA,
      service_request: `SEL-37 ${s}`,
      service_location_id: locA,
    });
    expect(leadRes.status(), 'seed: lead for customer A').toBe(201);
    const leadId = leadBody.lead.id as string;
    // D8/D9 (PR-B2) removed the walkthrough gate on estimate create entirely, so the
    // create below needs no walkthrough setup - it succeeds straight from NEW.

    const custB = await api.createCustomer({
      first_name: `Sel37-${s}`, last_name: 'Decoy',
      email: `sel37-${s}@e2e-qa.invalid`, phone: uniquePhone(),
    });
    expect(custB?.id, 'seed: decoy customer B').toBeTruthy();

    // createEstimateSchema (:236-244) has no customer_id key → validate() strips it; the
    // controller reaches a customer ONLY via estimate → lead → customer (:652-653).
    const { res, body } = await api.raw('post', '/api/estimates', {
      lead_id: leadId,
      customer_id: custB.id, // stripped
      line_items: [{ description: 'SEL-37 service', quantity: 1, unit_price: 250, is_taxable: true }],
    });
    expect(res.status()).toBe(201);
    expect(body.estimate.lead_id).toBe(leadId);
    // estimateDetailSelect exposes the linkage as lead.customer (:69-104) — the real
    // response shape: the estimate resolves to customer A; the decoy is nowhere.
    expect(body.estimate.lead.customer.id).toBe(custA);
    expect(body.estimate.lead.customer.id).not.toBe(custB.id);
  });
});

test.describe('redesign-29 entry-points — cross-org creates + unvalidated overrides', () => {
  let apiB: ApiClient; // org B — the hostile creator (INT-32 only; DLV-27 stays in org A)
  let orgB: { organizationId: string; adminEmail: string; adminPassword: string };

  test.beforeAll(async () => {
    test.setTimeout(120_000);
    // SECOND-ORG DOOR (redesign-24 pattern): POST /api/test/provision-org
    // (E2E_TEST_DOORS-gated, no body) mints a FRESH org + confirmed admin per call.
    // Deliberately NO door teardown for org B — teardown's Auth sweep is full-domain
    // and would delete the run org's admin mid-suite (see redesign-24's header).
    // Residue accepted as in redesign-24: org B's Auth user is swept at end of run by
    // global-teardown; its Prisma rows (1 Organization + 1 User + grants, ZERO business
    // rows — every create probe here refuses pre-write) linger name-tagged.
    const prov = await api.raw('post', '/api/test/provision-org');
    expect(prov.res.status(), 'provision-org for org B').toBe(200);
    orgB = prov.body;
    apiB = await new ApiClient().init({ email: orgB.adminEmail, password: orgB.adminPassword });
  });
  test.afterAll(async () => { await apiB?.dispose(); });

  // ─── INT-32 (P1): cross-org FK probes on CREATE paths (extends X-01's reads/mutations) ──
  test('INT-32: cross-org FKs on creates — lead 400, job/estimate/invoice 404, nothing written against org A', async () => {
    test.setTimeout(120_000);
    const s = api.suffix;
    // Org A seed: fresh customer+location, one lead, one standalone job — the foreign FK
    // targets. (No estimate/invoice seed needed: the probes attack the PARENT ids.)
    const { customerId, locationId } = await createMaCustomerWithLocation(api);
    const { res: leadRes, body: leadBody } = await api.createLead({
      customer_id: customerId, service_request: `INT-32 seed ${s}`, service_location_id: locationId,
    });
    expect(leadRes.status(), 'seed: org A lead').toBe(201);
    const leadId = leadBody.lead.id as string;
    const { res: jobRes, body: jobBody } = await api.createJob({
      customer_id: customerId, service_location_id: locationId,
    });
    expect(jobRes.status(), 'seed: org A standalone job').toBe(201);
    const jobId = jobBody.job.id as string;

    // Baseline for the delta-0 absence asserts. customer._count {leads, jobs} are
    // relation counts with NO org filter (customer.controller.ts:497), so they would
    // catch a row mis-written in EITHER org that anchors to org A's customer.
    const beforeCounts = (await api.getCustomer(customerId))._count;
    expect(beforeCounts, 'seed sanity: exactly the seeded lead + job').toEqual({ leads: 1, jobs: 1 });

    // (a) Lead create as B with org A's customer → 400 'Customer not found'
    // (lead.controller.ts:643-646 — the lead path's 400, NOT a 404; see INT-33).
    const leadProbe = await apiB.raw('post', '/api/leads', {
      customer_id: customerId, service_request: `INT-32 breach ${s}`,
    });
    expect(leadProbe.res.status()).toBe(400);
    expect(leadProbe.body.error).toBe('Customer not found');
    expect(leadProbe.body.lead).toBeUndefined();

    // (b) Standalone job create as B with org A's customer+location → the customer
    // tenant-miss fires before the location check → 404 (job.controller.ts:385-389).
    const jobProbe = await apiB.raw('post', '/api/jobs', {
      customer_id: customerId, service_location_id: locationId,
    });
    expect(jobProbe.res.status()).toBe(404);
    expect(jobProbe.body.error).toBe('Customer not found');
    expect(jobProbe.body.job).toBeUndefined();

    // (c) Estimate create as B with org A's lead → 404 'Lead not found'
    // (estimate.controller.ts:654-658).
    const estProbe = await apiB.createEstimate({
      lead_id: leadId,
      line_items: [{ description: 'INT-32 breach line', quantity: 1, unit_price: 100, is_taxable: true }],
    });
    expect(estProbe.res.status()).toBe(404);
    expect(estProbe.body.error).toBe('Lead not found');

    // (d) Invoice create as B with org A's job → 404 'Job not found'
    // (invoice.controller.ts:311-324).
    const invProbe = await apiB.createInvoice(jobId);
    expect(invProbe.res.status()).toBe(404);
    expect(invProbe.body.error).toBe('Job not found');

    // Absence, read as org A. All three reads are relation-based with no org filter, so
    // a row mis-written into EITHER org would surface here:
    //  - _count delta 0 → no lead/job landed against org A's customer;
    //  - lead.estimates still empty → no estimate landed against org A's lead;
    //  - job.invoices still empty → no invoice landed against org A's job.
    expect((await api.getCustomer(customerId))._count).toEqual(beforeCounts);
    expect((await api.getLead(leadId)).estimates).toEqual([]);
    expect((await api.getJob(jobId)).invoices).toEqual([]);

    // Positive control: org B's session is real and DIFFERENT — the 4xx above are
    // tenancy refusals, not a broken login.
    const me = await apiB.raw('get', '/api/auth/me');
    expect(me.res.status()).toBe(200);
    expect(me.body.user.organization_id).toBe(orgB.organizationId);
  });

  // ─── DLV-27a (P0 — fixed by #180): estimate-branch location override now ownership-checked ──
  // The ESTIMATE branch fed the body service_location_id straight into the create with NO
  // ownership check — any same-org customer's location could be grafted onto the job. Fix #180
  // added the same pre-transaction ownership guard the standalone branch already had
  // (job.controller.ts:514), so a foreign-customer location now 404s.
  test('DLV-27a: estimate-branch service_location_id override is ownership-checked → 404 (#180)', async () => {
    test.setTimeout(120_000);
    const ctx = await approvedEstimateNoDeposit(api); // customer A + the lead's anchored location
    const b = await createMaCustomerWithLocation(api); // customer B, same org — the foreign location

    // FIXED #180: ownership validation now runs on the estimate branch before the write.
    const { res, body } = await api.raw('post', '/api/jobs', {
      estimate_id: ctx.estimateId,
      service_location_id: b.locationId,
    });
    expect(res.status()).toBe(404);
    expect(body.error).toBe('Service location not found or does not belong to customer');
  });

  // ─── DLV-27b (P0 — fixed by #180): nonexistent location id now validated before the write ──
  test('DLV-27b: estimate-branch nonexistent service_location_id → 404, nothing persisted (#180)', async () => {
    test.setTimeout(120_000);
    const ctx = await approvedEstimateNoDeposit(api);

    // FIXED #180: existence/ownership check runs before the transaction, so a ghost uuid 404s
    // instead of reaching the INSERT and dying as a Prisma P2003 → 500.
    const { res, body } = await api.raw('post', '/api/jobs', {
      estimate_id: ctx.estimateId,
      service_location_id: crypto.randomUUID(),
    });
    expect(res.status()).toBe(404);
    expect(body.error).toBe('Service location not found or does not belong to customer');

    // The guard aborted before the write: the estimate still has no job, so it remains consumable.
    expect((await api.getEstimate(ctx.estimateId)).job).toBeNull();
  });
});
