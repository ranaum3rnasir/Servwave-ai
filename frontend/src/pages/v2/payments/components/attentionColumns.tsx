import type { ColumnDef } from '@tanstack/react-table';

import type { AttentionItem } from '@/lib/api/paymentsPage';
import { formatInstant } from '@/lib/schedule-tz';
import { formatCurrency } from '@/lib/utils';
import { Badge } from '@/ui-kit/components/ui/badge';

import { Restricted } from './attentionRow';

const SHORT_DATE: Intl.DateTimeFormatOptions = { month: 'short', day: 'numeric', year: 'numeric' };

/** The history table's columns: when, what happened, who, which invoice, how much, and how it ended. */
export function buildAttentionColumns({ timeZone }: { timeZone: string }): ColumnDef<AttentionItem>[] {
  return [
    {
      id: 'date', header: 'Date', meta: { label: 'Date' }, size: 120,
      cell: ({ row }) => formatInstant(row.original.date, timeZone, SHORT_DATE),
    },
    {
      id: 'what', header: 'What happened', meta: { label: 'What happened' }, size: 300,
      cell: ({ row }) => (
        <div className="flex min-w-0 flex-col">
          <span className="font-medium">{row.original.title}</span>
          {row.original.detail && <span className="text-text-secondary text-[13px]">{row.original.detail}</span>}
        </div>
      ),
    },
    {
      id: 'customer', header: 'Customer', meta: { label: 'Customer' }, size: 180,
      cell: ({ row }) => (row.original.restricted ? <Restricted /> : (row.original.customer?.name ?? '—')),
    },
    {
      id: 'invoice', header: 'Invoice', meta: { label: 'Invoice' }, size: 110,
      cell: ({ row }) => (row.original.restricted ? <Restricted /> : (row.original.invoice?.number ?? '—')),
    },
    {
      id: 'amount', header: 'Amount', meta: { label: 'Amount' }, size: 110,
      cell: ({ row }) => (
        <span data-money className="block text-right tabular-nums">
          {row.original.amount == null ? '—' : formatCurrency(row.original.amount)}
        </span>
      ),
    },
    {
      id: 'status', header: 'Status', meta: { label: 'Status' }, size: 190,
      cell: ({ row }) => {
        const item = row.original;
        if (item.status === 'open') return <Badge variant="softRed">Open</Badge>;
        const when = item.resolved_at ? formatInstant(item.resolved_at, timeZone, SHORT_DATE) : null;
        const line = when && item.resolved_by_name ? `${when} by ${item.resolved_by_name}` : when;
        return (
          <div className="flex flex-col">
            <span>{item.resolution?.text ?? 'Resolved'}</span>
            {line && <span className="text-text-secondary text-[13px]">{line}</span>}
          </div>
        );
      },
    },
  ];
}
