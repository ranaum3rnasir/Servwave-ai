import { Prisma } from '@prisma/client';
import { prisma } from './prisma';
import { jobMoneyTotals } from './job-money-totals';
import { computeJobBilling } from './jobBilling';
import { asScopeArray, toScopeForTotals } from './scopes';
import { COUNTED_PAYMENT_WHERE, toCents } from './payment-ledger';

/**
 * Money owed on a job (Roles & Permissions, PRD 6, S06.13), the fact Mark Done reads. It is the figure the job page's
 * Balance card shows, and it is worked out in one place: `jobMoneyTotals` (lib/job-money-totals) holds the rule and says
 * it in a sentence. This file only reads what the rule needs, in one read of the job and one of its invoices with their
 * payments, over every invoice on the job whichever of them the person looking can open:
 *
 *  - the invoices are the ones on the job, those made from the estimate it came from and those made from an attached
 *    estimate;
 *  - the money paid is the payment ledger's own count: the payments `COUNTED_PAYMENT_WHERE` selects (succeeded, not
 *    voided), so a bank debit still clearing and a failed payment are never money paid;
 *  - the job's own total (its lines and scopes, tax and discount, worked out by `computeJobBilling` as the Items tab does)
 *    is what the job was sold for only when nothing was sold from an estimate; whichever way it was sold, the work not yet
 *    invoiced stays owed beside the invoices.
 *
 * A service plan's visit job is billed upfront and is non-billable, so it is never owed and its total reads as zero.
 * Amounts are whole cents.
 *
 * The same pass answers "is this job's total zero?" (the contract, S06.21): the progress bar never calls a money step
 * skipped on such a job, and this is the one place that says what a job's total is.
 */
export interface JobMoneyOwed {
  /** What is owed now, in whole cents; zero when nothing is. */
  owedCents: number;
  /** The job's total the balance is measured against, in whole cents; zero for a job with no price and for a service plan's visit job. */
  contractCents: number;
}

type Db = Prisma.TransactionClient | typeof prisma;

/**
 * The invoices a job's money is worked out over: the ones on the job, those made from the estimate it came from, and
 * those made from an estimate attached to it (GET /api/jobs/:id/financials asks the same question).
 */
function jobInvoiceFilter(
  orgId: string,
  jobId: string,
  job: { estimate_id: string | null; linked_estimates: Array<{ id: string }> },
): Prisma.InvoiceWhereInput {
  const or: Prisma.InvoiceWhereInput[] = [{ job_id: jobId }];
  if (job.estimate_id) or.push({ estimate_id: job.estimate_id });
  const linked = job.linked_estimates.map((e) => e.id).filter((id) => id !== job.estimate_id);
  if (linked.length) or.push({ estimate_id: { in: linked } });
  return { organization_id: orgId, OR: or };
}

export { jobsHoldingInvoice } from './job-invoice-holders';

/**
 * Take the job's invoices, in id order, so a payment landing on one of them waits for this transaction (and this one
 * waits for a payment already landing): every money writer locks its invoice first (lib/payment-ledger).
 */
export async function lockJobInvoices(tx: Prisma.TransactionClient, orgId: string, jobId: string): Promise<void> {
  const job = await tx.job.findFirst({
    where: { id: jobId, organization_id: orgId },
    select: { estimate_id: true, linked_estimates: { select: { id: true } } },
  });
  if (!job) return;
  const ids = (await tx.invoice.findMany({ where: jobInvoiceFilter(orgId, jobId, job), select: { id: true }, orderBy: { id: 'asc' } })).map((i) => i.id);
  if (ids.length === 0) return;
  await tx.$executeRaw`SELECT id FROM invoices WHERE id = ANY(${ids}::uuid[]) AND organization_id = ${orgId}::uuid ORDER BY id FOR UPDATE`;
}

/** What the job's own total is worked out from. */
const OWN_TOTAL_SELECT = {
  tax_rate: true,
  discount_amount: true,
  scopes: true,
  customer: { select: { tax_exempt: true } },
  job_line_items: { select: { quantity: true, unit_price: true, is_taxable: true } },
} satisfies Prisma.JobSelect;

type OwnTotalJob = Prisma.JobGetPayload<{ select: typeof OWN_TOTAL_SELECT }>;

/** The job's own total: its lines and scopes, tax and discount, worked out by `computeJobBilling` as the Items tab does. */
function ownTotalOf(job: OwnTotalJob): number {
  return computeJobBilling({
    lines: job.job_line_items.map((l) => ({ quantity: Number(l.quantity), unit_price: Number(l.unit_price), is_taxable: l.is_taxable })),
    scopes: toScopeForTotals(asScopeArray(job.scopes)),
    taxRate: Number(job.tax_rate),
    taxExempt: job.customer.tax_exempt,
    discountAmount: Number(job.discount_amount),
    invoices: [],
  }).total;
}

/** The same total for a caller that holds no job row (the financials answer asks it only when nothing else says what the job was sold for). */
export async function readJobOwnTotal(args: { orgId: string; jobId: string; db?: Db }): Promise<number> {
  const job = await (args.db ?? prisma).job.findFirst({ where: { id: args.jobId, organization_id: args.orgId }, select: OWN_TOTAL_SELECT });
  return job ? ownTotalOf(job) : 0;
}

/** The invoice fields `jobMoneyTotals` reads, for every caller that selects the job's invoices. */
export const JOB_MONEY_INVOICE_SELECT = {
  kind: true, status: true, total_amount: true, amount_due: true, voided_at: true,
  payments: { where: COUNTED_PAYMENT_WHERE, select: { amount: true, state: true, reference_number: true } },
} satisfies Prisma.InvoiceSelect;

export async function readJobMoneyOwed(args: { orgId: string; jobId: string; db?: Db }): Promise<JobMoneyOwed> {
  const { orgId, jobId } = args;
  const db = args.db ?? prisma;
  const job = await db.job.findFirst({
    where: { id: jobId, organization_id: orgId },
    select: {
      ...OWN_TOTAL_SELECT,
      source_plan_id: true,
      estimate: { select: { total_amount: true } },
      estimate_id: true,
      linked_estimates: { select: { id: true, status: true, total_amount: true } },
    },
  });
  if (!job || job.source_plan_id) return { owedCents: 0, contractCents: 0 };

  const invoices = await db.invoice.findMany({ where: jobInvoiceFilter(orgId, jobId, job), select: JOB_MONEY_INVOICE_SELECT });
  const totals = await jobMoneyTotals({
    invoices,
    estimateTotal: job.estimate?.total_amount ?? null,
    attachedEstimates: job.linked_estimates.filter((e) => e.id !== job.estimate_id),
    ownTotal: async () => ownTotalOf(job),
  });
  return { owedCents: toCents(totals.balance_due), contractCents: toCents(totals.contract_total ?? 0) };
}
