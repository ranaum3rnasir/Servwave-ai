/**
 * Payments go-live slice 07 (PRD Module 4) - the reconciler's APPLY step.
 *
 * Thin on purpose: every rule lives in decide.ts. This executes the ordered actions inside the
 * transaction the caller opened (one per event, which also wrote the processed-event record), so
 * an event's ledger changes land together or not at all.
 *
 * Copy written here reaches the invoice history, so it names no processor.
 */
import type { PaymentState, Prisma } from '@prisma/client';
import { logger } from '../../lib/logger';
import { fromCents, rederiveRefundTotals, settlePaymentInTx, settleRefundInTx, toCents, UNAPPLIED_REFUND_REASON, type SettledPayment } from '../../lib/payment-ledger';
import { systemVoidPaymentForChargeback } from '../../controllers/invoice.controller';
import { checkoutOpenStatus } from '../../lib/public-pay-state';
import { CREATED_BY_CLIENT } from '../../lib/created-by';
import {
  clearUnappliedCaptureAlerts, countRefundOnCapture, resolveChargeRecordsForBookedPayment, uncountRefundOnCapture, writeUnappliedCaptureEntry, type UnappliedCapture,
} from '../../lib/unapplied-capture';
import { transitionLeadStatus } from '../lead-stage.service';
import { recordJobMoneyMovement } from '../../lib/job-change-history';
import type { LedgerAction } from './decide';

/** The reason on a refund row the reconciler recorded as made outside ServWave. */
export const OUTSIDE_REFUND_REASON = 'Refunded outside ServWave';

export interface ApplyContext {
  organizationId: string;
  eventId: string;
  /** The connected account the event arrived on (where captured money sits, for its refund). */
  accountId?: string | null;
}

/** A payment this event booked: a card payment, or a bank debit (PROCESSING, or already settled). */
export interface BookedPayment {
  paymentId: string;
  invoiceId: string;
  method: 'CARD' | 'ACH';
  state: PaymentState;
  /** Applied to the invoice, in dollars. */
  amount: number;
  paysInFull: boolean;
  /** What is still owed after it, in dollars. */
  newBalance: number;
  /** The estimate whose deposit this payment paid in full (a bank one: started paying), approved or not before. */
  depositEstimateId: string | null;
  /** The estimate this payment approved: its deposit's estimate, unless it was approved already. */
  approvedEstimateId: string | null;
  /** The closed (declined, cancelled, expired) estimate this deposit money landed on: booked, nothing won. */
  closedEstimateId: string | null;
}

/** A dispute the owner must hear about once the transaction commits (slice 32 adds the email). */
export type DisputeNotice = Extract<LedgerAction, { type: 'notify_dispute' }>;

/**
 * V7-13 (BE-13a): a bank payment the bank took back (a late return voided it, an early one failed it), so the customer is
 * asked to pay again once the transaction commits. Pushed only when this event moved the payment, so a replay sends nothing.
 */
export interface BankReturnNotice {
  eventId: string;
  disputeId: string;
  invoiceId: string;
  paymentId: string;
  /** The payment's own face amount (what the customer owes again), not the dispute amount, which includes the tip. */
  amountCents: number;
  deposit: boolean;
  /**
   * The invoice can be paid online right now: open (SENT or PARTIAL), not DISPUTED (including while another dispute is
   * open), and not already covered by another payment. False means no Pay Again email goes out (C-38).
   */
  payAgain: boolean;
  /** The invoice is VOIDED: it stays voided and the customer is never asked to pay it. */
  voided: boolean;
}

/** What the caller does after the transaction commits (audit rows, alerts, emails). */
export interface AppliedEffects {
  /** Refunds that moved to SUCCEEDED in this event (a bank refund the processor confirmed): the customer is told after commit. */
  settledRefunds: Array<{ refundId: string }>;
  externalRefunds: Array<{ invoiceId: string; amount: number; processorRefundId: string }>;
  bookedPayments: BookedPayment[];
  /** Written down inside the transaction; the alert and audit go out after it commits. */
  unappliedCaptures: UnappliedCapture[];
  disputeNotices: DisputeNotice[];
  /** Invoices whose other open checkout links are closed once the transaction commits (a payment started). */
  expireCheckouts: string[];
  /** Bank payments that started, cleared or failed: delivered by slices 31/32, logged until then. */
  bankNotices: BankNotice[];
  /** Bank debits that cleared or failed: their automation and alerts go out once the transaction commits. */
  settledPayments: SettledPayment[];
  /**
   * Invoices whose balance a lost dispute or bank return raised (slice 15): their open checkout
   * links ask for too little and are closed once the transaction commits.
   */
  reopenedInvoices: string[];
  /** The org's account status was written (it still held the account). */
  accountStatusWritten: boolean;
  /** Payments-account notices, sent once the transaction commits and only when the status was written. */
  accountNotices: AccountNotice[];
  /** Slice 32: refunds the processor could not complete; the owner is told once the transaction commits. */
  failedRefunds: FailedRefund[];
  /** Payouts slice P2: bank payments this event marked FAILED; their failure code is looked up after the commit. */
  failedPayments: Array<{ paymentId: string }>;
  /** V7-13: bank payments the bank took back in this event; the customer is emailed after the commit (BE-13a). */
  bankReturnNotices: BankReturnNotice[];
}

/** A refund that failed: on an invoice, or the one sent for a payment needing attention (recordId). */
export interface FailedRefund {
  processorRefundId: string;
  invoiceId: string | null;
  recordId: string | null;
}

/** A bank payment notice, tagged with the ledger event that caused it (the owner's notice is keyed on it). */
export type BankNotice = Extract<LedgerAction, { type: 'notify_bank_payment' }> & { eventId: string };

