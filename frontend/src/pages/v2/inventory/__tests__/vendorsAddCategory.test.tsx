/**
 * Slice 16 (visits-and-task-categories): "Add category" on the Vendors screen.
 *
 * An office manager can set up vendor categories without opening a vendor
 * form. Three entries - the header button left of "Add Vendor", the empty By
 * Category tab's call to action and the category filter's "+ Add category"
 * row - all open the vendor category manager, the same component the vendor
 * form's picker opens from "Manage categories…". All three are gated on
 * `create Vendor`, the permission POST /api/inventory/vendor-categories checks.
 *
 * Driven through the routed page. The vendor/PO/item queries are stubbed with
 * stable data; the vendor-category query and its create mutation stay REAL
 * over a tiny in-memory "server" behind the axios mock, so a category created
 * in the manager has to reach the filter, the By Category tab and the vendor
 * form's picker through the shared query cache - no reload.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import api from '@/lib/axios';
import { buildAbility } from '@/lib/ability';
import type { VendorCategory } from '@/lib/api/inventory';
import { renderWithProviders, inventoryWriteAbility } from '@/__tests__/helpers';

const hoisted = vi.hoisted(() => {
  const VENDOR = {
    id: 'ddddddd1-0000-4000-8000-000000000001',
    name: 'Harbor Hardware Supply',
    category: '',
    categoryId: null as string | null,
    status: 'active' as 'active' | 'inactive',
    additionalContacts: [],
  };
  const DEFAULT_VENDORS = [VENDOR];
  // Swapped per test for a different, still STABLE, array (an unstable one
  // re-fires the page's seed effect forever).
  return { VENDOR, DEFAULT_VENDORS, vendors: DEFAULT_VENDORS };
});

vi.mock('@/lib/api/inventory', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api/inventory')>();
  const EMPTY: never[] = [];
  const stable =
    <T,>(data: T) =>
    () => ({ data, isLoading: false, isError: false });
  return {
    ...actual, // useVendorCategories + useCreateVendorCategory stay REAL
    useVendors: () => ({ data: hoisted.vendors, isLoading: false, isError: false }),
    usePurchaseOrders: stable(EMPTY),
    useInventoryItems: stable(EMPTY),
  };
});

const { VendorsPage } = await import('@/pages/v2/inventory/VendorsPage');

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
global.ResizeObserver = ResizeObserverStub as unknown as typeof ResizeObserver;

const GLAZING_ID = 'a1000000-0000-4000-8000-000000000a03';
const mockApi = vi.mocked(api);
let server: VendorCategory[];

beforeEach(() => {
  vi.clearAllMocks();
  hoisted.vendors = hoisted.DEFAULT_VENDORS;
  server = [];
  mockApi.get.mockImplementation(async (url: string) => {
    if (url === '/api/inventory/vendor-categories') return { data: { categories: [...server] } };
    return { data: {} };
  });
  mockApi.post.mockImplementation(async (url: string, body?: unknown) => {
    if (url !== '/api/inventory/vendor-categories') return { data: {} };
    const { name } = body as { name: string };
    const row = { id: GLAZING_ID, name, vendorCount: 0 };
    server = [...server, row];
    return { data: { category: row } };
  });
});

// A role with vendor read access but no `create Vendor` (sales, technicians).
const readOnlyAbility = () => buildAbility([{ action: 'read', subject: 'Vendor' }]);

function renderPage(ability = inventoryWriteAbility()) {
  renderWithProviders(<VendorsPage />, { ability, initialEntries: ['/inventory/vendors'] });
}

/** Type a name into the open manager and add it. */
async function addInManager(name: string) {
  const dialog = await screen.findByRole('dialog', { name: /vendor categories/i });
  await userEvent.type(within(dialog).getByLabelText('New category name'), name);
  await userEvent.click(within(dialog).getByRole('button', { name: /^add$/i }));
  await waitFor(() =>
    expect(mockApi.post).toHaveBeenCalledWith('/api/inventory/vendor-categories', { name }),
  );
  return dialog;
}

