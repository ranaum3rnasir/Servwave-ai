/* =============================================================================
   Payments go-live slice 13 - the reconciler's decide step for a bank (ACH) payment's lifecycle.

   A bank checkout completes UNPAID: the debit is in flight and can still fail days later. It is
   booked PROCESSING at once (so what can be paid online drops), and settles when the processor
   says the debit cleared (SUCCEEDED) or failed (FAILED). decide(event, snapshot) is pure: the
   event plus a snapshot of the rows it touches in, the ordered ledger actions out. It works from
   the snapshot, not from the order events arrive in.
   ========================================================================== */

import { describe, it, expect } from 'vitest';
import { decide, type CheckoutSnapshot, type CheckoutEvent } from '../decide';

const ORG = 'org_1';
const INVOICE = 'inv_1';
const CHARGE_TIME = new Date('2026-10-01T14:03:00Z');

type BankEventType = CheckoutEvent['type'];

function bankEvent(
  type: BankEventType,
  session: Partial<CheckoutEvent['data']['object']> = {},
  over: Partial<Omit<CheckoutEvent, 'data' | 'type'>> = {},
): CheckoutEvent {
  return {
    id: `evt_${type}`,
    type,
    account: 'acct_1',
    created: Math.floor(new Date('2026-10-01T14:05:00Z').getTime() / 1000),
    ...over,
    data: {
      object: {
        id: 'cs_bank_1',
        object: 'checkout.session',
        payment_intent: 'pi_bank_1',
        // A bank session completes unpaid; the async events carry the session once it settled.
        payment_status: type === 'checkout.session.completed' ? 'unpaid' : type === 'checkout.session.async_payment_succeeded' ? 'paid' : 'unpaid',
        amount_total: 50000,
        metadata: { invoiceId: INVOICE, organizationId: ORG, kind: 'invoice', payableNowCents: '50000' },
        ...session,
      },
    },
  } as CheckoutEvent;
}

const bankCharge = { id: 'py_1', createdAt: CHARGE_TIME, wallet: null, cardBrand: null, cardLast4: null, bankName: 'STRIPE TEST BANK', bankLast4: '6789' };

const snapshot = (over: Partial<CheckoutSnapshot> = {}): CheckoutSnapshot => ({
  eventAlreadyProcessed: false,
  organization: { id: ORG },
  invoice: {
    id: INVOICE,
    invoiceNumber: 'INV-0001',
    organizationId: ORG,
    status: 'SENT',
    kind: 'STANDARD',
    amountDueCents: 50000,
    totalCents: 50000,
    processingCents: 0,
    depositHold: null,
    estimateClosed: false,
  },
  bookedPayment: null,
  charge: bankCharge,
  ...over,
});

const types = (actions: ReturnType<typeof decide>) => actions.map((a) => a.type);

describe('decide: a bank checkout completes unpaid', () => {
  it('books a PROCESSING bank payment (bank name, last four, charge and session ids, paid at the charge time), closes the other open links, and says it started', () => {
    expect(decide(bankEvent('checkout.session.completed'), snapshot())).toEqual([
      {
        type: 'record_payment',
        organizationId: ORG,
        invoiceId: INVOICE,
        kind: 'STANDARD',
        method: 'ACH',
        state: 'PROCESSING',
        amountCents: 50000,
        tipCents: 0,
        paidAt: CHARGE_TIME,
        paysInFull: true,
        estimateClosed: false,
        processorPaymentIntentId: 'pi_bank_1',
        processorChargeId: 'py_1',
        checkoutSessionId: 'cs_bank_1',
        connectedAccountId: 'acct_1',
        wallet: null,
        cardBrand: null,
        cardLast4: null,
        bankName: 'STRIPE TEST BANK',
        bankLast4: '6789',
      },
      { type: 'expire_open_checkouts', invoiceId: INVOICE },
      { type: 'notify_bank_payment', kind: 'started', invoiceId: INVOICE, amountCents: 50000, deposit: false, payAgain: false },
    ]);
  });
});

describe('decide: a bank checkout completes before its charge exists (account entered by hand, micro-deposits verified later)', () => {
  it('books the PROCESSING payment with the bank from the payment method, no charge id yet, paid at the event time', () => {
    const [record] = decide(bankEvent('checkout.session.completed'), snapshot({ charge: null, bankAccount: { bankName: 'STRIPE TEST BANK', bankLast4: '6789' } }));
    expect(record).toMatchObject({
      type: 'record_payment', method: 'ACH', state: 'PROCESSING',
      processorChargeId: null, bankName: 'STRIPE TEST BANK', bankLast4: '6789',
      paidAt: new Date('2026-10-01T14:05:00Z'),
    });
  });
});

const processing = { id: 'pay_1', state: 'PROCESSING' as const, voided: false, amountCents: 50000, chargeId: 'py_1' };

