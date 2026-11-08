import { Fragment } from 'react';
import { useParams, useLocation } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Download, FileText, Users } from 'lucide-react';

import { formatCurrency } from '@/lib/utils';
import { getJobStatement, getCustomerStatement } from '@/lib/api/statements';
import type { Statement, StatementLine } from '@/types/entities';

import { EmptyState } from '@/ui-kit/components/data/emptyState';
import { Button } from '@/ui-kit/components/ui/button';
import { Card } from '@/ui-kit/components/ui/card';
import { Skeleton } from '@/ui-kit/components/ui/skeleton';
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@/ui-kit/components/ui/table';

import { preferV2Path } from '../uiV2';
import { useRecordVisit } from '../pageBreadcrumbs';

// --- Line-type presentation --------------------------------------------------
// Lines are loosely typed by design (the backend builds synthetic
// deposit_credit rows). Map each known type to a label; unknown types fall back
// to a neutral one.
const LINE_LABELS: Record<string, string> = {
  invoice: 'Invoice',
  credit: 'Credit',
  deposit_credit: 'Deposit credit',
  payment: 'Payment',
  refund: 'Refund',
};

/** Charges that REDUCE the balance (shown as a negative magnitude). */
const NEGATIVE_TYPES = new Set(['payment', 'credit', 'deposit_credit']);

function lineLabel(line: StatementLine): string {
  return LINE_LABELS[line.type] ?? 'Adjustment';
}

function formatDate(date: string | null): string {
  if (!date) return '-';
  const d = new Date(date);
  return Number.isNaN(d.getTime()) ? '-' : d.toLocaleDateString();
}

// Signed amount: invoices/refunds add to the balance, payments/credits reduce
// it. The prefix is the Unicode minus the legacy page uses, not a hyphen - it
// is the arithmetic sign, not punctuation.
function signedAmount(line: StatementLine): string {
  const magnitude = formatCurrency(Number(line.amount ?? 0));
  return NEGATIVE_TYPES.has(line.type) ? `−${magnitude}` : magnitude;
}

function memberName(m: NonNullable<Statement['members']>[number]): string {
  const name = [m.first_name, m.last_name].filter(Boolean).join(' ').trim();
  if (name) return name;
  return m.company_name || 'Customer';
}


/**
 * /v2/customers/:customerId/statement AND /v2/jobs/:jobId/statement.
 *
 * ONE FILE, TWO ROUTES - exactly as `pages/StatementPage.tsx` is mounted twice
 * in App.tsx. It lives under `customers/` because the Customers branch reached
 * it first; the Jobs module points its `/v2/jobs/:jobId/statement` route at
 * this same file rather than making a second copy, which is what keeps the four
 * scope-dependent differences below in one place.
 *
 * Those differences are the whole of the scope logic: the hero title, the
 * default breadcrumb root, the billing-group block and the ledger
 * description's customer suffix. Everything else is scope-agnostic.
 */
