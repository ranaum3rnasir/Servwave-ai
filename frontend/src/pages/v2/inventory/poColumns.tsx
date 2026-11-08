import type { ColumnDef } from '@tanstack/react-table';
import { formatExactDay, formatExactInstant } from '@/lib/format-date';
import { Eye, PackageCheck, Truck } from 'lucide-react';

import type { PurchaseOrder } from '@/lib/api/inventory';
import { poTotal } from '@/lib/inventory/po-money';
import { formatCurrency } from '@/lib/utils';
import { Button } from '@/ui-kit/components/ui/button';
import { Progress } from '@/ui-kit/components/ui/progress';

import { StatusChip } from '../_shared/statusChip';

import { buildSelectColumn } from '../_shared/selectColumn';
import { ClientSortHeader } from '../_shared/sortHeader';

import { EM_DASH } from './glyphs';

/**
 * SORTING IS THE TABLE'S on both of these grids. PurchaseOrdersPage hands
 * each DataTable a complete array with no `page` and no `manualSorting`, so a
 * header click drives TanStack's own sorted row model.
 *
 * Several columns here are derived rather than fields (`total`, `lines`,
 * `received`, `lead`), so each carries a real accessor computing exactly what
 * its own cell prints - an accessorKey naming a non-field read `undefined`
 * and sorted nothing.
 *
 * A SELECTION COLUMN is opt-in on both via `selectable`, and the page opts in
 * on both: each grid carries Export selected, which needs no backend. Every
 * WRITE the page offers is per-row (preview, receive) because `PurchaseOrder`
 * has no `bulk-*` route of any kind - a bulk receive or bulk close would be a
 * button with nothing behind it. Nothing here sends: ServWave does not email
 * POs to vendors.
 *
 * Purchasing Audit Verdict PR 2 (S2.2): the Pre-PO grid is gone with the
 * estimate-reservation queue; drafts live in the Open grid.
 */

export function fmtDate(iso: string | null | undefined): string {
  if (!iso) return '-';
  // Same day-resolution as the detail dialog: dates stored at UTC midnight must not
  // print as the previous evening in US time zones.
  return formatExactDay(iso, { month: 'short', day: 'numeric' });
}

/** A real timestamp (received-on) rendered in the viewer's own zone. */
export function fmtInstant(iso: string | null | undefined): string {
  if (!iso) return '-';
  return formatExactInstant(iso, { month: 'short', day: 'numeric' });
}

function VendorCell({ vendor }: { vendor: string }) {
  return (
    <span className="text-muted-foreground flex items-center gap-1.5">
      <Truck className="size-3.5" />
      {vendor}
    </span>
  );
}

function JobCell({ po }: { po: PurchaseOrder }) {
  if (!po.jobNumber) {
    return (
      <span className="text-muted-foreground text-xs">
        {EM_DASH} no job link {EM_DASH}
      </span>
    );
  }
  return (
    <span className="flex flex-col">
      <span className="text-brand font-mono text-[11px]">{po.jobNumber}</span>
      <span className="text-muted-foreground text-[12px]">{po.customer ?? '-'}</span>
    </span>
  );
}

