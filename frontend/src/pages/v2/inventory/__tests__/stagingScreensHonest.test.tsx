/**
 * Roles & Permissions S07.4 - the Staging tab renders what the server returns and shows only what the person's
 * switches allow. Abilities are built from the switches' grants (Create stock = create Inventory, Edit stock =
 * update Inventory, See costs = read Pricing, View vendors = read Vendor), never from a role name.
 *
 * Drives the routed Staging tab body (`pages/v2/inventory/components/stagingView`, the file InventoryPage mounts).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen } from '@testing-library/react';

import { renderWithProviders } from '@/__tests__/helpers';
import { buildAbility, type AbilityRule } from '@/lib/ability';
import type { JobStage, Location } from '@/lib/api/inventory';

import { StagingView } from '../components/stagingView';

const h = vi.hoisted(() => ({ stages: [] as JobStage[] }));

vi.mock('@/lib/api/inventory', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api/inventory')>();
  const mutation = () => ({ mutate: vi.fn(), mutateAsync: vi.fn(), isPending: false });
  return {
    ...actual,
    useJobStages: () => ({ data: h.stages, isLoading: false, isError: false }),
    usePurchaseOrders: () => ({ data: [], isLoading: false, isError: false }),
    useVendors: () => ({ data: [], isLoading: false, isError: false }),
    useCreateStage: mutation,
    useReceiveStageLine: mutation,
    useNotifyTechReady: mutation,
  };
});

// The detail and create dialogs are covered by their own suites; here only the tab body is under test.
vi.mock('@/components/inventory/StageDetailDialog', () => ({ StageDetailDialog: () => null }));
vi.mock('@/components/inventory/CreateStageDialog', () => ({ CreateStageDialog: () => null }));
vi.mock('@/components/inventory/POPreviewDialog', () => ({ POPreviewDialog: () => null }));

const LOCATIONS: Location[] = [
  { id: 'loc-wh', name: 'Main Warehouse', type: 'warehouse', branch: 'HQ', stagingAreas: ['Zone A'] },
];

// One rule per switch the tab reads.
const VIEW_STOCK: AbilityRule = { action: 'read', subject: 'Inventory' };
const CREATE_STOCK: AbilityRule = { action: 'create', subject: 'Inventory' };
const EDIT_STOCK: AbilityRule = { action: 'update', subject: 'Inventory' };
const SEE_FINANCIAL_DATA: AbilityRule = { action: 'read', subject: 'Pricing' };
const VIEW_VENDORS: AbilityRule = { action: 'read', subject: 'Vendor' };

// The staging area picker's trigger reads "Pick a staging area" (plus a chevron glyph) while no area is set.
const STAGING_AREA_PICKER = /Pick a staging area/;

function stage(over: Partial<JobStage> = {}): JobStage {
  return {
    id: 'stg-1',
    jobNumber: 'J-1850',
    customer: 'Acme Corp',
    site: '665 Fifth Ave',
    trade: 'security',
    status: 'awaiting',
    stagedLocationId: 'loc-wh',
    items: [
      {
        id: 'it-1', itemSku: 'CAM-01', itemName: 'Dome Camera', uom: 'EA', qtyOrdered: 2, qtyReceived: 0,
        vendor: 'Northwind Supply', poNumber: 'PO-1001', serialized: false, unitCost: 12.5,
      },
    ],
    createdAt: '2026-05-21T09:14:00Z',
    ...over,
  };
}

function renderTab(rules: AbilityRule[]) {
  return renderWithProviders(<StagingView locations={LOCATIONS} onToast={vi.fn()} />, {
    initialEntries: ['/inventory/staging'],
    ability: buildAbility(rules),
  });
}

beforeEach(() => {
  h.stages = [stage()];
});

describe('Staging tab - write controls follow Create stock and Edit stock', () => {
  it('shows no receive, notify or area controls and no New Pickup with View stock alone', () => {
    h.stages = [stage({ status: 'complete', items: [{ ...stage().items[0]!, qtyReceived: 2 }] })];
    renderTab([VIEW_STOCK]);

    expect(screen.queryByRole('button', { name: 'New Pickup' })).toBeNull();
    expect(screen.queryByRole('button', { name: /From PO/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /Notify Tech/ })).toBeNull();
    // The area row is drawn (the stage sits in a known location), so the missing picker is the switch, not an empty card.
    expect(screen.getByText(/Staging area in Main Warehouse/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: STAGING_AREA_PICKER })).toBeNull();
  });

  it('offers the staging area picker with Edit stock and not without it', () => {
    const { unmount } = renderTab([VIEW_STOCK, EDIT_STOCK]);
    expect(screen.getByRole('button', { name: STAGING_AREA_PICKER })).toBeInTheDocument();
    unmount();

    renderTab([VIEW_STOCK]);
    expect(screen.queryByRole('button', { name: STAGING_AREA_PICKER })).toBeNull();
  });

  it('Create stock alone offers New Pickup and no Receive +1', () => {
    renderTab([VIEW_STOCK, CREATE_STOCK]);

    expect(screen.getByRole('button', { name: 'New Pickup' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Receive +1' })).toBeNull();
  });

  it('Edit stock alone offers Receive +1 and no New Pickup', () => {
    renderTab([VIEW_STOCK, EDIT_STOCK]);

    expect(screen.getByRole('button', { name: 'Receive +1' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'New Pickup' })).toBeNull();
  });
});

describe('Staging tab - line vendor follows View vendors', () => {
  it('drops the vendor name, and its separator, without View vendors even when the response carries it', () => {
    renderTab([VIEW_STOCK]);

    expect(screen.queryByText(/Northwind Supply/)).toBeNull();
    // The PO number stays; nothing is left dangling in front of it.
    const po = screen.getByRole('button', { name: /PO-1001/ });
    expect(po.parentElement?.textContent?.trim().startsWith('·')).toBe(false);
  });

  it('shows the vendor name with View vendors', () => {
    renderTab([VIEW_STOCK, VIEW_VENDORS]);

    expect(screen.getByText(/Northwind Supply/)).toBeInTheDocument();
  });
});

describe('Staging tab - line unit cost follows See costs', () => {
  it('has no unit cost, blank or zero, without See costs', () => {
    renderTab([VIEW_STOCK, VIEW_VENDORS]);

    expect(screen.queryByText(/12\.50/)).toBeNull();
    expect(screen.queryByText(/unit cost/i)).toBeNull();
    expect(screen.queryByText(/\$0\.00/)).toBeNull();
  });

  it('shows the unit cost with See costs', () => {
    renderTab([VIEW_STOCK, SEE_FINANCIAL_DATA]);

    expect(screen.getByText(/\$12\.50/)).toBeInTheDocument();
  });

  it('leaves a line whose response has no cost without a cost, even with See costs', () => {
    const noCost = stage();
    delete noCost.items[0]!.unitCost;
    h.stages = [noCost];
    renderTab([VIEW_STOCK, SEE_FINANCIAL_DATA]);

    expect(screen.queryByText(/unit cost/i)).toBeNull();
    expect(screen.queryByText(/\$0\.00/)).toBeNull();
  });
});

describe('Staging tab - empty states', () => {
  it('says plainly that there is nothing to show when the server returned no stages', () => {
    h.stages = [];
    renderTab([VIEW_STOCK]);

    expect(screen.getByText('No staging to show.')).toBeInTheDocument();
    expect(screen.queryByText('No staged jobs match this filter.')).toBeNull();
  });
});
