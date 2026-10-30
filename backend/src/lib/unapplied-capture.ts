/**
 * Money that landed and that no invoice balance accounts for, written down where a person finds
 * it (#2031 slice 5, F1; payments go-live slice 05).
 *
 * Three records, the same ones the dispute and chargeback branches leave: a timeline entry on the
 * invoice (visible from the record itself), an in-app notification that interrupts an admin, and
 * an audit row. The card-checkout webhook uses this when it refuses to apply a capture; the ledger
 * uses it when a bank payment clears onto an invoice that can no longer take it, or clears for more
 * than the balance.
 *
 * The timeline entry is the durable record, so it can be written inside the caller's transaction
 * (writeUnappliedCaptureEntry); the alert and the audit row are best-effort and go out after the
 * money write has committed (alertUnappliedCapture), so an alert never points at money that rolled
 * back. Copy is staff-facing and names no vendor.
 *
 * Payments go-live slice 08: when the money cannot be tied to an invoice of the org it landed in
 * (the session names no invoice ServWave has, or another org's), the record sits on the org
 * itself (`invoice: null`), so another org's invoice is never touched.
 *
 * Payments go-live slice 11: the durable half also writes the unapplied-payment record
 * (unapplied_captures), which the Payments page lists on its Needs attention card with a one-click refund. One record per
 * captured money (its source key), however many times its event is delivered.
 */
import type { Prisma } from '@prisma/client';
import { notifyOwners, PAYMENTS_ATTENTION_PATH } from './owner-payment-notices';
import { logAudit } from './audit';

export type UnappliedCaptureReason =
  | 'AMOUNT_MISMATCH'
  | 'DEPOSIT_SUPERSEDED'
  | 'DEPOSIT_ON_HOLD'
  | 'INVOICE_NOT_PAYABLE'
  | 'OVERPAYMENT'
  // Slice 08: no invoice of this org can carry the money.
  | 'INVOICE_NOT_FOUND'
  | 'WRONG_ORG'
  // Slice 08: the session was built for another kind of document than the invoice it names.
  | 'DOCUMENT_MISMATCH'
  // Slice 08: a refund went out of this org's account for a payment ServWave has no record of.
  | 'REFUND_UNMATCHED';

export interface UnappliedCapture {
  /** The org the money landed in. */
  organizationId: string;
  /** The invoice the record sits on; null = on the org (no invoice of this org can carry it). */
  invoice: { id: string; invoice_number: string } | null;
  /** The timeline sentence a person reads on the invoice. */
  description: string;
  metadata: Prisma.InputJsonObject & { reason: UnappliedCaptureReason };
  /** One alert per money event, however many times the event is delivered. */
  dedupKey: string;
  /** Extra template data for the alert (the invoice label is always added). */
  notificationData?: Record<string, string>;
  /** What the unapplied-payment record keeps, so a person can send the money back. */
  record: UnappliedCaptureRecord;
}

export interface UnappliedCaptureRecord {
  /** The money not applied, in cents (null when the processor did not say). */
  amountCents: number | null;
  paymentIntentId: string | null;
  checkoutSessionId: string | null;
  /** The connected account the money sits in. */
  accountId: string | null;
  /** REFUND_UNMATCHED: the refund that went out. */
  refundId?: string | null;
  /** One record per captured money: the session, the settled payment, or the refund it came from. */
  sourceKey: string;
}

/**
 * The payment row a record's money sits on, when it has one: a bank payment that cleared onto an
 * invoice that could not take it (all of it, or the excess) is booked as a payment, and its record
 * is keyed `payment:<id>`. Money from a checkout ServWave refused to book has no payment row.
 */
export function ledgerPaymentIdOf(sourceKey: string): string | null {
  return sourceKey.startsWith('payment:') ? sourceKey.slice('payment:'.length) : null;
}

/**
 * Payments go-live slice 37b: a Payment is booked for a charge, so any OPEN "charge with no
 * payment" record the nightly reconcile wrote for that charge (source key `charge:<charge id>`, or
 * the same payment intent) is closed, in the booking's own transaction. Left open, staff could
 * refund it (the customer refunded, the invoice still paid) or apply it (the money booked twice).
 * Each record closed leaves an audit row saying the payment arrived. Returns the records closed.
 */
