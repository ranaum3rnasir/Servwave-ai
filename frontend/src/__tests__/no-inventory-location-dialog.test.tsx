// PRD-4 (B12 / S4.3): one "No inventory location" dialog wherever stock has to
// land and the company has no location at all. Shown by the Receive dialog
// (PODetailDialog receive mode) when the destination options are empty, and by
// Create Pickup (CreateStageDialog) when the destination fallback resolves to
// nothing - which blocks the submit. Both link to /settings/locations.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithProviders, inventoryWriteAbility } from './helpers';
import { PODetailDialog } from '@/components/inventory/PODetailDialog';
import { CreateStageDialog } from '@/components/inventory/CreateStageDialog';
import PurchaseOrdersPage from '@/pages/v2/inventory/PurchaseOrdersPage';
import api from '@/lib/axios';
import { toast } from '@/ui-kit/components/ui/sonner';
import type { Location, PurchaseOrder } from '@/lib/api/inventory';

const hoisted = vi.hoisted(() => {
  const LOC_MAIN_ID = 'aaaaaaa1-0000-4000-8000-000000000001';
  const MAIN: { id: string; name: string; type: string; branch: string } = {
    id: LOC_MAIN_ID, name: 'Main Warehouse', type: 'warehouse', branch: 'HQ',
  };
  const ORDERED_PO = {
    id: 'po-1',
    poNumber: 'PO-4301',
    vendor: 'ADI / Anixter',
    status: 'ordered' as const,
    orderedAt: '2026-08-23T00:00:00Z',
    lines: [
      { id: 'line-1', itemSku: 'SKU-001', itemName: 'Strike', uom: 'EA', qtyOrdered: 5, qtyReceived: 0, unitCost: 100 },
    ],
  };
  return {
    LOC_MAIN_ID,
    MAIN,
    ORDERED_PO,
    // Mutable per test: the locations the org has, and its default destination.
    state: {
      locations: [] as Array<typeof MAIN>,
      org: { id: 'org-1', default_inventory_location_id: null as string | null },
    },
    createStageMutate: vi.fn(),
  };
});

vi.mock('@/ui-kit/components/ui/sonner', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/ui-kit/components/ui/sonner')>()),
  toast: Object.assign(vi.fn(), { error: vi.fn() }),
}));
const mockToast = vi.mocked(toast);

vi.mock('@/lib/api/inventory', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api/inventory')>();
  const EMPTY: never[] = [];
  const stable =
    <T,>(data: T) =>
    () => ({ data, isLoading: false, isError: false });
  return {
    ...actual, // useReceivePO stays REAL - the page test asserts the 409 branch
    useLocations: () => ({ data: hoisted.state.locations, isLoading: false, isError: false }),
    usePurchaseOrders: stable([hoisted.ORDERED_PO]),
    useInventoryJobs: stable(EMPTY),
    useVendors: stable(EMPTY),
    useInventoryItems: stable(EMPTY),
    useCategories: stable(EMPTY),
    useBrands: stable(EMPTY),
    useTechs: stable(EMPTY),
    useCreateStage: () => ({ mutate: hoisted.createStageMutate, mutateAsync: vi.fn(), isPending: false }),
  };
});

vi.mock('@/lib/api/organization', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api/organization')>();
  return {
    ...actual,
    useOrganization: () => ({ data: hoisted.state.org, isLoading: false, isError: false }),
  };
});

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
global.ResizeObserver = ResizeObserverStub as unknown as typeof ResizeObserver;

const ORDERED_PO = hoisted.ORDERED_PO as PurchaseOrder;
const MAIN = hoisted.MAIN as Location;

function noLocationDialog() {
  return screen.queryByTestId('no-inventory-location-dialog');
}

// The footer "Close" - the dialog chrome also carries an sr-only "Close" X.
function footerClose(dialog: HTMLElement) {
  const buttons = within(dialog).getAllByRole('button', { name: /^close$/i });
  return buttons[buttons.length - 1]!;
}

beforeEach(() => {
  vi.clearAllMocks();
  hoisted.state.locations = [];
  hoisted.state.org = { id: 'org-1', default_inventory_location_id: null };
});

