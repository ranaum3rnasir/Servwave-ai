/**
 * Ruling 7 and the save rule (ticket 35): the item form shows a price only to a person with See prices. Without it there is no
 * Sell Price field, no "$0.00" in its place, and a save sends no price at all, so the stored one is never blanked.
 */
import { describe, it, expect, vi } from 'vitest';
import { screen, fireEvent, waitFor } from '@testing-library/react';
import { renderWithProviders } from '@/__tests__/helpers';
import { AddItemDialog } from '../AddItemDialog';
import type { Item } from '@/lib/api/inventory';
import { buildAbility } from '@/lib/ability';

vi.mock('@/lib/api/inventory', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api/inventory')>();
  const stable =
    <T,>(data: T) =>
    () => ({ data, isLoading: false, isError: false });
  const mutation = () => ({ mutate: vi.fn(), mutateAsync: vi.fn(), isPending: false });
  return {
    ...actual,
    useLocations: stable([{ id: 'loc_1', name: 'Main Warehouse', type: 'warehouse', branchId: 'br_1' }]),
    useBranches: stable([{ id: 'br_1', name: 'HQ' }]),
    useFinishes: stable([]),
    useUpsertFinish: mutation,
    useUpsertBrand: mutation,
    useUpsertLocation: mutation,
    useUpsertBranch: mutation,
    useDeleteFinish: mutation,
    useDeleteBrand: mutation,
    useDeleteCategory: mutation,
  };
});

vi.mock('@/lib/api/organization', () => ({
  useOrganization: () => ({ data: { default_inventory_location_id: 'loc_1' }, isLoading: false }),
}));

/** The item as a person without See prices receives it: the price keys are simply not there. */
function item(sellPrice: number | undefined): Item {
  return {
    id: 'itm_1', sku: 'LOCK-1', name: 'Lock', category: 'Locks', trade: 'locksmith' as Item['trade'], kind: 'material' as Item['kind'],
    uom: 'EA', sellPrice, serialized: false, hazmat: false, status: 'active' as const, vendor: '', stock: [], updatedAt: '2026-01-01',
  } as Item;
}

const withoutPrices = () => buildAbility([{ action: 'read', subject: 'PriceBook' }, { action: 'update', subject: 'PriceBook' }, { action: 'create', subject: 'PriceBook' }]);
const withPrices = () => buildAbility([{ action: 'read', subject: 'PriceBook' }, { action: 'update', subject: 'PriceBook' }, { action: 'read', subject: 'Prices' }]);

function renderDialog(ability: ReturnType<typeof buildAbility>, editItem: Item | undefined, onSave = vi.fn()) {
  renderWithProviders(
    <AddItemDialog open onClose={vi.fn()} onSave={onSave} vendors={[]} onAddVendor={vi.fn()} categories={[]} onAddCategory={vi.fn()} brands={[]} editItem={editItem} />,
    { ability },
  );
  return onSave;
}

describe('AddItemDialog - Sell Price follows See prices', () => {
  it('without See prices: editing shows no Sell Price field and no $0.00, and a save sends no price', async () => {
    const onSave = renderDialog(withoutPrices(), item(undefined));
    expect(screen.queryByLabelText(/sell price/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/sell price/i)).not.toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/\$\s?\d/);
    fireEvent.click(screen.getByRole('button', { name: /save changes/i }));
    await waitFor(() => expect(onSave).toHaveBeenCalled());
    const payload = onSave.mock.calls[0]![0] as Record<string, unknown>;
    expect(payload.sellPrice).toBeUndefined();
  });

  it('without See prices: adding an item shows no Sell Price field either', () => {
    renderDialog(withoutPrices(), undefined);
    expect(screen.queryByLabelText(/sell price/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/sell price/i)).not.toBeInTheDocument();
  });

  it('with See prices: the field shows the stored price and a save sends it', async () => {
    const onSave = renderDialog(withPrices(), item(178));
    expect(screen.getByLabelText(/sell price/i)).toHaveValue('178');
    fireEvent.click(screen.getByRole('button', { name: /save changes/i }));
    await waitFor(() => expect(onSave).toHaveBeenCalled());
    expect((onSave.mock.calls[0]![0] as { sellPrice?: number }).sellPrice).toBe(178);
  });
});
