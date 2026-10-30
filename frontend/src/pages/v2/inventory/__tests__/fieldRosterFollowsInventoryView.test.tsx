/**
 * Roles & Permissions S07.23 - the field roster on the inventory screens follows the Inventory view switch.
 *
 * The server's staff answer (GET /api/inventory/techs) says which view each person's switch gives them: Field or
 * Counter. It carries no role name, so a screen has nothing else to read. The people here are on custom roles
 * with names that mean nothing to the screens (a "Yard Lead" is in the field, a "Floor Hand" is at the counter),
 * and each screen below must offer exactly the Field ones. The screens are the routed Inventory page (the van's
 * primary-tech picker) and the staging dialogs the Staging tab opens.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import api from '@/lib/axios';
import { renderWithProviders, inventoryWriteAbility } from '@/__tests__/helpers';
import InventoryPage from '@/pages/v2/inventory/InventoryPage';
import { StageDetailDialog } from '@/components/inventory/StageDetailDialog';
import type { JobStage } from '@/lib/api/inventory';

const mockApi = vi.mocked(api);

const h = vi.hoisted(() => ({
  LOC_WH: 'aaaaaaa1-0000-4000-8000-000000000001',
  STAGE_ID: '11111111-2222-4333-8444-555555555555',
}));

// Read-side seam hooks answer stable data (the page's seed loops re-run on a fresh array); the staff list
// stays REAL so it reads the answer served below.
vi.mock('@/lib/api/inventory', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api/inventory')>();
  const EMPTY: never[] = [];
  const stable =
    <T,>(data: T) =>
    () => ({ data, isLoading: false, isError: false });
  return {
    ...actual,
    useInventoryItems: stable(EMPTY),
    useLocations: stable([{ id: h.LOC_WH, name: 'Main Warehouse', type: 'warehouse', branch: 'HQ' }]),
    useVendors: stable(EMPTY),
    useCategories: stable(EMPTY),
    useBranches: stable([{ id: 'br-1', name: 'HQ' }]),
    useBrands: stable(EMPTY),
    useJobStages: stable(EMPTY),
    useMovements: stable(EMPTY),
    useInventoryJobs: stable(EMPTY),
    usePurchaseOrders: stable(EMPTY),
  };
});

vi.mock('@/lib/api/organization', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api/organization')>();
  return {
    ...actual,
    useOrganization: () => ({ data: { id: 'org-1', default_inventory_location_id: h.LOC_WH }, isLoading: false, isError: false }),
  };
});

/** The server's answer, exactly its shape: a view per person and no role. */
const STAFF = [
  { id: 'p-field', name: 'Yolanda Yardlead', email: 'y@example.test', inventoryView: 'field', branch: 'HQ', certs: [] },
  { id: 'p-counter', name: 'Floyd Floorhand', email: 'f@example.test', inventoryView: 'counter', branch: 'HQ', certs: [] },
  { id: 'p-field-2', name: 'Quinn Roadcrew', email: 'q@example.test', inventoryView: 'field', branch: 'HQ', certs: [] },
];

beforeEach(() => {
  vi.clearAllMocks();
  mockApi.get.mockImplementation(((url: string) => {
    if (url === '/api/inventory/techs') return Promise.resolve({ data: { techs: STAFF } });
    if (url === '/api/inventory/vendors') return Promise.resolve({ data: { vendors: [] } });
    return Promise.resolve({ data: {} });
  }) as typeof mockApi.get);
});

async function optionNames(trigger: HTMLElement): Promise<string[]> {
  await userEvent.click(trigger);
  const names = within(await screen.findByRole('listbox')).getAllByRole('option').map((o) => o.textContent ?? '');
  await userEvent.keyboard('{Escape}');
  return names;
}

describe('the van\'s primary-tech picker on the Inventory page', () => {
  it('offers the people whose Inventory view is Field, and not the ones at the counter', async () => {
    renderWithProviders(<InventoryPage />, { initialEntries: ['/inventory'], ability: inventoryWriteAbility() });

    await userEvent.click(await screen.findByText('Add Location / Van').catch(async () => {
      await userEvent.click(await screen.findByRole('button', { name: /all locations/i }));
      return screen.findByText('Add Location / Van');
    }));
    const dialog = within(await screen.findByRole('dialog'));
    await userEvent.click(dialog.getByRole('button', { name: /Truck \/ Van/ }));

    const names = await optionNames(await dialog.findByRole('combobox', { name: 'Primary tech' }));
    expect(names.join('|')).toContain('Yolanda Yardlead');
    expect(names.join('|')).toContain('Quinn Roadcrew');
    expect(names.join('|')).not.toContain('Floyd Floorhand');
  });
});

describe('the Assigned tech picker on a staging dialog', () => {
  it('offers the people whose Inventory view is Field, and not the ones at the counter', async () => {
    const stage: JobStage = {
      id: h.STAGE_ID, jobNumber: 'J-1900', customer: 'Acme Corp', site: '1 Main St', trade: 'security', status: 'awaiting',
      items: [{ id: 'li-1', itemSku: 'CAM-01', itemName: 'Dome Camera', uom: 'EA', qtyOrdered: 2, qtyReceived: 0, vendor: 'Acme', poNumber: 'P00001', serialized: false }],
      photos: [], createdAt: '2026-07-01T00:00:00.000Z',
    };
    renderWithProviders(
      <StageDetailDialog open onClose={vi.fn()} stage={stage} locations={[]} onSave={vi.fn()} onReceiveOne={vi.fn()} />,
      { ability: inventoryWriteAbility() },
    );

    const names = await optionNames(await screen.findByRole('combobox', { name: 'Assigned tech' }));
    expect(names.join('|')).toContain('Yolanda Yardlead');
    expect(names.join('|')).toContain('Quinn Roadcrew');
    expect(names.join('|')).not.toContain('Floyd Floorhand');
  });
});
