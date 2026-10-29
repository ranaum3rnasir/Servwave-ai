// The Items grid's "Locations" column must show WHERE an item is stocked, even when
// the quantity there is currently zero.
//
// LocationBreakdown filtered its rows with `s.onHand > 0`, so an item assigned to a
// van but sitting at 0 rendered a bare dash - visually identical to "not assigned
// to any location at all". The Alpha Doors Zoho import surfaced this: 66 item/location
// memberships legitimately carry 0 on hand, and every one of them looked unassigned.
//
// The filter is gone, so those rows render again and the cases below pin them there: a
// zero-on-hand assignment and a negative balance each keep a chip of their own, and an
// item with no stock rows at all stays the one case that collapses to a dash.
//
// Seam hooks are mocked with stable resolved data (the sanctioned jsdom pattern used by
// inventory-thresholds.test.tsx).
//
// Showing every assignment is what makes the chip cap necessary: an item assigned to a
// dozen vans stacked a chip per van and made its row taller than the rows around it, so
// only the first LOCATION_CHIP_LIMIT render and the rest collapse into a "+N" pill whose
// tooltip names them. Both halves are asserted here - they are one behaviour.
import { describe, it, expect, vi } from 'vitest';
import { screen, within } from '@testing-library/react';
import { renderWithProviders } from './helpers';
import InventoryPage from '@/pages/v2/inventory/InventoryPage';
import { buildAbility } from '@/lib/ability';

const h = vi.hoisted(() => ({
  LOC_WH: 'aaaaaaa1-0000-4000-8000-000000000001',
  LOC_VAN: 'aaaaaaa1-0000-4000-8000-000000000002',
  LOC_VAN2: 'aaaaaaa1-0000-4000-8000-000000000003',
  LOC_VAN3: 'aaaaaaa1-0000-4000-8000-000000000004',
  ZERO_ITEM: 'bbbbbbb1-0000-4000-8000-000000000001',
  NEG_ITEM: 'bbbbbbb1-0000-4000-8000-000000000002',
  NOSTOCK_ITEM: 'bbbbbbb1-0000-4000-8000-000000000003',
  MANY_ITEM: 'bbbbbbb1-0000-4000-8000-000000000004',
}));

vi.mock('@/lib/api/inventory', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api/inventory')>();
  const EMPTY: never[] = [];
  const stable =
    <T,>(data: T) =>
    () => ({ data, isLoading: false, isError: false });
  const base = {
    category: 'Hardware',
    trade: 'locksmith',
    kind: 'material',
    uom: 'EA',
    unitCost: 10,
    sellPrice: 0,
    serialized: false,
    hazmat: false,
    trackInventory: true,
    status: 'active',
    vendor: '',
    updatedAt: '2026-08-11T00:00:00.000Z',
  };
  return {
    ...actual,
    useInventoryItems: stable([
      {
        ...base,
        id: h.ZERO_ITEM,
        sku: 'ZERO-1',
        name: 'Cable 18/6',
        // Stocked at the warehouse (positive) AND assigned to the van at zero.
        stock: [
          { locationId: h.LOC_WH, onHand: 4 },
          { locationId: h.LOC_VAN, onHand: 0 },
        ],
      },
      {
        ...base,
        id: h.NEG_ITEM,
        sku: 'NEG-1',
        name: 'Door Closer CX5016',
        stock: [{ locationId: h.LOC_WH, onHand: -1 }],
      },
      {
        ...base,
        id: h.NOSTOCK_ITEM,
        sku: 'NOSTOCK-1',
        name: 'Unassigned Widget',
        stock: [],
      },
      {
        ...base,
        id: h.MANY_ITEM,
        sku: 'MANY-1',
        name: 'Strike Plate SP2',
        // Four assignments: two chips render, the other two collapse into "+2".
        stock: [
          { locationId: h.LOC_WH, onHand: 4 },
          { locationId: h.LOC_VAN, onHand: 0 },
          { locationId: h.LOC_VAN2, onHand: 2 },
          { locationId: h.LOC_VAN3, onHand: 7 },
        ],
      },
    ]),
    useLocations: stable([
      { id: h.LOC_WH, name: 'Alpha HQ', type: 'warehouse', branch: 'HQ' },
      { id: h.LOC_VAN, name: 'Efrain Van', type: 'truck', branch: 'HQ' },
      { id: h.LOC_VAN2, name: 'Marcus Van', type: 'truck', branch: 'HQ' },
      { id: h.LOC_VAN3, name: 'Priya Van', type: 'truck', branch: 'HQ' },
    ]),
    useVendors: stable(EMPTY),
    useCategories: stable(EMPTY),
    useBranches: stable(EMPTY),
    useBrands: stable(EMPTY),
    useJobStages: stable(EMPTY),
    useMovements: stable(EMPTY),
  };
});

const inventoryAbility = () =>
  buildAbility([
    { action: 'manage', subject: 'Inventory' },
    { action: 'read', subject: 'Invoice' },
  ]);

const renderGrid = () =>
  renderWithProviders(<InventoryPage />, {
    initialEntries: ['/inventory'],
    ability: inventoryAbility(),
  });

/** The row's Locations cell, found via the SKU cell in the same row. */
async function locationsCell(sku: string) {
  const row = (await screen.findByText(sku)).closest('tr');
  expect(row).not.toBeNull();
  return within(row as HTMLElement);
}

describe('Items grid - Locations column', () => {
  it('shows a location assigned zero on hand instead of collapsing it to a dash', async () => {
    renderGrid();
    const cell = await locationsCell('ZERO-1');

    // The whole point: the van is a real assignment and must be visible.
    expect(cell.getByTitle(/Efrain Van: 0 on hand/i)).toBeInTheDocument();
    // The positive location keeps rendering alongside it.
    expect(cell.getByTitle(/Alpha HQ: 4 on hand/i)).toBeInTheDocument();
  });

  it('shows a negative balance rather than hiding it', async () => {
    renderGrid();
    const cell = await locationsCell('NEG-1');

    // A negative is a data problem the user needs to SEE, not one to swallow.
    expect(cell.getByTitle(/Alpha HQ: -1 on hand/i)).toBeInTheDocument();
  });

  it('still renders a dash when an item genuinely has no location rows', async () => {
    // Guards against over-correcting: an item with NO stock rows at all is the one
    // case that should still collapse to "-".
    renderGrid();
    const cell = await locationsCell('NOSTOCK-1');
    expect(cell.getByText('-')).toBeInTheDocument();
  });

  it('caps the chips and collapses the rest into a "+N" pill that names them', async () => {
    renderGrid();
    const cell = await locationsCell('MANY-1');

    // The first two assignments still render as their own chips.
    expect(cell.getByTitle(/Alpha HQ: 4 on hand/i)).toBeInTheDocument();
    expect(cell.getByTitle(/Efrain Van: 0 on hand/i)).toBeInTheDocument();
    // The remaining two do NOT stack: four assignments render three elements,
    // the two chips plus the single collapsed pill.
    const pill = cell.getByText('+2');
    expect(cell.getAllByTitle(/on hand/i)).toHaveLength(3);
    // A hidden location is still reachable - the pill's tooltip names each one.
    expect(cell.getByTitle(/Marcus Van: 2 on hand/i)).toBe(pill);
    expect(cell.getByTitle(/Priya Van: 7 on hand/i)).toBe(pill);
  });
});
