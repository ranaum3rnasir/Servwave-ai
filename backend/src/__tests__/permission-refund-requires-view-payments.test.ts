/* =============================================================================
   Payments go-live, slice P8 - catalog edits agreed with the roles session (13 Oct).

   Pure: no database. Refund payments needs View payments and payouts (the Payments page the refund is made from),
   and View payments and payouts sits in the Invoices and payments group beside Show Payments page.
   ========================================================================== */

import { describe, it, expect } from 'vitest';
import { BUILT_IN_ROLES, SWITCH_CATALOG, presetSwitchSet } from '../lib/permissions/switches/catalog';
import { validateSwitchSet } from '../lib/permissions/switches/validate';

const entry = (key: string) => SWITCH_CATALOG.find((s) => s.key === key)!;

describe('Refund payments needs View payments and payouts', () => {
  it('lists View payments and payouts among the switches Refund payments requires', () => {
    expect(entry('refund_payments').requires).toEqual(['view_invoices', 'view_payments']);
  });

  it('refuses a custom role with Refund payments on and View payments and payouts off', () => {
    const base = presetSwitchSet('ADMIN');
    const bad = validateSwitchSet({ ...base, refund_payments: true, view_payments: false });
    expect(bad.map((v) => v.message).join(' ')).toMatch(/Refund payments needs View payments and payouts/);
    expect(validateSwitchSet({ ...base, refund_payments: true, view_payments: true })).toEqual([]);
  });

  it('leaves every built-in preset valid and unchanged: Admin only', () => {
    for (const role of BUILT_IN_ROLES) expect(validateSwitchSet(presetSwitchSet(role)), role).toEqual([]);
    expect(BUILT_IN_ROLES.map((role) => entry('refund_payments').presets[role])).toEqual([true, false, false, false]);
    expect(BUILT_IN_ROLES.map((role) => entry('view_payments').presets[role])).toEqual([true, false, false, false]);
  });
});

describe('View payments and payouts sits with the invoice switches', () => {
  it('is in the Invoices module, directly before Show Payments page', () => {
    expect(entry('view_payments').module).toBe('Invoices');
    const keys = SWITCH_CATALOG.map((s) => s.key);
    expect(keys.indexOf('view_payments')).toBe(keys.indexOf('show_payments_page') - 1);
  });

  it('keeps its grant, label and help text, a toggle that requires nothing', () => {
    const e = entry('view_payments');
    expect(e.label).toBe('View payments and payouts');
    expect(e.kind).toBe('toggle');
    expect(e.requires).toEqual([]);
    expect(e.helpText.length).toBeGreaterThan(0);
    expect(e.grants).toEqual([{ action: 'view_payments', subject: 'Organization' }]);
  });
});
