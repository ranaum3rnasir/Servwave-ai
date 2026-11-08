import { Prisma } from '@prisma/client';
// Creator tracking (audit only) - stamped at every create, never read for authorization here.
import { CREATED_BY_SYSTEM } from './created-by';

/**
 * Deposit-credit drawdown ledger (entity-redesign §6/§8, Phase 1, seam 4).
 *
 * A deposit's paid amount becomes a CREDIT that draws down across a job's STANDARD
 * invoices. Each drawdown is recorded as a `DepositCreditApplication` ledger row
 * (the internal, reversible record that prevents one deposit being credited to two
 * invoices — the central no-double-credit invariant). The credit is recorded on the
 * target invoice as a post-tax PAYMENT by the caller, NEVER as a discount/line (which
 * would wrongly shrink the taxable subtotal — tax is charged exactly once, on the
 * STANDARD invoice; the deposit invoice is non-taxable).
 *
 * The lib is invoice-id-agnostic: it operates purely on the deposit-invoice id and the
 * target-invoice id passed in. The caller (invoice.controller.create) is responsible for
 * sourcing the deposit-invoice id and recording the matching Payment on the target.
 */

/**
 * The synthetic Payment row a deposit credit is recorded as on the target invoice. Canonical
 * home (this lib's docstrings already name it); invoice.controller re-exports it because
 * estimate.controller, report.controller and job-invoicing.test.ts still import it from there.
 * job.controller imports it from here directly. statement.controller keeps a private copy,
 * deliberately untouched.
 */
export const DEPOSIT_CREDIT_REFERENCE = 'DEPOSIT-CREDIT';
const DEPOSIT_CREDIT_NOTE = 'Deposit credit applied from estimate deposit';

function toCents(n: number): number {
  return Math.round(n * 100) / 100;
}

function sumOf(agg: { _sum: { amount: Prisma.Decimal | number | null } } | null | undefined): number {
  const raw = agg?._sum?.amount;
  return raw == null ? 0 : Number(raw);
}

/**
 * remainingDepositCredit
 *   = (Σ Payment.amount on the deposit invoice, non-voided)
 *   − (Σ DepositCreditApplication.amount where deposit_invoice_id = id AND reversed_at IS NULL)
 *   − (Σ Refund.amount where invoice_id = id)
 *
 * This single subtraction is the source of the no-double-credit invariant: the sum of
 * active applications across a job's STANDARD invoices can never exceed the deposit's
 * net-paid balance, because each new application is capped by what `remaining` returns.
 * Reversal (void-payment / refund in Phase 2) sets `reversed_at`, which re-frees credit
 * through the same formula.
 */
export async function remainingDepositCredit(
  tx: Prisma.TransactionClient,
  depositInvoiceId: string,
): Promise<number> {
  const [paymentAgg, applicationAgg, refundAgg] = await Promise.all([
    tx.payment.aggregate({
      where: { invoice_id: depositInvoiceId, voided_at: null },
      _sum: { amount: true },
    }),
    tx.depositCreditApplication.aggregate({
      where: { deposit_invoice_id: depositInvoiceId, reversed_at: null },
      _sum: { amount: true },
    }),
    tx.refund.aggregate({
      where: { invoice_id: depositInvoiceId },
      _sum: { amount: true },
    }),
  ]);

  const paid = sumOf(paymentAgg);
  const applied = sumOf(applicationAgg);
  const refunded = sumOf(refundAgg);

  return toCents(paid - applied - refunded);
}

/**
 * applyDepositCredit
 *
 * Draws down min(remainingDepositCredit, targetInvoiceTotal) from the deposit invoice
 * onto the target invoice. Writes a `DepositCreditApplication` row (reversed_at = null)
 * for the applied amount and returns it. Writes NO row and returns 0 when nothing remains.
 *
 * The CALLER records the matching post-tax Payment on the target invoice (carrying
 * `reference_number = DEPOSIT_CREDIT_REFERENCE`). This function NEVER writes a discount line.
 */
export async function applyDepositCredit(
  tx: Prisma.TransactionClient,
  depositInvoiceId: string,
  targetInvoiceId: string,
  targetInvoiceTotal: number,
  orgId: string,
): Promise<number> {
  const remaining = await remainingDepositCredit(tx, depositInvoiceId);
  const applied = toCents(Math.min(remaining, targetInvoiceTotal));

  if (applied <= 0) return 0;

  await tx.depositCreditApplication.create({
    data: {
      deposit_invoice_id: depositInvoiceId,
      target_invoice_id: targetInvoiceId,
      amount: applied,
      organization_id: orgId,
    },
  });

  return applied;
}

