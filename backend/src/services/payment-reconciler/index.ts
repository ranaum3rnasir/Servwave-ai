/**
 * Payments go-live slice 07 (PRD Module 4) - the payment event reconciler.
 *
 * One event in: read the snapshot of the rows it touches (inside the owning org, under the
 * invoice lock), decide the ledger actions, apply them, and write the processed-event record, all
 * in one transaction. A replayed event finds its id already recorded and changes nothing.
 *
 * Tenancy: the caller resolves the owning org from the connected account the event arrived on;
 * every read here is scoped to that org, so an event can never touch another org's invoice.
 */
import { REFUND_ROW_METADATA_KEY } from '../../lib/in-app-refund';
import { Prisma, type DisputeStatus, type PaymentMethod, type PaymentWallet } from '@prisma/client';
import { z } from 'zod';
import { prisma } from '../../lib/prisma';
import { COUNTED_PAYMENT_WHERE, afterPaymentSettled, paidCents, refundedCents, toCents } from '../../lib/payment-ledger';
import { DEPOSIT_CREDIT_REFERENCE } from '../../lib/deposit-credit';
import { emit } from '../notifications/notificationService';
import { notifyOwners } from '../../lib/owner-payment-notices';
import { disputeReasonWords } from '../notifications/templates';
import { logAudit } from '../../lib/audit';
import { logger } from '../../lib/logger';
import { getStripeForOrg, listPayoutBalanceTransactions, retrieveAccountPayout, retrievePaymentIntentFailureCode } from '../../lib/stripe';
import { payoutStatusOf, syncPayout } from '../../lib/payout-sync';
import { depositEstimateClosed, depositHoldReason } from '../../controllers/invoice.controller';
import {
  decide, disputeStatusFor, isAccountEvent, isCheckoutEvent, isDisputeEvent, isPayoutEvent, REFUND_EVENT_TYPES,
  type AccountEvent, type ChargeDetails, type CheckoutEvent, type CheckoutSnapshot, type DisputeEvent, type DisputeSnapshot,
  type PayoutEvent, type ProcessorDispute,
  type RefundEvent, type RefundSnapshot,
} from './decide';
import { applyActions, OUTSIDE_REFUND_REASON, type AppliedEffects, type DisputeNotice, type FailedRefund } from './apply';
import { alertUnappliedCapture, ledgerPaymentIdOf } from '../../lib/unapplied-capture';
import { CHECKOUT_INVOICE_SELECT, emailBankReturnToCustomer, runCheckoutEffects, type CheckoutInvoice, type CustomerNoticeOutcome } from './checkout-effects';
import { closeOpenCheckoutLinks } from '../../lib/invoice-checkout-expiry';
import { syncAccountStatus } from '../../lib/account-status';
import { emailRefundToCustomer } from '../../lib/refund-email';

export { REFUND_EVENT_TYPES, isDisputeEvent };
export type { RefundEvent, DisputeEvent };

export function isReconcilerEvent(event: { type: string }): event is RefundEvent {
  return (REFUND_EVENT_TYPES as readonly string[]).includes(event.type);
}

/**
 * unmatched: an event naming nothing ServWave recorded or created; acknowledged and ignored.
 * retry: a dispute on a ServWave checkout whose payment is not booked yet; left unrecorded and
 * answered with a failure, so the processor delivers it again.
 */
export type ReconcileOutcome = 'applied' | 'duplicate' | 'unmatched' | 'retry';

/** A verified processor event, as the webhook route hands it over. */
export interface ProcessorEvent {
  id: string;
  type: string;
  account?: string;
  data: { object: unknown };
}

/**
 * The one entry for every verified processor event, once the webhook route has resolved the org
 * that owns the connected account it arrived on. No event is judged against the org's accepted
 * methods here: a refund, dispute, completed checkout or bank settlement on money that already
 * exists is always recorded, and the accepted methods are only ever written by the account events.
 * An event type ServWave does not act on is acknowledged and recorded, so it is not delivered again.
 */
export async function reconcile(event: ProcessorEvent, org: OwningOrg): Promise<ReconcileOutcome> {
  if (isReconcilerEvent(event)) return reconcileEvent(event, org.id);
  if (isDisputeEvent(event)) return reconcileDispute(event, org.id);
  if (isCheckoutEvent(event)) return reconcileCheckout(event, org);
  if (isAccountEvent(event)) return reconcileAccountEvent(event, org.id);
  if (isPayoutEvent(event)) return reconcilePayout(event, org.id);
  if (event.type === 'charge.refunded') {
    // Slice 07: refunds are recorded from the refund.* events, keyed on the refund id. At the pinned
    // API version this charge event no longer carries its refunds, and its amount_refunded is the
    // charge's RUNNING total, so it records nothing; it is logged for cross-checking.
    const charge = event.data.object as { id?: string; payment_intent?: string; amount_refunded?: number; amount?: number };
    logger.info(`charge.refunded ${charge.id} (payment_intent ${charge.payment_intent}): ${charge.amount_refunded} of ${charge.amount} cents refunded so far; refunds are recorded from refund events`);
  } else if (event.type === 'checkout.session.expired') {
    // Slice 14: ignoring this is intended. ServWave keeps no per-invoice record of open links (the
    // sweep in lib/invoice-checkout-expiry.ts asks the processor for them each time), so a link that
    // timed out or was expired by that sweep has nothing to mark closed.
    const session = event.data.object as { id?: string };
    logger.info(`checkout.session.expired ${session.id}: nothing to record; open links are read from the processor`);
  } else {
    logger.info(`Unhandled webhook event: ${event.type}`);
  }
  return acknowledge(event);
}

/** Record an event ServWave does not act on, so the processor stops delivering it. */
export async function acknowledge(event: { id: string; type: string }): Promise<ReconcileOutcome> {
  try {
    await prisma.stripeEvent.create({ data: { stripe_event_id: event.id, event_type: event.type } });
  } catch (err) {
    if ((err as { code?: string }).code !== 'P2002') throw err;
  }
  return 'applied';
}

/**
 * Payouts slice P2: why a bank payment this event marked FAILED failed. After the commit, so the
 * lookup can never block the state change: the processor is asked for the payment intent's last
 * error code (the code only), and a failed lookup is logged and leaves the payment without one.
 * Scoped to the company through the payment's invoice; only a payment that has no code yet is written.
 */