describe('Receive dialog with no inventory location (S4.3)', () => {
  it('opens the dialog on Receive items, with a link to /settings/locations, and Save Receipt stays disabled', async () => {
    renderWithProviders(
      <PODetailDialog open onClose={vi.fn()} po={ORDERED_PO} onReceive={vi.fn()} />,
      { ability: inventoryWriteAbility() },
    );
    expect(noLocationDialog()).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: /receive items/i }));

    const dialog = await screen.findByTestId('no-inventory-location-dialog');
    expect(within(dialog).getByText('No inventory location yet')).toBeInTheDocument();
    expect(within(dialog).getByText(/Locations are managed under Settings → Locations/)).toBeInTheDocument();
    expect(within(dialog).getByRole('link', { name: /settings → locations/i })).toHaveAttribute(
      'href',
      '/settings/locations',
    );
    // The plain "No inventory locations available" dead end is gone.
    expect(screen.queryByText('No inventory locations available')).not.toBeInTheDocument();
    // `hidden`: the topmost Radix dialog aria-hides the detail dialog beneath it.
    expect(screen.getByRole('button', { name: /save receipt/i, hidden: true })).toBeDisabled();
  });

  it('Close keeps receive mode (the strip still points at Settings); no dialog when a location exists', async () => {
    const view = renderWithProviders(
      <PODetailDialog open onClose={vi.fn()} po={ORDERED_PO} onReceive={vi.fn()} />,
      { ability: inventoryWriteAbility() },
    );
    await userEvent.click(screen.getByRole('button', { name: /receive items/i }));
    const dialog = await screen.findByTestId('no-inventory-location-dialog');
    await userEvent.click(footerClose(dialog));
    await waitFor(() => expect(noLocationDialog()).not.toBeInTheDocument());

    // Still receiving: Cancel/Save are on the footer and the strip carries the link.
    expect(screen.getByRole('button', { name: /save receipt/i })).toBeDisabled();
    expect(screen.getByRole('link', { name: /add one in settings/i })).toHaveAttribute(
      'href',
      '/settings/locations',
    );

    // Regression guard: with a location the dialog never appears.
    hoisted.state.locations = [hoisted.MAIN];
    hoisted.state.org.default_inventory_location_id = hoisted.LOC_MAIN_ID;
    view.rerender(
      <PODetailDialog open onClose={vi.fn()} po={{ ...ORDERED_PO }} onReceive={vi.fn()} />,
    );
    await userEvent.click(await screen.findByRole('button', { name: /receive items/i }));
    expect(noLocationDialog()).not.toBeInTheDocument();
    expect(screen.getByRole('combobox', { name: 'Receive into' })).toHaveTextContent('Main Warehouse · HQ');
  });
});

describe('Create Pickup with no inventory location (S4.3)', () => {
  it('shows the dialog and does not create the stage', async () => {
    const onCreate = vi.fn();
    renderWithProviders(
      <CreateStageDialog open onClose={vi.fn()} locations={[]} onCreate={onCreate} />,
    );
    await userEvent.click(screen.getByRole('button', { name: /create pickup/i }));

    const dialog = await screen.findByTestId('no-inventory-location-dialog');
    expect(within(dialog).getByRole('link', { name: /settings → locations/i })).toHaveAttribute(
      'href',
      '/settings/locations',
    );
    expect(hoisted.createStageMutate).not.toHaveBeenCalled();
    expect(onCreate).not.toHaveBeenCalled();

    await userEvent.click(footerClose(dialog));
    await waitFor(() => expect(noLocationDialog()).not.toBeInTheDocument());
    // The pickup form is still open with the draft (nothing was reset or closed).
    expect(screen.getByRole('button', { name: /create pickup/i })).toBeInTheDocument();
  });

  it('with a location the submit path runs as before (form validation, not the dialog)', async () => {
    renderWithProviders(
      <CreateStageDialog open onClose={vi.fn()} locations={[MAIN]} onCreate={vi.fn()} />,
    );
    await userEvent.click(screen.getByRole('button', { name: /create pickup/i }));
    expect(noLocationDialog()).not.toBeInTheDocument();
    expect(screen.getByText('Job number is required.')).toBeInTheDocument();
  });
});

describe('PurchaseOrdersPage (v2) — server 409 NO_STOCK_LOCATION', () => {
  it('surfaces the server message as a human toast, never the machine code', async () => {
    hoisted.state.locations = [hoisted.MAIN];
    hoisted.state.org.default_inventory_location_id = hoisted.LOC_MAIN_ID;
    vi.spyOn(api, 'post').mockRejectedValue({
      response: {
        status: 409,
        data: {
          error: 'NO_STOCK_LOCATION',
          message: 'Add an inventory location under Settings → Locations before receiving.',
        },
      },
    });
    renderWithProviders(<PurchaseOrdersPage />, {
      ability: inventoryWriteAbility(),
      initialEntries: ['/inventory/purchase-orders?status=ordered'],
    });

    await userEvent.click(await screen.findByText('PO-4301'));
    await userEvent.click(await screen.findByRole('button', { name: /receive items/i }));
    await userEvent.click(screen.getByRole('button', { name: /receive all/i }));
    await userEvent.click(screen.getByRole('button', { name: /save receipt/i }));

    await waitFor(() =>
      expect(mockToast.error).toHaveBeenCalledWith(
        'No inventory location yet',
        expect.objectContaining({ description: expect.stringMatching(/Settings → Locations/) }),
      ),
    );
    expect(mockToast.error).not.toHaveBeenCalledWith('NO_STOCK_LOCATION');
  });
});
