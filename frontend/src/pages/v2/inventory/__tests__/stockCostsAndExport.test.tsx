/**
 * Roles & Permissions S07.15 - the Stock page hides cost without See financial data (never as $0) and its two
 * downloads follow Export stock.
 *
 * Mounted through the routed v2 `InventoryPage` with the HTTP layer mocked. Every person is built from switch
 * values: the ability is compiled from the grants the backend catalog gives each switch (the source of truth),
 * never from a role name. A person without See financial data is served items with no `unitCost` key at all, which
 * is what the server does (S01.15); the screen must not turn that absence into a figure.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import api from '@/lib/axios';
import { renderWithProviders } from '@/__tests__/helpers';
import { abilityWithSwitches } from '@/__tests__/support/backendSwitchCatalog';
import { useInventoryAlertStore } from '@/stores/inventory-alert.store';
import InventoryPage from '@/pages/v2/inventory/InventoryPage';
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

function item(id: string, sku: string, name: string, unitCost: number | undefined, onHand: number): Item {
  return {
    id, sku, name, category: 'Hardware', trade: 'general' as Item['trade'], kind: 'material', uom: 'EA',
    ...(unitCost === undefined ? {} : { unitCost }),
    sellPrice: 9, serialized: false, hazmat: false, status: 'active', vendor: 'Supply Co',
    stock: [{ locationId: WAREHOUSE, onHand, min: 1 }], updatedAt: '2026-07-01T00:00:00.000Z',
  } as Item;
}

// 3 on hand at 4.00 and 2 on hand at 10.00: the inventory value is 32.
const WITH_COST: Item[] = [
  item('b0000000-0000-0000-0000-00000000b001', 'HNG-1', 'Brass Hinge', 4, 3),
  item('b0000000-0000-0000-0000-00000000b002', 'LCK-1', 'Deadbolt', 10, 2),
];
const WITHOUT_COST: Item[] = WITH_COST.map((i) => item(i.id, i.sku, i.name, undefined, i.stock[0]!.onHand));

let served: Item[] = WITH_COST;

beforeEach(() => {
  vi.clearAllMocks();
  downloads.files.length = 0;
  served = WITH_COST;
  useInventoryAlertStore.setState({ pending: null, nonce: 0 });
  mockApi.get.mockImplementation((async (url: string) => {
    if (url === '/api/permission-switches/me') return { data: { admin_box: false, values: { show_stock_page: true }, rules: [] } };
    if (url.startsWith('/api/inventory/items')) return { data: { data: served } };
    if (url.startsWith('/api/inventory/locations')) return { data: { locations: LOCATIONS } };
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

const READ = ['View stock', 'View price book', 'View purchase orders', 'View vendors'];

function renderStock(...extra: string[]) {
  return renderWithProviders(<InventoryPage />, {
    ability: abilityWithSwitches(...READ, ...extra),
    initialEntries: ['/inventory'],
  });
}

function renderActivity(...extra: string[]) {
  return renderWithProviders(<InventoryPage />, {
    ability: abilityWithSwitches(...READ, 'See inventory activity', ...extra),
    initialEntries: ['/inventory/activity'],
  });
}

/** Waits for the item row, then opens its detail pane. */
async function openDetail() {
  await userEvent.click(await screen.findByText('Brass Hinge'));
  return screen.findByRole('heading', { level: 2, name: 'Brass Hinge' });
}

const button = (name: string | RegExp) => screen.queryByRole('button', { name });
const columnHeader = (name: string) => screen.queryByRole('columnheader', { name: new RegExp(name, 'i') });

describe('Items tab - a person without See financial data', () => {
  beforeEach(() => {
    served = WITHOUT_COST;
  });

  it('has no Inventory Value card, and the other three cards stay', async () => {
    renderStock();
    await screen.findByText('Brass Hinge');

    expect(screen.queryByText('Inventory Value')).not.toBeInTheDocument();
    expect(screen.queryByText('$0')).not.toBeInTheDocument();
    for (const label of ['Active SKUs', 'Low Stock', 'Backorder']) {
      expect(screen.getByText(label)).toBeInTheDocument();
    }
  });

  it('lays the three remaining cards out three across on a wide screen, not four with a hole', async () => {
    renderStock();
    await screen.findByText('Brass Hinge');

    const group = document.querySelector('[data-slot="stat-card-group"]')!;
    expect(group.children).toHaveLength(3);
    expect(group.className).toContain('xl:grid-cols-3');
    expect(group.className).not.toContain('xl:grid-cols-4');
  });

  it('has no Unit Cost column in the grid', async () => {
    renderStock();
    await screen.findByText('Brass Hinge');

    expect(columnHeader('Unit Cost')).not.toBeInTheDocument();
    expect(screen.queryByText(/^\$4\.00$/)).not.toBeInTheDocument();
  });

  it('has no Unit Cost in the item detail, and the sell price stays', async () => {
    renderStock();
    await openDetail();

    expect(screen.queryByText('Unit Cost')).not.toBeInTheDocument();
    expect(screen.getByText('Sell Price')).toBeInTheDocument();
  });
});

describe('Items tab - a person with See financial data', () => {
  it('sees the Inventory Value card with the real total, the Unit Cost column and the unit cost in the detail', async () => {
    renderStock('See financial data');
    await screen.findByText('Brass Hinge');

    expect(screen.getByText('Inventory Value')).toBeInTheDocument();
    expect(screen.getByText('$32')).toBeInTheDocument();
    expect(columnHeader('Unit Cost')).toBeInTheDocument();
    const group = document.querySelector('[data-slot="stat-card-group"]')!;
    expect(group.children).toHaveLength(4);
    expect(group.className).toContain('xl:grid-cols-4');

    await openDetail();
    expect(screen.getAllByText('Unit Cost').length).toBeGreaterThan(1);
  });
});