async function storeFailureCodes(failed: ReadonlyArray<{ paymentId: string }>, organizationId: string): Promise<void> {
  for (const { paymentId } of failed) {
    try {
      const payment = await prisma.payment.findFirst({
        where: { id: paymentId, invoice: { organization_id: organizationId } },
        select: { stripe_payment_intent_id: true, stripe_account_id: true },
      });
      // A payment with no connected account was made on the platform account itself: look it up there.
      if (!payment?.stripe_payment_intent_id) continue;
      const code = await retrievePaymentIntentFailureCode(payment.stripe_account_id, payment.stripe_payment_intent_id);
      if (!code) continue;
      await prisma.payment.updateMany({
        where: { id: paymentId, failure_code: null, invoice: { organization_id: organizationId } },
        data: { failure_code: code },
      });
    } catch (err) {
      logger.warn(`Reconciler: could not look up why payment ${paymentId} failed for org ${organizationId}: ${(err as Error).message}`);
    }
  }
}

/**
 * Payouts slice P2: payout.created / updated / paid / failed / canceled fill ServWave's own payouts
 * table (lib/payout-sync.ts) for the company that owns the account the event arrived on, and link the
 * company's payments whose balance transaction is in the payout. The event id is claimed with the
 * write, so a replay changes nothing. The balance transactions are listed from the processor before the
 * write; a failed list still records the payout (the nightly reconcile links the payments later).
 */
export async function reconcilePayout(event: PayoutEvent, organizationId: string): Promise<ReconcileOutcome> {
  if (!event.account) return acknowledge(event);
  // A delivery whose event id is already recorded costs nothing: no processor call. The claim inside the
  // transaction below stays the authority (two deliveries at once both pass this check, one loses there).
  if (await prisma.stripeEvent.findUnique({ where: { stripe_event_id: event.id }, select: { stripe_event_id: true } })) return 'duplicate';
  let payout = event.data.object;

  // Events arrive in any order and carry a snapshot: for an end state the payout is read again, and the
  // processor's current state is what is written. If it cannot be read, the snapshot cannot change a held end state.
  let current = false;
  if (payoutStatusOf(payout.status) !== 'PENDING' && payoutStatusOf(payout.status) !== 'IN_TRANSIT') {
    try {
      const fresh = await retrieveAccountPayout(event.account, payout.id);
      if (fresh) {
        payout = fresh as unknown as typeof payout;
        current = true;
      }
    } catch (err) {
      logger.warn(`Reconciler: could not read payout ${payout.id} again for org ${organizationId}: ${(err as Error).message}`);
    }
  }

  let balanceTransactionIds: string[] | undefined;
  if (payout.status !== 'failed' && payout.status !== 'canceled') {
    try {
      balanceTransactionIds = (await listPayoutBalanceTransactions(event.account, payout.id)).map((bt) => bt.id);
    } catch (err) {
      logger.warn(`Reconciler: could not list the balance transactions of payout ${payout.id} for org ${organizationId}: ${(err as Error).message}`);
    }
  }

  const outcome = await prisma.$transaction(async (tx) => {
    try {
      await tx.stripeEvent.create({ data: { stripe_event_id: event.id, event_type: event.type } });
    } catch (err) {
      if ((err as { code?: string }).code === 'P2002') return 'duplicate' as const;
      throw err;
    }
    const synced = await syncPayout(tx, organizationId, payout, balanceTransactionIds, { current });
    logger.info(`Reconciler: payout event ${event.type} ${event.id} for org ${organizationId}: ${synced ? `${synced.linked} payments linked` : 'not written'}`);
    return 'applied' as const;
  }, { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted });
  return outcome;
}

/**
 * account.updated: the account is read back and its status and the accepted methods it implies
 * are stored (CARD while the card capability is active, ACH while the bank-debit one is), and the
 * owner hears when it activates, needs action or is paused. account.application.deauthorized: the
 * org is disconnected and the owner is told. Through the same writer as the status refresh
 * (lib/account-status.ts, syncAccountStatus), so the two never overwrite each other's newer answer.
 */
export async function reconcileAccountEvent(event: AccountEvent, organizationId: string): Promise<ReconcileOutcome> {
  // The platform's own account (no connected account on the event) is not an org's.
  if (!event.account) return acknowledge(event);
  const { outcome } = await syncAccountStatus({ organizationId, accountId: event.account, event });
  // One line per reconciled account event (org, type, outcome, event id): a processed event and a
  // duplicate otherwise differ only in the size of the response. No account id is logged.
  logger.info(`Reconciler: account event ${event.type} ${event.id} for org ${organizationId}: ${outcome}`);
  return outcome === 'duplicate' ? 'duplicate' : 'applied';
}

