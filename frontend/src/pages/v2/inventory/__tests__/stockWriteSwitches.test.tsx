import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, within, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import api from '@/lib/axios';
import { renderInventory, serveInventory } from '@/__tests__/harness/inventoryPage';
import type { Item, Location } from '@/lib/api/inventory';
import { abilityWithSwitches, presetSwitchLabels } from '@/__tests__/support/backendSwitchCatalog';
import { useInventoryAlertStore } from '@/stores/inventory-alert.store';
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
 * Roles & Permissions S07.14 - the Stock page's write controls follow the stock switches.
 *
 * Mounted through the routed v2 `InventoryPage`, with the HTTP layer mocked. Every person here is a custom role
 * built from switch values: the ability is compiled from the grants the backend catalog gives each switch (the
 * source of truth, read from the catalog file), never from a role name and never a hand-written grant list.
 * What is asserted is what a person sees, not the shape of a grant.
 */

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
global.ResizeObserver = ResizeObserverStub as unknown as typeof ResizeObserver;

const WAREHOUSE = 'a0000000-0000-0000-0000-0000000000w1';
const ITEM_ID = 'b0000000-0000-0000-0000-00000000b001';

const LOCATIONS: Location[] = [{ id: WAREHOUSE, name: 'Main Warehouse', type: 'warehouse', branch: 'HQ' }];

// One unit on hand against a reserve level of five, so the low-stock count (and with it Generate PO) is live.
const ITEMS: Item[] = [
  {
    id: ITEM_ID, sku: 'HNG-1', name: 'Brass Hinge', category: 'Hardware', trade: 'general' as Item['trade'], kind: 'material',
    uom: 'EA', unitCost: 4, sellPrice: 9, serialized: false, hazmat: false, status: 'active', vendor: 'Supply Co',
    stock: [{ locationId: WAREHOUSE, onHand: 1, min: 5 }], updatedAt: '2026-07-01T00:00:00.000Z',
  },
];

beforeEach(() => {
  vi.clearAllMocks();
  useInventoryAlertStore.setState({ pending: null, nonce: 0 });
  serveInventory({ items: ITEMS, locations: LOCATIONS, routes: [
      { match: (url) => url === '/api/permission-switches/me', data: { admin_box: false, values: { view_stock: true }, rules: [] } },
    ] });
});

/** What every person here may read: the stock page opens, and nothing on it can be written. */
const READ = ['View stock', 'View price book', 'View purchase orders', 'View vendors'];

// A Create switch is passed with the Edit switch it needs (Create price book items needs Edit price book items, Create
// purchase orders needs Edit purchase orders, Create vendors needs Edit vendors).
function renderStock(...writes: string[]) {
  return renderInventory({
    ability: abilityWithSwitches(...READ, ...writes),
    entry: '/inventory',
  });
}

/** Waits for the item row, then opens its detail pane. */
async function openDetail() {
  const cell = await screen.findByText('Brass Hinge');
  await userEvent.click(cell);
  return screen.findByRole('heading', { level: 2, name: 'Brass Hinge' });
}

const button = (name: string | RegExp) => screen.queryByRole('button', { name });

