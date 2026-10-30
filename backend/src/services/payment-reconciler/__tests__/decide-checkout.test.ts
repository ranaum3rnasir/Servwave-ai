/* =============================================================================
   Payments go-live slice 08 - the reconciler's decide step for completed card checkouts.

   decide(event, snapshot) is pure: a checkout.session.completed event plus a snapshot of the rows
   it touches (the owning org, the invoice read under its lock, any payment already booked for this
   session, the charge the session made) in, the ordered ledger actions out.

   The rule this slice exists for: money the processor captured is never only logged. A paid
   session either books a SUCCEEDED payment, or is written down as an unapplied capture.
   ========================================================================== */

import { describe, it, expect } from 'vitest';
import { decide, type CheckoutSnapshot, type CheckoutCompletedEvent } from '../decide';

const ORG = 'org_1';
const INVOICE = 'inv_1';
const CHARGE_TIME = new Date('2026-10-01T14:03:00Z');

function checkoutEvent(
  session: Partial<CheckoutCompletedEvent['data']['object']> = {},
  over: Partial<Omit<CheckoutCompletedEvent, 'data'>> = {},
): CheckoutCompletedEvent {
  return {
    id: 'evt_cs_1',
    type: 'checkout.session.completed',
    account: 'acct_1',
    created: Math.floor(new Date('2026-10-01T14:05:00Z').getTime() / 1000),
    ...over,
    data: {
      object: {
        id: 'cs_1',
        object: 'checkout.session',
        payment_intent: 'pi_1',
        payment_status: 'paid',
        amount_total: 50000,
        metadata: { invoiceId: INVOICE },
        ...session,
      },
    },
  };
}

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
  charge: { id: 'ch_1', createdAt: CHARGE_TIME, wallet: null, cardBrand: 'visa', cardLast4: '4242', bankName: null, bankLast4: null },
  ...over,
});

describe('decide: checkout.session.completed (paid)', () => {
  it('books a SUCCEEDED card payment, paid at the charge time, with the charge and session ids and how the customer paid, and closes the invoice\'s other open links', () => {
    expect(decide(checkoutEvent(), snapshot())).toEqual([{
      type: 'record_payment',
      organizationId: ORG,
      invoiceId: INVOICE,
      kind: 'STANDARD',
      method: 'CARD',
      state: 'SUCCEEDED',
      amountCents: 50000,
      tipCents: 0,
      paidAt: CHARGE_TIME,
      paysInFull: true,
      estimateClosed: false,
      processorPaymentIntentId: 'pi_1',
      processorChargeId: 'ch_1',
      checkoutSessionId: 'cs_1',
      connectedAccountId: 'acct_1',
      wallet: null,
      cardBrand: 'visa',
      cardLast4: '4242',
      bankName: null,
      bankLast4: null,
    }, { type: 'expire_open_checkouts', invoiceId: INVOICE }]);
  });
});