export async function reconcileEvent(event: RefundEvent, organizationId: string): Promise<ReconcileOutcome> {
  const refund = event.data.object;
  const result = await prisma.$transaction(async (tx) => {
    try {
      await tx.stripeEvent.create({ data: { stripe_event_id: event.id, event_type: event.type } });
    } catch (err) {
      if ((err as { code?: string }).code === 'P2002') return { outcome: 'duplicate' as const, effects: null };
      throw err;
    }

    // One event per refund at a time, whatever its event id: a stray refund (no invoice to lock) is
    // checked and written down under this lock, so two deliveries never both see "not yet".
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`refund:${refund.id}`}, 0))`;

    // Find the rows first, then lock the invoice they sit on and read them again under the lock:
    // the in-app refund door takes the same lock before it writes its row, so the two never both
    // see "no row" for one refund id.
    const payment = refund.payment_intent
      ? await tx.payment.findFirst({
          where: { stripe_payment_intent_id: refund.payment_intent, invoice: { organization_id: organizationId } },
          select: { id: true, invoice_id: true, method: true, amount: true, service_fee_amount: true, tip_amount: true },
        })
      : null;
    const rowBefore = await tx.refund.findFirst({
      where: { stripe_refund_id: refund.id, organization_id: organizationId },
      select: { invoice_id: true },
    });
    const invoiceId = rowBefore?.invoice_id ?? payment?.invoice_id;
    if (invoiceId) {
      await tx.$executeRaw`SELECT id FROM invoices WHERE id = ${invoiceId}::uuid AND organization_id = ${organizationId}::uuid FOR UPDATE`;
    }
    let row = await tx.refund.findFirst({
      where: { stripe_refund_id: refund.id, organization_id: organizationId },
      select: { id: true, invoice_id: true, state: true, reason: true },
    });
    // Slice 29: an in-app refund holds its row (PENDING, no refund id yet) before the processor is
    // asked, and names that row in the refund's metadata. An event that lands before the call has
    // returned completes that row with its refund id, never a second one. The name is trusted only
    // for a row of this org, on the refunded payment, that no refund has claimed yet.
    const reservedRowId = refund.metadata?.[REFUND_ROW_METADATA_KEY];
    if (!row && payment && reservedRowId && uuid.safeParse(reservedRowId).success) {
      const reserved = await tx.refund.findFirst({
        where: { id: reservedRowId, organization_id: organizationId, payment_id: payment.id, stripe_refund_id: null },
        select: { id: true },
      });
      if (reserved) {
        row = await tx.refund.update({
          where: { id: reserved.id },
          data: { stripe_refund_id: refund.id },
          select: { id: true, invoice_id: true, state: true, reason: true },
        });
      }
    }

    // Slice 11: a refund ServWave sent for a payment needing attention. It carries the record's id
    // in its metadata, which is trusted only together with the record's own payment intent in this
    // org (the event may land before the record has stored the refund id).
    const recordId = refund.metadata?.unapplied_capture_id;
    const namedRecord = recordId && uuid.safeParse(recordId).success && refund.payment_intent
      ? { id: recordId, stripe_payment_intent_id: refund.payment_intent }
      : null;
    const attention = await tx.unappliedCapture.findFirst({
      where: {
        organization_id: organizationId,
        reason: { not: 'REFUND_UNMATCHED' },
        OR: [
          { stripe_refund_id: refund.id },
          ...(namedRecord ? [namedRecord] : []),
        ],
      },
      select: { id: true, status: true, stripe_refund_id: true, source_key: true, failed_refund_ids: true },
    });

    // A stray refund (no row, no payment) is written down once: has an earlier event for it been?
    const unmatchedRefundRecorded = !row && !payment
      ? (await tx.timelineEvent.count({
        where: { organization_id: organizationId, event_type: 'PAYMENT_UNRECORDED', metadata: { path: ['processor_refund_id'], equals: refund.id } },
      })) > 0
      : false;

    const snapshot: RefundSnapshot = {
      // The record was written just above; reaching here means this delivery is the first.
      eventAlreadyProcessed: false,
      organizationId,
      refund: row ? { id: row.id, invoiceId: row.invoice_id, state: row.state, external: row.reason === OUTSIDE_REFUND_REASON } : null,
      unmatchedRefundRecorded,
      attentionRecord: attention
        ? {
            id: attention.id,
            status: attention.status,
            refundId: attention.stripe_refund_id,
            paymentId: ledgerPaymentIdOf(attention.source_key),
            failedRefundIds: attention.failed_refund_ids,
          }
        : null,
      payment: payment
        ? {
            id: payment.id,
            invoiceId: payment.invoice_id,
            method: payment.method,
            amountCents: toCents(payment.amount),
            extrasCents: toCents(payment.service_fee_amount ?? 0) + toCents(payment.tip_amount ?? 0),
          }
        : null,
    };
    const actions = decide(event, snapshot);
    if (!row && !payment && !attention) {
      logger.warn(`Reconciler: ${event.type} ${refund.id} matches no payment in org ${organizationId}; recorded as not matched`);
    }
    const effects = await applyActions(tx, actions, { organizationId, eventId: event.id, accountId: event.account ?? null });
    // Payouts slice P2: why a refund failed is stored with the refund (the code only; shown through describeFailure).
    if (refund.failure_reason && (event.type === 'refund.failed' || refund.status === 'failed')) {
      await tx.refund.updateMany({
        where: { stripe_refund_id: refund.id, organization_id: organizationId, failure_code: null },
        data: { failure_code: refund.failure_reason },
      });
    }
    return { outcome: 'applied' as const, effects };
  }, { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted });

  if (result.effects) {
    auditExternalRefunds(result.effects, organizationId);
    for (const settled of result.effects.settledRefunds) await emailRefundToCustomer(organizationId, settled.refundId);
    for (const capture of result.effects.unappliedCaptures) await alertUnappliedCapture(capture);
    for (const failed of result.effects.failedRefunds) await announceRefundFailed(failed, organizationId, refund.amount);
  }
  return result.outcome;
}

/**
 * Slice 32: a refund the processor could not complete. The money is back in the balance and the
 * customer is still owed it, so the owner is told, in-app and by email, once per refund. Wording
 * says "bank" when the refund went to a bank account; it names no processor.
 */
async function announceRefundFailed(failed: FailedRefund, organizationId: string, eventCents: number): Promise<void> {
  const person = { select: { first_name: true, last_name: true, company_name: true } };
  const row = await prisma.refund.findFirst({
    where: { stripe_refund_id: failed.processorRefundId, organization_id: organizationId },
    select: { amount: true, method: true, invoice_id: true },
  });
  const record = !row && failed.recordId
    ? await prisma.unappliedCapture.findFirst({
        where: { id: failed.recordId, organization_id: organizationId },
        select: { invoice_id: true, source_key: true },
      })
    : null;
  const paymentId = record ? ledgerPaymentIdOf(record.source_key) : null;
  const payment = paymentId
    ? await prisma.payment.findFirst({ where: { id: paymentId, invoice: { organization_id: organizationId } }, select: { method: true } })
    : null;
  const invoiceId = failed.invoiceId ?? row?.invoice_id ?? record?.invoice_id ?? null;
  const invoice = invoiceId
    ? await prisma.invoice.findFirst({
        where: { id: invoiceId, organization_id: organizationId },
        select: { id: true, invoice_number: true, customer: person, job: { select: { customer: person } } },
      })
    : null;
  const customer = invoice?.customer ?? invoice?.job?.customer ?? null;
  const customerName = customer ? [customer.first_name, customer.last_name].filter(Boolean).join(' ') || customer.company_name || '' : '';
  const bank = (row?.method ?? payment?.method) === 'ACH';
  const cents = row ? Math.round(Number(row.amount) * 100) : eventCents;
  await notifyOwners({
    verb: 'billing.refund_failed',
    organizationId,
    object: invoice
      ? { type: 'INVOICE', id: invoice.id, label: invoice.invoice_number }
      : { type: 'ORGANIZATION', id: organizationId, label: 'a payment' },
    data: {
      amount: (cents / 100).toFixed(2),
      refund_kind: bank ? 'bank' : 'card',
      ...(customerName ? { customer_name: customerName } : {}),
      ...(invoice ? {} : { object_kind: 'ORGANIZATION' }),
    },
    dedupKey: `billing.refund_failed:${failed.processorRefundId}`,
    actionLabel: invoice ? 'Open the invoice' : 'Open Payments',
  });
}

function auditExternalRefunds(effects: AppliedEffects, organizationId: string): void {
  for (const r of effects.externalRefunds) {
    void logAudit({
      action: 'invoice.refunded_outside_servwave',
      resourceType: 'Invoice',
      resourceId: r.invoiceId,
      orgId: organizationId,
      actorId: null,
      metadata: { amount: r.amount, processor_refund_id: r.processorRefundId },
    });
  }
}

// ---- Completed checkouts (slice 08) -----------------------------------------------------------

/** The org the event's connected account belongs to, as the webhook route resolved it. */
export interface OwningOrg {
  id: string;
  name: string | null;
  accepted_payment_methods: PaymentMethod[];
  stripe_payouts_enabled: boolean;
}

const uuid = z.string().uuid();

/**
 * checkout.session.completed: book the payment (a bank debit as PROCESSING), or write down the
 * money that cannot be applied. checkout.session.async_payment_succeeded / _failed (slice 13): the
 * bank debit cleared or failed. Never judged against the org's accepted methods: a payment the
 * processor already took is always recorded.
 */
export async function reconcileCheckout(event: CheckoutEvent, org: OwningOrg): Promise<ReconcileOutcome> {
  const session = event.data.object;
  const metaInvoiceId = session.metadata?.invoiceId;
  const invoiceId = metaInvoiceId && uuid.safeParse(metaInvoiceId).success ? metaInvoiceId : null;
  if (metaInvoiceId && !invoiceId) logger.warn(`Reconciler: checkout ${session.id} carries a malformed invoice id`);

  // Read before the transaction: only which org the invoice belongs to (wherever it lives, so another
  // org's invoice is told apart from none at all; nothing else of another org's invoice is read,
  // locked, written or named), and the charge the session made, which the event does not carry at
  // the pinned API version. Everything the payment is judged against is read under the lock.
  const found = invoiceId
    ? await prisma.invoice.findUnique({ where: { id: invoiceId }, select: { id: true, organization_id: true } })
    : null;
  const isOurs = found?.organization_id === org.id;
  const read = found && isOurs ? await readCharge(session.payment_intent, event.account) : null;
  const charge = read?.details ?? null;
  const bankAccount = read?.bankAccount ?? null;
  let ours: CheckoutInvoice | null = null;

  const result = await prisma.$transaction(async (tx) => {
    try {
      await tx.stripeEvent.create({ data: { stripe_event_id: event.id, event_type: event.type } });
    } catch (err) {
      if ((err as { code?: string }).code === 'P2002') return { outcome: 'duplicate' as const, effects: null };
      throw err;
    }

    // One delivery of a session at a time, whatever its event id, so the same money is never
    // booked or written down twice (a capture on the org has no invoice row to lock).
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`checkout:${session.id}`}, 0))`;
    const captureRecorded = (await tx.timelineEvent.count({
      where: { organization_id: org.id, event_type: 'PAYMENT_UNRECORDED', metadata: { path: ['checkout_session'], equals: session.id } },
    })) > 0;

    // Under the invoice lock, inside this org: the balance the payment is judged against, the bank
    // payments still clearing, and any payment this session already booked (another event id for
    // the same money).
    let lockedInvoice: CheckoutSnapshot['invoice'] = null;
    let bookedPayment: CheckoutSnapshot['bookedPayment'] = null;
    if (found && isOurs) {
      await tx.$executeRaw`SELECT id FROM invoices WHERE id = ${found.id}::uuid AND organization_id = ${org.id}::uuid FOR UPDATE`;
      // The deposit hold is judged here too: a recall or repricing that commits while the webhook
      // waits for the lock is what the payment must be judged against.
      const locked = await tx.invoice.findFirstOrThrow({
        where: { id: found.id, organization_id: org.id },
        select: { ...CHECKOUT_INVOICE_SELECT, payments: { where: { state: 'PROCESSING', voided_at: null }, select: { amount: true } } },
      });
      ours = locked;
      lockedInvoice = {
        id: locked.id,
        invoiceNumber: locked.invoice_number,
        organizationId: org.id,
        status: locked.status,
        kind: locked.kind,
        amountDueCents: toCents(locked.amount_due),
        totalCents: toCents(locked.total_amount),
        processingCents: locked.payments.reduce((sum, p) => sum + toCents(p.amount), 0),
        depositHold: depositHoldReason(locked, locked.organization),
        estimateClosed: depositEstimateClosed(locked),
      };
      const sameMoney = [
        { stripe_checkout_session_id: session.id },
        ...(charge ? [{ stripe_charge_id: charge.id }] : []),
        ...(session.payment_intent ? [{ stripe_payment_intent_id: session.payment_intent }] : []),
      ];
      const booked = await tx.payment.findFirst({
        where: { invoice: { organization_id: org.id }, OR: sameMoney },
        select: { id: true, state: true, voided_at: true, amount: true, stripe_charge_id: true },
      });
      bookedPayment = booked
        ? { id: booked.id, state: booked.state, voided: booked.voided_at !== null, amountCents: toCents(booked.amount), chargeId: booked.stripe_charge_id }
        : null;
    } else if (found) {
      // Another org's invoice: decide() reads only that it is not this org's, and touches nothing.
      // Nothing else of it was read, so the rest is placeholder.
      lockedInvoice = {
        id: found.id, invoiceNumber: '', organizationId: found.organization_id,
        status: 'DRAFT', kind: 'STANDARD', amountDueCents: 0, totalCents: 0, processingCents: 0, depositHold: null, estimateClosed: false,
      };
    }

    const snapshot: CheckoutSnapshot = {
      // The record was written just above; reaching here means this delivery is the first.
      eventAlreadyProcessed: false,
      organization: { id: org.id },
      invoice: lockedInvoice,
      bookedPayment,
      captureRecorded,
      charge,
      bankAccount,
    };
    const actions = decide(event, snapshot);
    if (actions.length === 0) {
      logger.info(`Reconciler: ${event.type} ${session.id} for org ${org.id} needs no ledger change`);
    }
    const effects = await applyActions(tx, actions, { organizationId: org.id, eventId: event.id, accountId: event.account ?? null });
    return { outcome: 'applied' as const, effects };
  }, { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted });

  if (result.effects) await storeFailureCodes(result.effects.failedPayments, org.id);
  if (result.effects) {
    await runCheckoutEffects(result.effects, {
      organization: org,
      account: event.account,
      paymentIntentId: session.payment_intent,
      invoice: ours,
    });
  }
  // A dispute the processor raised with the charge (its dispute test card does) can arrive before
  // this booking, find no payment, and be left unrecorded. Pick it up now the payment exists. Also
  // on a duplicate delivery, so a pickup that failed after the booking committed is retried.
  if (read?.disputed && charge) await pickUpRaisedDisputes(charge.id, event, org.id);
  return result.outcome;
}

