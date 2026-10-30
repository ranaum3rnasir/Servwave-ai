/* =============================================================================
   Payments go-live slice 07 - the reconciler's decide step, as a table.

   decide(event, snapshot) is pure: the processor event plus the ledger rows it touches in, the
   ordered ledger actions out. Refunds are keyed on the processor's refund id: a refund ServWave
   already wrote only changes state; a refund it never saw (made outside ServWave) is recorded
   once; a replayed event does nothing.
   ========================================================================== */

import { describe, it, expect } from 'vitest';
import { decide, type RefundSnapshot, type RefundEvent as ReconcilerEvent } from '../decide';

const PAYMENT = { id: 'pay_row_1', invoiceId: 'inv_1', method: 'CARD' as const, amountCents: 10000, extrasCents: 0 };

function refundEvent(
  type: 'refund.created' | 'refund.updated' | 'refund.failed',
  refund: { id?: string; amount?: number; status?: string; metadata?: Record<string, string> } = {},
  eventId = 'evt_1',
): ReconcilerEvent {
  return {
    id: eventId,
    type,
    account: 'acct_1',
    data: {
      object: {
        id: refund.id ?? 're_1',
        object: 'refund',
        amount: refund.amount ?? 5000,
        status: refund.status ?? 'succeeded',
        payment_intent: 'pi_1',
        charge: 'ch_1',
        metadata: refund.metadata ?? {},
      },
    },
  };
}

const snapshot = (over: Partial<RefundSnapshot> = {}): RefundSnapshot => ({
  eventAlreadyProcessed: false,
  organizationId: 'org_1',
  refund: null,
  payment: PAYMENT,
  ...over,
});

