/**
 * The v2 Staging tab body - `pages/v2/inventory/components/stagingView.tsx`.
 *
 * NOT a port: there is no legacy StagingView suite to port. The task brief
 * assumed one existed; the whole repo has no test that imports
 * `components/inventory/StagingView`, and the only staging coverage is
 * `stage-attachment-upload.test.tsx`, which tests `StageDetailDialog` - a
 * component this rebuild KEEPS legacy and does not touch. So this file is net
 * new, written against the contract the rebuild claims to have preserved
 * verbatim, and it is the first coverage this 970-line view has ever had on
 * either layer.
 *
 * The four mutation/validation surfaces the rebuild keeps legacy
 * (`CreateStageDialog`, `StageDetailDialog`, `POPreviewDialog`,
 * `StagingAreaPicker`) are stubbed so the assertions are about the VIEW: which
 * props it hands them, and when.
 *
 * One documented divergence is pinned rather than described: the trade chip
 * capitalises from a label map instead of CSS (`locksmith` -> `Locksmith`).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { renderWithProviders, inventoryWriteAbility } from '@/__tests__/helpers';
import type { JobStage, Location, PurchaseOrder } from '@/lib/api/inventory';

import { useNavHistory } from '../../navHistory.store';
import { StagingView } from '../components/stagingView';

const h = vi.hoisted(() => ({
  createStage: vi.fn(),
  receiveStageLine: vi.fn(),
  notifyTechReady: vi.fn(),
  stageDetailProps: vi.fn(),
  createStageProps: vi.fn(),
  poPreviewProps: vi.fn(),
  stagingAreaProps: vi.fn(),
  stages: [] as JobStage[],
  purchaseOrders: [] as PurchaseOrder[],
}));

vi.mock('@/lib/api/inventory', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api/inventory')>();
  return {
    ...actual,
    useJobStages: () => ({ data: h.stages, isLoading: false, isError: false }),
    usePurchaseOrders: () => ({ data: h.purchaseOrders, isLoading: false, isError: false }),
    useVendors: () => ({ data: [{ id: 'vnd-1', name: 'ADI' }], isLoading: false, isError: false }),
    useCreateStage: () => ({ mutate: h.createStage, mutateAsync: h.createStage, isPending: false }),
    useReceiveStageLine: () => ({ mutate: h.receiveStageLine, mutateAsync: h.receiveStageLine, isPending: false }),
    useNotifyTechReady: () => ({ mutate: h.notifyTechReady, mutateAsync: h.notifyTechReady, isPending: false }),
  };
});

// KEPT-LEGACY surfaces: stubbed to record the props the view hands them.
vi.mock('@/components/inventory/StageDetailDialog', () => ({
  StageDetailDialog: (props: { open: boolean; stage: JobStage | null }) => {
    h.stageDetailProps(props);
    return props.open ? <div data-testid="stage-detail">{props.stage?.jobNumber}</div> : null;
  },
}));
vi.mock('@/components/inventory/CreateStageDialog', () => ({
  CreateStageDialog: (props: { open: boolean; prefilledFromPO: PurchaseOrder | null }) => {
    h.createStageProps(props);
    return props.open ? (
      <div data-testid="create-stage">{props.prefilledFromPO?.poNumber ?? 'blank'}</div>
    ) : null;
  },
}));
vi.mock('@/components/inventory/POPreviewDialog', () => ({
  POPreviewDialog: (props: { open: boolean; poNumber: string | null }) => {
    h.poPreviewProps(props);
    return props.open ? <div data-testid="po-preview">{props.poNumber}</div> : null;
  },
}));
vi.mock('@/components/inventory/StagingAreaPicker', () => ({
  StagingAreaPicker: (props: { value?: string; onChange: (next: string | undefined) => void }) => {
    h.stagingAreaProps(props);
    return (
      <button type="button" onClick={() => props.onChange('Zone A')}>
        pick staging area
      </button>
    );
  },
}));

const LOCATIONS: Location[] = [
  { id: 'loc-wh', name: 'Main Warehouse', type: 'warehouse', branch: 'HQ', stagingAreas: ['Zone A'] },
];

function item(over: Partial<JobStage['items'][number]> = {}): JobStage['items'][number] {
  return {
    id: 'it-1',
    itemSku: 'CAM-01',
    itemName: 'Dome Camera',
    uom: 'EA',
    qtyOrdered: 2,
    qtyReceived: 0,
    vendor: 'ADI',
    poNumber: 'PO-1001',
    serialized: false,
    ...over,
  };
}

function stage(over: Partial<JobStage> = {}): JobStage {
  return {
    id: 'stg-1',
    jobNumber: 'J-1850',
    customer: 'Rolex 5th Ave',
    site: '665 Fifth Ave',
    trade: 'locksmith',
    status: 'awaiting',
    stagedLocationId: 'loc-wh',
    items: [item()],
    createdAt: '2026-05-21T09:14:00Z',
    ...over,
  };
}

function po(over: Partial<PurchaseOrder> = {}): PurchaseOrder {
  return {
    id: 'po-1',
    poNumber: 'PO-2305',
    vendor: 'ADI',
    status: 'ordered',
    orderedAt: '2026-05-23T11:00:00Z',
    orderedBy: null,
    receivedAt: null,
    leadTimeDays: null,
    notes: null,
    signatureData: null,
    signatureName: null,
    signatureAt: null,
    createdAt: '2026-05-23T10:00:00Z',
    lines: [
      { itemSku: 'CAM-01', itemName: 'Dome Camera', uom: 'EA', qtyOrdered: 3, qtyReceived: 0 },
    ],
    ...over,
  };
}

function renderStaging(props: Partial<React.ComponentProps<typeof StagingView>> = {}) {
  const onToast = vi.fn();
  const result = renderWithProviders(
    <StagingView locations={LOCATIONS} onToast={onToast} {...props} />,
    // #2043 - New Pickup / Receive +1 / Notify / staging-area picker all gate
    // on create/update Inventory now; this suite exercises the writer's path.
    { initialEntries: ['/inventory/staging'], ability: inventoryWriteAbility() },
  );
  return { onToast, ...result };
}

beforeEach(() => {
  vi.clearAllMocks();
  h.stages = [stage()];
  h.purchaseOrders = [];
});

describe('v2 StagingView - header and breadcrumb', () => {
  /**
   * The trail is not a hierarchy (`Home > Operations > Staging`) but the last
   * few pages visited, and this view is a TAB of the inventory page rather than
   * a page of its own. It used to register itself as `Staging`, which meant
   * clicking through the tab strip appended a crumb per tab and reading the
   * trail suggested a journey across several pages. Naming the section is now
   * `InventoryPage`'s job alone, so this view records nothing - see
   * `navHistory.store.ts`'s `canonicalPath` and the tab cases in
   * `pages/v2/__tests__/pageBreadcrumbs.test.tsx`.
   */
  it('renders the page title, and leaves the trail to the inventory page', () => {
    useNavHistory.getState().clear();
    renderStaging();

    expect(screen.getByRole('heading', { name: 'Job Staging' })).toBeInTheDocument();
    expect(useNavHistory.getState().visits).toEqual([]);
  });
});