/** A payments-account notice the owner hears once the account status has committed (slice 10). */
export type AccountNotice = Extract<LedgerAction, { type: 'notify_account' }>;

export async function applyActions(
  tx: Prisma.TransactionClient,
  actions: readonly LedgerAction[],
  ctx: ApplyContext,
): Promise<AppliedEffects> {
  const effects: AppliedEffects = {
    settledRefunds: [], externalRefunds: [], bookedPayments: [], unappliedCaptures: [], disputeNotices: [], expireCheckouts: [], bankNotices: [],
    settledPayments: [], reopenedInvoices: [], accountStatusWritten: false, accountNotices: [], failedRefunds: [], failedPayments: [], bankReturnNotices: [],
  };
  // Whether the settle step just before a bank notice moved the payment. decide() read its snapshot
  // before the invoice lock, so something else may have moved it first; the cleared and failed
  // notices (customer and owner) then stay unsent, as the receipt always did. Null = no settle step.
  let settleMoved: boolean | null = null;
  // The payment a record_payment action just wrote FAILED: the bank notice that follows it names it.
  let justFailedPaymentId: string | null = null;
  for (const action of actions) {
    switch (action.type) {
      case 'record_refund': {
        await lockInvoice(tx, action.invoiceId, ctx.organizationId);
        const actor = await systemActor(tx, ctx.organizationId);
        await tx.refund.create({
          data: {
            invoice_id: action.invoiceId,
            payment_id: action.paymentId,
            amount: fromCents(action.amountCents),
            tax_portion: 0,
            non_taxable_concession: false,
            method: action.method,
            reason: action.unapplied ? UNAPPLIED_REFUND_REASON : OUTSIDE_REFUND_REASON,
            reason_category: action.unapplied ? 'OVERPAYMENT' : 'OTHER',
            from_unapplied_capture: action.unapplied ?? false,
            stripe_refund_id: action.processorRefundId,
            // Named every time: the column's default is SUCCEEDED, which a pending or failed
            // refund must never inherit.
            state: action.state,
            refunded_by: actor,
            organization_id: ctx.organizationId,
          },
        });
        await rederiveRefundTotals(tx, { invoiceId: action.invoiceId, organizationId: ctx.organizationId });
        break;
      }
      case 'record_outside_refund_history': {
        await lockInvoice(tx, action.invoiceId, ctx.organizationId);
        const row = await tx.refund.findFirstOrThrow({
          where: { stripe_refund_id: action.processorRefundId, organization_id: ctx.organizationId },
          select: { amount: true },
        });
        const amount = Number(row.amount);
        await updateInvoiceInOrg(tx, action.invoiceId, ctx.organizationId, { refunded_at: new Date(), refund_reason: OUTSIDE_REFUND_REASON });
        await tx.timelineEvent.create({
          data: {
            organization_id: ctx.organizationId,
            entity_type: 'INVOICE',
            entity_id: action.invoiceId,
            event_type: 'INVOICE_REFUNDED',
            description: 'Refund made outside ServWave recorded',
            metadata: { source: 'outside_servwave', processor_refund_id: action.processorRefundId, event_id: ctx.eventId, amount },
          },
        });
        effects.externalRefunds.push({ invoiceId: action.invoiceId, amount, processorRefundId: action.processorRefundId });
        break;
      }
      case 'set_refund_state': {
        const { changed } = await settleRefundInTx(tx, { refundId: action.refundId, organizationId: ctx.organizationId, to: action.to });
        if (changed && action.to === 'SUCCEEDED') effects.settledRefunds.push({ refundId: action.refundId });
        break;
      }
      case 'notify_refund_failed':
        effects.failedRefunds.push({ processorRefundId: action.processorRefundId, invoiceId: action.invoiceId, recordId: null });
        logger.warn(`Refund ${action.processorRefundId} failed on invoice ${action.invoiceId} (org ${ctx.organizationId}); the customer must be refunded another way`);
        break;
      case 'record_payment': {
        const booked = await recordPayment(tx, action, ctx);
        effects.bookedPayments.push(booked);
        if (booked.state === 'FAILED') {
          effects.failedPayments.push({ paymentId: booked.paymentId });
          justFailedPaymentId = booked.paymentId;
        }
        break;
      }
      case 'mark_unapplied_capture_refunded': {
        // V7-09b: counted once per refund under the record's lock; the record reads REFUNDED only when the whole amount
        // is back (a RESOLVED record is marked too: a refund that went out is always stored).
        const { closed } = await countRefundOnCapture(tx, {
          organizationId: ctx.organizationId, recordId: action.recordId, refundId: action.processorRefundId, refundCents: action.refundCents, closes: action.closes,
        });
        // Slice 32: the row is dealt with, so its alert is read.
        if (closed) {
          const marked = await tx.unappliedCapture.findFirst({
            where: { id: action.recordId, organization_id: ctx.organizationId }, select: { source_key: true },
          });
          if (marked) await clearUnappliedCaptureAlerts(tx, ctx.organizationId, marked.source_key);
        }
        break;
      }
      case 'reopen_unapplied_capture':
        await tx.unappliedCapture.updateMany({
          where: { id: action.recordId, organization_id: ctx.organizationId, status: 'REFUNDED', stripe_refund_id: action.processorRefundId },
          // Kept on the record: a late event for this refund never marks it REFUNDED again.
          data: { status: 'OPEN', stripe_refund_id: null, refunded_at: null, failed_refund_ids: { push: action.processorRefundId } },
        });
        await uncountRefundOnCapture(tx, { organizationId: ctx.organizationId, recordId: action.recordId, refundId: action.processorRefundId, refundCents: action.refundCents });
        effects.failedRefunds.push({ processorRefundId: action.processorRefundId, invoiceId: null, recordId: action.recordId });
        logger.warn(`Refund ${action.processorRefundId} of payment needing attention ${action.recordId} (org ${ctx.organizationId}) failed; listed as open again`);
        break;
      case 'note_unapplied_capture_refund_failed':
        // The failure landed before the record stored the refund (the list's commit is still to
        // come): kept, so neither that commit nor a late event marks the record REFUNDED.
        await tx.unappliedCapture.updateMany({
          where: { id: action.recordId, organization_id: ctx.organizationId, NOT: { failed_refund_ids: { has: action.processorRefundId } } },
          data: { failed_refund_ids: { push: action.processorRefundId } },
        });
        // A partial refund already counted comes back to the record (and reopens it if that had closed it).
        await uncountRefundOnCapture(tx, { organizationId: ctx.organizationId, recordId: action.recordId, refundId: action.processorRefundId, refundCents: action.refundCents });
        effects.failedRefunds.push({ processorRefundId: action.processorRefundId, invoiceId: null, recordId: action.recordId });
        logger.warn(`Refund ${action.processorRefundId} of payment needing attention ${action.recordId} (org ${ctx.organizationId}) failed before it was stored`);
        break;
      case 'record_unapplied_capture': {
        const capture = unappliedCapture(action, ctx);
        await writeUnappliedCaptureEntry(tx, capture);
        effects.unappliedCaptures.push(capture);
        break;
      }
      case 'open_dispute':
        await openDispute(tx, action, ctx);
        break;
      case 'update_dispute':
      case 'close_dispute':
        await tx.dispute.updateMany({
          where: { stripe_dispute_id: action.processorDisputeId, organization_id: ctx.organizationId },
          data: {
            status: action.status,
            reason: action.reason,
            amount: fromCents(action.amountCents),
            evidence_due_by: action.evidenceDueBy,
            ...(action.type === 'close_dispute' ? { closed_at: new Date() } : {}),
          },
        });
        break;
      case 'restore_invoice_status': {
        const paid = await restoreInvoiceStatus(tx, action, ctx);
        // Slice 29: the restore paid the invoice in full; INVOICE_PAID goes out once it commits.
        if (paid) effects.settledPayments.push({ changed: true, becamePaid: true, invoice: paid, unapplied: null });
        break;
      }
      case 'void_disputed_payment': {
        const voided = await voidDisputedPayment(tx, action, ctx);
        effects.reopenedInvoices.push(...voided.reopened);
        // A lost card dispute is not a bank return and is left alone.
        if (voided.notice && action.bankReturn) effects.bankReturnNotices.push({ ...voided.notice, eventId: ctx.eventId, disputeId: action.processorDisputeId });
        break;
      }
      case 'fail_disputed_payment': {
        const failed = await failDisputedPayment(tx, action, ctx);
        if (failed) effects.failedPayments.push({ paymentId: action.paymentId });
        if (failed && action.bankReturn) effects.bankReturnNotices.push({ ...failed, eventId: ctx.eventId, disputeId: action.processorDisputeId });
        break;
      }
      case 'flag_partial_chargeback':
        await flagPartialChargeback(tx, action, ctx);
        break;
      case 'notify_dispute':
        effects.disputeNotices.push(action);
        break;
      case 'expire_open_checkouts':
        effects.expireCheckouts.push(action.invoiceId);
        break;
      case 'notify_bank_payment':
        // A debit that failed before its checkout completed was written down FAILED by the record just above: name it.
        if (settleMoved !== false) {
          effects.bankNotices.push({ ...action, ...(!action.paymentId && action.kind === 'failed' && justFailedPaymentId ? { paymentId: justFailedPaymentId } : {}), eventId: ctx.eventId });
        }
        settleMoved = null;
        justFailedPaymentId = null;
        break;
      case 'settle_payment': {
        const settled = await settleBankPayment(tx, action, ctx);
        settleMoved = settled.changed;
        effects.settledPayments.push(settled);
        if (settled.changed && action.to === 'FAILED') effects.failedPayments.push({ paymentId: action.paymentId });
        break;
      }
      case 'update_account_status': {
        // Keyed on the account id too: an org that has since been unlinked from this account, or
        // linked to another one, is not written.
        const written = await tx.organization.updateMany({
          where: { id: action.organizationId, stripe_account_id: action.accountId },
          data: { ...action.flags, ...(action.acceptedMethods ? { accepted_payment_methods: action.acceptedMethods } : {}) },
        });
        effects.accountStatusWritten = written.count > 0;
        break;
      }
      case 'notify_account':
        effects.accountNotices.push(action);
        break;
    }
  }
  return effects;
}

