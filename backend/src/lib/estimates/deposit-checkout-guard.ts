/**
 * #2031 slice 5 (F2) — close the deposit-link window at the card processor.
 *
 * The public checkout door refuses to OPEN a payment on a superseded deposit. That is a gate on
 * new sessions only. A session the customer opened before the estimate was edited is already live
 * at the processor and settles by itself, against an `amount_due` the re-price has not touched
 * yet — so it passes every downstream cross-check and books a payment at a figure the business no
 * longer quotes.
 *
 * So the session is killed. Two trigger points, because they are two different moments:
 *
 *   1. THE MATERIAL EDIT — when the deposit figure stops being true. This is the one that closes
 *      the window: the re-price may not happen for days, or ever, and the window is open the whole
 *      time. Fires only when the figure would actually MOVE (F4): a FIXED deposit under a changed
 *      total, or a renamed discount, still asks for exactly the right money, and killing a
 *      customer's working payment link over that is a defect of its own.
 *   2. THE RE-PRICE — when the figure actually moves. Unconditional: by then the document already
 *      holds the NEW amount, so "would it move" is false by construction, while any session still
 *      open was opened against the OLD one.
 *
 * Nothing here throws and nothing here is allowed to fail its caller. An edit that cannot reach
 * Stripe is still an edit; a send that cannot reach Stripe is still a send. What must NOT happen
 * is the caller believing the link was killed when it was not — so a sweep that cannot prove the
 * invoice is clean files the same durable, findable record a human gets for any other money event
 * that needs looking at.
 */
import { prisma } from '../prisma';
import { logger } from '../logger';
import { logAudit } from '../audit';
import {
  getStripeForOrg,
  isStripeConfigured,
  expireOpenCheckoutSessionsForInvoice,
  type CheckoutExpiryResult,
} from '../stripe';
import { resolveDepositAmount, depositFigureWouldMove } from './deposit-amount';

/**
 * The deposit document plus everything needed to decide whether its figure has gone stale. A
 * DRAFT/SENT/PARTIAL row only: a PAID, VOIDED or REFUNDED deposit has no live payable link this
 * is responsible for, and a PARTIAL one is never re-priced but can still carry an open session.
 */
const guardSelect = {
  id: true,
  invoice_number: true,
  organization_id: true,
  total_amount: true,
  estimate: { select: { deposit_type: true, deposit_value: true, total_amount: true } },
  organization: {
    select: {
      stripe_account_id: true,
      deposit_default_type: true,
      deposit_default_percentage: true,
      deposit_default_fixed_amount: true,
    },
  },
} as const;

const LIVE_DEPOSIT_STATUSES = ['DRAFT', 'SENT', 'PARTIAL'] as const;

/**
 * The sweep could not prove the link is dead. The customer may still be able to pay at the old
 * figure, so this has to reach a person — same shape as every other operationally-important money
 * event in this codebase (an audit row on the record, readable from its history).
 */
function recordUnkillableCheckout(
  organizationId: string,
  invoice: { id: string; invoice_number: string },
  result: CheckoutExpiryResult,
) {
  logger.error(
    `Deposit ${invoice.invoice_number} (${invoice.id}): could not confirm its open card checkouts were expired`
    + ` (expired=${result.expired.length}, failed=${result.failed}) — a stale payment link may still settle`,
  );
  void logAudit({
    action: 'estimate.deposit_checkout_expiry_failed',
    resourceType: 'Invoice',
    resourceId: invoice.id,
    orgId: organizationId,
    actorId: null,
    metadata: {
      invoice_number: invoice.invoice_number,
      expired_sessions: result.expired.length,
      failed_sessions: result.failed,
    },
  });
}

async function sweep(
  organizationId: string,
  invoice: { id: string; invoice_number: string; organization: { stripe_account_id: string | null } },
): Promise<void> {
  if (!isStripeConfigured()) return;
  const ctx = getStripeForOrg(invoice.organization);
  const result = await expireOpenCheckoutSessionsForInvoice(invoice.id, ctx);
  if (!result.ok) recordUnkillableCheckout(organizationId, invoice, result);
}

/**
 * Trigger 1 — a material edit landed on this estimate. Kill the open checkouts behind its unpaid
 * deposit invoice, but only if the edit actually moved the figure.
 */
export async function expireDepositCheckoutsOnMaterialEdit(
  estimateId: string,
  organizationId: string,
): Promise<void> {
  try {
    const invoice = await prisma.invoice.findFirst({
      where: {
        estimate_id: estimateId,
        kind: 'DEPOSIT',
        organization_id: organizationId,
        status: { in: [...LIVE_DEPOSIT_STATUSES] },
      },
      select: guardSelect,
    });
    if (!invoice?.estimate) return;

    const { depositAmount } = resolveDepositAmount(invoice.estimate, invoice.organization);
    if (!depositFigureWouldMove(invoice.total_amount, depositAmount)) return;

    await sweep(organizationId, invoice);
  } catch (err) {
    // Never fails the edit. The public checkout door still refuses this deposit, and the webhook
    // refuses to book a superseded one, so this failing degrades the guarantee — it does not
    // remove it.
    logger.error(`Deposit checkout expiry (material edit) failed for estimate ${estimateId}:`, err);
  }
}

/**
 * Trigger 2 — the deposit invoice was just re-priced. Any session still open was opened at the
 * figure that has just been replaced, so they all die regardless of what the document now says.
 */
export async function expireDepositCheckoutsAfterReprice(
  invoiceId: string,
  organizationId: string,
): Promise<void> {
  try {
    const invoice = await prisma.invoice.findFirst({
      where: { id: invoiceId, organization_id: organizationId },
      select: guardSelect,
    });
    if (!invoice) return;
    await sweep(organizationId, invoice);
  } catch (err) {
    logger.error(`Deposit checkout expiry (re-price) failed for invoice ${invoiceId}:`, err);
  }
}

/**
 * Trigger 3 — the estimate was recalled to draft. Unconditional on the figure: a recall is not a
 * claim that the amount is wrong, it is a statement that the document has been withdrawn, so
 * whatever a customer has open against it must stop being able to settle. A session opened before
 * the recall is exactly how money arrives after the link is supposed to be shut.
 *
 * The status filter is what protects a settled deposit: a PAID or REFUNDED row is never found
 * here, so a deposit with money against it is not read, not swept and not written.
 */
export async function expireDepositCheckoutsOnRecall(
  estimateId: string,
  organizationId: string,
): Promise<void> {
  try {
    const invoice = await prisma.invoice.findFirst({
      where: {
        estimate_id: estimateId,
        kind: 'DEPOSIT',
        organization_id: organizationId,
        status: { in: [...LIVE_DEPOSIT_STATUSES] },
      },
      select: guardSelect,
    });
    if (!invoice) return;
    await sweep(organizationId, invoice);
  } catch (err) {
    // Never fails the status change. A salesperson pulling a document back cannot be blocked by
    // the card processor; the public door refuses the recalled deposit regardless, and the webhook
    // refuses to book one, so this failing degrades the guarantee - it does not remove it.
    logger.error(`Deposit checkout expiry (recall to draft) failed for estimate ${estimateId}:`, err);
  }
}
