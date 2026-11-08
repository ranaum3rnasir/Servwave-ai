// Regression (PRD-4 S4.4): confirming a Staging pickup wrote it to the
// database TWICE.
//
// `CreateStageDialog.submit()` is the sole writer of a new stage: it POSTs
// `/api/inventory/job-stages` and then calls `onCreate(stage)` so the parent can
// show the card. The routed v2 view (`pages/v2/inventory/components/stagingView`)
// fired `createStage.mutate(stage)` from that `onCreate` handler as well, so one
// click produced two POSTs, two `job_stages` rows and two sets of movements.
// The unrouted v1 view had already lost its second writer; the v2 presentation
// swap re-introduced it and the old `staging-create-once` test only ever drove
// the v1 view, so nothing caught it.
//
// This suite drives the ROUTED view with the REAL `CreateStageDialog` and the
// REAL `useCreateStage` hook, and counts calls on the axios client itself. Any
// second writer anywhere in the tree - dialog, view, or a future hook - shows
// up as a second POST.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, fireEvent } from '@testing-library/react';
import { renderWithProviders, inventoryWriteAbility } from './helpers';
import api from '@/lib/axios';
import type { Location } from '@/lib/api/inventory';
import { StagingView } from '@/pages/v2/inventory/components/stagingView';

vi.mock('@/lib/api/inventory', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api/inventory')>();
  const EMPTY: never[] = [];
  const stable =
    <T,>(data: T) =>
    () => ({ data, isLoading: false, isError: false });
  const mutation = () => ({ mutate: vi.fn(), mutateAsync: vi.fn(), isPending: false });
  return {
    ...actual,
    // Queries are pinned so the dialog and the view render deterministically.
    useJobStages: stable(EMPTY),
    usePurchaseOrders: stable(EMPTY),
    useVendors: stable(EMPTY),
    useInventoryItems: stable(EMPTY),
    useInventoryJobs: stable(EMPTY),
    useTechs: stable(EMPTY),
    // `useCreateStage` is deliberately NOT stubbed: the real hook must reach
    // the (setup.ts-mocked) axios client so the assertion counts POSTs, not
    // hook calls.
    useReceiveStageLine: mutation,
    useNotifyTechReady: mutation,
  };
});

const LOCATIONS: Location[] = [
  { id: 'loc_wh', name: 'Main Warehouse', type: 'warehouse', branch: 'HQ' },
];

const STAGE_POSTS = () =>
  vi.mocked(api.post).mock.calls.filter(([url]) => url === '/api/inventory/job-stages');

beforeEach(() => {
  vi.mocked(api.post).mockReset();
  vi.mocked(api.post).mockResolvedValue({ data: { stage: { id: 'stg_srv_1' } } });
});

function fillAndSubmitNewPickup() {
  // Exact name - the empty state also renders a "Create New Pickup" CTA.
  fireEvent.click(screen.getByRole('button', { name: 'New Pickup' }));
  fireEvent.change(screen.getByPlaceholderText(/type new job #/i), {
    target: { value: 'J-1870' },
  });
  fireEvent.change(screen.getByPlaceholderText('Rolex 5th Ave'), {
    target: { value: 'LVD' },
  });
  // The single starter line needs a quantity and a PO number to pass validation.
  fireEvent.change(screen.getByPlaceholderText('0'), { target: { value: '1' } });
  fireEvent.change(screen.getByPlaceholderText('PO-…'), { target: { value: '967678' } });
  fireEvent.click(screen.getByRole('button', { name: /create pickup/i }));
}

describe('routed StagingView - a new pickup is persisted exactly once (S4.4)', () => {
  it('POSTs /api/inventory/job-stages a single time per confirm', async () => {
    const onToast = vi.fn();
    renderWithProviders(<StagingView locations={LOCATIONS} onToast={onToast} />, {
      initialEntries: ['/inventory/staging'],
      // #2043 - New Pickup gates on create Inventory.
      ability: inventoryWriteAbility(),
    });

    fillAndSubmitNewPickup();

    await vi.waitFor(() => expect(STAGE_POSTS().length).toBeGreaterThan(0));
    // Let any second mutation scheduled by the same click flush before counting.
    await new Promise((r) => setTimeout(r, 50));

    expect(STAGE_POSTS()).toHaveLength(1);
    // The view still confirms the create to the user exactly once.
    expect(onToast).toHaveBeenCalledTimes(1);
    expect(onToast).toHaveBeenCalledWith(expect.stringContaining('Pickup created for J-1870'));
  });

  it('that one POST is the dialog payload: job + customer + the link keys', async () => {
    renderWithProviders(<StagingView locations={LOCATIONS} onToast={vi.fn()} />, {
      initialEntries: ['/inventory/staging'],
      ability: inventoryWriteAbility(),
    });

    fillAndSubmitNewPickup();

    await vi.waitFor(() => expect(STAGE_POSTS()).toHaveLength(1));
    const [, payload] = STAGE_POSTS()[0]!;
    expect(payload).toMatchObject({ jobNumber: 'J-1870', customer: 'LVD', stagedLocationId: 'loc_wh' });
    // No job picked and no PO linked in this flow, so both links are absent
    // rather than wrong - but the keys must exist on the payload builder, which
    // distinguishes the dialog's `stagePayload` from the bare view-shape stage
    // the second (removed) writer used to send.
    expect(payload).toHaveProperty('jobId');
    expect(payload).toHaveProperty('linkedPurchaseOrderId');
  });
});
