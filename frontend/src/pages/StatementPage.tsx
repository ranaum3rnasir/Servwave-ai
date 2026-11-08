import { useParams, useLocation } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { Breadcrumb } from '@/components/ui/breadcrumb';
import { Heading } from '@/components/ui/heading';
import type { BreadcrumbItem } from '@/components/ui/breadcrumb';
import { EmptyState } from '@/components/ui/empty-state';
import { Download, FileText, Receipt, Users } from 'lucide-react';
import { formatCurrency } from '@/lib/utils';
import { getJobStatement, getCustomerStatement } from '@/lib/api/statements';
import type { Statement, StatementLine } from '@/types/entities';

// ─── Line-type presentation ─────────────────────────
// Lines are loosely typed by design (backend builds synthetic deposit_credit rows).
// Map each known type to a label; unknown types fall back to a neutral label.
const LINE_LABELS: Record<string, string> = {
  invoice: 'Invoice',
  credit: 'Credit',
  deposit_credit: 'Deposit credit',
  payment: 'Payment',
  refund: 'Refund',
};

// Charges that REDUCE the balance (shown as a negative magnitude in the Amount column).
const NEGATIVE_TYPES = new Set(['payment', 'credit', 'deposit_credit']);

function lineLabel(line: StatementLine): string {
  return LINE_LABELS[line.type] ?? 'Adjustment';
}

function formatDate(date: string | null): string {
  if (!date) return '—';
  const d = new Date(date);
  return Number.isNaN(d.getTime()) ? '—' : d.toLocaleDateString('en-US');
}

// Signed amount: invoices/refunds add to the balance, payments/credits reduce it.
function signedAmount(line: StatementLine): string {
  const magnitude = formatCurrency(Number(line.amount ?? 0));
  return NEGATIVE_TYPES.has(line.type) ? `−${magnitude}` : magnitude;
}

// ─── Member display (customer-scope billing group) ──
function memberName(m: NonNullable<Statement['members']>[number]): string {
  const name = [m.first_name, m.last_name].filter(Boolean).join(' ').trim();
  if (name) return name;
  return m.company_name || 'Customer';
}

// ─── Page ────────────────────────────────────────────

