import type { ColumnDef } from '@tanstack/react-table';
import { Eye, EyeOff } from 'lucide-react';

import { ItemIdentifiers } from '@/components/inventory/ItemIdentifiers';
import type { Brand, Item } from '@/lib/api/inventory';
import { formatCurrency } from '@/lib/utils';
import { Badge } from '@/ui-kit/components/ui/badge';
import { Button } from '@/ui-kit/components/ui/button';

import { buildSelectColumn } from '../_shared/selectColumn';
import { ClientSortHeader } from '../_shared/sortHeader';
import { ItemThumb } from './components/itemThumb';

/**
 * The Price Book Items table.
 *
 * SORTING IS THE TABLE'S: PriceBookPage hands the DataTable its whole filtered
 * array with no `page` and no `manualSorting`, so a header click drives
 * TanStack's own sorted row model. Three columns needed a real accessor to do
 * it - Item, Brand and Price each print something other than the field the
 * column named, and sorting by the named field ordered by a value the user
 * cannot see (Brand sorted by opaque uuid).
 *
 * THE SELECTION COLUMN is opt-in via `selectable`, and PriceBookPage does NOT
 * opt in. There is no `/api/price-book/bulk-*` endpoint, so no write-shaped
 * bulk action (bulk visibility flip, bulk re-category, bulk price change) is
 * possible, and the one read-shaped action - Export - is on the toolbar and
 * takes the filtered set. A tick column with only that behind it spends a
 * column on every row to duplicate a control already in reach. The option
 * stays here for the day a bulk endpoint lands.
 *
 * THE ITEM CELL also carries the model number / part number / finish line the
 * legacy `ItemsTab` prints. All three are writable from the Add/Edit Item
 * dialog, and this is their only read-back surface on the page. PriceBookPage's
 * Items search matches on them too (finish on the resolved name), so a part
 * number you can store is a part number you can find.
 *
 * It shares the SKU line's `text-muted-foreground` rather than taking
 * `ItemIdentifiers`' own default: the two sit one under the other, and the
 * component's default is the v1 `--text-secondary` grey, a visibly different
 * one from the v2 kit's. The component merges the override through `cn`, so its
 * v1 callers keep the default.
 *
 * Same eight columns, same fallbacks and same visibility toggle semantics as
 * the legacy `ItemsTab`. The photo cell and the toggle pill are the only two
 * that changed shape: the raw `<img>`/placeholder pair becomes the shared
 * `ItemThumb` (kit Avatar), and the two-state pill becomes a kit Button
 * carrying `aria-pressed`, which the legacy pill expressed only through colour.
 */
