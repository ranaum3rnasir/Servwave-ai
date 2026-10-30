/**
 * Payments go-live slice 07 (PRD Module 4) - the payment event reconciler's DECIDE step.
 *
 * Pure: a verified processor event and a snapshot of the ledger rows it touches go in; an ordered
 * list of ledger actions comes out. No reads, no writes, no clock. The apply step (apply.ts)
 * executes the actions in one transaction. Working from the snapshot, not from the order events
 * arrive in, is what makes out-of-order delivery safe: a refund.updated that lands before its
 * refund.created simply finds no row and records it, and the late refund.created then finds the
 * row and has nothing left to do.
 *
 * Refunds are keyed on the processor's refund id. An in-app refund writes its row with that id
 * before the event arrives, so the event only moves the row's state. A refund made outside
 * ServWave has no row, and is recorded once.
 *
 * Slice 08 adds completed card checkouts (decideCheckoutCompleted below), slice 09 disputes and
 * late bank returns (decideDispute), slice 10 account events (decideAccount).
 */
import type { DisputeStatus, InvoiceKind, InvoiceStatus, PaymentMethod, PaymentState, PaymentWallet, RefundState } from '@prisma/client';
import type { UnappliedCaptureReason } from '../../lib/unapplied-capture';
import { MIN_PARTIAL_PAYMENT_CENTS } from '../../lib/checkout-pricing';
import { checkoutOpenStatus } from '../../lib/public-pay-state';
import { impliedMoneyStatus } from '../../lib/invoice-money-status';
import { syncedAcceptedMethods } from '../../lib/payment-methods';
import type { AccountStatusDecision, AccountStatusFlags } from '../../lib/account-status';

export const REFUND_EVENT_TYPES = ['refund.created', 'refund.updated', 'refund.failed'] as const;
export type RefundEventType = (typeof REFUND_EVENT_TYPES)[number];

/** The processor's refund object, as sent at the pinned API version. Amounts are in cents. */
export interface ProcessorRefund {
  id: string;
  object?: 'refund';
  amount: number;
  status: string | null;
  payment_intent: string | null;
  charge?: string | null;
  /** Why a failed refund failed (the processor's code; stored, never shown). */
  failure_reason?: string | null;
  metadata?: Record<string, string> | null;
}

export interface RefundEvent {
  id: string;
  type: RefundEventType;
  account?: string;
  data: { object: ProcessorRefund };
}

/** The ledger rows a refund event touches, read inside the owning org. */
export interface RefundSnapshot {
  /** This event id is already in the processed-event record. */
  eventAlreadyProcessed: boolean;
  /** The org that owns the connected account the event arrived on. */
  organizationId: string;
  /** The Refund row carrying this processor refund id, if ServWave has one. */
  refund: {
    id: string;
    invoiceId: string;
    state: RefundState;
    /** Recorded by the reconciler as made outside ServWave (an in-app refund wrote its own history). */
    external?: boolean;
  } | null;
  /** The Payment the refunded charge paid, if ServWave recorded it. */
  payment: {
    id: string;
    invoiceId: string;
    method: PaymentMethod;
    /** The payment's face amount, in cents. */
    amountCents: number;
    /** Legacy card service fee + tip on the same charge, in cents (0 for new payments). */
    extrasCents: number;
  } | null;
  /** A refund matching no payment that an earlier event for the same refund id already wrote down. */
  unmatchedRefundRecorded?: boolean;
  /**
   * Slice 11: the "Payments needing attention" record this refund sends back (ServWave sent it from
   * the list: it carries the record's refund id, or names the record and its payment intent).
   */
  attentionRecord?: {
    id: string;
    status: 'OPEN' | 'REFUNDED' | 'RESOLVED';
    refundId: string | null;
    /** The payment row the record's money sits on (a bank payment that cleared onto the invoice), if any. */
    paymentId?: string | null;
    /** Refunds sent for this record that the processor reported failed (never mark it REFUNDED). */
    failedRefundIds?: string[];
  } | null;
}

// ---- Completed checkouts (slice 08) -----------------------------------------------------------

/**
 * A checkout completed; and, for a bank debit (slice 13), the debit later cleared or failed. A bank
 * session completes 'unpaid' and is booked PROCESSING; the async events then settle it.
 */
export const CHECKOUT_EVENT_TYPES = [
  'checkout.session.completed',
  'checkout.session.async_payment_succeeded',
  'checkout.session.async_payment_failed',
] as const;
export type CheckoutEventType = (typeof CHECKOUT_EVENT_TYPES)[number];

/** The processor's checkout session, as sent at the pinned API version. Amounts are in cents. */
export interface ProcessorCheckoutSession {
  id: string;
  object?: 'checkout.session';
  payment_intent: string | null;
  /** 'paid' for a card. A bank debit completes 'unpaid' and settles later (slice 13). */
  payment_status?: string | null;
  amount_total: number | null;
  /** What ServWave built the session against (invoiceId, and from slice 12 organizationId, kind, payableNowCents; tipCents). */
  metadata?: Record<string, string> | null;
}

export interface CheckoutEvent {
  id: string;
  type: CheckoutEventType;
  account?: string;
  /** When the processor created the event (unix seconds). */
  created?: number;
  data: { object: ProcessorCheckoutSession };
}

export type CheckoutCompletedEvent = CheckoutEvent & { type: 'checkout.session.completed' };

export function isCheckoutEvent(event: { type: string }): event is CheckoutEvent {
  return (CHECKOUT_EVENT_TYPES as readonly string[]).includes(event.type);
}

// ---- Disputes and late bank returns (slice 09) ------------------------------------------------

export const DISPUTE_EVENT_TYPES = ['charge.dispute.created', 'charge.dispute.updated', 'charge.dispute.closed'] as const;
export type DisputeEventType = (typeof DISPUTE_EVENT_TYPES)[number];

/** The processor's dispute object, as sent at the pinned API version. Amounts are in cents. */
export interface ProcessorDispute {
  id: string;
  object?: 'dispute';
  amount: number;
  /** warning_needs_response, warning_under_review, warning_closed, needs_response, under_review, won, lost. */
  status: string;
  reason?: string | null;
  payment_intent: string | null;
  charge?: string | null;
  evidence_details?: { due_by?: number | null } | null;
  /** us_bank_account for a bank payment (a late bank return), card for a card. */
  payment_method_details?: { type?: string | null } | null;
}

export interface DisputeEvent {
  id: string;
  type: DisputeEventType;
  account?: string;
  data: { object: ProcessorDispute };
}