export default function StatementPage() {
  const params = useParams<{ jobId?: string; customerId?: string }>();
  const location = useLocation();
  const incomingBreadcrumbs: BreadcrumbItem[] | undefined = location.state?.breadcrumbs;

  const scope: 'job' | 'customer' = params.jobId ? 'job' : 'customer';
  const entityId = params.jobId ?? params.customerId ?? '';

  const { data: statement, isLoading, error } = useQuery({
    queryKey: ['statement', scope, entityId],
    queryFn: () =>
      scope === 'job' ? getJobStatement(params.jobId!) : getCustomerStatement(params.customerId!),
    enabled: Boolean(entityId),
  });

  const handleDownloadPdf = async () => {
    const blob =
      scope === 'job'
        ? await getJobStatement(params.jobId!, { format: 'pdf' })
        : await getCustomerStatement(params.customerId!, { format: 'pdf' });
    const url = URL.createObjectURL(blob);
    window.open(url, '_blank', 'noopener');
    // Revoke after a tick so the new tab has time to load the resource.
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  };

  const crumbs: BreadcrumbItem[] = [
    ...(incomingBreadcrumbs ?? [
      scope === 'job'
        ? { label: 'Jobs', href: '/jobs' }
        : { label: 'Customers', href: '/customers' },
    ]),
    { label: 'Statement' },
  ];

  // ─── Loading ──────────────────────────────────────
  if (isLoading) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-4 w-48" />
        <Card className="space-y-3">
          <Skeleton className="h-7 w-40" />
          <Skeleton className="h-4 w-64" />
        </Card>
        <Card className="space-y-2">
          {Array.from({ length: 5 }).map((_, i) => (
            <Skeleton key={i} className="h-5 w-full" />
          ))}
        </Card>
      </div>
    );
  }

  // ─── Error / forbidden ────────────────────────────
  if (error || !statement) {
    return (
      <div className="space-y-4">
        <Breadcrumb items={crumbs} />
        <Card padding="lg" className="text-center">
          <FileText className="h-10 w-10 text-text-secondary/30 mx-auto mb-3" />
          <p className="text-sm text-text-secondary">
            This statement is unavailable or you do not have access to it.
          </p>
        </Card>
      </div>
    );
  }

  const lines: StatementLine[] = statement.lines ?? [];
  const totals = statement.totals ?? {
    billed: 0,
    paid: 0,
    refunded: 0,
    credited: 0,
    balance: 0,
  };
  const members = statement.members ?? [];

  const heroTitle =
    scope === 'job' ? 'Job Statement' : 'Customer Statement';

  return (
    <div className="space-y-4" data-testid="statement-page">
      <Breadcrumb items={crumbs} />

      {/* Hero */}
      <Card>
        <div className="flex items-start justify-between gap-4">
          <div>
            <Heading level={1} className="flex items-center gap-2"><Receipt className="h-5 w-5 shrink-0 text-primary" />{heroTitle}</Heading>
            <p className="text-sm text-text-secondary mt-1">
              Running ledger of invoices, payments, credits and refunds.
            </p>
            {scope === 'customer' && members.length > 0 && (
              <div className="mt-3 flex items-start gap-2 text-sm text-text-secondary">
                <Users className="h-4 w-4 mt-0.5 shrink-0" />
                <div>
                  <span className="font-medium text-text-primary">Billing group: </span>
                  {members.map((m) => memberName(m)).join(', ')}
                </div>
              </div>
            )}
          </div>
          <Button variant="outline" size="sm" onClick={handleDownloadPdf}>
            <Download className="mr-2 h-4 w-4" />
            Download PDF
          </Button>
        </div>
      </Card>

      {/* Ledger */}
      <Card padding="none" className="overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border text-left text-xs font-semibold uppercase tracking-wide text-text-secondary">
                <th className="px-5 py-3">Date</th>
                <th className="px-5 py-3">Description</th>
                <th className="px-5 py-3 text-right">Amount</th>
                <th className="px-5 py-3 text-right">Running Balance</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {lines.length === 0 ? (
                <tr>
                  <td colSpan={4} className="px-5 py-8 text-center text-text-secondary">
                    <EmptyState title="No activity yet." />
                  </td>
                </tr>
              ) : (
                lines.map((line, i) => (
                  <tr key={`${line.invoice_id ?? 'row'}-${i}`} className="hover:bg-background-light/40">
                    <td className="px-5 py-3 tabular-nums text-text-secondary whitespace-nowrap">
                      {formatDate(line.date)}
                    </td>
                    <td className="px-5 py-3">
                      <span className="font-medium text-text-primary">{lineLabel(line)}</span>
                      {line.invoice_number && (
                        <span className="text-text-secondary"> · {line.invoice_number}</span>
                      )}
                      {scope === 'customer' && line.customer_name && (
                        <span className="text-text-secondary"> · {line.customer_name}</span>
                      )}
                    </td>
                    <td className="px-5 py-3 text-right tabular-nums">{signedAmount(line)}</td>
                    <td className="px-5 py-3 text-right tabular-nums font-medium text-text-primary">
                      {formatCurrency(Number(line.running_balance ?? 0))}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>

        {/* Totals summary */}
        <div className="border-t border-border flex flex-wrap divide-x divide-border">
          {[
            { label: 'Billed', value: totals.billed },
            { label: 'Paid', value: totals.paid },
            // Deposit credit drawn down onto job invoices — shown only when present so the strip
            // reconciles (Balance = Billed − Paid − Deposit credit − Credited + Refunded) and matches
            // the PDF; hidden on cash-only statements to avoid a $0.00 column.
            ...(Number(totals.deposit_credit ?? 0) !== 0
              ? [{ label: 'Deposit credit', value: Number(totals.deposit_credit) }]
              : []),
            { label: 'Refunded', value: totals.refunded },
            { label: 'Credited', value: totals.credited },
          ].map(({ label, value }) => (
            <div key={label} className="flex-1 min-w-[140px] px-5 py-4">
              <p className="text-[10px] font-semibold uppercase tracking-widest text-text-secondary">
                {label}
              </p>
              <p className="text-lg font-semibold tabular-nums text-text-primary mt-0.5">
                {formatCurrency(Number(value ?? 0))}
              </p>
            </div>
          ))}
          <div className="flex-1 min-w-[140px] px-5 py-4 bg-background-light/40">
            <p className="text-[10px] font-semibold uppercase tracking-widest text-text-secondary">
              Balance
            </p>
            <p data-testid="statement-running-balance" className="text-xl font-bold tabular-nums text-text-primary mt-0.5">
              {formatCurrency(Number(totals.balance ?? 0))}
            </p>
          </div>
        </div>
      </Card>
    </div>
  );
}
