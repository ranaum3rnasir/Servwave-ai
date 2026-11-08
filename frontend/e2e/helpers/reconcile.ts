import { expect } from '@playwright/test';
import { ApiClient } from './api-client';

const r2 = (n: number) => Math.round(n * 100) / 100;

/**
 * Invoice ledger invariant (§3.1) — verified empirically against the live backend:
 *   amount_due == max(0, round(total_amount − Σ non-voided payments − Σ applied credits))
 *
 * Real semantics of THIS codebase (confirmed by the running system):
 *  - A REFUND does NOT re-open amount_due (it is money-out tracked in total_refunded /
 *    refunds[]; the invoice stays "paid"). Refunds are NOT in the amount_due formula.
 *  - amount_due is CLAMPED at 0 (an overpayment shows 0, not negative; a credit beyond the
 *    balance applies only up to the balance, the rest becomes a refund).
 *  - The deposit drawdown is a synthetic DEPOSIT-CREDIT entry in payments[] (not credits[]).
 *  - A voided payment (voided_at set) is excluded from the paid sum (so a void reopens the balance).
 */
export async function assertInvoiceReconciles(api: ApiClient, invoiceId: string, label = '') {
  const inv = await api.getInvoice(invoiceId);
  const payments: any[] = inv.payments ?? [];
  const refunds: any[] = inv.refunds ?? [];
  const credits: any[] = inv.credits ?? [];

  const paid = payments.filter((p) => !p.voided_at).reduce((s, p) => s + Number(p.amount), 0);
  const credited = credits.reduce((s, x) => s + Number(x.amount), 0);

  const expected = Math.max(0, r2(Number(inv.total_amount) - paid - credited));
  expect(r2(Number(inv.amount_due)), `reconcile(amount_due) ${label} invoice ${invoiceId}`).toBe(expected);

  // "Nothing lost": the invoice's headline total_refunded must equal the sum of its refund rows
  // (refunds don't change amount_due, but they must not vanish from the ledger).
  if (inv.total_refunded != null && refunds.length) {
    const refunded = refunds.reduce((s, x) => s + Number(x.amount), 0);
    expect(r2(Number(inv.total_refunded)), `reconcile(total_refunded) ${label} invoice ${invoiceId}`).toBe(r2(refunded));
  }
  return inv;
}

/**
 * Statement invariant (§3.1): the headline balance equals the final running balance.
 *
 * Field names verified against statement.controller.ts:
 *   response = { scope, job|customer, lines[], totals }
 *   each line has `running_balance` (NOT `balance`); the headline lives at `totals.balance`
 *   (NOT a top-level `body.balance`). buildStatement guarantees
 *   totals.balance == billed − paid − credited + refunded, and the last line's running_balance
 *   equals that same total.
 */
export async function assertStatementReconciles(
  api: ApiClient, scope: { jobId?: string; customerId?: string }, label = '',
) {
  const { body } = scope.jobId
    ? await api.getJobStatement(scope.jobId)
    : await api.getCustomerStatement(scope.customerId!);
  const lines: any[] = body.lines ?? [];
  const headlineBalance = Number(body.totals?.balance ?? body.balance ?? 0);
  const last = lines[lines.length - 1];
  // Only meaningful when there is at least one ledger event; an empty statement has balance 0.
  if (last) {
    expect(r2(headlineBalance), `statement ${label}`).toBe(r2(Number(last.running_balance)));
  } else {
    expect(r2(headlineBalance), `statement ${label} (empty)`).toBe(0);
  }
  return body;
}
