/* =============================================================================
   Roles & Permissions, PRD 1, slice S01.17 - the payment switches in the switch catalog, and the company's
   effective accepted payment methods.

   Pure: no database. The expected values are the PRD's catalog rows, written out as literals here (they are the
   source of truth the catalog is built from), never read back from the catalog.
   ========================================================================== */

import { describe, it, expect } from 'vitest';
import {
  ALL_ACCEPTED_METHODS, BUILT_IN_ROLES, SWITCH_CATALOG, presetSwitchSet,
} from '../lib/permissions/switches/catalog';
import { validateSwitchSet } from '../lib/permissions/switches/validate';
import { compileSwitchGrants } from '../lib/permissions/switches/store';
import { effectiveAcceptedMethods, methodAllowedFor } from '../lib/permissions/paymentMethods';
import { ALL_PAYMENT_METHODS } from '../lib/payment-methods';

const byLabel = (label: string) => SWITCH_CATALOG.filter((s) => s.label === label);
const presetsOf = (label: string) => BUILT_IN_ROLES.map((role) => byLabel(label)[0]!.presets[role]);
const VENDORS = /\b(stripe|twilio|supabase|render|ctm|calltrackingmetrics|resend)\b/i;

describe('the payment switches', () => {
  it.each([
    // AL-04: the Technician preset no longer holds Record payments or Send payment links.
    ['Record payments', [true, false, true, false]],
    ['Refund payments', [true, false, false, false]],
    ['Send payment links', [true, false, true, false]],
  ])('%s is one on/off switch in the Invoices group that stands on its own, with the PRD preset column', (label, column) => {
    const rows = byLabel(label);
    expect(rows).toHaveLength(1);
    const entry = rows[0]!;
    expect(entry.module).toBe('Invoices');
    expect(entry.kind).toBe('toggle');
    expect(presetsOf(label)).toEqual(column);
    expect(`${entry.label} ${entry.helpText}`).not.toMatch(VENDORS);
  });

  it('Record payments needs only See prices, so it is valid with Invoices View off (a Technician set that turns it on)', () => {
    expect(byLabel('Record payments')[0]!.requires).toEqual(['see_prices']);
    expect(byLabel('Send payment links')[0]!.requires).toEqual([]);
    // AL-04: the Technician preset has Record payments off now; turning it on by hand must stay valid with View invoices off.
    const technician = presetSwitchSet('TECHNICIAN');
    technician.record_payments = true;
    technician.send_payment_links = true;
    expect(technician.view_invoices).toBe(false);
    expect(validateSwitchSet(technician)).toEqual([]);
  });

  it('keeps Record payments, Refund payments and Send payment links on three grants of their own', () => {
    const grantOf = (label: string) => byLabel(label)[0]!.grants.map((g) => `${g.action}:${g.subject}`);
    expect(grantOf('Record payments').sort()).toEqual(['record_payment:Estimate', 'record_payment:Invoice']);
    expect(grantOf('Refund payments')).toEqual(['refund:Invoice']);
    expect(grantOf('Send payment links')).toEqual(['send_payment_link:Invoice']);
  });

  it('compiles each grant in exactly the presets that have the switch on', () => {
    const holders = (action: string, subject: string) =>
      BUILT_IN_ROLES.filter((role) => compileSwitchGrants(presetSwitchSet(role)).some((g) => g.action === action && g.subject === subject));
    // AL-04: Technician no longer holds Record payments or Send payment links.
    expect(holders('record_payment', 'Invoice')).toEqual(['ADMIN', 'DISPATCHER']);
    expect(holders('record_payment', 'Estimate')).toEqual(['ADMIN', 'DISPATCHER']);
    expect(holders('refund', 'Invoice')).toEqual(['ADMIN']);
    expect(holders('send_payment_link', 'Invoice')).toEqual(['ADMIN', 'DISPATCHER']);
  });

  it('accounts for each switch with named server checks', () => {
    const checks = (label: string) => byLabel(label)[0]!.serverChecks;
    expect(checks('Record payments').sort()).toEqual(['estimate-record-payment', 'invoice-record-payment']);
    expect(checks('Send payment links').sort()).toEqual(['invoice-payment-link', 'payments-page-attention-contact']);
    expect(new Set(checks('Refund payments'))).toEqual(new Set([
      'invoice-refund', 'invoice-cancel-bank-payment', 'payment-attention-list', 'payment-attention-refund', 'payment-attention-resolve',
      'payments-page-attention-resolve',
      // Payments go-live P10: saving and submitting dispute evidence.
      'dispute-evidence-stage', 'dispute-evidence-submit',
    ]));
  });
});