describe('decide: checkout.session.completed - nothing to do', () => {
  // Each case is set against the same event that does book, so the guard named is what turns the
  // booking off, not a decide step that books nothing at all.
  const types = (actions: ReturnType<typeof decide>) => actions.map((a) => a.type);

  it('a duplicate does nothing: the same event again, or another event for a session already booked', () => {
    expect(types(decide(checkoutEvent(), snapshot()))).toEqual(['record_payment', 'expire_open_checkouts']);
    expect(decide(checkoutEvent(), snapshot({ eventAlreadyProcessed: true }))).toEqual([]);
    // Already booked, so the invoice reads PAID: still no "not payable" capture for the same money.
    expect(decide(
      checkoutEvent({}, { id: 'evt_cs_resent' }),
      snapshot({ bookedPayment: { id: 'pay_1', state: 'SUCCEEDED', voided: false, amountCents: 50000, chargeId: 'ch_1' }, invoice: { ...snapshot().invoice!, status: 'PAID', amountDueCents: 0 } }),
    )).toEqual([]);
  });

  it('money already written down as not applied for this session is not written down again under another event id', () => {
    const voided = { ...snapshot().invoice!, status: 'VOIDED' as const };
    expect(types(decide(checkoutEvent(), snapshot({ invoice: voided })))).toEqual(['record_unapplied_capture']);
    expect(decide(checkoutEvent({}, { id: 'evt_cs_resent' }), snapshot({ invoice: voided, captureRecorded: true }))).toEqual([]);
    // On the org too, when no invoice of the org can carry the money.
    expect(types(decide(checkoutEvent(), snapshot({ invoice: null })))).toEqual(['record_unapplied_capture']);
    expect(decide(checkoutEvent({}, { id: 'evt_cs_resent' }), snapshot({ invoice: null, captureRecorded: true }))).toEqual([]);
  });

  it('an event for a connected account ServWave does not know is not ours: no actions, no capture', () => {
    expect(types(decide(checkoutEvent(), snapshot()))).toEqual(['record_payment', 'expire_open_checkouts']);
    // The same session and invoice, but no org owns the account: nothing, not even a capture.
    expect(decide(checkoutEvent(), snapshot({ organization: null }))).toEqual([]);
    expect(decide(checkoutEvent(), snapshot({ organization: null, invoice: null }))).toEqual([]);
  });

  it('only a paid session books a SUCCEEDED card payment: an unpaid one is a bank debit still clearing (slice 13), and any other status books nothing', () => {
    expect(decide(checkoutEvent({ payment_status: 'paid' }), snapshot())[0]).toMatchObject({ type: 'record_payment', method: 'CARD', state: 'SUCCEEDED' });
    expect(decide(checkoutEvent({ payment_status: 'unpaid' }), snapshot())[0]).toMatchObject({ type: 'record_payment', method: 'ACH', state: 'PROCESSING' });
    expect(decide(checkoutEvent({ payment_status: 'no_payment_required' }), snapshot())).toEqual([]);
  });

  it('a session ServWave did not build (no invoice in its metadata) is not ours', () => {
    expect(types(decide(checkoutEvent({ metadata: { invoiceId: INVOICE } }), snapshot()))).toEqual(['record_payment', 'expire_open_checkouts']);
    expect(decide(checkoutEvent({ metadata: {} }), snapshot())).toEqual([]);
  });
});