/**
 * Book a card payment the processor captured and decide() found applicable: the payment row, the
 * invoice's balance and status, its history, and (a deposit paid in full) the estimate approved
 * and the lead won. The invoice is locked; decide() judged the amount against the balance read
 * under this same lock. Exported for V7-09b: attaching unapplied money to an invoice books it the same way.
 */
export async function recordPayment(
  tx: Prisma.TransactionClient,
  action: Extract<LedgerAction, { type: 'record_payment' }>,
  ctx: ApplyContext,
): Promise<BookedPayment> {
  await lockInvoice(tx, action.invoiceId, ctx.organizationId);
  const invoice = await tx.invoice.findFirstOrThrow({
    where: { id: action.invoiceId, organization_id: ctx.organizationId },
    select: {
      invoice_number: true,
      job_id: true,
      amount_due: true,
      estimate: { select: { id: true, status: true, lead_id: true, estimate_number: true, lead: { select: { status: true } } } },
    },
  });
  const paidAt = action.paidAt ?? new Date();
  const amount = fromCents(action.amountCents);
  const payment = await tx.payment.create({
    data: {
      invoice_id: action.invoiceId,
      amount,
      method: action.method,
      state: action.state,
      paid_at: paidAt,
      collected_by: null,
      stripe_payment_intent_id: action.processorPaymentIntentId,
      stripe_charge_id: action.processorChargeId,
      stripe_checkout_session_id: action.checkoutSessionId,
      // NULL = legacy platform-account payment; a set value = direct charge on the connected account.
      stripe_account_id: action.connectedAccountId,
      // D10: the tip rides on the payment, never on the invoice. No new payment carries a card fee (D9).
      tip_amount: action.tipCents > 0 ? fromCents(action.tipCents) : null,
      wallet: action.wallet,
      card_brand: action.cardBrand,
      card_last4: action.cardLast4,
      bank_name: action.bankName,
      bank_last4: action.bankLast4,
      // The customer paid this themselves on the hosted checkout: no ServWave user behind it.
      ...CREATED_BY_CLIENT,
    },
  });
  // A late event can book a charge the nightly reconcile already wrote down: close that record.
  if (action.state !== 'FAILED') {
    await resolveChargeRecordsForBookedPayment(tx, {
      organizationId: ctx.organizationId, chargeId: action.processorChargeId, paymentIntentId: action.processorPaymentIntentId, paymentId: payment.id,
    });
  }

  const label = action.method === 'ACH' ? 'Bank payment' : 'Card payment';
  const history = (eventType: string, description: string) => tx.timelineEvent.create({
    data: {
      organization_id: ctx.organizationId,
      entity_type: 'INVOICE',
      entity_id: action.invoiceId,
      event_type: eventType,
      description,
      metadata: { payment_id: payment.id, stripe_payment_intent_id: action.processorPaymentIntentId, event_id: ctx.eventId, amount },
    },
  });
  // Only money that landed (SUCCEEDED) takes the balance down. A bank debit still clearing, or one
  // that failed before ServWave heard it started, is the payment row and its history only.
  const landed = action.state === 'SUCCEEDED';
  const newBalanceCents = landed ? Math.max(toCents(invoice.amount_due) - action.amountCents, 0) : toCents(invoice.amount_due);
  if (action.state === 'PROCESSING') {
    await history('PAYMENT_PROCESSING', `${label} started; it takes a few business days to clear`);
  } else if (action.state === 'FAILED') {
    await history('PAYMENT_FAILED', `${label} failed; nothing was collected`);
  } else {
    await updateInvoiceInOrg(tx, action.invoiceId, ctx.organizationId, {
      amount_due: fromCents(newBalanceCents),
      status: action.paysInFull ? 'PAID' : 'PARTIAL',
      ...(action.paysInFull ? { paid_at: paidAt } : {}),
    });
    // The stored net collected (and refund totals) from the ledger rows, under the same lock: SQL and
    // reports read the column (payments go-live slice 09, from slice 08 acceptance).
    await rederiveRefundTotals(tx, { invoiceId: action.invoiceId, organizationId: ctx.organizationId });
    await history('PAYMENT_RECEIVED', `${label} received via ServWave Payments`);
    // S06.7: money that landed is on the job's own history too (nobody signed in took it).
    await recordJobMoneyMovement(
      tx, { orgId: ctx.organizationId, userId: null }, invoice.job_id,
      { id: action.invoiceId, invoice_number: invoice.invoice_number }, 'PAYMENT_RECORDED',
      { amount, method: action.method, online: true, invoiceEventType: 'PAYMENT_RECEIVED', paymentId: payment.id },
    );
  }
  if (landed && action.paysInFull) {
    await tx.timelineEvent.create({
      data: {
        organization_id: ctx.organizationId,
        entity_type: 'INVOICE',
        entity_id: action.invoiceId,
        event_type: 'INVOICE_PAID',
        description: `Invoice ${invoice.invoice_number} paid in full`,
      },
    });
  }

  // A deposit paid in full is the customer's approval of its estimate: approve it and win the lead
  // (the public-checkout approval signal). Call 3: a bank deposit approves when the debit STARTS
  // (PROCESSING); a failure later does not un-win it. A debit that failed before ServWave heard it
  // started approves nothing, and an estimate already approved is not approved again.
  let approvedEstimateId: string | null = null;
  let depositEstimateId: string | null = null;
  let closedEstimateId: string | null = null;
  const est = invoice.estimate;
  if (action.kind === 'DEPOSIT' && est && action.estimateClosed) {
    // Conductor ruling 4: money that arrived on a closed estimate (a session minted before the
    // close) stays on the deposit invoice; the estimate and lead are not won, nothing is announced.
    closedEstimateId = est.id;
  } else if (action.kind === 'DEPOSIT' && est && action.paysInFull && action.state !== 'FAILED') {
    const byBank = action.method === 'ACH';
    depositEstimateId = est.id;
    if (est.status !== 'WON') {
      approvedEstimateId = est.id;
      await tx.estimate.update({ where: { id: est.id }, data: { status: 'WON', approved_at: new Date() } });
      if (est.lead_id && est.lead) {
        // actorId null: a processor event has no signed-in user, and the ledger says so.
        await transitionLeadStatus(tx, {
          leadId: est.lead_id,
          orgId: ctx.organizationId,
          to: 'WON',
          from: est.lead.status,
          actorId: null,
          description: byBank ? 'Lead won — deposit bank payment started' : 'Lead won — deposit invoice paid by card',
          metadata: {
            estimate_id: est.id, estimate_number: est.estimate_number, invoice_id: action.invoiceId,
            via: byBank ? 'online_deposit_processing' : 'stripe_deposit_paid',
          },
        });
      }
    }
    await tx.timelineEvent.create({
      data: {
        organization_id: ctx.organizationId,
        entity_type: 'ESTIMATE',
        entity_id: est.id,
        event_type: landed ? 'DEPOSIT_PAID' : 'DEPOSIT_PROCESSING',
        description: !byBank
          ? `Deposit paid via credit card for estimate ${est.estimate_number}`
          : landed
            ? `Deposit paid by bank payment for estimate ${est.estimate_number}`
            : `Deposit by bank payment started for estimate ${est.estimate_number}; it takes a few business days to clear`,
        metadata: { payment_intent: action.processorPaymentIntentId, method: action.method, amount },
      },
    });
  }

  return {
    paymentId: payment.id,
    invoiceId: action.invoiceId,
    method: action.method,
    state: action.state,
    amount,
    paysInFull: action.paysInFull,
    newBalance: fromCents(newBalanceCents),
    depositEstimateId,
    approvedEstimateId,
    closedEstimateId,
  };
}


