// Visits-and-task-categories slice 17 - "Add category" inside the Items screen's
// "Add Item" button. The primary part of the button still adds an item; its menu
// offers "Add item", "Add category" and "Manage categories", which open the
// screen's EXISTING category surfaces (the Add category dialog and the category
// filter panel whose rows carry edit/delete). Gated on the price-book abilities
// the category routes enforce (create/update/delete PriceBook).
//
// Harness mirrors stockAbilityGate.test.tsx (the page rendered through the real
// query hooks over a mocked axios).
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, within, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import api from '@/lib/axios';
import { buildAbility } from '@/lib/ability';
import { renderWithProviders } from '@/__tests__/helpers';
import { useInventoryAlertStore } from '@/stores/inventory-alert.store';

import InventoryPage from '@/pages/v2/inventory/InventoryPage';

import type { Category, Item, Location } from '@/lib/api/inventory';

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
global.ResizeObserver = ResizeObserverStub as unknown as typeof ResizeObserver;

const mockApi = vi.mocked(api);
vi.mock('@/lib/axios');

const WAREHOUSE = 'a0000000-0000-0000-0000-0000000000w1';

const LOCATIONS: Location[] = [{ id: WAREHOUSE, name: 'Main Warehouse', type: 'warehouse', branch: 'HQ' }];

const CATEGORIES: Category[] = [
  { id: 'c0000000-0000-4000-8000-000000000001', name: 'Hardware' },
];

const ITEMS: Item[] = [
  {
    id: 'b0000000-0000-0000-0000-00000000b017',
    sku: 'S17-1',
    name: 's17-item',
    category: 'Hardware',
    trade: 'general' as Item['trade'],
    kind: 'material',
    uom: 'EA',
    unitCost: 40,
    sellPrice: 178,
    serialized: false,
    hazmat: false,
    status: 'active',
    vendor: 's17-vendor',
    stock: [{ locationId: WAREHOUSE, onHand: 10, min: 1 }],
    updatedAt: '2026-07-01T00:00:00.000Z',
  },
];