describe('decide: checkout.session.completed - money captured that cannot be applied', () => {
  /** The one action a paid session that cannot be applied must produce. */
  const capture = (over: Record<string, unknown>) => ({
    type: 'record_unapplied_capture',
    organizationId: ORG,
    invoice: { id: INVOICE, invoiceNumber: 'INV-0001' },
    paymentLabel: 'Card payment',
    expectedCents: 50000,
    chargedCents: 50000,
    processorPaymentIntentId: 'pi_1',
    checkoutSessionId: 'cs_1',
    ...over,
  });
  const invoiceWith = (over: Partial<NonNullable<CheckoutSnapshot['invoice']>>) => ({ ...snapshot().invoice!, ...over });

  it('not payable: the invoice was voided (or paid another way) before the checkout completed', () => {
    expect(decide(checkoutEvent(), snapshot({ invoice: invoiceWith({ status: 'VOIDED' }) })))
      .toEqual([capture({ reason: 'INVOICE_NOT_PAYABLE', invoiceStatus: 'VOIDED' })]);
  });

  // Payments go-live slice 09 (conductor note from slice 08 acceptance): the audit read "expected
  // 0, charged 12345" for an invoice already paid. It records the invoice total and why it was closed.
  it('not payable because already paid: records the invoice total as expected and the status that closed it', () => {
    const paid = invoiceWith({ status: 'PAID', amountDueCents: 0, totalCents: 12345 });
    expect(decide(checkoutEvent({ amount_total: 12345 }), snapshot({ invoice: paid })))
      .toEqual([capture({ reason: 'INVOICE_NOT_PAYABLE', expectedCents: 12345, chargedCents: 12345, invoiceStatus: 'PAID' })]);
  });

  it('not found: the invoice the session names does not exist; recorded on the org, no invoice touched', () => {
    expect(decide(checkoutEvent(), snapshot({ invoice: null })))
      .toEqual([capture({ reason: 'INVOICE_NOT_FOUND', invoice: null, expectedCents: null })]);
  });

  it('wrong org: the invoice belongs to another org; recorded on the org the money landed in, the other org untouched', () => {
    expect(decide(checkoutEvent(), snapshot({ invoice: invoiceWith({ organizationId: 'org_other' }) })))
      .toEqual([capture({ reason: 'WRONG_ORG', invoice: null, expectedCents: null })]);
    // The org the session was built for (slice 12 metadata) must be the org the money landed in.
    expect(decide(checkoutEvent({ metadata: { invoiceId: INVOICE, organizationId: 'org_other' } }), snapshot()))
      .toEqual([capture({ reason: 'WRONG_ORG', invoice: null, expectedCents: null })]);
  });

  it('amount mismatch: charged more or less than the invoice owes (plus the tip)', () => {
    expect(decide(checkoutEvent({ amount_total: 49999 }), snapshot()))
      .toEqual([capture({ reason: 'AMOUNT_MISMATCH', chargedCents: 49999 })]);
    expect(decide(checkoutEvent({ amount_total: 52000, metadata: { invoiceId: INVOICE, tipCents: '1000' } }), snapshot()))
      .toEqual([capture({ reason: 'AMOUNT_MISMATCH', expectedCents: 51000, chargedCents: 52000 })]);
  });

  it('amount mismatch: a missing or non-numeric charged amount, or a malformed tip, never books a payment', () => {
    expect(decide(checkoutEvent({ amount_total: null }), snapshot()))
      .toEqual([capture({ reason: 'AMOUNT_MISMATCH', chargedCents: null })]);
    expect(decide(checkoutEvent({ metadata: { invoiceId: INVOICE, tipCents: '-500' } }), snapshot()))
      .toEqual([capture({ reason: 'AMOUNT_MISMATCH' })]);
    expect(decide(checkoutEvent({ metadata: { invoiceId: INVOICE, tipCents: 'abc' } }), snapshot()))
      .toEqual([capture({ reason: 'AMOUNT_MISMATCH' })]);
  });

  it('amount mismatch: a session opened under the retired card fee is no longer booked at face', () => {
    // $500 + the old 3.5% fee ($17.50). The fee is gone, so the charge does not match what is owed.
    expect(decide(checkoutEvent({ amount_total: 51750, metadata: { invoiceId: INVOICE, serviceFeeCents: '1750' } }), snapshot()))
      .toEqual([capture({ reason: 'AMOUNT_MISMATCH', chargedCents: 51750 })]);
  });

  it('amount mismatch: judged against the balance read under the lock, not the one the session was built on', () => {
    // A $200 staff payment landed while the customer was paying: $300 is owed now, $500 was charged.
    expect(decide(checkoutEvent(), snapshot({ invoice: invoiceWith({ status: 'PARTIAL', amountDueCents: 30000 }) })))
      .toEqual([capture({ reason: 'AMOUNT_MISMATCH', expectedCents: 30000 })]);
  });

  it('amount mismatch: the payable-now figure the session was built against must be what was charged', () => {
    expect(decide(checkoutEvent({ metadata: { invoiceId: INVOICE, payableNowCents: '40000' } }), snapshot()))
      .toEqual([capture({ reason: 'AMOUNT_MISMATCH' })]);
  });

  it('a bank payment still clearing is not owed twice: the card pays what is payable now, and the invoice is not yet paid in full', () => {
    const [action] = decide(
      checkoutEvent({ amount_total: 30000, metadata: { invoiceId: INVOICE, payableNowCents: '30000' } }),
      snapshot({ invoice: invoiceWith({ status: 'PARTIAL', amountDueCents: 50000, processingCents: 20000 }) }),
    );
    expect(action).toMatchObject({ type: 'record_payment', amountCents: 30000, paysInFull: false });
  });

  it('document mismatch: the session was built for a deposit and names an ordinary invoice (or the other way round)', () => {
    expect(decide(checkoutEvent({ metadata: { invoiceId: INVOICE, kind: 'deposit' } }), snapshot()))
      .toEqual([capture({ reason: 'DOCUMENT_MISMATCH' })]);
    expect(decide(checkoutEvent({ metadata: { invoiceId: INVOICE, kind: 'invoice' } }), snapshot({ invoice: invoiceWith({ kind: 'DEPOSIT' }) })))
      .toEqual([capture({ reason: 'DOCUMENT_MISMATCH' })]);
  });

  it('deposit superseded: the estimate changed after the deposit was sent', () => {
    expect(decide(checkoutEvent(), snapshot({ invoice: invoiceWith({ kind: 'DEPOSIT', depositHold: 'SUPERSEDED' }) })))
      .toEqual([capture({ reason: 'DEPOSIT_SUPERSEDED' })]);
  });

  it('a deposit on a closed estimate is still recorded, flagged so apply does not win the estimate', () => {
    const [action] = decide(checkoutEvent(), snapshot({ invoice: invoiceWith({ kind: 'DEPOSIT', estimateClosed: true }) }));
    expect(action).toMatchObject({ type: 'record_payment', kind: 'DEPOSIT', amountCents: 50000, estimateClosed: true });
  });

  it('a deposit on an open estimate is not flagged closed', () => {
    const [action] = decide(checkoutEvent(), snapshot({ invoice: invoiceWith({ kind: 'DEPOSIT' }) }));
    expect(action).toMatchObject({ type: 'record_payment', estimateClosed: false });
  });

  it('deposit on hold: the estimate was sent back to draft', () => {
    expect(decide(checkoutEvent(), snapshot({ invoice: invoiceWith({ kind: 'DEPOSIT', depositHold: 'ESTIMATE_IN_DRAFT' }) })))
      .toEqual([capture({ reason: 'DEPOSIT_ON_HOLD' })]);
  });
});