describe('Vendors screen - "Add category" header button', () => {
  it('sits in the header and opens the category manager; a new category reaches the filter', async () => {
    renderPage();

    await userEvent.click(screen.getByRole('button', { name: 'Add category' }));
    const dialog = await addInManager('Glazing');
    await userEvent.click(within(dialog).getByRole('button', { name: /^done$/i }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());

    // The filter reads the same query: the new name is there without a reload.
    await userEvent.click(screen.getByRole('button', { name: /all categories/i }));
    expect(await screen.findByRole('button', { name: 'Glazing' })).toBeInTheDocument();
  });
});

describe('Vendors screen - duplicate names', () => {
  it("shows the server's duplicate-name message in the manager and adds nothing", async () => {
    server = [{ id: 'a1000000-0000-4000-8000-000000000a01', name: 'Glazing', vendorCount: 0 }];
    mockApi.post.mockRejectedValue({
      response: { status: 409, data: { error: 'CATEGORY_EXISTS', message: 'A category named "Glazing" already exists.' } },
    });
    renderPage();

    await userEvent.click(screen.getByRole('button', { name: 'Add category' }));
    const dialog = await screen.findByRole('dialog', { name: /vendor categories/i });
    await userEvent.type(within(dialog).getByLabelText('New category name'), 'glazing{Enter}');

    expect(await within(dialog).findByRole('alert')).toHaveTextContent('A category named "Glazing" already exists.');
    // Rolled back: only the one real row is listed.
    await waitFor(() => expect(within(dialog).getAllByRole('button', { name: /^rename /i })).toHaveLength(1));
  });
});

describe('Vendors screen - name length', () => {
  // The create and rename routes cap a name at 200 characters (zod .max(200));
  // the inputs stop there so the raw validation message never reaches the user.
  it('stops the new-name and rename boxes at the server limit of 200 characters', async () => {
    server = [{ id: 'a1000000-0000-4000-8000-000000000a01', name: 'Glazing', vendorCount: 0 }];
    renderPage();

    await userEvent.click(screen.getByRole('button', { name: 'Add category' }));
    const dialog = await screen.findByRole('dialog', { name: /vendor categories/i });
    const add = within(dialog).getByLabelText('New category name');
    await userEvent.type(add, 'x'.repeat(205));
    expect(add).toHaveValue('x'.repeat(200));

    await userEvent.click(await within(dialog).findByRole('button', { name: 'Rename Glazing' }));
    const rename = within(dialog).getByLabelText('New name for Glazing');
    await userEvent.type(rename, 'y'.repeat(200));
    expect((rename as HTMLInputElement).value).toHaveLength(200);
  });
});

describe('Vendors screen - "+ Add category" in the category filter', () => {
  it('opens the category manager from the filter dropdown; the new category is listed there', async () => {
    renderPage();

    await userEvent.click(screen.getByRole('button', { name: /all categories/i }));
    // The dropdown's popover (its footer sits outside the listbox itself).
    const panel = await screen.findByRole('dialog');
    expect(within(panel).getByText('No categories yet.')).toBeInTheDocument();
    await userEvent.click(within(panel).getByRole('button', { name: 'Add category' }));

    const dialog = await addInManager('Glazing');
    expect(await within(dialog).findByText('Glazing')).toBeInTheDocument();
    await userEvent.click(within(dialog).getByRole('button', { name: /^done$/i }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());

    await userEvent.click(screen.getByRole('button', { name: /all categories/i }));
    expect(await screen.findByRole('button', { name: 'Glazing' })).toBeInTheDocument();
  });
});

describe('Vendors screen - the empty By Category tab', () => {
  it('offers "Add category"; the new category then shows as a section of the tab', async () => {
    renderPage();
    await userEvent.click(screen.getByRole('tab', { name: /by category/i }));

    const tab = screen.getByRole('tabpanel');
    expect(await within(tab).findByText('No vendor categories yet')).toBeInTheDocument();
    await userEvent.click(within(tab).getByRole('button', { name: 'Add category' }));

    const dialog = await addInManager('Glazing');
    await userEvent.click(within(dialog).getByRole('button', { name: /^done$/i }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());

    const after = screen.getByRole('tabpanel');
    expect(await within(after).findByRole('heading', { name: /glazing/i })).toBeInTheDocument();
    expect(within(after).queryByText('No vendor categories yet')).not.toBeInTheDocument();
    // The vendor with no category is still grouped under Uncategorized.
    expect(within(after).getByRole('heading', { name: /uncategorized/i })).toBeInTheDocument();
  });
});

describe('Vendors screen - a category added there reaches the vendor form', () => {
  it("is offered by the Add Vendor form's category picker without a reload", async () => {
    renderPage();

    await userEvent.click(screen.getByRole('button', { name: 'Add category' }));
    const dialog = await addInManager('Glazing');
    await userEvent.click(within(dialog).getByRole('button', { name: /^done$/i }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());

    await userEvent.click(screen.getByRole('button', { name: /add vendor/i }));
    const form = await screen.findByRole('dialog');
    await userEvent.click(within(form).getByRole('combobox'));
    expect(await screen.findByRole('option', { name: 'Glazing' })).toBeInTheDocument();
    // Still the picker's own entry, not a second inline "add" row.
    expect(screen.getByRole('option', { name: 'Manage categories…' })).toBeInTheDocument();
    expect(screen.queryByRole('option', { name: /add (new )?category/i })).not.toBeInTheDocument();
  });
});

describe('Vendors screen - "Add category" permission gate (create Vendor)', () => {
  // The dispatcher's default grant: every Vendor verb, no `manage` row.
  const dispatcherAbility = () =>
    buildAbility(
      (['read', 'create', 'update', 'delete'] as const).map((action) => ({ action, subject: 'Vendor' })),
    );

  /** Whether each entry is on screen (the filter's is read while its dropdown is open). */
  async function entries() {
    const header = screen.queryByRole('button', { name: 'Add category' }) !== null;
    await userEvent.click(screen.getByRole('button', { name: /all categories/i }));
    const filter = within(await screen.findByRole('dialog')).queryByRole('button', { name: 'Add category' }) !== null;
    await userEvent.keyboard('{Escape}');
    await userEvent.click(screen.getByRole('tab', { name: /by category/i }));
    const tab = screen.getByRole('tabpanel');
    await within(tab).findByText('No vendor categories yet');
    const empty = within(tab).queryByRole('button', { name: 'Add category' }) !== null;
    return { header, filter, empty };
  }

  it('hides all three entries from a role that can read vendors but not create them', async () => {
    renderPage(readOnlyAbility());
    const { header, filter, empty } = await entries();

    expect({ header, filter, empty }).toEqual({ header: false, filter: false, empty: false });
    // The empty state still explains the tab; it just offers no action.
    expect(screen.queryByRole('button', { name: /add vendor/i })).not.toBeInTheDocument();
  });

  it('shows all three entries to a dispatcher (create Vendor, no manage row)', async () => {
    renderPage(dispatcherAbility());
    const { header, filter, empty } = await entries();

    expect({ header, filter, empty }).toEqual({ header: true, filter: true, empty: true });
  });
});

describe('Vendors screen - By Category sections for categories without active vendors', () => {
  const STOREFRONT_ID = 'a1000000-0000-4000-8000-000000000a09';
  const ARCHIVED = [
    {
      ...hoisted.VENDOR,
      id: 'ddddddd1-0000-4000-8000-000000000009',
      name: 'Old Storefront Glass',
      category: 'Storefront',
      categoryId: STOREFRONT_ID,
      status: 'inactive' as const,
    },
  ];

  beforeEach(() => {
    hoisted.vendors = ARCHIVED;
    server = [{ id: STOREFRONT_ID, name: 'Storefront', vendorCount: 1 }];
  });

  async function openByCategory() {
    renderPage();
    await userEvent.click(screen.getByRole('tab', { name: /by category/i }));
    // The list has loaded once the tab badge counts the one row.
    await waitFor(() => expect(screen.getByRole('tab', { name: /by category/i })).toHaveTextContent('1'));
    return screen.getByRole('tabpanel');
  }

  it('does not call a category whose only vendor is archived empty under the Active filter', async () => {
    const tab = await openByCategory();

    expect(within(tab).queryByText('No vendors in this category yet.')).not.toBeInTheDocument();
    expect(within(tab).queryByRole('heading', { name: /storefront/i })).not.toBeInTheDocument();
    expect(within(tab).getByText('No vendors match your filters.')).toBeInTheDocument();
  });

  it('lists the archived vendor under its category with the Inactive filter', async () => {
    await openByCategory();
    await userEvent.click(screen.getByRole('button', { name: /^inactive$/i }));

    const tab = screen.getByRole('tabpanel');
    expect(within(tab).getByRole('heading', { name: /storefront/i })).toBeInTheDocument();
    expect(within(tab).getByText('Old Storefront Glass')).toBeInTheDocument();
    expect(within(tab).queryByText('No vendors in this category yet.')).not.toBeInTheDocument();
  });
});
