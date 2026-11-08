// #2043 slice 1 - new RED/GREEN pairs for gates the frozen
// `repro-2043.test.tsx` does not pin (R14: every new gate needs its own
// pair). The frozen test is read-only; these cases live here, mirroring
// `priceBookAbilityGate.test.tsx`'s shape (#2009 prior art).
//
// Covers:
//   1. The Stock row kebab (R1, itemsColumns.tsx) - "More actions" trigger.
//   2. LocationSelector's "Add Location / Van" footer CTA.
//   3. CategorySelector's "Add category" footer CTA.
//   4. Location per-row edit/delete for a DISPATCHER-shaped ability
//      (update+delete Inventory, no manage Inventory) - AC10.
//   5. LowStockActionDialog's "Restock now" (R5).
//   6. AddLocationDialog surfaces a rejected save (R6/AC11).
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, within, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import api from '@/lib/axios';
import { buildAbility } from '@/lib/ability';
import { renderWithProviders } from '@/__tests__/helpers';
import { useInventoryAlertStore } from '@/stores/inventory-alert.store';

import InventoryPage from '@/pages/v2/inventory/InventoryPage';

import type { Item, Location } from '@/lib/api/inventory';

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
global.ResizeObserver = ResizeObserverStub as unknown as typeof ResizeObserver;

const mockApi = vi.mocked(api);
vi.mock('@/lib/axios');

const WAREHOUSE = 'a0000000-0000-0000-0000-0000000000w1';
const COUNTER = 'a0000000-0000-0000-0000-0000000000w2';
const ITEM_ID = 'b0000000-0000-0000-0000-00000000b001';

const LOCATIONS: Location[] = [
  { id: WAREHOUSE, name: 'Main Warehouse', type: 'warehouse', branch: 'HQ' },
  { id: COUNTER, name: 'Front Counter', type: 'counter', branch: 'HQ' },
];

const ITEMS: Item[] = [
  {
    id: ITEM_ID,
    sku: 'QA2043-1',
    name: 'qa-2043-item',
    category: 'Hardware',
    trade: 'general' as Item['trade'],
    kind: 'material',
    uom: 'EA',
    unitCost: 40,
    sellPrice: 178,
    serialized: false,
    hazmat: false,
    status: 'active',
    vendor: 'qa-2043-vendor',
    stock: [{ locationId: WAREHOUSE, onHand: 1, min: 5 }],
    updatedAt: '2026-07-01T00:00:00.000Z',
  },
];