/**
 * Every dispute already raised on a charge, read on the account the checkout arrived on and run
 * through the dispute path. The dispute path judges each from its own status and the dispute
 * record, so a dispute recorded already, by its own event or an earlier pickup, changes nothing.
 */
async function pickUpRaisedDisputes(chargeId: string, event: CheckoutEvent, organizationId: string): Promise<void> {
  const { stripe } = getStripeForOrg({ stripe_account_id: event.account ?? null });
  const disputes = await stripe.disputes.list(
    { charge: chargeId, limit: 10 },
    event.account ? { stripeAccount: event.account } : undefined,
  );
  for (const dispute of disputes.data) {
    await reconcileDispute({
      id: `${event.id}:${dispute.id}`,
      type: 'charge.dispute.created',
      account: event.account,
      data: { object: dispute as unknown as ProcessorDispute },
    }, organizationId);
  }
}

/**
 * The charge a checkout made, and whether it is already disputed, read back from the processor on
 * the account the event arrived on.
 * A payment intent the processor does not know (no such resource) yields null: the payment is
 * still booked, paid at the event's time and without display details. Any other failure throws,
 * so the event is not recorded and the processor delivers it again.
 */
async function readCharge(
  paymentIntentId: string | null,
  account: string | undefined,
): Promise<{ details: ChargeDetails | null; disputed: boolean; bankAccount: CheckoutSnapshot['bankAccount'] } | null> {
  if (!paymentIntentId) return null;
  const { stripe } = getStripeForOrg({ stripe_account_id: account ?? null });
  try {
    const pi = await stripe.paymentIntents.retrieve(
      paymentIntentId,
      { expand: ['latest_charge', 'payment_method'] },
      account ? { stripeAccount: account } : undefined,
    );
    const latest = pi.latest_charge;
    const disputed = !!latest && typeof latest === 'object' && (latest as { disputed?: boolean }).disputed === true;
    return { details: chargeDetails(latest), disputed, bankAccount: bankAccountOf(pi.payment_method) };
  } catch (err) {
    if ((err as { code?: string }).code === 'resource_missing') {
      logger.warn(`Reconciler: payment intent ${paymentIntentId} not found on ${account ?? 'the platform'}; booking without charge details`);
      return null;
    }
    throw err;
  }
}

