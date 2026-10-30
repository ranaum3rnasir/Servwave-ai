/**
 * Roles & Permissions M4 (ticket 35), Ran's ruling 7 (2026-10-29): the Price Book's bundles ("Preset bundles") stay visible to a
 * person without See prices, and show NO price line - no "Customer sees", no "items sum", no subtotal, and never a "$0.00" made
 * of prices the server left out. With See prices the same cards and editor show them.
 *
 * Both the routed page's bundle cards and the bundle editor (which opens for Create / Edit price book holders, who need not see
 * prices) are covered. The data a person without See prices receives has no price key at all, so the "stripped" fixtures below
 * carry none; the "full" fixtures carry the prices.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, fireEvent } from '@testing-library/react';

import { renderWithProviders } from '@/__tests__/helpers';
import PriceBookPage from '@/pages/v2/inventory/PriceBookPage';
import { AddGroupDialog } from '@/components/inventory/AddGroupDialog';
import { buildAbility } from '@/lib/ability';
import type { Item, ItemGroup } from '@/lib/api/inventory';

const h = vi.hoisted(() => {
  const ITEM_ID = 'dddddddd-0000-4000-8000-000000000001';
  const baseItem = {
    id: ITEM_ID, sku: 'QA-PB-1', name: 'qa-door-hinge', category: 'Hardware', trade: 'general', kind: 'material', type: 'MATERIAL', uom: 'EA',
    serialized: false, hazmat: false, trackInventory: false, taxable: true, status: 'active', vendor: '', stock: [], updatedAt: '2026-07-01T00:00:00.000Z',
  };
  return {
    stripped: true,
    EMPTY: [] as unknown[],
    FULL_ITEM: { ...baseItem, sellPrice: 178, unitCost: 40 } as unknown,
    STRIPPED_ITEM: { ...baseItem } as unknown,
    FULL_ITEMS: [{ ...baseItem, sellPrice: 178, unitCost: 40 }] as unknown[],
    STRIPPED_ITEMS: [{ ...baseItem }] as unknown[],
    FULL_GROUPS: [
      { id: 'g1', name: 'Itemized Bundle', groupType: 'individual', isActive: true, lines: [{ id: 'l1', itemId: ITEM_ID, name: 'qa-door-hinge', quantity: 2 }, { id: 'l2', name: 'Travel fee', quantity: 1, priceOverride: 50 }] },
      { id: 'g2', name: 'Flat Bundle', groupType: 'flat_rate', flatRatePriceOverride: 400, isActive: true, lines: [{ id: 'l3', itemId: ITEM_ID, name: 'qa-door-hinge', quantity: 1 }] },
    ] as unknown[],
    STRIPPED_GROUPS: [
      { id: 'g1', name: 'Itemized Bundle', groupType: 'individual', isActive: true, lines: [{ id: 'l1', itemId: ITEM_ID, name: 'qa-door-hinge', quantity: 2 }, { id: 'l2', name: 'Travel fee', quantity: 1 }] },
      { id: 'g2', name: 'Flat Bundle', groupType: 'flat_rate', isActive: true, lines: [{ id: 'l3', itemId: ITEM_ID, name: 'qa-door-hinge', quantity: 1 }] },
    ] as unknown[],
  };
});
const FULL_ITEM = h.FULL_ITEM as Item;
const STRIPPED_ITEM = h.STRIPPED_ITEM as Item;
const FULL_GROUPS = h.FULL_GROUPS as ItemGroup[];
const STRIPPED_GROUPS = h.STRIPPED_GROUPS as ItemGroup[];

vi.mock('@/lib/api/inventory', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api/inventory')>();
  const answer = (full: unknown, stripped: unknown) => () => ({ data: h.stripped ? stripped : full, isLoading: false, isError: false });
  const empty = () => ({ data: h.EMPTY, isLoading: false, isError: false });
  const mutation = () => ({ mutate: vi.fn(), mutateAsync: vi.fn(), isPending: false });
  return {
    ...actual,
    usePriceBookItems: answer(h.FULL_ITEMS, h.STRIPPED_ITEMS),
    useItemGroups: answer(h.FULL_GROUPS, h.STRIPPED_GROUPS),
    useBrands: empty, useCategories: empty, useVendors: empty, useLocations: empty, useFinishes: empty,
    useUpsertItem: mutation, useUpsertBrand: mutation, useUpsertItemGroup: mutation, useUpsertCategory: mutation, useUpsertVendor: mutation,
    useDeleteBrand: mutation, useDeleteItemGroup: mutation, useDeleteCategory: mutation, useSetThresholds: mutation,
  };
});

const withoutPrices = () => buildAbility([{ action: 'read', subject: 'PriceBook' }, { action: 'create', subject: 'PriceBook' }, { action: 'update', subject: 'PriceBook' }]);
const withPrices = () => buildAbility([{ action: 'read', subject: 'PriceBook' }, { action: 'read', subject: 'Prices' }]);

beforeEach(() => {
  vi.clearAllMocks();
});

async function bundleCards(ability: ReturnType<typeof buildAbility>) {
  renderWithProviders(<PriceBookPage />, { initialEntries: ['/inventory/price-book'], ability });
  fireEvent.click(screen.getByRole('tab', { name: /Groups/i }));
  await screen.findByText('Itemized Bundle');
}

describe('the Price Book bundle cards', () => {
  it('without See prices: both bundles are there, with no price line and no "$0.00"', async () => {
    h.stripped = true;
    await bundleCards(withoutPrices());
    expect(screen.getByText('Flat Bundle')).toBeInTheDocument();
    expect(screen.queryByText(/customer sees/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/items sum/i)).not.toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/\$\s?0\.00/);
    expect(document.body.textContent).not.toMatch(/\$\s?\d/);
  });

  it('with See prices: each card shows what the customer sees, and the flat bundle its items sum', async () => {
    h.stripped = false;
    await bundleCards(withPrices());
    expect(screen.getAllByText(/customer sees/i)).toHaveLength(2);
    // Itemized: 2 x $178.00 + $50.00 = $406.00. Flat: $400.00, over an items sum of $178.00.
    expect(screen.getByText('$406.00')).toBeInTheDocument();
    expect(screen.getByText('$400.00')).toBeInTheDocument();
    expect(screen.getByText(/items sum: \$178\.00/)).toBeInTheDocument();
  });
});

describe('the bundle editor', () => {
  function editor(ability: ReturnType<typeof buildAbility>, stripped: boolean) {
    h.stripped = stripped;
    renderWithProviders(
      <AddGroupDialog open onClose={vi.fn()} onUpdate={vi.fn()} editGroup={(stripped ? STRIPPED_GROUPS : FULL_GROUPS)[0]!} items={[stripped ? STRIPPED_ITEM : FULL_ITEM]} />,
      { ability },
    );
  }

  it('without See prices: the lines are there, with no Price or Amount column, no subtotal, no "Customer sees" and no "$0.00"', () => {
    editor(withoutPrices(), true);
    expect(screen.getByDisplayValue('Travel fee')).toBeInTheDocument();
    expect(screen.queryByRole('columnheader', { name: /^price$/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('columnheader', { name: /^amount$/i })).not.toBeInTheDocument();
    expect(screen.queryByText(/subtotal/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/customer sees/i)).not.toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/\$\s?\d/);
  });

  it('without See prices, a flat-rate bundle offers no price field either', () => {
    h.stripped = true;
    renderWithProviders(
      <AddGroupDialog open onClose={vi.fn()} onUpdate={vi.fn()} editGroup={STRIPPED_GROUPS[1]!} items={[STRIPPED_ITEM]} />,
      { ability: withoutPrices() },
    );
    expect(screen.queryByText(/flat-rate price/i)).not.toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/\$\s?\d/);
  });

  it('with See prices: the Price and Amount columns, the subtotal and "Customer sees" are all there', () => {
    editor(withPrices(), false);
    expect(screen.getByRole('columnheader', { name: /^price$/i })).toBeInTheDocument();
    expect(screen.getByRole('columnheader', { name: /^amount$/i })).toBeInTheDocument();
    expect(screen.getByText(/subtotal/i)).toBeInTheDocument();
    expect(screen.getByText(/customer sees/i)).toBeInTheDocument();
    expect(screen.getAllByText('$406.00').length).toBeGreaterThan(0);
  });
});
