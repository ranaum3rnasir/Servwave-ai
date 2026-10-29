import type { ColumnDef } from '@tanstack/react-table';
import {
  AlertTriangle, ArrowRightLeft, Boxes, Gauge, MoreHorizontal, PackagePlus,
  Pencil, ShoppingCart, Trash2, Undo2,
} from 'lucide-react';

import { ItemIdentifiers } from '@/components/inventory/ItemIdentifiers';
import { isLowStock, totalOnHand, type Item, type Location } from '@/lib/api/inventory';
import { formatCurrency } from '@/lib/utils';
import { Badge } from '@/ui-kit/components/ui/badge';
import { Button } from '@/ui-kit/components/ui/button';
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/ui-kit/components/ui/dropdownMenu';

import { buildSelectColumn } from '../_shared/selectColumn';
import { ClientSortHeader } from '../_shared/sortHeader';
import { ItemThumb } from './components/itemThumb';

/** The kebab actions the Stock list offers on a row. */
export interface ItemRowActions {
  onEdit: (item: Item) => void;
  onRestock: (item: Item) => void;
  onTransfer: (item: Item) => void;
  onSetQuantity: (item: Item) => void;
  onSetThresholds: (item: Item) => void;
  onDelete: (item: Item) => void;
  onRestore: (item: Item) => void;
}

// How many location chips a row shows before collapsing the rest into a "+N"
// pill. Every assigned location still counts (including the zero-stock rows
// #1491 deliberately surfaced) - they just stop stacking a 16-van item into a
// row several times the height of its neighbours.
const LOCATION_CHIP_LIMIT = 2;

/**
 * The per-location chips in the "Locations" / "Also at" column.
 *
 * Ported from `InventoryPage`'s `LocationBreakdown`, including the name
 * truncation (strip a trailing "'s Van", then 14 characters) and the title
 * string.
 *
 * EVERY location the item is ASSIGNED to renders, not just those currently
 * holding stock (#1491). A zero row is a real assignment, and dropping it left
 * the cell a bare dash - indistinguishable from "no location at all". Nothing
 * upstream filters those rows out; the page hands this component `item.stock`
 * as the API returned it.
 *
 * The colour split is the legacy one, plus an arm the legacy page never had:
 * below min is amber, a NEGATIVE balance is red, zero on hand is muted, and a
 * healthy count is the plain outline chip. Negative gets its own arm because it
 * is not a low balance but an impossible one - a miscount or a missed movement -
 * and the legacy styling let it pass as a normal chip whenever the row carried
 * no min. It is the row an operator most needs to spot, so it must not read as
 * "fine".
 */
