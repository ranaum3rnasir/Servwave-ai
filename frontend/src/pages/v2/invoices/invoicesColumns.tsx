import type { ColumnDef, SortingState } from '@tanstack/react-table';
import { ArrowDown, ArrowUp, ChevronsUpDown } from 'lucide-react';

import { customerDisplayName } from '@/lib/customer-name';
import { formatCurrency } from '@/lib/utils';
import { orgDayDiff, formatInstant, ORG_DAY_FORMAT } from '@/lib/schedule-tz';
import { TagChips, type TagChip } from '@/components/data/TagChips';
import { Badge } from '@/ui-kit/components/ui/badge';
import { Button } from '@/ui-kit/components/ui/button';
import { Checkbox } from '@/ui-kit/components/ui/checkbox';

import { StatusChip } from '../_shared/statusChip';

export interface InvoiceListItem {
  id: string;
  invoice_number: string;
  status: string;
  kind: string;
  subtotal: number | string;
  discount_amount: number | string;
  tax_amount: number | string;
  deposit_credit: number | string;
  total_amount: number | string;
  amount_due: number | string;
  due_date: string | null;
  sent_at: string | null;
  paid_at: string | null;
  created_at: string;
  // customer is always present on the invoice; job is optional (deposit/orphan
  // invoices have no job).
  customer: {
    id: string;
    first_name: string;
    last_name: string;
    company_name: string | null;
  };
  job: {
    id: string;
    job_number: string;
  } | null;
  tags?: TagChip[];
}

/**
 * OVERDUE is a derived pseudo-status, never persisted. Same rule as the detail page's
 * `isOverdue` (lib/invoices/invoiceMoney.ts): payable, and the ORG's calendar day has
 * moved past the due day. It used to compare raw instants, which made this list disagree
 * with the detail page for the last few hours of an invoice's due day, in whichever
 * direction the viewer's own zone happened to sit.
 */
export function isOverdue(invoice: InvoiceListItem, timeZone: string): boolean {
  if (!invoice.due_date) return false;
  if (invoice.status !== 'SENT' && invoice.status !== 'PARTIAL') return false;
  return orgDayDiff(invoice.due_date, timeZone) < 0;
}

/**
 * One invoice -> one CSV row, field-for-field mirroring the column set above.
 *
 * It lives HERE rather than as a closure inside `InvoicesPage` on purpose: the export is
 * a second, independent rendering of the same fields, and when the two were written in
 * different files they drifted - the export kept `isOverdue` on the ORG clock while its
 * dates were still on the viewer's, so a CSV could print `Status: OVERDUE` beside a due
 * date that had not arrived. Adjacency is what keeps them honest.
 *
 * Both export paths (current page and "export all") run through this one mapper.
 */
export function toInvoiceExportRow(inv: InvoiceListItem, timeZone: string) {
  return {
    'Invoice #': inv.invoice_number,
    'Customer': customerDisplayName(inv.customer, ''),
    'Company': inv.customer.company_name ?? '',
    'Job': inv.job?.job_number ?? '',
    'Status': isOverdue(inv, timeZone) ? 'OVERDUE' : inv.status,
    'Subtotal': Number(inv.subtotal),
    'Discount': Number(inv.discount_amount),
    'Tax': Number(inv.tax_amount),
    'Deposit Credit': Number(inv.deposit_credit),
    'Total': Number(inv.total_amount),
    'Amount Due': Number(inv.amount_due),
    // `formatInstant` renders '' for null/undefined/'', so the old ternary is redundant.
    'Due Date': formatInstant(inv.due_date, timeZone, ORG_DAY_FORMAT),
    'Created': formatInstant(inv.created_at, timeZone, ORG_DAY_FORMAT),
  };
}

/**
 * The four money columns the legacy page hides on first render
 * (`DEFAULT_COLUMN_VISIBILITY`), handed to the table as
 * `defaultColumnVisibility`. Run-once by construction: it seeds the table's
 * own visibility state, so a user who turns one back on in the Columns menu -
 * or has one stored in a saved view - keeps it on.
 */
export const DEFAULT_COLUMN_VISIBILITY = {
  subtotal: false,
  discount_amount: false,
  tax_amount: false,
  deposit_credit: false,
};

