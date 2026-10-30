/* =============================================================================
   Payments go-live slice 09 - the reconciler's decide step for disputes and late bank returns.

   decide(event, snapshot) is pure: a charge.dispute.* event plus a snapshot of the rows it touches
   (the dispute row ServWave holds for that processor dispute id, the disputed payment and its
   invoice, read under the invoice lock) in, the ordered ledger actions out.

   Close rules: a WON dispute (or an inquiry that closed without becoming a chargeback) returns the
   invoice to the status its SUCCEEDED payments and refunds imply, never straight to PAID; a LOST one
   voids the payment and reopens the balance. A dispute on a bank payment is a late bank return and
   takes the same path, with the "bank returned the payment" wording.
   ========================================================================== */

import { describe, it, expect } from 'vitest';
import { decide, type DisputeEvent, type DisputeSnapshot } from '../decide';

const ORG = 'org_1';
const INVOICE = 'inv_1';
const PAYMENT = 'pay_row_1';
const DUE_BY = 1791000000; // unix seconds

function disputeEvent(
  type: DisputeEvent['type'],
  dispute: Partial<DisputeEvent['data']['object']> = {},
  eventId = 'evt_dp_1',
): DisputeEvent {
  return {
    id: eventId,
    type,
    account: 'acct_1',
    data: {
      object: {
        id: 'dp_1',
        object: 'dispute',
        amount: 50000,
        status: 'needs_response',
        reason: 'fraudulent',
        payment_intent: 'pi_1',
        charge: 'ch_1',
        evidence_details: { due_by: DUE_BY },
        ...dispute,
      },
    },
  };
}

const snapshot = (over: Partial<DisputeSnapshot> = {}): DisputeSnapshot => ({
  eventAlreadyProcessed: false,
  organizationId: ORG,
  dispute: null,
  payment: { id: PAYMENT, invoiceId: INVOICE, method: 'CARD', state: 'SUCCEEDED', voided: false, amountCents: 50000, extrasCents: 0, unrefundedCents: 50000 },
  invoice: { id: INVOICE, invoiceNumber: 'INV-0001', status: 'PAID', amountDueCents: 0, paidCents: 50000, refundedCents: 0, anyMoneyLanded: true },
  otherOpenDisputes: 0,
  ...over,
});

const types = (actions: Array<{ type: string }>) => actions.map((a) => a.type);

describe('decide: charge.dispute.created', () => {
  it('opens a dispute on the payment: the record, the invoice reads DISPUTED, the owner is told', () => {
    expect(decide(disputeEvent('charge.dispute.created'), snapshot())).toEqual([
      {
        type: 'open_dispute',
        organizationId: ORG,
        processorDisputeId: 'dp_1',
        invoiceId: INVOICE,
        paymentId: PAYMENT,
        status: 'NEEDS_RESPONSE',
        reason: 'fraudulent',
        amountCents: 50000,
        evidenceDueBy: new Date(DUE_BY * 1000),
        bankReturn: false,
        markInvoiceDisputed: true,
      },
      { type: 'notify_dispute', kind: 'opened', processorDisputeId: 'dp_1', invoiceId: INVOICE, bankReturn: false, amountCents: 50000, reason: 'fraudulent', evidenceDueBy: new Date(DUE_BY * 1000) },
    ]);
  });
});

describe('decide: charge.dispute.updated', () => {
  const held = { id: 'dispute_row_1', status: 'NEEDS_RESPONSE' as const, amountCents: 50000, evidenceDueBy: new Date(DUE_BY * 1000) };

  it('moves the dispute ServWave holds to its new status; the invoice and the money stay as they are', () => {
    expect(decide(disputeEvent('charge.dispute.updated', { status: 'under_review' }), snapshot({ dispute: held }))).toEqual([{
      type: 'update_dispute',
      processorDisputeId: 'dp_1',
      status: 'UNDER_REVIEW',
      reason: 'fraudulent',
      amountCents: 50000,
      evidenceDueBy: new Date(DUE_BY * 1000),
    }]);
  });
});

