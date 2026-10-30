/**
 * The ROUTED Price Book page's bundle-card profitability (PRD #2186, slice 09).
 *
 * `pages/v2/inventory/PriceBookPage.tsx` is the page `/inventory/price-book`
 * actually renders (App.tsx -> the pages/v2/routes glob -> inventory.routes.tsx);
 * the v1 file of the same name is imported by nothing but tests and is
 * deliberately left alone.
 *
 * The card used to compute its own margin and hardcode `return 100` when the
 * bundle's cost basis was zero-or-negative — so a bundle nobody had costed
 * advertised 100% margin. It now reads the shared calculator, shows margin and
 * markup side by side under their full words, and renders an em dash where
 * there is no figure.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, fireEvent, within } from '@testing-library/react';

import { renderWithProviders } from '@/__tests__/helpers';
import PriceBookPage from '@/pages/v2/inventory/PriceBookPage';
import { buildAbility } from '@/lib/ability';

const h = vi.hoisted(() => ({
  ITEM_ID: 'cccccccc-0000-4000-8000-000000000001',
}));

vi.mock('@/lib/api/inventory', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api/inventory')>();
  const stable =
    <T,>(data: T) =>
    () => ({ data, isLoading: false, isError: false });
  const mutation = () => ({ mutate: vi.fn(), mutateAsync: vi.fn(), isPending: false });
  const items = [
    {
      id: h.ITEM_ID,
      sku: 'QA-PB-1',
      name: 'qa-costed-item',
      category: 'Hardware',
      trade: 'general',
      kind: 'material',
      type: 'MATERIAL',
      uom: 'EA',
      unitCost: 40,
      sellPrice: 178,
      serialized: false,
      hazmat: false,
      trackInventory: false,
      taxable: true,
      status: 'active',
      vendor: '',
      stock: [],
      updatedAt: '2026-07-01T00:00:00.000Z',
    },
  ];
  const groups = [
    {
      id: 'grp_costed',
      name: 'Costed Bundle',
      groupType: 'individual' as const,
      isActive: true,
      lines: [{ id: 'ln_1', itemId: h.ITEM_ID, name: 'qa-costed-item', quantity: 1 }],
    },
    {
      // Free-form lines only: a price, and a cost nobody ever entered.
      id: 'grp_uncosted',
      name: 'Uncosted Bundle',
      groupType: 'individual' as const,
      isActive: true,
      lines: [{ id: 'ln_2', name: 'Travel fee', quantity: 1, priceOverride: 50 }],
    },
  ];
  return {
    ...actual,
    usePriceBookItems: stable(items),
    useBrands: stable([]),
    useItemGroups: stable(groups),
    useCategories: stable([]),
    useVendors: stable([]),
    useLocations: stable([]),
    useFinishes: stable([]),
    useUpsertItem: mutation,
    useUpsertBrand: mutation,
    useUpsertItemGroup: mutation,
    useUpsertCategory: mutation,
    useUpsertVendor: mutation,
    useDeleteBrand: mutation,
    useDeleteItemGroup: mutation,
    useDeleteCategory: mutation,
    useSetThresholds: mutation,
  };
});

const ability = () =>
  buildAbility([
    { action: 'read', subject: 'PriceBook' },
    { action: 'read', subject: 'Pricing' },
  ]);

async function renderGroupsTab() {
  renderWithProviders(<PriceBookPage />, {
    initialEntries: ['/inventory/price-book'],
    ability: ability(),
  });
  fireEvent.click(screen.getByRole('tab', { name: /Groups/i }));
  await screen.findByText('Costed Bundle');
}

function profitability(groupName: string) {
  return screen.getByRole('group', {
    name: new RegExp(`profitability for ${groupName}`, 'i'),
  });
}

function figureUnder(groupName: string, word: string) {
  const term = within(profitability(groupName)).getByText(word);
  return term.parentElement?.querySelector('dd')?.textContent ?? '';
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('Price Book bundle card — margin and markup', () => {
  it('shows margin and markup side by side under their full words', async () => {
    await renderGroupsTab();

    // Price 178, cost 40: margin (178-40)/178 = 78%, markup (178-40)/40 = 345%.
    expect(figureUnder('Costed Bundle', 'Margin')).toBe('78%');
    expect(figureUnder('Costed Bundle', 'Markup')).toBe('345%');
  });

  it('shows an em dash, never 100%, for a bundle nobody costed', async () => {
    await renderGroupsTab();

    expect(figureUnder('Uncosted Bundle', 'Margin')).toBe('—');
    expect(figureUnder('Uncosted Bundle', 'Markup')).toBe('—');
    expect(within(profitability('Uncosted Bundle')).queryByText('100%')).not.toBeInTheDocument();
  });
});
