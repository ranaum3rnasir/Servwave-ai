// D3 — PODetailDialog "Close PO" action: a received PO closes without a
// confirm; a partial PO force-closes behind a window.confirm (open items).
// PR 2 (S2.2): a closed PO reopens to received.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithProviders, inventoryWriteAbility } from './helpers';
import { PODetailDialog } from '@/components/inventory/PODetailDialog';
import api from '@/lib/axios';
import type { PurchaseOrder } from '@/lib/api/inventory';

const hoisted = vi.hoisted(() => ({
  LOC_MAIN_ID: 'aaaaaaa1-0000-4000-8000-000000000001',
  org: { id: 'org-1', default_inventory_location_id: 'aaaaaaa1-0000-4000-8000-000000000001' as string | null },
}));

vi.mock('@/lib/api/inventory', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api/inventory')>();
  const EMPTY: never[] = [];
  const stable =
    <T,>(data: T) =>
    () => ({ data, isLoading: false, isError: false });
  return {
    ...actual, // useUpdatePO stays REAL — the test asserts the PATCH wire call
    useLocations: stable([{ id: hoisted.LOC_MAIN_ID, name: 'Main Warehouse', type: 'warehouse', branch: 'HQ' }]),
    usePurchaseOrders: stable(EMPTY),
    useVendors: stable(EMPTY),
    useInventoryItems: stable(EMPTY),
    useBranches: stable(EMPTY),
  };
});

vi.mock('@/lib/api/organization', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api/organization')>();
  return { ...actual, useOrganization: () => ({ data: hoisted.org, isLoading: false, isError: false }) };
});

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
global.ResizeObserver = ResizeObserverStub as unknown as typeof ResizeObserver;

const BASE = {
  vendor: 'Acme', orderedAt: '2026-05-20T00:00:00Z', orderedBy: null, receivedAt: null, leadTimeDays: null,
  notes: null, signatureData: null, signatureName: null, signatureAt: null, createdAt: '2026-05-19T00:00:00Z',
};
const RECEIVED_PO: PurchaseOrder = {
  ...BASE, id: 'po-recv-1', poNumber: 'PO-9001', status: 'received', receivedAt: '2026-05-28T00:00:00Z',
  lines: [{ id: 'l1', itemSku: 'A', itemName: 'Item A', uom: 'EA', qtyOrdered: 5, qtyReceived: 5, unitCost: 10 }],
};
const PARTIAL_PO: PurchaseOrder = {
  ...BASE, id: 'po-part-1', poNumber: 'PO-9002', status: 'partial',
  lines: [{ id: 'l1', itemSku: 'A', itemName: 'Item A', uom: 'EA', qtyOrdered: 5, qtyReceived: 2, unitCost: 10 }],
};
const CLOSED_PO: PurchaseOrder = {
  ...BASE, id: 'po-closed-1', poNumber: 'PO-9003', status: 'closed', receivedAt: '2026-05-28T00:00:00Z',
  lines: [{ id: 'l1', itemSku: 'A', itemName: 'Item A', uom: 'EA', qtyOrdered: 5, qtyReceived: 5, unitCost: 10 }],
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe('PODetailDialog — Close PO (D3)', () => {
  it('received PO: Close PO patches status:closed without a confirm', async () => {
    const patchSpy = vi.spyOn(api, 'patch').mockResolvedValue({ data: { purchaseOrder: {} } });
    renderWithProviders(<PODetailDialog open onClose={vi.fn()} po={RECEIVED_PO} onReceive={vi.fn()} />, { ability: inventoryWriteAbility() });

    await userEvent.click(screen.getByRole('button', { name: /close po/i }));
    expect(patchSpy).toHaveBeenCalledWith('/api/inventory/purchase-orders/po-recv-1', { status: 'closed' });
  });

  it('partial PO: Close PO asks to confirm; proceeds only when confirmed', async () => {
    const patchSpy = vi.spyOn(api, 'patch').mockResolvedValue({ data: { purchaseOrder: {} } });
    const confirmSpy = vi.spyOn(window, 'confirm');
    renderWithProviders(<PODetailDialog open onClose={vi.fn()} po={PARTIAL_PO} onReceive={vi.fn()} />, { ability: inventoryWriteAbility() });

    // Cancel path.
    await userEvent.click(screen.getByRole('button', { name: /close po/i }));
    expect(await screen.findByText(/still open - close this PO anyway\?/i)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(patchSpy).not.toHaveBeenCalled(); // cancelled at the confirm

    // Confirm path.
    await userEvent.click(screen.getByRole('button', { name: /close po/i }));
    await userEvent.click(await screen.findByRole('button', { name: 'Close anyway' }));
    expect(patchSpy).toHaveBeenCalledWith('/api/inventory/purchase-orders/po-part-1', { status: 'closed' });

    // The prompt is the app's own dialog now, never the browser's.
    expect(confirmSpy).not.toHaveBeenCalled();
  });

  it('closed PO: Reopen patches status:received (S2.2)', async () => {
    const patchSpy = vi.spyOn(api, 'patch').mockResolvedValue({ data: { purchaseOrder: { ...CLOSED_PO, status: 'received' } } });
    renderWithProviders(<PODetailDialog open onClose={vi.fn()} po={CLOSED_PO} onReceive={vi.fn()} />, { ability: inventoryWriteAbility() });

    expect(screen.queryByRole('button', { name: /close po/i })).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: 'Reopen' }));
    expect(patchSpy).toHaveBeenCalledWith('/api/inventory/purchase-orders/po-closed-1', { status: 'received' });
  });
});
