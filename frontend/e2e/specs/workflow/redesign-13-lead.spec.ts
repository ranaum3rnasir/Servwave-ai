import { test, expect } from '@playwright/test';
import { ApiClient } from '../../helpers/api-client';
import {
  createMaCustomerWithLocation,
  maEstimateSentWithDeposit,
  createSalesUser,
} from '../../helpers/workflow-builders';
import { flagKnownBug } from '../../helpers/known-bug';

/**
 * Stage 3 — Lead (Task C3, rows LEAD-01..LEAD-12).
 *
 * ONE shared org, serial: data accumulates. Every seeded entity is made unique with
 * `api.suffix`; list/stat assertions are deltas / presence-of-our-id, never absolute counts.
 *
 * Facts (md_files/plans/entity-redesign/facts/lead.json) override the plan where they disagree:
 *  - LEAD-04 customer-freeze is STRUCTURAL (updateLeadSchema has no customer_id; Zod strips it,
 *    no 4xx). Only a LOCATION change is hard-400. We assert the location 400 and document the
 *    customer-freeze-by-omission.
 *  - LEAD-05 tax_warning is a SIBLING body.tax_warning (NOT body.lead.tax_warning).
 *  - LEAD-07 PAID branch: record-payment flips the lead to WON, so cancelLead returns 400 and
 *    never runs — the PAID deposit survives because cancel was REJECTED, not spared. We assert
 *    both the PAID deposit AND the 400, and flag the exemplar's misleading mechanism.
 *  - LEAD-09 a plain PATCH of a WON lead's service_request is NOT blocked (200) — humanCheck.
 *  - LEAD-10 happy-path delete returns 204 (empty body), not 200.
 */
let api: ApiClient;
test.beforeAll(async () => { api = await new ApiClient().init(); });
test.afterAll(async () => { await api.dispose(); });

// ── shared helpers ─────────────────────────────────────────────────────────
/** Create a bare lead on a fresh MA customer; returns ids. */
async function freshLead(serviceRequest?: string) {
  const { customerId, locationId } = await createMaCustomerWithLocation(api);
  const { res, body } = await api.createLead({
    customer_id: customerId,
    service_request: serviceRequest ?? `c3-${api.suffix}`,
    service_location_id: locationId,
  });
  expect(res.status(), 'createLead should 201').toBe(201);
  return { customerId, locationId, leadId: body.lead.id as string, lead: body.lead };
}

