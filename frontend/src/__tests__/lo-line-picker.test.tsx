// LOLinePicker — the LO line-list editor (spec §12 rec 2).
//
// Contract under test (the "8 lines from one warehouse = 1 decision" behaviour):
//   • Searching adds a line: qty defaults to 1, the item's sku/name snapshot ride along.
//   • Line-1 source location resolves session pick → org default → first location, each
//     candidate validated against the live location list.
//   • Line N inherits the PREVIOUS line's location.
//   • Adding a line records its location in sessionStorage (feeds the next LO's line-1 default).
//   • Disabled mode drops the search box and the remove control.
//
// Seam hooks are mocked with stable resolved data (jsdom seed-loop landmine). The picker is
// controlled, so `onChange` is a spy and we assert the exact next-array it is handed — no Radix
// Select driving needed to prove the resolution logic.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import api from '@/lib/axios';
import { renderWithProviders } from './helpers';
import { LOLinePicker, type LOLineDraft } from '@/components/inventory/lo/LOLinePicker';
import { setLastStockLocationId } from '@/lib/inventory/stockLocationMemory';
import { buildAbility } from '@/lib/ability';

// jsdom 28 doesn't enable sessionStorage (setup.ts shims localStorage only).
class MemoryStorage {
  private store = new Map<string, string>();
  get length() { return this.store.size; }
  clear() { this.store.clear(); }
  getItem(key: string) { return this.store.has(key) ? this.store.get(key)! : null; }
  key(index: number) { return Array.from(this.store.keys())[index] ?? null; }
  removeItem(key: string) { this.store.delete(key); }
  setItem(key: string, value: string) { this.store.set(key, String(value)); }
}
if (typeof window.sessionStorage === 'undefined') {
  const ss = new MemoryStorage() as unknown as Storage;
  Object.defineProperty(globalThis, 'sessionStorage', { value: ss, writable: true, configurable: true });
  Object.defineProperty(window, 'sessionStorage', { value: ss, writable: true, configurable: true });
}

const h = vi.hoisted(() => ({
  LOC_MAIN: 'aaaaaaa1-0000-4000-8000-000000000001',
  LOC_VAN: 'aaaaaaa2-0000-4000-8000-000000000002',
  ITEM1: 'bbbbbbb1-0000-4000-8000-000000000001',
  ITEM0: 'bbbbbbb0-0000-4000-8000-000000000000',
  orgDefault: null as string | null,
}));

vi.mock('@/lib/api/inventory', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api/inventory')>();
  const locations = [
    { id: h.LOC_MAIN, name: 'Main Warehouse', type: 'warehouse', branch: 'HQ' },
    { id: h.LOC_VAN, name: 'Van 12', type: 'truck', branch: 'HQ' },
  ];
  return { ...actual, useLocations: () => ({ data: locations, isLoading: false, isError: false }) };
});

vi.mock('@/lib/api/organization', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api/organization')>();
  return {
    ...actual,
    useOrganization: () => ({
      data: { id: 'org-1', default_inventory_location_id: h.orgDefault },
      isLoading: false,
      isError: false,
    }),
  };
});

vi.mock('@/lib/api/invoices', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api/invoices')>();
  return {
    ...actual,
    listPriceBookItems: vi.fn().mockResolvedValue([
      { id: h.ITEM1, name: 'Filter 20x20', sku: 'FIL-2020', type: 'MATERIAL', track_inventory: true },
    ]),
  };
});

const mockApi = vi.mocked(api);
const inventoryAbility = () => buildAbility([{ action: 'read', subject: 'Inventory' }]);

function renderPicker(lines: LOLineDraft[], opts: { disabled?: boolean } = {}) {
  const onChange = vi.fn();
  const utils = renderWithProviders(
    <LOLinePicker lines={lines} onChange={onChange} disabled={opts.disabled} />,
    { ability: inventoryAbility() },
  );
  return { ...utils, onChange };
}

async function searchAndPick() {
  await userEvent.type(screen.getByLabelText('Search tracked items'), 'filter');
  await userEvent.click(await screen.findByRole('button', { name: /Filter 20x20/ }));
}

beforeEach(() => {
  vi.clearAllMocks();
  window.sessionStorage.clear();
  h.orgDefault = null;
  // useItemStock (per row) → GET /api/inventory/items/:id
  mockApi.get.mockResolvedValue({ data: { item: { id: h.ITEM1, stock: [] } } });
});

describe('LOLinePicker — adding a line', () => {
  it('adds the searched item with qty 1 and its sku/name snapshot', async () => {
    setLastStockLocationId(h.LOC_MAIN);
    const { onChange } = renderPicker([]);
    await searchAndPick();
    expect(onChange).toHaveBeenCalledWith([
      {
        item_id: h.ITEM1,
        item_sku: 'FIL-2020',
        item_name: 'Filter 20x20',
        qty: 1,
        from_location_id: h.LOC_MAIN,
      },
    ]);
  });

  it('records the chosen default location in sessionStorage for the next LO', async () => {
    setLastStockLocationId(h.LOC_MAIN);
    renderPicker([]);
    await searchAndPick();
    expect(window.sessionStorage.getItem('sw.lastStockLocationId')).toBe(h.LOC_MAIN);
  });
});

describe('LOLinePicker — line-1 location default chain', () => {
  it('session pick beats the org default', async () => {
    h.orgDefault = h.LOC_VAN;
    setLastStockLocationId(h.LOC_MAIN);
    const { onChange } = renderPicker([]);
    await searchAndPick();
    expect(onChange.mock.calls[0][0][0].from_location_id).toBe(h.LOC_MAIN);
  });

  it('falls back to the org default when the session holds no pick', async () => {
    h.orgDefault = h.LOC_VAN;
    const { onChange } = renderPicker([]);
    await searchAndPick();
    expect(onChange.mock.calls[0][0][0].from_location_id).toBe(h.LOC_VAN);
  });

  it('falls back to the first location when neither session nor org default is set', async () => {
    const { onChange } = renderPicker([]);
    await searchAndPick();
    expect(onChange.mock.calls[0][0][0].from_location_id).toBe(h.LOC_MAIN);
  });
});

describe('LOLinePicker — inheritance', () => {
  it('a second line inherits the previous line’s location, ignoring the chain', async () => {
    // Session says Main, but the existing line pulls from Van — the new line must follow the line.
    setLastStockLocationId(h.LOC_MAIN);
    const existing: LOLineDraft = {
      item_id: h.ITEM0,
      item_sku: 'OLD-1',
      item_name: 'Existing part',
      qty: 2,
      from_location_id: h.LOC_VAN,
    };
    const { onChange } = renderPicker([existing]);
    await searchAndPick();
    const next = onChange.mock.calls[0][0] as LOLineDraft[];
    expect(next).toHaveLength(2);
    expect(next[1].from_location_id).toBe(h.LOC_VAN);
  });
});

describe('LOLinePicker — disabled (read-only) mode', () => {
  it('renders the line but drops the search box and the remove control', () => {
    renderPicker(
      [
        {
          item_id: h.ITEM0,
          item_sku: 'OLD-1',
          item_name: 'Existing part',
          qty: 2,
          from_location_id: h.LOC_VAN,
        },
      ],
      { disabled: true },
    );
    expect(screen.getByText('Existing part')).toBeInTheDocument();
    expect(screen.queryByLabelText('Search tracked items')).toBeNull();
    expect(screen.queryByRole('button', { name: /Remove Existing part/ })).toBeNull();
  });
});
