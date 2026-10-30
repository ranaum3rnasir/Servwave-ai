/**
 * Roles & Permissions S07.7 - "Taken by..." on the Staging tab. The button follows Record pickup for someone else alone (the
 * `record_pickup_for_other` ability), never Edit stock or Pick up staged items; its picker lists the people the server
 * returns, the stage's assigned person first; the saved record reads "Taken by <name>, recorded by <name>" and the time.
 * Abilities are built from the switches' grants, never from a role name.
 *
 * Drives the routed Staging tab body (`pages/v2/inventory/components/stagingView`, the file InventoryPage mounts).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, within } from '@testing-library/react';
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
const RECORD_FOR_OTHER: AbilityRule = { action: 'record_pickup_for_other', subject: 'Inventory' };

const PEOPLE_URL = '/api/inventory/job-stages/stg-1/pickup-people';
const TAKEN_BY_URL = '/api/inventory/job-stages/stg-1/taken-by';

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
  mockApi.get.mockImplementation(((url: string) =>
    url === PEOPLE_URL
      ? Promise.resolve({
          data: {
            people: [
              { id: 'u-zed', name: 'Zed Assigned', assigned: true },
              { id: 'u-ann', name: 'Ann Baker', assigned: false },
              { id: 'u-lee', name: 'Lee Park', assigned: false },
            ],
          },
        })
      : Promise.resolve({ data: {} })) as typeof mockApi.get);
});

describe('Staging tab - "Taken by..." follows Record pickup for someone else', () => {
  it('shows it with Record pickup for someone else and Edit stock and Pick up staged items off', () => {
    renderTab([VIEW_STOCK, RECORD_FOR_OTHER]);

    expect(screen.getByRole('button', { name: 'Taken by...' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Taken by me' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Receive +1' })).toBeNull();
  });

  it('is absent without the switch, even with Edit stock and Pick up staged items on', () => {
    renderTab([VIEW_STOCK, EDIT_STOCK, PICK_UP_STAGED]);

    expect(screen.queryByRole('button', { name: 'Taken by...' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Taken by me' })).toBeInTheDocument();
  });

  it('offers both buttons when both pickup switches are on, and neither when both are off', () => {
    const { unmount } = renderTab([VIEW_STOCK, PICK_UP_STAGED, RECORD_FOR_OTHER]);
    expect(screen.getByRole('button', { name: 'Taken by me' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Taken by...' })).toBeInTheDocument();
    unmount();

    renderTab([VIEW_STOCK, EDIT_STOCK]);
    expect(screen.queryByRole('button', { name: /^Taken by/ })).toBeNull();
  });

  it('lists the people the server returns, in its order, and records the chosen one on the server', async () => {
    mockApi.post.mockResolvedValue({
      data: {
        jobStage: stage({
          status: 'delivered', takenAt: '2026-10-09T14:05:00Z', takenById: 'u-lee', takenByName: 'Lee Park',
          recordedById: 'u-me', recordedByName: 'Rae Roe',
        }),
      },
    });
    renderTab([VIEW_STOCK, RECORD_FOR_OTHER]);

    await userEvent.click(screen.getByRole('button', { name: 'Taken by...' }));
    const dialog = await screen.findByRole('dialog');
    expect(mockApi.get).toHaveBeenCalledWith(PEOPLE_URL);
    await userEvent.click(await within(dialog).findByRole('combobox'));
    const names = screen.getAllByRole('option').map((o) => o.textContent ?? '');
    expect(names[0]).toMatch(/^Zed Assigned/);
    expect(names.map((n) => n.replace(/Assigned$/, '').trim())).toEqual(['Zed Assigned', 'Ann Baker', 'Lee Park']);
    await userEvent.click(screen.getByRole('option', { name: /Lee Park/ }));
    await userEvent.click(within(dialog).getByRole('button', { name: 'Record pickup' }));

    expect(mockApi.post).toHaveBeenCalledWith(TAKEN_BY_URL, { takenById: 'u-lee' });
    expect(await screen.findByText(/^Taken by Lee Park, recorded by Rae Roe · /)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Taken by...' })).toBeNull();
  });

  it('cannot record until a person is chosen', async () => {
    renderTab([VIEW_STOCK, RECORD_FOR_OTHER]);

    await userEvent.click(screen.getByRole('button', { name: 'Taken by...' }));
    const dialog = await screen.findByRole('dialog');

    expect(within(dialog).getByRole('button', { name: 'Record pickup' })).toBeDisabled();
    expect(mockApi.post).not.toHaveBeenCalled();
  });

  it('says so when the server refuses, and keeps the dialog open', async () => {
    mockApi.post.mockRejectedValue({ response: { data: { error: 'These parts are already marked as taken.' } } });
    renderTab([VIEW_STOCK, RECORD_FOR_OTHER]);

    await userEvent.click(screen.getByRole('button', { name: 'Taken by...' }));
    const dialog = await screen.findByRole('dialog');
    await userEvent.click(await within(dialog).findByRole('combobox'));
    await userEvent.click(screen.getByRole('option', { name: /Ann Baker/ }));
    await userEvent.click(within(dialog).getByRole('button', { name: 'Record pickup' }));

    expect(await within(dialog).findByRole('alert')).toHaveTextContent('These parts are already marked as taken.');
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });

  it('names no third-party service anywhere in the picker', async () => {
    renderTab([VIEW_STOCK, RECORD_FOR_OTHER]);

    await userEvent.click(screen.getByRole('button', { name: 'Taken by...' }));
    const dialog = await screen.findByRole('dialog');

    expect(dialog.textContent).not.toMatch(/stripe|twilio|resend|supabase|render|ctm|calltracking/i);
  });
});

describe('Staging tab - a stage someone else took', () => {
  const taken = {
    status: 'delivered' as const, takenAt: '2026-10-09T14:05:00Z', takenById: 'u-1', takenByName: 'Tom Hill',
    recordedById: 'u-2', recordedByName: 'Lee Park',
  };

  it('reads "Taken by <name>, recorded by <name>" and the time, and offers no pickup button', () => {
    h.stages = [stage(taken)];
    renderTab([VIEW_STOCK, PICK_UP_STAGED, RECORD_FOR_OTHER]);

    expect(screen.getByText(/^Taken by Tom Hill, recorded by Lee Park · /)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Taken by/ })).toBeNull();
  });

  it('omits "recorded by" when the person recorded their own pickup', () => {
    h.stages = [stage({ ...taken, recordedById: 'u-1', recordedByName: 'Tom Hill' })];
    renderTab([VIEW_STOCK]);

    expect(screen.getByText(/^Taken by Tom Hill · /)).toBeInTheDocument();
    expect(screen.queryByText(/recorded by/)).toBeNull();
  });
});
