/**
 * The Low stock tab body, rebuilt on the CRM UI kit.
 *
 * A presentation swap over `components/inventory/LowStockView.tsx`. The data
 * contract is unchanged: `useLowStock` server-computes one row per
 * (item, location) where a configured min is breached, the location picker
 * re-queries with the server `locationId` param and resets to page 1, and both
 * Generate-PO surfaces gate on `create PurchaseOrder`.
 *
 * `toProposalItems` is IMPORTED from the legacy module rather than copied. It
 * is the bridge into P2's proposal builder (`buildLowStockProposal` re-derives
 * shortfalls from the synthetic Items it returns), it is covered by
 * `src/__tests__/inventory-low-stock-view.test.tsx`, and forking it would be a
 * logic change wearing a restyle's clothes.
 *
 * What moved onto the kit:
 *   - the hand-rolled header strip becomes a kit PageHeader.
 *   - `form/SelectField` becomes the kit Select, keeping the
 *     `Filter by location` accessible name the spec selects on.
 *   - the hand-rolled `<table>` and its bespoke prev/next footer become one
 *     kit DataTable in SERVER-PAGING mode, so the list has one paginator
 *     instead of a table plus a separate control row.
 *   - the raw brand-tinted `<button>` becomes a kit Button.
 *
 * KEPT LEGACY: `GeneratePODialog` (the whole proposal/grouping flow).
 */
import { useMemo, useState } from 'react';
import type { ColumnDef } from '@tanstack/react-table';
import { AlertTriangle, ShoppingCart } from 'lucide-react';

import { useLowStock, useLocations } from '@/lib/api/inventory';
import type { Item, LowStockRow } from '@/lib/api/inventory';
import { useAppAbility } from '@/contexts/AbilityContext';
import { GeneratePODialog } from '@/components/inventory/GeneratePODialog';
import { toProposalItems } from '@/components/inventory/LowStockView';

import { DataTable } from '@/ui-kit/components/data/dataTable/dataTable';
import { EmptyState } from '@/ui-kit/components/data/emptyState';
import { PageHeader } from '@/ui-kit/components/layout/pageHeader';
import { Badge } from '@/ui-kit/components/ui/badge';
import { Button } from '@/ui-kit/components/ui/button';
import { SelectField } from '@/ui-kit/components/form/selectField';

import { EM_DASH } from '../glyphs';

/** Fractional Decimal quantities - render with up to 2 decimals. */
function fmtQty(n: number): string {
  return Number.isInteger(n) ? String(n) : n.toFixed(2);
}

/** The server's own default page size, mirrored so the footer readout is right. */
const SERVER_PAGE_SIZE = 100;

function buildLowStockColumns({
  canCreatePO, onGeneratePO,
}: {
  canCreatePO: boolean;
  onGeneratePO: (row: LowStockRow) => void;
}): ColumnDef<LowStockRow, unknown>[] {
  const columns: ColumnDef<LowStockRow, unknown>[] = [
    {
      id: 'item',
      accessorKey: 'name',
      header: 'Item',
      size: 260,
      meta: { label: 'Item', fixed: true },
      cell: ({ row }) => (
        <span className="flex items-center gap-2">
          <span className="min-w-0">
            <code className="text-muted-foreground block font-mono text-[11px]">{row.original.sku}</code>
            <span className="block truncate font-medium">{row.original.name}</span>
          </span>
          {!row.original.isActive && (
            <Badge variant="softNeutral" size="sm">inactive</Badge>
          )}
        </span>
      ),
    },
    {
      id: 'location',
      accessorKey: 'locationName',
      header: 'Location',
      size: 170,
      meta: { label: 'Location', fixed: true },
      cell: ({ row }) => <span>{row.original.locationName}</span>,
    },
    {
      id: 'onHand',
      accessorKey: 'onHand',
      header: 'On hand',
      size: 110,
      meta: { label: 'On hand', fixed: true },
      cell: ({ row }) => (
        <span className="text-status-amber-emphasis flex items-center justify-end gap-1 font-mono font-semibold">
          <AlertTriangle className="size-3.5" />
          {fmtQty(row.original.onHand)}
        </span>
      ),
    },
    {
      id: 'min',
      accessorKey: 'min',
      header: 'Min',
      size: 80,
      meta: { label: 'Min', fixed: true },
      cell: ({ row }) => <span className="block text-right font-mono">{row.original.min}</span>,
    },
    {
      id: 'max',
      accessorKey: 'max',
      header: 'Max',
      size: 80,
      meta: { label: 'Max', fixed: true },
      cell: ({ row }) => (
        <span className="text-muted-foreground block text-right font-mono">
          {row.original.max ?? EM_DASH}
        </span>
      ),
    },
    {
      id: 'vendor',
      accessorKey: 'vendorName',
      header: 'Vendor',
      size: 170,
      meta: { label: 'Vendor' },
      cell: ({ row }) => (
        <span className="text-muted-foreground">{row.original.vendorName ?? EM_DASH}</span>
      ),
    },
  ];

  if (canCreatePO) {
    columns.push({
      id: 'actions',
      header: '',
      size: 150,
      enableHiding: false,
      meta: { label: 'Generate PO', fixed: true },
      cell: ({ row }) => (
        <span className="flex justify-end">
          <Button
            variant="outline"
            size="sm"
            onClick={(e) => { e.stopPropagation(); onGeneratePO(row.original); }}
            aria-label={`Generate PO for ${row.original.name}`}
          >
            <ShoppingCart />
            Generate PO
          </Button>
        </span>
      ),
    });
  }

  return columns;
}

