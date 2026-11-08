// SRVW-93 - the remaining fake inventory writes on the Stock page.
//
// Contract under test: category create/rename/delete, vendor create, branch
// create, and item-create's Starting Qty all POST/PATCH/DELETE for real
// instead of only mutating local React state with a fabricated id - and a
// server rejection surfaces an honest error instead of a false success toast.
// The bulk-stage transfer arm is proven DISABLED (no fake success, no API
// call) rather than wired, per the SRVW-93 escalation.
//
// Seam hooks are mocked with stable resolved data for the READ side only
// (jsdom seed-loop landmine - see purchase-orders-deeplink.test.tsx, the
// sanctioned pattern). Every WRITE hook (useUpsertCategory/useUpsertVendor/
// useUpsertBranch/useDeleteCategory/useUpsertItem/useSetQuantity/etc.) is left
// REAL so its POST/PATCH/DELETE actually hits the setup-mocked axios.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import api from '@/lib/axios';
import { renderWithProviders, inventoryWriteAbility } from './helpers';
import InventoryPage from '@/pages/v2/inventory/InventoryPage';
import { toPriceBookBody } from '@/lib/api/inventory';

import { toast } from '@/ui-kit/components/ui/sonner';

// The routed page reports through the kit's sonner toaster, which App.tsx
// mounts at the root and renderWithProviders does not. Spying on the call is
// how the toast copy stays asserted without standing a toaster up per test.
vi.mock('@/ui-kit/components/ui/sonner', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/ui-kit/components/ui/sonner')>()),
  toast: vi.fn(),
}));

const mockToast = vi.mocked(toast);

const h = vi.hoisted(() => ({
  LOC_WH: 'aaaaaaa1-0000-4000-8000-000000000001',
  LOC_VAN: 'aaaaaaa1-0000-4000-8000-000000000002',
  CAT_ID: 'ccccccc1-0000-4000-8000-000000000001',
  CAT_UNUSED_ID: 'ccccccc1-0000-4000-8000-000000000002',
  CAT_UNUSED2_ID: 'ccccccc1-0000-4000-8000-000000000003',
  ITEM_ID: 'bbbbbbb1-0000-4000-8000-000000000001',
}));

vi.mock('@/lib/api/inventory', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api/inventory')>();
  const EMPTY: never[] = [];
  const stable =
    <T,>(data: T) =>
    () => ({ data, isLoading: false, isError: false });
  const locations = [
    { id: h.LOC_WH, name: 'Main Warehouse', type: 'warehouse', branch: 'HQ' },
    { id: h.LOC_VAN, name: "Mike's Van", type: 'truck', branch: 'HQ' },
  ];
  const categories = [
    { id: h.CAT_ID, name: 'Filters' },
    { id: h.CAT_UNUSED_ID, name: 'Bulbs' },
    { id: h.CAT_UNUSED2_ID, name: 'Widgets' },
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
    stock: [
      { locationId: h.LOC_WH, onHand: 10 },
      { locationId: h.LOC_VAN, onHand: 0 },
    ],
    updatedAt: '2026-07-01T00:00:00.000Z',
  };
  return {
    ...actual,
    useInventoryItems: stable([item]),
    useLocations: stable(locations),
    useVendors: stable(EMPTY),
    useCategories: stable(categories),
    useBranches: stable(EMPTY),
    useBrands: stable(EMPTY),
    useJobStages: stable(EMPTY),
    useMovements: stable(EMPTY),
    useInventoryJobs: stable(EMPTY),
    usePurchaseOrders: stable(EMPTY),
  };
});

// AddItemDialog + AddLocationDialog read the org default inventory location.
vi.mock('@/lib/api/organization', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api/organization')>();
  return {
    ...actual,
    useOrganization: () => ({
      data: { id: 'org-1', default_inventory_location_id: h.LOC_WH },
      isLoading: false,
      isError: false,
    }),
  };
});

const mockApi = vi.mocked(api);

// #2043 - InventoryPage now gates the Add Item / Import CSV toolbar on
// 'create PriceBook', not 'manage Inventory' - inventoryWriteAbility() (no
// 'manage' row of any kind, per R14) is the shared write ability the
// module's suites converge on.
const inventoryAbility = () => inventoryWriteAbility();

