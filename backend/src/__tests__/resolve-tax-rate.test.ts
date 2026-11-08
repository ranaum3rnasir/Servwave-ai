import { describe, it, expect, vi } from 'vitest';
import { resolveTaxRateForState } from '../lib/tax/resolveTaxRate';

/**
 * The org-owned tax-rate list (2026-08-05) makes `org_tax_rates` the authority for an org's tax
 * rates and demotes `state_tax_rates` to seed source + fallback. Every derivation site in the app
 * routes through this one helper, so these tests are the contract for all of them.
 */

type Stub = Parameters<typeof resolveTaxRateForState>[0];

function client(orgRow: unknown, globalRow: unknown) {
  const orgFindFirst = vi.fn().mockResolvedValue(orgRow);
  const stateFindFirst = vi.fn().mockResolvedValue(globalRow);
  return {
    stub: { orgTaxRate: { findFirst: orgFindFirst }, stateTaxRate: { findFirst: stateFindFirst } } as unknown as Stub,
    orgFindFirst,
    stateFindFirst,
  };
}

describe('resolveTaxRateForState', () => {
  it("uses the org's own row for the state in preference to the global one", async () => {
    // The global table holds the Tax Foundation's *averaged* combined rate, which is never the
    // legally exact rate at a given address. An org that has corrected its row must win.
    const { stub, stateFindFirst } = client({ rate: '0.06625', is_visible: true }, { tax_rate: '0.066' });

    expect(await resolveTaxRateForState(stub, 'org-1', 'NJ')).toBe(0.06625);
    expect(stateFindFirst).not.toHaveBeenCalled();
  });

  it('uses a HIDDEN org row all the same', async () => {
    // Decision 3: hiding is a picker filter, never a reason to under-charge tax. An out-of-state
    // job in a state the admin has hidden must still be taxed at that state's rate.
    const { stub } = client({ rate: '0.0820', is_visible: false }, { tax_rate: '0.0625' });

    expect(await resolveTaxRateForState(stub, 'org-1', 'TX')).toBe(0.082);
  });

  it('falls back to the global table when the org has no row for the state', async () => {
    // True for an org created before the backfill, or one that deleted a seeded row.
    const { stub, stateFindFirst } = client(null, { tax_rate: '0.0854' });

    expect(await resolveTaxRateForState(stub, 'org-1', 'NY')).toBe(0.0854);
    expect(stateFindFirst).toHaveBeenCalledOnce();
  });

  it('returns 0 when neither table has the state', async () => {
    const { stub } = client(null, null);
    expect(await resolveTaxRateForState(stub, 'org-1', 'ZZ')).toBe(0);
  });

  it('returns 0 without touching the DB when no state resolves', async () => {
    const { stub, orgFindFirst, stateFindFirst } = client({ rate: '0.09' }, { tax_rate: '0.09' });

    expect(await resolveTaxRateForState(stub, 'org-1', null)).toBe(0);
    expect(await resolveTaxRateForState(stub, 'org-1', '')).toBe(0);
    expect(await resolveTaxRateForState(stub, 'org-1', '   ')).toBe(0);
    expect(orgFindFirst).not.toHaveBeenCalled();
    expect(stateFindFirst).not.toHaveBeenCalled();
  });

  it('scopes the org lookup to the caller org and normalises the state code', async () => {
    const { stub, orgFindFirst, stateFindFirst } = client(null, null);

    await resolveTaxRateForState(stub, 'org-1', ' nj ');

    expect(orgFindFirst.mock.calls[0][0].where).toEqual({ organization_id: 'org-1', state_code: 'NJ' });
    expect(stateFindFirst.mock.calls[0][0].where).toEqual({ state_code: 'NJ' });
  });
});
