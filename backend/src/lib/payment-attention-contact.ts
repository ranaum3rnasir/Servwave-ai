/**
 * Asking a customer to pay a failed bank payment again, from ServWave's side: what the office's Contact customer
 * endpoint and the automatic emails (a bank return, a debit that failed while clearing) share, so the two never both
 * email the same customer for the same item inside the throttle window.
 *
 * One history row per real send ("Customer emailed a link to pay again"), keyed on the item
 * (`failed_payment:{paymentId}`). The row is claimed under an advisory lock on the item BEFORE the email goes out and
 * given back when no email left, so two quick attempts claim the item once and only the winner sends, and only a real
 * send stays recorded (and throttled). The email itself is sent after the claim's transaction has ended: the mail layer
 * uses the app's own client, which must never be awaited while a transaction holds the only pooled connection.
 */
import type { Prisma } from '@prisma/client';
import { prisma } from './prisma';
import { logger } from './logger';

/** A second "ask the customer to pay again" for the same payment inside this window is refused. */
export const CONTACT_THROTTLE_MS = 10 * 60 * 1000;
export const TIMELINE_ASKED_AGAIN = 'PAYMENT_CUSTOMER_ASKED_TO_PAY_AGAIN';
/** The one wording of the history row, whoever sent the email. */
export const ASKED_AGAIN_DESCRIPTION = 'Customer emailed a link to pay again';

/** The Needs-attention item key of a failed bank payment. */
export const failedPaymentItemKey = (paymentId: string): string => `failed_payment:${paymentId}`;

/**
 * Whether the item was asked inside the throttle window (a history row for the invoice carrying the item key).
 * Read-only; the claim below is what keeps two attempts from both sending.
 */
export async function askedRecently(
  db: Prisma.TransactionClient | typeof prisma,
  args: { organizationId: string; invoiceId: string; itemKey: string },
): Promise<boolean> {
  const recent = await db.timelineEvent.findFirst({
    where: {
      organization_id: args.organizationId, entity_type: 'INVOICE', entity_id: args.invoiceId, event_type: TIMELINE_ASKED_AGAIN,
      metadata: { path: ['item_key'], equals: args.itemKey }, created_at: { gte: new Date(Date.now() - CONTACT_THROTTLE_MS) },
    },
    select: { id: true },
  });
  return recent !== null;
}

/**
 * Claim the item for one send: under the item's advisory lock, refuse (null) when it was asked inside the window,
 * otherwise write the history row and return its id. `createdBy` is the person who clicked, or null for an automatic send.
 */
export async function claimContact(args: { organizationId: string; invoiceId: string; itemKey: string; createdBy: string | null }): Promise<string | null> {
  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`attention-contact:${args.itemKey}`}, 0))`;
    if (await askedRecently(tx, args)) return null;
    const created = await tx.timelineEvent.create({
      data: {
        organization_id: args.organizationId, entity_type: 'INVOICE', entity_id: args.invoiceId, event_type: TIMELINE_ASKED_AGAIN,
        description: ASKED_AGAIN_DESCRIPTION, metadata: { item_key: args.itemKey }, created_by: args.createdBy,
      },
      select: { id: true },
    });
    return created.id;
  });
}

/** Give a claim back because no email left. If it cannot be given back the customer is not emailed for the window, the safe direction. */
export async function releaseContactClaim(organizationId: string, claimId: string, invoiceId: string): Promise<void> {
  try {
    await prisma.timelineEvent.deleteMany({ where: { id: claimId, organization_id: organizationId } });
  } catch (releaseError) {
    logger.error(`payment attention contact: could not release the throttle row after an unsent email (invoice ${invoiceId})`, releaseError);
  }
}