/** The bank account on a payment method (expanded), or null for a card or an unexpanded id. */
function bankAccountOf(paymentMethod: unknown): CheckoutSnapshot['bankAccount'] {
  if (!paymentMethod || typeof paymentMethod !== 'object') return null;
  const bank = (paymentMethod as { us_bank_account?: { bank_name?: string | null; last4?: string | null } | null }).us_bank_account;
  return bank ? { bankName: bank.bank_name ?? null, bankLast4: bank.last4 ?? null } : null;
}

const WALLETS: Record<string, PaymentWallet> = { apple_pay: 'APPLE_PAY', google_pay: 'GOOGLE_PAY', link: 'LINK' };

/** How the customer paid, from the processor's charge object. */
export function chargeDetails(charge: unknown): ChargeDetails | null {
  if (!charge || typeof charge !== 'object') return null;
  const c = charge as {
    id?: string; created?: number;
    payment_method_details?: {
      type?: string;
      card?: { brand?: string | null; last4?: string | null; wallet?: { type?: string } | null } | null;
      us_bank_account?: { bank_name?: string | null; last4?: string | null } | null;
    } | null;
  };
  if (typeof c.id !== 'string' || typeof c.created !== 'number') return null;
  const details = c.payment_method_details;
  const card = details?.card ?? null;
  const bank = details?.us_bank_account ?? null;
  const walletType = details?.type === 'link' ? 'link' : card?.wallet?.type;
  return {
    id: c.id,
    createdAt: new Date(c.created * 1000),
    wallet: (walletType && WALLETS[walletType]) || null,
    cardBrand: card?.brand ?? null,
    cardLast4: card?.last4 ?? null,
    bankName: bank?.bank_name ?? null,
    bankLast4: bank?.last4 ?? null,
  };
}

// ---- Disputes and late bank returns (slice 09) ------------------------------------------------

/** A dispute that has not reached its final status. */
const OPEN_DISPUTE_STATUSES = ['NEEDS_RESPONSE', 'UNDER_REVIEW'] as const;

/**
 * charge.dispute.created / updated / closed: open, update or close the dispute and settle the
 * invoice and the money. Never judged against the org's accepted methods: a dispute on a payment
 * that already exists is always recorded, whatever the org accepts today.
 */