/**
 * A bank debit still clearing reached its outcome: the ledger door settles it under the invoice
 * lock (SUCCEEDED applies the money, FAILED only marks the payment), and the invoice's history
 * says what happened. Nothing is written when the payment had already left PROCESSING.
 */
async function settleBankPayment(
  tx: Prisma.TransactionClient,
  action: Extract<LedgerAction, { type: 'settle_payment' }>,
  ctx: ApplyContext,
): Promise<SettledPayment> {
  const settled = await settlePaymentInTx(tx, { paymentId: action.paymentId, organizationId: ctx.organizationId, to: action.to });
  if (!settled.changed) return settled;
  // Booked before its charge existed (micro-deposits verified after the checkout): the charge id,
  // the bank, and paid-at (the charge's creation time) are filled in now. Only a field the charge
  // knows replaces what the booking had. The invoice is locked (settlePaymentInTx took it).
  if (action.charge) {
    await tx.payment.updateMany({
      where: { id: action.paymentId, invoice: { organization_id: ctx.organizationId }, stripe_charge_id: null },
      data: {
        stripe_charge_id: action.charge.id,
        paid_at: action.charge.paidAt,
        ...(action.charge.bankName ? { bank_name: action.charge.bankName } : {}),
        ...(action.charge.bankLast4 ? { bank_last4: action.charge.bankLast4 } : {}),
      },
    });
  }
  const payment = await tx.payment.findFirstOrThrow({
    where: { id: action.paymentId, invoice: { organization_id: ctx.organizationId } },
    select: {
      amount: true, method: true, invoice_id: true, stripe_payment_intent_id: true,
      invoice: { select: { invoice_number: true, job_id: true } },
    },
  });
  if (action.charge) {
    await resolveChargeRecordsForBookedPayment(tx, {
      organizationId: ctx.organizationId, chargeId: action.charge.id, paymentIntentId: payment.stripe_payment_intent_id, paymentId: action.paymentId,
    });
  }
  // A bank deposit that cleared: its estimate (approved when the debit started) records the deposit paid.
  const deposit = action.to === 'SUCCEEDED' ? await tx.invoice.findFirst({
    where: { id: payment.invoice_id, organization_id: ctx.organizationId, kind: 'DEPOSIT' },
    select: { estimate: { select: { id: true, estimate_number: true } } },
  }) : null;
  if (deposit?.estimate) {
    await tx.timelineEvent.create({
      data: {
        organization_id: ctx.organizationId,
        entity_type: 'ESTIMATE',
        entity_id: deposit.estimate.id,
        event_type: 'DEPOSIT_PAID',
        description: `Deposit paid by bank payment for estimate ${deposit.estimate.estimate_number}`,
        metadata: { payment_intent: payment.stripe_payment_intent_id, method: 'ACH', amount: Number(payment.amount) },
      },
    });
  }
  await tx.timelineEvent.create({
    data: {
      organization_id: ctx.organizationId,
      entity_type: 'INVOICE',
      entity_id: payment.invoice_id,
      event_type: action.to === 'SUCCEEDED' ? 'PAYMENT_RECEIVED' : 'PAYMENT_FAILED',
      description: action.to === 'SUCCEEDED'
        ? 'Bank payment cleared'
        : 'Bank payment failed; the balance is open for payment again',
      metadata: { payment_id: action.paymentId, stripe_payment_intent_id: payment.stripe_payment_intent_id, event_id: ctx.eventId, amount: Number(payment.amount) },
    },
  });
  // S06.7: a bank payment that cleared and was applied is money collected: on the job's own history
  // too. What the invoice could not take (an excess) was written down as an unapplied capture instead.
  if (action.to === 'SUCCEEDED' && settled.invoice) {
    const appliedCents = toCents(payment.amount) - (settled.unapplied?.record.amountCents ?? 0);
    await recordJobMoneyMovement(
      tx, { orgId: ctx.organizationId, userId: null }, payment.invoice.job_id,
      { id: payment.invoice_id, invoice_number: payment.invoice.invoice_number }, 'PAYMENT_RECORDED',
      { amount: fromCents(appliedCents), method: payment.method, online: true, invoiceEventType: 'PAYMENT_RECEIVED', paymentId: action.paymentId },
    );
  }
  return {
    ...settled,
    bankOutcome: {
      paymentId: action.paymentId, invoiceId: payment.invoice_id, invoiceNumber: payment.invoice.invoice_number,
      amount: fromCents(toCents(payment.amount)), to: action.to,
    },
  };
}