function installGetMock() {
  mockApi.get.mockImplementation(async (url: string) => {
    if (url.startsWith('/api/inventory/items')) return { data: { data: ITEMS } };
    if (url.startsWith('/api/inventory/locations')) return { data: { locations: LOCATIONS } };
    if (url.startsWith('/api/inventory/assets')) return { data: { data: [], meta: { total: 0 } } };
    if (url.startsWith('/api/inventory/vendors')) return { data: { vendors: [] } };
    if (url.startsWith('/api/inventory/purchase-orders')) return { data: { purchaseOrders: [] } };
    if (url.startsWith('/api/inventory/job-stages')) return { data: { jobStages: [] } };
    if (url.startsWith('/api/inventory/techs')) return { data: { techs: [] } };
    if (url.startsWith('/api/logistic-orders')) return { data: { data: [], page: 1, limit: 50, total: 0 } };
    if (url.startsWith('/api/users')) return { data: { users: [] } };
    return {
      data: {
        data: [], meta: { page: 1, limit: 1, total: 0, totalPages: 1 },
        locations: [], vendors: [], categories: [], branches: [], brands: [],
        stages: [], assets: [], total: 0, jobStages: [], purchaseOrders: [],
        users: [], finishes: [], techs: [], itemGroups: [],
      },
    };
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  installGetMock();
  mockApi.post.mockResolvedValue({ data: { success: true } });
  useInventoryAlertStore.setState({ pending: null, nonce: 0 });
});

const readOnlyAbility = () =>
  buildAbility([
    { action: 'read', subject: 'Inventory' },
    { action: 'read', subject: 'PriceBook' },
    { action: 'read', subject: 'PurchaseOrder' },
    { action: 'read', subject: 'Vendor' },
  ]);

const fullWriteAbility = () =>
  buildAbility([
    { action: 'read', subject: 'Inventory' },
    { action: 'create', subject: 'Inventory' },
    { action: 'update', subject: 'Inventory' },
    { action: 'delete', subject: 'Inventory' },
    { action: 'read', subject: 'PriceBook' },
    { action: 'create', subject: 'PriceBook' },
    { action: 'update', subject: 'PriceBook' },
    { action: 'delete', subject: 'PriceBook' },
    { action: 'read', subject: 'PurchaseOrder' },
    { action: 'create', subject: 'PurchaseOrder' },
    { action: 'read', subject: 'Vendor' },
  ]);

// AC10 - the DISPATCHER-shaped ability: create/update/delete Inventory,
// deliberately WITHOUT `manage Inventory` (defaultGrants.ts:272-275).
const dispatcherShapedAbility = () =>
  buildAbility([
    { action: 'read', subject: 'Inventory' },
    { action: 'create', subject: 'Inventory' },
    { action: 'update', subject: 'Inventory' },
    { action: 'delete', subject: 'Inventory' },
    { action: 'read', subject: 'PriceBook' },
    { action: 'read', subject: 'PurchaseOrder' },
    { action: 'read', subject: 'Vendor' },
  ]);

function renderStock(ability: ReturnType<typeof readOnlyAbility>) {
  return renderWithProviders(<InventoryPage />, { ability, initialEntries: ['/inventory'] });
}

// ─── 1. Row kebab (R1) ──────────────────────────────────────────────────
describe('#2043 — Stock row kebab (itemsColumns.tsx)', () => {
  it('renders no "More actions" trigger on the item row for a read-only ability', async () => {
    renderStock(readOnlyAbility());
    const row = (await screen.findByText('qa-2043-item')).closest('tr')!;

    expect(within(row).queryByRole('button', { name: 'More actions' })).not.toBeInTheDocument();
  });

  it('opens all eight entries for a write ability', async () => {
    renderStock(fullWriteAbility());
    const row = (await screen.findByText('qa-2043-item')).closest('tr')!;

    await userEvent.click(within(row).getByRole('button', { name: 'More actions' }));
    const menu = within(await screen.findByRole('menu'));

    expect(menu.getByRole('menuitem', { name: 'Edit item' })).toBeInTheDocument();
    expect(menu.getByRole('menuitem', { name: 'Restock' })).toBeInTheDocument();
    expect(menu.getByRole('menuitem', { name: 'Transfer stock' })).toBeInTheDocument();
    expect(menu.getByRole('menuitem', { name: 'Create PO' })).toBeInTheDocument();
    expect(menu.getByRole('menuitem', { name: 'Set quantity' })).toBeInTheDocument();
    expect(menu.getByRole('menuitem', { name: 'Reserve levels' })).toBeInTheDocument();
    expect(menu.getByRole('menuitem', { name: 'Delete item' })).toBeInTheDocument();
  });
});

// ─── 2 & 4. LocationSelector footer + per-row edit/delete ─────────────
describe('#2043 — LocationSelector (Stock toolbar Showing row)', () => {
  async function openLocations() {
    await userEvent.click(screen.getByRole('button', { name: /All Locations/i }));
  }

  it('hides "Add Location / Van" without create Inventory', async () => {
    renderStock(readOnlyAbility());
    await screen.findByText('qa-2043-item');
    await openLocations();

    expect(screen.queryByRole('button', { name: 'Add Location / Van' })).not.toBeInTheDocument();
  });

  it('shows "Add Location / Van" with create Inventory', async () => {
    renderStock(fullWriteAbility());
    await screen.findByText('qa-2043-item');
    await openLocations();

    expect(screen.getByRole('button', { name: 'Add Location / Van' })).toBeInTheDocument();
  });

  it('shows the per-row edit/delete affordances for update+delete Inventory without manage Inventory (AC10)', async () => {
    renderStock(dispatcherShapedAbility());
    await screen.findByText('qa-2043-item');
    await openLocations();

    // Two locations render (Main Warehouse, Front Counter) - each row carries
    // its own edit/delete pair, so at least one of each must be present.
    expect(screen.getAllByRole('button', { name: 'Edit location' }).length).toBeGreaterThan(0);
    expect(screen.getAllByRole('button', { name: 'Delete location' }).length).toBeGreaterThan(0);
  });

  it('hides the per-row edit/delete affordances for a read-only ability', async () => {
    renderStock(readOnlyAbility());
    await screen.findByText('qa-2043-item');
    await openLocations();

    expect(screen.queryByRole('button', { name: 'Edit location' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Delete location' })).not.toBeInTheDocument();
  });
});

// ─── 3. CategorySelector footer ────────────────────────────────────────
describe('#2043 — CategorySelector (Stock toolbar Showing row)', () => {
  async function openCategories() {
    await userEvent.click(screen.getByRole('button', { name: /All Categories/i }));
  }

  it('hides "Add category" without create PriceBook', async () => {
    renderStock(readOnlyAbility());
    await screen.findByText('qa-2043-item');
    await openCategories();

    expect(screen.queryByRole('button', { name: 'Add category' })).not.toBeInTheDocument();
  });

  it('shows "Add category" with create PriceBook', async () => {
    renderStock(fullWriteAbility());
    await screen.findByText('qa-2043-item');
    await openCategories();

    expect(screen.getByRole('button', { name: 'Add category' })).toBeInTheDocument();
  });
});

// ─── 5. LowStockActionDialog (R5) ──────────────────────────────────────
describe('#2043 — LowStockActionDialog (reached from the TopBar bell)', () => {
  function emitLowStockAlert() {
    useInventoryAlertStore.getState().emit({
      id: 'alert-1',
      kind: 'low_stock',
      severity: 'warning',
      title: 'Low stock',
      subtitle: 'qa-2043-item is low',
      ref: { itemSku: 'QA2043-1' },
    });
  }

  it('hides "Restock now" for a read-only ability, keeps Close', async () => {
    renderStock(readOnlyAbility());
    await screen.findByText('qa-2043-item');
    emitLowStockAlert();

    await screen.findByText(/Low stock · QA2043-1/);
    expect(screen.queryByRole('button', { name: /Restock now/i })).not.toBeInTheDocument();
    // Two "Close"-named buttons: the Modal's own X plus the footer's dismiss
    // control - same shape as priceBookAbilityGate.test.tsx.
    expect(screen.getAllByRole('button', { name: 'Close' }).length).toBeGreaterThan(0);
  });

  it('shows "Restock now" with update Inventory, keeps Close', async () => {
    renderStock(fullWriteAbility());
    await screen.findByText('qa-2043-item');
    emitLowStockAlert();

    await screen.findByText(/Low stock · QA2043-1/);
    expect(screen.getByRole('button', { name: /Restock now/i })).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: 'Close' }).length).toBeGreaterThan(0);
  });
});

// ─── 6. AddLocationDialog surfaces a rejected save (R6/AC11) ──────────
describe('#2043 — AddLocationDialog rejected save (R6/AC11)', () => {
  it('stays open, keeps the typed name, and renders the server message', async () => {
    mockApi.post.mockImplementation(async (url: string) => {
      if (url === '/api/inventory/locations') {
        const err = new Error('Validation failed') as Error & {
          response: { data: { error: string; details: Array<{ field: string; message: string }> } };
        };
        err.response = {
          data: {
            error: 'Validation failed',
            details: [{ field: 'name', message: 'String must contain at most 200 character(s)' }],
          },
        };
        throw err;
      }
      return { data: { success: true } };
    });

    renderStock(fullWriteAbility());
    await screen.findByText('qa-2043-item');
    await userEvent.click(screen.getByRole('button', { name: /All Locations/i }));
    await userEvent.click(screen.getByRole('button', { name: 'Add Location / Van' }));

    const dialog = await screen.findByRole('dialog');
    const nameInput = within(dialog).getByPlaceholderText(/Carlos's Van/i);
    const tooLongName = 'x'.repeat(201);
    await userEvent.type(nameInput, tooLongName);
    await userEvent.click(within(dialog).getByRole('button', { name: 'Create Location' }));

    await waitFor(() => {
      expect(
        within(dialog).getByText('name: String must contain at most 200 character(s)'),
      ).toBeInTheDocument();
    });
    // Dialog stayed open with the typed value intact - not "please try again".
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(nameInput).toHaveValue(tooLongName);
    expect(within(dialog).queryByText(/please try again/i)).not.toBeInTheDocument();
  });
});