export async function reconcileDispute(event: DisputeEvent, organizationId: string): Promise<ReconcileOutcome> {
  const dispute = event.data.object;
  let invoiceNumber: string | null = null;
  const result = await prisma.$transaction(async (tx) => {
    try {
      await tx.stripeEvent.create({ data: { stripe_event_id: event.id, event_type: event.type } });
    } catch (err) {
      if ((err as { code?: string }).code === 'P2002') return { outcome: 'duplicate' as const, effects: null };
      throw err;
    }

    // One event per dispute at a time, whatever its event id, so two deliveries never both see "no
    // record" and both open it.
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`dispute:${dispute.id}`}, 0))`;

    // The disputed payment, inside this org only: by the charge the dispute names, else its payment
    // intent. A dispute already recorded names its payment itself.
    const held = await tx.dispute.findFirst({
      where: { stripe_dispute_id: dispute.id, organization_id: organizationId },
      select: { payment_id: true, invoice_id: true },
    });
    const byProcessorIds = [
      ...(dispute.charge ? [{ stripe_charge_id: dispute.charge }] : []),
      ...(dispute.payment_intent ? [{ stripe_payment_intent_id: dispute.payment_intent }] : []),
    ];
    const found = held
      ? { id: held.payment_id, invoice_id: held.invoice_id }
      : byProcessorIds.length > 0
        ? await tx.payment.findFirst({ where: { invoice: { organization_id: organizationId }, OR: byProcessorIds }, select: { id: true, invoice_id: true } })
        : null;

    // Lock the invoice, then read everything the decision rests on under it.
    let snapshot: DisputeSnapshot = {
      eventAlreadyProcessed: false, organizationId, dispute: null, payment: null, invoice: null, otherOpenDisputes: 0,
    };
    if (found) {
      await tx.$executeRaw`SELECT id FROM invoices WHERE id = ${found.invoice_id}::uuid AND organization_id = ${organizationId}::uuid FOR UPDATE`;
      const [payment, row, invoice, otherOpenDisputes] = await Promise.all([
        tx.payment.findFirstOrThrow({
          where: { id: found.id, invoice: { organization_id: organizationId } },
          select: {
            id: true, invoice_id: true, method: true, state: true, voided_at: true, amount: true,
            service_fee_amount: true, tip_amount: true,
            refunds: { where: { organization_id: organizationId }, select: { amount: true, state: true } },
          },
        }),
        tx.dispute.findFirst({
          where: { stripe_dispute_id: dispute.id, organization_id: organizationId },
          select: { id: true, status: true, amount: true, evidence_due_by: true },
        }),
        tx.invoice.findFirstOrThrow({
          where: { id: found.invoice_id, organization_id: organizationId },
          select: {
            id: true, invoice_number: true, status: true, amount_due: true,
            payments: { where: COUNTED_PAYMENT_WHERE, select: { amount: true, reference_number: true } },
            // The refunded payment's void: a refund on a voided payment does not count toward the status.
            refunds: { select: { amount: true, state: true, from_unapplied_capture: true, payment: { select: { voided_at: true } } } },
          },
        }),
        tx.dispute.count({
          where: {
            invoice_id: found.invoice_id, organization_id: organizationId,
            status: { in: [...OPEN_DISPUTE_STATUSES] }, stripe_dispute_id: { not: dispute.id },
          },
        }),
      ]);
      invoiceNumber = invoice.invoice_number;
      // As rederiveRefundTotals counts it: money sent back from the Needs attention card was
      // never the invoice's, so it comes off both sides of the status maths (slice 11).
      const standingRefunds = invoice.refunds.filter((r) => !r.payment?.voided_at);
      const unappliedBackCents = refundedCents(standingRefunds.filter((r) => r.from_unapplied_capture));
      snapshot = {
        eventAlreadyProcessed: false,
        organizationId,
        dispute: row ? { id: row.id, status: row.status, amountCents: toCents(row.amount), evidenceDueBy: row.evidence_due_by } : null,
        payment: {
          id: payment.id, invoiceId: payment.invoice_id, method: payment.method, state: payment.state, voided: payment.voided_at !== null,
          amountCents: toCents(payment.amount),
          extrasCents: toCents(payment.service_fee_amount ?? 0) + toCents(payment.tip_amount ?? 0),
          unrefundedCents: toCents(payment.amount) - refundedCents(payment.refunds),
        },
        invoice: {
          id: invoice.id,
          invoiceNumber: invoice.invoice_number,
          status: invoice.status,
          amountDueCents: toCents(invoice.amount_due),
          paidCents: paidCents(invoice.payments.filter((p) => p.reference_number !== DEPOSIT_CREDIT_REFERENCE)) - unappliedBackCents,
          refundedCents: refundedCents(standingRefunds) - unappliedBackCents,
          anyMoneyLanded: invoice.payments.length > 0,
        },
        otherOpenDisputes,
      };
    } else {
      // No payment in this org names the charge yet. The event is not marked processed either
      // way; after the transaction the processor is asked whether the charge came from a
      // ServWave checkout (see unmatchedDisputeOutcome).
      await tx.stripeEvent.delete({ where: { stripe_event_id: event.id } });
      return { outcome: 'unmatched' as const, effects: null };
    }

    const actions = decide(event, snapshot);
    const effects = await applyActions(tx, actions, { organizationId, eventId: event.id, accountId: event.account ?? null });
    return { outcome: 'applied' as const, effects };
  }, { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted });

  if (result.effects && invoiceNumber) {
    // V7-13 (BE-13a, BE-13d): the customer whose bank payment was taken back is emailed BEFORE the owner's alert, so the
    // alert says what really happened to them. Matched to the dispute by the processor's dispute id.
    const returns = new Map<string, { outcome: CustomerNoticeOutcome; voided: boolean }>();
    for (const returned of result.effects.bankReturnNotices) {
      returns.set(returned.disputeId, { outcome: await emailBankReturnToCustomer(returned, organizationId), voided: returned.voided });
    }
    for (const notice of result.effects.disputeNotices) {
      const returned = notice.kind === 'closed' ? returns.get(notice.processorDisputeId) : undefined;
      await announceDispute(notice, organizationId, invoiceNumber, returned ? { customerNotice: returned.outcome, invoiceVoided: returned.voided } : undefined);
    }
  }
  if (result.effects) await storeFailureCodes(result.effects.failedPayments, organizationId);
  // Slice 29: a won dispute that paid the invoice in full fires INVOICE_PAID, post-commit.
  if (result.effects) {
    for (const settled of result.effects.settledPayments) await afterPaymentSettled(settled, organizationId);
  }
  // Slice 15 (from the slice 14 review): a lost dispute or bank return raised these balances, so a
  // link opened before it asks for too little. Post-commit, and never fails the event.
  if (result.effects && result.effects.reopenedInvoices.length > 0) {
    await closeOpenCheckoutLinks(organizationId, result.effects.reopenedInvoices.map((id) => ({ id })), 'payment_voided');
  }
  if (result.outcome === 'unmatched') return unmatchedDisputeOutcome(event, organizationId);
  return result.outcome;
}

/**
 * A dispute naming no payment in the org. Its charge is looked up on the processor:
 * - no checkout ServWave built (none carries ServWave's invoice id): acknowledged and ignored, so the
 *   endpoint does not fail for days on it (the nightly reconcile, slice 37, compares the processor's
 *   disputes with ours);
 * - a ServWave checkout no payment row can ever appear for (written down as unapplied): written down
 *   where a person finds it and the owner is told (see recordUnbookedDispute);
 * - a checkout not booked yet (the processor's dispute test card sends the dispute ahead of the
 *   completed checkout; a bank return can beat the bank checkout's completion): 'retry', so the
 *   route fails and the processor delivers it again; the checkout booking also picks up a dispute
 *   already raised on its charge.
 * A failed lookup throws, and the processor retries.
 */
async function unmatchedDisputeOutcome(event: DisputeEvent, organizationId: string): Promise<ReconcileOutcome> {
  const dispute = event.data.object;
  const session = dispute.payment_intent ? await findServWaveCheckout(dispute.payment_intent, event.account) : null;
  if (!session) {
    logger.warn(`Reconciler: ${event.type} ${dispute.id} names no charge ServWave created in org ${organizationId}; ignored`);
    return 'unmatched';
  }
  const outcome = await recordUnbookedDispute(event, session, organizationId);
  if (outcome === 'retry') {
    logger.warn(`Reconciler: ${event.type} ${dispute.id} is on a ServWave checkout in org ${organizationId} whose payment is not booked yet; asking for a retry`);
  }
  return outcome;
}

interface ServWaveCheckout {
  id: string;
  invoiceId: string;
  /** A bank (ACH) checkout: its return is worded as the bank returning the payment. */
  bank: boolean;
}

/** The checkout session ServWave built (it names an invoice) for this payment intent, if any. */
async function findServWaveCheckout(paymentIntentId: string, account: string | undefined): Promise<ServWaveCheckout | null> {
  const { stripe } = getStripeForOrg({ stripe_account_id: account ?? null });
  const sessions = await stripe.checkout.sessions.list(
    { payment_intent: paymentIntentId, limit: 1 },
    account ? { stripeAccount: account } : undefined,
  );
  const session = sessions.data.find((candidate) => !!candidate.metadata?.invoiceId);
  if (!session?.metadata?.invoiceId) return null;
  return {
    id: session.id,
    invoiceId: session.metadata.invoiceId,
    bank: (session.payment_method_types ?? []).includes('us_bank_account'),
  };
}

/** The history entry for a dispute on money ServWave holds no payment row for. */
const UNBOOKED_DISPUTE_EVENT = 'DISPUTE_ON_UNRECORDED_PAYMENT';

/**
 * A dispute on a ServWave checkout that has no payment row. When none can ever appear (the
 * reconciler wrote the checkout down as an unapplied capture), retrying cannot match it: it is
 * written down once per stage (raised, then final) where the capture sits (the invoice, or the
 * org), and the owner is alerted. Nothing on the invoice changes, since nothing of this money was
 * counted there. Otherwise the payment may still be booked: 'retry'. A bank checkout is booked like
 * a card one since slice 13 (PROCESSING when it completes), so its return waits for the booking and
 * then takes the normal path. Under the same per-dispute lock as the matched path.
 */
async function recordUnbookedDispute(
  event: DisputeEvent,
  session: ServWaveCheckout,
  organizationId: string,
): Promise<ReconcileOutcome> {
  const dispute = event.data.object;
  const status = disputeStatusFor(dispute.status);
  const final = status === 'WON' || status === 'LOST' || status === 'CLOSED';
  const bank = session.bank || dispute.payment_method_details?.type === 'us_bank_account';
  const result = await prisma.$transaction(async (tx) => {
    try {
      await tx.stripeEvent.create({ data: { stripe_event_id: event.id, event_type: event.type } });
    } catch (err) {
      if ((err as { code?: string }).code === 'P2002') return { outcome: 'duplicate' as const, notice: null };
      throw err;
    }
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`dispute:${dispute.id}`}, 0))`;
    const capture = await tx.timelineEvent.findFirst({
      where: { organization_id: organizationId, event_type: 'PAYMENT_UNRECORDED', metadata: { path: ['checkout_session'], equals: session.id } },
      select: { entity_type: true, entity_id: true },
    });
    // Not written down as unapplied: the payment may still be booked (a card checkout, or a bank
    // debit whose completion has not been processed yet), so the processor is asked to retry.
    if (!capture) {
      await tx.stripeEvent.delete({ where: { stripe_event_id: event.id } });
      return { outcome: 'retry' as const, notice: null };
    }
    // Once per stage; a raised event arriving after the final one adds nothing.
    const stage = final ? 'final' : 'raised';
    const already = await tx.timelineEvent.count({
      where: {
        organization_id: organizationId, event_type: UNBOOKED_DISPUTE_EVENT,
        AND: [
          { metadata: { path: ['processor_dispute_id'], equals: dispute.id } },
          ...(final ? [{ metadata: { path: ['stage'], equals: 'final' } }] : []),
        ],
      },
    });
    if (already > 0) return { outcome: 'applied' as const, notice: null };

    // Where the money was written down; a bank checkout with no record yet sits on its invoice when
    // that invoice is this org's, else on the org. Another org's invoice is never read or named.
    const invoice = capture
      ? capture.entity_type === 'INVOICE'
        ? await tx.invoice.findFirst({ where: { id: capture.entity_id, organization_id: organizationId }, select: { id: true, invoice_number: true } })
        : null
      : await tx.invoice.findFirst({ where: { id: session.invoiceId, organization_id: organizationId }, select: { id: true, invoice_number: true } });
    const on = invoice ? `on invoice ${invoice.invoice_number}` : 'in this account';
    const description = bank
      ? `The bank returned a payment ${on} that was not recorded automatically. Nothing on the invoice was changed. `
        + 'If the payment was recorded by hand, void it and check the balance.'
      : `A customer disputed a card payment ${on} that was not recorded on the invoice. Nothing on the invoice was changed. `
        + (final ? `The dispute closed: ${finalWords(status)}.` : 'Do not refund this payment while the dispute is open.');
    await tx.timelineEvent.create({
      data: {
        organization_id: organizationId,
        entity_type: invoice ? 'INVOICE' : 'ORGANIZATION',
        entity_id: invoice?.id ?? organizationId,
        event_type: UNBOOKED_DISPUTE_EVENT,
        description,
        metadata: {
          processor_dispute_id: dispute.id, stage, status, amount_cents: dispute.amount, bank_return: bank,
          checkout_session: session.id, payment_intent: dispute.payment_intent, event_id: event.id,
        },
      },
    });
    return { outcome: 'applied' as const, notice: { invoice, stage, status, bank } };
  }, { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted });

  const notice = result.notice;
  // The owner hears when it is raised and when the money is lost, as on a recorded payment.
  if (notice && (notice.stage === 'raised' || notice.status === 'LOST')) {
    const label = notice.invoice?.invoice_number ?? 'an invoice';
    const lost = notice.stage === 'final';
    const verb = lost ? 'billing.chargeback' : 'billing.disputed';
    await notifyOwners({
      verb,
      organizationId,
      object: notice.invoice
        ? { type: 'INVOICE', id: notice.invoice.id, label }
        : { type: 'ORGANIZATION', id: organizationId, label },
      data: {
        variant: notice.bank ? 'bank_return' : 'card', unrecorded: notice.bank ? 'bank' : 'card',
        amount: (dispute.amount / 100).toFixed(2),
        ...(notice.invoice ? {} : { object_kind: 'ORGANIZATION' }),
      },
      dedupKey: `${verb}:${dispute.id}`,
      actionLabel: notice.invoice ? 'Open the invoice' : 'Open Payments',
    });
    void logAudit({
      action: lost ? 'billing.dispute_closed' : 'billing.dispute_opened',
      resourceType: notice.invoice ? 'Invoice' : 'Organization',
      resourceId: notice.invoice?.id ?? organizationId,
      orgId: organizationId,
      actorId: null,
      metadata: { processor_dispute_id: dispute.id, bank_return: notice.bank, unrecorded_payment: true, status: notice.status },
    });
  }
  return result.outcome;
}