/**
 * Sorting is SERVER-side: the column id is sent as `sortBy` and the list
 * refetches. The page hands its sorting state to the DataTable as
 * `sorting`/`onSortingChange` with `manualSorting`, so the table renders the
 * rows in the order the server returned them and never re-sorts them itself.
 *
 * The six ids below are the six the backend allow-lists
 * (`invoice.controller.ts` - created_at, invoice_number, status, amount_due,
 * due_date, total_amount) and the same six the legacy page leaves sortable.
 */
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
      // `text-[11.5px] font-semibold` matches TableHead's own type scale -
      // Button's `size="sm"` ships `text-[13px]`, which would otherwise make
      // sortable titles bigger and lighter than the plain headers beside them.
      className={align === 'right'
        ? '-me-2 h-7 w-full justify-end gap-1.5 px-2 text-[11.5px] font-semibold'
        : '-ms-2 h-7 gap-1.5 px-2 text-[11.5px] font-semibold'}
      onClick={() => onToggleSort(columnId)}
    >
      <span>{title}</span>
      {active
        ? (active.desc ? <ArrowDown /> : <ArrowUp />)
        : <ChevronsUpDown />}
    </Button>
  );
}

/** A right-aligned money cell. `-` for a zero the legacy page suppresses. */
function Money({ value, dash, weight }: { value: number; dash?: boolean; weight?: 'medium' | 'bold' }) {
  return (
    <span
      className={
        weight === 'bold'
          ? 'block text-right font-bold tabular-nums'
          : weight === 'medium'
            ? 'block text-right font-medium tabular-nums'
            : 'block text-right tabular-nums'
      }
    >
      {dash && value === 0 ? '-' : formatCurrency(value)}
    </span>
  );
}

