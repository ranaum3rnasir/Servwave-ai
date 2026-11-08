import { Link } from 'react-router-dom';
import { Receipt, CreditCard } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { StatusBadge } from '@/components/data/status-badge';
import { SectionCard } from '@/components/jobs/overview/SectionCard';
import { PaymentFeeBreakdown } from '@/components/crm/PaymentFeeBreakdown';
import { EmptyState } from '@/components/ui/empty-state';
import { formatCurrency } from '@/lib/utils';
import { PAYMENT_METHOD_LABELS } from '@/lib/payment-methods';
import type { PaymentMethod } from '@/lib/api/organization';
import type { JobFinancials } from '@/lib/api/jobs';

interface PaymentsTabProps {
  financials: JobFinancials | undefined;
  jobId: string;
}

/** Kind badge — "Deposit" for DEPOSIT invoices, "Final" for defined non-DEPOSIT, "—" for null/undefined. */
function KindBadge({ kind }: { kind?: string | null }) {
  if (kind == null) {
    return <span className="text-[11px] text-text-secondary">—</span>;
  }
  if (kind === 'DEPOSIT') {
    return (
      <span className="inline-flex items-center rounded-full bg-sage-50 px-2 py-0.5 text-[11px] font-medium text-sage-700">
        Deposit
      </span>
    );
  }
  return (
    <span className="inline-flex items-center rounded-full bg-info/10 px-2 py-0.5 text-[11px] font-medium text-info">
      Final
    </span>
  );
}

/**
 * Human label for a payment method, from the shared map. The local map this replaced was keyed on
 * names that are not PaymentMethod enum values (a stray 'ACH', no EXTERNAL_CARD/BANK_TRANSFER), so
 * real payments in those methods fell through and rendered the raw enum - "BANK_TRANSFER" - in the
 * Method column. An unrecognised value still falls through to itself, by design.
 */
function formatMethod(method: string): string {
  return PAYMENT_METHOD_LABELS[method as PaymentMethod] ?? method;
}

