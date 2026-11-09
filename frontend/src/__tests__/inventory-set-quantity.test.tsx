// Inventory P1 §6 — "Set quantity" (physical count) on the Stock page.
//
// Contract under test:
//   • The item kebab offers "Set quantity" (replacing the dead-end "Cycle count" no-op).
//   • SetQuantityDialog previews the signed delta (QA-205: counted 7 vs system 9 ⇒ −2).
//   • Submit POSTs /api/inventory/stock/set-quantity with the snake_case body
//     { item_id, location_id, counted_qty, reason } that setQuantitySchema
//     actually validates (SRVW-93 - the shipped camelCase post 400ed on every
//     submit; this is a deliberate rewrite of what these assertions lock).
//   • The reason is a fixed preset (Cycle count / Damaged / … / Other); "Other" composes
//     into "Other: <note>" (LO-5, spec §12 rec 3).
//   • Success closes the dialog, shows the page toast, and invalidates ['inventory']
//     (useInventoryMutation's built-in refresh).
//
// Seam hooks are mocked with stable resolved data (jsdom seed-loop landmine — see
// purchase-orders-deeplink.test.tsx, the sanctioned pattern). useSetQuantity stays REAL
// so the POST path + cache invalidation are exercised over the setup-mocked axios.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import api from '@/lib/axios';
import { renderInventory } from '@/__tests__/harness/inventoryPage';
import { buildAbility } from '@/lib/ability';

import { toast } from '@/ui-kit/components/ui/sonner';

// The routed page reports through the kit's sonner toaster, which App.tsx
// mounts at the root and renderWithProviders does not. Spying on the call is
// how the toast copy stays asserted without standing a toaster up per test.
vi.mock('@/ui-kit/components/ui/sonner', async (importOriginal) =>
  (await import('@/__tests__/harness/inventoryApiStub')).sonnerSpy(await importOriginal<typeof import('@/ui-kit/components/ui/sonner')>()));

const mockToast = vi.mocked(toast);

const h = vi.hoisted(() => ({
  LOC_MAIN: 'aaaaaaa1-0000-4000-8000-000000000001',
  ITEM_ID: 'bbbbbbb1-0000-4000-8000-000000000001',
}));

vi.mock('@/lib/api/inventory', async (importOriginal) => {
  const locations = [
    { id: h.LOC_MAIN, name: 'Main Warehouse', type: 'warehouse', branch: 'HQ' },
  ];
  const item = {
    id: h.ITEM_ID,
    sku: 'FLT-20',
    name: 'Air Filter 20x20',
    category: 'Filters',
    trade: 'hvac',
    kind: 'material',
    uom: 'EA',
    unitCost: 8,
    sellPrice: 25,
    serialized: false,
    hazmat: false,
    trackInventory: true,
    status: 'active',
    vendor: 'Acme Supply',
    stock: [{ locationId: h.LOC_MAIN, onHand: 9 }],
    updatedAt: '2026-07-01T00:00:00.000Z',
  };
  return (await import('@/__tests__/harness/inventoryApiStub')).inventoryApi(
    await importOriginal<typeof import('@/lib/api/inventory')>(),
    {
      reads: {
        useInventoryItems: [item],
        useLocations: locations,
      },
    },
  );
});

// SetQuantityDialog reads the org default as a location fallback.
vi.mock('@/lib/api/shared/organization', async (importOriginal) =>
  (await import('@/__tests__/harness/inventoryApiStub')).organizationApi(await importOriginal<typeof import('@/lib/api/shared/organization')>(), { id: 'org-1', default_inventory_location_id: h.LOC_MAIN }));

const mockApi = vi.mocked(api);

const inventoryAbility = () =>
  buildAbility([
    { action: 'manage', subject: 'Inventory' },
    { action: 'read', subject: 'Invoice' },
  ]);

async function openSetQuantityDialog() {
  const utils = renderInventory({
    entry: '/inventory',
    ability: inventoryAbility(),
  });

  // The seeded row renders, then its kebab opens.
  await screen.findByText('FLT-20');
  await userEvent.click(screen.getAllByLabelText('More actions')[0]!);
  await userEvent.click(await screen.findByText('Set quantity'));

  const dialog = within(await screen.findByRole('dialog'));
  return { ...utils, dialog };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockApi.post.mockResolvedValue({ data: { success: true, on_hand: 7, delta: -2 } });
});

