import { describe, expect, it } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ColumnDef } from '@tanstack/react-table';

import { DataTable } from '@/ui-kit/components/data/dataTable/dataTable';
import type { Item, Location, PurchaseOrder } from '@/lib/api/inventory';

import { buildItemColumns } from '../inventory/itemsColumns';
import { buildPriceBookColumns } from '../inventory/priceBookColumns';
import { buildOpenPOColumns, buildHistoryPOColumns } from '../inventory/poColumns';
import { buildVendorSpendColumns, type RankedVendor } from '../inventory/vendorSpendColumns';

/**
 * The inventory tables sort, and they sort in the browser.
 *
 * All five of these column sets shipped with plain string headers: TanStack
 * would happily have sorted them, but nothing ever drew a control to ask, so
 * every one of these lists was frozen in whatever order its page computed. They
 * are all CLIENT-side - the pages hand the DataTable a complete row array with
 * no `page`/`manualSorting` - so the sort is the table's own and no request is
 * involved. That is the opposite of the entity lists, where the click has to
 * reach the server, and the two must not be mixed up: a client sort dropped on
 * a server-paged list would silently reorder one page of many.
 *
 * Several columns also had an `accessorKey` naming a field that does not exist
 * on the row (`available`, `share`, `mom`, `pos`, `last`, `total`, `age`...),
 * which sorts every row by `undefined` - the failure mode that makes a header
 * look sortable and do nothing. Each is a real accessor now; the behavioural
 * case at the bottom is what proves it.
 */

/**
 * The columns that offer a sort control, read off the rendered header rather
 * than off `enableSorting`: a column can be sortable to TanStack and still have
 * no way for a user to say so, which is exactly the state this fixes.
 */
function sortableHeaders(columns: ColumnDef<never, unknown>[], data: unknown[] = []) {
  render(
    <DataTable
      columns={columns as ColumnDef<unknown, unknown>[]}
      data={data}
      getRowId={(_row, index) => String(index)}
    />,
  );
  return screen
    .getAllByRole('columnheader')
    .map((th) => within(th).queryByRole('button')?.textContent?.trim())
    .filter((text): text is string => Boolean(text));
}

const LOCATIONS: Location[] = [];

const ITEM_ACTIONS = {
  onEdit: () => {}, onRestock: () => {}, onTransfer: () => {},
  onSetQuantity: () => {}, onSetThresholds: () => {}, onDelete: () => {}, onRestore: () => {},
};

/**
 * Two rows, deliberately in the WRONG order for every column asserted on, and
 * cast rather than fully constructed - the column set reads six of an Item's
 * thirty-odd fields and a literal for the rest would be noise.
 */
const ITEMS = [
  { id: 'b', sku: 'ZZ-2', name: 'Zinc anode', category: 'Plumbing', unitCost: 90, stock: [{ locationId: 'l1', onHand: 2, min: null }] },
  { id: 'a', sku: 'AA-1', name: 'Air filter', category: 'HVAC', unitCost: 10, stock: [{ locationId: 'l1', onHand: 40, min: null }] },
] as unknown as Item[];

describe('the inventory stock list', () => {
  it('offers a sort control on every column that carries a value', () => {
    expect(sortableHeaders(buildItemColumns({
      locations: LOCATIONS, activeLocation: null, finishNameById: new Map(), actions: ITEM_ACTIONS,
    }) as ColumnDef<never, unknown>[])).toEqual([
      'SKU', 'Item', 'Category', 'On Hand', 'Available', 'Unit Cost',
    ]);
    // Locations renders a bag of chips and Actions a kebab - neither has an
    // order, so neither gets a control.
  });

  it('reorders the rows itself, with no request behind it', async () => {
    render(
      <DataTable
        columns={buildItemColumns({
          locations: LOCATIONS, activeLocation: null, finishNameById: new Map(), actions: ITEM_ACTIONS,
        })}
        data={ITEMS}
        getRowId={(item) => item.id}
      />,
    );

    const skus = () => Array.from(document.querySelectorAll('[data-slot="table-body"] tr'))
      .map((tr) => tr.querySelectorAll('td')[0]!.textContent);

    expect(skus()).toEqual(['ZZ-2', 'AA-1']);
    await userEvent.click(screen.getByRole('button', { name: 'SKU' }));
    expect(skus()).toEqual(['AA-1', 'ZZ-2']);
    await userEvent.click(screen.getByRole('button', { name: 'SKU' }));
    expect(skus()).toEqual(['ZZ-2', 'AA-1']);
  });

  /**
   * On Hand's accessor was `stock`, an ARRAY, so sorting it compared two
   * objects and left the rows where they were. It has to sort by the number the
   * cell actually prints.
   */
  it('sorts On Hand by the quantity the cell shows, not by the stock array', async () => {
    render(
      <DataTable
        columns={buildItemColumns({
          locations: LOCATIONS, activeLocation: null, finishNameById: new Map(), actions: ITEM_ACTIONS,
        })}
        data={ITEMS}
        getRowId={(item) => item.id}
      />,
    );

    await userEvent.click(screen.getByRole('button', { name: 'On Hand' }));

    const onHand = Array.from(document.querySelectorAll('[data-slot="table-body"] tr'))
      .map((tr) => tr.querySelectorAll('td')[3]!.textContent);
    expect(onHand).toEqual(['2', '40']);
  });
});

