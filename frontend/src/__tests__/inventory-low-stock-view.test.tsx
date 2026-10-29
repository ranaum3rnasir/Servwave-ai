// Inventory P5 §1 — LowStockView: server-computed low-stock rows, location
// filter wired to the server param, and the bridge into P2's GeneratePODialog
// (synthetic Items carrying exactly the offending stock rows, aggregated per
// item across locations). Seam hooks mocked (jsdom seed-loop landmine).
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithProviders } from './helpers';
import { LowStockView, toProposalItems } from '@/components/inventory/LowStockView';
import type { Item, LowStockRow } from '@/lib/api/inventory';
import { buildAbility } from '@/lib/ability';

const hoisted = vi.hoisted(() => ({
  useLowStock: vi.fn(),
  dialogProps: vi.fn(),
}));

const ITEM_A = '10000000-0000-4000-8000-000000000001';
const ITEM_B = '10000000-0000-4000-8000-000000000002';

const ROWS: LowStockRow[] = [
  {
    itemId: ITEM_A, sku: 'CAM-01', name: 'Dome Camera', kind: 'material', status: 'active',
    isActive: true, trackInventory: true, vendorId: 'vnd-1', vendorName: 'Acme',
    locationId: 'loc-1', locationName: 'Main Warehouse', locationType: 'warehouse',
    onHand: 1, min: 5, max: 10,
  },
  {
    itemId: ITEM_A, sku: 'CAM-01', name: 'Dome Camera', kind: 'material', status: 'active',
    isActive: true, trackInventory: true, vendorId: 'vnd-1', vendorName: 'Acme',
    locationId: 'loc-2', locationName: 'Van 1', locationType: 'truck',
    onHand: 0.5, min: 2, max: null,
  },
  {
    itemId: ITEM_B, sku: 'LCK-02', name: 'Smart Lock', kind: 'material', status: 'active',
    isActive: false, trackInventory: true, vendorId: null, vendorName: null,
    locationId: 'loc-1', locationName: 'Main Warehouse', locationType: 'warehouse',
    onHand: 0, min: 3, max: null,
  },
];

vi.mock('@/lib/api/inventory', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api/inventory')>();
  return {
    ...actual,
    useLowStock: hoisted.useLowStock,
    useLocations: () => ({
      data: [
        { id: 'loc-1', name: 'Main Warehouse', type: 'warehouse', branch: 'HQ' },
        { id: 'loc-2', name: 'Van 1', type: 'truck', branch: 'HQ' },
      ],
      isLoading: false,
      isError: false,
    }),
  };
});

// Capture the props the view hands the P2 dialog instead of driving the real
// proposal UI (its own spec is generate-po-low-stock.test.tsx).
vi.mock('@/components/inventory/GeneratePODialog', () => ({
  GeneratePODialog: (props: { open: boolean; items: Item[] }) => {
    hoisted.dialogProps(props);
    return props.open ? <div data-testid="generate-po-dialog" /> : null;
  },
}));

const poAbility = () => buildAbility([{ action: 'create', subject: 'PurchaseOrder' }]);

beforeEach(() => {
  vi.clearAllMocks();
  hoisted.useLowStock.mockReturnValue({
    data: { data: ROWS, meta: { page: 1, limit: 100, total: 3, totalPages: 1 } },
    isLoading: false,
    isError: false,
  });
});

describe('LowStockView (P5 §1)', () => {
  it('renders the server rows — sku/name/location/on-hand/min/max + inactive badge', async () => {
    renderWithProviders(<LowStockView />, { ability: poAbility() });

    expect(await screen.findAllByText('Dome Camera')).toHaveLength(2);
    expect(screen.getByText('Smart Lock')).toBeInTheDocument();
    expect(screen.getByText('inactive')).toBeInTheDocument();
    expect(screen.getByText('Van 1')).toBeInTheDocument();
    // Fractional Decimal on-hand renders with 2 decimals.
    expect(screen.getByText('0.50')).toBeInTheDocument();
    expect(screen.getByText(/3 rows/)).toBeInTheDocument();
  });

  it('location filter re-queries with the server locationId param', async () => {
    renderWithProviders(<LowStockView />, { ability: poAbility() });

    await userEvent.click(screen.getByRole('combobox', { name: 'Filter by location' }));
    await userEvent.click(await screen.findByRole('option', { name: 'Van 1' }));

    await waitFor(() =>
      expect(hoisted.useLowStock).toHaveBeenLastCalledWith(
        expect.objectContaining({ locationId: 'loc-2', page: 1 }),
      ),
    );
  });

  it('per-row Generate PO opens the dialog with ONE synthetic item aggregating that item across locations', async () => {
    renderWithProviders(<LowStockView />, { ability: poAbility() });

    await userEvent.click(
      (await screen.findAllByRole('button', { name: 'Generate PO for Dome Camera' }))[0]!,
    );

    const last = hoisted.dialogProps.mock.calls.at(-1)![0] as { open: boolean; items: Item[] };
    expect(last.open).toBe(true);
    expect(last.items).toHaveLength(1);
    expect(last.items[0]).toMatchObject({ id: ITEM_A, sku: 'CAM-01', vendor: 'Acme' });
    // Both offending locations ride along so the proposal shortfall sums them.
    expect(last.items[0]!.stock).toEqual([
      { locationId: 'loc-1', onHand: 1, min: 5, max: 10 },
      { locationId: 'loc-2', onHand: 0.5, min: 2, max: undefined },
    ]);
  });

  it('"Generate PO (all)" passes every fetched row, grouped per item', async () => {
    renderWithProviders(<LowStockView />, { ability: poAbility() });

    await userEvent.click(await screen.findByRole('button', { name: /Generate PO \(all\)/ }));

    const last = hoisted.dialogProps.mock.calls.at(-1)![0] as { open: boolean; items: Item[] };
    expect(last.open).toBe(true);
    expect(last.items).toHaveLength(2); // 3 rows → 2 distinct items
    expect(last.items.map((i) => i.id).sort()).toEqual([ITEM_A, ITEM_B]);
    // The no-vendor item keeps vendor '' → falls into the manual-pick group.
    expect(last.items.find((i) => i.id === ITEM_B)?.vendor).toBe('');
  });

  it('Generate PO buttons are hidden without create PurchaseOrder', async () => {
    renderWithProviders(<LowStockView />); // emptyAbility — all .can() false

    await screen.findByText('Smart Lock');
    expect(screen.queryByRole('button', { name: /Generate PO/ })).toBeNull();
  });
});

describe('toProposalItems (pure)', () => {
  it('groups rows per item and carries only offending stock rows', () => {
    const items = toProposalItems(ROWS);
    expect(items).toHaveLength(2);
    const a = items.find((i) => i.id === ITEM_A)!;
    expect(a.stock).toHaveLength(2);
    expect(a.vendor).toBe('Acme');
    // Every synthesized row is below min — isLowStock in the dialog re-flags it.
    expect(a.stock.every((s) => s.min != null && s.onHand < s.min)).toBe(true);
  });
});
