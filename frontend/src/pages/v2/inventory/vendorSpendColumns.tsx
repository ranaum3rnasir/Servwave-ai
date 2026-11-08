import type { ColumnDef } from '@tanstack/react-table';
import { vendorCategoryLabel } from '@/lib/inventory/vendor-category';
import { Award, TrendingDown, TrendingUp } from 'lucide-react';

import type { Vendor } from '@/lib/api/inventory';
import { fmtMoneyFull, fmtRelativeDate, type VendorSpend } from '@/lib/inventory/vendor-spend';
import { cn } from '@/ui-kit/lib/utils';
import { Progress } from '@/ui-kit/components/ui/progress';

import { buildSelectColumn } from '../_shared/selectColumn';
import { ClientSortHeader } from '../_shared/sortHeader';

export interface RankedVendor {
  vendor: Vendor;
  spend: VendorSpend;
}

/**
 * The Spend Analytics leaderboard's columns.
 *
 * SORTING IS THE TABLE'S: VendorsPage hands the DataTable the whole ranked
 * array with no `page` and no `manualSorting`. Every column but Rank named an
 * accessorKey that does not exist on a RankedVendor - `category`, `ytd`,
 * `share`, `mom`, `pos`, `last` are all one level down, under `vendor` or
 * `spend` - so each reads `undefined` and each needs a real accessor.
 *
 * A SELECTION COLUMN is opt-in via `selectable`, and the page opts in: the
 * leaderboard now carries Export selected, which needs no backend. It stays
 * read-only otherwise - spend is DERIVED (`computeAllVendorSpend` over the PO
 * list), and `Vendor` has no `bulk-*` route, so there is nothing here a bulk
 * write could address.
 *
 * Every value is the legacy `AnalyticsView` table's, including the "bar width
 * is relative to the TOP vendor, share percentage is relative to the TOTAL"
 * split - two different denominators in one cell, which is easy to collapse by
 * accident. The hand-drawn share bar becomes the kit Progress.
 */
export function buildVendorSpendColumns({
  ranked, totalYTD, selectable = false,
}: {
  ranked: RankedVendor[];
  totalYTD: number;
  selectable?: boolean;
}): ColumnDef<RankedVendor, unknown>[] {
  const top = ranked[0];
  const columns: ColumnDef<RankedVendor, unknown>[] = [
    {
      id: 'rank',
      // The rank a row carries, not its position in the sorted view - the cell
      // reads the same index, so the number stays attached to its vendor.
      accessorFn: (row) => ranked.indexOf(row),
      header: ({ column }) => <ClientSortHeader column={column} title="#" />,
      size: 64,
      meta: { label: 'Rank', fixed: true },
      cell: ({ row }) => {
        const index = ranked.indexOf(row.original);
        return index === 0 ? (
          <span className="text-status-amber-emphasis inline-flex items-center gap-1 font-semibold">
            <Award className="size-3" /> 1
          </span>
        ) : (
          <span className="text-muted-foreground">{index + 1}</span>
        );
      },
    },
    {
      id: 'vendor',
      accessorFn: (row) => row.vendor.name,
      header: ({ column }) => <ClientSortHeader column={column} title="Vendor" />,
      size: 220,
      meta: { label: 'Vendor' },
      cell: ({ row }) => (
        <div className="min-w-0">
          <p className="truncate font-semibold">{row.original.vendor.name}</p>
          {row.original.vendor.contactPersonName && (
            <p className="text-muted-foreground truncate text-[10px]">
              {row.original.vendor.contactPersonName}
            </p>
          )}
        </div>
      ),
    },
    {
      id: 'category',
      accessorFn: (row) => vendorCategoryLabel(row.vendor),
      header: ({ column }) => <ClientSortHeader column={column} title="Category" />,
      size: 140,
      meta: { label: 'Category' },
      cell: ({ row }) => <span className="text-muted-foreground">{vendorCategoryLabel(row.original.vendor)}</span>,
    },
    {
      id: 'ytd',
      accessorFn: (row) => row.spend.ytd,
      header: ({ column }) => <ClientSortHeader column={column} align="right" title="YTD Spend" />,
      size: 130,
      meta: { label: 'YTD Spend', fixed: true },
      cell: ({ row }) => (
        <span className="block text-right font-mono font-semibold tabular-nums">
          {fmtMoneyFull(row.original.spend.ytd)}
        </span>
      ),
    },
    {
      id: 'share',
      // Share is YTD over a constant total, so ordering by the money is the
      // same ordering and does not depend on the denominator being non-zero.
      accessorFn: (row) => row.spend.ytd,
      header: ({ column }) => <ClientSortHeader column={column} title="Share" />,
      size: 160,
      meta: { label: 'Share' },
      cell: ({ row }) => {
        const share = totalYTD > 0 ? row.original.spend.ytd / totalYTD : 0;
        const barWidth =
          top && top.spend.ytd > 0 ? Math.max(2, (row.original.spend.ytd / top.spend.ytd) * 100) : 0;
        return (
          <div className="flex items-center gap-1.5">
            <Progress className="w-24" value={barWidth} />
            <span className="text-muted-foreground font-mono text-[10px]">
              {(share * 100).toFixed(1)}%
            </span>
          </div>
        );
      },
    },
    {
      id: 'mom',
      accessorFn: (row) => row.spend.momDeltaPct,
      header: ({ column }) => <ClientSortHeader column={column} title="MoM" />,
      size: 90,
      meta: { label: 'MoM', fixed: true },
      cell: ({ row }) => {
        const spend = row.original.spend;
        if (spend.lastMonth <= 0) return <span className="text-muted-foreground text-[11px]">{'-'}</span>;
        return (
          <span
            className={cn(
              'inline-flex items-center gap-0.5 text-[11px]',
              spend.momDelta >= 0 ? 'text-status-green-emphasis' : 'text-status-red-emphasis',
            )}
          >
            {spend.momDelta >= 0 ? <TrendingUp className="size-3" /> : <TrendingDown className="size-3" />}
            {Math.abs(spend.momDeltaPct * 100).toFixed(0)}%
          </span>
        );
      },
    },
    {
      id: 'pos',
      accessorFn: (row) => row.spend.ytdPoCount,
      header: ({ column }) => <ClientSortHeader column={column} align="right" title="POs" />,
      size: 70,
      meta: { label: 'POs', fixed: true },
      cell: ({ row }) => (
        <span className="text-muted-foreground block text-right font-mono tabular-nums">
          {row.original.spend.ytdPoCount}
        </span>
      ),
    },
    {
      id: 'last',
      // By instant, not by the "3 weeks ago" string the cell formats.
      accessorFn: (row) => (row.spend.lastOrderedAt ? new Date(row.spend.lastOrderedAt).getTime() : null),
      header: ({ column }) => <ClientSortHeader column={column} title="Last ordered" />,
      size: 130,
      meta: { label: 'Last ordered' },
      cell: ({ row }) => (
        <span className="text-muted-foreground">{fmtRelativeDate(row.original.spend.lastOrderedAt)}</span>
      ),
    },
  ];

  return selectable
    ? [buildSelectColumn<RankedVendor>({
        allLabel: 'Select all vendors on this page',
        rowLabel: (r) => `Select ${r.vendor.name}`,
      }), ...columns]
    : columns;
}