describe('the price book list', () => {
  it('offers a sort control on every column that carries a value', () => {
    expect(sortableHeaders(
      buildPriceBookColumns({ brands: [], finishNameById: new Map(), onToggleVisibility: () => {} }) as ColumnDef<never, unknown>[],
    )).toEqual(['Item', 'Brand', 'Category', 'Type', 'Price', 'Taxable', 'Visibility']);
    // Photo is a thumbnail with no ordering.
  });
});

describe('the purchase-order lists', () => {
  it('open POs offer a sort control on every column that carries a value', () => {
    expect(sortableHeaders(buildOpenPOColumns({
      isLate: () => false, isArrivingThisWeek: () => false,
      onPreview: () => {}, onReceive: () => {},
    }) as ColumnDef<never, unknown>[])).toEqual([
      'Status', 'PO #', 'Vendor', 'Job / Customer', 'Ordered', 'Expected', 'Lines', 'Total', 'Received',
    ]);
    // Actions is a row of icon buttons.
  });

  it('PO history offers a sort control on every column that carries a value', () => {
    expect(sortableHeaders(
      buildHistoryPOColumns({ onPreview: () => {} }) as ColumnDef<never, unknown>[],
    )).toEqual([
      'Status', 'PO #', 'Vendor', 'Job / Customer', 'Ordered', 'Received on', 'Lead time', 'Total',
    ]);
    // "Received on" is the real receivedAt stamp since PR 2, so it orders too.
  });

  it('sorts a PO total by the summed line cost, not by a missing `total` field', async () => {
    const pos = [
      { id: 'p1', poNumber: 'PO-1', vendor: 'Acme', status: 'ordered', orderedAt: '2026-07-01T00:00:00.000Z', expectedDate: '2026-07-10T00:00:00.000Z', lines: [{ qtyOrdered: 2, qtyReceived: 0, unitCost: 100 }] },
      { id: 'p2', poNumber: 'PO-2', vendor: 'Borax', status: 'ordered', orderedAt: '2026-07-02T00:00:00.000Z', expectedDate: '2026-07-11T00:00:00.000Z', lines: [{ qtyOrdered: 1, qtyReceived: 0, unitCost: 5 }] },
    ] as unknown as PurchaseOrder[];

    render(
      <DataTable
        columns={buildHistoryPOColumns({ onPreview: () => {} })}
        data={pos}
        getRowId={(po) => po.id}
      />,
    );

    await userEvent.click(screen.getByRole('button', { name: 'Total' }));

    const totals = Array.from(document.querySelectorAll('[data-slot="table-body"] tr'))
      .map((tr) => tr.querySelectorAll('td')[7]!.textContent);
    expect(totals).toEqual(['$5.00', '$200.00']);
  });
});

describe('the vendor spend leaderboard', () => {
  it('offers a sort control on every column that carries a value', () => {
    expect(sortableHeaders(buildVendorSpendColumns({
      ranked: [], totalYTD: 0,
    }) as ColumnDef<never, unknown>[])).toEqual([
      '#', 'Vendor', 'Category', 'YTD Spend', 'Share', 'MoM', 'POs', 'Last ordered',
    ]);
  });

  it('sorts YTD spend by the money, not by a missing `ytd` field', async () => {
    const ranked = [
      { vendor: { id: 'v1', name: 'Acme', category: 'HVAC' }, spend: { ytd: 90, lastMonth: 0, momDelta: 0, momDeltaPct: 0, ytdPoCount: 3, lastOrderedAt: '2026-07-01T00:00:00.000Z' } },
      { vendor: { id: 'v2', name: 'Borax', category: 'Plumbing' }, spend: { ytd: 12, lastMonth: 0, momDelta: 0, momDeltaPct: 0, ytdPoCount: 1, lastOrderedAt: '2026-06-01T00:00:00.000Z' } },
    ] as unknown as RankedVendor[];

    render(
      <DataTable
        columns={buildVendorSpendColumns({ ranked, totalYTD: 102 })}
        data={ranked}
        getRowId={(r) => r.vendor.id}
      />,
    );

    await userEvent.click(screen.getByRole('button', { name: 'YTD Spend' }));

    const names = Array.from(document.querySelectorAll('[data-slot="table-body"] tr'))
      .map((tr) => tr.querySelectorAll('td')[1]!.textContent);
    expect(names[0]).toContain('Borax');
  });
});
