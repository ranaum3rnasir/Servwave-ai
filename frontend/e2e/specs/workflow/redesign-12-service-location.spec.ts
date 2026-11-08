import { test, expect } from '@playwright/test';
import { ApiClient } from '../../helpers/api-client';
import { createMaCustomerWithLocation } from '../../helpers/workflow-builders';
import { flagKnownBug } from '../../helpers/known-bug';

/**
 * Stage 2 — ServiceLocation (Task C2, rows LOC-01..LOC-07).
 *
 * These rows exercise the CUSTOMER-owned ServiceLocation CRUD under
 * /api/customers/:id/locations* (customer.controller.ts). NOT location.controller
 * (that owns org-settings physical branches — a different entity entirely).
 *
 * Key behaviors pinned from facts/service-location.json + customer.controller.ts:
 *  - addLocation does NOT auto-promote a first/only location to primary; only the
 *    customer-CREATE path forces is_primary for a single location. So when seeding a
 *    second location for promote/delete tests, primary must be set explicitly.
 *  - enforceLocationInvariant runs FIRST in remove/archive: blocks the last active
 *    location, and the primary unless promote_location_id is supplied. So delete/archive
 *    rows seed >=2 active locations and target a non-primary one.
 *  - DELETE accepts a JSON body { promote_location_id } (unusual for DELETE; api.raw
 *    supports it).
 *  - All four mutating responses wrap the row under body.location; removeLocation returns
 *    { message, archived? }.
 *  - Re-read persisted state via GET /api/customers/:id -> customer.service_locations
 *    (ordered is_primary desc; includes is_active + archived_at).
 *
 * Shared org, serial: never assert absolute counts — assert presence/absence of the
 * specific seeded location ids and the per-customer single-primary invariant.
 */

let api: ApiClient;
test.beforeAll(async () => { api = await new ApiClient().init(); });
test.afterAll(async () => { await api.dispose(); });

/** Fetch the persisted service_locations for a customer (GET re-read, not the mutation echo). */
async function getLocations(customerId: string): Promise<any[]> {
  const customer = await api.getCustomer(customerId);
  return customer.service_locations as any[];
}

/** Add a second NON-primary location with a distinct address. Returns the created row. */
async function addSecondLocation(customerId: string, opts?: { is_primary?: boolean }) {
  return api.addLocation(customerId, {
    address_line1: `${Math.floor(Math.random() * 9999)} Commonwealth Ave`,
    city: 'Boston', state: 'MA', zip: '02215',
    is_primary: opts?.is_primary ?? false,
  });
}