/** The rows a dispute event touches, read inside the owning org under the invoice lock. */
export interface DisputeSnapshot {
  eventAlreadyProcessed: boolean;
  organizationId: string;
  /** The dispute row ServWave holds for this processor dispute id. */
  dispute: { id: string; status: DisputeStatus; amountCents: number; evidenceDueBy: Date | null } | null;
  /** The disputed payment, found by its charge or payment intent inside the org. */
  payment: {
    id: string;
    invoiceId: string;
    method: PaymentMethod;
    /** Only a SUCCEEDED payment took the balance down; a PROCESSING (clearing) or FAILED one never did. */
    state: PaymentState;
    voided: boolean;
    /** The payment's face amount, in cents (what the invoice ledger counts; no tip or card fee). */
    amountCents: number;
    /** Legacy card service fee + tip on the same charge, in cents: charged, never on the invoice. */
    extrasCents: number;
    /** The payment's face amount less its SUCCEEDED refunds (booked in face cents), in cents. */
    unrefundedCents: number;
  } | null;
  /** The disputed payment's invoice: what its SUCCEEDED payments and refunds add up to. */
  invoice: {
    id: string;
    invoiceNumber: string;
    status: InvoiceStatus;
    amountDueCents: number;
    /**
     * SUCCEEDED, not voided payments, applied deposit credit aside, less money sent back from
     * "Payments needing attention" (never the invoice's money).
     */
    paidCents: number;
    /**
     * SUCCEEDED refunds on payments that still stand (one on a voided payment left with it), less
     * money sent back from "Payments needing attention".
     */
    refundedCents: number;
    /** Any SUCCEEDED payment on the invoice, applied deposit credit included. */
    anyMoneyLanded: boolean;
  } | null;
  /** Other disputes on the same invoice that are still open. */
  otherOpenDisputes: number;
}

// ---- Payout events (payouts slice P2) ----------------------------------------------------------

export const PAYOUT_EVENT_TYPES = ['payout.created', 'payout.updated', 'payout.paid', 'payout.failed', 'payout.canceled'] as const;
export type PayoutEventType = (typeof PAYOUT_EVENT_TYPES)[number];

/** The payout object as a payout event carries it (cents; unix seconds). The destination is an id unless expanded. */
export interface ProcessorPayout {
  id: string;
  amount: number;
  status: string;
  automatic?: boolean;
  arrival_date?: number | null;
  created?: number | null;
  failure_code?: string | null;
  destination?: string | { bank_name?: string | null; last4?: string | null } | null;
}

/** An event about a payout. It only ever fills ServWave's own payouts table; no ledger action follows from it. */
export interface PayoutEvent {
  id: string;
  type: PayoutEventType;
  account?: string;
  data: { object: ProcessorPayout };
}

export function isPayoutEvent(event: { type: string }): event is PayoutEvent {
  return (PAYOUT_EVENT_TYPES as readonly string[]).includes(event.type);
}

// ---- Account events (slice 10) ----------------------------------------------------------------

export const ACCOUNT_EVENT_TYPES = ['account.updated', 'account.application.deauthorized'] as const;
export type AccountEventType = (typeof ACCOUNT_EVENT_TYPES)[number];

/**
 * An event about a connected account. Its payload is never trusted for the account's state (events
 * arrive out of order): account.updated reads the account back from the processor.
 */
export interface AccountEvent {
  id: string;
  type: AccountEventType;
  account?: string;
  data: { object: unknown };
}

export function isAccountEvent(event: { type: string }): event is AccountEvent {
  return (ACCOUNT_EVENT_TYPES as readonly string[]).includes(event.type);
}

/** What an account event touches: the org's stored status, read under the org row lock. */
export interface AccountSnapshot {
  eventAlreadyProcessed: boolean;
  organizationId: string;
  accountId: string;
  stored: { acceptedMethods: readonly PaymentMethod[]; chargesEnabled: boolean; payoutsEnabled: boolean };
  /**
   * account.updated: what the processor says about the account now (lib/account-status's
   * fail-closed decision over the account read back for this write). Null for a deauthorization.
   */
  status: AccountStatusDecision | null;
}

export type ReconcilerEvent = RefundEvent | CheckoutEvent | DisputeEvent | AccountEvent;

/** How a charge was paid, read from the processor's charge, for display. */
export interface ChargeDetails {
  id: string;
  /** The charge's creation time: when the customer paid. */
  createdAt: Date;
  wallet: PaymentWallet | null;
  cardBrand: string | null;
  cardLast4: string | null;
  /** A bank debit's bank name and account last four (null for a card). */
  bankName: string | null;
  bankLast4: string | null;
}

/** The rows a completed checkout touches. Invoice figures are read under the invoice lock. */
export interface CheckoutSnapshot {
  eventAlreadyProcessed: boolean;
  /** The org that owns the connected account the event arrived on; null = an account ServWave does not know. */
  organization: { id: string } | null;
  /** The invoice the session names, wherever it lives (its org is checked here); null = no such invoice. */
  invoice: {
    id: string;
    invoiceNumber: string;
    organizationId: string;
    status: InvoiceStatus;
    kind: InvoiceKind;
    amountDueCents: number;
    /** The invoice total: what an invoice closed for payment was expected to collect. */
    totalCents: number;
    /** Bank payments still clearing on the invoice: not payable a second time meanwhile. */
    processingCents: number;
    /** A deposit whose estimate was recalled to draft, or changed after the deposit was sent. */
    depositHold: 'ESTIMATE_IN_DRAFT' | 'SUPERSEDED' | null;
    /** A deposit whose estimate was declined, cancelled or expired: the money is booked, the estimate is not won. */
    estimateClosed: boolean;
  } | null;
  /**
   * A payment already booked for this checkout session or charge: a bank debit sits PROCESSING
   * until it clears or fails; a bank return before it cleared leaves it FAILED.
   */
  bookedPayment: { id: string; state: PaymentState; voided: boolean; amountCents: number; chargeId: string | null } | null;
  /** Money from this checkout session already written down as not applied (under another event id). */
  captureRecorded?: boolean;
  /** The charge the session made; null when the processor could not return it, or it does not exist yet. */
  charge: ChargeDetails | null;
  /**
   * The bank account on the session's payment method. A bank checkout whose account was entered by
   * hand completes before the micro-deposits are verified, so before any charge exists: the bank
   * name and last four are read from here then.
   */
  bankAccount?: { bankName: string | null; bankLast4: string | null } | null;
}

