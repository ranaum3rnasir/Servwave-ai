// Repro for #2009 — Price Book offers Add / row-click-edit / Save Changes to
// a requester without `update`/`create PriceBook`; the backend correctly
// 403s (backend/src/routes/price-book.routes.ts:24 `canDo('update','PriceBook')`)
// but the routed v2 page never checks the ability client-side, so a SALES
// user opens a fully editable dialog and only discovers the block at submit
// time (QA row 022).
//
// Routed page (`/inventory/price-book` -> `pages/v2/routes/inventory.routes.tsx`
// -> `../inventory/PriceBookPage` = `pages/v2/inventory/PriceBookPage.tsx`).
// The v1 `pages/inventory/PriceBookPage.tsx` (used by
// `price-book-persistence.test.tsx` / `inventory-item-type-taxable.test.tsx`)
// is dead code behind that route — this repro deliberately targets the v2
// page instead (see MEMORY: "v1 pages can be dead code behind v2 routes").
//
// Seam hooks mocked with stable resolved data — same landmine/pattern as
// `price-book-persistence.test.tsx` (jsdom seed-loop; mocking the seam keeps
// PriceBookPage's seed effects from re-firing forever).
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, fireEvent } from '@testing-library/react';
import { renderWithProviders } from './helpers';
import PriceBookPage from '@/pages/v2/inventory/PriceBookPage';
import { buildAbility } from '@/lib/ability';
import { formatCurrency } from '@/lib/utils';

const h = vi.hoisted(() => ({
  ITEM_ID: 'bbbbbbb1-0000-4000-8000-000000002009',
  upsertItemMutateAsync: vi.fn(async (p: Record<string, unknown>) => ({
    id: 'bbbbbbb1-0000-4000-8000-000000002099',
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
  const items = [
    {
      id: h.ITEM_ID,
      sku: 'QA2009-1',
      name: 'qa-2009-item',
      category: 'Hardware',
      trade: 'general',
      kind: 'material',
      type: 'MATERIAL',
      uom: 'EA',
      // Matches Pass A's prod fixture (unit_cost 40 / sell_price 178) — the
      // issue's "Decision" section requires a fix to keep these VISIBLE to
      // SALES, only the write controls must go.
      unitCost: 40,
      sellPrice: 178,
      serialized: false,
      hazmat: false,
      trackInventory: false,
      taxable: true,
      status: 'active',
      vendor: 'Acme Supply',
      stock: [],
      updatedAt: '2026-07-01T00:00:00.000Z',
    },
  ];
  return {
    ...actual,
    useInventoryItems: stable(items),
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

const readOnlyAbility = () =>
  buildAbility([
    { action: 'read', subject: 'PriceBook' },
    { action: 'read', subject: 'Pricing' },
  ]);

const writeAbility = () =>
  buildAbility([
    { action: 'read', subject: 'PriceBook' },
    { action: 'create', subject: 'PriceBook' },
    { action: 'update', subject: 'PriceBook' },
    { action: 'read', subject: 'Pricing' },
  ]);

function renderPriceBook(ability: ReturnType<typeof readOnlyAbility>) {
  return renderWithProviders(<PriceBookPage />, {
    initialEntries: ['/inventory/price-book'],
    ability,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('#2009 — Price Book write controls must be ability-gated', () => {
  it('does not render an Add Item control for a requester without create/update PriceBook', async () => {
    renderPriceBook(readOnlyAbility());
    await screen.findByText('qa-2009-item');

    expect(screen.queryByRole('button', { name: /Add Item/i })).not.toBeInTheDocument();
  });

  it('clicking an item row does not offer an enabled Save Changes control for a requester without update PriceBook', async () => {
    renderPriceBook(readOnlyAbility());
    const row = (await screen.findByText('qa-2009-item')).closest('tr');
    expect(row).not.toBeNull();
    fireEvent.click(row!);

    // Either no dialog opens at all, or a dialog opens with Save disabled.
    // Backend already 403s this write (price-book.routes.ts:24); the client
    // must not let the requester get as far as submitting it.
    const saveBtn = screen.queryByRole('button', { name: 'Save Changes' });
    const offersNoWorkingSave = saveBtn === null || saveBtn.hasAttribute('disabled');
    expect(offersNoWorkingSave).toBe(true);
  });

  it('still renders sell price for a read-only requester (SALES keeps seeing cost, Ran\'s Decision)', async () => {
    renderPriceBook(readOnlyAbility());
    await screen.findByText('qa-2009-item');

    // Price column (list -> sell fallback) renders unconditionally today and
    // must keep doing so — the fix must not blank cost/GM for SALES.
    expect(screen.getByText(formatCurrency(178))).toBeInTheDocument();

    // If a dialog does render on row click, the Unit Cost field inside it
    // must still show the real figure rather than being redacted.
    const row = screen.getByText('qa-2009-item').closest('tr');
    fireEvent.click(row!);
    const unitCostInput = screen.queryByLabelText(/unit cost/i);
    if (unitCostInput) {
      expect(unitCostInput).toHaveValue(40);
    }
  });

  it('still shows Add Item and an enabled Save Changes for a requester WITH update PriceBook', async () => {
    renderPriceBook(writeAbility());
    await screen.findByText('qa-2009-item');

    expect(screen.getByRole('button', { name: /Add Item/i })).toBeInTheDocument();

    const row = screen.getByText('qa-2009-item').closest('tr');
    fireEvent.click(row!);
    const saveBtn = await screen.findByRole('button', { name: 'Save Changes' });
    expect(saveBtn).not.toBeDisabled();
  });
});