describe('Items tab and item detail - a person with every stock write switch off', () => {
  it('sees no write control on the toolbar, the row, the selectors or the detail pane', async () => {
    renderStock();
    await openDetail();

    for (const name of [/^Restock$/, /^Transfer$/, /^Import CSV$/, /^Add Item$/, /^More add options$/, /^Generate PO/, /^Reserve levels$/, 'Delete item']) {
      expect(button(name), String(name)).not.toBeInTheDocument();
    }
    const row = screen.getAllByText('Brass Hinge')[0]!.closest('tr')!;
    expect(within(row).queryByRole('button', { name: 'More actions' })).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: /All Locations/i }));
    expect(button('Add Location / Van')).not.toBeInTheDocument();
    expect(button('Edit location')).not.toBeInTheDocument();
    expect(button('Delete location')).not.toBeInTheDocument();
  });

  it('still reads the item: quantities, the Edit button turned into a read-only View', async () => {
    renderStock();
    await openDetail();

    expect(screen.getAllByText('Main Warehouse').length).toBeGreaterThan(0);
    expect(screen.getByRole('button', { name: /^View$/ })).toBeInTheDocument();
  });

  it('sees no write control with the Dispatcher preset\'s values for the stock write switches', async () => {
    // The Dispatcher preset's value for every switch, with only the Stock page display switch on top (it is served
    // by the mocked own-switches read), so the page opens.
    const dispatcher = presetSwitchLabels('DISPATCHER').filter(
      (label) => /stock$|price book items$|purchase orders$|vendors$/.test(label),
    );
    expect(dispatcher).toContain('View stock');
    renderInventory({
      ability: abilityWithSwitches(...dispatcher, 'View stock'),
      entry: '/inventory',
    });
    await openDetail();

    for (const name of [/^Restock$/, /^Transfer$/, /^Import CSV$/, /^Add Item$/, /^Generate PO/, /^Reserve levels$/, 'Delete item', 'Add Location / Van']) {
      expect(button(name), String(name)).not.toBeInTheDocument();
    }
  });
});

describe('Items tab and item detail - each write control follows its own switch', () => {
  it('Edit stock gives restock, transfer, reserve levels and the row menu', async () => {
    renderStock('Edit stock');
    await openDetail();

    expect(screen.getAllByRole('button', { name: /^Restock$/ }).length).toBeGreaterThan(0);
    expect(screen.getAllByRole('button', { name: /^Transfer$/ }).length).toBeGreaterThan(0);
    expect(screen.getByRole('button', { name: 'Reserve levels' })).toBeInTheDocument();
    const row = screen.getAllByText('Brass Hinge')[0]!.closest('tr')!;
    expect(within(row).getByRole('button', { name: 'More actions' })).toBeInTheDocument();
    // Edit stock alone does not write the price book, and does not create or delete a location.
    expect(button(/^Import CSV$/)).not.toBeInTheDocument();
    expect(button(/^Add Item$/)).not.toBeInTheDocument();
    expect(button('Delete item')).not.toBeInTheDocument();
  });

  it('Edit stock gives the bulk restock on a selection', async () => {
    renderStock('Edit stock');
    await screen.findByText('Brass Hinge');
    const before = screen.getAllByRole('button', { name: /^Restock$/ }).length;
    await userEvent.click(screen.getByRole('checkbox', { name: 'Select HNG-1' }));

    await waitFor(() => expect(screen.getAllByRole('button', { name: /^Restock$/ }).length).toBe(before + 1));
  });

  it('a selection offers no bulk restock without Edit stock, only Export selected', async () => {
    renderStock('Export stock');
    await screen.findByText('Brass Hinge');
    await userEvent.click(screen.getByRole('checkbox', { name: 'Select HNG-1' }));

    expect(await screen.findByRole('button', { name: /^Export selected$/ })).toBeInTheDocument();
    expect(button(/^Restock$/)).not.toBeInTheDocument();
  });

  it('Create price book items gives add item and import', async () => {
    renderStock('Create price book items', 'Edit price book items');
    await screen.findByText('Brass Hinge');

    expect(screen.getByRole('button', { name: /^Import CSV$/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^Add Item$/ })).toBeInTheDocument();
    expect(button(/^Restock$/)).not.toBeInTheDocument();
  });

  it('Delete price book items gives the delete button on the item', async () => {
    renderStock('Delete price book items');
    await openDetail();

    expect(screen.getByRole('button', { name: 'Delete item' })).toBeInTheDocument();
  });

  it('Create purchase orders gives Generate PO, and only that', async () => {
    renderStock('Create purchase orders', 'Edit purchase orders');
    await screen.findByText('Brass Hinge');

    expect(await screen.findByRole('button', { name: /^Generate PO/ })).toBeInTheDocument();
    expect(button(/^Restock$/)).not.toBeInTheDocument();
    expect(button(/^Add Item$/)).not.toBeInTheDocument();
  });

  it('Create stock gives Add location, Edit stock the edit pencil, Delete stock the delete pencil', async () => {
    renderStock('Create stock', 'Edit stock', 'Delete stock');
    await screen.findByText('Brass Hinge');
    await userEvent.click(screen.getByRole('button', { name: /All Locations/i }));

    expect(screen.getByRole('button', { name: 'Add Location / Van' })).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: 'Edit location' }).length).toBeGreaterThan(0);
    expect(screen.getAllByRole('button', { name: 'Delete location' }).length).toBeGreaterThan(0);
  });
});