describe('decide: duplicates', () => {
  const held = { id: 'dispute_row_1', status: 'NEEDS_RESPONSE' as const, amountCents: 50000, evidenceDueBy: new Date(DUE_BY * 1000) };

  it('a replayed event does nothing, where its first delivery opened the dispute or voided the payment', () => {
    const created = disputeEvent('charge.dispute.created');
    expect(types(decide(created, snapshot()))).toContain('open_dispute');
    expect(decide(created, snapshot({ eventAlreadyProcessed: true }))).toEqual([]);

    const lost = disputeEvent('charge.dispute.closed', { status: 'lost' });
    const open = snapshot({ dispute: held, invoice: { ...snapshot().invoice!, status: 'DISPUTED' } });
    expect(types(decide(lost, open))).toContain('void_disputed_payment');
    expect(decide(lost, { ...open, eventAlreadyProcessed: true })).toEqual([]);
  });

  it('the same dispute delivered again under another event id, unchanged, does nothing', () => {
    expect(decide(disputeEvent('charge.dispute.created', {}, 'evt_dp_again'), snapshot({ dispute: held }))).toEqual([]);
    expect(decide(disputeEvent('charge.dispute.updated', {}, 'evt_dp_again'), snapshot({ dispute: held }))).toEqual([]);
    // Something did change: the processor moved the evidence deadline.
    expect(types(decide(disputeEvent('charge.dispute.updated', { evidence_details: { due_by: DUE_BY + 86400 } }), snapshot({ dispute: held }))))
      .toEqual(['update_dispute']);
  });
});