describe('decide: checkout.session.completed - the accepted-methods gate is never consulted', () => {
  // The snapshot no longer carries the org's accepted methods, so nothing in decide() can gate on
  // them: money the processor took is recorded whatever the org turned off after the session opened.
  it('an org that has since turned card off still gets the payment it already took', () => {
    const [action] = decide(checkoutEvent(), snapshot());
    expect(action).toMatchObject({ type: 'record_payment', amountCents: 50000 });
  });

  it('a tip rides on the payment and is not applied to the invoice', () => {
    const [action] = decide(checkoutEvent({ amount_total: 55000, metadata: { invoiceId: INVOICE, tipCents: '5000' } }), snapshot());
    expect(action).toMatchObject({ type: 'record_payment', amountCents: 50000, tipCents: 5000, paysInFull: true });
  });

  // Payments go-live slice 26: a partial amount rides on the session (amountCents), so the
  // reconciler books exactly what the homeowner chose to pay and leaves the rest owing.
  it('a partial payment with a tip books the partial amount, the tip beside it, and does not pay the invoice in full', () => {
    const [action] = decide(
      checkoutEvent({ amount_total: 4600, metadata: { invoiceId: INVOICE, payableNowCents: '50000', amountCents: '4000', tipCents: '600' } }),
      snapshot(),
    );
    expect(action).toMatchObject({ type: 'record_payment', amountCents: 4000, tipCents: 600, paysInFull: false });
  });

  it('a partial amount that covers everything still owed pays the invoice in full', () => {
    const [action] = decide(
      checkoutEvent({ amount_total: 50000, metadata: { invoiceId: INVOICE, payableNowCents: '50000', amountCents: '50000' } }),
      snapshot(),
    );
    expect(action).toMatchObject({ type: 'record_payment', amountCents: 50000, paysInFull: true });
  });

  it('a partial amount above what is owed now, below $1, or not matching the charge is never booked', () => {
    const meta = (amountCents: string, extra: Record<string, string> = {}) => ({ invoiceId: INVOICE, payableNowCents: '50000', amountCents, ...extra });
    // Above what is owed now (a staff payment landed since the session was built).
    expect(decide(checkoutEvent({ amount_total: 60000, metadata: meta('60000') }), snapshot())[0])
      .toMatchObject({ type: 'record_unapplied_capture', reason: 'AMOUNT_MISMATCH', chargedCents: 60000 });
    expect(decide(checkoutEvent({ amount_total: 50, metadata: meta('50') }), snapshot()).map((a) => a.type)).toEqual(['record_unapplied_capture']);
    // The charge is not the partial amount plus the tip.
    expect(decide(checkoutEvent({ amount_total: 4700, metadata: meta('4000', { tipCents: '600' }) }), snapshot()).map((a) => a.type))
      .toEqual(['record_unapplied_capture']);
    // A malformed amount.
    expect(decide(checkoutEvent({ amount_total: 4000, metadata: meta('abc') }), snapshot()).map((a) => a.type)).toEqual(['record_unapplied_capture']);
  });

  it('no charge from the processor: paid at the time the event was created, with no display details', () => {
    const [action] = decide(checkoutEvent(), snapshot({ charge: null }));
    expect(action).toMatchObject({
      type: 'record_payment', paidAt: new Date('2026-10-01T14:05:00Z'), processorChargeId: null, cardBrand: null, cardLast4: null, wallet: null,
    });
  });
});
