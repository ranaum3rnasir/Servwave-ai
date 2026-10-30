/**
 * Payments go-live slice 15 (from the slice 09 review): take back the credit ONE deposit gave the
 * invoices it was drawn onto, when that deposit's payment is taken back (a lost dispute or bank
 * return through the reconciler's chargeback void, or a staff void of the payment).
 *
 * The staff void door and the chargeback void used to share this cascade by copy, and both:
 *   - voided EVERY live deposit-credit row on each target, a second deposit's credit included,
 *     while raising the balance by this deposit's share only;
 *   - stamped each target SENT or PARTIAL whatever it was, so a DISPUTED target lost its dispute
 *     flag and a VOIDED one was reopened for payment.
 *
 * Only the credit the deposit's money no longer covers is taken back (fix round 1). A deposit can
 * be paid by more than one payment (part by hand, the rest through checkout), and taking back one
 * of them leaves the others' money on the deposit, with the credit it covers still owed to the
 * customer. So, once the caller has voided the payment, the credit to take back is what is applied
 * beyond what the deposit still holds (its counted payments less the refunds that left with them),
 * the same sum remainingDepositCredit keeps from going below zero. It is taken from applications on
 * a VOIDED target first (they give the customer nothing), then from the newest drawdown back; an
 * application only partly taken back is split: it and its credit row are closed, and an application
 * and credit row for the part that stays are written in their place.
 *
 * Per application taken back, under the target's lock:
 *   - a VOIDED target is a document the contractor closed: its balance and status stay as they are
 *     (its void released its own credit; an application still standing on it is only marked);
 *   - exactly one live credit row of this application's amount is voided (the drawdown writes one
 *     row per application and carries no link back, so the amount is how a row is told apart; two
 *     rows of the same amount are interchangeable);
 *   - the balance rises by the part taken back, and the status is derived from the money left
 *     on the invoice. DRAFT and DISPUTED are not money states and are kept: a disputed invoice's
 *     status is decided when its dispute closes.
 *
 * The caller holds the deposit invoice's lock and is inside the transaction. Returns the targets
 * whose balance rose, for the caller's history rows and its post-commit link sweep.
 */
import type { Prisma, InvoiceStatus, VoidPaymentReason } from '@prisma/client';
import { DEPOSIT_CREDIT_REFERENCE, depositHeldCents } from './deposit-credit';
import { COUNTED_PAYMENT_WHERE, COUNTED_REFUND_WHERE, toCents, fromCents, paidCents, refundedCents } from './payment-ledger';
import { impliedMoneyStatus } from './invoice-money-status';

/** Statuses that are not decided by the invoice's money, so a credit reversal leaves them alone. */
const KEPT_STATUSES: readonly InvoiceStatus[] = ['DRAFT', 'DISPUTED'];

export interface ReversedDepositCredit {
  id: string;
  invoice_number: string;
  /** The credit taken back from this invoice, in dollars. */
  amount: number;
}