export function LowStockView() {
  const ability = useAppAbility();
  const canCreatePO = ability.can('create', 'PurchaseOrder');

  const [locationId, setLocationId] = useState<string>('all');
  const [page, setPage] = useState(1);
  // Undefined until the footer's rows-per-page control is touched, so the
  // FIRST query key is byte-identical to the legacy view's `{ locationId,
  // page }`. The server already defaults to 100.
  const [limit, setLimit] = useState<number | undefined>(undefined);
  const lowStockQuery = useLowStock({
    locationId: locationId === 'all' ? undefined : locationId,
    page,
    ...(limit !== undefined ? { limit } : {}),
  });
  const { data: locations = [] } = useLocations();

  const rows = useMemo(() => lowStockQuery.data?.data ?? [], [lowStockQuery.data]);
  const meta = lowStockQuery.data?.meta;

  // null = closed; otherwise the synthetic Item scope handed to the dialog.
  const [dialogItems, setDialogItems] = useState<Item[] | null>(null);

  function openForItem(row: LowStockRow) {
    // The row plus its sibling locations for the same item (from the fetched page).
    setDialogItems(toProposalItems(rows.filter((r) => r.itemId === row.itemId)));
  }

  const columns = useMemo(
    () => buildLowStockColumns({ canCreatePO, onGeneratePO: openForItem }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [canCreatePO, rows],
  );

  return (
    <div>
      <PageHeader
        title="Low stock"
        description={`Every item-location below its configured minimum${
          meta ? ` · ${meta.total} row${meta.total === 1 ? '' : 's'}` : ''
        } - server-computed, not capped at the Stock page's 100-item window`}
        actions={
          canCreatePO && rows.length > 0 ? (
            <Button variant="secondary" size="sm" onClick={() => setDialogItems(toProposalItems(rows))}>
              <ShoppingCart />
              Generate PO (all)
            </Button>
          ) : undefined
        }
      />

      <DataTable
        columns={columns}
        data={rows}
        getRowId={(row) => `${row.itemId}-${row.locationId}`}
        isLoading={lowStockQuery.isLoading}
        enableColumnResizing
        mobileCards
        page={page}
        pageCount={meta?.totalPages ?? 1}
        onPageChange={setPage}
        pageSize={limit}
        onPageSizeChange={(next) => { setLimit(next); setPage(1); }}
        initialPageSize={SERVER_PAGE_SIZE}
        rowCount={meta?.total ?? rows.length}
        empty={
          <EmptyState
            title={
              lowStockQuery.isLoading
                ? 'Loading low-stock items…'
                : 'Nothing is below its minimum threshold.'
            }
          />
        }
      >
        {() => (
          <div className="flex flex-wrap items-center gap-2 border-b px-4 py-3">
            <div className="w-56">
              <SelectField
                value={locationId}
                onValueChange={(v) => { setLocationId(v); setPage(1); }}
                size="sm"
                aria-label="Filter by location"
                options={[
                  { value: 'all', label: 'All locations' },
                  ...locations.map((l) => ({ value: l.id, label: l.name })),
                ]}
              />
            </div>
          </div>
        )}
      </DataTable>

      <GeneratePODialog
        open={dialogItems !== null}
        onClose={() => setDialogItems(null)}
        items={dialogItems ?? []}
        locations={locations}
      />
    </div>
  );
}