describe('decide: the bank debit clears or fails', () => {
  it('cleared: the PROCESSING payment settles to SUCCEEDED, and the customer and owner hear it cleared', () => {
    expect(decide(bankEvent('checkout.session.async_payment_succeeded'), snapshot({ bookedPayment: processing }))).toEqual([
      { type: 'settle_payment', paymentId: 'pay_1', invoiceId: INVOICE, to: 'SUCCEEDED' },
      { type: 'notify_bank_payment', kind: 'cleared', invoiceId: INVOICE, amountCents: 50000, deposit: false, payAgain: false },
    ]);
  });

  it('failed: the PROCESSING payment settles to FAILED, and the customer is sent a link to pay again', () => {
    expect(decide(bankEvent('checkout.session.async_payment_failed'), snapshot({ bookedPayment: processing }))).toEqual([
      { type: 'settle_payment', paymentId: 'pay_1', invoiceId: INVOICE, to: 'FAILED' },
      { type: 'notify_bank_payment', kind: 'failed', invoiceId: INVOICE, amountCents: 50000, deposit: false, payAgain: true },
    ]);
  });

  it('duplicates change nothing: the same event again, or an outcome for a payment already settled, failed by a return, or voided', () => {
    const cleared = bankEvent('checkout.session.async_payment_succeeded');
    const failed = bankEvent('checkout.session.async_payment_failed');
    expect(types(decide(cleared, snapshot({ bookedPayment: processing })))).toEqual(['settle_payment', 'notify_bank_payment']);
    expect(decide(cleared, snapshot({ bookedPayment: processing, eventAlreadyProcessed: true }))).toEqual([]);
    expect(decide(cleared, snapshot({ bookedPayment: { ...processing, state: 'SUCCEEDED' } }))).toEqual([]);
    expect(decide(cleared, snapshot({ bookedPayment: { ...processing, state: 'FAILED' } }))).toEqual([]);
    expect(decide(cleared, snapshot({ bookedPayment: { ...processing, voided: true } }))).toEqual([]);
    expect(decide(failed, snapshot({ bookedPayment: { ...processing, state: 'FAILED' } }))).toEqual([]);
    expect(decide(failed, snapshot({ bookedPayment: { ...processing, state: 'SUCCEEDED' } }))).toEqual([]);
    // The completed event again, once the payment is booked (or already settled): nothing.
    expect(decide(bankEvent('checkout.session.completed', {}, { id: 'evt_resent' }), snapshot({ bookedPayment: processing }))).toEqual([]);
  });

  it('a debit booked before its charge existed (micro-deposit verification came after the checkout) gets the charge id, bank and paid-at filled in when it settles', () => {
    // Booked from the completed event with no charge yet: no charge id on the row.
    const noCharge = { ...processing, chargeId: null };
    const settleFill = { id: 'py_1', paidAt: CHARGE_TIME, bankName: 'STRIPE TEST BANK', bankLast4: '6789' };
    expect(decide(bankEvent('checkout.session.async_payment_succeeded'), snapshot({ bookedPayment: noCharge }))).toEqual([
      { type: 'settle_payment', paymentId: 'pay_1', invoiceId: INVOICE, to: 'SUCCEEDED', charge: settleFill },
      { type: 'notify_bank_payment', kind: 'cleared', invoiceId: INVOICE, amountCents: 50000, deposit: false, payAgain: false },
    ]);
    expect(decide(bankEvent('checkout.session.async_payment_failed'), snapshot({ bookedPayment: noCharge }))[0])
      .toEqual({ type: 'settle_payment', paymentId: 'pay_1', invoiceId: INVOICE, to: 'FAILED', charge: settleFill });
    // Still no charge to read (the processor could not return it): settled with nothing to fill.
    expect(decide(bankEvent('checkout.session.async_payment_succeeded'), snapshot({ bookedPayment: noCharge, charge: null }))[0])
      .toEqual({ type: 'settle_payment', paymentId: 'pay_1', invoiceId: INVOICE, to: 'SUCCEEDED' });
  });

  it('an outcome for an account ServWave does not know is not ours', () => {
    expect(decide(bankEvent('checkout.session.async_payment_succeeded'), snapshot({ bookedPayment: processing, organization: null }))).toEqual([]);
  });
});

