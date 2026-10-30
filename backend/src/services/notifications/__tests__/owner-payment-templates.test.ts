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

  it('failed interrupts and keeps its title', () => {
    const t = renderTemplate('billing.bank_payment_failed', { object_label: 'I0001', amount: '250.00', customer_notice: 'sent' });
    expect(t).toMatchObject({ priority: 'INTERRUPT', action_type: 'VIEW', needs_action: true, object_type: 'INVOICE' });
    expect(t.title).toBe('Bank payment failed for I0001');
  });

  // V7-13 part 2 (BE-13d, C-38): the alert says what really happened to the customer. Exact strings.
  it.each([
    ['sent', 'Amount: $250.00. No money moved. We emailed the customer a link to pay again.'],
    ['no_email', 'Amount: $250.00. No money moved. No email was sent because this customer has no email address on file. Contact them to pay again.'],
    ['bounced', 'Amount: $250.00. No money moved. No email was sent because earlier emails to this customer\u2019s address bounced. Contact them to pay again.'],
    ['not_sent', 'Amount: $250.00. No money moved. The email to the customer could not be sent. Contact them to pay again.'],
    // BE-13d: not_open on this path is the unchanged sentence; the C-38 sentence needs the cannot_pay marker (below).
    ['not_open', 'Amount: $250.00. No money moved. The invoice is no longer open for payment.'],
  ])('failed, customer_notice %s', (customer_notice, body) => {
    expect(renderTemplate('billing.bank_payment_failed', { object_label: 'I0001', amount: '250.00', customer_notice }).body).toBe(body);
  });

  it('failed, not_open with the cannot_pay marker (invoice PAID by another payment or DISPUTED) uses the C-38 sentence', () => {
    expect(renderTemplate('billing.bank_payment_failed', { object_label: 'I0001', amount: '250.00', customer_notice: 'not_open', cannot_pay: 'yes' }).body)
      .toBe('Amount: $250.00. No money moved. No email was sent because this invoice cannot be paid online right now.');
  });

  it('failed with no customer_notice key (a notice stored before this change) claims nothing about the customer', () => {
    expect(renderTemplate('billing.bank_payment_failed', { object_label: 'I0001', amount: '250.00' }).body).toBe('Amount: $250.00. No money moved.');
    // The old claim key alone no longer says anything about the customer.
    expect(renderTemplate('billing.bank_payment_failed', { object_label: 'I0001', amount: '250.00', pay_again: 'yes' }).body).toBe('Amount: $250.00. No money moved.');
  });
});

describe('bank return alert (billing.chargeback, variant bank_return)', () => {
  const render = (data: Record<string, string>) => renderTemplate('billing.chargeback', { object_label: 'I0001', variant: 'bank_return', amount: '300.00', ...data }).body;
  const TAKEN = 'Amount: $300.00 was taken back from your ServWave Payments balance.';
  const BEFORE = 'Amount: $300.00. The bank returned this payment before it cleared, so no money reached your ServWave Payments balance.';

  it('names the balance only when the marker says the debit had cleared', () => {
    expect(render({ cleared: 'yes' })).toBe(TAKEN);
    expect(render({ cleared: 'no' })).toBe(BEFORE);
    expect(render({})).toBe('Amount: $300.00.');
  });

  it.each([
    ['sent', 'The invoice is open again and we emailed the customer a link to pay again.', 'The invoice is still open and we emailed the customer a link to pay again.'],
    ['no_email', 'The invoice is open again. No email was sent because this customer has no email address on file. Contact them to pay again.', 'The invoice is still open. No email was sent because this customer has no email address on file. Contact them to pay again.'],
    ['bounced', 'The invoice is open again. No email was sent because earlier emails to this customer\u2019s address bounced. Contact them to pay again.', 'The invoice is still open. No email was sent because earlier emails to this customer\u2019s address bounced. Contact them to pay again.'],
    ['not_sent', 'The invoice is open again. The email to the customer could not be sent. Contact them to pay again.', 'The invoice is still open. The email to the customer could not be sent. Contact them to pay again.'],
  ])('ending for %s, cleared and not cleared', (customer_notice, yes, no) => {
    expect(render({ cleared: 'yes', customer_notice })).toBe(`${TAKEN} ${yes}`);
    expect(render({ cleared: 'no', customer_notice })).toBe(`${BEFORE} ${no}`);
  });

  it('not_open: the voided invoice stays voided; a PAID or DISPUTED one cannot be paid online (C-38, C-49)', () => {
    expect(render({ cleared: 'yes', customer_notice: 'not_open' })).toBe(`${TAKEN} The invoice stays voided, so the customer was not asked to pay.`);
    expect(render({ cleared: 'no', customer_notice: 'not_open' })).toBe(`${BEFORE} The invoice stays voided, so the customer was not asked to pay.`);
    expect(render({ cleared: 'yes', customer_notice: 'not_open', cannot_pay: 'yes' }))
      .toBe(`${TAKEN} No email was sent because this invoice cannot be paid online right now.`);
    expect(render({ cleared: 'no', customer_notice: 'not_open', cannot_pay: 'yes' }))
      .toBe(`${BEFORE} No email was sent because this invoice cannot be paid online right now.`);
  });

  it('no customer_notice key adds no ending', () => {
    expect(render({ cleared: 'yes' })).toBe(TAKEN);
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
  it('points at the Needs attention card on the Payments page, not at support, when the list can refund it', () => {
    for (const reason of ['INVOICE_NOT_FOUND', 'WRONG_ORG']) {
      const t = renderTemplate('billing.payment_unrecorded', { reason, object_kind: 'ORGANIZATION', payment_label: 'Card payment' });
      expect(t.body).toContain('Open Needs attention on the Payments page');
      expect(t.body).not.toMatch(/contact servwave support/i);
    }
  });
});

describe('account action needed', () => {
  it('the body is what to do, in ServWave words, when the notice supplies it', () => {
    const t = renderTemplate('billing.payments_action_needed', { what_to_do: 'Open Settings > ServWave Payments and upload the identity document ServWave Payments asks for.' });
    expect(t.body).toBe('Open Settings > ServWave Payments and upload the identity document ServWave Payments asks for.');
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
      pay_again: 'yes', customer_notice: 'sent', cleared: 'no', cannot_pay: 'yes', refund_kind: 'bank', what_to_do: 'Open Settings > ServWave Payments.', outcome: 'WON',
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
