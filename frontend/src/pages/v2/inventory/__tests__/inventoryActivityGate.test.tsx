import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, within, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import api from '@/lib/axios';
import { buildAbility, type AbilityRule } from '@/lib/ability';
import { renderInventory, serveInventory } from '@/__tests__/harness/inventoryPage';
import type { Item, Location, Movement } from '@/lib/api/inventory';
import { useAuthStore } from '@/stores/auth.store';

vi.mock('@/lib/axios');

// Each test starts from the setup file's signed-in user and bare client calls: reset them here, so a test states its own user
// and answers in its own `beforeEach` (`clearAllMocks` keeps implementations).
beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(useAuthStore).mockReset();
  vi.mocked(api.get).mockReset();
  vi.mocked(api.post).mockReset();
  vi.mocked(api.patch).mockReset();
  vi.mocked(api.put).mockReset();
  vi.mocked(api.delete).mockReset();
});

/**
 * Roles & Permissions S07.12 - the Activity tab and an item's movement history follow See inventory activity.
 *
 * Mounted through the routed v2 `InventoryPage`, with the HTTP layer mocked. The abilities are built from the
 * grants the server compiles the switches into (read Inventory, see_inventory_activity), never from a role name:
 * the page reads only the ability.
 */

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
global.ResizeObserver = ResizeObserverStub as unknown as typeof ResizeObserver;

const mockApi = vi.mocked(api);

const WAREHOUSE = 'a0000000-0000-0000-0000-0000000000w1';
const ITEM_ID = 'b0000000-0000-0000-0000-00000000b001';

const LOCATIONS: Location[] = [{ id: WAREHOUSE, name: 'Main Warehouse', type: 'warehouse', branch: 'HQ' }];

const ITEMS: Item[] = [
  {
    id: ITEM_ID, sku: 'HNG-1', name: 'Brass Hinge', category: 'Hardware', trade: 'general' as Item['trade'], kind: 'material',
    uom: 'EA', unitCost: 4, sellPrice: 9, serialized: false, hazmat: false, status: 'active', vendor: 'Supply Co',
    stock: [{ locationId: WAREHOUSE, onHand: 12, min: 2 }], updatedAt: '2026-07-01T00:00:00.000Z',
  },
];

const MOVEMENT: Movement = {
  id: 'mv-1', occurredAt: '2026-07-15T10:30:00.000Z', itemSku: 'HNG-1', itemName: 'Brass Hinge', type: 'receive', qty: 7,
  toLocationId: WAREHOUSE, reference: 'PO-77', actor: 'Dana Receiver', itemId: ITEM_ID,
};

const movementCalls = () => mockApi.get.mock.calls.filter((c) => String(c[0]).startsWith('/api/inventory/movements'));

beforeEach(() => {
  vi.clearAllMocks();
  serveInventory({
    items: ITEMS,
    locations: LOCATIONS,
    routes: [
      // The Stock tabs show with View stock (the rule, also read from the person's own switches).
      { match: (url) => url === '/api/permission-switches/me', data: { admin_box: false, values: { view_stock: true }, rules: [] } },
      { match: (url) => url.startsWith('/api/inventory/movements'), data: { data: [MOVEMENT], meta: { page: 1, limit: 25, total: 41, totalPages: 2 } } },
    ],
  });
});

const ACTIVITY = { action: 'see_inventory_activity', subject: 'Inventory' } as const;
const held = (...rules: AbilityRule[]) => buildAbility([{ action: 'read', subject: 'Inventory' }, ...rules]);

function renderAt(path: string, rules: AbilityRule[]) {
  return renderInventory({ entry: path, ability: held(...rules) });
}

describe('Activity tab - See inventory activity', () => {
  it('shows the Activity tab with its count when the switch is on', async () => {
    renderAt('/inventory', [ACTIVITY]);

    const tab = await screen.findByRole('tab', { name: /Activity/ });
    await waitFor(() => expect(within(tab).getByText('41')).toBeInTheDocument());
  });

  it('shows no Activity tab and asks the server for no movements when the switch is off', async () => {
    renderAt('/inventory', []);

    await screen.findByText('Brass Hinge');
    expect(screen.getByRole('tab', { name: /Items/ })).toBeInTheDocument();
    expect(screen.queryByRole('tab', { name: /Activity/ })).not.toBeInTheDocument();
    expect(movementCalls()).toHaveLength(0);
  });

  it('sends a deep link to the Activity tab home when the switch is off, without a refused read', async () => {
    renderAt('/inventory/activity', []);

    expect(await screen.findByText('Brass Hinge')).toBeInTheDocument();
    expect(screen.queryByRole('tab', { name: /Activity/ })).not.toBeInTheDocument();
    expect(movementCalls()).toHaveLength(0);
  });

  it('opens the ledger on the Activity deep link when the switch is on', async () => {
    renderAt('/inventory/activity', [ACTIVITY]);

    expect(await screen.findByText('Dana Receiver')).toBeInTheDocument();
  });
});

describe('item detail movement history - See inventory activity', () => {
  it('shows "Recent Stock Movements" in the item detail when the switch is on', async () => {
    renderAt('/inventory', [ACTIVITY]);

    await userEvent.click(await screen.findByText('Brass Hinge'));

    expect(await screen.findByText('Recent Stock Movements')).toBeInTheDocument();
    expect(await screen.findByText('PO-77')).toBeInTheDocument();
  });

  it('shows no movement history in the item detail when the switch is off, and never asks for it', async () => {
    renderAt('/inventory', []);

    await userEvent.click(await screen.findByText('Brass Hinge'));

    expect(await screen.findByText('By Location')).toBeInTheDocument();
    expect(screen.queryByText('Recent Stock Movements')).not.toBeInTheDocument();
    expect(screen.queryByText('No movements recorded yet.')).not.toBeInTheDocument();
    expect(movementCalls()).toHaveLength(0);
  });
});
