import { test, expect } from '@playwright/test';
import * as crypto from 'crypto';
import { ApiClient } from '../../helpers/api-client';
import {
  maEstimateSentWithDeposit,
  createMaCustomerWithLocation,
  createSalesUser,
  uniquePhone,
} from '../../helpers/workflow-builders';
import { assertInvoiceReconciles } from '../../helpers/reconcile';
import { flagKnownBug } from '../../helpers/known-bug';

/**
 * Stage 4 — Estimate (Task C4, rows EST-01..EST-13).
 *
 * ONE shared provisioned org, serial. Data accumulates — every seeded entity is unique
 * (api.suffix / random uuid), and no test asserts an absolute list/stat count.
 *
 * Per the harness contract + estimate-deposit facts (FACTS WIN where they disagree with
 * the plan):
 *  - Estimate creation is gated on a COMPLETED WALKTHROUGH (the maEstimate builder handles it;
 *    the hand-built helper below does contact→schedule(SALES performer)→complete).
 *  - The send schema does NOT accept deposit_percentage; the % is the org AppSetting
 *    'deposit_percentage' and applies to the TAX-INCLUSIVE total. maEstimateSentWithDeposit
 *    pins that AppSetting.
 *  - EST-02 needs a WELL-FORMED random uuid (a malformed string is a Zod 400, not 404).
 *  - EST-04 MA tax derives to the fraction 0.0625 and is snapshotted onto the row at create
 *    (send never re-derives it).
 *  - EST-12 is a 500-by-design today (P2002 on the partial-unique WON index; tx rolls
 *    back so the "exactly one WON" invariant holds) → flagged.
 */
let api: ApiClient;
test.beforeAll(async () => { api = await new ApiClient().init(); });
test.afterAll(async () => { await api.dispose(); });

/**
 * Hand-build a lead through a completed walkthrough so a DRAFT estimate can be created on it.
 * Mirrors the builder's gate (contact → schedule with a SALES performer → complete) but lets
 * a test own the lead id (needed for the two-estimates-on-one-lead rows and cross-lead tax).
 * `state` controls the service-location state (and thus the derived tax).
 */
async function leadReadyForEstimate(
  state: 'MA' | 'NH' = 'MA',
): Promise<{ leadId: string; customerId: string; locationId: string }> {
  const s = api.suffix;
  const customer = await api.createCustomer({
    first_name: `${state}-${s}`, last_name: 'Customer',
    email: `est-${state.toLowerCase()}-${s}@e2e-qa.invalid`, phone: uniquePhone(), // 2026-06-10: dup-guard fix (was fixed '6175550000' — 409 on 2nd call per org)
  });
  const cityZip = state === 'MA'
    ? { city: 'Boston', zip: '02108' }
    : { city: 'Concord', zip: '03301' };
  const location = await api.addLocation(customer.id, {
    address_line1: `${Math.floor(Math.random() * 9999)} Main St`,
    city: cityZip.city, state, zip: cityZip.zip, is_primary: true,
  });
  const { body: leadBody } = await api.createLead({
    customer_id: customer.id,
    service_request: `est-stage-${s}`,
    service_location_id: location.id,
  });
  const leadId = leadBody.lead.id;
  await api.contactLead(leadId);
  const performerId = await createSalesUser(api);
  await api.scheduleWalkthrough(leadId, {
    walkthrough_scheduled_at: api.futureDate(24),
    performer_ids: [performerId],
  });
  await api.completeWalkthrough(leadId);
  return { leadId, customerId: customer.id, locationId: location.id };
}

const VALID_LINE = { description: 'x', quantity: 1, unit_price: 1000, is_taxable: true };