export async function reverseDepositCredit(
  tx: Prisma.TransactionClient,
  input: {
    depositInvoiceId: string;
    organizationId: string;
    now: Date;
    /** How the target's credit row is marked voided. */
    creditVoid: { voided_reason: string; voided_by: string | null; void_category: VoidPaymentReason };
  },
): Promise<ReversedDepositCredit[]> {
  const { depositInvoiceId, organizationId, now, creditVoid } = input;
  const activeWhere = { deposit_invoice_id: depositInvoiceId, organization_id: organizationId, reversed_at: null };

  // Lock the targets (in id order) before reading their balances, the lock every payment door
  // takes: a payment landing on a target at this moment commits first and is the balance raised,
  // never written over with a stale one. The applications are re-read under those locks.
  const targetIds = [...new Set((await tx.depositCreditApplication.findMany({
    where: activeWhere,
    select: { target_invoice_id: true },
  })).map((a) => a.target_invoice_id))].sort();
  if (targetIds.length === 0) return [];
  await tx.$executeRaw`SELECT id FROM invoices WHERE id = ANY(${targetIds}::uuid[]) AND organization_id = ${organizationId}::uuid ORDER BY id FOR UPDATE`;
  const activeApps = await tx.depositCreditApplication.findMany({
    where: activeWhere,
    orderBy: { created_at: 'desc' },
    include: { target_invoice: { select: { status: true } } },
  });
  if (activeApps.length === 0) return [];

  // What the deposit still holds once the caller's void is written: the one sum the drawdown and
  // the refund cap use too (depositHeldCents, slice 29).
  const heldCents = await depositHeldCents(tx, depositInvoiceId);
  const appliedCents = activeApps.reduce((sum, a) => sum + toCents(a.amount), 0);
  let toReverseCents = Math.max(0, appliedCents - Math.max(0, heldCents));
  if (toReverseCents === 0) return [];

  // A VOIDED target's application first (taking it back costs the customer nothing), then newest first.
  const order = [
    ...activeApps.filter((a) => a.target_invoice.status === 'VOIDED'),
    ...activeApps.filter((a) => a.target_invoice.status !== 'VOIDED'),
  ];

  const raised: ReversedDepositCredit[] = [];
  for (const app of order) {
    if (toReverseCents <= 0) break;
    const appCents = toCents(app.amount);
    const partCents = Math.min(appCents, toReverseCents);
    const keptCents = appCents - partCents;
    toReverseCents -= partCents;

    await tx.depositCreditApplication.update({
      where: { id: app.id, organization_id: organizationId },
      data: { reversed_at: now },
    });
    if (keptCents > 0) {
      // The part the deposit's remaining money still covers stays applied, in the drawdown's place.
      await tx.depositCreditApplication.create({
        data: {
          deposit_invoice_id: depositInvoiceId,
          target_invoice_id: app.target_invoice_id,
          amount: fromCents(keptCents),
          organization_id: organizationId,
          created_at: app.created_at,
        },
      });
    }

    const target = await tx.invoice.findFirst({
      where: { id: app.target_invoice_id, organization_id: organizationId },
      select: { id: true, invoice_number: true, status: true, amount_due: true },
    });
    if (!target || target.status === 'VOIDED') continue;

    const credit = await tx.payment.findFirst({
      where: { invoice_id: target.id, reference_number: DEPOSIT_CREDIT_REFERENCE, voided_at: null, amount: app.amount },
      orderBy: { created_at: 'asc' },
      select: {
        id: true, method: true, paid_at: true, notes: true, created_at: true,
        created_by_id: true, created_by_name: true, created_by_source: true,
      },
    });
    if (credit) {
      await tx.payment.update({ where: { id: credit.id }, data: { voided_at: now, ...creditVoid } });
      if (keptCents > 0) {
        const { id: _closed, ...same } = credit;
        await tx.payment.create({
          data: { ...same, invoice_id: target.id, amount: fromCents(keptCents), reference_number: DEPOSIT_CREDIT_REFERENCE },
        });
      }
    }

    const amountDueCents = toCents(target.amount_due) + partCents;
    let status: InvoiceStatus = target.status;
    if (!KEPT_STATUSES.includes(target.status)) {
      const money = await tx.invoice.findUniqueOrThrow({
        where: { id: target.id },
        select: {
          payments: { where: COUNTED_PAYMENT_WHERE, select: { amount: true, reference_number: true } },
          refunds: { where: COUNTED_REFUND_WHERE, select: { amount: true, state: true, from_unapplied_capture: true, payment: { select: { voided_at: true } } } },
        },
      });
      // The same reading rederiveRefundTotals makes: a refund on a voided payment left with it, and
      // money sent back that was never applied comes off both sides.
      const standing = money.refunds.filter((r) => !r.payment?.voided_at);
      const unappliedBack = refundedCents(standing.filter((r) => r.from_unapplied_capture));
      status = impliedMoneyStatus({
        amountDueCents,
        paidCents: paidCents(money.payments.filter((p) => p.reference_number !== DEPOSIT_CREDIT_REFERENCE)) - unappliedBack,
        refundedCents: refundedCents(standing) - unappliedBack,
        anyMoneyLanded: money.payments.length > 0,
      });
    }
    await tx.invoice.update({
      where: { id: target.id, organization_id: organizationId },
      data: { amount_due: fromCents(amountDueCents), status, paid_at: null },
    });
    raised.push({ id: target.id, invoice_number: target.invoice_number, amount: fromCents(partCents) });
  }
  return raised;
}
