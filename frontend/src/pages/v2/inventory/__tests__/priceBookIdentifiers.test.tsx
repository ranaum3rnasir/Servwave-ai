/**
 * Model number, part number and finish on the ROUTED Price Book page.
 *
 * App.tsx builds its whole route table from `v2Routes()`, so this file's
 * `pages/v2/inventory/PriceBookPage` is the Price Book an operator actually
 * opens. The v1 page under `pages/inventory/` is unreachable, and the existing
 * `src/__tests__/inventory-model-part-number.test.tsx` is still pointed there.
 *
 * Two defects are pinned here, both of which the v2 fork lost on the way over:
 *
 *   1. The write. The Add/Edit Item dialog collects all three, but the page's
 *      `upsertItem.mutateAsync` payload omitted them, so a create stored NULL
 *      and an edit no-opped behind a success toast - the PATCH branch in
 *      `price-book.controller.ts` only writes a field it is actually sent.
 *   2. The read-back. The Items grid printed name and SKU only, so even a value
 *      that did reach the server could never be seen again outside the dialog.
 *
 * Seam hooks are mocked with stable resolved data, the pattern
 * `priceBookExport.test.tsx` follows - a fresh array per render re-fires this
 * page's seed effects forever and hangs jsdom.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { renderWithProviders } from '@/__tests__/helpers';
import { buildAbility } from '@/lib/ability';

const h = vi.hoisted(() => {
  const ITEM_ID = 'ccccccc2-0000-4000-8000-000000000001';
  const BARE_ID = 'ccccccc2-0000-4000-8000-000000000002';
  const FINISH_ID = 'ccccccc2-0000-4000-8000-00000000000f';
  const base = {
    category: 'Hardware',
    trade: 'locksmith' as const,
    kind: 'material' as const,
    uom: 'EA',
    unitCost: 20,
    sellPrice: 45,
    serialized: false,
    hazmat: false,
    trackInventory: false,
    status: 'active' as const,
    vendor: 'Acme Supply',
    stock: [],
    updatedAt: '2026-07-01T00:00:00.000Z',
    type: 'MATERIAL' as const,
    taxable: true,
  };
  return {
    ITEM_ID,
    BARE_ID,
    FINISH_ID,
    upsertItemMutateAsync: vi.fn(async (p: Record<string, unknown>) => ({
      id: 'ccccccc2-0000-4000-8000-000000000009',
      ...p,
    })),
    // One stable array, built inside vi.hoisted so every render sees the same
    // reference.
    items: [
      {
        ...base,
        id: ITEM_ID,
        sku: 'LOCK-100',
        name: 'Deadbolt',
        mpn: '114',
        modelNumber: 'MT5+',
        finishId: FINISH_ID,
      },
      // Most real rows carry none of the three - `model_number` and `finish_id`
      // are new columns with no backfill - so the "prints nothing" case is the
      // common one, not the edge case.
      { ...base, id: BARE_ID, sku: 'LOCK-400', name: 'Bare Lock' },
    ],
    finishes: [{ id: FINISH_ID, name: 'Satin Chrome', code: '626', isActive: true }],
  };
});

vi.mock('@/lib/api/inventory', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api/inventory')>();
  const EMPTY: never[] = [];
  const stable = <T,>(data: T) => () => ({ data, isLoading: false, isError: false });
  const mutation = () => ({ mutate: vi.fn(), mutateAsync: vi.fn(), isPending: false });
  return {
    ...actual,
    useInventoryItems: stable(h.items as unknown as import('@/lib/api/inventory').Item[]),
    // Finish is a foreign key, so unlike mpn/modelNumber the grid has to
    // resolve an id to a name - hence a populated list rather than EMPTY.
    useFinishes: stable(h.finishes),
    useBrands: stable(EMPTY),
    useItemGroups: stable(EMPTY),
    useCategories: stable(EMPTY),
    useVendors: stable(EMPTY),
    useLocations: stable(EMPTY),
    useUomOptions: stable(EMPTY),
    useUpsertItem: () => ({
      mutate: vi.fn(),
      mutateAsync: h.upsertItemMutateAsync,
      isPending: false,
    }),
    useUpsertBrand: mutation,
    useUpsertItemGroup: mutation,
    useUpsertCategory: mutation,
    useUpsertVendor: mutation,
    useUpsertFinish: mutation,
    useDeleteBrand: mutation,
    useDeleteItemGroup: mutation,
    useDeleteCategory: mutation,
    useDeleteFinish: mutation,
    useSetThresholds: mutation,
  };
});

// Imported AFTER the seam mock is declared; vi.mock is hoisted, so the page
// picks up the stubs.
const { PriceBookPage } = await import('../PriceBookPage');

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
global.ResizeObserver = ResizeObserverStub as unknown as typeof ResizeObserver;

const NAME_PLACEHOLDER = 'e.g. Dual Run Capacitor 45/5 MFD 440V';

beforeEach(() => {
  vi.clearAllMocks();
});

// #2009 - PriceBookPage now gates Add Item / row-click-edit on the ability;
// this suite drives both, so it needs create+update PriceBook.
const writeAbility = () =>
  buildAbility([
    { action: 'create', subject: 'PriceBook' },
    { action: 'update', subject: 'PriceBook' },
  ]);

async function renderPriceBook() {
  renderWithProviders(<PriceBookPage />, {
    initialEntries: ['/inventory/price-book'],
    ability: writeAbility(),
  });
  expect(await screen.findByText('Deadbolt')).toBeInTheDocument();
}

/** The Item cell - name, SKU and the identifier line share one container. */
function itemCell(name: string) {
  return screen.getByText(name).parentElement as HTMLElement;
}

