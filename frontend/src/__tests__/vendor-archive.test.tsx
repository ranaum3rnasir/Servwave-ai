// Inventory P2 §8 (QA-610, A-17) — vendor archive-first delete:
//   • useDeleteVendor hits the canonical DELETE /api/inventory/vendors/:id.
//   • No optimistic pre-removal: a 409 VENDOR_HAS_POS keeps the row and flips
//     the vendor to archived (status inactive via the existing upsert) with the
//     guided toast; any other error keeps the row AND the status untouched.
//
// Re-pointed (PRD-1, S1.3): driven through `pages/v2/inventory/VendorsPage` —
// the page `/inventory/vendors` actually routes to
// (`pages/v2/routes/inventory.routes.tsx`). The unrouted v1 page this file used
// to import is deleted. The v2 page reports through the kit's sonner toaster,
// so the toast seam is spied there instead of read off the page.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithProviders, inventoryWriteAbility } from './helpers';
import api from '@/lib/axios';
import { toast } from '@/ui-kit/components/ui/sonner';

vi.mock('@/ui-kit/components/ui/sonner', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/ui-kit/components/ui/sonner')>()),
  toast: Object.assign(vi.fn(), { error: vi.fn() }),
}));

const mockToast = vi.mocked(toast);

const hoisted = vi.hoisted(() => ({
  VENDOR: {
    id: 'ddddddd1-0000-4000-8000-000000000001',
    name: 'ADI / Anixter',
    category: 'Security',
    status: 'active' as const,
    contactPersonName: 'Marcus Patel',
    contactEmail: 'ny-orders@adiglobal.com',
  },
}));

// Stable resolved seam mocks; the delete + upsert MUTATION hooks stay REAL so
// the axios spies assert the wire calls.
vi.mock('@/lib/api/inventory', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api/inventory')>();
  const EMPTY: never[] = [];
  const stable =
    <T,>(data: T) =>
    () => ({ data, isLoading: false, isError: false });
  return {
    ...actual,
    useVendors: stable([hoisted.VENDOR]),
    usePurchaseOrders: stable(EMPTY),
    useInventoryItems: stable(EMPTY),
  };
});

const { VendorsPage } = await import('@/pages/v2/inventory/VendorsPage');

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
global.ResizeObserver = ResizeObserverStub as unknown as typeof ResizeObserver;

// #2043 - was `manage Inventory` (the wrong-subject gate this fix removes);
// converted to the module's write ability (R14) - a bare `manage Inventory`
// role no longer covers vendor writes at all.
const inventoryAdmin = () => inventoryWriteAbility();

let deleteSpy: ReturnType<typeof vi.spyOn>;
let postSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  vi.clearAllMocks();
  deleteSpy = vi.spyOn(api, 'delete').mockResolvedValue({ data: {} });
  postSpy = vi.spyOn(api, 'post').mockResolvedValue({ data: {} });
});

function renderPage() {
  renderWithProviders(<VendorsPage />, {
    ability: inventoryAdmin(),
    initialEntries: ['/inventory/vendors'],
  });
}

async function openDeleteDialogAndConfirm() {
  // Card → VendorDetailDialog → Delete → DeleteVendorDialog → Delete permanently.
  await userEvent.click(await screen.findByText('ADI / Anixter'));
  await userEvent.click(await screen.findByRole('button', { name: /^delete$/i }));
  await userEvent.click(
    await screen.findByRole('button', { name: /delete permanently/i }),
  );
}

describe('VendorsPage (v2) — archive-first delete (P2 §8)', () => {
  it('happy path: hits DELETE /api/inventory/vendors/:id and removes the row', async () => {
    renderPage();

    await openDeleteDialogAndConfirm();

    await waitFor(() =>
      expect(deleteSpy).toHaveBeenCalledWith(
        `/api/inventory/vendors/${hoisted.VENDOR.id}`,
      ),
    );
    await waitFor(() =>
      expect(screen.queryByText('ADI / Anixter')).not.toBeInTheDocument(),
    );
    expect(mockToast).toHaveBeenCalledWith(
      expect.stringMatching(/Vendor "ADI \/ Anixter" deleted/),
    );
  });

  it('409 VENDOR_HAS_POS: row stays, vendor flips to Archived, guided toast shows', async () => {
    deleteSpy.mockRejectedValue({
      response: { status: 409, data: { error: 'VENDOR_HAS_POS', po_count: 3 } },
    });
    renderPage();

    await openDeleteDialogAndConfirm();

    await waitFor(() =>
      expect(mockToast.error).toHaveBeenCalledWith(
        expect.stringMatching(/"ADI \/ Anixter" has purchase orders .* archived instead of deleted/),
      ),
    );
    // The archive fallback runs through the EXISTING status upsert.
    expect(postSpy).toHaveBeenCalledWith(
      '/api/inventory/vendors',
      expect.objectContaining({ id: hoisted.VENDOR.id, status: 'inactive' }),
    );

    // The vendor still exists — under the Inactive filter with the Archived badge.
    await userEvent.click(screen.getByRole('button', { name: 'inactive' }));
    expect(await screen.findByText('ADI / Anixter')).toBeInTheDocument();
    expect(screen.getByText('Archived')).toBeInTheDocument();
  });

  it('non-409 error: row stays, generic toast, status untouched', async () => {
    deleteSpy.mockRejectedValue({ response: { status: 500, data: { error: 'boom' } } });
    renderPage();

    await openDeleteDialogAndConfirm();

    await waitFor(() =>
      expect(mockToast.error).toHaveBeenCalledWith(
        expect.stringMatching(/Could not delete "ADI \/ Anixter"/),
      ),
    );
    // Still active — never archived, no status write fired.
    expect(postSpy).not.toHaveBeenCalledWith(
      '/api/inventory/vendors',
      expect.objectContaining({ status: 'inactive' }),
    );
    expect(await screen.findByText('ADI / Anixter')).toBeInTheDocument();
  });
});