export async function resolveChargeRecordsForBookedPayment(
  tx: Prisma.TransactionClient,
  input: { organizationId: string; chargeId: string | null; paymentIntentId: string | null; paymentId: string },
): Promise<number> {
  const { organizationId, chargeId, paymentIntentId, paymentId } = input;
  const keys = [
    ...(chargeId ? [{ source_key: `charge:${chargeId}` }] : []),
    ...(paymentIntentId ? [{ stripe_payment_intent_id: paymentIntentId, source_key: { startsWith: 'charge:' } }] : []),
  ];
  if (keys.length === 0) return 0;
  const open = await tx.unappliedCapture.findMany({
    where: { organization_id: organizationId, status: 'OPEN', OR: keys },
    select: { id: true },
  });
  let closed = 0;
  for (const rec of open) {
    // Conditional: a record a person resolved or refunded in the meantime is left as they left it.
    const { count } = await tx.unappliedCapture.updateMany({
      where: { id: rec.id, organization_id: organizationId, status: 'OPEN' },
      data: { status: 'RESOLVED' },
    });
    if (count === 0) continue;
    closed += 1;
    await tx.auditLog.create({
      data: {
        org_id: organizationId,
        actor_id: null,
        action: 'payment_attention.resolved',
        resource_type: 'UnappliedCapture',
        resource_id: rec.id,
        metadata: { note: 'The payment arrived and was booked; this record was closed.', payment_id: paymentId },
      },
    });
  }
  return closed;
}

/** The durable half: the timeline entry, through whichever client the caller holds. */
export async function writeUnappliedCaptureEntry(
  db: Pick<Prisma.TransactionClient, 'timelineEvent' | 'unappliedCapture'>,
  capture: UnappliedCapture,
): Promise<void> {
  const { record } = capture;
  // ON CONFLICT DO NOTHING: a second delivery of the same money never makes a second record, and
  // never aborts the transaction it runs in.
  await db.unappliedCapture.createMany({
    data: [{
      organization_id: capture.organizationId,
      invoice_id: capture.invoice?.id ?? null,
      reason: capture.metadata.reason,
      amount: record.amountCents != null ? record.amountCents / 100 : null,
      stripe_payment_intent_id: record.paymentIntentId,
      stripe_checkout_session_id: record.checkoutSessionId,
      stripe_account_id: record.accountId,
      stripe_refund_id: record.refundId ?? null,
      source_key: record.sourceKey,
    }],
    skipDuplicates: true,
  });
  await db.timelineEvent.create({
    data: {
      organization_id: capture.organizationId,
      entity_type: capture.invoice ? 'INVOICE' : 'ORGANIZATION',
      entity_id: capture.invoice?.id ?? capture.organizationId,
      event_type: 'PAYMENT_UNRECORDED',
      description: capture.description,
      metadata: capture.metadata,
    },
  });
}

/**
 * The alert half: the owner's notification and email, and the audit row. Call after the money write
 * commits. Slice 32: the alert opens the Payments page, where the Needs attention
 * card holds the row, and carries the row's source key so refunding or resolving the row can clear it.
 */
export async function alertUnappliedCapture(capture: UnappliedCapture): Promise<void> {
  const { organizationId, invoice, metadata, dedupKey, notificationData } = capture;
  await notifyOwners({
    verb: 'billing.payment_unrecorded',
    organizationId,
    object: invoice
      ? { type: 'INVOICE', id: invoice.id, label: invoice.invoice_number }
      : { type: 'ORGANIZATION', id: organizationId, label: 'an invoice' },
    data: {
      ...notificationData,
      reason: metadata.reason,
      link_path: PAYMENTS_ATTENTION_PATH,
      source_key: capture.record.sourceKey,
      ...(invoice ? {} : { object_kind: 'ORGANIZATION' }),
    },
    dedupKey,
    actionLabel: 'Open Needs attention',
  });

  void logAudit({
    action: 'billing.payment_unrecorded',
    resourceType: invoice ? 'Invoice' : 'Organization',
    resourceId: invoice?.id ?? organizationId,
    orgId: organizationId,
    actorId: null,
    metadata: { ...(invoice ? { invoice_number: invoice.invoice_number } : {}), ...metadata },
  });
}