function LocationBreakdown({
  item, locations, excludeId,
}: {
  item: Item;
  locations: Location[];
  excludeId?: string;
}) {
  const rows = item.stock.filter((s) => s.locationId !== excludeId);
  if (rows.length === 0) return <span className="text-muted-foreground">{'-'}</span>;
  // Only the first few chips render; the rest collapse into a "+N" pill whose
  // tooltip names them, so a hidden location is still reachable. The wrapper does
  // NOT wrap: a 220px column fits roughly one and a half chips, so `flex-wrap`
  // would push the second chip onto a second line and grow the row - the exact
  // thing the cap exists to prevent. Kit badges are `shrink-0`, so the overflow
  // clips at the cell edge instead, as the legacy page does.
  const shown = rows.slice(0, LOCATION_CHIP_LIMIT);
  const hidden = rows.slice(LOCATION_CHIP_LIMIT);
  return (
    <div className="flex items-center gap-1 overflow-hidden">
      {shown.map((s) => {
        const loc = locations.find((l) => l.id === s.locationId);
        if (!loc) return null;
        const low = s.min != null && s.onHand < s.min;
        const variant = s.onHand < 0
          ? 'softRed'
          : low
            ? 'softAmber'
            : s.onHand === 0
              ? 'softNeutral'
              : 'outline';
        return (
          <Badge
            key={s.locationId}
            variant={variant}
            size="sm"
            title={`${loc.name}: ${s.onHand} on hand${low ? ', below min' : ''}`}
          >
            <span className="truncate">{loc.name.replace(/'s Van$/, '').slice(0, 14)}</span>
            <span className="font-mono">{s.onHand}</span>
          </Badge>
        );
      })}
      {hidden.length > 0 && (
        <Badge
          variant="softNeutral"
          size="sm"
          title={hidden
            .map((s) => {
              const loc = locations.find((l) => l.id === s.locationId);
              return `${loc?.name ?? s.locationId}: ${s.onHand} on hand`;
            })
            .join('\n')}
        >
          +{hidden.length}
        </Badge>
      )}
    </div>
  );
}

/**
 * The On Hand / Available number a row actually shows: the active location's
 * own stock row when one is selected, the cross-location total otherwise. Both
 * columns print it, and both now sort by it.
 */
function onHandOf(item: Item, activeLocation: Location | null | undefined): number {
  const here = activeLocation ? item.stock.find((s) => s.locationId === activeLocation.id) : null;
  return here ? here.onHand : totalOnHand(item);
}

/**
 * The Stock list's columns.
 *
 * THE SELECTION COLUMN IS BACK, with the two bulk actions it exists for. The
 * legacy table's checkboxes were decorative - no `checked`, no `onChange`, no
 * bulk bar to consume them - and were dropped rather than rewired to a state
 * nothing could act on. The page now offers Export selected (no backend) and
 * Restock (`POST /api/inventory/bulk-restock`, gated `update Inventory`), so
 * a ticked row leads somewhere and comes back.
 *
 * SORTING IS THE TABLE'S. InventoryPage hands the DataTable the whole filtered
 * array with no `page` and no `manualSorting`, so every header below drives
 * TanStack's own sorted row model and nothing is refetched.
 *
 * THE ITEM CELL also carries the model number / part number / finish line the
 * legacy page prints under the item name. All three are writable from the
 * Add/Edit Item dialog, and the grid plus the side panel are their only
 * read-back surfaces here. InventoryPage's search matches on them too (finish
 * on the resolved name), so a part number you can store is a part number you
 * can find. It shares the SKU column's `text-muted-foreground` rather than
 * taking `ItemIdentifiers`' own default, which is the v1 `--text-secondary`
 * grey - a visibly different one from the v2 kit's; the component merges the
 * override through `cn`, so its v1 callers keep the default.
 *
 * `activeLocation` scopes the numeric columns exactly as the legacy row did:
 * with a location active, On Hand / Available read that location's stock row
 * and "low" is that row's own min, otherwise they are the cross-location
 * totals and `isLowStock` decides.
 */
export function buildItemColumns({
  locations, activeLocation, finishNameById, actions, selectable = false,
  canUpdatePriceBook = false, canUpdateInventory = false, canCreatePurchaseOrder = false,
  canDeletePriceBook = false,
}: {
  locations: Location[];
  activeLocation: Location | null | undefined;
  /** Finish is a foreign key, so the caller resolves id -> name once rather
   *  than firing a query per rendered row. */
  finishNameById: Map<string, string>;
  actions: ItemRowActions;
  selectable?: boolean;
  /** #2043 - the kebab's per-entry gates, read off the route each entry
   *  calls (`Edit item` / `Restore item` -> PriceBook PATCH; `Restock` /
   *  `Transfer stock` / `Set quantity` / `Reserve levels` -> Inventory
   *  writes; `Create PO` -> gated but inert, per its own comment below;
   *  `Delete item` -> PriceBook DELETE). This is a pure function outside the
   *  React tree, so the caller resolves the ability and passes booleans. */
  canUpdatePriceBook?: boolean;
  canUpdateInventory?: boolean;
  canCreatePurchaseOrder?: boolean;
  canDeletePriceBook?: boolean;
}): ColumnDef<Item, unknown>[] {
  // Pinned so it JOINS the leading sticky run rather than ending it: SKU and
  // Item are both pinned, and pinning honours the leading run only.
  const selectColumn = buildSelectColumn<Item>({
    allLabel: 'Select all items on this page',
    rowLabel: (item) => `Select ${item.sku}`,
  });

  const columns: ColumnDef<Item, unknown>[] = [
    {
      id: 'sku',
      accessorKey: 'sku',
      header: ({ column }) => <ClientSortHeader column={column} title="SKU" />,
      size: 120,
      meta: { label: 'SKU', fixed: true, pinned: true },
      cell: ({ row }) => (
        <span className="text-muted-foreground font-mono text-xs">{row.original.sku}</span>
      ),
    },
    {
      id: 'item',
      accessorKey: 'name',
      header: ({ column }) => <ClientSortHeader column={column} title="Item" />,
      size: 260,
      meta: { label: 'Item', pinned: true },
      cell: ({ row }) => {
        const item = row.original;
        return (
          <div className="flex items-center gap-2.5">
            <ItemThumb item={item} />
            <div className="min-w-0">
              <p className="truncate font-medium">{item.name}</p>
              <ItemIdentifiers
                item={item}
                finishName={finishNameById.get(item.finishId ?? '')}
                className="text-muted-foreground"
              />
              <div className="mt-0.5 flex flex-wrap items-center gap-1">
                {item.serialized && <Badge variant="softBlue" size="pill">serialized</Badge>}
                {item.hazmat && <Badge variant="softRed" size="pill">hazmat</Badge>}
                {item.status === 'on_backorder' && <Badge variant="softAmber" size="pill">backorder</Badge>}
                {item.isActive === false && <Badge variant="softNeutral" size="pill">archived</Badge>}
              </div>
            </div>
          </div>
        );
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
      id: 'onHand',
      // `stock` is an ARRAY; sorting by it compared two objects and left every
      // row where it was. Sort by the number the cell prints, which is
      // location-scoped whenever a location is active.
      accessorFn: (item) => onHandOf(item, activeLocation),
      // The legacy header appended a small "here" chip when a location was
      // active; the kit column-visibility menu reads `meta.label`, so the
      // qualifier goes in both places rather than only in the rendered header.
      header: ({ column }) => (
        <ClientSortHeader
          column={column}
          align="right"
          title={
            <span className="flex items-center gap-1">
              On Hand
              {activeLocation && <Badge variant="softBlue" size="pill">here</Badge>}
            </span>
          }
        />
      ),
      size: 110,
      meta: { label: 'On Hand', fixed: true },
      cell: ({ row }) => {
        const item = row.original;
        const here = activeLocation ? item.stock.find((s) => s.locationId === activeLocation.id) : null;
        const value = here ? here.onHand : totalOnHand(item);
        const low = here ? here.min != null && here.onHand < here.min : isLowStock(item);
        return (
          <span className="flex items-center justify-end gap-1 font-mono font-semibold">
            {low && <AlertTriangle aria-label="below min" className="text-status-amber-emphasis size-3" />}
            {value}
          </span>
        );
      },
    },
    {
      id: 'available',
      // There is no `available` field on an Item - the old accessorKey read
      // `undefined` on every row. Available IS on-hand today; see the cell.
      accessorFn: (item) => onHandOf(item, activeLocation),
      header: ({ column }) => <ClientSortHeader column={column} align="right" title="Available" />,
      size: 100,
      meta: { label: 'Available', fixed: true },
      // Available IS on-hand today - the legacy cell computed `availableCell =
      // onHandCell` and the reserved column was already gone from the header.
      cell: ({ row }) => {
        const item = row.original;
        const here = activeLocation ? item.stock.find((s) => s.locationId === activeLocation.id) : null;
        return (
          <span className="text-status-green-emphasis block text-right font-mono font-semibold">
            {here ? here.onHand : totalOnHand(item)}
          </span>
        );
      },
    },
    {
      id: 'unitCost',
      accessorKey: 'unitCost',
      header: ({ column }) => <ClientSortHeader column={column} align="right" title="Unit Cost" />,
      size: 110,
      meta: { label: 'Unit Cost', fixed: true },
      cell: ({ row }) => (
        <span className="block text-right font-mono tabular-nums">
          {row.original.unitCost != null ? formatCurrency(row.original.unitCost) : '-'}
        </span>
      ),
    },
    {
      id: 'locations',
      // A bag of per-location chips has no order to sort into.
      enableSorting: false,
      header: activeLocation ? 'Also at' : 'Locations',
      size: 220,
      meta: { label: activeLocation ? 'Also at' : 'Locations' },
      cell: ({ row }) => (
        <LocationBreakdown item={row.original} locations={locations} excludeId={activeLocation?.id} />
      ),
    },
    {
      id: 'actions',
      header: '',
      size: 56,
      enableHiding: false,
      enableSorting: false,
      meta: { label: 'Actions', fixed: true },
      // The legacy kebab was a hand-rolled absolute panel with NO outside-click
      // and NO Escape handler - it closed only when an item was chosen or the
      // same kebab was clicked again. The kit DropdownMenu is the same menu
      // with both of those, which is a fix the primitive brings, not one this
      // page authored.
      cell: ({ row }) => {
        const item = row.original;
        // The bottom entry is Restore (active -> false, PriceBook update) or
        // Delete (active, PriceBook delete) - never both, so they share one
        // slot for the "does anything survive" check below.
        const showRestoreOrDelete = item.isActive === false ? canUpdatePriceBook : canDeletePriceBook;
        const hasAnyAction =
          canUpdatePriceBook || canUpdateInventory || canCreatePurchaseOrder || showRestoreOrDelete;
        // #2043 R1 - drop the trigger entirely when no entry survives the
        // ability, rather than opening an empty menu.
        if (!hasAnyAction) return null;
        return (
          <div onClick={(e) => e.stopPropagation()} role="presentation">
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="icon-sm" aria-label="More actions">
                  <MoreHorizontal />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                {canUpdatePriceBook && (
                  <DropdownMenuItem onClick={() => actions.onEdit(item)}>
                    <Pencil />Edit item
                  </DropdownMenuItem>
                )}
                {canUpdateInventory && (
                  <DropdownMenuItem onClick={() => actions.onRestock(item)}>
                    <PackagePlus />Restock
                  </DropdownMenuItem>
                )}
                {canUpdateInventory && (
                  <DropdownMenuItem onClick={() => actions.onTransfer(item)}>
                    <ArrowRightLeft />Transfer stock
                  </DropdownMenuItem>
                )}
                {/* Inert in the legacy kebab too - it only closed the menu.
                    Carried over as-is rather than quietly deleted or quietly
                    wired; see the ledger. Gated (not wired) per #2043. */}
                {canCreatePurchaseOrder && (
                  <DropdownMenuItem onSelect={(e) => e.preventDefault()}>
                    <ShoppingCart />Create PO
                  </DropdownMenuItem>
                )}
                {canUpdateInventory && (
                  <DropdownMenuItem onClick={() => actions.onSetQuantity(item)}>
                    <Boxes />Set quantity
                  </DropdownMenuItem>
                )}
                {canUpdateInventory && (
                  <DropdownMenuItem onClick={() => actions.onSetThresholds(item)}>
                    <Gauge />Reserve levels
                  </DropdownMenuItem>
                )}
                {(canUpdatePriceBook || canUpdateInventory || canCreatePurchaseOrder) &&
                  showRestoreOrDelete && <DropdownMenuSeparator />}
                {item.isActive === false
                  ? canUpdatePriceBook && (
                      <DropdownMenuItem onClick={() => actions.onRestore(item)}>
                        <Undo2 />Restore item
                      </DropdownMenuItem>
                    )
                  : canDeletePriceBook && (
                      <DropdownMenuItem variant="destructive" onClick={() => actions.onDelete(item)}>
                        <Trash2 />Delete item
                      </DropdownMenuItem>
                    )}
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        );
      },
    },
  ];

  return selectable ? [selectColumn, ...columns] : columns;
}