describe('v2 StagingView - the KPI / chip filter coupling', () => {
  beforeEach(() => {
    h.stages = [
      stage({ id: 'stg-a', jobNumber: 'J-AAA', status: 'awaiting' }),
      stage({ id: 'stg-b', jobNumber: 'J-BBB', status: 'partial' }),
      stage({ id: 'stg-c', jobNumber: 'J-CCC', status: 'complete' }),
    ];
  });

  /**
   * A tile and its chip carry the SAME accessible name (label + count), which
   * is the point - they are one control in two places. The tile is the one
   * outside the chip group.
   */
  function tile(label: string, count: number) {
    const group = screen.getByRole('group', { name: 'Stage filter' });
    const matches = screen.getAllByRole('button', {
      name: new RegExp(`^${label}\\s*${count}$`),
    });
    const outside = matches.find((el) => !group.contains(el));
    expect(outside).toBeDefined();
    return outside!;
  }

  it('the five tiles count the five buckets', () => {
    renderStaging();
    expect(tile('Active Stages', 3)).toBeInTheDocument();
    expect(tile('Awaiting', 1)).toBeInTheDocument();
    expect(tile('Partial', 1)).toBeInTheDocument();
    expect(tile('Ready', 1)).toBeInTheDocument();
    expect(tile('Ready for pickup', 0)).toBeInTheDocument();
  });

  it('clicking a tile narrows the card list - tiles and chips are the SAME filter state', async () => {
    renderStaging();
    expect(screen.getByText('J-AAA')).toBeInTheDocument();
    expect(screen.getByText('J-BBB')).toBeInTheDocument();

    await userEvent.click(tile('Partial', 1));

    expect(screen.getByText('J-BBB')).toBeInTheDocument();
    expect(screen.queryByText('J-AAA')).not.toBeInTheDocument();
    // The chip for the same bucket is now the pressed one - one state, two
    // controls, which is the coupling the rebuild had to keep.
    const group = within(screen.getByRole('group', { name: 'Stage filter' }));
    expect(group.getByRole('button', { name: /^Partial/ })).toHaveAttribute('aria-pressed', 'true');
    expect(group.getByRole('button', { name: /^All Stages/ })).toHaveAttribute('aria-pressed', 'false');
  });

  it('a chip narrows the list the same way and carries its own count', async () => {
    renderStaging();
    const group = within(screen.getByRole('group', { name: 'Stage filter' }));
    const readyChip = group.getByRole('button', { name: /^Ready\s*1$/ });

    await userEvent.click(readyChip);

    expect(screen.getByText('J-CCC')).toBeInTheDocument();
    expect(screen.queryByText('J-AAA')).not.toBeInTheDocument();
  });

  it('a filter that matches nothing shows the empty card with its create action', async () => {
    renderStaging();
    const group = within(screen.getByRole('group', { name: 'Stage filter' }));
    await userEvent.click(group.getByRole('button', { name: /Ready for pickup/ }));

    expect(screen.getByText('No staged jobs match this filter.')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: /Create New Pickup/ }));
    expect(screen.getByTestId('create-stage')).toHaveTextContent('blank');
  });
});