describe('decide: refund events', () => {
  it('refund.created for a refund ServWave already wrote (PENDING) moves only its state', () => {
    const actions = decide(
      refundEvent('refund.created', { status: 'succeeded' }),
      snapshot({ refund: { id: 'refund_row_1', invoiceId: 'inv_1', state: 'PENDING' } }),
    );
    expect(actions).toEqual([{ type: 'set_refund_state', refundId: 'refund_row_1', invoiceId: 'inv_1', to: 'SUCCEEDED' }]);
  });

  it('refund.created for a refund ServWave never wrote (made outside ServWave) records it once, by refund id', () => {
    const actions = decide(refundEvent('refund.created', { id: 're_outside', amount: 4000, status: 'succeeded' }), snapshot());
    expect(actions).toEqual([{
      type: 'record_refund',
      processorRefundId: 're_outside',
      invoiceId: 'inv_1',
      paymentId: 'pay_row_1',
      method: 'CARD',
      amountCents: 4000,
      state: 'SUCCEEDED',
    }, { type: 'record_outside_refund_history', processorRefundId: 're_outside', invoiceId: 'inv_1' }]);
  });

  it('a replayed event does nothing, even for a refund it would otherwise record', () => {
    expect(decide(refundEvent('refund.created'), snapshot({ eventAlreadyProcessed: true }))).toEqual([]);
    expect(decide(
      refundEvent('refund.failed'),
      snapshot({ eventAlreadyProcessed: true, refund: { id: 'refund_row_1', invoiceId: 'inv_1', state: 'SUCCEEDED' } }),
    )).toEqual([]);
  });

  it('refund.failed marks a recorded refund FAILED and raises the refund-failed notification', () => {
    const actions = decide(
      refundEvent('refund.failed', { status: 'failed' }),
      snapshot({ refund: { id: 'refund_row_1', invoiceId: 'inv_1', state: 'SUCCEEDED' } }),
    );
    expect(actions).toEqual([
      { type: 'set_refund_state', refundId: 'refund_row_1', invoiceId: 'inv_1', to: 'FAILED' },
      { type: 'notify_refund_failed', processorRefundId: 're_1', invoiceId: 'inv_1' },
    ]);
  });

  it('a refund already in the state the event reports, or already FAILED, is left alone', () => {
    const row = (state: 'PENDING' | 'SUCCEEDED' | 'FAILED') => snapshot({ refund: { id: 'refund_row_1', invoiceId: 'inv_1', state } });
    expect(decide(refundEvent('refund.created', { status: 'succeeded' }), row('SUCCEEDED'))).toEqual([]);
    expect(decide(refundEvent('refund.created', { status: 'pending' }), row('PENDING'))).toEqual([]);
    expect(decide(refundEvent('refund.failed'), row('FAILED'))).toEqual([]);
    // A FAILED refund gave nothing back; a late "succeeded" cannot bring it back.
    expect(decide(refundEvent('refund.updated', { status: 'succeeded' }), row('FAILED'))).toEqual([]);
    // A late "pending" never walks a settled refund backwards.
    expect(decide(refundEvent('refund.created', { status: 'pending' }), row('SUCCEEDED'))).toEqual([]);
  });

  it('refund.updated pending -> succeeded settles a bank refund', () => {
    expect(decide(
      refundEvent('refund.updated', { status: 'succeeded' }),
      snapshot({ refund: { id: 'refund_row_1', invoiceId: 'inv_1', state: 'PENDING' } }),
    )).toEqual([{ type: 'set_refund_state', refundId: 'refund_row_1', invoiceId: 'inv_1', to: 'SUCCEEDED' }]);
  });

  it('a refund made outside ServWave that has already failed is recorded FAILED (never counted) and notified', () => {
    expect(decide(refundEvent('refund.failed', { id: 're_outside', status: 'failed' }), snapshot())).toEqual([
      { type: 'record_refund', processorRefundId: 're_outside', invoiceId: 'inv_1', paymentId: 'pay_row_1', method: 'CARD', amountCents: 5000, state: 'FAILED' },
      { type: 'notify_refund_failed', processorRefundId: 're_outside', invoiceId: 'inv_1' },
    ]);
  });

  it('refund.updated arriving before refund.created ends with one row', () => {
    // The ledger the two events see: empty for the first, the row the first wrote for the second.
    const first = decide(refundEvent('refund.updated', { id: 're_ooo', status: 'succeeded' }, 'evt_updated'), snapshot());
    expect(first.filter((a) => a.type === 'record_refund')).toHaveLength(1);
    const second = decide(
      refundEvent('refund.created', { id: 're_ooo', status: 'succeeded' }, 'evt_created'),
      snapshot({ refund: { id: 'refund_row_ooo', invoiceId: 'inv_1', state: 'SUCCEEDED' } }),
    );
    expect(second).toEqual([]);
  });

  it('a refund on a legacy charge that carried a card fee and a tip books only the face share', () => {
    // $100 face + $3.50 fee + $10 tip = $113.50 charged. Half of it refunded (5675c) is $50 face.
    const legacy = snapshot({ payment: { ...PAYMENT, amountCents: 10000, extrasCents: 1350 } });
    const [action] = decide(refundEvent('refund.created', { amount: 5675 }), legacy);
    expect(action).toMatchObject({ type: 'record_refund', amountCents: 5000 });
  });

  it('a refund made outside ServWave that is still PENDING gets no history yet: it has given nothing back (slice 08)', () => {
    // Landed: the refund and its history.
    expect(decide(refundEvent('refund.created', { id: 're_bank', status: 'succeeded' }), snapshot()).map((a) => a.type))
      .toEqual(['record_refund', 'record_outside_refund_history']);
    // Still on its way: the refund only.
    const actions = decide(refundEvent('refund.created', { id: 're_bank', status: 'pending' }), snapshot());
    expect(actions.map((a) => a.type)).toEqual(['record_refund']);
    expect(actions[0]).toMatchObject({ state: 'PENDING' });
  });

  it('...and gets its history once, when it lands; a refund ServWave made never does (slice 08)', () => {
    const outside = { id: 'refund_row_1', invoiceId: 'inv_1', state: 'PENDING' as const, external: true };
    expect(decide(refundEvent('refund.updated', { id: 're_bank', status: 'succeeded' }), snapshot({ refund: outside }))).toEqual([
      { type: 'set_refund_state', refundId: 'refund_row_1', invoiceId: 'inv_1', to: 'SUCCEEDED' },
      { type: 'record_outside_refund_history', processorRefundId: 're_bank', invoiceId: 'inv_1' },
    ]);
    // A refund that fails never had money go back, so it never gets the history.
    expect(decide(refundEvent('refund.failed', { id: 're_bank' }), snapshot({ refund: outside })).map((a) => a.type))
      .toEqual(['set_refund_state', 'notify_refund_failed']);
    // An in-app refund wrote its own history when staff made it.
    const inApp = { ...outside, external: false };
    expect(decide(refundEvent('refund.updated', { id: 're_bank', status: 'succeeded' }), snapshot({ refund: inApp })).map((a) => a.type))
      .toEqual(['set_refund_state']);
  });

  it('a refund for a charge ServWave never recorded is written down where the owner finds it, not only logged (slice 08)', () => {
    expect(decide(refundEvent('refund.created', { id: 're_stray', amount: 2500 }), snapshot({ payment: null }))).toEqual([{
      type: 'record_unapplied_capture',
      reason: 'REFUND_UNMATCHED',
      organizationId: 'org_1',
      invoice: null,
      paymentLabel: 'Refund',
      expectedCents: null,
      chargedCents: 2500,
      processorPaymentIntentId: 'pi_1',
      checkoutSessionId: null,
      processorRefundId: 're_stray',
    }]);
  });

  it('a stray refund is written down once, not once per event the processor sends for it (slice 08)', () => {
    expect(decide(refundEvent('refund.created', { id: 're_stray' }, 'evt_1'), snapshot({ payment: null })).map((a) => a.type))
      .toEqual(['record_unapplied_capture']);
    expect(decide(refundEvent('refund.updated', { id: 're_stray' }, 'evt_2'), snapshot({ payment: null, unmatchedRefundRecorded: true }))).toEqual([]);
  });

  it("a refund carrying ServWave's in-app marker but no row is booked as made outside ServWave (slice 08)", () => {
    // Only the platform can set the marker, but with no row behind it nothing proves a staff
    // member made it: it gets the outside-refund history and audit row.
    expect(decide(refundEvent('refund.created', { status: 'succeeded', metadata: { source: 'in_app' } }), snapshot())).toEqual([
      { type: 'record_refund', processorRefundId: 're_1', invoiceId: 'inv_1', paymentId: 'pay_row_1', method: 'CARD', amountCents: 5000, state: 'SUCCEEDED' },
      { type: 'record_outside_refund_history', processorRefundId: 're_1', invoiceId: 'inv_1' },
    ]);
  });
});