export function buildInvoiceColumns(
  sorting: SortingState,
  onToggleSort: (columnId: string) => void,
  onOpenJob: (jobId: string) => void,
  /** The ORG's zone - the clock `isOverdue` counts days on. */
  timeZone: string,
): ColumnDef<InvoiceListItem, unknown>[] {
  const sortable = (columnId: string, title: string, align?: 'right') => () =>
    <SortHeader columnId={columnId} title={title} align={align} sorting={sorting} onToggleSort={onToggleSort} />;

  return [
    // Row selection exists here because the module HAS a bulk action - the
    // Send / Send reminder bar the legacy list grew with `enableRowSelection`.
    // `meta.fixed` keeps the 40px box out of the surplus-width share-out, and
    // no `accessorKey` keeps it out of the Columns menu.
    {
      id: '__select',
      size: 40,
      minSize: 40,
      enableHiding: false,
      enableResizing: false,
      // The legacy invoices list pins NOTHING - it is the one of the five with
      // no `meta.pinned` at all - so only the leading checkbox is pinned here.
      // Extending the run over invoice_number/customer would be inventing a
      // layout the legacy list never had.
      meta: { pinned: true, fixed: true },
      header: ({ table }) => (
        <Checkbox
          aria-label="Select all rows"
          checked={
            table.getIsAllRowsSelected()
              ? true
              : table.getIsSomeRowsSelected()
                ? 'indeterminate'
                : false
          }
          onCheckedChange={(value) => table.toggleAllRowsSelected(value === true)}
        />
      ),
      cell: ({ row }) => (
        <Checkbox
          aria-label="Select row"
          checked={row.getIsSelected()}
          onCheckedChange={(value) => row.toggleSelected(value === true)}
          // The row itself navigates on click - stop the box from doing both.
          onClick={(e) => e.stopPropagation()}
        />
      ),
    },
    {
      id: 'invoice_number',
      accessorKey: 'invoice_number',
      header: sortable('invoice_number', 'Invoice #'),
      size: 120,
      minSize: 100,
      meta: { label: 'Invoice #', fixed: true },
      // A DEPOSIT invoice is money held against future work, not billed work, and
      // the dashboard's revenue figures deliberately exclude it. Nothing on this
      // row said so: a deposit carried the same "Paid" chip and the same Total as
      // an ordinary invoice, so a list of paid deposits read as a list of earned
      // revenue. The badge is the cheapest honest signal - it rides under the
      // number rather than in the Status column, because the kind of document a
      // row IS is not a stage in its lifecycle.
      cell: ({ row }) => (
        <div className="flex flex-col items-start gap-0.5">
          <span className="text-brand font-medium">{row.original.invoice_number}</span>
          {row.original.kind === 'DEPOSIT' && (
            <Badge variant="softAmber" size="sm">Deposit</Badge>
          )}
        </div>
      ),
    },
    {
      id: 'customer',
      accessorKey: 'customer',
      header: 'Customer',
      size: 180,
      minSize: 140,
      meta: { label: 'Customer' },
      cell: ({ row }) => {
        const c = row.original.customer;
        return (
          <div className="min-w-0">
            <span className="block truncate font-medium">{customerDisplayName(c, '')}</span>
            {c.company_name && (c.first_name || c.last_name) && (
              <span className="text-muted-foreground block truncate text-xs">{c.company_name}</span>
            )}
          </div>
        );
      },
    },
    {
      id: 'job',
      accessorKey: 'job',
      header: 'Job',
      size: 100,
      minSize: 80,
      meta: { label: 'Job', fixed: true },
      // Ported behaviour, deliberately NOT react-router: the legacy cell stops
      // propagation (so the row click does not also fire) and then sets
      // `window.location.href`, a FULL page load into the legacy Jobs module.
      // Jobs is a different migration; a soft navigation from here would land
      // inside the v2 shell on a route that may not exist yet.
      cell: ({ row }) => {
        const job = row.original.job;
        if (!job) return <span className="text-muted-foreground">{'-'}</span>;
        return (
          <span
            role="link"
            tabIndex={0}
            className="text-brand cursor-pointer font-medium hover:underline"
            onClick={(e) => {
              e.stopPropagation();
              onOpenJob(job.id);
            }}
            onKeyDown={(e) => {
              if (e.key !== 'Enter' && e.key !== ' ') return;
              e.stopPropagation();
              e.preventDefault();
              onOpenJob(job.id);
            }}
          >
            {job.job_number}
          </span>
        );
      },
    },
    {
      id: 'status',
      accessorKey: 'status',
      header: sortable('status', 'Status'),
      size: 110,
      minSize: 90,
      meta: { label: 'Status', fixed: true },
      cell: ({ row }) => (
        <StatusChip domain="invoice" status={isOverdue(row.original, timeZone) ? 'OVERDUE' : row.original.status} />
      ),
    },
    {
      id: 'subtotal',
      accessorKey: 'subtotal',
      header: () => <span className="block text-right">Subtotal</span>,
      size: 100,
      minSize: 80,
      meta: { label: 'Subtotal', fixed: true },
      cell: ({ row }) => <Money value={Number(row.original.subtotal)} />,
    },
    {
      id: 'discount_amount',
      accessorKey: 'discount_amount',
      header: () => <span className="block text-right">Discount</span>,
      size: 90,
      minSize: 70,
      meta: { label: 'Discount', fixed: true },
      cell: ({ row }) => <Money value={Number(row.original.discount_amount)} dash />,
    },
    {
      id: 'tax_amount',
      accessorKey: 'tax_amount',
      header: () => <span className="block text-right">Tax</span>,
      size: 80,
      minSize: 70,
      meta: { label: 'Tax', fixed: true },
      cell: ({ row }) => <Money value={Number(row.original.tax_amount)} />,
    },
    {
      id: 'deposit_credit',
      accessorKey: 'deposit_credit',
      header: () => <span className="block text-right">Deposit Credit</span>,
      size: 100,
      minSize: 80,
      meta: { label: 'Deposit Credit', fixed: true },
      cell: ({ row }) => <Money value={Number(row.original.deposit_credit)} dash />,
    },
    {
      id: 'total_amount',
      accessorKey: 'total_amount',
      header: sortable('total_amount', 'Total', 'right'),
      size: 110,
      minSize: 90,
      meta: { label: 'Total', fixed: true },
      cell: ({ row }) => <Money value={Number(row.original.total_amount)} weight="medium" />,
    },
    {
      id: 'amount_due',
      accessorKey: 'amount_due',
      header: sortable('amount_due', 'Amount Due', 'right'),
      size: 120,
      minSize: 100,
      meta: { label: 'Amount Due', fixed: true },
      cell: ({ row }) => {
        const val = Number(row.original.amount_due);
        return <Money value={val} weight={val > 0 ? 'bold' : undefined} />;
      },
    },
    {
      id: 'due_date',
      accessorKey: 'due_date',
      header: sortable('due_date', 'Due Date'),
      size: 120,
      minSize: 100,
      meta: { label: 'Due Date', fixed: true },
      cell: ({ row }) => {
        const { due_date } = row.original;
        if (!due_date) return <span className="text-muted-foreground">{'-'}</span>;
        return (
          <span className={isOverdue(row.original, timeZone) ? 'text-status-red-emphasis' : undefined}>
            {formatInstant(due_date, timeZone, ORG_DAY_FORMAT)}
          </span>
        );
      },
    },
    {
      id: 'tags',
      accessorKey: 'tags',
      header: 'Tags',
      size: 140,
      minSize: 80,
      meta: { label: 'Tags' },
      cell: ({ row }) => <TagChips tags={row.original.tags} />,
    },
    {
      id: 'created_at',
      accessorKey: 'created_at',
      header: sortable('created_at', 'Created'),
      size: 110,
      minSize: 90,
      meta: { label: 'Created', fixed: true },
      cell: ({ row }) => (
        <span className="text-muted-foreground text-sm">
          {formatInstant(row.original.created_at, timeZone, ORG_DAY_FORMAT)}
        </span>
      ),
    },
  ];
}