describe('decide: charge.dispute.closed', () => {
  const open = { id: 'dispute_row_1', status: 'UNDER_REVIEW' as const, amountCents: 50000, evidenceDueBy: new Date(DUE_BY * 1000) };
  const disputed = (over: Partial<NonNullable<DisputeSnapshot['invoice']>> = {}) => ({ ...snapshot().invoice!, status: 'DISPUTED' as const, ...over });

  it('won: the dispute closes and the invoice returns to the status its payments imply (paid in full -> PAID)', () => {
    expect(decide(disputeEvent('charge.dispute.closed', { status: 'won' }), snapshot({ dispute: open, invoice: disputed() }))).toEqual([
      { type: 'close_dispute', processorDisputeId: 'dp_1', status: 'WON', reason: 'fraudulent', amountCents: 50000, evidenceDueBy: new Date(DUE_BY * 1000) },
      { type: 'restore_invoice_status', invoiceId: INVOICE, to: 'PAID', processorDisputeId: 'dp_1', outcome: 'WON' },
      { type: 'notify_dispute', kind: 'closed', outcome: 'WON', processorDisputeId: 'dp_1', invoiceId: INVOICE, bankReturn: false, amountCents: 50000, reason: 'fraudulent', evidenceDueBy: new Date(DUE_BY * 1000) },
    ]);
  });

  it('won on an invoice partly refunded before the dispute: back to PARTIALLY_REFUNDED, never straight to PAID', () => {
    const actions = decide(
      disputeEvent('charge.dispute.closed', { status: 'won', amount: 35000 }),
      snapshot({ dispute: open, invoice: disputed({ paidCents: 50000, refundedCents: 15000 }) }),
    );
    expect(actions.find((a) => a.type === 'restore_invoice_status')).toEqual(
      { type: 'restore_invoice_status', invoiceId: INVOICE, to: 'PARTIALLY_REFUNDED', processorDisputeId: 'dp_1', outcome: 'WON' },
    );
  });

  it('an inquiry closed without a chargeback is not a win: the invoice is restored with the closed wording', () => {
    const actions = decide(disputeEvent('charge.dispute.closed', { status: 'warning_closed' }), snapshot({ dispute: open, invoice: disputed() }));
    expect(actions.find((a) => a.type === 'restore_invoice_status')).toEqual(
      { type: 'restore_invoice_status', invoiceId: INVOICE, to: 'PAID', processorDisputeId: 'dp_1', outcome: 'CLOSED' },
    );
  });

  it('won on an invoice only partly paid: back to PARTIAL', () => {
    const actions = decide(
      disputeEvent('charge.dispute.closed', { status: 'won', amount: 20000 }),
      snapshot({ dispute: open, invoice: disputed({ amountDueCents: 30000, paidCents: 20000 }) }),
    );
    expect(actions.find((a) => a.type === 'restore_invoice_status')).toMatchObject({ to: 'PARTIAL' });
  });

  it('lost: the dispute closes, the payment is voided and the balance reopens', () => {
    expect(decide(disputeEvent('charge.dispute.closed', { status: 'lost' }), snapshot({ dispute: open, invoice: disputed() }))).toEqual([
      { type: 'close_dispute', processorDisputeId: 'dp_1', status: 'LOST', reason: 'fraudulent', amountCents: 50000, evidenceDueBy: new Date(DUE_BY * 1000) },
      { type: 'void_disputed_payment', paymentId: PAYMENT, invoiceId: INVOICE, processorDisputeId: 'dp_1', bankReturn: false, stayDisputed: false },
      { type: 'notify_dispute', kind: 'closed', outcome: 'LOST', processorDisputeId: 'dp_1', invoiceId: INVOICE, bankReturn: false, amountCents: 50000, reason: 'fraudulent', evidenceDueBy: new Date(DUE_BY * 1000) },
    ]);
  });

  // Conductor ruling 2026-10-07: the processor took back only part of the payment. Voiding the
  // whole payment would reopen more than was taken, so nothing is voided or reopened; the dispute
  // is recorded LOST and flagged for a manual review of the balance.
  it('lost for less than the payment\'s unrefunded amount: recorded LOST, the payment is not voided, the balance needs a manual review', () => {
    const actions = decide(
      disputeEvent('charge.dispute.closed', { status: 'lost', amount: 4000 }),
      snapshot({ dispute: { ...open, amountCents: 4000 }, payment: { ...snapshot().payment!, unrefundedCents: 10000 }, invoice: disputed({ paidCents: 10000 }) }),
    );
    expect(actions).toEqual([
      { type: 'close_dispute', processorDisputeId: 'dp_1', status: 'LOST', reason: 'fraudulent', amountCents: 4000, evidenceDueBy: new Date(DUE_BY * 1000) },
      { type: 'restore_invoice_status', invoiceId: INVOICE, to: 'PAID', processorDisputeId: 'dp_1', outcome: 'LOST_PARTIAL' },
      {
        type: 'flag_partial_chargeback', invoiceId: INVOICE, paymentId: PAYMENT, processorDisputeId: 'dp_1',
        disputedCents: 4000, unrefundedCents: 10000, bankReturn: false,
      },
      { type: 'notify_dispute', kind: 'closed', outcome: 'LOST', processorDisputeId: 'dp_1', invoiceId: INVOICE, bankReturn: false, amountCents: 4000, reason: 'fraudulent', evidenceDueBy: new Date(DUE_BY * 1000), partial: true },
    ]);
  });

  it('lost for the whole unrefunded amount of a partly refunded payment: the payment is voided as before', () => {
    const actions = decide(
      disputeEvent('charge.dispute.closed', { status: 'lost', amount: 35000 }),
      snapshot({ dispute: { ...open, amountCents: 35000 }, payment: { ...snapshot().payment!, unrefundedCents: 35000 }, invoice: disputed({ refundedCents: 15000 }) }),
    );
    expect(types(actions)).toEqual(['close_dispute', 'void_disputed_payment', 'notify_dispute']);
  });

  // The processor's dispute amount is in charged cents (face amount plus the tip and any legacy card
  // fee on the same charge); the payment's unrefunded amount is in face cents. A $100 invoice paid
  // with a $20 tip was charged $120: only a dispute for the whole $120 took all of it back.
  describe('on a tipped payment ($100 face, $20 tip, charged $120)', () => {
    const tipped = { ...snapshot().payment!, amountCents: 10000, extrasCents: 2000, unrefundedCents: 10000 };
    const paidInFull = disputed({ paidCents: 10000 });

    it('lost for the whole $120 charged: a full loss, the payment is voided and the balance reopens', () => {
      const actions = decide(
        disputeEvent('charge.dispute.closed', { status: 'lost', amount: 12000 }),
        snapshot({ dispute: { ...open, amountCents: 12000 }, payment: tipped, invoice: paidInFull }),
      );
      expect(types(actions)).toEqual(['close_dispute', 'void_disputed_payment', 'notify_dispute']);
    });

    it('lost for only the $100 face amount: $20 is still held, so it is a partial loss (flagged, nothing voided or reopened)', () => {
      const actions = decide(
        disputeEvent('charge.dispute.closed', { status: 'lost', amount: 10000 }),
        snapshot({ dispute: { ...open, amountCents: 10000 }, payment: tipped, invoice: paidInFull }),
      );
      expect(types(actions)).toEqual(['close_dispute', 'restore_invoice_status', 'flag_partial_chargeback', 'notify_dispute']);
      // Both figures in what the card was charged: $100 taken of the $120 left.
      expect(actions.find((a) => a.type === 'flag_partial_chargeback')).toMatchObject({ disputedCents: 10000, unrefundedCents: 12000 });
    });

    // $60 of the $120 charge was refunded, booked as $50 face. $60 charged ($50 face) is left.
    const partlyRefunded = { ...tipped, unrefundedCents: 5000 };

    it('partly refunded, then lost for the whole $60 charged that was left: a full loss', () => {
      const actions = decide(
        disputeEvent('charge.dispute.closed', { status: 'lost', amount: 6000 }),
        snapshot({ dispute: { ...open, amountCents: 6000 }, payment: partlyRefunded, invoice: disputed({ paidCents: 10000, refundedCents: 5000 }) }),
      );
      expect(types(actions)).toEqual(['close_dispute', 'void_disputed_payment', 'notify_dispute']);
    });

    it('partly refunded, then lost for $50 of the $60 charged that was left: a partial loss', () => {
      const actions = decide(
        disputeEvent('charge.dispute.closed', { status: 'lost', amount: 5000 }),
        snapshot({ dispute: { ...open, amountCents: 5000 }, payment: partlyRefunded, invoice: disputed({ paidCents: 10000, refundedCents: 5000 }) }),
      );
      expect(types(actions)).toEqual(['close_dispute', 'restore_invoice_status', 'flag_partial_chargeback', 'notify_dispute']);
      expect(actions.find((a) => a.type === 'flag_partial_chargeback')).toMatchObject({ disputedCents: 5000, unrefundedCents: 6000 });
    });
  });

  it('lost on a payment already voided: the dispute closes, nothing is voided twice', () => {
    expect(types(decide(
      disputeEvent('charge.dispute.closed', { status: 'lost' }),
      snapshot({ dispute: open, invoice: disputed(), payment: { ...snapshot().payment!, voided: true } }),
    ))).toEqual(['close_dispute', 'notify_dispute']);
  });
});