describe('Dialogs opened from the Items tab - their own write controls follow the same switches', () => {
  async function openAddItem() {
    await screen.findByText('Brass Hinge');
    await userEvent.click(screen.getByRole('button', { name: /^Add Item$/ }));
    return within(await screen.findByRole('dialog'));
  }

  it('the new item form has no starting-stock section without Edit stock (its quantity write is an Edit stock call)', async () => {
    renderStock('Create price book items', 'Edit price book items');
    const dialog = await openAddItem();

    expect(dialog.getByLabelText(/Item Name/)).toBeInTheDocument();
    expect(dialog.queryByText('Starting Stock')).not.toBeInTheDocument();
  });

  it('the new item form has the starting-stock section with Edit stock', async () => {
    renderStock('Create price book items', 'Edit price book items', 'Edit stock');
    const dialog = await openAddItem();

    expect(dialog.getByText('Starting Stock')).toBeInTheDocument();
  });

  it('the starting-stock location picker offers no new location without Create stock, and offers one with it', async () => {
    const { unmount } = renderStock('Create price book items', 'Edit price book items', 'Edit stock');
    let dialog = await openAddItem();
    await userEvent.click(dialog.getByRole('combobox', { name: 'Starting stock location' }));
    await screen.findByRole('option', { name: 'Main Warehouse' });
    expect(screen.queryByRole('option', { name: /Add new location/ })).not.toBeInTheDocument();
    unmount();

    renderStock('Create price book items', 'Edit price book items', 'Edit stock', 'Create stock');
    dialog = await openAddItem();
    await userEvent.click(dialog.getByRole('combobox', { name: 'Starting stock location' }));
    expect(await screen.findByRole('option', { name: /Add new location/ })).toBeInTheDocument();
  });

  it('the vendor picker offers no new vendor without Create vendors, and offers one with it', async () => {
    const { unmount } = renderStock('Create price book items', 'Edit price book items');
    let dialog = await openAddItem();
    await userEvent.click(dialog.getByRole('combobox', { name: 'Vendor / Source' }));
    await screen.findByRole('option', { name: /Select vendor/ });
    expect(screen.queryByRole('option', { name: /Add new vendor/ })).not.toBeInTheDocument();
    unmount();

    renderStock('Create price book items', 'Edit price book items', 'Create vendors', 'Edit vendors');
    dialog = await openAddItem();
    await userEvent.click(dialog.getByRole('combobox', { name: 'Vendor / Source' }));
    expect(await screen.findByRole('option', { name: /Add new vendor/ })).toBeInTheDocument();
  });

  it('editing a location (Edit stock) offers no new branch without Create stock', async () => {
    renderStock('Edit stock');
    await screen.findByText('Brass Hinge');
    await userEvent.click(screen.getByRole('button', { name: /All Locations/i }));
    await userEvent.click(screen.getAllByRole('button', { name: 'Edit location' })[0]!);
    const dialog = within(await screen.findByRole('dialog'));

    await waitFor(() => expect(dialog.getByRole('textbox', { name: /name/i })).toBeInTheDocument());
    expect(dialog.queryByRole('button', { name: 'Add new branch' })).not.toBeInTheDocument();
  });

  it('editing a location offers a new branch with Create stock', async () => {
    renderStock('Edit stock', 'Create stock');
    await screen.findByText('Brass Hinge');
    await userEvent.click(screen.getByRole('button', { name: /All Locations/i }));
    await userEvent.click(screen.getAllByRole('button', { name: 'Edit location' })[0]!);
    const dialog = within(await screen.findByRole('dialog'));

    expect(await dialog.findByRole('button', { name: 'Add new branch' })).toBeInTheDocument();
  });
});