function finalWords(status: DisputeStatus): string {
  if (status === 'LOST') return 'the money was taken back';
  if (status === 'WON') return 'it was decided in your favor';
  return 'it ended without a chargeback';
}

/**
 * The owner hears about a dispute, after its ledger changes have committed: in-app and by email,
 * once per dispute and stage (slice 32). Copy names no processor.
 */
async function announceDispute(
  notice: DisputeNotice,
  organizationId: string,
  invoiceNumber: string,
  bankReturn?: { customerNotice: CustomerNoticeOutcome; invoiceVoided: boolean },
): Promise<void> {
  const variant = notice.bankReturn ? 'bank_return' : 'card';
  const object = { type: 'INVOICE' as const, id: notice.invoiceId, label: invoiceNumber };
  const customerName = await invoiceCustomerName(notice.invoiceId, organizationId);
  const facts = {
    amount: (notice.amountCents / 100).toFixed(2),
    ...(customerName ? { customer_name: customerName } : {}),
  };
  if (notice.kind === 'opened') {
    await notifyOwners({
      verb: 'billing.disputed', organizationId, object,
      data: {
        ...facts, variant,
        ...(notice.reason ? { reason_words: disputeReasonWords(notice.reason) } : {}),
        ...(notice.evidenceDueBy ? { evidence_due: longDate(notice.evidenceDueBy) } : {}),
      },
      dedupKey: `billing.disputed:${notice.processorDisputeId}`,
      actionLabel: 'Open the invoice',
    });
  } else if (notice.outcome === 'LOST') {
    await notifyOwners({
      verb: 'billing.chargeback', organizationId, object,
      data: {
        ...facts, variant: notice.partial ? 'partial_chargeback' : variant,
        // V7-13 (BE-13e): whether the debit had cleared, so the alert names the balance only when money was taken back.
        ...(notice.bankReturn && notice.cleared !== undefined ? { cleared: notice.cleared ? 'yes' : 'no' } : {}),
        // V7-13 (BE-13d): what became of the email to the customer. A not-open invoice that is not voided (PAID by another
        // payment, DISPUTED) cannot be paid online (C-38, C-49).
        ...(bankReturn ? { customer_notice: bankReturn.customerNotice } : {}),
        ...(bankReturn?.customerNotice === 'not_open' && !bankReturn.invoiceVoided ? { cannot_pay: 'yes' } : {}),
      },
      dedupKey: `billing.chargeback:${notice.processorDisputeId}`,
      actionLabel: 'Open the invoice',
    });
  } else {
    await notifyOwners({
      verb: 'billing.dispute_closed', organizationId, object,
      data: { ...facts, outcome: notice.outcome ?? 'CLOSED' },
      dedupKey: `billing.dispute_closed:${notice.processorDisputeId}`,
      actionLabel: 'Open the invoice',
    });
  }
  void logAudit({
    action: notice.kind === 'opened' ? 'billing.dispute_opened' : 'billing.dispute_closed',
    resourceType: 'Invoice',
    resourceId: notice.invoiceId,
    orgId: organizationId,
    actorId: null,
    metadata: {
      invoice_number: invoiceNumber, processor_dispute_id: notice.processorDisputeId, bank_return: notice.bankReturn,
      ...(notice.outcome ? { outcome: notice.outcome } : {}),
      ...(notice.partial ? { partial: true } : {}),
    },
  });
}

/** The date an owner reads ("October 20, 2026"); the processor's deadline is a UTC instant. */
function longDate(date: Date): string {
  return new Intl.DateTimeFormat('en-US', { dateStyle: 'long', timeZone: 'UTC' }).format(date);
}

/** The name staff know the invoice's customer by, or null. Scoped to the org. */
async function invoiceCustomerName(invoiceId: string, organizationId: string): Promise<string | null> {
  const person = { select: { first_name: true, last_name: true, company_name: true } };
  const invoice = await prisma.invoice.findFirst({
    where: { id: invoiceId, organization_id: organizationId },
    select: { customer: person, job: { select: { customer: person } } },
  });
  const customer = invoice?.customer ?? invoice?.job?.customer ?? null;
  if (!customer) return null;
  return [customer.first_name, customer.last_name].filter(Boolean).join(' ') || customer.company_name || null;
}
