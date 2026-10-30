/**
 * Payments go-live slice 32 - the copy and routing of the owner's payment notifications.
 * Pure: templates and recipients only. The events that raise them are covered in
 * owner-payment-notices-db.test.ts.
 */
import { describe, it, expect } from 'vitest';
import { renderTemplate, isKnownVerb, VERB_RULES } from '../templates';
import { resolveRecipients } from '../resolveRecipients';

const VENDOR_NAMES = /stripe|connect|plaid|resend|supabase|render\.com|\bach\b|ctm|calltracking/i;
const base = { organizationId: 'org1', actorId: null as string | null };

describe('bank payment notifications', () => {
  it('started and cleared are feed items on the invoice, with the amount', () => {
    const started = renderTemplate('billing.bank_payment_started', { object_label: 'I0001', customer_name: 'Pat Payer', amount: '250.00' });
    expect(started).toMatchObject({ category: 'BILLING', object_type: 'INVOICE', priority: 'FEED', needs_action: false });
    expect(started.title).toBe('Bank payment started for I0001 — Pat Payer');
    expect(started.body).toContain('$250.00');
    const cleared = renderTemplate('billing.bank_payment_cleared', { object_label: 'I0001', amount: '250.00' });
    expect(cleared).toMatchObject({ category: 'BILLING', object_type: 'INVOICE', priority: 'FEED', needs_action: false });
    expect(cleared.title).toBe('Bank payment cleared for I0001');
    expect(cleared.body).toContain('$250.00');
  });

  it('failed interrupts, and says whether the customer can pay again', () => {
    const open = renderTemplate('billing.bank_payment_failed', { object_label: 'I0001', amount: '250.00', pay_again: 'yes' });
    expect(open).toMatchObject({ priority: 'INTERRUPT', action_type: 'VIEW', needs_action: true, object_type: 'INVOICE' });
    expect(open.title).toBe('Bank payment failed for I0001');
    expect(open.body).toContain('$250.00');
    expect(open.body).toMatch(/pay again/i);
    const closed = renderTemplate('billing.bank_payment_failed', { object_label: 'I0001', amount: '250.00' });
    expect(closed.body).not.toMatch(/pay again/i);
  });
});

describe('dispute notifications', () => {
  it('opened carries the amount, the reason and the evidence deadline', () => {
    const t = renderTemplate('billing.disputed', {
      object_label: 'I0001', variant: 'card', amount: '300.00', reason_words: 'Fraudulent', evidence_due: 'October 20, 2026',
    });
    expect(t.title).toBe('Payment disputed for I0001');
    expect(t.body).toBe('Amount: $300.00. Reason: Fraudulent. Respond by October 20, 2026.');
  });

  it('a bank return after the payment cleared is worded as the bank taking it back', () => {
    const t = renderTemplate('billing.disputed', { object_label: 'I0001', variant: 'bank_return', amount: '300.00', reason_words: 'Insufficient funds' });
    expect(t.title).toBe('Bank returned the payment for I0001');
    expect(t.body).toBe('The bank took back $300.00. Reason: Insufficient funds.');
  });

  it('a chargeback and a partial chargeback say how much was taken back', () => {
    expect(renderTemplate('billing.chargeback', { object_label: 'I0001', variant: 'card', amount: '300.00' }).body)
      .toBe('Amount: $300.00 was taken back from your ServWave Payments balance.');
    const partial = renderTemplate('billing.chargeback', { object_label: 'I0001', variant: 'partial_chargeback', amount: '100.00' });
    expect(partial.body).toContain('$100.00');
    expect(partial.body).toMatch(/balance was not changed/);
  });

  it('closed (won, or ended without a chargeback) is a feed item with the amount', () => {
    const won = renderTemplate('billing.dispute_closed', { object_label: 'I0001', outcome: 'WON', amount: '300.00' });
    expect(won).toMatchObject({ category: 'BILLING', object_type: 'INVOICE', priority: 'FEED', needs_action: false });
    expect(won.title).toBe('Dispute won for I0001');
    expect(won.body).toBe('Amount: $300.00. It was decided in your favor and the payment stands.');
    const closed = renderTemplate('billing.dispute_closed', { object_label: 'I0001', outcome: 'CLOSED', amount: '300.00' });
    expect(closed.title).toBe('Dispute closed for I0001');
    expect(closed.body).toBe('Amount: $300.00. It ended without a chargeback.');
  });
});

describe('refund failed', () => {
  it('says the money is back in the balance and the customer still needs to be repaid', () => {
    const t = renderTemplate('billing.refund_failed', { object_label: 'I0001', customer_name: 'Pat Payer', amount: '40.00', refund_kind: 'bank' });
    expect(t).toMatchObject({ category: 'BILLING', object_type: 'INVOICE', priority: 'INTERRUPT', action_type: 'VIEW', needs_action: true });
    expect(t.title).toBe('Refund failed for I0001 — Pat Payer');
    expect(t.body).toBe('A bank refund of $40.00 to Pat Payer failed. The money is back in your ServWave Payments balance and the customer still needs to be repaid.');
  });

  it('a refund that is not a bank one says "A refund"; no customer name still reads', () => {
    const t = renderTemplate('billing.refund_failed', { object_label: 'I0001', amount: '40.00' });
    expect(t.body).toBe('A refund of $40.00 to the customer failed. The money is back in your ServWave Payments balance and the customer still needs to be repaid.');
  });
});