export function buildOpenPOColumns({
  isLate, isArrivingThisWeek, onPreview, onReceive, selectable = false,
}: {
  isLate: (po: PurchaseOrder) => boolean;
  isArrivingThisWeek: (po: PurchaseOrder) => boolean;
  onPreview: (po: PurchaseOrder) => void;
  onReceive: (po: PurchaseOrder) => void;
  selectable?: boolean;
}): ColumnDef<PurchaseOrder, unknown>[] {
  const columns: ColumnDef<PurchaseOrder, unknown>[] = [
    {
      id: 'status',
      accessorKey: 'status',
      header: ({ column }) => <ClientSortHeader column={column} title="Status" />,
      size: 110,
      meta: { label: 'Status', fixed: true },
      cell: ({ row }) => <StatusChip domain="purchaseOrder" status={row.original.status} />,
    },
    {
      id: 'po',
      accessorKey: 'poNumber',
      header: ({ column }) => <ClientSortHeader column={column} title="PO #" />,
      size: 110,
      meta: { label: 'PO #', fixed: true },
      cell: ({ row }) => <span className="font-mono text-xs">{row.original.poNumber}</span>,
    },
    {
      id: 'vendor',
      accessorKey: 'vendor',
      header: ({ column }) => <ClientSortHeader column={column} title="Vendor" />,
      size: 180,
      meta: { label: 'Vendor' },
      cell: ({ row }) => <VendorCell vendor={row.original.vendor} />,
    },
    {
      id: 'job',
      // The cell leads with the job number and falls back to an em-dash note,
      // so an unlinked PO sorts to one end rather than interleaving on a null.
      accessorFn: (po) => po.jobNumber ?? '',
      header: ({ column }) => <ClientSortHeader column={column} title="Job / Customer" />,
      size: 180,
      meta: { label: 'Job / Customer' },
      cell: ({ row }) => <JobCell po={row.original} />,
    },
    {
      id: 'ordered',
      // Null for drafts (PR 2): unordered rows sort first ascending.
      accessorFn: (po) => (po.orderedAt ? new Date(po.orderedAt).getTime() : 0),
      header: ({ column }) => <ClientSortHeader column={column} title="Ordered" />,
      size: 100,
      meta: { label: 'Ordered', fixed: true },
      cell: ({ row }) => (
        <span className="text-muted-foreground text-xs">{fmtDate(row.original.orderedAt)}</span>
      ),
    },
    {
      id: 'expected',
      // By instant, not by the "Jul 10" string the cell formats - "Apr" sorts
      // before "Jul" alphabetically, and that is not a date order.
      accessorFn: (po) => (po.expectedDate ? new Date(po.expectedDate).getTime() : null),
      header: ({ column }) => <ClientSortHeader column={column} title="Expected" />,
      size: 110,
      meta: { label: 'Expected', fixed: true },
      cell: ({ row }) => {
        const po = row.original;
        if (isLate(po)) {
          return (
            <span className="text-status-red-emphasis inline-flex items-center gap-1 text-xs font-semibold">
              <span className="bg-status-red inline-block size-1.5 rounded-full" />
              {fmtDate(po.expectedDate)}
            </span>
          );
        }
        if (isArrivingThisWeek(po)) {
          return (
            <span className="text-status-amber-emphasis text-xs font-medium">{fmtDate(po.expectedDate)}</span>
          );
        }
        return <span className="text-muted-foreground text-xs">{fmtDate(po.expectedDate)}</span>;
      },
    },
    {
      id: 'lines',
      accessorFn: (po) => po.lines.length,
      header: ({ column }) => <ClientSortHeader column={column} title="Lines" />,
      size: 80,
      meta: { label: 'Lines', fixed: true },
      cell: ({ row }) => <span className="text-muted-foreground">{row.original.lines.length}</span>,
    },
    {
      id: 'total',
      // There is no `total` field; it is the summed line cost the cell prints.
      accessorFn: (po) => poTotal(po),
      header: ({ column }) => <ClientSortHeader column={column} align="right" title="Total" />,
      size: 120,
      meta: { label: 'Total', fixed: true },
      cell: ({ row }) => (
        <span className="block text-right tabular-nums">{formatCurrency(poTotal(row.original))}</span>
      ),
    },
    {
      id: 'received',
      // By the fraction the progress bar draws, so a half-received PO sorts
      // between an untouched one and a complete one whatever their sizes.
      accessorFn: (po) => {
        const ordered = po.lines.reduce((sum, line) => sum + line.qtyOrdered, 0);
        return ordered === 0 ? 0 : po.lines.reduce((sum, line) => sum + line.qtyReceived, 0) / ordered;
      },
      header: ({ column }) => <ClientSortHeader column={column} title="Received" />,
      size: 150,
      meta: { label: 'Received' },
      cell: ({ row }) => {
        const totalOrd = row.original.lines.reduce((s, l) => s + l.qtyOrdered, 0);
        const totalRec = row.original.lines.reduce((s, l) => s + l.qtyReceived, 0);
        const pct = totalOrd === 0 ? 0 : Math.round((totalRec / totalOrd) * 100);
        return (
          <div className="flex items-center gap-2">
            <Progress className="w-16" value={pct} />
            <span className="text-muted-foreground text-[11px] tabular-nums">
              {totalRec}/{totalOrd}
            </span>
          </div>
        );
      },
    },
    {
      id: 'actions',
      header: 'Actions',
      size: 110,
      enableHiding: false,
      enableSorting: false,
      meta: { label: 'Actions', fixed: true },
      cell: ({ row }) => {
        const po = row.original;
        return (
          <div className="inline-flex items-center gap-1" onClick={(e) => e.stopPropagation()} role="presentation">
            <Button variant="ghost" size="icon-sm" title="Preview PO" aria-label="Preview PO" onClick={() => onPreview(po)}>
              <Eye />
            </Button>
            {/* A draft has not been ordered, so there is nothing to receive
                against yet - its detail leads with "Mark as ordered" instead. */}
            {po.status === 'draft' ? null : po.stagedAsJobStageId != null ? (
              /* Single-receive-path: a staged PO receives via the Staging view only. */
              <Button
                variant="ghost"
                size="icon-sm"
                disabled
                aria-label="Receive items"
                title="Receive via Staging - this PO is staged to a job"
              >
                <PackageCheck />
              </Button>
            ) : (
              <Button
                variant="ghost"
                size="icon-sm"
                title="Receive items"
                aria-label="Receive items"
                onClick={() => onReceive(po)}
              >
                <PackageCheck />
              </Button>
            )}
          </div>
        );
      },
    },
  ];

  return selectable ? [poSelectColumn(), ...columns] : columns;
}