export function buildPriceBookColumns({
  brands, finishNameById, onToggleVisibility, selectable = false,
}: {
  brands: Brand[];
  /** Finish is a foreign key, so the caller resolves id -> name once rather
   *  than firing a query per rendered row. */
  finishNameById: Map<string, string>;
  onToggleVisibility: (itemId: string) => void;
  selectable?: boolean;
}): ColumnDef<Item, unknown>[] {
  const selectColumn = buildSelectColumn<Item>({
    allLabel: 'Select all price book items on this page',
    rowLabel: (item) => `Select ${item.sku}`,
  });

  const columns: ColumnDef<Item, unknown>[] = [
    {
      id: 'photo',
      header: '',
      size: 64,
      enableHiding: false,
      // A thumbnail has no ordering.
      enableSorting: false,
      meta: { label: 'Photo', fixed: true },
      cell: ({ row }) => <ItemThumb item={row.original} />,
    },
    {
      id: 'item',
      // The cell prints `customerName ?? name`; sorting by `name` alone put the
      // rows in an order the column does not show.
      accessorFn: (item) => item.customerName ?? item.name,
      header: ({ column }) => <ClientSortHeader column={column} title="Item" />,
      size: 260,
      meta: { label: 'Item' },
      cell: ({ row }) => (
        <div className="min-w-0">
          <div className="truncate font-medium">{row.original.customerName ?? row.original.name}</div>
          <div className="text-muted-foreground text-[11px]">{row.original.sku}</div>
          <ItemIdentifiers
            item={row.original}
            finishName={finishNameById.get(row.original.finishId ?? '')}
            className="text-muted-foreground"
          />
        </div>
      ),
    },
    {
      id: 'brand',
      // By brand NAME, which is what the cell resolves and prints - `brandId` is
      // an opaque uuid and sorting by it is arbitrary.
      accessorFn: (item) => brands.find((b) => b.id === item.brandId)?.name ?? '',
      header: ({ column }) => <ClientSortHeader column={column} title="Brand" />,
      size: 140,
      meta: { label: 'Brand' },
      cell: ({ row }) => {
        const brand = brands.find((b) => b.id === row.original.brandId);
        return brand ? <span>{brand.name}</span> : <span className="text-muted-foreground text-xs">{'-'}</span>;
      },
    },
    {
      id: 'category',
      accessorKey: 'category',
      header: ({ column }) => <ClientSortHeader column={column} title="Category" />,
      size: 140,
      meta: { label: 'Category' },
      cell: ({ row }) => <span>{row.original.category}</span>,
    },
    {
      // The billing type, read-only here - it is a projection of the item's Kind.
      id: 'type',
      accessorKey: 'type',
      header: ({ column }) => <ClientSortHeader column={column} title="Type" />,
      size: 110,
      meta: { label: 'Type', fixed: true },
      cell: ({ row }) => <span>{row.original.type === 'MATERIAL' ? 'Material' : 'Service'}</span>,
    },
    {
      id: 'price',
      // Same fallback chain the cell renders, so a "No price" row sorts to one
      // end rather than landing among the priced ones on a null.
      accessorFn: (item) => item.listPrice ?? item.sellPrice ?? null,
      header: ({ column }) => <ClientSortHeader column={column} align="right" title="Price" />,
      size: 120,
      meta: { label: 'Price', fixed: true },
      cell: ({ row }) => {
        const it = row.original;
        if (it.listPrice != null) {
          return <span className="block text-right tabular-nums">{formatCurrency(it.listPrice)}</span>;
        }
        if (it.sellPrice) {
          return <span className="block text-right tabular-nums">{formatCurrency(it.sellPrice)}</span>;
        }
        return <span className="text-status-amber-emphasis block text-right text-xs">No price</span>;
      },
    },
    {
      id: 'taxable',
      accessorKey: 'taxable',
      header: ({ column }) => <ClientSortHeader column={column} title="Taxable" />,
      size: 110,
      meta: { label: 'Taxable', fixed: true },
      cell: ({ row }) =>
        row.original.taxable === false
          ? <span className="text-muted-foreground text-xs">Not taxable</span>
          : <span>Taxable</span>,
    },
    {
      id: 'visibility',
      // Undefined means catalog, the same default the cell applies.
      accessorFn: (item) => item.visibility ?? 'catalog',
      header: ({ column }) => <ClientSortHeader column={column} title="Visibility" />,
      size: 140,
      meta: { label: 'Visibility', fixed: true },
      cell: ({ row }) => {
        const it = row.original;
        const visibility = it.visibility ?? 'catalog';
        const isCatalog = visibility === 'catalog';
        return (
          <Button
            variant="ghost"
            size="sm"
            aria-pressed={isCatalog}
            title={
              isCatalog
                ? 'Visible to customers - click to hide'
                : 'Internal only - click to publish to catalog'
            }
            onClick={(e) => { e.stopPropagation(); onToggleVisibility(it.id); }}
          >
            <Badge variant={isCatalog ? 'softBlue' : 'softNeutral'} size="pill">
              {isCatalog ? <Eye /> : <EyeOff />}
              {isCatalog ? 'Catalog' : 'Internal'}
            </Badge>
          </Button>
        );
      },
    },
  ];

  return selectable ? [selectColumn, ...columns] : columns;
}