export type LedgerAction =
  /**
   * A refund ServWave has no row for: write one, keyed on the processor's refund id. With no row
   * behind it nothing proves a staff member made it, so it is booked as made outside ServWave
   * (history and audit row), whatever marker it carries.
   */
  | {
      type: 'record_refund';
      processorRefundId: string;
      invoiceId: string;
      paymentId: string;
      method: PaymentMethod;
      /** Face amount given back against the invoice, in cents (legacy fee and tip stripped). */
      amountCents: number;
      state: RefundState;
      /**
       * Slice 11: money sent back from "Payments needing attention" that sat on this payment (never
       * the invoice's money): booked with its own reason, never as a refund made outside ServWave.
       */
      unapplied?: true;
    }
  /** A refund ServWave already has: move its state (PENDING -> SUCCEEDED / FAILED, SUCCEEDED -> FAILED). */
  | { type: 'set_refund_state'; refundId: string; invoiceId: string; to: 'SUCCEEDED' | 'FAILED' }
  /**
   * A refund failed: the money went back to the contractor's balance, not to the customer. The
   * owner must refund the customer another way. Delivered by slice 32; until then apply logs it.
   */
  | { type: 'notify_refund_failed'; processorRefundId: string; invoiceId: string }
  /**
   * A refund made outside ServWave has landed (SUCCEEDED): write its history on the invoice and the
   * audit row. Never for a PENDING or FAILED one, which gave nothing back.
   */
  | { type: 'record_outside_refund_history'; processorRefundId: string; invoiceId: string }
  /**
   * A checkout that applies to its invoice: book the payment. SUCCEEDED takes the balance down. A
   * bank debit that started is PROCESSING: the row only (the balance and status stay; what can be
   * paid online drops). A bank debit whose failure arrived before its completion is FAILED: the
   * row only, so the late completion books nothing.
   */
  | {
      type: 'record_payment';
      organizationId: string;
      invoiceId: string;
      kind: InvoiceKind;
      method: 'CARD' | 'ACH';
      state: PaymentState;
      /** Applied to the invoice, in cents (the tip rides on the payment, never on the invoice). */
      amountCents: number;
      tipCents: number;
      /** The charge's creation time; null = not known (apply uses the time it runs). */
      paidAt: Date | null;
      /** True when the payment covers the whole balance (once SUCCEEDED the invoice is PAID). */
      paysInFull: boolean;
      /** The deposit's estimate is closed (declined, cancelled, expired): record the money, win nothing. */
      estimateClosed: boolean;
      processorPaymentIntentId: string | null;
      processorChargeId: string | null;
      checkoutSessionId: string;
      connectedAccountId: string | null;
      wallet: PaymentWallet | null;
      cardBrand: string | null;
      cardLast4: string | null;
      bankName: string | null;
      bankLast4: string | null;
    }
  /**
   * A bank debit still PROCESSING reached its outcome. SUCCEEDED applies the money to the invoice
   * (settlePayment's rules); FAILED changes only the payment's state, so payable-now goes back up.
   */
  | {
      type: 'settle_payment';
      paymentId: string;
      invoiceId: string;
      to: 'SUCCEEDED' | 'FAILED';
      /**
       * The charge a debit booked before its charge existed (the customer entered the account by
       * hand and verified it with micro-deposits after the checkout completed): its id, bank, and
       * paid-at (the charge's creation time) are filled in on the payment as it settles.
       */
      charge?: { id: string; paidAt: Date; bankName: string | null; bankLast4: string | null };
    }
  /**
   * A payment started processing on the invoice: every other checkout link still open for it is
   * closed, so the customer cannot pay the same balance twice while the debit clears.
   */
  | { type: 'expire_open_checkouts'; invoiceId: string }
  /**
   * The customer and the owner hear that a bank payment started, cleared or failed. Delivered by
   * slices 31 (customer) and 32 (owner); until then apply logs it. A failure on an invoice still
   * open for payment carries a pay-again link (payAgain).
   */
  | {
      type: 'notify_bank_payment';
      kind: 'started' | 'cleared' | 'failed';
      invoiceId: string;
      amountCents: number;
      /** The payment is a deposit (its estimate went WON when the debit started). */
      deposit: boolean;
      payAgain: boolean;
    }
  /** Slice 11: the refund sent for a payment needing attention went out; its record reads REFUNDED. */
  | { type: 'mark_unapplied_capture_refunded'; recordId: string; processorRefundId: string }
  /** Slice 11: that refund failed, so the money is still here: the record is open again. */
  | { type: 'reopen_unapplied_capture'; recordId: string; processorRefundId: string }
  /**
   * Slice 11 fix round 2: a refund for the record failed before the record stored it (still OPEN).
   * The failure is kept on the record, so neither the list's own commit nor a late event for that
   * refund ever marks it REFUNDED.
   */
  | { type: 'note_unapplied_capture_refund_failed'; recordId: string; processorRefundId: string }
  /**
   * Money the processor captured that ServWave will not apply: written down where a person finds
   * it (timeline entry, owner notification, audit), never only logged. `invoice` is null when the
   * money cannot be tied to an invoice of this org (none found, or another org's), and the record
   * then sits on the org the money landed in.
   */
  | {
      type: 'record_unapplied_capture';
      reason: UnappliedReason;
      organizationId: string;
      invoice: { id: string; invoiceNumber: string } | null;
      /** Staff-facing name of the money ('Card payment', 'Refund'). */
      paymentLabel: string;
      expectedCents: number | null;
      chargedCents: number | null;
      processorPaymentIntentId: string | null;
      checkoutSessionId: string | null;
      /** A refund that matches no payment: its processor refund id. */
      processorRefundId?: string;
      /** Not payable: the status that closed the invoice for payment (PAID, VOIDED, ...). */
      invoiceStatus?: InvoiceStatus;
    }
  /**
   * A customer disputed a payment (or the bank returned a bank payment after it cleared): write the
   * dispute record, and the invoice reads DISPUTED. The money may still come back (a won dispute).
   */
  | {
      type: 'open_dispute';
      organizationId: string;
      processorDisputeId: string;
      invoiceId: string;
      paymentId: string;
      status: DisputeStatus;
      reason: string | null;
      amountCents: number;
      evidenceDueBy: Date | null;
      bankReturn: boolean;
      /** False for an invoice that cannot read DISPUTED (voided, draft): only the record is written. */
      markInvoiceDisputed: boolean;
    }
  /** A dispute ServWave holds moved on (status, amount, evidence due date); nothing else changes. */
  | {
      type: 'update_dispute';
      processorDisputeId: string;
      status: DisputeStatus;
      reason: string | null;
      amountCents: number;
      evidenceDueBy: Date | null;
    }
  /** A dispute reached its final status (WON, LOST, or CLOSED: an inquiry that never became a chargeback). */
  | {
      type: 'close_dispute';
      processorDisputeId: string;
      status: 'WON' | 'LOST' | 'CLOSED';
      reason: string | null;
      amountCents: number;
      evidenceDueBy: Date | null;
    }
  /**
   * The payment stands (won, an inquiry closed, or a lost dispute that took back only part of it):
   * the invoice leaves DISPUTED for the status its SUCCEEDED payments and refunds imply, which is
   * not always PAID. The outcome picks the history wording; a partial loss writes its own entry.
   */
  | {
      type: 'restore_invoice_status';
      invoiceId: string;
      to: InvoiceStatus;
      processorDisputeId: string;
      outcome: 'WON' | 'CLOSED' | 'LOST_PARTIAL';
    }
  /**
   * A lost dispute took back less than the payment's unrefunded amount. Voiding the whole payment
   * would reopen more than was taken, so the payment and the balance are left as they are and the
   * owner is told the balance needs a manual review (history entry and billing alert).
   */
  | {
      type: 'flag_partial_chargeback';
      invoiceId: string;
      paymentId: string;
      processorDisputeId: string;
      /** What the processor took back, in charged cents (tip and any card fee included). */
      disputedCents: number;
      /** What was left of the charge before it, in charged cents. */
      unrefundedCents: number;
      bankReturn: boolean;
    }
  /**
   * The dispute was lost (or the bank returned the payment): the processor took the money back, so
   * the payment is voided and the balance reopens. With another dispute still open on the invoice,
   * it keeps reading DISPUTED. A voided invoice keeps its status and balance (only the payment is voided).
   */
  | { type: 'void_disputed_payment'; paymentId: string; invoiceId: string; processorDisputeId: string; bankReturn: boolean; stayDisputed: boolean }
  /**
   * The bank returned a bank payment that was still clearing (PROCESSING). It never took the
   * balance down, so nothing is reopened: the payment is marked FAILED, which also means the later
   * "cleared" event finds nothing to settle.
   */
  | { type: 'fail_disputed_payment'; paymentId: string; invoiceId: string; processorDisputeId: string; amountCents: number; bankReturn: boolean }
  /**
   * The owner hears about the dispute. Delivered in-app here; slice 32 adds the email. A bank-return
   * variant says the bank returned the payment.
   */
  /**
   * Store what the processor says about the org's connected account, and the accepted methods it
   * implies (null = unchanged). Written only while the org still holds this account.
   */
  | {
      type: 'update_account_status';
      organizationId: string;
      accountId: string;
      flags: Partial<AccountStatusFlags>;
      acceptedMethods: PaymentMethod[] | null;
    }
  /**
   * The owner hears about the payments account, once per account and occurrence (the dedup key).
   * emailAdmins: the occurrence also emails each active admin, the first time it is notified.
   */
  | {
      type: 'notify_account';
      verb: AccountNoticeVerb;
      organizationId: string;
      accountId: string;
      dedup: string;
      emailAdmins: boolean;
      /** Slice 32: the requirements an action-needed notice is about, sorted; the copy says what to do about them. */
      requirements?: string[];
    }
  | {
      type: 'notify_dispute';
      kind: 'opened' | 'closed';
      processorDisputeId: string;
      invoiceId: string;
      bankReturn: boolean;
      /** Slice 32: what the owner is told about it - how much, why, and by when evidence is due. */
      amountCents: number;
      reason: string | null;
      evidenceDueBy: Date | null;
      outcome?: 'WON' | 'LOST' | 'CLOSED';
      /** A lost dispute that took back only part of the payment. */
      partial?: true;
    };

