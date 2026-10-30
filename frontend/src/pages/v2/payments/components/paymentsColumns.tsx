import { Link } from 'react-router-dom';
import type { ColumnDef, SortingState } from '@tanstack/react-table';
import { ArrowDown, ArrowUp, ChevronsUpDown, Lock } from 'lucide-react';

import { netAfterRefunds, type PaymentRow } from '@/lib/api/paymentsPage';
import { formatInstant } from '@/lib/schedule-tz';
import { formatCurrency } from '@/lib/utils';
import { Button } from '@/ui-kit/components/ui/button';

import { StatusChip } from '../../_shared/statusChip';
import { v2Path } from '../../uiV2';

const SHORT_DATE: Intl.DateTimeFormatOptions = { month: 'short', day: 'numeric', year: 'numeric' };

/** Server-side sortable columns; the ids are the API's `sortBy` values. */
export const SORTABLE_COLUMNS = new Set(['date', 'amount', 'fee', 'net']);

function Restricted() {
  return (
    <span className="text-muted-foreground inline-flex items-center gap-1.5">
      <Lock className="size-3.5" aria-hidden />
      Restricted
    </span>
  );
}

function Money({ value }: { value: number | null }) {
  return (
    <span data-money className="block text-right tabular-nums">
      {value == null ? <span className="text-muted-foreground">—</span> : formatCurrency(value)}
    </span>
  );
}

function SortHeader({
  columnId, title, align, sorting, onToggleSort,
}: {
  columnId: string;
  title: string;
  align?: 'right';
  sorting: SortingState;
  onToggleSort: (columnId: string) => void;
}) {
  const active = sorting[0]?.id === columnId ? sorting[0] : undefined;
  return (
    <Button
      variant="ghost"
      size="sm"
      className={align === 'right'
        ? '-me-2 ms-auto h-7 gap-1.5 px-2 text-[11.5px] font-semibold'
        : '-ms-2 h-7 gap-1.5 px-2 text-[11.5px] font-semibold'}
      onClick={() => onToggleSort(columnId)}
    >
      <span>{title}</span>
      {active ? (active.desc ? <ArrowDown /> : <ArrowUp />) : <ChevronsUpDown />}
    </Button>
  );
}

/**
 * The Payments tab's columns (payments go-live P6). A Restricted row (the caller cannot open its invoice) shows a lock
 * and the word in Customer and Invoice and is not a link. Money is right-aligned in tabular figures; a fee or net the
 * processor has not confirmed yet is a dash.
 */
export function buildPaymentColumns({
  sorting, onToggleSort, timeZone,
}: {
  sorting: SortingState;
  onToggleSort: (columnId: string) => void;
  timeZone: string;
}): ColumnDef<PaymentRow>[] {
  const sortHeader = (columnId: string, title: string, align?: 'right') => (
    <SortHeader columnId={columnId} title={title} align={align} sorting={sorting} onToggleSort={onToggleSort} />
  );
  return [
    {
      id: 'date',
      header: () => sortHeader('date', 'Date'),
      meta: { label: 'Date' },
      size: 120,
      cell: ({ row }) => formatInstant(row.original.date, timeZone, SHORT_DATE),
    },
    {
      id: 'customer',
      header: 'Customer',
      meta: { label: 'Customer' },
      size: 200,
      cell: ({ row }) => (row.original.restricted || !row.original.customer ? <Restricted /> : row.original.customer.name),
    },
    {
      id: 'invoice',
      header: 'Invoice',
      meta: { label: 'Invoice' },
      size: 120,
      cell: ({ row }) => {
        const invoice = row.original.invoice;
        if (row.original.restricted || !invoice) return <Restricted />;
        return (
          <Link
            to={v2Path(`/invoices/${invoice.id}`)}
            className="text-brand hover:underline"
            onClick={(event) => event.stopPropagation()}
          >
            {invoice.number}
          </Link>
        );
      },
    },
    { id: 'method', header: 'Method', meta: { label: 'Method' }, size: 120, cell: ({ row }) => row.original.method_label },
    {
      id: 'status',
      header: 'Status',
      meta: { label: 'Status' },
      size: 150,
      cell: ({ row }) => <StatusChip domain="paymentDisplay" status={row.original.status} />,
    },
    { id: 'amount', header: () => sortHeader('amount', 'Amount', 'right'), meta: { label: 'Amount' }, size: 110, cell: ({ row }) => <Money value={row.original.amount} /> },
    { id: 'fee', header: () => sortHeader('fee', 'Fee', 'right'), meta: { label: 'Fee' }, size: 90, cell: ({ row }) => <Money value={row.original.fee} /> },
    { id: 'net', header: () => sortHeader('net', 'Net', 'right'), meta: { label: 'Net' }, size: 110, cell: ({ row }) => <Money value={netAfterRefunds(row.original)} /> },
  ];
}

/** One payment as a CSV row; Restricted rows say so instead of naming the customer or the invoice. */
export function toPaymentExportRow(p: PaymentRow & { customer_name: string; invoice_number: string }, timeZone: string) {
  return {
    Date: formatInstant(p.date, timeZone, { year: 'numeric', month: '2-digit', day: '2-digit' }),
    Customer: p.restricted ? 'Restricted' : p.customer_name,
    Invoice: p.restricted ? 'Restricted' : p.invoice_number,
    Method: p.method_label,
    Status: p.status,
    Amount: p.amount,
    Fee: p.fee,
    Net: netAfterRefunds(p),
  };
}