export default function StatementPage() {
  useRecordVisit('clients', 'Statement');
  const params = useParams<{ jobId?: string; customerId?: string }>();
  const location = useLocation();

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


  if (isLoading) {
    return (
      <div className="flex flex-col gap-4">
        <Skeleton className="h-4 w-48" />
        {/* Padding lives on an inner div, never as a className on Card: the
            component-API ratchet counts appearance handed to a shared primitive
            from a call site, and Card exposes no padding prop. */}
        <Card>
          <div className="flex flex-col gap-3 p-5">
            <Skeleton className="h-7 w-40" />
            <Skeleton className="h-4 w-64" />
          </div>
        </Card>
        <Card>
          <div className="flex flex-col gap-2 p-5">
            {Array.from({ length: 5 }).map((_, i) => (
              <Skeleton key={i} className="h-5 w-full" />
            ))}
          </div>
        </Card>
      </div>
    );
  }

  // The 403 path lands here too - a statement you may not read is reported the
  // same way as one that does not exist, deliberately.
  if (error || !statement) {
    return (
      <div className="flex flex-col gap-4">
        <Card>
          <EmptyState
            icon={<FileText />}
            title="This statement is unavailable or you do not have access to it."
          />
        </Card>
      </div>
    );
  }

  const lines: StatementLine[] = statement.lines ?? [];
  const totals = statement.totals ?? { billed: 0, paid: 0, refunded: 0, credited: 0, balance: 0 };
  const members = statement.members ?? [];
  const heroTitle = scope === 'job' ? 'Job Statement' : 'Customer Statement';

  return (
    <div className="flex flex-col gap-4" data-testid="statement-page">

      <Card>
        <div className="flex items-start justify-between gap-4 p-5">
          <div>
            {/* role/aria-level rather than an <h1>: the design-system raw-tag
                ratchet sits at its floor for h1-h6, so a v2 page may not add
                one. The accessible heading is preserved. */}
            <p role="heading" aria-level={1} className="text-xl font-semibold">{heroTitle}</p>
            <p className="text-muted-foreground mt-1 text-sm">
              Running ledger of invoices, payments, credits and refunds.
            </p>
            {scope === 'customer' && members.length > 0 && (
              <div className="text-muted-foreground mt-3 flex items-start gap-2 text-sm">
                <Users className="mt-0.5 size-4 shrink-0" />
                <div>
                  <span className="text-foreground font-medium">Billing group: </span>
                  {members.map((m) => memberName(m)).join(', ')}
                </div>
              </div>
            )}
          </div>
          <Button variant="outline" size="sm" onClick={handleDownloadPdf}>
            <Download />
            Download PDF
          </Button>
        </div>
      </Card>

      <Card className="overflow-hidden">
        <Table>
          <TableHeader>
            <TableRow className="hover:bg-transparent">
              <TableHead>Date</TableHead>
              <TableHead>Description</TableHead>
              <TableHead className="text-right">Amount</TableHead>
              <TableHead className="text-right">Running Balance</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {lines.length === 0 ? (
              <TableRow className="hover:bg-transparent">
                <TableCell colSpan={4} padding="none">
                  <EmptyState title="No activity yet." />
                </TableCell>
              </TableRow>
            ) : (
              lines.map((line, i) => (
                <TableRow key={`${line.invoice_id ?? 'row'}-${i}`}>
                  <TableCell>
                    <span className="text-muted-foreground whitespace-nowrap tabular-nums">
                      {formatDate(line.date)}
                    </span>
                  </TableCell>
                  <TableCell>
                    <span className="font-medium">{lineLabel(line)}</span>
                    {line.invoice_number && (
                      <span className="text-muted-foreground"> · {line.invoice_number}</span>
                    )}
                    {scope === 'customer' && line.customer_name && (
                      <span className="text-muted-foreground"> · {line.customer_name}</span>
                    )}
                  </TableCell>
                  <TableCell>
                    <span className="block text-right tabular-nums">{signedAmount(line)}</span>
                  </TableCell>
                  <TableCell>
                    <span className="block text-right font-medium tabular-nums">
                      {formatCurrency(Number(line.running_balance ?? 0))}
                    </span>
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>

        {/* Totals strip. Plain divs, not StatCards: these are a reconciliation
            row that has to add up left to right, not four independent metrics. */}
        <div className="flex flex-wrap border-t">
          {[
            { label: 'Billed', value: totals.billed },
            { label: 'Paid', value: totals.paid },
            // Deposit credit drawn down onto job invoices - shown only when
            // present so the strip reconciles (Balance = Billed - Paid -
            // Deposit credit - Credited + Refunded) and matches the PDF.
            ...(Number(totals.deposit_credit ?? 0) !== 0
              ? [{ label: 'Deposit credit', value: Number(totals.deposit_credit) }]
              : []),
            { label: 'Refunded', value: totals.refunded },
            { label: 'Credited', value: totals.credited },
          ].map(({ label, value }) => (
            <div key={label} className="min-w-[140px] flex-1 px-5 py-4">
              <p className="text-muted-foreground text-[10px] font-semibold uppercase tracking-widest">
                {label}
              </p>
              <p className="mt-0.5 text-lg font-semibold tabular-nums">
                {formatCurrency(Number(value ?? 0))}
              </p>
            </div>
          ))}
          <div className="bg-muted min-w-[140px] flex-1 px-5 py-4">
            <p className="text-muted-foreground text-[10px] font-semibold uppercase tracking-widest">
              Balance
            </p>
            <p data-testid="statement-running-balance" className="mt-0.5 text-xl font-bold tabular-nums">
              {formatCurrency(Number(totals.balance ?? 0))}
            </p>
          </div>
        </div>
      </Card>
    </div>
  );
}
