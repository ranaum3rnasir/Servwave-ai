/**
 * Payments go-live slice 15 (from the slice 14 review): void the deposit invoices of closing
 * estimates that hold no money, decided under each deposit's lock.
 *
 * Every door that closes an estimate or its lead (estimate cancel, either decline, lead lost or
 * cancelled, and the waive door's waive and cancel) voids the estimate's unpaid deposit. "Unpaid" is a DRAFT or SENT deposit with no money
 * taken on it: no live SUCCEEDED or PROCESSING payment (a bank payment still clearing leaves the
 * deposit SENT, and it is money on its way). A deposit with money on it is never voided; its money
 * goes back by refund.
 *
 * The deposits are locked first (the lock every payment door takes) and judged under it, so a
 * payment being booked at this moment commits first and the deposit is then seen holding it,
 * never voided under it. Runs inside the caller's transaction. Returns the deposits it voided,
 * with the status each had, for the caller's history row and its post-commit link sweep.
 */
import type { Prisma, InvoiceStatus } from '@prisma/client';
import { lockDepositInvoicesForEstimates } from '../deposit-credit';
import { MONEY_TAKEN_PAYMENT_WHERE } from '../payment-ledger';

export interface VoidedDeposit {
  id: string;
  invoice_number: string;
  /** The status the deposit had before it was voided. */
  status: InvoiceStatus;
}

export async function voidUnpaidDeposits(
  tx: Prisma.TransactionClient,
  input: { organizationId: string; estimateIds: string[]; reason: string | null },
): Promise<VoidedDeposit[]> {
  const { organizationId, estimateIds, reason } = input;
  if (estimateIds.length === 0) return [];
  await lockDepositInvoicesForEstimates(tx, estimateIds, organizationId);
  const unpaid = await tx.invoice.findMany({
    where: {
      organization_id: organizationId,
      estimate_id: { in: estimateIds },
      kind: 'DEPOSIT',
      status: { in: ['DRAFT', 'SENT'] },
      payments: { none: MONEY_TAKEN_PAYMENT_WHERE },
    },
    select: { id: true, invoice_number: true, status: true },
  });
  if (unpaid.length === 0) return [];
  await tx.invoice.updateMany({
    where: { id: { in: unpaid.map((d) => d.id) }, organization_id: organizationId },
    data: { status: 'VOIDED', voided_at: new Date(), ...(reason ? { voided_reason: reason } : {}) },
  });
  return unpaid;
}