describe('decide: out of order', () => {
  it('closed arriving before created: the dispute is recorded and closed in one go; the late created event then does nothing', () => {
    const closedFirst = decide(disputeEvent('charge.dispute.closed', { status: 'lost' }), snapshot());
    expect(types(closedFirst)).toEqual(['open_dispute', 'notify_dispute', 'close_dispute', 'void_disputed_payment', 'notify_dispute']);
    expect(closedFirst[0]).toMatchObject({ type: 'open_dispute', status: 'LOST' });

    const won = decide(disputeEvent('charge.dispute.closed', { status: 'won' }), snapshot());
    // Never disputed in ServWave before, so the invoice is put back where its money says.
    expect(types(won)).toEqual(['open_dispute', 'notify_dispute', 'close_dispute', 'restore_invoice_status', 'notify_dispute']);
    expect(won.find((a) => a.type === 'restore_invoice_status')).toMatchObject({ to: 'PAID' });

    const lateCreated = decide(
      disputeEvent('charge.dispute.created', { status: 'needs_response' }, 'evt_dp_late'),
      snapshot({ dispute: { id: 'dispute_row_1', status: 'LOST', amountCents: 50000, evidenceDueBy: new Date(DUE_BY * 1000) } }),
    );
    expect(lateCreated).toEqual([]);
  });

  it('an update arriving after the close does not reopen it', () => {
    expect(decide(
      disputeEvent('charge.dispute.updated', { status: 'under_review' }, 'evt_dp_late'),
      snapshot({ dispute: { id: 'dispute_row_1', status: 'WON', amountCents: 50000, evidenceDueBy: new Date(DUE_BY * 1000) } }),
    )).toEqual([]);
  });
});

