/* =============================================================================
   Roles & Permissions security fixes, M4 (ticket 35), Ran's rulings of 2026-10-28: a bell carries NO amount, for anyone, and no
   text in a bell is scanned.

   No database. One table, driven from the registry of notification verbs (`VERB_RULES`), so a money bell added later fails it:
   every verb is rendered with a figure in every money-sounding key of its data bag, and its title and body must carry none of
   them - no figure, no "$", no "Amount:" or "Balance due:" label left without its figure, no empty brackets. The owner payment
   emails are built from the same templates, so they carry none either.

   And the other half of the ruling: a customer's own words are never touched. A text-message alert's preview keeps a "$500"
   exactly as the customer typed it. (The route that serves bells is in permission-costs-db.test.ts.)
   ========================================================================== */

import { describe, it, expect } from 'vitest';
import { renderTemplate, VERB_RULES } from '../services/notifications/templates';
import { BILLING_ALERT_VERBS } from '../services/notifications/invoiceBillingAlerts';
import { withoutMoneyFields } from '../lib/permissions/prices';

const SENTINEL = '8675.31';
/** Every key a bell's data bag has carried a figure under, or could (a new verb that names its figure under another key adds it here). */
const MONEY_KEYS = [
  'amount', 'total', 'total_amount', 'deposit_amount', 'refund_amount', 'refunded_amount', 'balance', 'amount_due', 'price', 'charged_amount',
  'payout_amount', 'fee', 'net', 'tip', 'unit_price', 'subtotal',
];
const moneyData = () => ({
  ...Object.fromEntries(MONEY_KEYS.map((k) => [k, SENTINEL])),
  // The other facts bells are made from, so each template renders its normal sentence.
  object_label: 'INV-1', customer_name: 'Pat Payer', variant: 'bank_return', cleared: 'yes', customer_notice: 'sent', outcome: 'WON',
  reason: 'OVERPAYMENT', reason_words: 'Product not received', refund_kind: 'bank', object_kind: 'INVOICE', evidence_due: 'Nov 3',
});

describe('M4: no bell names an amount, to anyone (table over every notification verb)', () => {
  const verbs = Object.keys(VERB_RULES);

  it('knows the verbs it is meant to cover', () => {
    expect(verbs.length).toBeGreaterThan(60);
    for (const v of ['billing.payment_received', 'billing.refunded', 'billing.disputed', 'billing.bank_payment_failed', 'estimate.deposit_paid', 'estimate.approved', 'billing.payouts_pending_first_payment']) {
      expect(verbs, v).toContain(v);
    }
    // Every billing verb the owner emails are sent for is in the registry.
    for (const v of BILLING_ALERT_VERBS) expect(verbs, v).toContain(v);
  });

  it.each(verbs)('%s: its title and body carry no figure, no "$" and no label left without its figure', (verb) => {
    for (const variant of [moneyData(), { ...moneyData(), variant: undefined, cleared: 'no', outcome: 'LOST', reason: 'INVOICE_NOT_FOUND', refund_kind: undefined }]) {
      const t = renderTemplate(verb, variant);
      const text = `${t.title}\n${t.body ?? ''}`;
      expect(text, verb).not.toContain(SENTINEL);
      expect(text, verb).not.toContain('8675');
      expect(text, verb).not.toMatch(/\$\s*\d/);
      expect(text, verb).not.toMatch(/\b(?:Amount|Balance due|Total|Deposit):/i);
      expect(text, verb).not.toContain('()');
      expect(text, verb).not.toMatch(/[:,(]\s*(?:\n|$)/);
      expect(text, verb).not.toMatch(/ {2,}/);
    }
  });

  it('the bank-return and dispute bells, which used to hang their whole sentence on the figure, still say what happened', () => {
    const base = { object_label: 'INV-1', customer_name: 'Pat Payer', variant: 'bank_return', cleared: 'yes', customer_notice: 'sent' };
    expect(renderTemplate('billing.chargeback', base).body).toBe(
      'This payment was taken back from your ServWave Payments balance. The invoice is open again and we emailed the customer a link to pay again.',
    );
    expect(renderTemplate('billing.disputed', { ...base, reason_words: 'Product not received' }).body).toBe('The bank took back this payment. Reason: Product not received.');
    expect(renderTemplate('billing.refund_failed', { ...base, refund_kind: 'bank' }).body).toBe(
      'A bank refund to Pat Payer failed. The money is back in your ServWave Payments balance and the customer still needs to be repaid.',
    );
  });

  it('a bell\'s data bag loses every money key, whatever its name, and keeps the rest', () => {
    const bag = { ...moneyData(), contract_price: 5, unit_cost: 3, preview: 'a note' };
    const kept = withoutMoneyFields(bag);
    for (const k of [...MONEY_KEYS.filter((m) => ['amount', 'total_amount', 'deposit_amount', 'refunded_amount', 'amount_due', 'unit_price', 'subtotal'].includes(m)), 'contract_price', 'unit_cost']) {
      expect(kept, k).not.toHaveProperty(k);
    }
    expect(kept).toMatchObject({ object_label: 'INV-1', customer_name: 'Pat Payer', preview: 'a note' });
  });
});

describe('M4: a bell never scans the words in it', () => {
  it('a text-message alert keeps the customer\'s "$500" exactly as typed', () => {
    const t = renderTemplate('communication.sms_inbound', { object_label: '+15555550100', customer_name: 'Pat Payer', preview: 'Can you do it for $500? Final offer, $450.' });
    expect(t.body).toBe('Can you do it for $500? Final offer, $450.');
  });

  it('an email-reply alert keeps the subject as the customer wrote it', () => {
    const t = renderTemplate('communication.email_inbound', { object_label: 'pat@example.test', customer_name: 'Pat Payer', subject: 'Re: Invoice INV-1 ($60.00)' });
    expect(t.body).toBe('Re: Invoice INV-1 ($60.00)');
  });
});
