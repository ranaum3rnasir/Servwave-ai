import type { ColumnDef } from '@tanstack/react-table';

import { STATUS_REGISTRY } from '@/design-system/status-registry';
import type { AttentionItem } from '@/lib/api/paymentsPage';
import { formatInstant } from '@/lib/schedule-tz';
import { formatCurrency } from '@/lib/utils';
import { Badge } from '@/ui-kit/components/ui/badge';

import { AttentionRowActions } from './AttentionRowActions';
import { CustomerCell } from './CustomerIdLink';
import { Restricted } from './attentionRow';

/** The server sends the plain reason; the page adds "Resolved: " once (V7 C-21). */
const resolvedLine = (item: AttentionItem) => (item.resolution?.text ? `Resolved: ${item.resolution.text}` : item.detail);

const SHORT_DATE: Intl.DateTimeFormatOptions = { month: 'short', day: 'numeric', year: 'numeric' };

type PillTone = 'red' | 'amber' | 'green' | 'slate';

/** A dispute's own status wears the tone v7 draws for it: Needs response red, Under review amber, Won green, Lost and Closed neutral. */
const DISPUTE_TONE: Record<string, PillTone> = {
  NEEDS_RESPONSE: 'red', UNDER_REVIEW: 'amber', WON: 'green', LOST: 'slate', CLOSED: 'slate',
};

/** The Status pill: the item's kind while open (a dispute shows its own status), "Resolved" once closed. */
function statusPill(item: AttentionItem): { label: string; tone: PillTone } {
  if (item.type === 'dispute') {
    const key = item.dispute_status ?? 'NEEDS_RESPONSE';
    return { label: STATUS_REGISTRY.dispute[key]?.label ?? key, tone: DISPUTE_TONE[key] ?? 'slate' };
  }
  if (item.status === 'resolved') return { label: 'Resolved', tone: 'green' };
  switch (item.type) {
    case 'failed_refund': return { label: 'Refund failed', tone: 'red' };
    case 'unmatched_payment':
    case 'unmatched_refund': return { label: 'Unapplied', tone: 'amber' };
    default: return { label: 'Failed', tone: 'red' };
  }
}

const isUnapplied = (item: AttentionItem) => item.type === 'unmatched_payment' || item.type === 'unmatched_refund';

/**
 * Sizes add up to 1,008px so the table fits the page box at 1280px with the sidebar open (1,014px): nothing scrolls
 * sideways or clips the Actions header. Item and Customer wrap; Actions keeps room for its buttons on one line.
 *
 * The Needs attention table's columns: when, what it is (title and plain detail, or how it was resolved), who, which
 * invoice, its status, how much, and the row's actions (or who resolved it).
 */
export function buildAttentionColumns({ timeZone }: { timeZone: string }): ColumnDef<AttentionItem>[] {
  return [
    {
      id: 'date', header: 'Date', meta: { label: 'Date' }, size: 112,
      cell: ({ row }) => formatInstant(row.original.date, timeZone, SHORT_DATE),
    },
    {
      id: 'item', header: 'Item', meta: { label: 'Item' }, size: 170,
      cell: ({ row }) => {
        const item = row.original;
        const line = item.status === 'resolved' ? resolvedLine(item) : item.detail;
        return (
          <div className="flex min-w-0 flex-col">
            <span className="font-medium">{item.title}</span>
            {line && <span className="text-text-secondary text-[12.5px]">{line}</span>}
          </div>
        );
      },
    },
    {
      id: 'customer', header: 'Customer', meta: { label: 'Customer' }, size: 130,
      cell: ({ row }) => {
        const item = row.original;
        if (item.restricted) return <Restricted />;
        if (item.customer) return <CustomerCell customer={item.customer} />;
        return item.type === 'failed_payout' && item.payout_reference ? `Payout ${item.payout_reference}` : '—';
      },
    },
    {
      id: 'invoice', header: 'Invoice', meta: { label: 'Invoice' }, size: 96,
      cell: ({ row }) => {
        const item = row.original;
        if (item.restricted) return <Restricted />;
        if (!item.invoice) return '—';
        if (!isUnapplied(item)) return item.invoice.number;
        return (
          <div className="flex min-w-0 flex-col">
            <span>{item.invoice.number}</span>
            <span className="text-text-secondary text-[12.5px]">Meant for</span>
          </div>
        );
      },
    },
    {
      id: 'status', header: 'Status', meta: { label: 'Status' }, size: 116,
      cell: ({ row }) => {
        const { label, tone } = statusPill(row.original);
        return <Badge variant={tone} size="sm">{label}</Badge>;
      },
    },
    {
      id: 'amount', header: () => <span className="block text-right">Amount</span>, meta: { label: 'Amount' }, size: 84,
      cell: ({ row }) => (
        <span data-money className="block text-right tabular-nums">
          {row.original.amount == null ? '—' : formatCurrency(row.original.amount)}
        </span>
      ),
    },
    {
      id: 'actions', header: () => <span className="block text-right">Actions</span>, meta: { label: 'Actions' }, size: 300,
      cell: ({ row }) => {
        const item = row.original;
        if (item.status === 'resolved') {
          return <span className="text-text-secondary block text-right">{item.resolved_by_name ?? ''}</span>;
        }
        if (item.restricted) return null;
        return <div className="flex justify-end"><AttentionRowActions item={item} /></div>;
      },
    },
  ];
}