/**
 * Slice 32: the row was dealt with (refunded, or marked resolved), so its "could not be applied"
 * alert is read for everyone it reached. Keyed on the row's source key and scoped to the org.
 *
 * Slice 33b: an alert raised before slice 32 carries no source key, so it is matched by what it
 * does carry: the invoice (or, for money on the org itself, the org) it was raised on. It is
 * cleared only when no OTHER open row remains on that same invoice (or the org), so one row's
 * resolution never silences another row's alert.
 */
export async function clearUnappliedCaptureAlerts(
  db: Pick<Prisma.TransactionClient, 'notificationRecipient' | 'notification' | 'unappliedCapture'>,
  organizationId: string,
  sourceKey: string,
): Promise<void> {
  const now = new Date();
  await db.notificationRecipient.updateMany({
    where: {
      organization_id: organizationId,
      read_at: null,
      notification: {
        organization_id: organizationId,
        verb: 'billing.payment_unrecorded',
        data: { path: ['source_key'], equals: sourceKey },
      },
    },
    data: { read_at: now },
  });

  const row = await db.unappliedCapture.findFirst({
    where: { organization_id: organizationId, source_key: sourceKey },
    select: { invoice_id: true },
  });
  if (!row) return;
  const stillOpen = await db.unappliedCapture.count({
    where: { organization_id: organizationId, invoice_id: row.invoice_id, status: 'OPEN', source_key: { not: sourceKey } },
  });
  if (stillOpen > 0) return;
  const older = await db.notification.findMany({
    where: {
      organization_id: organizationId,
      verb: 'billing.payment_unrecorded',
      object_type: row.invoice_id ? 'INVOICE' : 'ORGANIZATION',
      object_id: row.invoice_id ?? organizationId,
      recipients: { some: { read_at: null } },
    },
    select: { id: true, data: true },
  });
  const olderIds = older
    .filter((n) => !(n.data && typeof n.data === 'object' && 'source_key' in n.data))
    .map((n) => n.id);
  if (olderIds.length === 0) return;
  await db.notificationRecipient.updateMany({
    where: { organization_id: organizationId, read_at: null, notification_id: { in: olderIds } },
    data: { read_at: now },
  });
}

// ---------------------------------------------------------------------------------------------------------------------
// V7-09b (C-32): a partial refund of unapplied money. The record keeps the dollars already sent back (refunded_amount)
// and the refunds counted into it (counted_refund_ids), so one refund reported twice - the staff door and its event, a
// replayed event - counts once, and the record closes (REFUNDED) only when the whole amount is back.
// ---------------------------------------------------------------------------------------------------------------------

const centsOf = (d: { toString(): string }): number => Math.round(Number(d.toString()) * 100);

type CaptureTx = Pick<Prisma.TransactionClient, 'unappliedCapture' | '$executeRaw'>;

/**
 * Count one refund of a record, once. Takes the record's row lock (the caller may hold it already), so two writers of the
 * same refund - or two refunds - never interleave. A refund already counted, or known to have failed, changes nothing.
 * The record closes (status REFUNDED, the refund's id kept) when this refund closes it or the total back reaches the amount;
 * a RESOLVED record is closed too (the money went back, and that is what it must say). Returns whether it is closed now.
 */
export async function countRefundOnCapture(
  tx: CaptureTx,
  input: { organizationId: string; recordId: string; refundId: string; refundCents: number; closes: boolean; closedBy?: { id: string; name: string } },
): Promise<{ counted: boolean; closed: boolean }> {
  const { organizationId, recordId, refundId, refundCents } = input;
  await tx.$executeRaw`SELECT id FROM unapplied_captures WHERE id = ${recordId}::uuid AND organization_id = ${organizationId}::uuid FOR UPDATE`;
  const row = await tx.unappliedCapture.findFirst({
    where: { id: recordId, organization_id: organizationId },
    select: { status: true, amount: true, refunded_amount: true, counted_refund_ids: true, failed_refund_ids: true },
  });
  if (!row) return { counted: false, closed: false };
  if (row.failed_refund_ids.includes(refundId)) return { counted: false, closed: row.status === 'REFUNDED' };
  if (row.counted_refund_ids.includes(refundId)) return { counted: false, closed: row.status === 'REFUNDED' };
  const refundedCents = centsOf(row.refunded_amount) + Math.max(refundCents, 0);
  const closing = (row.status === 'OPEN' || row.status === 'RESOLVED')
    && (input.closes || (row.amount != null && refundedCents >= centsOf(row.amount)));
  const now = new Date();
  await tx.unappliedCapture.updateMany({
    where: { id: recordId, organization_id: organizationId },
    data: {
      refunded_amount: refundedCents / 100,
      counted_refund_ids: { push: refundId },
      ...(closing
        ? {
            status: 'REFUNDED', stripe_refund_id: refundId, refunded_at: now,
            // Who sent it back and when (V7-05b); the reconciler knows no user.
            ...(input.closedBy ? { resolved_at: now, resolved_by: input.closedBy.id, resolved_by_name: input.closedBy.name } : {}),
          }
        : {}),
    },
  });
  return { counted: true, closed: closing || row.status === 'REFUNDED' };
}

