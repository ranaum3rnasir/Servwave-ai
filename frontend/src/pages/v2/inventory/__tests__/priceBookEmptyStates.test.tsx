// The routed Price Book's empty Groups tab only invites creating a bundle to a person who holds Create price book
// (the same switch that draws the New Bundle button); anyone else reads a plain "nothing here".
import { describe, it, expect, vi } from 'vitest';
import { screen, fireEvent } from '@testing-library/react';

import { renderWithProviders } from '@/__tests__/helpers';
import PriceBookPage from '@/pages/v2/inventory/PriceBookPage';
import { buildAbility } from '@/lib/ability';

vi.mock('@/lib/api/inventory', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api/inventory')>();
  const stable =
    <T,>(data: T) =>
    () => ({ data, isLoading: false, isError: false });
  const mutation = () => ({ mutate: vi.fn(), mutateAsync: vi.fn(), isPending: false });
  return {
    ...actual,
    usePriceBookItems: stable([]),
    useBrands: stable([]),
    useItemGroups: stable([]),
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

function openEmptyGroups(rules: Parameters<typeof buildAbility>[0]) {
  renderWithProviders(<PriceBookPage />, { ability: buildAbility(rules) });
  fireEvent.click(screen.getByRole('tab', { name: /Groups/i }));
}

describe('the Price Book Groups tab with no bundles', () => {
  it('invites creating the first bundle to a person who can create one', () => {
    // Create price book items needs Edit price book items.
    openEmptyGroups([
      { action: 'read', subject: 'PriceBook' },
      { action: 'create', subject: 'PriceBook' },
      { action: 'update', subject: 'PriceBook' },
    ]);

    expect(screen.getByText('No bundles yet')).toBeInTheDocument();
    expect(screen.getByText(/Create your first preset bundle/)).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: /New Bundle/ }).length).toBeGreaterThan(0);
  });

  it('only says there are none to a person without Create price book', () => {
    openEmptyGroups([{ action: 'read', subject: 'PriceBook' }]);

    expect(screen.getByText('No bundles yet')).toBeInTheDocument();
    expect(screen.queryByText(/Create your first/)).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /New Bundle/ })).not.toBeInTheDocument();
  });
});