/**
 * A customer disputed a payment, or the bank returned a bank payment after it cleared: the dispute
 * record, and (decide() said the invoice can) the invoice reads DISPUTED with its history entry.
 * The money is not touched: a dispute can still be won.
 */
async function openDispute(
  tx: Prisma.TransactionClient,
  action: Extract<LedgerAction, { type: 'open_dispute' }>,
  ctx: ApplyContext,
): Promise<void> {
  await lockInvoice(tx, action.invoiceId, ctx.organizationId);
  await tx.dispute.create({
    data: {
      organization_id: ctx.organizationId,
      invoice_id: action.invoiceId,
      payment_id: action.paymentId,
      stripe_dispute_id: action.processorDisputeId,
      status: action.status,
      reason: action.reason,
      amount: fromCents(action.amountCents),
      evidence_due_by: action.evidenceDueBy,
      is_bank_return: action.bankReturn,
    },
  });
  if (!action.markInvoiceDisputed) return;
  const invoice = await updateInvoiceInOrg(tx, action.invoiceId, ctx.organizationId, {
    status: 'DISPUTED', stripe_dispute_id: action.processorDisputeId,
  });
  await tx.timelineEvent.create({
    data: {
      organization_id: ctx.organizationId,
      entity_type: 'INVOICE',
      entity_id: action.invoiceId,
      event_type: 'INVOICE_DISPUTED',
      description: action.bankReturn
        ? `The bank returned the payment on invoice ${invoice.invoice_number}`
        : `Card payment disputed on invoice ${invoice.invoice_number}`,
      metadata: { processor_dispute_id: action.processorDisputeId, payment_id: action.paymentId, bank_return: action.bankReturn, event_id: ctx.eventId, amount: action.amountCents / 100 },
    },
  });
}