/**
 * ─── SRVW-85: the multi-deposit drawdown, in exactly ONE place ───
 *
 * Both invoice doors (POST /api/invoices {job_id} and POST /api/jobs/:id/invoices) draw the
 * same credit from the same estimates, so the clamp lives here rather than being written twice.
 * Lifted verbatim from job.controller.createInvoiceFromJob, which is where it was proved.
 */

/**
 * The PAID kind=DEPOSIT invoices for a set of estimate ids, in a deterministic drawdown order.
 * Returns [] WITHOUT querying when the set is empty - callers on the no-estimate path must not
 * need an `invoice.findMany` on their transaction surface.
 */
export async function resolvePaidDepositInvoices(
  tx: Prisma.TransactionClient,
  estimateIds: string[],
  organizationId: string,
): Promise<{ id: string }[]> {
  if (estimateIds.length === 0) return [];
  return tx.invoice.findMany({
    where: { estimate_id: { in: estimateIds }, kind: 'DEPOSIT', status: 'PAID', organization_id: organizationId },
    select: { id: true },
    orderBy: { created_at: 'asc' },
  });
}

/**
 * PASS 1 (read-only): the invoice's deposit_credit. Each deposit contributes its own unapplied
 * credit; a DECREASING `room` is the ceiling for the cumulative credit, so two deposits cannot
 * each draw up to the full total and over-credit the invoice past what it is worth. `room`
 * starts at the TAX-INCLUSIVE total - the amount the customer actually owes.
 */
export async function computeDepositCredit(
  tx: Prisma.TransactionClient,
  depositInvoices: { id: string }[],
  invoiceTotal: number,
): Promise<number> {
  let depositCredit = 0;
  let room = invoiceTotal;
  for (const dep of depositInvoices) {
    if (room <= 0) break;
    const remaining = await remainingDepositCredit(tx, dep.id);
    const draw = toCents(Math.min(Math.max(remaining, 0), room));
    depositCredit = toCents(depositCredit + draw);
    room = toCents(room - draw);
  }
  return depositCredit;
}

/**
 * PASS 2 (post-create): ONE DepositCreditApplication ledger row + ONE post-tax Payment per
 * deposit that draws > 0. Pass 1 was read-only, so each applyDepositCredit re-reads the SAME
 * per-deposit `remaining` and, under the SAME decreasing-room clamp, applies exactly the amounts
 * pass 1 summed. Passing `applyRoom` (NOT the full invoiceTotal) as the per-deposit cap is what
 * stops a later deposit re-drawing room an earlier one already spent.
 */
export async function applyDepositCreditsWithPayments(
  tx: Prisma.TransactionClient,
  depositInvoices: { id: string }[],
  targetInvoiceId: string,
  invoiceTotal: number,
  organizationId: string,
): Promise<void> {
  let applyRoom = invoiceTotal;
  for (const dep of depositInvoices) {
    if (applyRoom <= 0) break;
    const applied = await applyDepositCredit(tx, dep.id, targetInvoiceId, applyRoom, organizationId);
    if (applied > 0) {
      applyRoom = toCents(applyRoom - applied);
      // Post-tax Payment, NEVER a discount line - the deposit invoice's own Payment carries the
      // real payment method; this one is tagged for refundInvoice's reference_number filter.
      await tx.payment.create({
        data: {
          invoice_id: targetInvoiceId,
          amount: applied,
          method: 'CARD',
          paid_at: new Date(),
          collected_by: null,
          reference_number: DEPOSIT_CREDIT_REFERENCE,
          notes: DEPOSIT_CREDIT_NOTE,
          // Audit: a synthetic ledger row the platform mints so an already-paid deposit shows on
          // the target invoice. No user chose it and no customer paid it - the real money moved on
          // the deposit invoice's own Payment, which carries its own creator.
          ...CREATED_BY_SYSTEM,
        },
      });
    }
  }
}

/**
 * ─── SRVW-85: which estimates a job draws deposits from, in exactly ONE place ───
 *
 * Both doors load the same shapes (job.estimate = the 1:1 provenance estimate, job.linked_estimates
 * = EstimateJobLink attachments) and previously spelled out the same union rule independently.
 * Centralised here so a future change to it (a third anchor type, a status filter) cannot land in
 * one door without the other. E5 (job-owns-tax-discount) retired this file's tax-pricing role
 * (taxSourceEstimate) - tax_rate/discount_* live on the job itself now.
 */

/** The deduped set of estimate ids a job's deposit credit draws from: every linked estimate UNION
 * the 1:1 provenance estimate. */
export function depositEstimateIds(job: {
  estimate?: { id: string } | null;
  linked_estimates: { id: string }[];
}): string[] {
  return [...new Set([
    ...job.linked_estimates.map((e) => e.id),
    ...(job.estimate ? [job.estimate.id] : []),
  ])];
}