describe('v2 StagingView - the trade chip (documented divergence)', () => {
  it('capitalises from the label map instead of CSS, and multi reads Multi-trade', () => {
    h.stages = [
      stage({ id: 'stg-a', jobNumber: 'J-AAA', trade: 'locksmith' }),
      stage({ id: 'stg-b', jobNumber: 'J-BBB', trade: 'multi' }),
    ];
    renderStaging();
    expect(screen.getByText('Locksmith')).toBeInTheDocument();
    expect(screen.queryByText('locksmith')).toBeNull();
    expect(screen.getByText('Multi-trade')).toBeInTheDocument();
  });
});

describe('v2 StagingView - receive one unit', () => {
  it('fires the mutation and recomputes awaiting -> partial -> complete', async () => {
    renderStaging(); // one stage, one line, 0 of 2 received, status awaiting

    const receive = screen.getByRole('button', { name: 'Receive +1' });
    await userEvent.click(receive);

    expect(h.receiveStageLine).toHaveBeenCalledWith({ stageId: 'stg-1', itemId: 'it-1' });
    expect(screen.getByText('1 backordered')).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Receive +1' }));

    // Fully received: the line reads Complete and the stage flipped to the
    // ready bucket, which is what surfaces the notify action.
    expect(screen.getByText('Complete')).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: /Notify Tech · Ready for Pickup/ }),
    ).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Receive +1' })).toBeNull();
  });
});

describe('v2 StagingView - mark ready / mark delivered', () => {
  it('a complete stage notifies the tech and toasts the ready-for-pickup line', async () => {
    h.stages = [stage({ status: 'complete', items: [item({ qtyReceived: 2 })] })];
    const { onToast } = renderStaging();

    await userEvent.click(screen.getByRole('button', { name: /Notify Tech · Ready for Pickup/ }));

    expect(h.notifyTechReady).toHaveBeenCalledWith({ stageId: 'stg-1' });
    expect(onToast).toHaveBeenCalledWith('✓ J-1850 marked ready for pickup · tech notified');
  });

  it('a ready-for-pickup stage marks delivered and toasts that instead', async () => {
    h.stages = [stage({ status: 'ready_for_pickup', items: [item({ qtyReceived: 2 })] })];
    const { onToast } = renderStaging();

    await userEvent.click(screen.getByRole('button', { name: /Mark Delivered to Tech/ }));

    expect(onToast).toHaveBeenCalledWith('✓ J-1850 marked delivered');
  });
});

