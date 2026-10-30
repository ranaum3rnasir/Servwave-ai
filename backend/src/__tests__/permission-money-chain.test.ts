/* =============================================================================
   Roles & Permissions alignment, AL-05 (P11): the three money classes are one chain. See prices is the root; what stands
   on it - recording payments and creating or editing estimates and invoices - cannot be on while it is off.

   Pure: no database. The expected chain is written out here from the principle (P11) and the ruling (E7), never read
   back from the catalog.
   ========================================================================== */

import { describe, it, expect } from 'vitest';
import { BUILT_IN_ROLES, SWITCH_CATALOG, findSwitch, presetSwitchSet, type SwitchValue } from '../lib/permissions/switches/catalog';
import { validateSwitchSet } from '../lib/permissions/switches/validate';

/** What stands on See prices, by label, as P11 lists them: the two other money classes and what writes a priced document. */
const NEEDS_PRICES = [
  'See costs', 'See company figures', 'Record payments', 'Create estimates', 'Edit estimates', 'Create invoices', 'Edit invoices',
];

const keyOf = (label: string) => SWITCH_CATALOG.find((s) => s.label === label)!.key;

describe('See prices, the root switch', () => {
  it('is one on/off switch that needs nothing and compiles into the one grant the server reads', () => {
    const entry = findSwitch('see_prices')!;
    expect(entry.label).toBe('See prices');
    expect(entry.kind).toBe('toggle');
    expect(entry.requires).toEqual([]);
    expect(entry.grants).toEqual([{ action: 'read', subject: 'Prices' }]);
  });

  it('is on in all four built-in presets, so no preset behaves differently', () => {
    expect(findSwitch('see_prices')!.presets).toEqual({ ADMIN: true, SALES: true, DISPATCHER: true, TECHNICIAN: true });
  });

  it('names a server check for every response that carries a price, and each name is unique', () => {
    const checks = findSwitch('see_prices')!.serverChecks;
    expect(checks.length).toBeGreaterThan(0);
    expect(new Set(checks).size).toBe(checks.length);
    for (const area of ['estimate', 'invoice', 'job', 'payments-page', 'customer', 'price-book']) {
      expect(checks.some((c) => c.startsWith(area)), area).toBe(true);
    }
  });

  it('names no vendor in its label or help text', () => {
    const entry = findSwitch('see_prices')!;
    expect(`${entry.label} ${entry.helpText}`).not.toMatch(/stripe|supabase|render|ctm|calltracking/i);
  });
});

describe('what stands on See prices', () => {
  it.each(NEEDS_PRICES)('%s requires See prices', (label) => {
    expect(findSwitch(keyOf(label))!.requires).toContain('see_prices');
  });

  it.each(NEEDS_PRICES)('%s cannot be stored on while See prices is off, and the refusal names See prices', (label) => {
    const key = keyOf(label);
    // Everything else it needs is on, so the only thing missing is the root.
    const needed = Object.fromEntries(findSwitch(key)!.requires.filter((r) => r !== 'see_prices').map((r) => [r, true]));
    const refused = validateSwitchSet({ ...needed, [key]: true, see_prices: false });
    expect(refused.some((v) => v.switchKey === key && v.needs.includes('see_prices')), label).toBe(true);
    expect(refused.find((v) => v.switchKey === key)?.message, label).toMatch(/See prices/);
    const accepted = validateSwitchSet({ ...needed, [key]: true, see_prices: true });
    expect(accepted.filter((v) => v.switchKey === key), label).toEqual([]);
  });

  it('passes the validator for every built-in preset', () => {
    for (const role of BUILT_IN_ROLES) {
      const set: Record<string, SwitchValue> = presetSwitchSet(role);
      expect(validateSwitchSet(set), role).toEqual([]);
    }
  });
});

describe('the three money classes', () => {
  const MONEY = ['See prices', 'See costs', 'See company figures'];

  it('are the only switches of the Money group, in the order the screens draw them', () => {
    expect(SWITCH_CATALOG.filter((s) => s.module === 'Money').map((s) => s.label)).toEqual(MONEY);
  });

  it('leave no switch called See financial data: its behaviour lives under See costs, with the same grant and checks', () => {
    expect(SWITCH_CATALOG.some((s) => s.key === 'see_financial_data' || s.label === 'See financial data')).toBe(false);
    const costs = findSwitch('see_costs')!;
    expect(costs.grants).toEqual([{ action: 'read', subject: 'Pricing' }]);
    expect(costs.presets).toEqual({ ADMIN: true, SALES: true, DISPATCHER: false, TECHNICIAN: false });
    expect(costs.serverChecks).toEqual(expect.arrayContaining(['estimate-cost', 'invoice-cost', 'job-cost', 'price-book-cost', 'vendor-account-number']));
  });

  it('keep See company figures as it was: on for Admin only', () => {
    expect(findSwitch('see_company_figures')!.presets).toEqual({ ADMIN: true, SALES: false, DISPATCHER: false, TECHNICIAN: false });
  });

  it('turn off together: a set with See prices off and either other class on is refused, naming See prices', () => {
    for (const key of ['see_costs', 'see_company_figures']) {
      const refused = validateSwitchSet({ [key]: true, see_prices: false });
      expect(refused.map((v) => v.switchKey), key).toEqual([key]);
      expect(refused[0]!.needs, key).toEqual(['see_prices']);
    }
    expect(validateSwitchSet({ see_costs: true, see_company_figures: true, see_prices: true })).toEqual([]);
    expect(validateSwitchSet({ see_costs: false, see_company_figures: false, see_prices: false })).toEqual([]);
  });
});