/** The history entry for a dispute that closed with the payment standing. A partial loss writes its own. */
const RESTORED_HISTORY = {
  WON: { eventType: 'INVOICE_DISPUTE_WON', says: (n: string) => `Dispute closed in your favor on invoice ${n}; the payment stands` },
  CLOSED: {
    eventType: 'INVOICE_DISPUTE_CLOSED',
    says: (n: string) => `Payment inquiry on invoice ${n} closed without a chargeback; the payment stands`,
  },
} as const;

/**
 * The payment stands (won, an inquiry closed, or a lost dispute that took back only part of it):
 * the invoice leaves DISPUTED for the status decide() derived from its SUCCEEDED payments and
 * refunds, and its totals are re-derived under the lock.
 */
async function restoreInvoiceStatus(
  tx: Prisma.TransactionClient,
  action: Extract<LedgerAction, { type: 'restore_invoice_status' }>,
  ctx: ApplyContext,
): Promise<{ id: string; invoice_number: string } | null> {
  await lockInvoice(tx, action.invoiceId, ctx.organizationId);
  // Slice 29 (from the slice 13 review): a bank debit that cleared while the invoice was DISPUTED
  // took its balance to $0 without paying it (no paid date, no INVOICE_PAID). When the restore
  // lands on PAID and the invoice was never paid, this is the moment it is paid in full: the paid
  // date, the history entry and (after commit) the INVOICE_PAID automation, as every payment door
  // does. An invoice paid before the dispute keeps its paid date and its one INVOICE_PAID.
  const before = await tx.invoice.findFirstOrThrow({
    where: { id: action.invoiceId, organization_id: ctx.organizationId },
    select: { paid_at: true },
  });
  const becamePaid = action.to === 'PAID' && before.paid_at === null;
  const invoice = await updateInvoiceInOrg(tx, action.invoiceId, ctx.organizationId, {
    status: action.to, stripe_dispute_id: null, ...(becamePaid ? { paid_at: new Date() } : {}),
  });
  if (action.outcome !== 'LOST_PARTIAL') {
    const history = RESTORED_HISTORY[action.outcome];
    await tx.timelineEvent.create({
      data: {
        organization_id: ctx.organizationId,
        entity_type: 'INVOICE',
        entity_id: action.invoiceId,
        event_type: history.eventType,
        description: history.says(invoice.invoice_number),
        metadata: { processor_dispute_id: action.processorDisputeId, restored_status: action.to, event_id: ctx.eventId },
      },
    });
  }
  await rederiveRefundTotals(tx, { invoiceId: action.invoiceId, organizationId: ctx.organizationId });
  if (!becamePaid) return null;
  await tx.timelineEvent.create({
    data: {
      organization_id: ctx.organizationId,
      entity_type: 'INVOICE',
      entity_id: action.invoiceId,
      event_type: 'INVOICE_PAID',
      description: `Invoice ${invoice.invoice_number} paid in full`,
      metadata: { processor_dispute_id: action.processorDisputeId, event_id: ctx.eventId },
    },
  });
  return { id: action.invoiceId, invoice_number: invoice.invoice_number };
}

/**
 * A lost dispute took back only part of the payment (conductor ruling 2026-10-07): the payment
 * and the balance stay as they are, and the history says the balance needs a manual review. The
 * billing alert goes out with the closed-dispute notice once the transaction commits.
 */
async function flagPartialChargeback(
  tx: Prisma.TransactionClient,
  action: Extract<LedgerAction, { type: 'flag_partial_chargeback' }>,
  ctx: ApplyContext,
): Promise<void> {
  await lockInvoice(tx, action.invoiceId, ctx.organizationId);
  const invoice = await tx.invoice.findFirstOrThrow({
    where: { id: action.invoiceId, organization_id: ctx.organizationId },
    select: { invoice_number: true },
  });
  const taken = action.bankReturn ? 'The bank returned' : 'A lost dispute took back';
  await tx.timelineEvent.create({
    data: {
      organization_id: ctx.organizationId,
      entity_type: 'INVOICE',
      entity_id: action.invoiceId,
      event_type: 'CHARGEBACK_PARTIAL',
      description: `${taken} part of the payment on invoice ${invoice.invoice_number}. `
        + 'The payment and the balance were left as they are; the balance needs a manual review.',
      metadata: {
        processor_dispute_id: action.processorDisputeId, payment_id: action.paymentId,
        disputed_cents: action.disputedCents, unrefunded_cents: action.unrefundedCents, event_id: ctx.eventId,
      },
    },
  });
}