export function PaymentsTab({ financials, jobId: _jobId }: PaymentsTabProps) {
  const inv = financials?.final_invoice ?? null;
  const payments = financials?.payments ?? [];

  // Every invoice on the job - its own draws plus any reached through the estimate link - minus
  // the voided ones, which are not money owed or collected and only add noise here. The card used
  // to render `final_invoice` alone, so a job whose only invoice was a DEPOSIT (the shape an
  // estimate-anchored conversion produces) showed "No invoice yet" while its paid deposit sat
  // visible in the Payment history table directly below.
  const invoices = (financials?.invoices ?? []).filter((i) => i.status !== 'VOIDED');

  // Deposit drawdown — tied to a real DEPOSIT-kind invoice (not just a payment).
  const depositInvoice = financials?.invoices?.find((i) => i.kind === 'DEPOSIT') ?? null;
  const depositPaid = payments
    .filter((p) => p.invoice_kind === 'DEPOSIT')
    .reduce((s, p) => s + Number(p.amount), 0);
  // #948 — exclude the synthetic DEPOSIT-CREDIT mirror payment a deposit's drawdown writes on
  // the STANDARD invoice: it's the same cash as the deposit's own payment, not new money.
  // Same non-cash-credit filter InvoiceDetailPage's buildLedgerEvents uses.
  const totalPaid = payments
    .filter((p) => p.reference_number !== 'DEPOSIT-CREDIT')
    .reduce((s, p) => s + Number(p.amount), 0);
  const depositBalance = depositInvoice ? Number(depositInvoice.amount_due) : 0;
  const showCollectDeposit =
    depositInvoice != null &&
    !['PAID', 'VOIDED'].includes(depositInvoice.status) &&
    depositBalance > 0;
  const contractTotal = inv ? Number(inv.total_amount) : 0;
  const pctCollected =
    contractTotal > 0 ? Math.min(Math.round((totalPaid / contractTotal) * 100), 100) : 0;

  // Show Record Payment only when the final invoice exists and still has a balance.
  const showRecordPayment =
    inv != null && !['PAID', 'VOIDED'].includes(inv.status) && Number(inv.amount_due) > 0;

  const collectDepositButton = depositInvoice ? (
    <Link to={`/invoices/${depositInvoice.id}`}>
      <Button variant="solid" tone="business" size="sm">
        <CreditCard className="mr-2 h-4 w-4" />
        Collect deposit
      </Button>
    </Link>
  ) : null;

  return (
    <div className="space-y-5 p-5">
      {/* ── Invoice ─────────────────────────────────────── */}
      <SectionCard
        title={invoices.length > 1 ? 'Invoices' : 'Invoice'}
        icon={<Receipt className="h-4 w-4 text-text-secondary" />}
        meta={
          showRecordPayment && inv ? (
            <Link to={`/invoices/${inv.id}`}>
              <Button variant="solid" tone="business" size="sm">
                <CreditCard className="mr-2 h-4 w-4" />
                Record Payment
              </Button>
            </Link>
          ) : undefined
        }
      >
        {invoices.length > 0 ? (
          <>
            <ul className="divide-y divide-border">
              {invoices.map((i) => (
                <li key={i.id} className="py-2 first:pt-0 last:pb-0">
                  <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                    <Link
                      to={`/invoices/${i.id}`}
                      className="text-base font-bold text-text-primary underline-offset-2 hover:underline"
                    >
                      {i.invoice_number}
                    </Link>
                    <KindBadge kind={i.kind} />
                    <StatusBadge domain="invoice" status={i.status} />
                    <span className="text-sm text-text-secondary">
                      Total:{' '}
                      <span className="font-semibold tabular-nums text-text-primary">
                        {formatCurrency(Number(i.total_amount))}
                      </span>
                    </span>
                    <span className="text-sm text-text-secondary">
                      Due:{' '}
                      <span className="font-semibold tabular-nums text-text-primary">
                        {formatCurrency(Number(i.amount_due))}
                      </span>
                    </span>
                  </div>
                </li>
              ))}
            </ul>

            {/* Deposit drawdown — deposit applied → remaining balance on the final invoice.
                Guarded on `inv` as well as the deposit: the bar measures collection against the
                STANDARD contract total, which a deposit-only job does not have yet. */}
            {depositInvoice && inv && (
              <div className="mt-3 rounded-xl border border-border bg-primary-subtle/30 p-3">
                <div className="flex items-center justify-between text-xs">
                  <span className="text-text-secondary">Deposit applied</span>
                  <span className="font-medium tabular-nums text-sage-700">
                    {formatCurrency(depositPaid)}
                  </span>
                </div>
                <div className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-surface-light">
                  <div
                    className="h-full rounded-full bg-sage-500"
                    style={{ width: `${pctCollected}%` }}
                  />
                </div>
                <div className="mt-1.5 flex items-center justify-between text-xs text-text-secondary">
                  <span>{pctCollected}% collected</span>
                  <span>
                    Balance{' '}
                    <span className="font-medium tabular-nums text-text-primary">
                      {formatCurrency(Number(inv.amount_due))}
                    </span>
                  </span>
                </div>
                {showCollectDeposit && <div className="mt-3">{collectDepositButton}</div>}
              </div>
            )}
            {/* Deposit still owed on a job with no STANDARD invoice: the drawdown block above is
                suppressed, so the action would otherwise have nowhere to render. */}
            {showCollectDeposit && !inv && <div className="mt-3">{collectDepositButton}</div>}
          </>
        ) : (
          <EmptyState density="compact"
            icon={Receipt}
            title="No invoice yet"
           
            description={
              showCollectDeposit
                ? `A ${formatCurrency(depositBalance)} deposit is due before this job is invoiced.`
                : undefined
            }
            action={showCollectDeposit ? collectDepositButton : undefined}
          />
        )}
      </SectionCard>

      {/* ── Payment history ─────────────────────────────── */}
      <SectionCard
        title="Payment history"
        icon={<CreditCard className="h-4 w-4 text-text-secondary" />}
        bodyClassName="p-0"
      >
        {payments.length === 0 ? (
          <EmptyState icon={CreditCard} title="No payments recorded" />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <caption className="sr-only">Payment history for this job</caption>
              <thead>
                <tr className="border-b border-border">
                  <th scope="col" className="px-5 py-3 text-left text-[11px] font-semibold uppercase tracking-widest text-text-secondary">
                    Date
                  </th>
                  <th scope="col" className="px-5 py-3 text-left text-[11px] font-semibold uppercase tracking-widest text-text-secondary">
                    Method
                  </th>
                  <th scope="col" className="px-5 py-3 text-right text-[11px] font-semibold uppercase tracking-widest text-text-secondary">
                    Amount
                  </th>
                  <th scope="col" className="px-5 py-3 text-left text-[11px] font-semibold uppercase tracking-widest text-text-secondary">
                    Invoice #
                  </th>
                  <th scope="col" className="px-5 py-3 text-left text-[11px] font-semibold uppercase tracking-widest text-text-secondary">
                    Type
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {payments.map((p) => (
                  <tr key={p.id} className="transition-colors hover:bg-background-light/30">
                    <td className="whitespace-nowrap px-5 py-3 tabular-nums text-text-primary">
                      {new Date(p.paid_at).toLocaleDateString('en-US')}
                    </td>
                    <td className="px-5 py-3 text-text-secondary">{formatMethod(p.method)}</td>
                    <td className="px-5 py-3 text-right font-semibold tabular-nums text-text-primary">
                      <div className="flex flex-col items-end gap-0.5">
                        <span>{formatCurrency(Number(p.amount))}</span>
                        <PaymentFeeBreakdown
                          amount={p.amount}
                          stripeFeeAmount={p.stripe_fee_amount}
                          platformFeeAmount={p.platform_fee_amount}
                          netAmount={p.net_amount}
                          serviceFeeAmount={p.service_fee_amount}
                          tipAmount={p.tip_amount}
                        />
                      </div>
                    </td>
                    <td className="px-5 py-3 text-text-secondary">{p.invoice_number ?? '—'}</td>
                    <td className="px-5 py-3">
                      <KindBadge kind={p.invoice_kind} />
                    </td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr className="border-t border-border">
                  <td className="px-5 py-3 text-[11px] font-semibold uppercase tracking-widest text-text-secondary">
                    Total paid
                  </td>
                  <td />
                  <td className="px-5 py-3 text-right text-sm font-bold tabular-nums text-text-primary">
                    {formatCurrency(totalPaid)}
                  </td>
                  <td colSpan={2} />
                </tr>
              </tfoot>
            </table>
          </div>
        )}
      </SectionCard>
    </div>
  );
}
