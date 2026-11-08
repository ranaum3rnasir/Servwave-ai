/**
 * The v2 Low stock tab body - the port of
 * `src/__tests__/inventory-low-stock-view.test.tsx` onto the rebuilt component
 * at `pages/v2/inventory/components/lowStockView.tsx`.
 *
 * The rebuild is a PRESENTATION rebuild. What the legacy suite pinned is the
 * data contract, and all of it was meant to survive: `useLowStock` is called
 * with the server `locationId` param and a reset to page 1, the rows render
 * their sku/name/location/on-hand/min/max plus the inactive badge, and both
 * Generate-PO surfaces gate on `create PurchaseOrder` and hand
 * `GeneratePODialog` synthetic Items aggregated per item across locations.
 *
 * `toProposalItems` is IMPORTED by the v2 component from the legacy module, so
 * its own pure describe block stays in the legacy suite - there is one copy of
 * that function and forking the spec would only duplicate it.
 *
 * Two things this file adds beyond the legacy suite, because the rebuild
 * introduced them:
 *   - the separate prev/next control row is gone; the kit DataTable pages in
 *     SERVER mode, so `Next page` has to re-query with page 2.
 *   - the footer's rows-per-page control is new, and it is the one documented
 *     query-key divergence: the first key carries no `limit`, and a page-size
 *     change adds one.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { renderWithProviders } from '@/__tests__/helpers';
import type { Item, LowStockRow } from '@/lib/api/inventory';
import { buildAbility } from '@/lib/ability';

import { LowStockView } from '../components/lowStockView';

const hoisted = vi.hoisted(() => ({
  useLowStock: vi.fn(),
  dialogProps: vi.fn(),
}));

const ITEM_A = '10000000-0000-4000-8000-000000000001';
const ITEM_B = '10000000-0000-4000-8000-000000000002';

const ROWS: LowStockRow[] = [
  {
    itemId: ITEM_A, sku: 'CAM-01', name: 'Dome Camera', kind: 'material', status: 'active',
    isActive: true, trackInventory: true, vendorId: 'vnd-1', vendorName: 'Acme',
    locationId: 'loc-1', locationName: 'Main Warehouse', locationType: 'warehouse',
    onHand: 1, min: 5, max: 10,
  },
  {
    itemId: ITEM_A, sku: 'CAM-01', name: 'Dome Camera', kind: 'material', status: 'active',
    isActive: true, trackInventory: true, vendorId: 'vnd-1', vendorName: 'Acme',
    locationId: 'loc-2', locationName: 'Van 1', locationType: 'truck',
    onHand: 0.5, min: 2, max: null,
  },
  {
    itemId: ITEM_B, sku: 'LCK-02', name: 'Smart Lock', kind: 'material', status: 'active',
    isActive: false, trackInventory: true, vendorId: null, vendorName: null,
    locationId: 'loc-1', locationName: 'Main Warehouse', locationType: 'warehouse',
    onHand: 0, min: 3, max: null,
  },
];

vi.mock('@/lib/api/inventory', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api/inventory')>();
  return {
    ...actual,
    useLowStock: hoisted.useLowStock,
    useLocations: () => ({
      data: [
        { id: 'loc-1', name: 'Main Warehouse', type: 'warehouse', branch: 'HQ' },
        { id: 'loc-2', name: 'Van 1', type: 'truck', branch: 'HQ' },
      ],
      isLoading: false,
      isError: false,
    }),
  };
});

// Capture the props the view hands the P2 dialog instead of driving the real
// proposal UI (its own spec is generate-po-low-stock.test.tsx).
vi.mock('@/components/inventory/GeneratePODialog', () => ({
  GeneratePODialog: (props: { open: boolean; items: Item[] }) => {
    hoisted.dialogProps(props);
    return props.open ? <div data-testid="generate-po-dialog" /> : null;
  },
}));

const poAbility = () => buildAbility([{ action: 'create', subject: 'PurchaseOrder' }]);

function serve(totalPages = 1) {
  hoisted.useLowStock.mockReturnValue({
    data: { data: ROWS, meta: { page: 1, limit: 100, total: 3, totalPages } },
    isLoading: false,
    isError: false,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  serve();
});

describe('v2 LowStockView', () => {
  it('renders the server rows - sku/name/location/on-hand/min/max + inactive badge', async () => {
    renderWithProviders(<LowStockView />, { ability: poAbility() });

    expect(await screen.findAllByText('Dome Camera')).toHaveLength(2);
    expect(screen.getByText('Smart Lock')).toBeInTheDocument();
    expect(screen.getByText('inactive')).toBeInTheDocument();
    expect(screen.getByText('Van 1')).toBeInTheDocument();
    // Fractional Decimal on-hand renders with 2 decimals.
    expect(screen.getByText('0.50')).toBeInTheDocument();
    expect(screen.getByText(/3 rows/)).toBeInTheDocument();
  });

  it('location filter re-queries with the server locationId param', async () => {
    renderWithProviders(<LowStockView />, { ability: poAbility() });

    await userEvent.click(screen.getByRole('combobox', { name: 'Filter by location' }));
    await userEvent.click(await screen.findByRole('option', { name: 'Van 1' }));

    await waitFor(() =>
      expect(hoisted.useLowStock).toHaveBeenLastCalledWith(
        expect.objectContaining({ locationId: 'loc-2', page: 1 }),
      ),
    );
  });

  it('per-row Generate PO opens the dialog with ONE synthetic item aggregating that item across locations', async () => {
    renderWithProviders(<LowStockView />, { ability: poAbility() });

    await userEvent.click(
      (await screen.findAllByRole('button', { name: 'Generate PO for Dome Camera' }))[0]!,
    );

    const last = hoisted.dialogProps.mock.calls.at(-1)![0] as { open: boolean; items: Item[] };
    expect(last.open).toBe(true);
    expect(last.items).toHaveLength(1);
    expect(last.items[0]).toMatchObject({ id: ITEM_A, sku: 'CAM-01', vendor: 'Acme' });
    // Both offending locations ride along so the proposal shortfall sums them.
    expect(last.items[0]!.stock).toEqual([
      { locationId: 'loc-1', onHand: 1, min: 5, max: 10 },
      { locationId: 'loc-2', onHand: 0.5, min: 2, max: undefined },
    ]);
  });

  it('"Generate PO (all)" passes every fetched row, grouped per item', async () => {
    renderWithProviders(<LowStockView />, { ability: poAbility() });

    await userEvent.click(await screen.findByRole('button', { name: /Generate PO \(all\)/ }));

    const last = hoisted.dialogProps.mock.calls.at(-1)![0] as { open: boolean; items: Item[] };
    expect(last.open).toBe(true);
    expect(last.items).toHaveLength(2); // 3 rows -> 2 distinct items
    expect(last.items.map((i) => i.id).sort()).toEqual([ITEM_A, ITEM_B]);
    // The no-vendor item keeps vendor '' -> falls into the manual-pick group.
    expect(last.items.find((i) => i.id === ITEM_B)?.vendor).toBe('');
  });

  it('Generate PO buttons are hidden without create PurchaseOrder', async () => {
    renderWithProviders(<LowStockView />); // emptyAbility - all .can() false

    await screen.findByText('Smart Lock');
    expect(screen.queryByRole('button', { name: /Generate PO/ })).toBeNull();
  });
});

describe('v2 LowStockView - server paging through the kit footer', () => {
  it('the FIRST query key carries no limit, so it matches the legacy key byte for byte', () => {
    renderWithProviders(<LowStockView />, { ability: poAbility() });
    expect(hoisted.useLowStock).toHaveBeenCalledWith({ locationId: undefined, page: 1 });
  });

  it('Next page re-queries with page 2 and the readout follows the server meta', async () => {
    serve(2);
    renderWithProviders(<LowStockView />, { ability: poAbility() });

    expect(screen.getByText('Page 1 of 2')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Next page' }));

    await waitFor(() =>
      expect(hoisted.useLowStock).toHaveBeenLastCalledWith(
        expect.objectContaining({ page: 2 }),
      ),
    );
  });

  it('changing rows-per-page adds `limit` to the key and resets to page 1 (documented divergence)', async () => {
    serve(2);
    renderWithProviders(<LowStockView />, { ability: poAbility() });

    await userEvent.click(screen.getByRole('button', { name: 'Next page' }));
    // Two comboboxes on the view: the location filter (labelled) and the kit
    // footer's rows-per-page (unlabelled - it is the footer's own control).
    const comboboxes = screen.getAllByRole('combobox');
    expect(comboboxes).toHaveLength(2);
    await userEvent.click(comboboxes[1]!);
    await userEvent.click(await screen.findByRole('option', { name: '50' }));

    await waitFor(() =>
      expect(hoisted.useLowStock).toHaveBeenLastCalledWith(
        expect.objectContaining({ page: 1, limit: 50 }),
      ),
    );
  });
});