describe('the Allowed payment methods switch', () => {
  const entry = byLabel('Allowed payment methods')[0]!;

  it('is one list switch in the Invoices group that stands on its own, with every payment method as an option', () => {
    expect(byLabel('Allowed payment methods')).toHaveLength(1);
    expect(entry.module).toBe('Invoices');
    expect(entry.kind).toBe('list');
    expect(entry.requires).toEqual([]);
    expect(entry.listOptions).toEqual(ALL_PAYMENT_METHODS);
    expect(`${entry.label} ${entry.helpText}`).not.toMatch(VENDORS);
  });

  it('holds the "All accepted methods" marker in every preset, never a copy of a list', () => {
    expect(BUILT_IN_ROLES.map((role) => entry.presets[role])).toEqual(Array(4).fill(ALL_ACCEPTED_METHODS));
    expect(typeof ALL_ACCEPTED_METHODS).toBe('string');
  });

  it('is checked wherever a payment or a deposit is recorded', () => {
    expect(new Set(entry.serverChecks)).toEqual(new Set(['invoice-payment-method', 'estimate-deposit-method']));
  });

  it('is valid as the marker or as a fixed subset of methods, and as none at all', () => {
    const check = (value: unknown) => validateSwitchSet({ ...presetSwitchSet('ADMIN'), allowed_payment_methods: value as never });
    expect(check(ALL_ACCEPTED_METHODS)).toEqual([]);
    expect(check(['CHECK', 'CASH'])).toEqual([]);
    expect(check([])).toEqual([]);
  });

  it.each([
    ['text that is not the marker', 'everything'],
    ['a method that does not exist', ['CHECK', 'GOLD']],
    ['a method listed twice', ['CASH', 'CASH']],
    ['on', true],
    ['a list holding something that is not text', ['CASH', 1]],
  ])('refuses %s', (_name, value) => {
    const violations = validateSwitchSet({ ...presetSwitchSet('ADMIN'), allowed_payment_methods: value as never });
    expect(violations.map((v) => v.switchKey)).toEqual(['allowed_payment_methods']);
  });

  it('refuses a list for an on/off switch', () => {
    const violations = validateSwitchSet({ ...presetSwitchSet('ADMIN'), record_payments: ['CASH'] as never });
    expect(violations.map((v) => v.switchKey)).toEqual(['record_payments']);
  });

  it('passes the catalog validator in every built-in preset', () => {
    for (const role of BUILT_IN_ROLES) expect(validateSwitchSet(presetSwitchSet(role)), role).toEqual([]);
  });
});

describe("the company's effective accepted payment methods", () => {
  const org = (accepted: unknown, chargesEnabled = false) => ({ accepted_payment_methods: accepted, stripe_charges_enabled: chargesEnabled });

  it('counts every method as accepted when the company ticked none (an empty list)', () => {
    const effective = effectiveAcceptedMethods(org([]));
    expect(effective.everyMethod).toBe(true);
    expect(effective.methods).toEqual(ALL_PAYMENT_METHODS);
  });

  it('counts every method as accepted when the stored list holds Credit Card alone because the card processor is live', () => {
    const effective = effectiveAcceptedMethods(org(['CARD'], true));
    expect(effective.everyMethod).toBe(true);
    expect(effective.methods).toEqual(ALL_PAYMENT_METHODS);
  });

  it('accepts the ticked methods and Credit Card while the processor is live, and nothing else', () => {
    const effective = effectiveAcceptedMethods(org(['CHECK', 'CARD'], true));
    expect(effective.everyMethod).toBe(false);
    expect([...effective.methods].sort()).toEqual(['CARD', 'CHECK']);
  });

  it('accepts only the ticked methods when no processor is live, even if the stored list still names Credit Card', () => {
    const effective = effectiveAcceptedMethods(org(['CHECK', 'CARD'], false));
    expect(effective.methods).toEqual(['CHECK']);
  });

  it('leaves Credit Card out while the processor can take charges but the card capability is not active (not in the stored list)', () => {
    // The card capability fact is kept only as Credit Card in the stored list; charges alone do not make it accepted.
    expect(effectiveAcceptedMethods(org(['CASH'], true)).methods).toEqual(['CASH']);
  });

  it('never counts the online bank method, which is collected only through the processor', () => {
    expect(effectiveAcceptedMethods(org(['CHECK', 'ACH'], true)).methods).toEqual(['CHECK']);
  });

  it('treats a stored list that is not a list as nothing ticked', () => {
    expect(effectiveAcceptedMethods(org(null)).everyMethod).toBe(true);
  });
});

describe("a method against the company's list and the person's list", () => {
  const checkOnly = effectiveAcceptedMethods({ accepted_payment_methods: ['CHECK'], stripe_charges_enabled: false });
  const everything = effectiveAcceptedMethods({ accepted_payment_methods: [], stripe_charges_enabled: false });

  it('lets a person on "All accepted methods" record exactly what the company accepts', () => {
    expect(methodAllowedFor('CHECK', checkOnly, ALL_ACCEPTED_METHODS)).toBe(true);
    expect(methodAllowedFor('CASH', checkOnly, ALL_ACCEPTED_METHODS)).toBe(false);
    expect(methodAllowedFor('CASH', everything, ALL_ACCEPTED_METHODS)).toBe(true);
  });

  it('intersects a fixed subset with the company list', () => {
    expect(methodAllowedFor('CHECK', checkOnly, ['CHECK', 'CASH'])).toBe(true);
    expect(methodAllowedFor('CASH', checkOnly, ['CHECK', 'CASH'])).toBe(false);
    expect(methodAllowedFor('CASH', everything, ['CHECK'])).toBe(false);
  });

  it('lets a person with no methods record none', () => {
    expect(methodAllowedFor('CHECK', everything, [])).toBe(false);
  });
});