/** The payments-account notifications. */
export type AccountNoticeVerb =
  | 'billing.payments_activated'
  | 'billing.payouts_activated'
  | 'billing.payments_action_needed'
  | 'billing.payments_paused'
  | 'billing.payments_disconnected';

/** Why captured money was not applied (OVERPAYMENT belongs to the bank-payment settle door). */
export type UnappliedReason = Exclude<UnappliedCaptureReason, 'OVERPAYMENT'>;

export function decide(event: RefundEvent, snapshot: RefundSnapshot): LedgerAction[];
export function decide(event: CheckoutEvent, snapshot: CheckoutSnapshot): LedgerAction[];
export function decide(event: DisputeEvent, snapshot: DisputeSnapshot): LedgerAction[];
export function decide(event: AccountEvent, snapshot: AccountSnapshot): LedgerAction[];
export function decide(
  event: ReconcilerEvent,
  snapshot: RefundSnapshot | CheckoutSnapshot | DisputeSnapshot | AccountSnapshot,
): LedgerAction[] {
  if (isAccountEvent(event)) return decideAccount(event, snapshot as AccountSnapshot);
  if (isCheckoutEvent(event)) return decideCheckout(event, snapshot as CheckoutSnapshot);
  if (isDisputeEvent(event)) return decideDispute(event, snapshot as DisputeSnapshot);
  return decideRefund(event, snapshot as RefundSnapshot);
}

export function isDisputeEvent(event: { type: string }): event is DisputeEvent {
  return (DISPUTE_EVENT_TYPES as readonly string[]).includes(event.type);
}