/**
 * The dispute was lost (or the bank returned the payment): the processor took the money back. The
 * payment is voided as a chargeback and the balance reopens, through the system void the chargeback
 * path has always used (it also un-applies a charged-back deposit's credit). A voided invoice is
 * left VOIDED with its balance untouched. Read under the lock.
 */
async function voidDisputedPayment(
  tx: Prisma.TransactionClient,
  action: Extract<LedgerAction, { type: 'void_disputed_payment' }>,
  ctx: ApplyContext,
): Promise<{ reopened: string[]; notice: Omit<BankReturnNotice, 'eventId' | 'disputeId'> | null }> {
  await lockInvoice(tx, action.invoiceId, ctx.organizationId);
  const payment = await tx.payment.findFirstOrThrow({
    where: { id: action.paymentId, invoice: { id: action.invoiceId, organization_id: ctx.organizationId } },
    select: { id: true, amount: true, method: true, stripe_payment_intent_id: true, voided_at: true, state: true },
  });
  // Only a SUCCEEDED payment took the balance down, so only it can reopen the balance. Nothing was voided here, so a
  // replayed event owes the customer nothing.
  if (payment.voided_at || payment.state !== 'SUCCEEDED') return { reopened: [], notice: null };
  const invoice = await tx.invoice.findFirstOrThrow({
    where: { id: action.invoiceId, organization_id: ctx.organizationId },
    select: { id: true, amount_due: true, total_amount: true, status: true, kind: true, invoice_number: true },
  });
  const reopened = await systemVoidPaymentForChargeback(tx, {
    payment,
    invoice,
    disputeId: action.processorDisputeId,
    orgId: ctx.organizationId,
    bankReturn: action.bankReturn,
  });
  if (action.stayDisputed) {
    await updateInvoiceInOrg(tx, action.invoiceId, ctx.organizationId, { status: 'DISPUTED' });
  }
  await rederiveRefundTotals(tx, { invoiceId: action.invoiceId, organizationId: ctx.organizationId });
  // The invoice as it stands after the void, under the same lock.
  const after = await tx.invoice.findFirstOrThrow({
    where: { id: action.invoiceId, organization_id: ctx.organizationId },
    select: { status: true, kind: true, total_amount: true },
  });
  const deposit = after.kind === 'DEPOSIT';
  return {
    reopened,
    notice: {
      invoiceId: action.invoiceId,
      paymentId: payment.id,
      amountCents: toCents(payment.amount),
      deposit,
      voided: after.status === 'VOIDED',
      // Reopened (a VOIDED invoice is never asked to pay), open for online payment (a DISPUTED one, including while
      // another dispute is open, is not), and not already covered by another payment (C-38).
      payAgain: reopened.includes(action.invoiceId) && checkoutOpenStatus(after.status, deposit)
        && !(await paidByOtherPayments(tx, { invoiceId: action.invoiceId, organizationId: ctx.organizationId, exceptPaymentId: payment.id, totalAmount: after.total_amount })),
    },
  };
}

/**
 * Whether the invoice's other live payments (a SUCCEEDED or PROCESSING one, the deposit credit included) already cover
 * its total: then the customer owes nothing to pay again, and asking them would be wrong (C-38). Read under the lock.
 */
async function paidByOtherPayments(
  tx: Prisma.TransactionClient,
  args: { invoiceId: string; organizationId: string; exceptPaymentId: string; totalAmount: Prisma.Decimal | number },
): Promise<boolean> {
  const others = await tx.payment.findMany({
    where: {
      invoice: { id: args.invoiceId, organization_id: args.organizationId },
      id: { not: args.exceptPaymentId }, voided_at: null, state: { in: ['SUCCEEDED', 'PROCESSING'] },
    },
    select: { amount: true },
  });
  return others.reduce((sum, p) => sum + toCents(p.amount), 0) >= toCents(args.totalAmount);
}

/**
 * The bank returned a bank payment that was still clearing: it never took the balance down, so the
 * balance and the invoice status stay as they are. The payment is marked FAILED (only a PROCESSING
 * one, re-checked under the lock), so the later "cleared" event finds nothing to settle.
 */
async function failDisputedPayment(
  tx: Prisma.TransactionClient,
  action: Extract<LedgerAction, { type: 'fail_disputed_payment' }>,
  ctx: ApplyContext,
): Promise<Omit<BankReturnNotice, 'eventId' | 'disputeId'> | null> {
  await lockInvoice(tx, action.invoiceId, ctx.organizationId);
  const failed = await tx.payment.updateMany({
    where: { id: action.paymentId, state: 'PROCESSING', invoice: { id: action.invoiceId, organization_id: ctx.organizationId } },
    data: { state: 'FAILED' },
  });
  if (failed.count === 0) return null;
  const invoice = await tx.invoice.findFirstOrThrow({
    where: { id: action.invoiceId, organization_id: ctx.organizationId },
    select: { invoice_number: true, status: true, kind: true, total_amount: true },
  });
  const taken = action.bankReturn ? 'The bank returned the payment' : 'A lost dispute took back the payment';
  await tx.timelineEvent.create({
    data: {
      organization_id: ctx.organizationId,
      entity_type: 'INVOICE',
      entity_id: action.invoiceId,
      event_type: 'PAYMENT_RETURNED',
      description: `${taken} on invoice ${invoice.invoice_number} before it cleared. `
        + 'The payment was marked failed; it was never counted, so the balance is unchanged.',
      metadata: { processor_dispute_id: action.processorDisputeId, payment_id: action.paymentId, event_id: ctx.eventId, amount: action.amountCents / 100 },
    },
  });
  // What the customer owes again is the payment's own face amount, not the dispute amount (which includes the tip).
  const payment = await tx.payment.findFirstOrThrow({
    where: { id: action.paymentId, invoice: { id: action.invoiceId, organization_id: ctx.organizationId } },
    select: { amount: true },
  });
  const deposit = invoice.kind === 'DEPOSIT';
  return {
    invoiceId: action.invoiceId,
    paymentId: action.paymentId,
    amountCents: toCents(payment.amount),
    deposit,
    voided: invoice.status === 'VOIDED',
    // Open for online payment as read under the lock (a DISPUTED invoice is not), and not already covered by another payment (C-38).
    payAgain: checkoutOpenStatus(invoice.status, deposit)
      && !(await paidByOtherPayments(tx, { invoiceId: action.invoiceId, organizationId: ctx.organizationId, exceptPaymentId: action.paymentId, totalAmount: invoice.total_amount })),
  };
}