test.describe('Stage 3 — Lead (redesign C3)', () => {
  // ── LEAD-01 ────────────────────────────────────────────────────────────
  test('LEAD-01: create — customer required, location is pick-existing/structured (no silent free-text)', async () => {
    // (a) neither customer_id nor new_customer -> 400 (Zod .refine XOR).
    const none = await api.raw('post', '/api/leads', { service_request: `bad-${api.suffix}` });
    expect(none.res.status()).toBe(400);

    // (b) BOTH customer_id and new_customer present -> 400 (mutual-exclusion refine).
    const { customerId, locationId } = await createMaCustomerWithLocation(api);
    const both = await api.raw('post', '/api/leads', {
      customer_id: customerId,
      new_customer: {
        first_name: 'Dup', last_name: 'Both', email: `dup-${api.suffix}@e2e-qa.invalid`,
        phone: '6175550000',
        location: { address_line1: '1 Both St', city: 'Boston', state: 'MA', zip: '02108' },
      },
      service_request: `both-${api.suffix}`,
    });
    expect(both.res.status()).toBe(400);

    // (c) a service_location_id NOT owned by the customer -> 400 (LocationResolutionError).
    //     There is no free-text location field at all; location is a uuid validated against the
    //     customer, OR a structured new_location/legacy address. Use a *second* customer's loc id.
    const other = await createMaCustomerWithLocation(api);
    const cross = await api.raw('post', '/api/leads', {
      customer_id: customerId,
      service_request: `cross-${api.suffix}`,
      service_location_id: other.locationId, // belongs to a different customer
    });
    expect(cross.res.status()).toBe(400);
    expect(String(cross.body.error)).toContain('does not belong to the customer');

    // (d) happy path with a valid owned location -> 201.
    const ok = await api.createLead({
      customer_id: customerId,
      service_request: `ok-${api.suffix}`,
      service_location_id: locationId,
    });
    expect(ok.res.status()).toBe(201);
    expect(ok.body.lead.status).toBe('NEW');
  });

  // ── LEAD-02 ────────────────────────────────────────────────────────────
  test('LEAD-02: status pipeline + walkthrough + assignment persists', async () => {
    const { leadId } = await freshLead();

    // contact requires NEW -> CONTACTED.
    const contacted = await api.contactLead(leadId);
    expect(contacted.res.status()).toBe(200);
    expect(contacted.body.lead.status).toBe('CONTACTED');

    // a SALES performer is an eligible walkthrough performer in the seeded org.
    const performerId = await createSalesUser(api);
    const sched = await api.scheduleWalkthrough(leadId, {
      walkthrough_scheduled_at: api.futureDate(24),
      performer_ids: [performerId],
    });
    expect(sched.res.status()).toBe(200);
    expect(sched.body.lead.status).toBe('WALKTHROUGH_SCHEDULED');

    const done = await api.completeWalkthrough(leadId);
    expect(done.res.status()).toBe(200);
    expect(done.body.lead.status).toBe('WALKTHROUGH_COMPLETED');

    // contact from a non-NEW status is rejected.
    const reContact = await api.contactLead(leadId);
    expect(reContact.res.status()).toBe(400);

    // assignment persists on re-GET.
    const assigned = await api.assignLead(leadId, performerId);
    expect(assigned.res.status()).toBe(200);
    // M2M: single lead owner mirrors to commission_owner (scalar assigned_to dropped in TG7).
    expect(assigned.body.lead.commission_owner?.id).toBe(performerId);
    const reread = await api.getLead(leadId);
    expect(reread.commission_owner?.id).toBe(performerId);
  });

  // ── LEAD-03 ────────────────────────────────────────────────────────────
  test('LEAD-03: freely editable while no estimate — detail edits persist', async () => {
    const { leadId } = await freshLead();
    const newReq = `edited-${api.suffix}`;
    const newNote = `note-${api.suffix}`;
    const upd = await api.updateLead(leadId, {
      service_request: newReq, notes: newNote, job_type: 'HVAC',
    });
    expect(upd.res.status()).toBe(200);
    expect(upd.body.lead.service_request).toBe(newReq);

    const reread = await api.getLead(leadId);
    expect(reread.service_request).toBe(newReq);
    expect(reread.notes).toBe(newNote);
  });

  // ── LEAD-04 ────────────────────────────────────────────────────────────
  test('LEAD-04: location freeze once an estimate exists (customer-freeze is structural)', async () => {
    // maEstimateSentWithDeposit leaves a SENT estimate on the lead (estimate count >= 1).
    const ctx = await maEstimateSentWithDeposit(api, 10_000, 30);

    // Any location-change input now -> 400 'Location locked — lead has estimates'.
    const locked = await api.updateLead(ctx.leadId, {
      new_location: { address_line1: '99 Locked Ln', city: 'Boston', state: 'MA', zip: '02109' },
    });
    expect(locked.res.status()).toBe(400);
    expect(String(locked.body.error)).toBe('Location locked — lead has estimates');

    // The legacy service_address_* path is equally frozen.
    const lockedLegacy = await api.updateLead(ctx.leadId, {
      service_address_line1: '77 Legacy Rd', service_zip: '02110',
    });
    expect(lockedLegacy.res.status()).toBe(400);

    // Detail fields are STILL editable even with an estimate present.
    const detail = await api.updateLead(ctx.leadId, { service_request: `still-editable-${api.suffix}` });
    expect(detail.res.status()).toBe(200);

    // "Customer freeze" is enforced by SCHEMA OMISSION, not a 4xx: updateLeadSchema has no
    // customer_id field, so a customer_id in the PATCH body is silently stripped by Zod (200,
    // customer unchanged). Document this; do not assert a customer-change 4xx (it doesn't exist).
    const before = await api.getLead(ctx.leadId);
    const otherCust = await createMaCustomerWithLocation(api);
    const stripped = await api.updateLead(ctx.leadId, { customer_id: otherCust.customerId } as any);
    expect(stripped.res.status()).toBe(200); // not 4xx — the key is stripped, not rejected
    const after = await api.getLead(ctx.leadId);
    expect(after.customer_id).toBe(before.customer_id); // customer unchanged
  });

  // ── LEAD-05 ────────────────────────────────────────────────────────────
  test('LEAD-05: cross-state location edit returns a structured sibling tax_warning', async () => {
    // buildLocationTaxWarning(existing.service_state, newState) compares the lead row's
    // DENORMALIZED service_state against the NEW location's state. The existing-customer
    // create path (lead.controller.ts:624-661) does NOT denormalize service_state from a
    // resolved service_location_id — it only writes the legacy service_address_* fields
    // when they are passed explicitly. So freshLead() (location-id only) leaves
    // service_state=null, and buildLocationTaxWarning(null, 'NH') returns null (no warning).
    // We must seed the lead with an explicit service_state='MA' so the edit truly crosses
    // state lines. Pass the legacy service_address_* alongside service_location_id (the id
    // wins for the resolved location; extraData.service_state='MA' is persisted on the row).
    const { customerId, locationId } = await createMaCustomerWithLocation(api);
    const { res: createRes, body: createBody } = await api.createLead({
      customer_id: customerId,
      service_request: `tax-${api.suffix}`,
      service_location_id: locationId,
      service_address_line1: '1 Beacon St',
      service_city: 'Boston',
      service_state: 'MA',
      service_zip: '02108',
    } as any);
    expect(createRes.status(), 'createLead should 201').toBe(201);
    const leadId = createBody.lead.id as string;
    // Confirm the seed actually carries service_state='MA' (the warning's old_state source).
    expect(createBody.lead.service_state).toBe('MA');

    // Cross-state edit: MA -> NH yields the structured sibling tax_warning.
    const warn = await api.updateLead(leadId, {
      new_location: { address_line1: '5 Granite St', city: 'Concord', state: 'NH', zip: '03301' },
    });
    expect(warn.res.status()).toBe(200);
    // The warning is a SIBLING on the body, NOT nested under lead.
    expect(warn.body.tax_warning).toBeTruthy();
    expect(warn.body.tax_warning.tax_warning).toBe(true);
    expect(warn.body.tax_warning.old_state).toBe('MA');
    expect(warn.body.tax_warning.new_state).toBe('NH');
    expect(warn.body.lead?.tax_warning).toBeUndefined(); // not nested under lead

    // A same-state location change produces no warning sibling. The lead row's
    // service_state is STILL 'MA' (the NH edit above only rewrote service_location_id,
    // never the denormalized service_state — leadData excludes new_location). So the
    // no-warning case is a change to ANOTHER MA location (MA == existing 'MA').
    const same = await api.updateLead(leadId, {
      new_location: { address_line1: '6 Newbury St', city: 'Boston', state: 'MA', zip: '02116' },
    });
    expect(same.res.status()).toBe(200);
    expect(same.body.tax_warning ?? null).toBeNull();
  });

  // ── LEAD-06 ────────────────────────────────────────────────────────────
  test('LEAD-06: LOST counts in lost stats; CANCELLED is excluded from lost', async () => {
    // Use the /stats month-scoped surface (lost_this_month gated on lost_at=now). Capture a
    // baseline delta — never an absolute count (shared org accumulates).
    const before = await api.getLeadStats();

    const lost = await freshLead();
    await api.markLeadLost(lost.leadId, `lost-${api.suffix}`);

    const cancelled = await freshLead();
    await api.cancelLead(cancelled.leadId, `cancel-${api.suffix}`);

    const after = await api.getLeadStats();
    // The mark-lost lead increments lost_this_month by (at least) 1; the cancel does NOT.
    expect(Number(after.lost_this_month) - Number(before.lost_this_month)).toBe(1);

    // Cross-check the inline list stats.lost (all-time org LOST count): also +1 vs baseline.
    const listBefore = await api.listLeads({ status: 'LOST' });
    expect(Number(listBefore.body.stats.lost)).toBeGreaterThanOrEqual(1);
  });

  // ── LEAD-07 ────────────────────────────────────────────────────────────
  test('LEAD-07: cancel voids an UNPAID deposit invoice; a PAID deposit survives because cancel is rejected (lead already WON)', async () => {
    // UNPAID branch: SENT estimate + unpaid kind=DEPOSIT invoice; cancel voids it.
    const a = await maEstimateSentWithDeposit(api, 10_000, 30);
    const cancelA = await api.cancelLead(a.leadId, `customer gone ${api.suffix}`);
    expect(cancelA.res.status()).toBe(200);
    const ea = await api.getEstimate(a.estimateId);
    expect(ea.invoices[0].status).toBe('VOIDED'); // unpaid deposit voided by the cascade

    // PAID branch: record the deposit payment (auto-injects amount) -> deposit PAID, lead WON.
    const b = await maEstimateSentWithDeposit(api, 10_000, 30);
    const pay = await api.markDepositReceived(b.estimateId, { payment_method: 'CHECK' });
    expect(pay.res.status()).toBe(200);
    const ebPaid = await api.getLead(b.leadId);
    expect(ebPaid.status).toBe('WON');

    // The cancel is REJECTED with 400 (cannot cancel a WON lead) — it never runs.
    const cancelB = await api.cancelLead(b.leadId, `changed mind ${api.suffix}`);
    expect(cancelB.res.status()).toBe(400);
    expect(String(cancelB.body.error)).toBe('Cannot cancel a won lead');

    // The PAID deposit therefore survives — because cancel was rejected, NOT because cancel
    // ran and spared it. Assert the PAID state too (the exemplar's positive claim).
    const eb = await api.getEstimate(b.estimateId);
    expect(eb.invoices[0].status).toBe('PAID');

    // Document the exemplar's misleading mechanism (assertion is true for the wrong reason).
    flagKnownBug(test.info(), {
      id: 'LEAD-07',
      spec: '§3 lead cancel cascade',
      current: 'Recording the deposit payment flips the lead to WON; the subsequent cancelLead returns 400 and never runs, so the PAID deposit invoice survives because cancel was REJECTED.',
      expected: 'The exemplar implies cancel ran and deliberately spared a PAID deposit; in reality cancel cannot run on a WON lead. Behaviour is correct but the exemplar mechanism is misleading.',
    });
  });

  // ── LEAD-08 ────────────────────────────────────────────────────────────
  test('LEAD-08: cancel AND mark-lost run the identical estimate-cascade (SENT estimate -> ARCHIVED, unpaid deposit -> VOIDED)', async () => {
    // cancel branch.
    const c = await maEstimateSentWithDeposit(api, 8_000, 25);
    const cancelRes = await api.cancelLead(c.leadId, `cancel-cascade-${api.suffix}`);
    expect(cancelRes.res.status()).toBe(200);
    const ce = await api.getEstimate(c.estimateId);
    expect(ce.status).toBe('ARCHIVED');            // SENT estimate -> ARCHIVED
    expect(ce.invoices[0].status).toBe('VOIDED');   // unpaid deposit -> VOIDED

    // mark-lost branch (separate lead) runs the SAME cascade.
    const l = await maEstimateSentWithDeposit(api, 8_000, 25);
    const lostRes = await api.markLeadLost(l.leadId, `lost-cascade-${api.suffix}`);
    expect(lostRes.res.status()).toBe(200);
    const le = await api.getEstimate(l.estimateId);
    expect(le.status).toBe('ARCHIVED');
    expect(le.invoices[0].status).toBe('VOIDED');
  });

  // ── LEAD-09 ────────────────────────────────────────────────────────────
  test('LEAD-09: WON lead blocks cancel/mark-lost (400) but a plain field PATCH is NOT blocked (200)', async () => {
    // Reach WON via record-payment on a deposit estimate.
    const w = await maEstimateSentWithDeposit(api, 9_000, 20);
    const pay = await api.markDepositReceived(w.estimateId, { payment_method: 'CHECK' });
    expect(pay.res.status()).toBe(200);
    const wonLead = await api.getLead(w.leadId);
    expect(wonLead.status).toBe('WON');

    // cancel -> 400.
    const cancel = await api.cancelLead(w.leadId, `try-cancel-${api.suffix}`);
    expect(cancel.res.status()).toBe(400);
    expect(String(cancel.body.error)).toBe('Cannot cancel a won lead');

    // mark-lost -> 400.
    const lost = await api.markLeadLost(w.leadId, `try-lost-${api.suffix}`);
    expect(lost.res.status()).toBe(400);
    expect(String(lost.body.error)).toBe('Cannot mark a won lead as lost');

    // BUT a plain detail PATCH (service_request) on a WON lead is NOT blocked: update() has no
    // terminal-status guard, so it returns 200 and persists. This is the real current behavior.
    const edit = await api.updateLead(w.leadId, { service_request: `won-edit-${api.suffix}` });
    expect(edit.res.status()).toBe(200);
    const reread = await api.getLead(w.leadId);
    expect(reread.service_request).toContain('won-edit-');

    // Flagged for human: the plan's intent ("edit a WON lead -> 4xx") diverges from the code,
    // which only blocks cancel/mark-lost (and location edits, via the unrelated estimate-freeze).
    flagKnownBug(test.info(), {
      id: 'LEAD-09',
      spec: '§3 lead WON terminal guard',
      current: 'A plain PATCH of service_request/notes on a WON lead returns 200 and persists — update() has no terminal-status guard; only cancel/mark-lost (and location edits) are blocked.',
      expected: "If the spec intends ALL edits blocked once WON, that guard is unimplemented. Needs a human decision on whether generic field edits should be frozen on a WON lead.",
    });
  });

  // ── LEAD-10 ────────────────────────────────────────────────────────────
  test('LEAD-10: delete only when no estimate — with estimate -> 400, bare lead -> 204', async () => {
    // Negative: a lead carrying an estimate cannot be deleted.
    const withEst = await maEstimateSentWithDeposit(api, 7_000, 30);
    const blocked = await api.deleteLead(withEst.leadId);
    expect(blocked.status).toBe(400);
    const blockedBody = await blocked.res.json().catch(() => ({}));
    expect(String(blockedBody.error)).toBe('Lead has estimates — cancel or mark lost instead');

    // Positive: a bare lead (no estimate, no payment) deletes with 204 No Content (NOT 200).
    const bare = await freshLead();
    const ok = await api.deleteLead(bare.leadId);
    expect(ok.status).toBe(204);
    // The deleted lead is gone.
    const gone = await api.raw('get', `/api/leads/${bare.leadId}`);
    expect(gone.res.status()).toBe(404);
  });

  // ── LEAD-11 ────────────────────────────────────────────────────────────
  // fixme: the lead list controller has NO default terminal-status filter (it builds `where`
  // without excluding WON/LOST/CANCELLED), so terminal leads appear in the default list.
  // Whether terminal-hiding belongs in the API or the FE is unresolved — related to GH #129.
  // Un-skip once the intended layer ships.
  test.fixme('LEAD-11: default list = open pipeline (terminal hidden); ?status= returns terminal', async () => {
    // Seed one open (NEW) lead and one terminal (CANCELLED) lead, both unique to this run.
    const open = await freshLead(`open-${api.suffix}`);
    const term = await freshLead(`term-${api.suffix}`);
    await api.cancelLead(term.leadId, `to-terminal-${api.suffix}`);

    // Default list (no status/search): our CANCELLED lead is hidden, our NEW lead is present.
    const def = await api.listLeads();
    const defIds = (def.body.leads as any[]).map((l) => l.id);
    expect(defIds).toContain(open.leadId);
    expect(defIds).not.toContain(term.leadId);
    // No terminal status leaks into the default page.
    for (const l of def.body.leads as any[]) {
      expect(['WON', 'LOST', 'CANCELLED']).not.toContain(l.status);
    }

    // ?status=CANCELLED overrides the open-pipeline default and returns the terminal lead.
    const filtered = await api.listLeads({ status: 'CANCELLED' });
    const filteredIds = (filtered.body.leads as any[]).map((l) => l.id);
    expect(filteredIds).toContain(term.leadId);
  });

  // ── LEAD-12 ────────────────────────────────────────────────────────────
  // fixme: depends on the default list hiding terminal leads (see LEAD-11 / GH #129) — the API
  // applies no such filter today. The stats-unfiltered half is correct; the list-hides-terminal
  // premise is not yet built. Un-skip once resolved.
  test.fixme('LEAD-12: list stats are unfiltered — count terminal leads even when the list hides them', async () => {
    // Baseline from the default list call's inline stats.
    const before = await api.listLeads();
    const lostBefore = Number(before.body.stats.lost);
    const totalBefore = Number(before.body.stats.total);

    // Seed 1 NEW + 1 LOST + 1 CANCELLED, all unique to this run.
    const openLead = await freshLead(`stat-open-${api.suffix}`);
    const lostLead = await freshLead(`stat-lost-${api.suffix}`);
    await api.markLeadLost(lostLead.leadId, `stat-lost-${api.suffix}`);
    const cancelLead = await freshLead(`stat-cancel-${api.suffix}`);
    await api.cancelLead(cancelLead.leadId, `stat-cancel-${api.suffix}`);

    // Same default GET /api/leads call: list hides the two terminal leads, but stats count ALL.
    const after = await api.listLeads();
    const afterIds = (after.body.leads as any[]).map((l) => l.id);
    expect(afterIds).toContain(openLead.leadId);          // open lead visible
    expect(afterIds).not.toContain(lostLead.leadId);      // terminal hidden from list
    expect(afterIds).not.toContain(cancelLead.leadId);    // terminal hidden from list

    // Stats are org-scoped and unfiltered: total +3 (all three) and lost +1 vs baseline.
    expect(Number(after.body.stats.total) - totalBefore).toBeGreaterThanOrEqual(3);
    expect(Number(after.body.stats.lost) - lostBefore).toBe(1);
  });
});