function installGetMock(categories: Category[] = CATEGORIES) {
  mockApi.get.mockImplementation(async (url: string) => {
    if (url.startsWith('/api/inventory/items')) return { data: { data: ITEMS } };
    if (url.startsWith('/api/inventory/locations')) return { data: { locations: LOCATIONS } };
    if (url.startsWith('/api/inventory/categories')) return { data: { categories } };
    if (url.startsWith('/api/inventory/assets')) return { data: { data: [], meta: { total: 0 } } };
    if (url.startsWith('/api/logistic-orders')) return { data: { data: [], page: 1, limit: 50, total: 0 } };
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

const READS = [
  { action: 'read', subject: 'Inventory' },
  { action: 'read', subject: 'PriceBook' },
  { action: 'read', subject: 'PurchaseOrder' },
  { action: 'read', subject: 'Vendor' },
] as const;

const priceBookAbility = (...actions: Array<'create' | 'update' | 'delete'>) =>
  buildAbility([...READS, ...actions.map((action) => ({ action, subject: 'PriceBook' as const }))]);

function renderItems(ability = priceBookAbility('create', 'update', 'delete')) {
  return renderWithProviders(<InventoryPage />, { ability, initialEntries: ['/inventory'] });
}

async function openAddMenu() {
  await userEvent.click(screen.getByRole('button', { name: 'More add options' }));
  return within(await screen.findByRole('menu'));
}

describe('Items "Add Item" split button - menu', () => {
  it('"Add category" opens the existing "Add category" dialog', async () => {
    renderItems();
    await screen.findByText('s17-item');

    const menu = await openAddMenu();
    await userEvent.click(menu.getByRole('menuitem', { name: 'Add category' }));

    expect(await screen.findByRole('dialog', { name: /^add category$/i })).toBeInTheDocument();
  });

  it('a category saved from the menu shows up in the category filter and the item form picker without a reload', async () => {
    mockApi.post.mockImplementation(async (url: string, body?: unknown) => {
      if (url === '/api/price-book/categories') {
        return { data: { data: { id: 'c0000000-0000-4000-8000-000000000017', ...(body as object) } } };
      }
      throw new Error(`unexpected POST ${url}`);
    });
    renderItems();
    await screen.findByText('s17-item');

    await userEvent.click((await openAddMenu()).getByRole('menuitem', { name: 'Add category' }));
    const dialog = within(await screen.findByRole('dialog', { name: /^add category$/i }));
    await userEvent.type(dialog.getByLabelText(/category name/i), 'Weatherstrip');
    await userEvent.click(dialog.getByRole('button', { name: /save category/i }));

    await waitFor(() =>
      expect(mockApi.post).toHaveBeenCalledWith(
        '/api/price-book/categories',
        expect.objectContaining({ name: 'Weatherstrip' }),
      ),
    );
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());

    // The filter: the page now filters by the new category, and it is listed.
    await userEvent.click(screen.getByRole('button', { name: /Weatherstrip/ }));
    expect(await screen.findByRole('button', { name: /^Weatherstrip$/ })).toBeInTheDocument();
    await userEvent.keyboard('{Escape}');

    // The item form's category picker.
    await userEvent.click(screen.getByRole('button', { name: /^add item$/i }));
    const itemDialog = within(await screen.findByRole('dialog'));
    await userEvent.click(itemDialog.getByRole('combobox', { name: 'Category' }));
    expect(await screen.findByRole('option', { name: 'Weatherstrip' })).toBeInTheDocument();
    // One wording on every screen (PRD story 70): the picker's create entry
    // for categories reads "Add category" too; the other pickers keep theirs.
    expect(screen.getByRole('option', { name: '+ Add category…' })).toBeInTheDocument();
    expect(screen.queryByRole('option', { name: /add new category/i })).not.toBeInTheDocument();
  }, 60_000);

  it("keeps the dialog open with the server's message when the name is taken", async () => {
    mockApi.post.mockRejectedValue({
      isAxiosError: true,
      response: { status: 409, data: { error: 'A category named "Hardware" already exists' } },
    });
    renderItems();
    await screen.findByText('s17-item');

    await userEvent.click((await openAddMenu()).getByRole('menuitem', { name: 'Add category' }));
    const dialog = within(await screen.findByRole('dialog', { name: /^add category$/i }));
    await userEvent.type(dialog.getByLabelText(/category name/i), 'Hardware');
    await userEvent.click(dialog.getByRole('button', { name: /save category/i }));

    expect(await dialog.findByText('A category named "Hardware" already exists')).toBeInTheDocument();
    expect(screen.getByRole('dialog', { name: /^add category$/i })).toBeInTheDocument();
  });

  it('"Manage categories" opens the category panel with its edit and delete actions', async () => {
    renderItems();
    await screen.findByText('s17-item');

    await userEvent.click((await openAddMenu()).getByRole('menuitem', { name: 'Manage categories' }));

    expect(await screen.findByRole('textbox', { name: 'Search categories' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Edit Hardware' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Delete Hardware' })).toBeInTheDocument();
    // It stays open: the menu closing must not hand focus back in a way that dismisses it.
    await new Promise((r) => setTimeout(r, 50));
    expect(screen.getByRole('textbox', { name: 'Search categories' })).toBeInTheDocument();
  });

  it('"Manage categories" scrolls the category filter into view when it sits below the fold (phones)', async () => {
    renderItems();
    await screen.findByText('s17-item');
    // On a phone the header actions sit above four stacked stat cards, so the
    // filter pill starts off-screen and its panel would open with no room.
    const pill = screen.getByTitle('Filter items by category');
    pill.getBoundingClientRect = () =>
      ({ top: 930, bottom: 972, left: 15, right: 303, width: 288, height: 42, x: 15, y: 930, toJSON: () => ({}) }) as DOMRect;
    const scrollIntoView = vi.fn();
    pill.scrollIntoView = scrollIntoView;

    await userEvent.click((await openAddMenu()).getByRole('menuitem', { name: 'Manage categories' }));

    await waitFor(() => expect(scrollIntoView).toHaveBeenCalledWith(expect.objectContaining({ block: 'center' })));
    expect(await screen.findByRole('textbox', { name: 'Search categories' })).toBeInTheDocument();
  });

  it('does not scroll when the category filter already has room below it', async () => {
    renderItems();
    await screen.findByText('s17-item');
    const pill = screen.getByTitle('Filter items by category');
    pill.getBoundingClientRect = () =>
      ({ top: 200, bottom: 242, left: 15, right: 303, width: 288, height: 42, x: 15, y: 200, toJSON: () => ({}) }) as DOMRect;
    const scrollIntoView = vi.fn();
    pill.scrollIntoView = scrollIntoView;

    await userEvent.click((await openAddMenu()).getByRole('menuitem', { name: 'Manage categories' }));

    expect(await screen.findByRole('textbox', { name: 'Search categories' })).toBeInTheDocument();
    expect(scrollIntoView).not.toHaveBeenCalled();
  });

  it('"Manage categories" leads to the existing edit dialog', async () => {
    renderItems();
    await screen.findByText('s17-item');

    await userEvent.click((await openAddMenu()).getByRole('menuitem', { name: 'Manage categories' }));
    await userEvent.click(await screen.findByRole('button', { name: 'Edit Hardware' }));

    expect(await screen.findByRole('dialog', { name: /edit category/i })).toBeInTheDocument();
  });
});

describe('Items "Add Item" split button - main part and keyboard', () => {
  it('the main part still opens the Add Item dialog directly, with the menu as a separate control', async () => {
    renderItems();
    await screen.findByText('s17-item');

    const group = screen.getByRole('group', { name: 'Add Item' });
    expect(within(group).getByRole('button', { name: 'More add options' })).toHaveAttribute('aria-haspopup', 'menu');
    await userEvent.click(within(group).getByRole('button', { name: /^add item$/i }));

    expect(await screen.findByRole('dialog')).toBeInTheDocument();
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
    expect(mockApi.post).not.toHaveBeenCalled();
  });

  it('opens from the keyboard, moves with the arrows, and Escape hands focus back to the caret', async () => {
    renderItems();
    await screen.findByText('s17-item');
    const caret = screen.getByRole('button', { name: 'More add options' });

    caret.focus();
    await userEvent.keyboard('{Enter}');
    const menu = within(await screen.findByRole('menu'));
    await waitFor(() => expect(menu.getByRole('menuitem', { name: 'Add item' })).toHaveFocus());
    await userEvent.keyboard('{ArrowDown}');
    expect(menu.getByRole('menuitem', { name: 'Add category' })).toHaveFocus();
    await userEvent.keyboard('{Escape}');

    await waitFor(() => expect(screen.queryByRole('menu')).not.toBeInTheDocument());
    await waitFor(() => expect(caret).toHaveFocus());
  });

  it('Enter on "Add category" opens the "Add category" dialog', async () => {
    renderItems();
    await screen.findByText('s17-item');

    screen.getByRole('button', { name: 'More add options' }).focus();
    await userEvent.keyboard('{ArrowDown}');
    await screen.findByRole('menu');
    await userEvent.keyboard('{ArrowDown}{Enter}');

    expect(await screen.findByRole('dialog', { name: /^add category$/i })).toBeInTheDocument();
  });
});

describe('Items "Add Item" split button - permissions (the category routes enforce create/update/delete PriceBook)', () => {
  it('renders neither part without create PriceBook', async () => {
    renderItems(priceBookAbility('update', 'delete'));
    await screen.findByText('s17-item');

    expect(screen.queryByRole('button', { name: /^add item$/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'More add options' })).not.toBeInTheDocument();
  });

  it('renders neither part for a read-only ability', async () => {
    renderItems(buildAbility([...READS]));
    await screen.findByText('s17-item');

    expect(screen.queryByRole('button', { name: 'More add options' })).not.toBeInTheDocument();
  });

  it('hides "Manage categories" with create but neither update nor delete PriceBook', async () => {
    renderItems(priceBookAbility('create'));
    await screen.findByText('s17-item');

    const menu = await openAddMenu();
    expect(menu.getByRole('menuitem', { name: 'Add item' })).toBeInTheDocument();
    expect(menu.getByRole('menuitem', { name: 'Add category' })).toBeInTheDocument();
    expect(menu.queryByRole('menuitem', { name: 'Manage categories' })).not.toBeInTheDocument();
  });

  it.each([['update' as const], ['delete' as const]])(
    'offers "Manage categories" with create and %s PriceBook',
    async (extra) => {
      renderItems(priceBookAbility('create', extra));
      await screen.findByText('s17-item');

      const menu = await openAddMenu();
      expect(menu.getByRole('menuitem', { name: 'Manage categories' })).toBeInTheDocument();
    },
  );
});

