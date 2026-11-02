/**
 * Roles & Permissions S07.18 - the Stock page's vendor surfaces follow View vendors.
 *
 * Mounted through the routed v2 `InventoryPage` with the HTTP layer mocked. A person without View vendors is served
 * items with no `vendor` key at all, which is what the server does; the page must not turn that absence into a blank
 * cell, a blank filter section or a blank column in a download. Every person is built from switch values: the ability
 * is compiled from the grants the backend catalog gives each switch (the source of truth), never from a role name.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import api from '@/lib/axios';
import { renderWithProviders } from '@/__tests__/helpers';
import { abilityWithSwitches } from '@/__tests__/support/backendSwitchCatalog';
import { useInventoryAlertStore } from '@/stores/inventory-alert.store';
import InventoryPage from '@/pages/v2/inventory/InventoryPage';
import PurchaseOrdersPage from '@/pages/v2/inventory/PurchaseOrdersPage';
import type { Item, Location } from '@/lib/api/inventory';

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
global.ResizeObserver = ResizeObserverStub as unknown as typeof ResizeObserver;

const downloads = vi.hoisted(() => ({ files: [] as Array<{ csv: string; name: string }> }));
vi.mock('@/lib/inventory/csv', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/inventory/csv')>();
  return { ...actual, downloadCSV: (csv: string, name: string) => void downloads.files.push({ csv, name }) };
});

const mockApi = vi.mocked(api);
vi.mock('@/lib/axios');

const WAREHOUSE = 'a0000000-0000-0000-0000-0000000000w1';
const LOCATIONS: Location[] = [{ id: WAREHOUSE, name: 'Main Warehouse', type: 'warehouse', branch: 'HQ' }];
const VENDOR_NAME = 'Supply Co';
const VENDOR_ID = 'f0000000-0000-4000-8000-000000000001';

function item(id: string, sku: string, name: string, vendor: string | undefined): Item {
  return {
    id, sku, name, category: 'Hardware', trade: 'general' as Item['trade'], kind: 'material', uom: 'EA',
    unitCost: 4, sellPrice: 9, serialized: false, hazmat: false, status: 'active',
    ...(vendor === undefined ? {} : { vendor }),
    stock: [{ locationId: WAREHOUSE, onHand: 3, min: 1 }], updatedAt: '2026-07-01T00:00:00.000Z',
  } as Item;
}

const ID = 'b0000000-0000-0000-0000-00000000b001';
const WITH_VENDOR = [item(ID, 'HNG-1', 'Brass Hinge', VENDOR_NAME)];
const WITHOUT_VENDOR = [item(ID, 'HNG-1', 'Brass Hinge', undefined)];

let served: Item[] = WITH_VENDOR;
let requested: string[] = [];

beforeEach(() => {
  vi.clearAllMocks();
  downloads.files.length = 0;
  requested = [];
  served = WITH_VENDOR;
  useInventoryAlertStore.setState({ pending: null, nonce: 0 });
  mockApi.get.mockImplementation((async (url: string) => {
    requested.push(url.split('?')[0]!);
    if (url === '/api/permission-switches/me') return { data: { admin_box: false, values: { view_stock: true }, rules: [] } };
    if (url.startsWith('/api/inventory/items')) return { data: { data: served } };
    if (url.startsWith('/api/inventory/locations')) return { data: { locations: LOCATIONS } };
    if (url.startsWith('/api/inventory/vendors')) {
      return { data: { vendors: [{ id: VENDOR_ID, name: VENDOR_NAME, category: 'Hardware', status: 'active' }] } };
    }
    if (url.startsWith('/api/inventory/low-stock')) {
      return {
        data: {
          data: [{
            itemId: ID, sku: 'HNG-1', name: 'Brass Hinge', isActive: true, trackInventory: true,
            ...(served === WITH_VENDOR ? { vendorId: VENDOR_ID, vendorName: VENDOR_NAME } : {}),
            locationId: WAREHOUSE, locationName: 'Main Warehouse', onHand: 1, min: 5, max: null,
          }],
          meta: { page: 1, limit: 100, total: 1, totalPages: 1 },
        },
      };
    }
    if (url.startsWith('/api/inventory/assets')) return { data: { data: [], meta: { total: 0 } } };
    if (url.startsWith('/api/logistic-orders')) return { data: { data: [], page: 1, limit: 50, total: 0 } };
    return {
      data: {
        data: [], meta: { page: 1, limit: 1, total: 0, totalPages: 1 }, vendors: [], categories: [], branches: [], brands: [],
        jobStages: [], purchaseOrders: [], users: [], finishes: [], techs: [], itemGroups: [], total: 0,
      },
    };
  }) as typeof mockApi.get);
});

const READ = ['View stock', 'View price book'];
// Create price book items (used below) needs Edit price book items, so each such person holds both.

function renderStock(path: string, ...extra: string[]) {
  return renderWithProviders(<InventoryPage />, { ability: abilityWithSwitches(...READ, ...extra), initialEntries: [path] });
}

const columnHeader = (name: string) => screen.queryByRole('columnheader', { name: new RegExp(`^${name}`, 'i') });

describe('a person without View vendors', () => {
  beforeEach(() => {
    served = WITHOUT_VENDOR;
  });

  it('never asks for the vendor list', async () => {
    renderStock('/inventory');
    await screen.findByText('Brass Hinge');

    expect(requested).not.toContain('/api/inventory/vendors');
  });

  it('can still search the items (an item with no vendor key does not break the search)', async () => {
    renderStock('/inventory');
    await screen.findByText('Brass Hinge');

    // A search that matches neither sku, name nor category is tried against the vendor too.
    await userEvent.type(screen.getByPlaceholderText('Search inventory…'), 'zzz');
    expect(await screen.findByText('No items match your filters.')).toBeInTheDocument();
  });

  it('has no Vendor section in the Filter', async () => {
    renderStock('/inventory');
    await screen.findByText('Brass Hinge');

    await userEvent.click(screen.getByRole('button', { name: /^Filter/ }));
    const tabs = within(await screen.findByRole('tablist', { name: 'Filter facets' })).getAllByRole('tab');
    expect(tabs.map((t) => t.textContent)).toEqual(['Item Kind', 'Stock Status', 'Flags']);
  });

  it('has no Vendor field in the item form', async () => {
    renderStock('/inventory', 'Edit price book items', 'Create price book items');
    await screen.findByText('Brass Hinge');

    await userEvent.click(screen.getByRole('button', { name: /^add item$/i }));
    await screen.findByRole('dialog');
    expect(screen.queryByText('Vendor / Source')).not.toBeInTheDocument();
  });

  it('has no Vendor column in the Low stock tab', async () => {
    renderStock('/inventory/low-stock');
    await screen.findByText('Brass Hinge');

    expect(columnHeader('Vendor')).not.toBeInTheDocument();
    expect(columnHeader('Location')).toBeInTheDocument();
  });

  it('has no Vendor column in the downloaded file', async () => {
    renderStock('/inventory', 'Export stock');
    await screen.findByText('Brass Hinge');

    await userEvent.click(screen.getByRole('button', { name: /^Export$/ }));
    await waitFor(() => expect(downloads.files).toHaveLength(1));
    const csv = downloads.files[0]!.csv;
    expect(csv.split('\r\n')[0]).toContain('SKU');
    expect(csv).not.toMatch(/vendor/i);
  });

  it('has no Vendor column in the file made by Export selected either', async () => {
    renderStock('/inventory', 'Export stock');
    await screen.findByText('Brass Hinge');

    await userEvent.click(screen.getByRole('checkbox', { name: 'Select HNG-1' }));
    await userEvent.click(await screen.findByRole('button', { name: /^Export selected$/ }));
    await waitFor(() => expect(downloads.files).toHaveLength(1));
    expect(downloads.files[0]!.csv).not.toMatch(/vendor/i);
  });

  it('has no Vendor column in the CSV import: not in the expected columns, not in the template', async () => {
    renderStock('/inventory', 'Edit price book items', 'Create price book items');
    await screen.findByText('Brass Hinge');

    await userEvent.click(screen.getByRole('button', { name: /^Import CSV$/ }));
    const dialog = within(await screen.findByRole('dialog'));
    expect(dialog.queryByText('Vendor')).not.toBeInTheDocument();
    expect(dialog.queryByText(/vendor/i)).not.toBeInTheDocument();

    await userEvent.click(dialog.getByRole('button', { name: /Download sample CSV/ }));
    expect(downloads.files[0]!.csv.split('\n')[0]).toBe('SKU,Name,Category,Kind,UoM,Unit Cost,Sell Price');
    expect(downloads.files[0]!.csv).not.toMatch(/vendor|Ferguson|Mul-T-Lock/i);
  });
});

describe('a person with View vendors', () => {
  it('asks for the vendor list and has the Vendor section in the Filter', async () => {
    renderStock('/inventory', 'View vendors');
    await screen.findByText('Brass Hinge');

    await waitFor(() => expect(requested).toContain('/api/inventory/vendors'));
    await userEvent.click(screen.getByRole('button', { name: /^Filter/ }));
    const tabs = within(await screen.findByRole('tablist', { name: 'Filter facets' })).getAllByRole('tab');
    expect(tabs.map((t) => t.textContent)).toEqual(['Item Kind', 'Stock Status', 'Vendor', 'Flags']);
  });

  it('has the Vendor field in the item form', async () => {
    renderStock('/inventory', 'View vendors', 'Edit price book items', 'Create price book items');
    await screen.findByText('Brass Hinge');

    await userEvent.click(screen.getByRole('button', { name: /^add item$/i }));
    await screen.findByRole('dialog');
    expect(screen.getByText('Vendor / Source')).toBeInTheDocument();
  });

  it('has the Vendor column in the Low stock tab, with the vendor name', async () => {
    renderStock('/inventory/low-stock', 'View vendors');
    await screen.findByText('Brass Hinge');

    expect(columnHeader('Vendor')).toBeInTheDocument();
    expect(screen.getByText(VENDOR_NAME)).toBeInTheDocument();
  });

  it('has the Vendor column in the downloaded file, with the vendor name', async () => {
    renderStock('/inventory', 'View vendors', 'Export stock');
    await screen.findByText('Brass Hinge');

    await userEvent.click(screen.getByRole('button', { name: /^Export$/ }));
    await waitFor(() => expect(downloads.files).toHaveLength(1));
    const [header, row] = downloads.files[0]!.csv.split('\r\n');
    expect(header).toContain('Vendor');
    expect(row).toContain(VENDOR_NAME);
  });

  it('has the Vendor column in the CSV import and its template', async () => {
    renderStock('/inventory', 'View vendors', 'Edit price book items', 'Create price book items');
    await screen.findByText('Brass Hinge');

    await userEvent.click(screen.getByRole('button', { name: /^Import CSV$/ }));
    const dialog = within(await screen.findByRole('dialog'));
    expect(dialog.getByText('Vendor')).toBeInTheDocument();

    await userEvent.click(dialog.getByRole('button', { name: /Download sample CSV/ }));
    expect(downloads.files[0]!.csv.split('\n')[0]).toBe('SKU,Name,Category,Kind,UoM,Unit Cost,Sell Price,Vendor');
  });
});

describe('the Purchase Orders page', () => {
  it('asks for the vendor list only with View vendors', async () => {
    renderWithProviders(<PurchaseOrdersPage />, {
      ability: abilityWithSwitches('View purchase orders'),
      initialEntries: ['/inventory/purchase-orders'],
    });
    await waitFor(() => expect(requested).toContain('/api/inventory/purchase-orders'));
    expect(requested).not.toContain('/api/inventory/vendors');
  });

  it('asks for it with View vendors', async () => {
    renderWithProviders(<PurchaseOrdersPage />, {
      ability: abilityWithSwitches('View purchase orders', 'View vendors'),
      initialEntries: ['/inventory/purchase-orders'],
    });
    await waitFor(() => expect(requested).toContain('/api/inventory/vendors'));
  });
});
