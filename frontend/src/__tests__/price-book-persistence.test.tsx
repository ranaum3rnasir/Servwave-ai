// P0 §D — catalog single write path, frontend side.
//
// Contract under test:
//   • `toPriceBookBody` maps the camelCase ItemWritePayload onto the
//     price-book snake_case body (the shape POST/PATCH /api/price-book/items
//     validates).
//   • PriceBookPage's AddItemDialog save persists through the repointed
//     useUpsertItem hook (no more local-only prototype writes).
//
// Seam hooks are mocked with stable resolved data (jsdom seed-loop landmine —
// see purchase-orders-deeplink.test.tsx, the sanctioned pattern).
import { describe, it, expect, vi } from 'vitest';
import { screen, fireEvent, waitFor } from '@testing-library/react';
import { renderWithProviders } from './helpers';
import PriceBookPage from '@/pages/inventory/PriceBookPage';
import { toPriceBookBody } from '@/lib/api/inventory';

const h = vi.hoisted(() => ({
  upsertItemMutateAsync: vi.fn(async (p: Record<string, unknown>) => ({
    id: 'itm_srv_1',
    ...p,
  })),
}));

vi.mock('@/lib/api/inventory', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api/inventory')>();
  const EMPTY: never[] = [];
  const stable =
    <T,>(data: T) =>
    () => ({ data, isLoading: false, isError: false });
  const mutation = () => ({ mutate: vi.fn(), mutateAsync: vi.fn(), isPending: false });
  return {
    ...actual,
    useInventoryItems: stable(EMPTY),
    useBrands: stable(EMPTY),
    useItemGroups: stable(EMPTY),
    useCategories: stable(EMPTY),
    useVendors: stable(EMPTY),
    useLocations: stable(EMPTY),
    useUpsertItem: () => ({
      mutate: vi.fn(),
      mutateAsync: h.upsertItemMutateAsync,
      isPending: false,
    }),
    useUpsertBrand: mutation,
    useUpsertItemGroup: mutation,
    useUpsertCategory: mutation,
    useDeleteBrand: mutation,
    useDeleteItemGroup: mutation,
    useDeleteCategory: mutation,
  };
});

describe('toPriceBookBody — camelCase → price-book snake_case', () => {
  it('maps every write field onto its snake_case column name', () => {
    expect(
      toPriceBookBody({
        name: 'Widget',
        sku: 'W-1',
        mpn: 'MPN-1',
        upc: 'UPC-1',
        brandId: 'b-1',
        vendorId: 'v-1',
        categoryId: 'c-1',
        trade: 'locksmith',
        kind: 'material',
        uom: 'EA',
        unitCost: 10,
        sellPrice: 25,
        listPrice: 30,
        serialized: true,
        hazmat: false,
        status: 'active',
        visibility: 'catalog',
        customerName: 'Nice Widget',
        customerDescription: 'A very nice widget',
        keyFeatures: ['shiny'],
        photoUrl: 'data:image/png;base64,x',
        trackInventory: true,
        taxable: true,
      }),
    ).toEqual({
      name: 'Widget',
      sku: 'W-1',
      mpn: 'MPN-1',
      upc: 'UPC-1',
      brand_id: 'b-1',
      vendor_id: 'v-1',
      category_id: 'c-1',
      trade: 'locksmith',
      kind: 'material',
      uom: 'EA',
      unit_cost: 10,
      sell_price: 25,
      list_price: 30,
      serialized: true,
      hazmat: false,
      status: 'active',
      visibility: 'catalog',
      customer_name: 'Nice Widget',
      customer_description: 'A very nice widget',
      key_features: ['shiny'],
      photo_url: 'data:image/png;base64,x',
      track_inventory: true,
      taxable: true,
    });
  });
});

describe('PriceBookPage — item save persists through useUpsertItem (P0 §D)', () => {
  it('AddItemDialog save calls the repointed hook with the item payload', async () => {
    renderWithProviders(<PriceBookPage />, {
      initialEntries: ['/inventory/price-book'],
    });

    fireEvent.click(screen.getByRole('button', { name: /Add Item/ }));
    fireEvent.change(
      await screen.findByPlaceholderText('e.g. Dual Run Capacitor 45/5 MFD 440V'),
      { target: { value: 'Test Widget' } },
    );
    // SKU is required since the 2026-08-12 restructure - it used to be minted
    // silently from the name on save.
    fireEvent.change(screen.getByLabelText(/^SKU/), { target: { value: 'TESTW-1' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save Item' }));

    await waitFor(() => expect(h.upsertItemMutateAsync).toHaveBeenCalledTimes(1));
    const payload = h.upsertItemMutateAsync.mock.calls[0]![0];
    expect(payload).toMatchObject({ name: 'Test Widget' });
    // Create mode — no id on the payload, so the seam POSTs (not PATCHes).
    expect(payload.id).toBeUndefined();
  });
});

// Inventory P1 §1 — the catalog "Track inventory" toggle rides the same single write path.
describe('PriceBookPage — Track inventory toggle (Inventory P1)', () => {
  it('checking "Track inventory" ships trackInventory: true and renders the deduct-on-add helper', async () => {
    h.upsertItemMutateAsync.mockClear();
    renderWithProviders(<PriceBookPage />, {
      initialEntries: ['/inventory/price-book'],
    });

    fireEvent.click(screen.getByRole('button', { name: /Add Item/ }));
    fireEvent.change(
      await screen.findByPlaceholderText('e.g. Dual Run Capacitor 45/5 MFD 440V'),
      { target: { value: 'Tracked Widget' } },
    );
    // SKU is required since the 2026-08-12 restructure - it used to be minted
    // silently from the name on save.
    fireEvent.change(screen.getByLabelText(/^SKU/), { target: { value: 'TRACKW-1' } });

    // What the toggle does now rides as the row's tooltip rather than a line of
    // helper text under the flags (2026-08-12 dialog restructure - Ran's call:
    // the strings restated their own labels). The plan-§3.2 "newly added lines
    // only" caveat is still the engine's behaviour either way.
    expect(
      screen.getByTitle(/deducts stock when this item is added to a job or invoice/i),
    ).toBeInTheDocument();

    fireEvent.click(screen.getByLabelText('Track inventory'));
    fireEvent.click(screen.getByRole('button', { name: 'Save Item' }));

    await waitFor(() => expect(h.upsertItemMutateAsync).toHaveBeenCalledTimes(1));
    expect(h.upsertItemMutateAsync.mock.calls[0]![0]).toMatchObject({
      name: 'Tracked Widget',
      trackInventory: true,
    });
  });

  it('leaving the box unchecked ships trackInventory: false (D8 default)', async () => {
    h.upsertItemMutateAsync.mockClear();
    renderWithProviders(<PriceBookPage />, {
      initialEntries: ['/inventory/price-book'],
    });

    fireEvent.click(screen.getByRole('button', { name: /Add Item/ }));
    fireEvent.change(
      await screen.findByPlaceholderText('e.g. Dual Run Capacitor 45/5 MFD 440V'),
      { target: { value: 'Untracked Widget' } },
    );
    // SKU is required since the 2026-08-12 restructure - it used to be minted
    // silently from the name on save.
    fireEvent.change(screen.getByLabelText(/^SKU/), { target: { value: 'UNTRACKW-1' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save Item' }));

    await waitFor(() => expect(h.upsertItemMutateAsync).toHaveBeenCalledTimes(1));
    expect(h.upsertItemMutateAsync.mock.calls[0]![0]).toMatchObject({
      name: 'Untracked Widget',
      trackInventory: false,
    });
  });
});