test.describe('Stage 2 — ServiceLocation (LOC-01..LOC-07)', () => {
  test('LOC-01: a single seeded location is the one primary', async () => {
    // createMaCustomerWithLocation adds one location with is_primary:true explicitly,
    // matching the documented behavior (standalone addLocation does NOT auto-promote).
    const { customerId, locationId } = await createMaCustomerWithLocation(api);

    const locs = await getLocations(customerId);
    // Exactly one primary for THIS customer (per-customer invariant; safe to assert absolutely).
    expect(locs.filter((l) => l.is_primary)).toHaveLength(1);
    const primary = locs.find((l) => l.is_primary)!;
    expect(primary.id).toBe(locationId);
    expect(primary.is_active).toBe(true);
  });

  test('LOC-02: adding a location accretes (existing locations preserved)', async () => {
    const { customerId, locationId } = await createMaCustomerWithLocation(api);

    const before = await getLocations(customerId);
    const baselineIds = new Set(before.map((l) => l.id));

    const second = await addSecondLocation(customerId);
    expect(second.id).toBeTruthy();

    const after = await getLocations(customerId);
    // The new one is present AND every pre-existing id survives (accretion, no replace).
    expect(after.map((l) => l.id)).toContain(second.id);
    expect(after.map((l) => l.id)).toContain(locationId);
    for (const id of baselineIds) expect(after.map((l) => l.id)).toContain(id);
    expect(after.length).toBe(before.length + 1);
    // Still exactly one primary (the original); addLocation w/o is_primary did not steal it.
    expect(after.filter((l) => l.is_primary)).toHaveLength(1);
    expect(after.find((l) => l.is_primary)!.id).toBe(locationId);
  });

  test('LOC-03: promoting B (PATCH is_primary:true) demotes A', async () => {
    const { customerId, locationId: aId } = await createMaCustomerWithLocation(api); // A is primary
    const b = await addSecondLocation(customerId); // B not primary

    // Promote B via the PATCH updateLocation path (no dedicated /promote endpoint).
    const { res } = await api.updateLocationRaw(customerId, b.id, { is_primary: true });
    expect(res.status()).toBe(200);

    // Re-read persisted state, not the PATCH echo.
    const locs = await getLocations(customerId);
    const a = locs.find((l) => l.id === aId)!;
    const bRow = locs.find((l) => l.id === b.id)!;
    expect(bRow.is_primary).toBe(true);
    expect(a.is_primary).toBe(false);
    // Still exactly one primary overall.
    expect(locs.filter((l) => l.is_primary)).toHaveLength(1);
  });

  test('LOC-04: a referenced non-primary location ARCHIVES (not hard-delete)', async () => {
    const { customerId } = await createMaCustomerWithLocation(api); // A primary
    const b = await addSecondLocation(customerId); // B non-primary, >=2 active so invariant passes

    // Reference B via a lead so the referenced-branch fires.
    const { body: leadBody } = await api.createLead({
      customer_id: customerId,
      service_request: `loc04-${api.suffix}`,
      service_location_id: b.id,
    });
    expect(leadBody.lead.id).toBeTruthy();

    // DELETE B (non-primary -> no promote needed). Referenced -> archive branch.
    const { res, body } = await api.raw('delete', `/api/customers/${customerId}/locations/${b.id}`);
    expect(res.status()).toBe(200);
    expect(body.archived).toBe(true);
    expect(body.message).toBe('Location archived (referenced by leads or jobs)');

    // B still exists but is_active:false + archived_at set (NOT hard-deleted).
    const locs = await getLocations(customerId);
    const bRow = locs.find((l) => l.id === b.id);
    expect(bRow).toBeTruthy();
    expect(bRow!.is_active).toBe(false);
    expect(bRow!.archived_at).not.toBeNull();
  });

  test('LOC-05: an unreferenced non-primary location HARD-DELETES', async () => {
    const { customerId } = await createMaCustomerWithLocation(api); // A primary
    const b = await addSecondLocation(customerId); // B non-primary, unreferenced; >=2 active

    // DELETE B — no lead/job references it -> hard delete branch.
    const { res, body } = await api.raw('delete', `/api/customers/${customerId}/locations/${b.id}`);
    expect(res.status()).toBe(200);
    expect(body.message).toBe('Location deleted');
    expect(body.archived).toBeUndefined();

    // B is gone from the persisted set (hard-deleted, not archived).
    const locs = await getLocations(customerId);
    expect(locs.map((l) => l.id)).not.toContain(b.id);
  });

  test('LOC-06: cannot remove the last active / unpromoted primary; promote unblocks', async () => {
    // ── Case A: last active location -> 400 'Cannot remove the last active location'.
    const single = await createMaCustomerWithLocation(api); // exactly one active location
    const caseA = await api.raw('delete', `/api/customers/${single.customerId}/locations/${single.locationId}`);
    expect(caseA.res.status()).toBe(400);
    expect(caseA.body.error).toBe('Cannot remove the last active location');

    // ── Case B: primary with siblings, no promote -> 400.
    const { customerId, locationId: aId } = await createMaCustomerWithLocation(api); // A primary
    await addSecondLocation(customerId); // B non-primary; now 2 active, A still primary
    const caseB = await api.raw('delete', `/api/customers/${customerId}/locations/${aId}`);
    expect(caseB.res.status()).toBe(400);
    expect(caseB.body.error).toBe('Cannot remove the primary location without promoting another');

    // ── Case C: same delete WITH promote_location_id -> succeeds and promotes the survivor.
    // Re-read the surviving (non-primary) location id (A is still present/primary at this point).
    const before = await getLocations(customerId);
    const survivor = before.find((l) => l.id !== aId && l.is_active)!;
    const caseC = await api.raw('delete', `/api/customers/${customerId}/locations/${aId}`, {
      promote_location_id: survivor.id,
    });
    expect(caseC.res.status()).toBe(200);
    // The survivor is now primary on re-read; A is gone (unreferenced -> hard delete).
    const after = await getLocations(customerId);
    const survivorRow = after.find((l) => l.id === survivor.id)!;
    expect(survivorRow.is_primary).toBe(true);
    expect(after.filter((l) => l.is_primary && l.is_active)).toHaveLength(1);
  });

  test('LOC-07: cross-state location edit emits NO tax_warning (SS10 gap — known bug)', async () => {
    const { customerId, locationId } = await createMaCustomerWithLocation(api); // MA location
    // Cross-state edit MA -> TX. The customer-level updateLocation never computes a tax warning
    // (that lives only on lead/job location-change paths). This is the documented SS10 gap.
    const { res, body } = await api.updateLocationRaw(customerId, locationId, { state: 'TX' });
    expect(res.status()).toBe(200);
    // tax_warning is never present on this response (top-level or under body.location).
    expect(body.tax_warning ?? null).toBeNull();
    expect(body.location?.tax_warning ?? null).toBeNull();
    // The edit DID persist (sanity: state changed, response still wraps the row under .location).
    expect(body.location.state).toBe('TX');

    flagKnownBug(test.info(), {
      id: 'LOC-07',
      spec: 'SS10',
      current: 'updateLocation logs LOCATION_UPDATED, no tax_warning',
      expected: 'tax_warning on cross-state location edit',
    });
  });
});