/** The reason on a record made for money a failed refund handed back to a record already dealt with. */
const RETURNED_REASON: UnappliedCaptureReason = 'INVOICE_NOT_FOUND';

/**
 * A refund of a record failed: the money is still here, and it must always be held by an OPEN item the office can act
 * on, in exactly the cents that came back.
 *  - The record is OPEN (or this refund was the one that closed it, and the caller already reopened it): the cents
 *    simply come back to it.
 *  - The record was dealt with since (attached to an invoice, marked resolved, or closed by a LATER refund): reopening it
 *    would hand out money already booked or sent, so the returned cents move to a NEW open record of their own
 *    (source key `returned:<record>:<refund>`, so a replayed failure makes one) and leave this one holding what it
 *    really did: its amount and its refunded total both drop by those cents.
 * A refund that was never counted (its failure landed first, or the record predates the counting) changes nothing here.
 */
export async function uncountRefundOnCapture(
  tx: CaptureTx & Pick<Prisma.TransactionClient, 'auditLog'>,
  input: { organizationId: string; recordId: string; refundId: string; refundCents: number },
): Promise<void> {
  const { organizationId, recordId, refundId } = input;
  await tx.$executeRaw`SELECT id FROM unapplied_captures WHERE id = ${recordId}::uuid AND organization_id = ${organizationId}::uuid FOR UPDATE`;
  const row = await tx.unappliedCapture.findFirst({
    where: { id: recordId, organization_id: organizationId },
    select: {
      status: true, amount: true, refunded_amount: true, counted_refund_ids: true,
      stripe_payment_intent_id: true, stripe_account_id: true,
    },
  });
  if (!row || !row.counted_refund_ids.includes(refundId)) return;
  const cents = Math.max(input.refundCents, 0);
  const refundedCents = Math.max(centsOf(row.refunded_amount) - cents, 0);
  const remaining = row.counted_refund_ids.filter((id) => id !== refundId);
  if (row.status === 'OPEN') {
    await tx.unappliedCapture.updateMany({
      where: { id: recordId, organization_id: organizationId },
      data: { refunded_amount: refundedCents / 100, counted_refund_ids: remaining },
    });
    return;
  }
  // Dealt with already: the returned cents get an open record of their own.
  const keptCents = Math.max((row.amount != null ? centsOf(row.amount) : 0) - cents, 0);
  await tx.unappliedCapture.updateMany({
    where: { id: recordId, organization_id: organizationId },
    data: { amount: keptCents / 100, refunded_amount: refundedCents / 100, counted_refund_ids: remaining },
  });
  if (cents <= 0) return;
  const sourceKey = `returned:${recordId}:${refundId}`;
  await tx.unappliedCapture.createMany({
    data: [{
      organization_id: organizationId,
      invoice_id: null,
      reason: RETURNED_REASON,
      amount: cents / 100,
      stripe_payment_intent_id: row.stripe_payment_intent_id,
      // No checkout session: the payment row an attach books for this money must not claim the session twice.
      stripe_checkout_session_id: null,
      stripe_account_id: row.stripe_account_id,
      source_key: sourceKey,
    }],
    skipDuplicates: true,
  });
  await tx.auditLog.create({
    data: {
      org_id: organizationId,
      actor_id: null,
      action: 'payment_attention.returned',
      resource_type: 'UnappliedCapture',
      resource_id: recordId,
      metadata: { note: 'A refund of this payment failed after it was dealt with; the money is open again as its own item.', source_key: sourceKey, amount: cents / 100 },
    },
  });
}