describe('Export and Export selected follow Export stock', () => {
  it('shows neither button without Export stock, even for a person who can select rows to restock', async () => {
    renderStock('See financial data', 'Edit stock');
    await screen.findByText('Brass Hinge');

    expect(button(/^Export$/)).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('checkbox', { name: 'Select HNG-1' }));
    await waitFor(() => expect(screen.getByText(/1 item selected/i)).toBeInTheDocument());
    expect(button(/^Export selected$/)).not.toBeInTheDocument();
  });

  it('offers no row selection at all when the person has neither Export stock nor Edit stock', async () => {
    renderStock();
    await screen.findByText('Brass Hinge');

    expect(screen.queryByRole('checkbox', { name: 'Select HNG-1' })).not.toBeInTheDocument();
  });

  it('keeps the selection for Edit stock alone, with bulk restock and no Export selected', async () => {
    renderStock('Edit stock');
    await screen.findByText('Brass Hinge');
    const before = screen.getAllByRole('button', { name: /^Restock$/ }).length;
    await userEvent.click(screen.getByRole('checkbox', { name: 'Select HNG-1' }));

    await waitFor(() => expect(screen.getAllByRole('button', { name: /^Restock$/ }).length).toBe(before + 1));
    expect(button(/^Export selected$/)).not.toBeInTheDocument();
  });

  it('shows both buttons with Export stock', async () => {
    renderStock('Export stock');
    await screen.findByText('Brass Hinge');

    expect(screen.getByRole('button', { name: /^Export$/ })).toBeInTheDocument();
    await userEvent.click(screen.getByRole('checkbox', { name: 'Select HNG-1' }));
    expect(await screen.findByRole('button', { name: /^Export selected$/ })).toBeInTheDocument();
  });
});

describe('The Activity tab download follows Export stock', () => {
  const MOVEMENT = {
    id: 'mv-1', occurredAt: '2026-07-15T10:30:00.000Z', itemSku: 'HNG-1', itemName: 'Brass Hinge', type: 'receive', qty: 7,
    toLocationId: WAREHOUSE, reference: 'PO-77', actor: 'Dana Receiver', itemId: 'b0000000-0000-0000-0000-00000000b001',
  };

  beforeEach(() => {
    const base = mockApi.get.getMockImplementation()!;
    mockApi.get.mockImplementation((async (url: string, ...rest: unknown[]) => {
      if (url.startsWith('/api/inventory/movements')) {
        return { data: { data: [MOVEMENT], meta: { page: 1, limit: 25, total: 1, totalPages: 1 } } };
      }
      return (base as (u: string, ...r: unknown[]) => Promise<unknown>)(url, ...rest);
    }) as typeof mockApi.get);
  });

  it('shows no Export CSV button to a person who sees the ledger but lacks Export stock', async () => {
    renderActivity();
    expect(await screen.findByText('Dana Receiver')).toBeInTheDocument();

    expect(button(/Export CSV/)).not.toBeInTheDocument();
  });

  it('shows Export CSV, and it downloads, with Export stock', async () => {
    renderActivity('Export stock');
    await screen.findByText('Dana Receiver');

    await userEvent.click(screen.getByRole('button', { name: /Export CSV/ }));
    await waitFor(() => expect(downloads.files).toHaveLength(1));
    expect(downloads.files[0]!.name).toMatch(/^stock-activity-/);
  });
});

describe('The downloaded file', () => {
  async function exportAll() {
    await screen.findByText('Brass Hinge');
    await userEvent.click(screen.getByRole('button', { name: /^Export$/ }));
    await waitFor(() => expect(downloads.files).toHaveLength(1));
    return downloads.files[0]!.csv;
  }

  it('carries no cost column, not even an empty or 0.00 one, without See financial data', async () => {
    served = WITHOUT_COST;
    renderStock('Export stock');
    const csv = await exportAll();

    const header = csv.split('\r\n')[0]!;
    expect(header).toContain('SKU');
    expect(header).toContain('Sell Price');
    expect(header).not.toMatch(/cost/i);
    expect(csv).not.toContain('0.00,9.00');
  });

  it('carries the cost column with the real costs with See financial data', async () => {
    renderStock('Export stock', 'See financial data');
    const csv = await exportAll();

    const [header, ...rows] = csv.split('\r\n');
    expect(header).toContain('Unit Cost');
    expect(rows.some((r) => r.includes('HNG-1') && r.includes('4.00'))).toBe(true);
    expect(rows.some((r) => r.includes('LCK-1') && r.includes('10.00'))).toBe(true);
  });

  it('Export selected leaves the cost column out too without See financial data', async () => {
    served = WITHOUT_COST;
    renderStock('Export stock');
    await screen.findByText('Brass Hinge');
    await userEvent.click(screen.getByRole('checkbox', { name: 'Select HNG-1' }));
    await userEvent.click(await screen.findByRole('button', { name: /^Export selected$/ }));

    await waitFor(() => expect(downloads.files).toHaveLength(1));
    const csv = downloads.files[0]!.csv;
    expect(csv.split('\r\n')[0]).not.toMatch(/cost/i);
    expect(csv).toContain('HNG-1');
    expect(csv).not.toContain('LCK-1');
    expect(downloads.files[0]!.name).toMatch(/-selected-/);
  });
});
