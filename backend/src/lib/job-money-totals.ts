import { DEPOSIT_CREDIT_REFERENCE } from './deposit-credit';
import { fromCents, paidCents, toCents } from './payment-ledger';

/**
 * The job's own money figures - the contract, what has been paid, the deposit, what is still clearing and what is still
 * owed - worked out over EVERY invoice on the job, whichever of them the person looking can open. They are the job's
 * totals and balance, which anyone who can open the job sees (Roles & Permissions, PRD 4); the invoices behind them are
 * listed separately and only when the person can open them.
 *
 * This is the ONE place that says what a job owes. The job page's Balance card, the Ready to close banner, the review
 * panel's Balance and Mark Done's check (with the amount an owner must confirm) all read `balance_due` from here, through
 * `readJobMoneyOwed` (lib/job-money-owed) or the financials answer, so they cannot disagree.
 *
 * THE RULE, in a sentence a person can check: a job owes the larger of what its live invoices still have due, each counted
 * on its own, and what it was sold for less what was paid. So adding an invoice, drafted, sent or paid and whatever its
 * amount, never lowers what a job owes: the work not yet invoiced stays owed (Ran 4 Oct, Q42), and an invoice only adds
 * its own due or takes a payment off.
 *
 *  - An invoice's due is the smaller of the balance the invoice itself carries (it nets payments, an applied deposit and
 *    credit notes) and its total less the payments counted on it, never below zero. An overpaid invoice does not offset
 *    an underpaid one: money is owed while any invoice has a balance due.
 *  - Only STANDARD invoices that are not voided count. A deposit is part of the same contract, not money on top: an
 *    unpaid deposit invoice adds nothing, and deposit money paid but not yet drawn on an invoice comes off what is due.
 *  - What the job was sold for is the estimate it came from, else its live attached estimates, else its own priced lines.
 *    The contract shown is the larger of that and the invoices' total.
 *  - Refunds are not subtracted from what was paid, as the Balance card has always read it.
 *
 * A service plan's visit job is billed upfront, so it is never owed. A job whose contract is zero is never owed.
 */
export interface JobMoneyTotals {
  /** What the balance is measured against: what the job was sold for or what is invoiced, whichever is larger; null with neither. */
  contract_total: number | null;
  /** Money that landed, applied deposit credit aside (it is the same cash as the deposit's own payment). */
  paid: number;
  /** Money that landed on deposit invoices. */
  deposit_paid: number;
  /** Bank money still clearing across the job's live invoices. Never part of paid. */
  processing: number;
  /** What is still owed on the job, in dollars; zero when nothing is. */
  balance_due: number;
}

type Amount = Parameters<typeof paidCents>[0][number]['amount'];

export interface JobMoneyInvoice {
  kind: string;
  status: string;
  voided_at?: Date | string | null;
  /** The invoice's total, and the balance it carries (payments, applied deposit and credit notes already netted). */
  total_amount: Amount;
  amount_due: Amount;
  payments: Array<{ amount: Amount; state?: string; reference_number: string | null }>;
}

/** Estimate statuses that are not a live contract: an attached estimate in one of them adds nothing to the job. */
const DEAD_ESTIMATE_STATUSES = ['DECLINED', 'EXPIRED', 'ARCHIVED', 'SUPERSEDED'];

const isLive = (inv: JobMoneyInvoice) => inv.status !== 'VOIDED' && !inv.voided_at;
const isLanded = (p: { state?: string }) => (p.state ?? 'SUCCEEDED') === 'SUCCEEDED';

export async function jobMoneyTotals(input: {
  invoices: readonly JobMoneyInvoice[];
  /** The job's own (provenance) estimate total, when it has one. */
  estimateTotal: Amount | null;
  /** The estimates attached to the job beside its own, with their status and total. */
  attachedEstimates: ReadonlyArray<{ status: string; total_amount: Amount | null }>;
  /** The job's own total from its lines and scopes; asked only when no estimate says what the job was sold for. */
  ownTotal: () => Promise<Amount>;
  /** A service plan's visit job: billed upfront through the plan, so never owed. */
  billedUpfront?: boolean;
}): Promise<JobMoneyTotals> {
  const landed = input.invoices.flatMap((inv) => inv.payments.filter(isLanded).map((p) => ({ ...p, kind: inv.kind })));
  const cash = landed.filter((p) => p.reference_number !== DEPOSIT_CREDIT_REFERENCE);
  const processing = input.invoices.filter(isLive).flatMap((inv) => inv.payments.filter((p) => p.state === 'PROCESSING'));
  const paid = paidCents(cash);
  const depositHeld = paidCents(cash.filter((p) => p.kind === 'DEPOSIT'));

  const standard = input.invoices.filter((inv) => inv.kind === 'STANDARD' && isLive(inv));
  // What one invoice still has due: the balance it carries, held down to its total less what is counted on it.
  const dueCents = (inv: JobMoneyInvoice) =>
    Math.max(Math.min(toCents(inv.amount_due), toCents(inv.total_amount) - paidCents(inv.payments.filter(isLanded))), 0);
  // A deposit paid but not yet drawn on a live invoice is money the invoices have not netted yet.
  const drawn = paidCents(standard.flatMap((inv) => inv.payments.filter((p) => isLanded(p) && p.reference_number === DEPOSIT_CREDIT_REFERENCE)));
  const undrawnDeposit = Math.max(depositHeld - drawn, 0);
  const invoicesDue = Math.max(standard.reduce((sum, inv) => sum + dueCents(inv), 0) - undrawnDeposit, 0);

  // What the job was sold for: the estimate it came from, else its live attached estimates, else its own priced lines.
  const liveAttached = input.attachedEstimates.filter((e) => !DEAD_ESTIMATE_STATUSES.includes(e.status));
  let sold: number | null = null;
  if (input.estimateTotal != null) sold = toCents(input.estimateTotal);
  else if (liveAttached.length) sold = liveAttached.reduce((sum, e) => sum + toCents(e.total_amount ?? 0), 0);
  else {
    const own = toCents(await input.ownTotal());
    sold = own > 0 ? own : null;
  }
  // The work not yet invoiced is owed whatever is invoiced: an invoice is a claim on part of the job, never a reason for
  // the rest of it to stop being owed. So the job owes the larger of what its invoices have due and the sale less what
  // was paid.
  const owed = Math.max(invoicesDue, (sold ?? 0) - paid, 0);
  const invoicedTotal = standard.reduce((sum, inv) => sum + toCents(inv.total_amount), 0);
  const contract = sold === null && standard.length === 0 ? null : Math.max(sold ?? 0, invoicedTotal);

  return {
    contract_total: contract === null ? null : fromCents(contract),
    paid: fromCents(paid),
    deposit_paid: fromCents(depositHeld),
    processing: fromCents(paidCents(processing)),
    balance_due: input.billedUpfront ? 0 : fromCents(owed),
  };
}