describe('v2 StagingView - the From PO picker', () => {
  it('offers only POs that are not staged, not received and not closed', async () => {
    h.purchaseOrders = [
      po({ id: 'po-open', poNumber: 'PO-OPEN' }),
      po({ id: 'po-recv', poNumber: 'PO-RECV', status: 'received' }),
      po({ id: 'po-clsd', poNumber: 'PO-CLSD', status: 'closed' }),
      po({ id: 'po-stgd', poNumber: 'PO-STGD', stagedAsJobStageId: 'stg-9' }),
      // Already staged by line reference, even without stagedAsJobStageId.
      po({ id: 'po-line', poNumber: 'PO-1001' }),
    ];
    renderStaging();

    const trigger = screen.getByRole('button', { name: /From PO/ });
    expect(within(trigger).getByText('1')).toBeInTheDocument();

    await userEvent.click(trigger);

    expect(await screen.findByText('PO-OPEN')).toBeInTheDocument();
    expect(screen.queryByText('PO-RECV')).toBeNull();
    expect(screen.queryByText('PO-CLSD')).toBeNull();
    expect(screen.queryByText('PO-STGD')).toBeNull();
  });

  it('picking a PO pre-fills the create dialog with it', async () => {
    h.purchaseOrders = [po({ id: 'po-open', poNumber: 'PO-OPEN' })];
    renderStaging();

    await userEvent.click(screen.getByRole('button', { name: /From PO/ }));
    await userEvent.click(await screen.findByText('PO-OPEN'));

    expect(screen.getByTestId('create-stage')).toHaveTextContent('PO-OPEN');
  });

  it('an empty picker says so', async () => {
    renderStaging();
    await userEvent.click(screen.getByRole('button', { name: /From PO/ }));
    expect(await screen.findByText(/All open POs are already staged/)).toBeInTheDocument();
  });
});

describe('v2 StagingView - the bell intent contract', () => {
  it('a pendingIntent opens StageDetailDialog on that stage', () => {
    renderStaging({ pendingIntent: { id: 'stg-1', nonce: 1 } });
    expect(screen.getByTestId('stage-detail')).toHaveTextContent('J-1850');
  });

  it('re-firing the SAME id with a new nonce re-opens it after a close', async () => {
    const { rerender, onToast } = renderStaging({ pendingIntent: { id: 'stg-1', nonce: 1 } });
    expect(screen.getByTestId('stage-detail')).toBeInTheDocument();

    // The dialog's own close path runs through the view's onClose prop.
    const lastProps = h.stageDetailProps.mock.calls.at(-1)![0] as { onClose: () => void };
    lastProps.onClose();
    await vi.waitFor(() => expect(screen.queryByTestId('stage-detail')).toBeNull());

    rerender(
      <StagingView
        locations={LOCATIONS}
        onToast={onToast}
        pendingIntent={{ id: 'stg-1', nonce: 2 }}
      />,
    );
    expect(screen.getByTestId('stage-detail')).toHaveTextContent('J-1850');
  });
});

describe('v2 StagingView - the staging area', () => {
  it('picking an area toasts and records an audit entry with the actor', async () => {
    const { onToast } = renderStaging();

    await userEvent.click(screen.getByRole('button', { name: 'pick staging area' }));

    expect(onToast).toHaveBeenCalledWith('📍 J-1850 staged in Zone A');
    // The picker is re-rendered with the new value ...
    const pickerProps = h.stagingAreaProps.mock.calls.at(-1)![0] as { value?: string };
    expect(pickerProps.value).toBe('Zone A');

    // ... and the change is recorded in the stage's audit log, with the actor
    // taken from the auth store (the setup file's ADMIN user). Read through
    // the detail dialog, which is where the stage object is handed out.
    await userEvent.click(screen.getByRole('button', { name: 'J-1850' }));
    const { stage: opened } = h.stageDetailProps.mock.calls.at(-1)![0] as { stage: JobStage | null };
    expect(opened?.auditLog?.at(-1)).toMatchObject({
      actorName: 'Test Admin',
      field: 'stagedArea',
      newValue: 'Zone A',
      comment: 'Placed in "Zone A"',
    });
  });
});