function decideRefund(event: RefundEvent, snapshot: RefundSnapshot): LedgerAction[] {
  if (snapshot.eventAlreadyProcessed) return [];
  const target = refundStateFor(event);
  const row = snapshot.refund;
  const refund = event.data.object;
  // The refund ServWave sent for a payment needing attention moves that record, and never writes a
  // second "not recorded" entry or an outside-refund history. Money that never sat on a payment row
  // (a checkout ServWave refused to book) touches nothing else. Money that did (a bank payment that
  // cleared for more than the balance, or onto an invoice that could not take it) also comes off
  // that payment in the invoice's totals, once: the refund row is keyed on the refund id (PRD story 40).
  // The processor does not promise event order: a created or updated event for a refund may land
  // after its refund.failed, or the failure may land before the list stored the refund. A refund
  // known to have failed is kept on the record and never marks it REFUNDED. A record someone marked
  // resolved while the refund was on its way out (its answer lost, say) is marked too: the money
  // went back, and that is what the record must say, as the list's own commit does.
  const attention = snapshot.attentionRecord;
  if (attention) {
    const knownFailed = attention.failedRefundIds?.includes(refund.id) ?? false;
    const recordActions: LedgerAction[] = target === 'FAILED'
      ? (attention.status === 'REFUNDED' && attention.refundId === refund.id
        ? [{ type: 'reopen_unapplied_capture', recordId: attention.id, processorRefundId: refund.id }]
        : knownFailed ? [] : [{ type: 'note_unapplied_capture_refund_failed', recordId: attention.id, processorRefundId: refund.id }])
      : ((attention.status === 'OPEN' || attention.status === 'RESOLVED') && !knownFailed
        ? [{ type: 'mark_unapplied_capture_refunded', recordId: attention.id, processorRefundId: refund.id }]
        : []);
    const payment = attention.paymentId && snapshot.payment?.id === attention.paymentId ? snapshot.payment : null;
    if (!payment) return recordActions;
    if (row) {
      if (row.state === target || row.state === 'FAILED' || target === 'PENDING') return recordActions;
      return [...recordActions, { type: 'set_refund_state', refundId: row.id, invoiceId: row.invoiceId, to: target }];
    }
    return [...recordActions, {
      type: 'record_refund',
      processorRefundId: refund.id,
      invoiceId: payment.invoiceId,
      paymentId: payment.id,
      method: payment.method,
      // The record holds face money only (the excess, or a payment's face amount): booked as it is.
      amountCents: refund.amount,
      state: target,
      unapplied: true,
    }];
  }
  const history = (invoiceId: string): LedgerAction =>
    ({ type: 'record_outside_refund_history', processorRefundId: refund.id, invoiceId });
  const failed = (invoiceId: string): LedgerAction[] =>
    target === 'FAILED' ? [{ type: 'notify_refund_failed', processorRefundId: refund.id, invoiceId }] : [];
  if (row) {
    // FAILED is final (nothing went back), and a late "pending" never walks a refund backwards.
    if (row.state === target || row.state === 'FAILED' || target === 'PENDING') return [];
    return [
      { type: 'set_refund_state', refundId: row.id, invoiceId: row.invoiceId, to: target },
      ...(target === 'SUCCEEDED' && row.external ? [history(row.invoiceId)] : []),
      ...failed(row.invoiceId),
    ];
  }
  const payment = snapshot.payment;
  if (payment) {
    return [{
      type: 'record_refund',
      processorRefundId: refund.id,
      invoiceId: payment.invoiceId,
      paymentId: payment.id,
      method: payment.method,
      amountCents: faceCents(refund.amount, payment),
      state: target,
    }, ...(target === 'SUCCEEDED' ? [history(payment.invoiceId)] : []), ...failed(payment.invoiceId)];
  }
  // Money went out of this org's account for a payment ServWave has no record of: written down
  // where the owner finds it, never only logged. Once per refund, however many events it sends.
  if (snapshot.unmatchedRefundRecorded) return [];
  return [{
    type: 'record_unapplied_capture',
    reason: 'REFUND_UNMATCHED',
    organizationId: snapshot.organizationId,
    invoice: null,
    paymentLabel: 'Refund',
    expectedCents: null,
    chargedCents: refund.amount,
    processorPaymentIntentId: refund.payment_intent,
    checkoutSessionId: null,
    processorRefundId: refund.id,
  }];
}

/**
 * The face amount a processor refund gives back against the invoice, in cents. A legacy charge
 * also carried the retired card fee and a tip, which never entered the invoice ledger, so the
 * refund is scaled by the share the face amount was of the whole charge (one rounding). New
 * charges carry neither, and the refund is booked as it is.
 */
function faceCents(refundCents: number, payment: { amountCents: number; extrasCents: number }): number {
  const chargedCents = payment.amountCents + payment.extrasCents;
  if (payment.extrasCents <= 0 || chargedCents <= 0) return refundCents;
  return Math.round((refundCents * payment.amountCents) / chargedCents);
}

/**
 * The inverse of faceCents: what a face amount of the payment was on the charge, in cents (the
 * tip and any legacy card fee scaled back in). Used only to word a figure the way the processor did.
 */
function chargedCentsOf(face: number, payment: { amountCents: number; extrasCents: number }): number {
  if (payment.extrasCents <= 0 || payment.amountCents <= 0) return face;
  return Math.round((face * (payment.amountCents + payment.extrasCents)) / payment.amountCents);
}

/** The ledger state a processor refund is in. */
export function refundStateFor(event: RefundEvent): RefundState {
  if (event.type === 'refund.failed') return 'FAILED';
  const status = event.data.object.status;
  if (status === 'succeeded') return 'SUCCEEDED';
  if (status === 'failed' || status === 'canceled') return 'FAILED';
  return 'PENDING';
}

/**
 * A completed checkout. Paid and applicable: book the payment. Paid and not applicable: record an
 * unapplied capture (never only a log line). Everything is judged from the snapshot, so the order
 * events arrive in does not matter.
 */
function decideCheckout(event: CheckoutEvent, snapshot: CheckoutSnapshot): LedgerAction[] {
  const session = event.data.object;
  const { organization } = snapshot;
  // A replay, or money from this session already written down under another event id.
  if (snapshot.eventAlreadyProcessed || snapshot.captureRecorded) return [];
  // An account ServWave does not know (the sandbox is shared between environments): not ours.
  if (!organization) return [];
  // ServWave builds every session with the invoice it pays; a session without one is not ours.
  if (!session.metadata?.invoiceId) return [];

  if (event.type === 'checkout.session.completed') {
    // Already booked under another event id (or the debit's outcome arrived first): recorded.
    if (snapshot.bookedPayment) return [];
    const status = session.payment_status;
    // A session without the field predates it and is a card payment.
    if (status == null || status === 'paid') {
      const verdict = judgeCheckout(session, snapshot);
      // Slice 14: every booking closes the invoice's other open links, built against the old balance.
      return verdict.ok
        ? [paymentRecord(event, snapshot, verdict, 'CARD', 'SUCCEEDED'), { type: 'expire_open_checkouts', invoiceId: verdict.invoice.id }]
        : captureFor(verdict, event, snapshot, 'Card payment');
    }
    // A bank debit completes before the money moves: booked PROCESSING at once, so what can be
    // paid online drops while it clears. One that cannot be applied books nothing yet: no money
    // has moved, and if the debit clears the money is written down then.
    if (status === 'unpaid') {
      const verdict = judgeCheckout(session, snapshot);
      if (!verdict.ok) return [];
      return [
        paymentRecord(event, snapshot, verdict, 'ACH', 'PROCESSING'),
        { type: 'expire_open_checkouts', invoiceId: verdict.invoice.id },
        bankNotice('started', verdict.invoice, verdict.amountCents),
      ];
    }
    return [];
  }

  // The bank debit cleared or failed.
  const to = event.type === 'checkout.session.async_payment_succeeded' ? 'SUCCEEDED' : 'FAILED';
  const booked = snapshot.bookedPayment;
  if (booked) {
    // Only a payment still clearing moves: one already settled (a duplicate), failed by a bank
    // return that arrived first, or voided stays as it is.
    if (booked.voided || booked.state !== 'PROCESSING' || !snapshot.invoice) return [];
    // Booked before the charge existed (micro-deposit verification comes after the checkout): the
    // charge read now fills in what the booking could not know.
    const { charge } = snapshot;
    const fill = !booked.chargeId && charge
      ? { charge: { id: charge.id, paidAt: charge.createdAt, bankName: charge.bankName, bankLast4: charge.bankLast4 } }
      : {};
    return [
      { type: 'settle_payment', paymentId: booked.id, invoiceId: snapshot.invoice.id, to, ...fill },
      bankNotice(to === 'SUCCEEDED' ? 'cleared' : 'failed', snapshot.invoice, booked.amountCents),
    ];
  }
  // Nothing booked yet: the outcome arrived before the completion (or the completion could not be
  // applied). A debit that cleared is money: booked SUCCEEDED, or written down as not applied.
  const verdict = judgeCheckout(session, snapshot);
  if (to === 'SUCCEEDED') {
    return verdict.ok
      ? [
          paymentRecord(event, snapshot, verdict, 'ACH', 'SUCCEEDED'),
          { type: 'expire_open_checkouts', invoiceId: verdict.invoice.id },
          bankNotice('cleared', verdict.invoice, verdict.amountCents),
        ]
      : captureFor(verdict, event, snapshot, 'Bank payment');
  }
  // A debit that failed moved no money. It is written down FAILED (counted nowhere) on this org's
  // invoice, so the late completion finds it and books nothing.
  const { invoice } = snapshot;
  if (!invoice || invoice.organizationId !== organization.id) return [];
  // What the debit was for, even when it would not have applied (it is a record, not money).
  const tipCents = parseCents(session.metadata.tipCents ?? '0') ?? 0;
  const attempted: Judged = verdict.ok
    ? verdict
    : { ok: true, invoice, amountCents: Math.max((sessionChargedCents(session) ?? 0) - tipCents, 0), tipCents };
  return [paymentRecord(event, snapshot, attempted, 'ACH', 'FAILED'), bankNotice('failed', invoice, attempted.amountCents)];
}

