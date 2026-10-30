/**
 * Payments go-live slice 14 (PRD Module 3): a customer can never pay an old amount through an old
 * link. Whenever what an invoice asks for stops being true, every checkout link still open for it
 * is expired at the processor. The triggers:
 *   - a payment is recorded by hand (the invoice's own door, and the estimate's deposit door);
 *   - the invoice is voided (the invoice void route and the job cancel cascade, slice 18), or a
 *     sent deposit is voided by its estimate closing (cancel, either decline, waive) or its lead
 *     closing (lost, cancelled);
 *   - a line, a scope of work or the billing changes (the invoice line editor);
 *   - a credit lowers the balance, or a give-back reopens it (the invoice credit route);
 *   - a payment is voided, which raises the balance of the invoice and of every invoice a voided
 *     deposit's credit is taken back from (the void-payment route);
 *   - an online payment is booked against it (the reconciler's expire_open_checkouts action).
 * The deposit put on hold has its own guard (estimates/deposit-checkout-guard.ts).
 *
 * Called after the change has committed. Nothing here throws and nothing here may fail its caller:
 * a payment, void or edit that cannot reach the processor still happens. A sweep that cannot prove
 * every link is dead is logged and leaves an audit row on the invoice; the next trigger sweeps
 * again, and a stale link that is paid anyway is written down by the reconciler, never dropped.
 * Resolves true when every link is proven dead (or there was nothing to close); a caller that must
 * not proceed on a live link (deleting a DRAFT) reads it, the fire-and-forget callers ignore it.
 */
import { prisma } from './prisma';
import { logger } from './logger';
import { logAudit } from './audit';
import { getStripeForOrg, isStripeConfigured, expireOpenCheckoutSessionsForInvoice } from './stripe';

/** Why the links were closed; recorded on the audit row when a sweep cannot finish. */
export type CheckoutExpiryTrigger =
  | 'manual_payment'
  | 'invoice_voided'
  | 'invoice_edited'
  | 'invoice_deleted'
  | 'credit_applied'
  | 'payment_voided'
  | 'online_payment';

export async function closeOpenCheckoutLinks(
  organizationId: string,
  invoices: ReadonlyArray<{ id: string; invoice_number?: string }>,
  trigger: CheckoutExpiryTrigger,
): Promise<boolean> {
  if (invoices.length === 0 || !isStripeConfigured()) return true;
  let allClosed = true;
  try {
    const org = await prisma.organization.findUnique({
      where: { id: organizationId },
      select: { stripe_account_id: true },
    });
    if (!org) return true;
    const ctx = getStripeForOrg(org);
    for (const invoice of invoices) {
      const result = await expireOpenCheckoutSessionsForInvoice(invoice.id, ctx);
      if (result.ok) continue;
      allClosed = false;
      logger.error(
        `Invoice ${invoice.invoice_number ?? ''} (${invoice.id}): could not confirm its open checkouts were expired after ${trigger}`
        + ` (expired=${result.expired.length}, failed=${result.failed}) - a stale payment link may still settle`,
      );
      void logAudit({
        action: 'invoice.checkout_expiry_failed',
        resourceType: 'Invoice',
        resourceId: invoice.id,
        orgId: organizationId,
        actorId: null,
        metadata: {
          ...(invoice.invoice_number ? { invoice_number: invoice.invoice_number } : {}),
          expired_sessions: result.expired.length,
          failed_sessions: result.failed,
          trigger,
        },
      });
    }
  } catch (err) {
    logger.error(`Closing open checkouts after ${trigger} failed for org ${organizationId}:`, err);
    return false;
  }
  return allClosed;
}

/**
 * Close the links of an estimate's voided deposit invoices, after an estimate door (cancel, either
 * decline, waive) voided its unpaid deposit in its own transaction. The door's single guarded
 * write does not say which rows it voided, so this reads them back after the commit: every VOIDED
 * deposit on the estimate. One voided earlier is swept again, which is harmless (it has no open
 * link left) and costs one list call on a door that runs once per estimate. Never throws.
 */
export async function closeVoidedDepositCheckoutLinks(organizationId: string, estimateId: string): Promise<void> {
  if (!isStripeConfigured()) return;
  try {
    const deposits = await prisma.invoice.findMany({
      where: { organization_id: organizationId, estimate_id: estimateId, kind: 'DEPOSIT', status: 'VOIDED' },
      select: { id: true, invoice_number: true },
    });
    await closeOpenCheckoutLinks(organizationId, deposits, 'invoice_voided');
  } catch (err) {
    logger.error(`Closing the voided deposit's open checkouts failed for estimate ${estimateId}:`, err);
  }
}