describe('v2 InventoryPage - Set quantity (Inventory P1 §6)', () => {
  it('the kebab offers "Set quantity" and no longer the dead-end "Cycle count"', async () => {
    renderInventory({
      entry: '/inventory',
      ability: inventoryAbility(),
    });

    await screen.findByText('FLT-20');
    await userEvent.click(screen.getAllByLabelText('More actions')[0]!);

    expect(await screen.findByText('Set quantity')).toBeInTheDocument();
    expect(screen.queryByText('Cycle count')).toBeNull();
  });

  it('previews the signed delta (counted 7 vs system 9 → −2, QA-205)', async () => {
    const { dialog } = await openSetQuantityDialog();

    await userEvent.type(dialog.getByLabelText('Counted quantity'), '7');

    // "System shows 9 — this records an adjustment of -2."
    expect(dialog.getByText('9')).toBeInTheDocument();
    expect(dialog.getByText('-2')).toBeInTheDocument();
    expect(dialog.getByText(/records an adjustment of/)).toBeInTheDocument();
  });

  it('submits the count body with the chosen preset reason (rewritten to snake_case), closes, toasts, and invalidates the inventory cache', async () => {
    const { dialog, queryClient } = await openSetQuantityDialog();
    const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries');

    await userEvent.type(dialog.getByLabelText('Counted quantity'), '7');
    await userEvent.click(dialog.getByRole('combobox', { name: /reason/i }));
    await userEvent.click(await screen.findByRole('option', { name: 'Cycle count' }));
    await userEvent.click(dialog.getByRole('button', { name: /set quantity/i }));

    await waitFor(() => {
      expect(mockApi.post).toHaveBeenCalledWith('/api/inventory/stock/set-quantity', {
        item_id: h.ITEM_ID,
        location_id: h.LOC_MAIN,
        counted_qty: 7,
        reason: 'Cycle count',
      });
    });

    // Dialog closes, the page toast reports the recorded count, cache refreshes.
    await waitFor(() => {
      expect(screen.queryByText('Set Quantity (Count)')).toBeNull();
    });
    await waitFor(() =>
      expect(mockToast).toHaveBeenCalledWith(
        expect.stringMatching(/FLT-20: set to 7 at Main Warehouse \(adjust -2\)/),
      ),
    );
    // A stock write now refreshes its own key set rather than the whole
    // ['inventory'] prefix (#1639): the blanket key refetched all 22 inventory
    // queries per write and could exhaust the 100-per-60s API limiter.
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['inventory', 'items'] });
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['inventory', 'movements'] });
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['inventory', 'low-stock'] });
    expect(invalidateSpy).not.toHaveBeenCalledWith({ queryKey: ['inventory'] });
  });

  it('requires a reason preset before submitting (no POST without one)', async () => {
    const { dialog } = await openSetQuantityDialog();

    await userEvent.type(dialog.getByLabelText('Counted quantity'), '7');
    await userEvent.click(dialog.getByRole('button', { name: /set quantity/i }));

    expect(await dialog.findByText('Reason is required.')).toBeInTheDocument();
    expect(mockApi.post).not.toHaveBeenCalled();
  });

  it('requires a note for "Other" and sends the composed "Other: <note>" reason', async () => {
    const { dialog } = await openSetQuantityDialog();

    await userEvent.type(dialog.getByLabelText('Counted quantity'), '7');
    await userEvent.click(dialog.getByRole('combobox', { name: /reason/i }));
    await userEvent.click(await screen.findByRole('option', { name: 'Other' }));

    // "Other" with no note is blocked — no POST.
    await userEvent.click(dialog.getByRole('button', { name: /set quantity/i }));
    expect(await dialog.findByText('Add a note describing the reason.')).toBeInTheDocument();
    expect(mockApi.post).not.toHaveBeenCalled();

    // Adding the note composes the reason that gets sent.
    await userEvent.type(dialog.getByLabelText('Reason note'), 'Shrinkage in bin 4');
    await userEvent.click(dialog.getByRole('button', { name: /set quantity/i }));

    await waitFor(() => {
      expect(mockApi.post).toHaveBeenCalledWith('/api/inventory/stock/set-quantity', {
        item_id: h.ITEM_ID,
        location_id: h.LOC_MAIN,
        counted_qty: 7,
        reason: 'Other: Shrinkage in bin 4',
      });
    });
  });
});