describe('decide: events out of order (judged from the snapshot, not the order they arrive in)', () => {
  it('cleared before completed: the bank payment is booked SUCCEEDED at once and the other open links close, and the late completion then books nothing', () => {
    const actions = decide(bankEvent('checkout.session.async_payment_succeeded'), snapshot());
    expect(actions).toEqual([
      expect.objectContaining({ type: 'record_payment', method: 'ACH', state: 'SUCCEEDED', amountCents: 50000, paidAt: CHARGE_TIME, paysInFull: true, bankLast4: '6789' }),
      { type: 'expire_open_checkouts', invoiceId: INVOICE },
      { type: 'notify_bank_payment', kind: 'cleared', invoiceId: INVOICE, amountCents: 50000, deposit: false, payAgain: false },
    ]);
    const booked = { id: 'pay_1', state: 'SUCCEEDED' as const, voided: false, amountCents: 50000, chargeId: 'py_1' };
    const paid = { ...snapshot().invoice!, status: 'PAID' as const, amountDueCents: 0 };
    expect(decide(bankEvent('checkout.session.completed'), snapshot({ bookedPayment: booked, invoice: paid }))).toEqual([]);
  });

  it('cleared before completed on an invoice that can no longer take it: the money is written down as a bank payment not applied', () => {
    const voided = { ...snapshot().invoice!, status: 'VOIDED' as const };
    expect(decide(bankEvent('checkout.session.async_payment_succeeded'), snapshot({ invoice: voided }))).toEqual([
      expect.objectContaining({ type: 'record_unapplied_capture', reason: 'INVOICE_NOT_PAYABLE', paymentLabel: 'Bank payment', chargedCents: 50000 }),
    ]);
  });

  it('failed before completed: the failed debit is written down FAILED (it counts nowhere), so the late completion books nothing', () => {
    expect(decide(bankEvent('checkout.session.async_payment_failed'), snapshot())).toEqual([
      expect.objectContaining({ type: 'record_payment', method: 'ACH', state: 'FAILED', amountCents: 50000 }),
      { type: 'notify_bank_payment', kind: 'failed', invoiceId: INVOICE, amountCents: 50000, deposit: false, payAgain: true },
    ]);
    const failedRow = { id: 'pay_1', state: 'FAILED' as const, voided: false, amountCents: 50000, chargeId: null };
    expect(decide(bankEvent('checkout.session.completed'), snapshot({ bookedPayment: failedRow }))).toEqual([]);
    // Never on another org's invoice, and not for an account ServWave does not know.
    const foreign = { ...snapshot().invoice!, organizationId: 'org_2' };
    expect(decide(bankEvent('checkout.session.async_payment_failed'), snapshot({ invoice: foreign }))).toEqual([]);
    expect(decide(bankEvent('checkout.session.async_payment_failed'), snapshot({ invoice: null }))).toEqual([]);
  });

  it('a bank checkout books PROCESSING only on an invoice it applies to; on one it cannot apply to it books nothing yet: no money has moved', () => {
    // The same completion on an invoice it applies to is booked PROCESSING ...
    expect(types(decide(bankEvent('checkout.session.completed'), snapshot())))
      .toEqual(['record_payment', 'expire_open_checkouts', 'notify_bank_payment']);
    // ... and on one it cannot apply to (closed, a different amount, no such invoice) nothing is
    // booked or written down: no money has moved yet, and a debit that clears is written down then.
    expect(decide(bankEvent('checkout.session.completed'), snapshot({ invoice: { ...snapshot().invoice!, status: 'VOIDED' } }))).toEqual([]);
    expect(decide(bankEvent('checkout.session.completed', { amount_total: 49999 }), snapshot())).toEqual([]);
    expect(decide(bankEvent('checkout.session.completed'), snapshot({ invoice: null }))).toEqual([]);
  });
});

describe('decide: a deposit paid by bank under "deposit required" (call 3)', () => {
  const depositInvoice = { ...snapshot().invoice!, kind: 'DEPOSIT' as const };
  const deposit = (type: BankEventType) => bankEvent(type, { metadata: { invoiceId: INVOICE, organizationId: ORG, kind: 'deposit', payableNowCents: '50000' } });

  it('when the debit starts, the deposit is booked PROCESSING for the whole deposit: the signal that approves the estimate and wins the lead', () => {
    const actions = decide(deposit('checkout.session.completed'), snapshot({ invoice: depositInvoice }));
    expect(actions[0]).toMatchObject({ type: 'record_payment', kind: 'DEPOSIT', method: 'ACH', state: 'PROCESSING', paysInFull: true });
    expect(actions[2]).toEqual({ type: 'notify_bank_payment', kind: 'started', invoiceId: INVOICE, amountCents: 50000, deposit: true, payAgain: false });
  });

  it('when the debit fails, the deposit invoice reopens for payment and the customer gets a pay-again link; nothing un-wins the estimate', () => {
    const won = { id: 'pay_1', state: 'PROCESSING' as const, voided: false, amountCents: 50000, chargeId: 'py_1' };
    expect(decide(deposit('checkout.session.async_payment_failed'), snapshot({ invoice: depositInvoice, bookedPayment: won }))).toEqual([
      { type: 'settle_payment', paymentId: 'pay_1', invoiceId: INVOICE, to: 'FAILED' },
      { type: 'notify_bank_payment', kind: 'failed', invoiceId: INVOICE, amountCents: 50000, deposit: true, payAgain: true },
    ]);
  });
});