/** The staff-facing record of money that was captured and not applied. Names no processor. */
function unappliedCapture(
  action: Extract<LedgerAction, { type: 'record_unapplied_capture' }>,
  ctx: ApplyContext,
): UnappliedCapture {
  const label = action.paymentLabel;
  const on = action.invoice ? `on invoice ${action.invoice.invoiceNumber}` : '';
  const description = (() => {
    switch (action.reason) {
      case 'DEPOSIT_SUPERSEDED':
        return `${label} on deposit ${action.invoice?.invoiceNumber} was not recorded: the estimate changed after this deposit was sent, so the amount paid is no longer the amount owed.`;
      case 'DEPOSIT_ON_HOLD':
        return `${label} on deposit ${action.invoice?.invoiceNumber} was not recorded: the estimate was sent back to draft, so this deposit request is on hold until it is sent again.`;
      case 'INVOICE_NOT_PAYABLE':
        return `${label} ${on} was not recorded: ${notPayableBecause(action.invoiceStatus)}`;
      case 'INVOICE_NOT_FOUND':
      case 'WRONG_ORG':
        return `${label} was not recorded: it does not belong to any invoice in this account.`;
      case 'DOCUMENT_MISMATCH':
        return `${label} ${on} was not recorded: the payment was made for a different document than this invoice.`;
      case 'REFUND_UNMATCHED':
        return `${label} sent from this account was not recorded: it does not match any payment ServWave recorded.`;
      case 'AMOUNT_MISMATCH':
      default:
        return `${label} ${on} was not recorded: the amount paid does not match the amount owed.`;
    }
  })();
  return {
    organizationId: action.organizationId,
    invoice: action.invoice ? { id: action.invoice.id, invoice_number: action.invoice.invoiceNumber } : null,
    description,
    metadata: {
      reason: action.reason,
      expected_cents: action.expectedCents,
      charged_cents: action.chargedCents,
      payment_intent: action.processorPaymentIntentId,
      checkout_session: action.checkoutSessionId,
      ...(action.processorRefundId ? { processor_refund_id: action.processorRefundId } : {}),
      ...(action.invoiceStatus ? { invoice_status: action.invoiceStatus } : {}),
      event_id: ctx.eventId,
    },
    // The processor retries; one alert per event, not one per delivery.
    dedupKey: `billing.payment_unrecorded:${ctx.eventId}`,
    notificationData: { payment_label: label },
    record: {
      amountCents: action.chargedCents,
      paymentIntentId: action.processorPaymentIntentId,
      checkoutSessionId: action.checkoutSessionId,
      accountId: ctx.accountId ?? null,
      refundId: action.processorRefundId ?? null,
      // One record per money: the refund that went out, the session that took it, else the event.
      sourceKey: action.processorRefundId
        ? `refund:${action.processorRefundId}`
        : action.checkoutSessionId ? `checkout:${action.checkoutSessionId}` : `event:${ctx.eventId}`,
    },
  };
}

/** Why an invoice could not take the payment, in staff words. */
function notPayableBecause(status: Extract<LedgerAction, { type: 'record_unapplied_capture' }>['invoiceStatus']): string {
  switch (status) {
    case 'PAID':
      return 'the invoice was already paid in full when the payment completed.';
    case 'VOIDED':
      return 'the invoice was voided before the payment completed.';
    default:
      return 'the invoice was not open for payment when the payment completed.';
  }
}

/**
 * Update an invoice of this org only: the write itself is scoped, not just the read that led to
 * it. An invoice outside the org (or none) throws (no record to update), which fails the event:
 * it rolls back and is retried.
 */
async function updateInvoiceInOrg(
  tx: Prisma.TransactionClient,
  invoiceId: string,
  organizationId: string,
  data: Prisma.InvoiceUpdateInput,
): Promise<{ invoice_number: string }> {
  return tx.invoice.update({ where: { id: invoiceId, organization_id: organizationId }, data, select: { invoice_number: true } });
}

async function lockInvoice(tx: Prisma.TransactionClient, invoiceId: string, organizationId: string): Promise<void> {
  await tx.$executeRaw`SELECT id FROM invoices WHERE id = ${invoiceId}::uuid AND organization_id = ${organizationId}::uuid FOR UPDATE`;
}

/**
 * A Refund row needs a user (refunded_by). A refund made outside ServWave has none, so it is
 * attributed to the org's first admin, as the old charge.refunded door did.
 */
async function systemActor(tx: Prisma.TransactionClient, organizationId: string): Promise<string> {
  const admin = await tx.user.findFirst({
    where: { organization_id: organizationId, is_admin: true },
    orderBy: { created_at: 'asc' },
    select: { id: true },
  });
  const anyone = admin ?? await tx.user.findFirst({ where: { organization_id: organizationId }, orderBy: { created_at: 'asc' }, select: { id: true } });
  // No user at all: fail the event so the processor retries, rather than lose the refund.
  if (!anyone) throw new Error(`reconciler: org ${organizationId} has no user to attribute a refund to`);
  return anyone.id;
}
