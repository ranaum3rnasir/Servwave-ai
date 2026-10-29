/**
 * The Stock grid's row selection and its two bulk actions.
 *
 * Export selected reuses the page's own `toExportRow` mapping and the shared
 * `toCSV`/`downloadCSV` writer, so the selected-row file is column-identical to
 * the toolbar Export's - only the row set differs.
 *
 * Restock is the one WRITE-shaped bulk action anywhere in this sweep that the
 * backend can already serve: `POST /api/inventory/bulk-restock`, gated
 * `canDo('update','Inventory')`, body `{ lines: [{ itemId, locationId, qty,
 * unitCost? }] }` (`invCatalog.bulkRestockSchema`). The request assertion below
 * is written against that schema, so a drift in either direction fails here
 * rather than as a 400 in front of a user.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import api from '@/lib/axios';
import { buildAbility } from '@/lib/ability';
import { renderWithProviders } from '@/__tests__/helpers';
import type { Item, Location } from '@/lib/api/inventory';

import InventoryPage from '../InventoryPage';

const hoisted = vi.hoisted(() => ({
  toCSV: vi.fn((_rows: Record<string, unknown>[]) => 'csv-content'),
  downloadCSV: vi.fn(),
}));

vi.mock('@/lib/inventory/csv', () => ({
  toCSV: hoisted.toCSV,
  downloadCSV: hoisted.downloadCSV,
}));

// Radix's Select and DropdownMenu both reach for ResizeObserver via floating-ui.
class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
global.ResizeObserver = ResizeObserverStub as unknown as typeof ResizeObserver;

const WAREHOUSE = 'a0000000-0000-0000-0000-0000000000w1';

const LOCATIONS: Location[] = [
  { id: WAREHOUSE, name: 'Main Warehouse', type: 'warehouse', branch: 'HQ' },
];

function item(n: number, sku: string, name: string, onHand: number, min: number): Item {
  return {
    id: `b000000${n}-0000-0000-0000-000000000001`,
    sku,
    name,
    category: 'Capacitors',
    trade: 'hvac',
    kind: 'material',
    uom: 'ea',
    unitCost: 12.5,
    sellPrice: 30,
    serialized: false,
    hazmat: false,
    status: 'active',
    vendor: 'Acme Supply',
    stock: [{ locationId: WAREHOUSE, onHand, min }],
    updatedAt: '2026-07-01T00:00:00.000Z',
  };
}

const ITEMS = [item(1, 'CAP-01', 'Run Capacitor', 2, 6), item(2, 'CAP-02', 'Start Capacitor', 9, 4)];

const mockApi = vi.mocked(api);

beforeEach(() => {
  vi.clearAllMocks();
  mockApi.get.mockImplementation(async (url: string) => {
    if (url.startsWith('/api/inventory/items')) return { data: { data: ITEMS } };
    if (url.startsWith('/api/inventory/locations')) return { data: { locations: LOCATIONS } };
    if (url.startsWith('/api/organization')) return { data: { default_inventory_location_id: WAREHOUSE } };
    return {
      data: {
        data: [], meta: { page: 1, limit: 1, total: 0, totalPages: 1 },
        locations: [], vendors: [], categories: [], branches: [], brands: [],
        stages: [], assets: [], total: 0,
      },
    };
  });
  mockApi.post.mockResolvedValue({ data: { success: true, count: 1 } });
});

function admin() {
  return buildAbility([
    { action: 'update', subject: 'Inventory' },
    { action: 'read', subject: 'Inventory' },
  ]);
}

async function renderStock(ability = admin()) {
  renderWithProviders(<InventoryPage />, { ability, initialEntries: ['/inventory'] });
  expect(await screen.findByText('Run Capacitor')).toBeInTheDocument();
}

describe('stock bulk selection', () => {
  it('lifts a ticked row into the bulk action bar', async () => {
    await renderStock();

    await userEvent.click(screen.getByRole('checkbox', { name: 'Select CAP-01' }));

    const bar = await screen.findByRole('status');
    expect(within(bar).getByText('1 item selected')).toBeInTheDocument();
  });

  it('exports exactly the selected rows, not all of them', async () => {
    await renderStock();

    await userEvent.click(screen.getByRole('checkbox', { name: 'Select CAP-02' }));
    const bar = await screen.findByRole('status');
    await userEvent.click(within(bar).getByRole('button', { name: /export selected/i }));

    await waitFor(() => expect(hoisted.downloadCSV).toHaveBeenCalled());
    const rows = hoisted.toCSV.mock.calls[0]![0] as Record<string, unknown>[];
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ SKU: 'CAP-02', Name: 'Start Capacitor' });
    expect(hoisted.downloadCSV).toHaveBeenCalledWith(
      'csv-content',
      expect.stringMatching(/^inventory-all-locations-selected-\d{4}-\d{2}-\d{2}\.csv$/),
    );
  });

  it('leaves the toolbar Export exporting the whole filtered set', async () => {
    await renderStock();

    await userEvent.click(screen.getByRole('checkbox', { name: 'Select CAP-02' }));
    await screen.findByRole('status');

    await userEvent.click(screen.getByRole('button', { name: /^export$/i }));

    await waitFor(() => expect(hoisted.downloadCSV).toHaveBeenCalled());
    const rows = hoisted.toCSV.mock.calls[0]![0] as Record<string, unknown>[];
    expect(rows).toHaveLength(2);
  });
});

describe('stock bulk restock', () => {
  it('posts one line per selected item in bulkRestockSchema shape', async () => {
    await renderStock();

    await userEvent.click(screen.getByRole('checkbox', { name: 'Select CAP-01' }));
    await userEvent.click(screen.getByRole('checkbox', { name: 'Select CAP-02' }));
    const bar = await screen.findByRole('status');
    await userEvent.click(within(bar).getByRole('button', { name: /^restock$/i }));

    const dialog = await screen.findByRole('dialog');
    await userEvent.click(within(dialog).getByRole('button', { name: /receive/i }));

    await waitFor(() => expect(mockApi.post).toHaveBeenCalled());
    const [url, body] = mockApi.post.mock.calls[0]!;
    expect(url).toBe('/api/inventory/bulk-restock');
    expect(body).toEqual({
      lines: [
        // Defaults to the shortfall against the destination's own min, so the
        // common case (restock what is below reserve) needs no typing.
        { itemId: ITEMS[0]!.id, locationId: WAREHOUSE, qty: 4, unitCost: 12.5 },
        { itemId: ITEMS[1]!.id, locationId: WAREHOUSE, qty: 1, unitCost: 12.5 },
      ],
    });
  });

  it('hides Restock without `update Inventory`, and keeps Export selected', async () => {
    await renderStock(buildAbility([{ action: 'read', subject: 'Inventory' }]));

    await userEvent.click(screen.getByRole('checkbox', { name: 'Select CAP-01' }));

    const bar = await screen.findByRole('status');
    expect(within(bar).queryByRole('button', { name: /^restock$/i })).toBeNull();
    expect(within(bar).getByRole('button', { name: /export selected/i })).toBeInTheDocument();
  });
});