type Judged = {
  ok: true;
  invoice: NonNullable<CheckoutSnapshot['invoice']>;
  amountCents: number;
  tipCents: number;
};
type NotApplied = {
  ok: false;
  reason: UnappliedReason;
  onInvoice: boolean;
  expectedCents: number | null;
  invoiceStatus?: InvoiceStatus;
};

/**
 * Whether a checkout's money applies to its invoice, judged against the invoice read under its
 * lock. The same rules for a card payment, a bank debit that started, and one that cleared.
 */
function judgeCheckout(session: ProcessorCheckoutSession, snapshot: CheckoutSnapshot): Judged | NotApplied {
  const { organization, invoice } = snapshot;
  const meta = session.metadata ?? {};
  const chargedCents = sessionChargedCents(session);
  const tip = parseCents(meta.tipCents ?? '0');
  const no = (reason: UnappliedReason, onInvoice: boolean, expectedCents: number | null, invoiceStatus?: InvoiceStatus): NotApplied =>
    ({ ok: false, reason, onInvoice, expectedCents, ...(invoiceStatus ? { invoiceStatus } : {}) });

  // Tenancy first: the money landed in this org's account, so it is recorded on this org, and an
  // invoice of any other org is never touched (nor named).
  if (!invoice) return no('INVOICE_NOT_FOUND', false, null);
  if (invoice.organizationId !== organization!.id || (meta.organizationId != null && meta.organizationId !== organization!.id)) {
    return no('WRONG_ORG', false, null);
  }
  // What is owed now, read under the invoice lock: the balance less bank payments still clearing.
  const payableCents = invoice.amountDueCents - invoice.processingCents;
  // Slice 26: a partial payment carries the document amount the homeowner chose (amountCents).
  // Absent = the payable-now amount in full, exactly as before.
  const chosen = meta.amountCents != null ? parseCents(meta.amountCents) : undefined;
  const amountCents = chosen === undefined ? payableCents : chosen;
  const expectedCents = (amountCents ?? payableCents) + (tip ?? 0);
  if (meta.kind != null && meta.kind !== (invoice.kind === 'DEPOSIT' ? 'deposit' : 'invoice')) {
    return no('DOCUMENT_MISMATCH', true, expectedCents);
  }
  // W4: a DRAFT with a public link is payable too (a payment link no longer issues the invoice).
  if (!checkoutOpenStatus(invoice.status, invoice.kind === 'DEPOSIT')) {
    // Nothing is owed on a closed invoice, so what it was expected to collect is its total.
    return no('INVOICE_NOT_PAYABLE', true, invoice.totalCents, invoice.status);
  }
  if (invoice.depositHold) {
    return no(invoice.depositHold === 'ESTIMATE_IN_DRAFT' ? 'DEPOSIT_ON_HOLD' : 'DEPOSIT_SUPERSEDED', true, expectedCents);
  }
  // The charge must be exactly what is owed now plus the tip, and the payable-now figure the
  // session was built against. Anything else (a retired card fee, a staff payment that landed
  // meanwhile, a malformed figure) is not guessed at.
  // A partial amount is judged on its own bounds (at least $1, at most what is owed now): the money
  // was taken correctly even if the balance moved a little since the session was built. A full
  // payment must still match the payable-now figure it was built against.
  const builtCents = meta.payableNowCents != null ? parseCents(meta.payableNowCents) : payableCents;
  const partialOk = chosen === undefined || (chosen !== null && chosen >= MIN_PARTIAL_PAYMENT_CENTS && chosen <= payableCents);
  const builtOk = chosen === undefined ? builtCents === payableCents : true;
  if (tip === null || chosen === null || amountCents === null || chargedCents === null || payableCents <= 0 || !partialOk || !builtOk || chargedCents !== expectedCents) {
    return no('AMOUNT_MISMATCH', true, expectedCents);
  }
  return { ok: true, invoice, amountCents, tipCents: tip };
}

const sessionChargedCents = (session: ProcessorCheckoutSession): number | null =>
  typeof session.amount_total === 'number' && Number.isFinite(session.amount_total) ? session.amount_total : null;

/** The payment row a checkout books, from the judged amounts and the charge read back. */
function paymentRecord(
  event: CheckoutEvent, snapshot: CheckoutSnapshot, verdict: Judged, method: 'CARD' | 'ACH', state: PaymentState,
): Extract<LedgerAction, { type: 'record_payment' }> {
  const session = event.data.object;
  const { charge } = snapshot;
  return {
    type: 'record_payment',
    organizationId: snapshot.organization!.id,
    invoiceId: verdict.invoice.id,
    kind: verdict.invoice.kind,
    method,
    state,
    amountCents: verdict.amountCents,
    tipCents: verdict.tipCents,
    paidAt: charge?.createdAt ?? (event.created != null ? new Date(event.created * 1000) : null),
    paysInFull: verdict.amountCents === verdict.invoice.amountDueCents,
    estimateClosed: verdict.invoice.kind === 'DEPOSIT' && verdict.invoice.estimateClosed,
    processorPaymentIntentId: session.payment_intent,
    processorChargeId: charge?.id ?? null,
    checkoutSessionId: session.id,
    connectedAccountId: event.account ?? null,
    wallet: charge?.wallet ?? null,
    cardBrand: charge?.cardBrand ?? null,
    cardLast4: charge?.cardLast4 ?? null,
    bankName: charge?.bankName ?? (method === 'ACH' ? snapshot.bankAccount?.bankName : null) ?? null,
    bankLast4: charge?.bankLast4 ?? (method === 'ACH' ? snapshot.bankAccount?.bankLast4 : null) ?? null,
  };
}