test.describe('Stage 4 — Estimate (EST-01..EST-13)', () => {
  // ─── EST-01: create requires lead_id (Zod 400, BEFORE any DB read) ──────────────
  test('EST-01: create lead-required — missing/blank lead_id → Zod 400', async () => {
    // No lead needed: validate() middleware rejects before the handler runs.
    // (a) lead_id omitted entirely.
    const omitted = await api.raw('post', '/api/estimates', { line_items: [VALID_LINE] });
    expect(omitted.res.status()).toBe(400);

    // (b) lead_id blank ''. Still fails .uuid().
    const blank = await api.raw('post', '/api/estimates', { lead_id: '', line_items: [VALID_LINE] });
    expect(blank.res.status()).toBe(400);

    // (c) missing line_items → 400 ('At least one line item is required').
    const noLines = await api.raw('post', '/api/estimates', { lead_id: crypto.randomUUID() });
    expect(noLines.res.status()).toBe(400);
  });

  // ─── EST-02: well-formed-but-nonexistent uuid → 404 ('Lead not found') ──────────
  test('EST-02: invalid-uuid (well-formed, non-existent) lead_id → 404', async () => {
    // A WELL-FORMED random uuid passes Zod .uuid(); lead.findUnique → null → 404.
    const ghostLeadId = crypto.randomUUID();
    const { res, body } = await api.createEstimate({ lead_id: ghostLeadId, line_items: [VALID_LINE] });
    expect(res.status()).toBe(404);
    expect(body.error).toBe('Lead not found');

    // Contrast (documented in facts): a MALFORMED uuid is a Zod 400, NOT a 404.
    const malformed = await api.raw('post', '/api/estimates', { lead_id: 'not-a-uuid', line_items: [VALID_LINE] });
    expect(malformed.res.status()).toBe(400);
  });

  // ─── EST-03: line items persist; totals computed ───────────────────────────────
  test('EST-03: line items persist; subtotal/total computed', async () => {
    const { leadId } = await leadReadyForEstimate('MA');
    // Two taxable lines: 2×100 = 200, 3×50 = 150 → subtotal 350.
    const { res, body } = await api.createEstimate({
      lead_id: leadId,
      line_items: [
        { description: 'Labor', quantity: 2, unit_price: 100, is_taxable: true },
        { description: 'Parts', quantity: 3, unit_price: 50, is_taxable: true },
      ],
    });
    expect(res.status()).toBe(201);
    const est = body.estimate;
    expect(est.line_items.length).toBe(2);

    // Each line_total = round(qty*unit_price, 2).
    const byDesc = Object.fromEntries(est.line_items.map((li: any) => [li.description, Number(li.line_total)]));
    expect(byDesc.Labor).toBe(200);
    expect(byDesc.Parts).toBe(150);

    // subtotal = Σ effective line totals; total = subtotal + tax_amount (MA 6.25% on 350).
    expect(Number(est.subtotal)).toBe(350);
    const expectedTax = Math.round(350 * 0.0625 * 100) / 100; // 21.875 → 21.88
    expect(Number(est.tax_amount)).toBeCloseTo(expectedTax, 2);
    expect(Number(est.total_amount)).toBeCloseTo(350 + Number(est.tax_amount), 2);
  });

  // ─── EST-04: tax auto-derived from MA = 0.0625, editable on DRAFT, snapshotted on send ─
  test('EST-04: tax auto-derived (MA=0.0625), editable, snapshotted on send', async () => {
    const { leadId } = await leadReadyForEstimate('MA');

    // (a) Omit tax_rate → derived from MA service-location = 0.0625 (a fraction, not 6.25).
    const { body: createBody } = await api.createEstimate({ lead_id: leadId, line_items: [VALID_LINE] });
    const estId = createBody.estimate.id;
    expect(Number(createBody.estimate.tax_rate)).toBe(0.0625);

    // (b) Editable while DRAFT: PATCH tax_rate 0.05 → recomputes.
    const { res: patchRes, body: patchBody } = await api.updateEstimate(estId, { tax_rate: 0.05 });
    expect(patchRes.status()).toBe(200);
    expect(Number(patchBody.estimate.tax_rate)).toBe(0.05);
    expect(Number(patchBody.estimate.tax_amount)).toBeCloseTo(1000 * 0.05, 2);

    // (c) Snapshot-on-send: send() never touches tax_rate — the document carries its own.
    const { body: sentBody } = await api.sendEstimate(estId, {
      deposit_required: false, payment_methods: [],
    });
    expect(Number(sentBody.estimate.tax_rate)).toBe(0.05);
    const afterSend = await api.getEstimate(estId);
    expect(Number(afterSend.tax_rate)).toBe(0.05);
  });

  // ─── EST-05: send → public_token issued; public GET 200 ────────────────────────
  test('EST-05: send issues public_token; public GET returns 200', async () => {
    const { leadId } = await leadReadyForEstimate('MA');
    const { body: createBody } = await api.createEstimate({ lead_id: leadId, line_items: [VALID_LINE] });
    const estId = createBody.estimate.id;

    const { res: sendRes, body: sentBody } = await api.sendEstimate(estId, {
      deposit_required: false, payment_methods: [],
    });
    expect(sendRes.status()).toBe(200);
    expect(sentBody.estimate.status).toBe('SENT');
    const token = sentBody.estimate.public_token;
    expect(typeof token).toBe('string');
    expect(token).toMatch(/^[0-9a-f-]{36}$/i);

    // Public (unauthenticated) GET with the token → 200 with the document bundle.
    const { res: pubRes, body: pubBody } = await api.getPublicEstimate(estId, token);
    expect(pubRes.status()).toBe(200);
    expect(pubBody.estimate).toBeTruthy();
    expect(pubBody.organization).toBeTruthy();
  });

  // ─── EST-06: send-with-deposit spawns a kind=DEPOSIT invoice ────────────────────
  test('EST-06: deposit invoice spawned on send-with-deposit', async () => {
    // Use the builder so the deposit % is pinned via the org AppSetting (the send body
    // CANNOT carry a percentage — facts/surprises confirm it is silently ignored).
    const ctx = await maEstimateSentWithDeposit(api, 5_000, 30, ['CARD']);
    const dep = await api.getDepositInvoice(ctx.estimateId);
    expect(dep, 'deposit invoice on estimate.invoices[0]').toBeTruthy();
    expect(dep!.kind).toBe('DEPOSIT');
    expect(dep!.status).toBe('SENT');

    // The deposit % applies to the TAX-INCLUSIVE total: 5000 + 312.5 MA tax = 5312.5, 30% = 1593.75.
    expect(Number(dep!.total_amount)).toBeCloseTo(5_312.5 * 0.3, 2);

    // send_config reflects the pinned org percentage (NOT the send body).
    const est = await api.getEstimate(ctx.estimateId);
    expect(Number(est.send_config.deposit_percentage)).toBe(30);

    await assertInvoiceReconciles(api, dep!.id, 'EST-06');
  });

  // ─── EST-07: WON estimate is frozen for edits → 400 ────────────────────────
  test('EST-07: edit WON estimate → 400 (frozen)', async () => {
    // Drive an estimate to WON via a CASH record-payment (three-way flip).
    const ctx = await maEstimateSentWithDeposit(api, 4_000, 50, ['CHECK', 'CASH']);
    const { res: payRes } = await api.markDepositReceived(ctx.estimateId, { payment_method: 'CASH' });
    expect(payRes.status()).toBe(200);
    expect((await api.getEstimate(ctx.estimateId)).status).toBe('WON');

    // PATCH on the WON estimate → 400. Message updated 2026-07-21 (estimate-workspace v13
    // redesign, §A1/§A3a) — WON stays outside the editable set, but the gate now also allows
    // SENT/PENDING in place (locked-unless-paid/lock_on_send, D6/D12), so the message reads
    // "draft or sent" rather than "draft" alone.
    const { res, body } = await api.updateEstimate(ctx.estimateId, {
      line_items: [{ description: 'late add', quantity: 1, unit_price: 99, is_taxable: true }],
    });
    expect(res.status()).toBe(400);
    expect(body.error).toBe('Only draft or sent estimates can be edited');
  });

  // ─── EST-08: revise SENT→DRAFT nulls the old token; re-send re-publishes with a fresh token ──
  test('EST-08: revise invalidates old public token; re-send re-publishes with a fresh token', async () => {
    const { leadId } = await leadReadyForEstimate('MA');
    const { body: createBody } = await api.createEstimate({ lead_id: leadId, line_items: [VALID_LINE] });
    const estId = createBody.estimate.id;

    // First send → token1, status SENT, public GET 200. (First send also CREATES an
    // EstimateSendConfig row keyed by the unique estimate_id.)
    const { body: sent1 } = await api.sendEstimate(estId, { deposit_required: false, payment_methods: [] });
    const token1 = sent1.estimate.public_token;
    expect(typeof token1).toBe('string');
    expect((await api.getPublicEstimate(estId, token1)).res.status()).toBe(200);

    // Revise → DRAFT, public_token null. (revise() only nulls public_token/sent_at/valid_until;
    // it does NOT delete the EstimateSendConfig created on the first send.)
    const { res: revRes, body: revBody } = await api.reviseEstimate(estId);
    expect(revRes.status()).toBe(200);
    expect(revBody.estimate.status).toBe('DRAFT');
    expect(revBody.estimate.public_token).toBeNull();

    // The old token is INVALIDATED: public GET with token1 now 404
    // (findFirst {id, public_token: token1} → null). This is the real, durable invariant.
    expect((await api.getPublicEstimate(estId, token1)).res.status()).toBe(404);

    // FIXED behavior: re-send takes the isFirstSend path again (status==DRAFT) and UPSERTS the
    // EstimateSendConfig keyed on the @unique estimate_id (instead of a bare create that P2002'd),
    // so the revised estimate re-publishes cleanly: 200, status SENT again, and a FRESH public_token.
    const { res: reRes, body: sent2 } = await api.sendEstimate(estId, { deposit_required: false, payment_methods: [] });
    expect(reRes.status()).toBe(200);
    expect(sent2.estimate.status).toBe('SENT');
    const token2 = sent2.estimate.public_token;
    expect(typeof token2).toBe('string');
    expect(token2).toMatch(/^[0-9a-f-]{36}$/i);
    // A genuinely new token — not the invalidated token1, and not the (already-null) revise token.
    expect(token2).not.toBe(token1);

    // The revised estimate is now SENT again, carrying the fresh token; the new token serves the
    // public page (200) while the old token1 stays invalidated (still 404 from the revise above).
    const after = await api.getEstimate(estId);
    expect(after.status).toBe('SENT');
    expect(after.public_token).toBe(token2);
    expect((await api.getPublicEstimate(estId, token2)).res.status()).toBe(200);

    // No duplicate deposit document was spawned: this no-deposit estimate still has exactly ZERO
    // kind=DEPOSIT invoices (estimate.invoices is the deduped kind=DEPOSIT array; one upsert, no
    // second send_config or invoice). (`getDepositInvoice` reads estimate.invoices[0].)
    expect(after.invoices).toEqual([]);
    expect(await api.getDepositInvoice(estId)).toBeUndefined();
  });

  // ─── EST-09: duplicate same-lead carries the source tax_rate verbatim ───────────
  test('EST-09: duplicate same-lead keeps tax_rate', async () => {
    const { leadId } = await leadReadyForEstimate('MA');
    const { body: createBody } = await api.createEstimate({ lead_id: leadId, line_items: [VALID_LINE] });
    const source = createBody.estimate;
    expect(Number(source.tax_rate)).toBe(0.0625);

    // No body → target defaults to the source lead; tax carries verbatim.
    const { res, body } = await api.duplicateEstimate(source.id);
    expect(res.status()).toBe(201);
    expect(body.estimate.estimate_number).not.toBe(source.estimate_number);
    expect(Number(body.estimate.tax_rate)).toBe(Number(source.tax_rate));
  });

  // ─── EST-10: duplicate cross-lead re-derives tax from the target lead's state ────
  test('EST-10: duplicate cross-lead re-derives tax from target state', async () => {
    // Source on an MA lead (0.0625).
    const ma = await leadReadyForEstimate('MA');
    const { body: createBody } = await api.createEstimate({ lead_id: ma.leadId, line_items: [VALID_LINE] });
    const source = createBody.estimate;
    expect(Number(source.tax_rate)).toBe(0.0625);

    // Target lead in a DIFFERENT state (NH — no sales tax; no/zero StateTaxRate row → 0).
    const nh = await leadReadyForEstimate('NH');
    const { res, body } = await api.duplicateEstimate(source.id, { target_lead_id: nh.leadId });
    expect(res.status()).toBe(201);

    // Tax is RE-DERIVED from the target's service-location state — NOT the source 0.0625.
    // (Facts: target state with no StateTaxRate row → tax_rate === 0.)
    expect(Number(body.estimate.tax_rate)).not.toBe(0.0625);
    expect(Number(body.estimate.tax_rate)).toBe(0);
  });

  // ─── EST-11: at-most-one-WON-per-lead (record-payment / public / waive) ─────
  test('EST-11: 2nd approval via record-payment, public approve, and waive all → 400', async () => {
    test.setTimeout(120_000); // loops four full create→send chains on one lead.
    // Lead L with E1 driven to WON, plus three more SENT estimates on the SAME lead.
    const { leadId } = await leadReadyForEstimate('MA');

    // Pin a deposit % so every estimate spawns a deposit invoice on send.
    await api.raw('patch', '/api/settings/deposit_percentage', { value: '50' });

    const mkSent = async () => {
      const { body: cb } = await api.createEstimate({
        lead_id: leadId,
        line_items: [{ description: 'job', quantity: 1, unit_price: 2000, is_taxable: true }],
      });
      // The send response's estimate.invoices[] is selected BEFORE the deposit invoice is
      // created in the same tx, so it is empty here — read public_token (which IS on the
      // send response) and re-GET later for the deposit invoice if needed.
      const { body: sb } = await api.sendEstimate(cb.estimate.id, {
        deposit_required: true, payment_methods: ['CHECK', 'CASH', 'CARD'],
      });
      return { id: cb.estimate.id, token: sb.estimate.public_token };
    };

    // CRITICAL ORDERING: approving E1 (record-payment) wins the lead (lead → WON), and create()
    // rejects a new estimate on a WON/terminal lead ('Cannot create estimate for a won lead').
    // So ALL four estimates must be created+sent while the lead is still non-terminal, THEN
    // E1 is approved. The three survivors are already SENT and hit assertSingleApprovedPerLead.
    const e1 = await mkSent();
    const e2a = await mkSent();
    const e2b = await mkSent();
    const e2c = await mkSent();

    // Approve E1 via a CASH record-payment (three-way flip: deposit PAID + estimate WON + lead WON).
    const { res: e1Pay } = await api.markDepositReceived(e1.id, { payment_method: 'CASH' });
    expect(e1Pay.status()).toBe(200);
    expect((await api.getEstimate(e1.id)).status).toBe('WON');

    // (a) record-payment on a 2nd estimate → 400 (assertSingleApprovedPerLead).
    const { res: payRes, body: payBody } = await api.markDepositReceived(e2a.id, { payment_method: 'CASH' });
    expect(payRes.status()).toBe(400);
    expect(payBody.error).toBe('This lead already has an approved estimate');

    // (b) public non-card approve (Branch3 / Branch1) on a 2nd estimate → 400.
    const { res: pubRes, body: pubBody } = await api.approveEstimatePublic(e2b.id, e2b.token, {
      signature_data: api.testSignature, payment_method: 'CHECK',
    });
    expect(pubRes.status()).toBe(400);
    expect(pubBody.error).toBe('This lead already has an approved estimate');

    // (c) waive-deposit {action:'waive'} on a 2nd estimate → 400 (same guard; estimate still
    // SENT with an active SENT deposit invoice, so the guard is reached).
    const { res: waiveRes, body: waiveBody } = await api.waiveDeposit(e2c.id, 'waive');
    expect(waiveRes.status()).toBe(400);
    expect(waiveBody.error).toBe('This lead already has an approved estimate');

    // E1 is still the single WON estimate on the lead (delta-safe: scope to this lead).
    const both = await api.listEstimates({ lead_id: leadId });
    const list: any[] = both.body.estimates ?? both.body;
    const approved = list.filter((e: any) => e.status === 'WON');
    expect(approved.length).toBe(1);
    expect(approved[0].id).toBe(e1.id);
  });

  // ─── EST-12: webhook two-approved — invariant holds; 500-by-design → flag (§6) ───
  test('EST-12: webhook two-approved — never two WON; current path 500 (should be 4xx)', async () => {
    test.setTimeout(120_000); // two full create→send chains + two webhook fires + reconcile.
    // Two SENT estimates on ONE lead, each with a paid-eligible kind=DEPOSIT invoice; the
    // 2nd deposit webhook arrives after the 1st has flipped WON.
    const { customerId, locationId } = await createMaCustomerWithLocation(api);
    const { body: leadBody } = await api.createLead({
      customer_id: customerId, service_request: `two-approved-${api.suffix}`, service_location_id: locationId,
    });
    const leadId = leadBody.lead.id;

    // Gate the lead's estimates on a completed walkthrough.
    await api.contactLead(leadId);
    const performerId = await createSalesUser(api);
    await api.scheduleWalkthrough(leadId, {
      walkthrough_scheduled_at: api.futureDate(24), performer_ids: [performerId],
    });
    await api.completeWalkthrough(leadId);

    // Pin the org deposit % (CARD-accept + stripe_account_id are set by provisionTestOrg).
    await api.raw('patch', '/api/settings/deposit_percentage', { value: '30' });

    const mk = async () => {
      const { body } = await api.createEstimate({
        lead_id: leadId, line_items: [{ description: 'x', quantity: 1, unit_price: 1000, is_taxable: true }],
      });
      const estId = body.estimate.id;
      await api.sendEstimate(estId, {
        deposit_required: true, payment_methods: ['CARD'],
      });
      // The send response's estimate.invoices[] is selected BEFORE the deposit invoice is
      // created in the same transaction, so it comes back EMPTY. Re-GET the estimate to read
      // the spawned kind=DEPOSIT invoice (estimate.invoices[0]).
      const dep = await api.getDepositInvoice(estId);
      expect(dep, 'deposit invoice spawned on send-with-deposit').toBeTruthy();
      return { id: estId, dep };
    };
    const e1 = await mk();
    const e2 = await mk();

    // Approve E1 via its deposit webhook (amount_total = amount_due*100, face value).
    const ev1 = api.depositPaidEvent(e1.dep.id, api.checkoutCents(Number(e1.dep.amount_due)), { eventId: `evt_e1_${api.suffix}` });
    await api.fireStripeEvent(ev1);
    expect((await api.getEstimate(e1.id)).status).toBe('WON');

    // Second deposit webhook for the SAME lead — the WON update hits the partial-unique
    // index estimates_org_lead_approved_key → P2002 → outer catch → res 500 (tx rolls back).
    const ev2 = api.depositPaidEvent(e2.dep.id, api.checkoutCents(Number(e2.dep.amount_due)), { eventId: `evt_e2_${api.suffix}` });
    const { res } = await api.fireStripeEvent(ev2);

    // INVARIANT (real green assertion): never two WON estimates on one lead.
    const both = await api.listEstimates({ lead_id: leadId });
    const list: any[] = both.body.estimates ?? both.body;
    const approved = list.filter((e: any) => e.status === 'WON');
    expect(approved.length).toBe(1);
    expect(approved[0].id).toBe(e1.id);

    // E2's deposit invoice stayed unpaid (whole tx rolled back).
    const e2Dep = await api.getInvoice(e2.dep.id);
    expect(e2Dep.status).not.toBe('PAID');
    expect(Number(e2Dep.amount_due)).toBeGreaterThan(0);
    await assertInvoiceReconciles(api, e2.dep.id, 'EST-12-e2');

    // FLAG: the partial-unique index throws → 500 today; should be a clean 4xx. (Real Stripe
    // would strand the charge — a §9 residual.)
    expect(res.status()).toBe(500);
    flagKnownBug(test.info(), {
      id: 'EST-12', spec: '§4/§6',
      current: '2nd deposit webhook → 500 (P2002 on partial-unique WON index, tx rollback)',
      expected: 'clean 4xx; real-Stripe stranded-charge is a §9 residual',
    });
  });

  // ─── EST-13: DRAFT-only delete (200 + message); SENT → 400 ──────────────────────
  test('EST-13: delete SENT → 400; delete DRAFT → 200 with message', async () => {
    // SENT estimate → delete rejected.
    const { leadId: sentLeadId } = await leadReadyForEstimate('MA');
    const { body: sentCreate } = await api.createEstimate({ lead_id: sentLeadId, line_items: [VALID_LINE] });
    await api.sendEstimate(sentCreate.estimate.id, { deposit_required: false, payment_methods: [] });
    const { res: sentDel, body: sentDelBody } = await api.raw('delete', `/api/estimates/${sentCreate.estimate.id}`);
    expect(sentDel.status()).toBe(400);
    expect(sentDelBody.error).toBe('Only draft estimates can be deleted');

    // DRAFT estimate → deletes, 200 + {message:'Estimate deleted'} (NOT 204).
    const { leadId: draftLeadId } = await leadReadyForEstimate('MA');
    const { body: draftCreate } = await api.createEstimate({ lead_id: draftLeadId, line_items: [VALID_LINE] });
    const { res: draftDel, body: draftDelBody } = await api.raw('delete', `/api/estimates/${draftCreate.estimate.id}`);
    expect(draftDel.status()).toBe(200);
    expect(draftDelBody.message).toBe('Estimate deleted');

    // Confirm it's gone (GET → 404).
    const gone = await api.raw('get', `/api/estimates/${draftCreate.estimate.id}`);
    expect(gone.res.status()).toBe(404);
  });
});