// Payments go-live slice 11: the refund ServWave sends from "Payments needing attention".
describe('decide: the refund sent for a payment needing attention', () => {
  const attention = (status: 'OPEN' | 'REFUNDED' | 'RESOLVED', refundId: string | null = null, paymentId: string | null = null) =>
    ({ id: 'uc_1', status, refundId, paymentId });

  it('marks its record REFUNDED and writes nothing else when the money never sat on a payment row', () => {
    expect(decide(refundEvent('refund.created'), snapshot({ attentionRecord: attention('OPEN') })))
      .toEqual([{ type: 'mark_unapplied_capture_refunded', recordId: 'uc_1', processorRefundId: 're_1', refundCents: 5000, closes: false }]);
    expect(decide(refundEvent('refund.updated', { status: 'pending' }), snapshot({ payment: null, attentionRecord: attention('OPEN') })))
      .toEqual([{ type: 'mark_unapplied_capture_refunded', recordId: 'uc_1', processorRefundId: 're_1', refundCents: 5000, closes: false }]);
  });

  it('V7-09b: the action carries the refund\'s cents and whether it gives back the whole rest, so a partial refund does not close the record', () => {
    expect(decide(refundEvent('refund.created', { amount: 4000 }), snapshot({ attentionRecord: attention('OPEN') })))
      .toEqual([{ type: 'mark_unapplied_capture_refunded', recordId: 'uc_1', processorRefundId: 're_1', refundCents: 4000, closes: false }]);
    expect(decide(refundEvent('refund.created', { amount: 4000, metadata: { unapplied_capture_closes: '1' } }), snapshot({ attentionRecord: attention('OPEN') })))
      .toEqual([{ type: 'mark_unapplied_capture_refunded', recordId: 'uc_1', processorRefundId: 're_1', refundCents: 4000, closes: true }]);
  });

  it('does nothing once the record already reads REFUNDED (the list stored it first)', () => {
    expect(decide(refundEvent('refund.updated'), snapshot({ payment: null, attentionRecord: attention('REFUNDED', 're_1') }))).toEqual([]);
  });

  it('a failed refund reopens the record it refunded, and only that refund', () => {
    expect(decide(refundEvent('refund.failed', { status: 'failed' }), snapshot({ payment: null, attentionRecord: attention('REFUNDED', 're_1') })))
      .toEqual([{ type: 'reopen_unapplied_capture', recordId: 'uc_1', processorRefundId: 're_1', refundCents: 5000 }]);
    // Another refund holds the record: it stays REFUNDED; the failure is only kept on it.
    expect(decide(refundEvent('refund.failed', { status: 'failed' }), snapshot({ payment: null, attentionRecord: attention('REFUNDED', 're_other') })))
      .toEqual([{ type: 'note_unapplied_capture_refund_failed', recordId: 'uc_1', processorRefundId: 're_1', refundCents: 5000 }]);
  });

  // Fix round 2: the processor does not promise event order. A refund known to have failed never
  // marks its record REFUNDED, whatever arrives after the failure.
  it('a failure that lands while the record is still OPEN is kept on the record, and changes nothing else', () => {
    expect(decide(refundEvent('refund.failed', { status: 'failed' }), snapshot({ payment: null, attentionRecord: attention('OPEN') })))
      .toEqual([{ type: 'note_unapplied_capture_refund_failed', recordId: 'uc_1', processorRefundId: 're_1', refundCents: 5000 }]);
    // Already kept: a second failure event for the same refund adds nothing.
    expect(decide(refundEvent('refund.failed', { status: 'failed' }), snapshot({ payment: null, attentionRecord: { ...attention('OPEN'), failedRefundIds: ['re_1'] } })))
      .toEqual([]);
  });

  it('a late created or updated event for a refund that already failed never marks the record REFUNDED', () => {
    const reopened = { ...attention('OPEN'), failedRefundIds: ['re_1'] };
    expect(decide(refundEvent('refund.created', { status: 'pending' }), snapshot({ payment: null, attentionRecord: reopened }))).toEqual([]);
    expect(decide(refundEvent('refund.updated', { status: 'succeeded' }), snapshot({ payment: null, attentionRecord: reopened }))).toEqual([]);
    // A new refund for the same record still marks it.
    expect(decide(refundEvent('refund.created', { id: 're_2' }), snapshot({ payment: null, attentionRecord: reopened })))
      .toEqual([{ type: 'mark_unapplied_capture_refunded', recordId: 'uc_1', processorRefundId: 're_2', refundCents: 5000, closes: false }]);
  });
});