describe('payment could not be applied', () => {
  it('points at the Payments needing attention list, not at support, when the list can refund it', () => {
    for (const reason of ['INVOICE_NOT_FOUND', 'WRONG_ORG']) {
      const t = renderTemplate('billing.payment_unrecorded', { reason, object_kind: 'ORGANIZATION', payment_label: 'Card payment' });
      expect(t.body).toContain('Payments needing attention');
      expect(t.body).not.toMatch(/contact servwave support/i);
    }
  });
});

describe('account action needed', () => {
  it('the body is what to do, in ServWave words, when the notice supplies it', () => {
    const t = renderTemplate('billing.payments_action_needed', { what_to_do: 'Open Settings > Payments and upload the identity document ServWave Payments asks for.' });
    expect(t.body).toBe('Open Settings > Payments and upload the identity document ServWave Payments asks for.');
    expect(renderTemplate('billing.payments_action_needed', { object_label: 'Acme' }).body).toBeUndefined();
  });
});

describe('registry and routing', () => {
  const NEW_VERBS = [
    'billing.bank_payment_started', 'billing.bank_payment_cleared', 'billing.bank_payment_failed',
    'billing.dispute_closed', 'billing.refund_failed',
  ] as const;

  it('every new verb is known, event-timed, and records why it has no actor', () => {
    for (const verb of NEW_VERBS) {
      expect(isKnownVerb(verb), verb).toBe(true);
      expect(VERB_RULES[verb].timing).toBe('event');
      expect(VERB_RULES[verb].exception, verb).toBeTruthy();
    }
  });

  // S06.28: these five are told through the billing alerts' two lanes like the other invoice and payment alerts, never by a role.
  it('the people who must act are interrupted by a failure and a refund that failed, the rest feed; nobody is told for their role', () => {
    const expected: Record<string, string> = {
      'billing.bank_payment_started': 'FEED', 'billing.bank_payment_cleared': 'FEED', 'billing.bank_payment_failed': 'INTERRUPT',
      'billing.dispute_closed': 'FEED', 'billing.refund_failed': 'INTERRUPT',
    };
    for (const verb of NEW_VERBS) {
      expect(resolveRecipients({ ...base, verb, entity: { id: 'i1' } }), `${verb}: no role list`).toEqual([]);
      const r = resolveRecipients({ ...base, verb, entity: { id: 'i1', lane_two_ids: ['biller1'] } });
      expect(r.map((x) => x.userId), verb).toEqual(['biller1']);
      expect(r[0].priority, verb).toBe(expected[verb]);
    }
  });

  it('the account notices no longer cite the deleted webhook handler', () => {
    for (const verb of ['billing.payments_activated', 'billing.payouts_activated', 'billing.payments_action_needed', 'billing.payments_paused'] as const) {
      expect(VERB_RULES[verb].exception, verb).not.toMatch(/emitPaymentsNotif|webhook\.controller/);
      expect(VERB_RULES[verb].exception, verb).toMatch(/payment event reconciler|sendAccountNotices/);
    }
  });

  it('no payment notification names a vendor', () => {
    const data = {
      object_label: 'I0001', customer_name: 'Pat Payer', amount: '10.00', reason_words: 'Fraudulent', evidence_due: 'October 20, 2026',
      pay_again: 'yes', refund_kind: 'bank', what_to_do: 'Open Settings > Payments.', outcome: 'WON',
    };
    const verbs = [
      ...NEW_VERBS, 'billing.disputed', 'billing.chargeback', 'billing.payment_unrecorded',
      // The six payments-account alerts (S06.29), with and without the why line the managers carry.
      'billing.payments_activated', 'billing.payouts_activated', 'billing.payments_action_needed', 'billing.payments_paused',
      'billing.payments_disconnected', 'billing.payouts_pending_first_payment',
    ];
    for (const verb of verbs) {
      for (const variant of ['card', 'bank_return', 'partial_chargeback']) {
        for (const reason of ['AMOUNT_MISMATCH', 'INVOICE_NOT_FOUND', 'REFUND_UNMATCHED', 'OVERPAYMENT']) {
          for (const fallback_reason of ['', 'Nobody can change company settings.']) {
            const t = renderTemplate(verb, { ...data, variant, reason, fallback_reason });
            expect(`${t.title} ${t.body ?? ''}`, `${verb}/${variant}/${reason}`).not.toMatch(VENDOR_NAMES);
          }
        }
      }
    }
  });
});
