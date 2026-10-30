/**
 * Payments go-live slice 29: an in-app refund holds its money BEFORE the processor is asked.
 *
 * The refund doors used to call the processor first and write the refund row afterwards, so two
 * refunds made at the same moment both passed their caps (neither saw the other) and could
 * together send back more than was paid. Now a door, under the invoice lock, re-checks its caps
 * against the rows as they stand and writes its refund row PENDING with no processor id: a
 * reservation. Every other door's cap counts it (a PENDING refund holds its share), so a second
 * refund is refused before the processor is asked. Then the processor is called, outside any
 * transaction, and the reservation is completed with the processor's refund id and state, or
 * released when the processor refused (nothing went out).
 *
 * The refund carries the reservation's id in its metadata (REFUND_ROW_METADATA_KEY), so the
 * processor's refund event, which can land before the call has returned, completes the same row
 * instead of recording a second (payment-reconciler/index.ts).
 */
import type { Prisma, RefundState } from '@prisma/client';
import { prisma } from './prisma';
import { OUTSIDE_REFUND_REASON } from '../services/payment-reconciler/apply';

/** The processor refund's metadata key naming the reserved refund row it was sent for. */
export const REFUND_ROW_METADATA_KEY = 'refund_row_id';

/**
 * Write the refund row PENDING, with no processor id yet. The caller holds the invoice lock and has
 * re-checked its caps against the locked rows.
 */
export async function reserveRefund(
  tx: Prisma.TransactionClient,
  data: Omit<Prisma.RefundUncheckedCreateInput, 'state' | 'stripe_refund_id'>,
): Promise<{ id: string }> {
  return tx.refund.create({ data: { ...data, state: 'PENDING', stripe_refund_id: null }, select: { id: true } });
}

/**
 * The processor refused the refund, so nothing went out: the reservation is removed and its money
 * is free again. A reservation the refund's event already completed (it carries a processor id) is
 * a refund that did go out, and is kept.
 */
export async function releaseRefundReservation(organizationId: string, refundRowId: string): Promise<void> {
  await prisma.refund.deleteMany({ where: { id: refundRowId, organization_id: organizationId, stripe_refund_id: null } });
}

/**
 * True only when the processor definitely refused the call (a 4xx answer other than 409, which
 * means another request under the same key is still running). A dropped connection, a timeout, a
 * 5xx or a 409 is ambiguous: the refund may already exist there, so its reservation must stay held.
 */
export function refundDefinitelyRefused(err: unknown): boolean {
  const status = (err as { statusCode?: unknown } | null)?.statusCode;
  return typeof status === 'number' && status >= 400 && status < 500 && status !== 409;
}

/**
 * Release the reservation only for a definite refusal. Returns true when released; false when the
 * answer is unknown and the money stays held (the refund's own event completes the row if it exists).
 */
export async function releaseIfRefused(organizationId: string, refundRowId: string, err: unknown): Promise<boolean> {
  if (!refundDefinitelyRefused(err)) return false;
  await releaseRefundReservation(organizationId, refundRowId);
  return true;
}

/**
 * The processor took the refund: the reservation gets its refund id and state. The caller holds the
 * invoice lock. If the refund's event got there first, it already named the row (its state is the
 * processor's later word and is kept). If an event recorded the refund as a row of its own (one that
 * lost the reservation's id), that row is completed with the reservation's details and the
 * reservation goes, so the refund is on record once.
 *
 * Returns the refund row's id and whether THIS call moved the row. When the refund's event settled
 * the row first (it carries the processor id), the event's own handler told the customer, so the
 * door must not tell them again: it emails only when `moved` is true (slice 31).
 */
export async function completeReservedRefund(
  tx: Prisma.TransactionClient,
  input: { refundRowId: string; organizationId: string; stripeRefundId: string | null; state: RefundState },
): Promise<{ id: string; moved: boolean }> {
  const { refundRowId, organizationId, stripeRefundId, state } = input;
  const reservation = await tx.refund.findFirstOrThrow({ where: { id: refundRowId, organization_id: organizationId } });
  if (stripeRefundId) {
    const recorded = await tx.refund.findFirst({
      where: { stripe_refund_id: stripeRefundId, organization_id: organizationId, id: { not: refundRowId } },
      select: { id: true, state: true, reason: true },
    });
    if (recorded) {
      await tx.refund.delete({ where: { id: refundRowId } });
      // Slice 32b: the customer is told on ONE state transition. A row the event recorded as made
      // outside ServWave was never announced (the event's email skips it), so the door announces
      // it now; a row still PENDING moves to the door's state here, so the event that confirms it
      // later finds nothing to change and says nothing; a row already settled under the door's own
      // reason was announced by the event that settled it.
      const claimed = recorded.state === 'PENDING' && state !== 'PENDING'
        ? (await tx.refund.updateMany({ where: { id: recorded.id, state: 'PENDING' }, data: { state } })).count > 0
        : false;
      const unannounced = recorded.state === 'SUCCEEDED' && recorded.reason === OUTSIDE_REFUND_REASON;
      await tx.refund.update({
        where: { id: recorded.id },
        data: {
          payment_id: reservation.payment_id,
          amount: reservation.amount,
          tax_portion: reservation.tax_portion,
          non_taxable_concession: reservation.non_taxable_concession,
          method: reservation.method,
          reason: reservation.reason,
          reason_category: reservation.reason_category,
          refunded_by: reservation.refunded_by,
          from_unapplied_capture: reservation.from_unapplied_capture,
        },
      });
      return { id: recorded.id, moved: claimed || unannounced || recorded.state === 'PENDING' };
    }
  }
  if (reservation.stripe_refund_id) return { id: reservation.id, moved: false };
  await tx.refund.update({ where: { id: refundRowId }, data: { stripe_refund_id: stripeRefundId, state } });
  return { id: reservation.id, moved: true };
}