describe('decide: late bank returns', () => {
  const bankPayment = { ...snapshot().payment!, method: 'ACH' as const };

  it('a dispute on a bank payment is a bank return: same path, with the bank-return wording', () => {
    const actions = decide(disputeEvent('charge.dispute.created', { status: 'lost', reason: 'insufficient_funds' }), snapshot({ payment: bankPayment }));
    expect(types(actions)).toEqual(['open_dispute', 'notify_dispute', 'close_dispute', 'void_disputed_payment', 'notify_dispute']);
    expect(actions.filter((a) => 'bankReturn' in a).every((a) => (a as { bankReturn: boolean }).bankReturn)).toBe(true);
  });

  it('the dispute object alone says it is a bank payment when the payment row does not', () => {
    const actions = decide(disputeEvent('charge.dispute.created', { payment_method_details: { type: 'us_bank_account' } }), snapshot());
    expect(actions[0]).toMatchObject({ type: 'open_dispute', bankReturn: true });
  });

  // Only a SUCCEEDED payment ever took the balance down, so only a SUCCEEDED one can reopen it.
  // A bank payment still clearing (PROCESSING) never reduced amount_due: a return on it fails the
  // payment, so the later "cleared" event finds nothing to settle, and the balance is left alone.
  it('a bank return on a payment still clearing fails the payment instead of voiding it: the balance it never took down is not reopened', () => {
    const clearing = { ...bankPayment, state: 'PROCESSING' as const };
    const sent = { ...snapshot().invoice!, status: 'SENT' as const, amountDueCents: 50000, paidCents: 0, anyMoneyLanded: false };
    const actions = decide(disputeEvent('charge.dispute.created', { status: 'lost', reason: 'insufficient_funds' }), snapshot({ payment: clearing, invoice: sent }));
    expect(types(actions)).toEqual(['open_dispute', 'notify_dispute', 'close_dispute', 'fail_disputed_payment', 'notify_dispute']);
    expect(actions.find((a) => a.type === 'fail_disputed_payment')).toEqual({
      type: 'fail_disputed_payment', paymentId: PAYMENT, invoiceId: INVOICE, processorDisputeId: 'dp_1', amountCents: 50000, bankReturn: true,
    });
  });

  it('a dispute on a payment still clearing never marks the invoice DISPUTED: no money of it was counted', () => {
    const clearing = { ...bankPayment, state: 'PROCESSING' as const };
    const sent = { ...snapshot().invoice!, status: 'SENT' as const, amountDueCents: 50000, paidCents: 0, anyMoneyLanded: false };
    expect(decide(disputeEvent('charge.dispute.created'), snapshot({ payment: clearing, invoice: sent }))[0])
      .toMatchObject({ type: 'open_dispute', markInvoiceDisputed: false });
  });

  // A payment staff voided is not counted (COUNTED_PAYMENT_WHERE): it never took the balance down
  // in the ledger, so a dispute on it never marks the invoice DISPUTED.
  it('a dispute on a payment staff already voided writes the record but never marks the invoice DISPUTED', () => {
    const voidedPayment = { ...snapshot().payment!, voided: true };
    const sent = { ...snapshot().invoice!, status: 'SENT' as const, amountDueCents: 50000, paidCents: 0 };
    expect(decide(disputeEvent('charge.dispute.created'), snapshot({ payment: voidedPayment, invoice: sent }))[0])
      .toMatchObject({ type: 'open_dispute', markInvoiceDisputed: false });
    const partial = { ...sent, status: 'PARTIAL' as const, amountDueCents: 30000, paidCents: 20000 };
    expect(decide(disputeEvent('charge.dispute.created'), snapshot({ payment: voidedPayment, invoice: partial }))[0])
      .toMatchObject({ type: 'open_dispute', markInvoiceDisputed: false });
  });

  it('lost on a payment that already failed: the dispute closes, nothing is voided or reopened', () => {
    const failed = { ...bankPayment, state: 'FAILED' as const };
    expect(types(decide(disputeEvent('charge.dispute.created', { status: 'lost' }), snapshot({ payment: failed }))))
      .toEqual(['open_dispute', 'notify_dispute', 'close_dispute', 'notify_dispute']);
  });
});

describe('decide: what is not ours', () => {
  it('a dispute on a voided invoice writes the record but never marks the invoice DISPUTED', () => {
    const voided = { ...snapshot().invoice!, status: 'VOIDED' as const };
    expect(decide(disputeEvent('charge.dispute.created'), snapshot({ invoice: voided }))[0]).toMatchObject({ type: 'open_dispute', markInvoiceDisputed: false });
  });

  it('lost on a voided invoice while another dispute on it is still open: the payment is voided, the invoice is never marked DISPUTED', () => {
    const open = { id: 'dispute_row_1', status: 'UNDER_REVIEW' as const, amountCents: 50000, evidenceDueBy: new Date(DUE_BY * 1000) };
    const voided = { ...snapshot().invoice!, status: 'VOIDED' as const };
    expect(decide(disputeEvent('charge.dispute.closed', { status: 'lost' }), snapshot({ dispute: open, invoice: voided, otherOpenDisputes: 1 }))
      .find((a) => a.type === 'void_disputed_payment')).toMatchObject({ stayDisputed: false });
  });

  it('a dispute on a payment ServWave has no record of in this org changes nothing', () => {
    expect(decide(disputeEvent('charge.dispute.created'), snapshot({ payment: null, invoice: null }))).toEqual([]);
  });

  it('won while another dispute on the same invoice is still open: the invoice keeps reading DISPUTED', () => {
    const open = { id: 'dispute_row_1', status: 'UNDER_REVIEW' as const, amountCents: 50000, evidenceDueBy: new Date(DUE_BY * 1000) };
    const invoice = { ...snapshot().invoice!, status: 'DISPUTED' as const };
    expect(types(decide(disputeEvent('charge.dispute.closed', { status: 'won' }), snapshot({ dispute: open, invoice, otherOpenDisputes: 1 }))))
      .toEqual(['close_dispute', 'notify_dispute']);
    expect(decide(disputeEvent('charge.dispute.closed', { status: 'lost' }), snapshot({ dispute: open, invoice, otherOpenDisputes: 1 }))
      .find((a) => a.type === 'void_disputed_payment')).toMatchObject({ stayDisputed: true });
  });
});