// Fix round 1 (PRD story 40): money sent back from the list that sat on a payment row (a bank
// payment that cleared for more than the balance, or onto an invoice that could not take it).
describe('decide: the refund sent for a payment needing attention that sat on a payment row', () => {
  const onPayment = (status: 'OPEN' | 'REFUNDED', refundId: string | null = null) =>
    ({ id: 'uc_1', status, refundId, paymentId: 'pay_row_1' });

  it('the refund lands before the list stored it: the record reads REFUNDED and the refund comes off the payment, once', () => {
    expect(decide(refundEvent('refund.created', { amount: 3000, status: 'pending' }), snapshot({ attentionRecord: onPayment('OPEN') }))).toEqual([
      { type: 'mark_unapplied_capture_refunded', recordId: 'uc_1', processorRefundId: 're_1', refundCents: 3000, closes: false },
      // The excess is face money: booked as it is, never as a refund made outside ServWave.
      { type: 'record_refund', processorRefundId: 're_1', invoiceId: 'inv_1', paymentId: 'pay_row_1', method: 'CARD', amountCents: 3000, state: 'PENDING', unapplied: true },
    ]);
  });

  it('the refund row the list wrote moves with the processor: it lands, or it fails and the record reopens', () => {
    const row = { id: 'refund_row_1', invoiceId: 'inv_1', state: 'PENDING' as const };
    expect(decide(refundEvent('refund.updated', { status: 'succeeded' }), snapshot({ refund: row, attentionRecord: onPayment('REFUNDED', 're_1') })))
      .toEqual([{ type: 'set_refund_state', refundId: 'refund_row_1', invoiceId: 'inv_1', to: 'SUCCEEDED' }]);
    expect(decide(refundEvent('refund.failed', { status: 'failed' }), snapshot({ refund: row, attentionRecord: onPayment('REFUNDED', 're_1') }))).toEqual([
      { type: 'reopen_unapplied_capture', recordId: 'uc_1', processorRefundId: 're_1', refundCents: 5000 },
      { type: 'set_refund_state', refundId: 'refund_row_1', invoiceId: 'inv_1', to: 'FAILED' },
    ]);
    // A replay of a state the row already holds changes nothing.
    expect(decide(refundEvent('refund.created', { status: 'pending' }), snapshot({ refund: row, attentionRecord: onPayment('REFUNDED', 're_1') }))).toEqual([]);
  });
});