/** The PO-number-labelled checkbox the Open and History grids share. */
function poSelectColumn() {
  return buildSelectColumn<PurchaseOrder>({
    allLabel: 'Select all purchase orders on this page',
    rowLabel: (po) => `Select ${po.poNumber}`,
  });
}

export function buildHistoryPOColumns({
  onPreview, selectable = false,
}: {
  onPreview: (po: PurchaseOrder) => void;
  selectable?: boolean;
}): ColumnDef<PurchaseOrder, unknown>[] {
  const columns: ColumnDef<PurchaseOrder, unknown>[] = [
    {
      id: 'status',
      accessorKey: 'status',
      header: ({ column }) => <ClientSortHeader column={column} title="Status" />,
      size: 110,
      meta: { label: 'Status', fixed: true },
      cell: ({ row }) => <StatusChip domain="purchaseOrder" status={row.original.status} />,
    },
    {
      id: 'po',
      accessorKey: 'poNumber',
      header: ({ column }) => <ClientSortHeader column={column} title="PO #" />,
      size: 110,
      meta: { label: 'PO #', fixed: true },
      cell: ({ row }) => (
        <Button
          variant="link"
          size="sm"
          className="h-auto p-0 font-mono text-xs"
          title="Preview PO document"
          onClick={(e) => { e.stopPropagation(); onPreview(row.original); }}
        >
          {row.original.poNumber}
        </Button>
      ),
    },
    {
      id: 'vendor',
      accessorKey: 'vendor',
      header: ({ column }) => <ClientSortHeader column={column} title="Vendor" />,
      size: 180,
      meta: { label: 'Vendor' },
      cell: ({ row }) => <VendorCell vendor={row.original.vendor} />,
    },
    {
      id: 'job',
      // The cell leads with the job number and falls back to an em-dash note,
      // so an unlinked PO sorts to one end rather than interleaving on a null.
      accessorFn: (po) => po.jobNumber ?? '',
      header: ({ column }) => <ClientSortHeader column={column} title="Job / Customer" />,
      size: 180,
      meta: { label: 'Job / Customer' },
      cell: ({ row }) => <JobCell po={row.original} />,
    },
    {
      id: 'ordered',
      // Null for drafts (PR 2): unordered rows sort first ascending.
      accessorFn: (po) => (po.orderedAt ? new Date(po.orderedAt).getTime() : 0),
      header: ({ column }) => <ClientSortHeader column={column} title="Ordered" />,
      size: 100,
      meta: { label: 'Ordered', fixed: true },
      cell: ({ row }) => (
        <span className="text-muted-foreground text-xs">{fmtDate(row.original.orderedAt)}</span>
      ),
    },
    {
      id: 'received-on',
      // The real stamp (PR 2): set when the PO entered `received`, null for a
      // closed-without-receipt or cancelled PO - never the expected date.
      accessorFn: (po) => (po.receivedAt ? new Date(po.receivedAt).getTime() : 0),
      header: ({ column }) => <ClientSortHeader column={column} title="Received on" />,
      size: 120,
      meta: { label: 'Received on', fixed: true },
      cell: ({ row }) => (
        <span className="text-muted-foreground text-xs">
          {row.original.receivedAt ? fmtInstant(row.original.receivedAt) : EM_DASH}
        </span>
      ),
    },
    {
      id: 'lead',
      // Server-computed receivedAt − orderedAt (PR 2); null when either date is missing.
      accessorFn: (po) => po.leadTimeDays ?? -1,
      header: ({ column }) => <ClientSortHeader column={column} title="Lead time" />,
      size: 100,
      meta: { label: 'Lead time', fixed: true },
      cell: ({ row }) => (
        <span className="text-muted-foreground text-xs">
          {row.original.leadTimeDays == null ? EM_DASH : `${row.original.leadTimeDays}d`}
        </span>
      ),
    },
    {
      id: 'total',
      // There is no `total` field; it is the summed line cost the cell prints.
      accessorFn: (po) => poTotal(po),
      header: ({ column }) => <ClientSortHeader column={column} align="right" title="Total" />,
      size: 120,
      meta: { label: 'Total', fixed: true },
      cell: ({ row }) => (
        <span className="block text-right tabular-nums">{formatCurrency(poTotal(row.original))}</span>
      ),
    },
  ];

  return selectable ? [poSelectColumn(), ...columns] : columns;
}