/** Money the processor took that will not be applied: written down, never only logged. */
function captureFor(verdict: NotApplied, event: CheckoutEvent, snapshot: CheckoutSnapshot, paymentLabel: string): LedgerAction[] {
  const session = event.data.object;
  const { invoice } = snapshot;
  return [{
    type: 'record_unapplied_capture',
    reason: verdict.reason,
    organizationId: snapshot.organization!.id,
    invoice: verdict.onInvoice && invoice ? { id: invoice.id, invoiceNumber: invoice.invoiceNumber } : null,
    paymentLabel,
    expectedCents: verdict.expectedCents,
    chargedCents: sessionChargedCents(session),
    processorPaymentIntentId: session.payment_intent,
    checkoutSessionId: session.id,
    ...(verdict.invoiceStatus ? { invoiceStatus: verdict.invoiceStatus } : {}),
  }];
}

/** A bank payment started, cleared or failed: the customer and the owner hear (slices 31/32). */
function bankNotice(
  kind: 'started' | 'cleared' | 'failed',
  invoice: Pick<NonNullable<CheckoutSnapshot['invoice']>, 'id' | 'kind' | 'status'>,
  amountCents: number,
): LedgerAction {
  return {
    type: 'notify_bank_payment',
    kind,
    invoiceId: invoice.id,
    amountCents,
    deposit: invoice.kind === 'DEPOSIT',
    // The debit failed and the invoice is still open: the customer gets a link to pay again.
    payAgain: kind === 'failed' && checkoutOpenStatus(invoice.status, invoice.kind === 'DEPOSIT'),
  };
}

/** A non-negative whole number of cents from session metadata, or null when it is not one. */
function parseCents(value: string): number | null {
  if (!/^\d+$/.test(value)) return null;
  const cents = Number(value);
  return Number.isSafeInteger(cents) ? cents : null;
}

/**
 * A dispute event. Judged from the dispute object's own status and the snapshot, never from the
 * event type or the order events arrive in.
 */
function decideDispute(event: DisputeEvent, snapshot: DisputeSnapshot): LedgerAction[] {
  if (snapshot.eventAlreadyProcessed) return [];
  const dispute = event.data.object;
  const { payment } = snapshot;
  if (!payment) return [];
  const bankReturn = payment.method === 'ACH' || dispute.payment_method_details?.type === 'us_bank_account';
  const dueBy = dispute.evidence_details?.due_by;
  const fields = {
    processorDisputeId: dispute.id,
    status: disputeStatusFor(dispute.status),
    reason: dispute.reason ?? null,
    amountCents: dispute.amount,
    evidenceDueBy: typeof dueBy === 'number' ? new Date(dueBy * 1000) : null,
  };
  const held = snapshot.dispute;
  const closing = isFinal(fields.status);
  if (held) {
    const unchanged = held.status === fields.status && held.amountCents === fields.amountCents
      && (held.evidenceDueBy?.getTime() ?? null) === (fields.evidenceDueBy?.getTime() ?? null);
    if (unchanged || isFinal(held.status)) return [];
    if (!closing) return [{ type: 'update_dispute', ...fields }];
    return closeActions(fields, snapshot, bankReturn, false);
  }
  // Only money that was counted can be disputed on the invoice: a payment still clearing or failed
  // never took the balance down, and a voided one is not counted (COUNTED_PAYMENT_WHERE), so its
  // invoice does not read DISPUTED.
  const markInvoiceDisputed = !!snapshot.invoice && !NOT_DISPUTABLE.includes(snapshot.invoice.status)
    && payment.state === 'SUCCEEDED' && !payment.voided;
  const opened: LedgerAction[] = [
    {
      type: 'open_dispute',
      organizationId: snapshot.organizationId,
      invoiceId: payment.invoiceId,
      paymentId: payment.id,
      ...fields,
      bankReturn,
      markInvoiceDisputed,
    },
    {
      type: 'notify_dispute', kind: 'opened', processorDisputeId: dispute.id, invoiceId: payment.invoiceId, bankReturn,
      amountCents: fields.amountCents, reason: fields.reason, evidenceDueBy: fields.evidenceDueBy,
    },
  ];
  // Already final when ServWave first hears of it (the close arrived before the open, or a bank
  // return that is lost the moment it is raised): open and close in one go.
  return closing ? [...opened, ...closeActions(fields, snapshot, bankReturn, markInvoiceDisputed)] : opened;
}

/** An invoice in these statuses never reads DISPUTED: a dispute on it only writes the record. */
const NOT_DISPUTABLE: readonly InvoiceStatus[] = ['VOIDED', 'DRAFT'];

type DisputeFields = {
  processorDisputeId: string;
  status: DisputeStatus;
  reason: string | null;
  amountCents: number;
  evidenceDueBy: Date | null;
};

const isFinal = (status: DisputeStatus): status is 'WON' | 'LOST' | 'CLOSED' =>
  status === 'WON' || status === 'LOST' || status === 'CLOSED';