describe('price book item identifiers - the write', () => {
  it('a create ships the model number and part number', async () => {
    await renderPriceBook();

    await userEvent.click(screen.getByRole('button', { name: /Add Item/ }));
    await userEvent.type(await screen.findByPlaceholderText(NAME_PLACEHOLDER), 'New Deadbolt');
    await userEvent.type(screen.getByLabelText(/^SKU/), 'DEAD-3');
    await userEvent.type(screen.getByLabelText('Model Number'), 'MT5-C');
    await userEvent.type(screen.getByLabelText('Part Number'), '221');
    await userEvent.click(screen.getByRole('button', { name: 'Save Item' }));

    expect(h.upsertItemMutateAsync).toHaveBeenCalledWith(
      expect.objectContaining({ modelNumber: 'MT5-C', mpn: '221' }),
    );
  });

  it('an edit prefills all three and ships them back, finish id included', async () => {
    await renderPriceBook();

    await userEvent.click(screen.getByText('Deadbolt'));

    const model = await screen.findByLabelText('Model Number');
    expect(model).toHaveValue('MT5+');
    expect(screen.getByLabelText('Part Number')).toHaveValue('114');

    await userEvent.clear(model);
    await userEvent.type(model, 'MT5-C');
    await userEvent.click(screen.getByRole('button', { name: 'Save Changes' }));

    expect(h.upsertItemMutateAsync).toHaveBeenCalledWith(
      expect.objectContaining({
        id: h.ITEM_ID,
        modelNumber: 'MT5-C',
        mpn: '114',
        finishId: h.FINISH_ID,
      }),
    );
  });

  it('an edit updates the grid straight away, without waiting for a refetch', async () => {
    await renderPriceBook();

    await userEvent.click(screen.getByText('Deadbolt'));
    const model = await screen.findByLabelText('Model Number');
    await userEvent.clear(model);
    await userEvent.type(model, 'MT5-C');
    await userEvent.click(screen.getByRole('button', { name: 'Save Changes' }));

    // The seam is stable, so nothing re-seeds the mirror - what the row prints
    // is what the optimistic patch put there.
    expect(
      within(itemCell('Deadbolt')).getByText('Model MT5-C · Part 114 · Finish Satin Chrome'),
    ).toBeInTheDocument();
  });
});

describe('price book item identifiers - the read-back', () => {
  it('the grid prints all three under the item name', async () => {
    await renderPriceBook();

    expect(
      within(itemCell('Deadbolt')).getByText('Model MT5+ · Part 114 · Finish Satin Chrome'),
    ).toBeInTheDocument();
  });

  it('shows the finish NAME, never the raw id', async () => {
    await renderPriceBook();

    const cell = itemCell('Deadbolt');
    expect(within(cell).getByText(/Finish Satin Chrome/)).toBeInTheDocument();
    expect(within(cell).queryByText(new RegExp(h.FINISH_ID))).toBeNull();
  });

  it('prints no identifier line at all for an item carrying none of them', async () => {
    await renderPriceBook();

    expect(within(itemCell('Bare Lock')).queryByText(/^(Model|Part|Finish) /)).toBeNull();
  });
});

describe('price book item identifiers - the Items search', () => {
  /**
   * A part number you can store is a part number you can find. The grid's
   * search haystack was name + customer name + SKU only, so the identifiers
   * this PR made storable were invisible to the one control an operator uses
   * to go looking for them.
   */
  const search = () => screen.getByPlaceholderText('Search price book…');

  it('matches on the part number', async () => {
    await renderPriceBook();

    await userEvent.type(search(), '114');

    expect(screen.getByText('Deadbolt')).toBeInTheDocument();
    expect(screen.queryByText('Bare Lock')).toBeNull();
  });

  it('matches on the model number', async () => {
    await renderPriceBook();

    await userEvent.type(search(), 'mt5');

    expect(screen.getByText('Deadbolt')).toBeInTheDocument();
    expect(screen.queryByText('Bare Lock')).toBeNull();
  });

  it('matches on the finish NAME, not its id', async () => {
    await renderPriceBook();

    await userEvent.type(search(), 'satin chrome');
    expect(screen.getByText('Deadbolt')).toBeInTheDocument();
    expect(screen.queryByText('Bare Lock')).toBeNull();

    await userEvent.clear(search());
    await userEvent.type(search(), h.FINISH_ID);
    expect(screen.queryByText('Deadbolt')).toBeNull();
  });

  it('still matches on name and SKU', async () => {
    await renderPriceBook();

    await userEvent.type(search(), 'lock-400');

    expect(screen.getByText('Bare Lock')).toBeInTheDocument();
    expect(screen.queryByText('Deadbolt')).toBeNull();
  });
});

describe('price book item identifiers - presentation', () => {
  it('prints the identifier line in the same muted token as the SKU above it', async () => {
    await renderPriceBook();

    const cell = itemCell('Deadbolt');
    const sku = within(cell).getByText('LOCK-100');
    const identifiers = within(cell).getByText(/^Model MT5\+/);

    expect(sku).toHaveClass('text-muted-foreground');
    expect(identifiers).toHaveClass('text-muted-foreground');
    // The component's own v1 default must not survive the override, or the two
    // adjacent lines render in two different greys.
    expect(identifiers).not.toHaveClass('text-text-secondary');
  });
});