function render() {
  return renderWithProviders(<InventoryPage />, {
    initialEntries: ['/inventory'],
    ability: inventoryAbility(),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('Category create on the Stock page (SRVW-93)', () => {
  it('POSTs /api/price-book/categories exactly once and no fabricated id reaches the list', async () => {
    mockApi.post.mockResolvedValue({
      data: { data: { id: 'ccccccc1-0000-4000-8000-0000000000aa', name: 'Thermostats' } },
    });
    render();

    await screen.findByText('FLT-20');
    await userEvent.click(screen.getByTitle('Filter items by category'));
    await userEvent.click(await screen.findByText('Add category'));

    const dialog = within(await screen.findByRole('dialog'));
    await userEvent.type(dialog.getByLabelText(/category name/i), 'Thermostats');
    await userEvent.click(dialog.getByRole('button', { name: /save category/i }));

    await waitFor(() => {
      expect(mockApi.post).toHaveBeenCalledWith(
        '/api/price-book/categories',
        expect.objectContaining({ name: 'Thermostats' }),
      );
    });
    expect(mockApi.post).toHaveBeenCalledTimes(1);
  });

  it('a rejected category POST leaves the dialog open with no success toast', async () => {
    mockApi.post.mockRejectedValue(new Error('boom'));
    render();

    await screen.findByText('FLT-20');
    await userEvent.click(screen.getByTitle('Filter items by category'));
    await userEvent.click(await screen.findByText('Add category'));

    const dialog = within(await screen.findByRole('dialog'));
    await userEvent.type(dialog.getByLabelText(/category name/i), 'Thermostats');
    await userEvent.click(dialog.getByRole('button', { name: /save category/i }));

    await waitFor(() => {
      expect(mockApi.post).toHaveBeenCalled();
    });
    // Dialog is still open with an inline error - not a success toast.
    expect(await screen.findByRole('dialog')).toBeInTheDocument();
    expect(screen.queryByText(/added - now filtering/)).toBeNull();
  });
});

describe('Category rename + delete on the Stock page (SRVW-93)', () => {
  it('renaming an existing category PATCHes it', async () => {
    mockApi.patch.mockResolvedValue({ data: { data: { id: h.CAT_ID, name: 'Air Filters' } } });
    render();

    await screen.findByText('FLT-20');
    await userEvent.click(screen.getByTitle('Filter items by category'));
    await userEvent.click(await screen.findByRole('listbox').then((lb) => within(lb).getByLabelText('Edit Filters')));

    const dialog = within(await screen.findByRole('dialog'));
    const nameInput = dialog.getByLabelText(/category name/i);
    await userEvent.clear(nameInput);
    await userEvent.type(nameInput, 'Air Filters');
    await userEvent.click(dialog.getByRole('button', { name: /save changes/i }));

    await waitFor(() => {
      expect(mockApi.patch).toHaveBeenCalledWith(
        `/api/price-book/categories/${h.CAT_ID}`,
        expect.objectContaining({ name: 'Air Filters' }),
      );
    });
  });

  it('deleting an unused category DELETEs it; a server 400 leaves it on screen with an honest toast', async () => {
    mockApi.delete.mockResolvedValueOnce({ data: { message: 'Category deleted' } });
    render();

    await screen.findByText('FLT-20');
    await userEvent.click(screen.getByTitle('Filter items by category'));
    await userEvent.click(within(await screen.findByRole('listbox')).getByLabelText('Delete Bulbs'));
    await userEvent.click(await screen.findByRole('button', { name: 'Delete' }));

    await waitFor(() => {
      expect(mockApi.delete).toHaveBeenCalledWith(`/api/price-book/categories/${h.CAT_UNUSED_ID}`);
    });
    await waitFor(() =>
      expect(mockToast).toHaveBeenCalledWith(expect.stringMatching(/Category "Bulbs" deleted/)),
    );

    // A second, also locally-unused category: the server rejects anyway,
    // representing the routine divergence between the page's by-NAME guard
    // and the server's by-FK count.
    //
    // The popover must be REOPENED here. It used to survive a delete, because the old
    // `window.confirm` blocked the whole renderer without ever taking DOM focus. The app's own
    // dialog is a real focus-trapping layer, so dismissing it dismisses the popover underneath
    // too - a deliberate consequence of the swap, asserted rather than worked around.
    mockApi.delete.mockRejectedValueOnce({ response: { status: 400, data: { error: 'Cannot delete category with items' } } });
    await userEvent.click(screen.getByTitle('Filter items by category'));
    await userEvent.click(within(await screen.findByRole('listbox')).getByLabelText('Delete Widgets'));
    await userEvent.click(await screen.findByRole('button', { name: 'Delete' }));

    await waitFor(() => {
      expect(mockApi.delete).toHaveBeenCalledWith(`/api/price-book/categories/${h.CAT_UNUSED2_ID}`);
    });
    await waitFor(() =>
      expect(mockToast).toHaveBeenCalledWith(
        expect.stringMatching(/Could not delete the category "Widgets"/),
      ),
    );
    // The row is still there - it was never removed from local state.
    await userEvent.click(screen.getByTitle('Filter items by category'));
    expect(within(await screen.findByRole('listbox')).getByText('Widgets')).toBeInTheDocument();
  });
});

describe('Vendor + category created inline from Add Item (SRVW-93)', () => {
  // 120s, not 30s. This case already ran within a few seconds of the default
  // cap, and it goes over it intermittently now that `SelectField`'s §4.2
  // branch puts `components/ui/combobox` (Popover + Input + icons) in the
  // import graph of every page that renders a dropdown. Measured standalone
  // it is ~10% slower than before that branch; the rest of the margin is
  // whatever else shares the machine, the same contention the 180s cap in
  // design-system/__tests__/unresolved-classes-guard.test.ts documents.
  //
  // NOTHING here changed behaviour: both dropdowns this test drives are
  // still plain selects (Vendor / Source has 3 options, Category has 7), so
  // neither one reaches the 10-option rule. A timeout would read as a broken
  // write path, which is exactly the signal this file exists to keep
  // trustworthy - hence a cap that clears the contended case.
  it('vendor created inline is persisted and the item save carries the server UUID as vendor_id', async () => {
    mockApi.post.mockImplementation((url: string, body?: unknown) => {
      if (url === '/api/inventory/vendors') {
        return Promise.resolve({ data: { vendor: { id: 'ddddddd1-0000-4000-8000-000000000001', name: 'ADI Supply' } } });
      }
      if (url === '/api/price-book/items') {
        return Promise.resolve({ data: { data: { id: 'eeeeeee1-0000-4000-8000-000000000001', ...(body as object) } } });
      }
      return Promise.reject(new Error(`unexpected POST ${url}`));
    });
    render();

    await screen.findByText('FLT-20');
    await userEvent.click(screen.getByRole('button', { name: /add item/i }));
    const dialog = within(await screen.findByRole('dialog'));

    // The creator is reached through the dropdown's own "+ Add new vendor…"
    // entry. The separate + button beside the select was removed - two routes
    // into one dialog was the inconsistency, not a convenience.
    await userEvent.click(dialog.getByRole('combobox', { name: 'Vendor / Source' }));
    await userEvent.click(await screen.findByRole('option', { name: /add new vendor/i }));
    const vendorDialog = within(await screen.findByRole('dialog', { name: /add new vendor/i }));
    await userEvent.type(vendorDialog.getByLabelText(/vendor name/i), 'ADI Supply');
    await userEvent.click(vendorDialog.getByRole('button', { name: /save vendor/i }));

    await waitFor(() => {
      expect(mockApi.post).toHaveBeenCalledWith('/api/inventory/vendors', expect.objectContaining({ name: 'ADI Supply' }));
    });

    await userEvent.type(dialog.getByPlaceholderText(/Dual Run Capacitor/), 'New Widget');
    // SKU is required since the 2026-08-12 restructure - it used to be minted
    // silently from the name on save.
    await userEvent.type(dialog.getByLabelText(/^SKU/), 'WIDGET-1');
    await userEvent.click(dialog.getByRole('button', { name: /save item/i }));

    await waitFor(() => {
      expect(mockApi.post).toHaveBeenCalledWith(
        '/api/price-book/items',
        expect.objectContaining({ vendor_id: 'ddddddd1-0000-4000-8000-000000000001' }),
      );
    });
  }, 120000);

  // 120s for the same reason as the vendor case above.
  it('category created inline is persisted and the item save carries the server UUID as category_id', async () => {
    mockApi.post.mockImplementation((url: string, body?: unknown) => {
      if (url === '/api/price-book/categories') {
        return Promise.resolve({ data: { data: { id: 'fffffff1-0000-4000-8000-000000000001', name: 'Thermostats' } } });
      }
      if (url === '/api/price-book/items') {
        return Promise.resolve({ data: { data: { id: 'eeeeeee1-0000-4000-8000-000000000002', ...(body as object) } } });
      }
      return Promise.reject(new Error(`unexpected POST ${url}`));
    });
    render();

    await screen.findByText('FLT-20');
    await userEvent.click(screen.getByRole('button', { name: /add item/i }));
    const dialog = within(await screen.findByRole('dialog'));

    // Same single route as the vendor case above.
    await userEvent.click(dialog.getByRole('combobox', { name: 'Category' }));
    await userEvent.click(await screen.findByRole('option', { name: '+ Add category…' }));
    const categoryDialog = within(await screen.findByRole('dialog', { name: /^add category$/i }));
    await userEvent.type(categoryDialog.getByLabelText(/category name/i), 'Thermostats');
    await userEvent.click(categoryDialog.getByRole('button', { name: /save category/i }));

    await waitFor(() => {
      expect(mockApi.post).toHaveBeenCalledWith('/api/price-book/categories', expect.objectContaining({ name: 'Thermostats' }));
    });

    await userEvent.type(dialog.getByPlaceholderText(/Dual Run Capacitor/), 'New Widget');
    // SKU is required since the 2026-08-12 restructure - it used to be minted
    // silently from the name on save.
    await userEvent.type(dialog.getByLabelText(/^SKU/), 'WIDGET-1');
    await userEvent.click(dialog.getByRole('button', { name: /save item/i }));

    await waitFor(() => {
      expect(mockApi.post).toHaveBeenCalledWith(
        '/api/price-book/items',
        expect.objectContaining({ category_id: 'fffffff1-0000-4000-8000-000000000001' }),
      );
    });
  }, 120000);
});

describe('Branch created from Add Location (SRVW-93)', () => {
  it('POSTs /api/inventory/branches and the location create sends the server UUID as branch_id', async () => {
    mockApi.post.mockImplementation((url: string) => {
      if (url === '/api/inventory/branches') {
        return Promise.resolve({ data: { branch: { id: '11111111-0000-4000-8000-000000000001', name: 'Long Island' } } });
      }
      if (url === '/api/inventory/locations') {
        return Promise.resolve({ data: { location: { id: '22222222-0000-4000-8000-000000000001', name: 'Van 3', type: 'truck' } } });
      }
      return Promise.reject(new Error(`unexpected POST ${url}`));
    });
    render();

    await screen.findByText('FLT-20');
    await userEvent.click(screen.getByText('All Locations'));
    await userEvent.click(await screen.findByText('Add Location / Van'));
    const dialog = within(await screen.findByRole('dialog'));

    await userEvent.click(dialog.getByLabelText('Add new branch'));
    const branchDialog = within(await screen.findByRole('dialog', { name: /add new branch/i }));
    await userEvent.type(branchDialog.getByLabelText(/branch name/i), 'Long Island');
    await userEvent.click(branchDialog.getByRole('button', { name: /save branch/i }));

    await waitFor(() => {
      expect(mockApi.post).toHaveBeenCalledWith('/api/inventory/branches', expect.objectContaining({ name: 'Long Island' }));
    });

    await userEvent.type(dialog.getByLabelText(/location name/i), 'Van 3');
    await userEvent.click(dialog.getByRole('button', { name: /create location/i }));

    await waitFor(() => {
      expect(mockApi.post).toHaveBeenCalledWith(
        '/api/inventory/locations',
        expect.objectContaining({ branch_id: '11111111-0000-4000-8000-000000000001' }),
      );
    });
  });
});

describe('Opening stock on item create (SRVW-93)', () => {
  it('posts an opening count for the server item id after the item create resolves', async () => {
    mockApi.post.mockImplementation((url: string, body?: unknown) => {
      if (url === '/api/price-book/items') {
        return Promise.resolve({ data: { data: { id: 'eeeeeee1-0000-4000-8000-000000000003', ...(body as object) } } });
      }
      if (url === '/api/inventory/stock/set-quantity') {
        return Promise.resolve({ data: { success: true, on_hand: 12, delta: 12 } });
      }
      return Promise.reject(new Error(`unexpected POST ${url}`));
    });
    render();

    await screen.findByText('FLT-20');
    await userEvent.click(screen.getByRole('button', { name: /add item/i }));
    const dialog = within(await screen.findByRole('dialog'));

    await userEvent.type(dialog.getByPlaceholderText(/Dual Run Capacitor/), 'New Widget');
    // SKU is required since the 2026-08-12 restructure - it used to be minted
    // silently from the name on save.
    await userEvent.type(dialog.getByLabelText(/^SKU/), 'WIDGET-1');
    await userEvent.type(dialog.getByLabelText(/on hand/i), '12');
    await userEvent.click(dialog.getByRole('button', { name: /save item/i }));

    await waitFor(() => {
      expect(mockApi.post).toHaveBeenCalledWith('/api/inventory/stock/set-quantity', {
        item_id: 'eeeeeee1-0000-4000-8000-000000000003',
        location_id: h.LOC_WH,
        counted_qty: 12,
        reason: 'Opening stock',
      });
    });
  });

  it('reports the partial failure when the item saves but the opening count fails', async () => {
    mockApi.post.mockImplementation((url: string, body?: unknown) => {
      if (url === '/api/price-book/items') {
        return Promise.resolve({ data: { data: { id: 'eeeeeee1-0000-4000-8000-000000000004', ...(body as object) } } });
      }
      if (url === '/api/inventory/stock/set-quantity') {
        return Promise.reject(new Error('boom'));
      }
      return Promise.reject(new Error(`unexpected POST ${url}`));
    });
    render();

    await screen.findByText('FLT-20');
    await userEvent.click(screen.getByRole('button', { name: /add item/i }));
    const dialog = within(await screen.findByRole('dialog'));

    await userEvent.type(dialog.getByPlaceholderText(/Dual Run Capacitor/), 'New Widget');
    // SKU is required since the 2026-08-12 restructure - it used to be minted
    // silently from the name on save.
    await userEvent.type(dialog.getByLabelText(/^SKU/), 'WIDGET-1');
    await userEvent.type(dialog.getByLabelText(/on hand/i), '12');
    await userEvent.click(dialog.getByRole('button', { name: /save item/i }));

    await waitFor(() =>
      expect(mockToast).toHaveBeenCalledWith(
        expect.stringMatching(/starting quantity could not be recorded/),
      ),
    );
    expect(mockToast).not.toHaveBeenCalledWith(expect.stringMatching(/^✓ .* added to the catalog$/));
  });
});

describe('TransferDialog staging controls are disabled, not fake (SRVW-93)', () => {
  it('offers no staging door and the destination default is a real location', async () => {
    render();

    await screen.findByText('FLT-20');
    await userEvent.click(screen.getByRole('button', { name: /^transfer$/i }));
    const dialog = within(await screen.findByRole('dialog'));

    expect(dialog.getByRole('button', { name: /by po/i })).toBeDisabled();
    expect(dialog.getByRole('button', { name: /by job/i })).toBeDisabled();
    expect(dialog.getByText('Job / PO').closest('button')).toBeDisabled();

    mockApi.post.mockResolvedValue({ data: {} });
    const qtyInput = dialog.getByPlaceholderText('0') ?? dialog.getByRole('spinbutton');
    await userEvent.type(qtyInput, '1');
    await userEvent.click(dialog.getByRole('button', { name: /submit transfer/i }));

    await waitFor(() => {
      expect(mockApi.post).toHaveBeenCalledWith(
        '/api/inventory/transfer',
        expect.objectContaining({ toId: h.LOC_VAN }),
      );
    });
    expect(mockApi.post).not.toHaveBeenCalledWith('/api/inventory/job-stages', expect.anything());
  });
});

describe('toPriceBookBody transport guard (SRVW-93, objection 3)', () => {
  it('throws on a placeholder FK instead of silently dropping it', () => {
    expect(() => toPriceBookBody({ name: 'x', brandId: 'brd_new_1753000000000' })).toThrow(/brand_id/);
    expect(() => toPriceBookBody({ name: 'x', brandId: 'b-1' })).not.toThrow();
    expect(() => toPriceBookBody({ name: 'x', brandId: '11111111-1111-4111-8111-111111111111' })).not.toThrow();
  });
});
