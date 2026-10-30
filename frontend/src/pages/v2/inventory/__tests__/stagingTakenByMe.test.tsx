/**
 * Roles & Permissions S07.6 - "Taken by me" on the Staging tab. The button follows Pick up staged items alone (the
 * `pick_up_staged` ability), never Edit stock; a taken stage reads "Taken by <name>" and the time; the old "Mark
 * Delivered to Tech" control is gone. Abilities are built from the switches' grants, never from a role name.
 *
 * Drives the routed Staging tab body (`pages/v2/inventory/components/stagingView`, the file InventoryPage mounts).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import api from '@/lib/axios';
import { renderWithProviders } from '@/__tests__/helpers';
import { buildAbility, type AbilityRule } from '@/lib/ability';
import type { JobStage, Location } from '@/lib/api/inventory';

import { StagingView } from '../components/stagingView';

const mockApi = vi.mocked(api);
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

vi.mock('@/components/inventory/StageDetailDialog', () => ({ StageDetailDialog: () => null }));
vi.mock('@/components/inventory/CreateStageDialog', () => ({ CreateStageDialog: () => null }));
vi.mock('@/components/inventory/POPreviewDialog', () => ({ POPreviewDialog: () => null }));

const LOCATIONS: Location[] = [
  { id: 'loc-wh', name: 'Main Warehouse', type: 'warehouse', branch: 'HQ', stagingAreas: ['Zone A'] },
];

const VIEW_STOCK: AbilityRule = { action: 'read', subject: 'Inventory' };
const EDIT_STOCK: AbilityRule = { action: 'update', subject: 'Inventory' };
const PICK_UP_STAGED: AbilityRule = { action: 'pick_up_staged', subject: 'Inventory' };

function stage(over: Partial<JobStage> = {}): JobStage {
  return {
    id: 'stg-1',
    jobNumber: 'J-1850',
    customer: 'Acme Corp',
    site: '665 Fifth Ave',
    trade: 'security',
    status: 'ready_for_pickup',
    stagedLocationId: 'loc-wh',
    items: [
      { id: 'it-1', itemSku: 'CAM-01', itemName: 'Dome Camera', uom: 'EA', qtyOrdered: 2, qtyReceived: 2, vendor: 'N', poNumber: 'PO-1001', serialized: false },
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
  vi.clearAllMocks();
  h.stages = [stage()];
});

describe('Staging tab - "Taken by me" follows Pick up staged items', () => {
  it('shows it with Pick up staged items and Edit stock off', () => {
    renderTab([VIEW_STOCK, PICK_UP_STAGED]);

    expect(screen.getByRole('button', { name: 'Taken by me' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Receive +1' })).toBeNull();
  });

  it('is absent with Pick up staged items off, even with Edit stock on', () => {
    renderTab([VIEW_STOCK, EDIT_STOCK]);

    expect(screen.queryByRole('button', { name: 'Taken by me' })).toBeNull();
  });

  it('leaves no pickup button at all with both pickup switches off', () => {
    renderTab([VIEW_STOCK]);

    expect(screen.queryByRole('button', { name: /^Taken by/ })).toBeNull();
  });

  it('no longer offers "Mark Delivered to Tech", with or without Edit stock', () => {
    renderTab([VIEW_STOCK, EDIT_STOCK, PICK_UP_STAGED]);

    expect(screen.queryByRole('button', { name: /Mark Delivered/ })).toBeNull();
  });

  it('saves the pickup on the server and then shows who took it and when', async () => {
    mockApi.post.mockResolvedValue({
      data: {
        jobStage: stage({ status: 'delivered', takenAt: '2026-10-09T14:05:00Z', takenById: 'u-1', takenByName: 'Tom Hill', recordedById: 'u-1', recordedByName: 'Tom Hill' }),
      },
    });
    renderTab([VIEW_STOCK, PICK_UP_STAGED]);

    await userEvent.click(screen.getByRole('button', { name: 'Taken by me' }));

    expect(mockApi.post).toHaveBeenCalledWith('/api/inventory/job-stages/stg-1/taken-by-me');
    expect(await screen.findByText(/^Taken by Tom Hill · /)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Taken by me' })).toBeNull();
  });

  it('says so when the server refuses, and keeps the button', async () => {
    mockApi.post.mockRejectedValue({ response: { data: { error: 'These parts are already marked as taken.' } } });
    renderTab([VIEW_STOCK, PICK_UP_STAGED]);

    await userEvent.click(screen.getByRole('button', { name: 'Taken by me' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('These parts are already marked as taken.');
    expect(screen.getByRole('button', { name: 'Taken by me' })).toBeInTheDocument();
  });
});

describe('Staging tab - a taken stage', () => {
  const taken = {
    status: 'delivered' as const, takenAt: '2026-10-09T14:05:00Z', takenById: 'u-1', takenByName: 'Tom Hill',
    recordedById: 'u-1', recordedByName: 'Tom Hill',
  };

  it('reads "Taken by <name>" and the time to anyone who can see it, and offers no pickup button', () => {
    h.stages = [stage(taken)];
    renderTab([VIEW_STOCK, PICK_UP_STAGED]);

    expect(screen.getByText(/^Taken by Tom Hill · /)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Taken by me' })).toBeNull();
    expect(screen.queryByText(/recorded by/)).toBeNull();
  });

  it('adds ", recorded by <name>" only when someone else recorded it', () => {
    h.stages = [stage({ ...taken, recordedById: 'u-2', recordedByName: 'Lee Park' })];
    renderTab([VIEW_STOCK]);

    expect(screen.getByText(/^Taken by Tom Hill, recorded by Lee Park · /)).toBeInTheDocument();
  });
});