/** A dispute reached its final status: close the record, then settle the invoice and the money. */
function closeActions(fields: DisputeFields, snapshot: DisputeSnapshot, bankReturn: boolean, openedNow: boolean): LedgerAction[] {
  const status = fields.status as 'WON' | 'LOST' | 'CLOSED';
  const payment = snapshot.payment!;
  const invoice = snapshot.invoice;
  const actions: LedgerAction[] = [{ type: 'close_dispute', ...fields, status }];
  const readsDisputed = !!invoice && (invoice.status === 'DISPUTED' || openedNow);
  // A lost dispute for less than what is left of the payment took back only part of it: the
  // payment stands, so it is settled like a won one and flagged (conductor ruling 2026-10-07).
  // The dispute amount is in charged cents (tip and any legacy card fee included) and the
  // unrefunded amount in face cents, so the dispute is scaled to face cents the way a refund is
  // booked: a dispute for the whole unrefunded charge comes out at (or a rounding cent over) it.
  const partialLoss = status === 'LOST' && !payment.voided && faceCents(fields.amountCents, payment) < payment.unrefundedCents;
  const paymentStands = status !== 'LOST' || partialLoss;
  if (paymentStands && invoice && readsDisputed && snapshot.otherOpenDisputes === 0) {
    actions.push({
      type: 'restore_invoice_status', invoiceId: invoice.id, to: impliedMoneyStatus(invoice),
      processorDisputeId: fields.processorDisputeId, outcome: partialLoss ? 'LOST_PARTIAL' : status as 'WON' | 'CLOSED',
    });
  }
  if (partialLoss) {
    actions.push({
      type: 'flag_partial_chargeback', invoiceId: payment.invoiceId, paymentId: payment.id, processorDisputeId: fields.processorDisputeId,
      disputedCents: fields.amountCents, unrefundedCents: chargedCentsOf(payment.unrefundedCents, payment), bankReturn,
    });
  } else if (status === 'LOST' && !payment.voided && payment.state === 'PROCESSING') {
    actions.push({
      type: 'fail_disputed_payment', paymentId: payment.id, invoiceId: payment.invoiceId,
      processorDisputeId: fields.processorDisputeId, amountCents: fields.amountCents, bankReturn,
    });
  } else if (status === 'LOST' && !payment.voided && payment.state === 'SUCCEEDED') {
    actions.push({
      type: 'void_disputed_payment',
      paymentId: payment.id,
      invoiceId: payment.invoiceId,
      processorDisputeId: fields.processorDisputeId,
      bankReturn,
      stayDisputed: snapshot.otherOpenDisputes > 0 && !!invoice && !NOT_DISPUTABLE.includes(invoice.status),
    });
  }
  actions.push({
    type: 'notify_dispute', kind: 'closed', outcome: status, processorDisputeId: fields.processorDisputeId, invoiceId: payment.invoiceId, bankReturn,
    amountCents: fields.amountCents, reason: fields.reason, evidenceDueBy: fields.evidenceDueBy,
    ...(partialLoss ? { partial: true as const } : {}),
  });
  return actions;
}

/** Why an account is not taking charges that the owner can do nothing about: the processor is reviewing. */
const NOT_ACTIONABLE_DISABLED_REASONS: readonly string[] = ['requirements.pending_verification', 'under_review'];

/** An account event: account.updated syncs the account's status, a deauthorization disconnects. */
function decideAccount(event: AccountEvent, snapshot: AccountSnapshot): LedgerAction[] {
  if (snapshot.eventAlreadyProcessed) return [];
  if (event.type === 'account.updated') return decideAccountStatusSync(snapshot);
  // The account was disconnected from ServWave: it can take no payment, so CARD and ACH leave the
  // accepted methods, and the owner is told. The account id stays on the org, so a late refund or
  // dispute event for it is still recognised and recorded.
  const { organizationId, accountId } = snapshot;
  return [
    {
      type: 'update_account_status',
      organizationId,
      accountId,
      flags: {
        stripe_charges_enabled: false, stripe_payouts_enabled: false, stripe_details_submitted: false,
        stripe_requirements_due: [], stripe_disabled_reason: 'deauthorized',
      },
      acceptedMethods: syncedAcceptedMethods(snapshot.stored.acceptedMethods, { chargesEnabled: false, cardCapabilityActive: false, achCapabilityActive: false }),
    },
    { type: 'notify_account', verb: 'billing.payments_disconnected', organizationId, accountId, dedup: `disconnected:${accountId}`, emailAdmins: false },
  ];
}

/**
 * The org's stored status and accepted methods after the processor's answer about its account.
 * Shared by account.updated and the status refresh (onboarding return, nightly), so both write
 * through one decision. A processor answer that is not about the account (a platform-side error,
 * a missing account on a sandbox key) changes nothing.
 */
export function decideAccountStatusSync(snapshot: AccountSnapshot): LedgerAction[] {
  const { status } = snapshot;
  if (!status || status.kind === 'keep') return [];
  // A failed-closed answer reads as "cannot take charges": CARD and ACH leave (withAccountCapabilities).
  const capabilities = status.outcome === 'refreshed'
    ? { chargesEnabled: status.flags.stripe_charges_enabled, cardCapabilityActive: status.cardActive, achCapabilityActive: status.achActive }
    : { chargesEnabled: false, cardCapabilityActive: false, achCapabilityActive: false };
  const { organizationId, accountId, stored } = snapshot;
  const actions: LedgerAction[] = [{
    type: 'update_account_status',
    organizationId,
    accountId,
    flags: status.flags,
    acceptedMethods: syncedAcceptedMethods(stored.acceptedMethods, capabilities),
  }];
  if (status.outcome !== 'refreshed') return actions;
  const notice = (verb: AccountNoticeVerb, dedup: string, emailAdmins: boolean): LedgerAction =>
    ({ type: 'notify_account', verb, organizationId, accountId, dedup, emailAdmins });
  const { flags } = status;
  // The "activated" nudges for flags this answer turned on. The keys are per account, so the
  // refresh and the account event seeing the same change send one of each.
  if (flags.stripe_charges_enabled && !stored.chargesEnabled) actions.push(notice('billing.payments_activated', `activated:${accountId}`, false));
  if (flags.stripe_payouts_enabled && !stored.payoutsEnabled) actions.push(notice('billing.payouts_activated', `payouts:${accountId}`, false));
  // Slice 32: until the owner has submitted their details they are inside onboarding, and every step
  // changes the requirements. Nothing is said (toast, feed or email) until the account has finished it.
  if (!flags.stripe_details_submitted) return actions;
  // Once per account and set of requirements (sorted, so the processor's order does not matter).
  if (flags.stripe_requirements_due.length > 0) {
    const requirements = [...flags.stripe_requirements_due].sort();
    actions.push({ ...notice('billing.payments_action_needed', `action:${accountId}:${requirements.join(',')}`, true), requirements } as LedgerAction);
  }
  // A pause the owner cannot act on (the processor is still checking what they sent) is not an interruption.
  if (flags.stripe_disabled_reason && !NOT_ACTIONABLE_DISABLED_REASONS.includes(flags.stripe_disabled_reason)) {
    actions.push(notice('billing.payments_paused', `paused:${accountId}:${flags.stripe_disabled_reason}`, true));
  }
  return actions;
}

/** Where a processor dispute stands, in ServWave's words. */
export function disputeStatusFor(status: string): DisputeStatus {
  switch (status) {
    case 'needs_response':
    case 'warning_needs_response':
      return 'NEEDS_RESPONSE';
    case 'won':
      return 'WON';
    case 'lost':
      return 'LOST';
    case 'warning_closed':
      return 'CLOSED';
    default:
      return 'UNDER_REVIEW';
  }
}
