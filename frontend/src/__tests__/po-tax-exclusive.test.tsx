// D6 — PO money surfaces are tax-exclusive (the invented 8.875% is gone) and the
// print preview shows the org brand, not "FieldOS".
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen } from '@testing-library/react';
import { renderWithProviders } from './helpers';
import { PODetailDialog } from '@/components/inventory/PODetailDialog';
import { POPreviewDialog } from '@/components/inventory/POPreviewDialog';
import { formatCurrency } from '@/lib/utils';
import type { PurchaseOrder } from '@/lib/api/inventory';

const ORG_NAME = 'ServWave Test Co';

const hoisted = vi.hoisted(() => ({
  org: { id: 'org-1', name: 'ServWave Test Co', default_inventory_location_id: 'loc-1' as string | null },
}));

vi.mock('@/lib/api/inventory', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api/inventory')>();
  const EMPTY: never[] = [];
  const stable =
    <T,>(data: T) =>
    () => ({ data, isLoading: false, isError: false });
  return {
    ...actual,
    useLocations: stable([{ id: 'loc-1', name: 'Main Warehouse', type: 'warehouse', branch: 'HQ' }]),
    useBranches: stable([{ id: 'br-1', name: 'HQ Branch', address: '1 Main St', phone: '5551234567', managerName: 'Manager' }]),
    useVendors: stable(EMPTY),
    useInventoryItems: stable(EMPTY),
    usePurchaseOrders: stable(EMPTY),
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

const PO_WITH_COSTS: PurchaseOrder = {
  id: 'po-tax-1', poNumber: 'PO-7777', vendor: 'Acme', status: 'ordered', orderedAt: '2026-05-20T00:00:00Z',
  lines: [{ id: 'l1', itemSku: 'A', itemName: 'Item A', uom: 'EA', qtyOrdered: 5, qtyReceived: 0, unitCost: 10 }],
};
const EXPECTED_SUBTOTAL = 50; // 5 × $10, no tax

beforeEach(() => {
  vi.clearAllMocks();
});

describe('D6 — PO tax-exclusive + preview branding', () => {
  it('PODetailDialog shows no tax row and Total equals Subtotal', () => {
    renderWithProviders(<PODetailDialog open onClose={vi.fn()} po={PO_WITH_COSTS} onReceive={vi.fn()} />);
    expect(screen.queryByText(/tax/i)).toBeNull();
    // Subtotal + Total (+ the line Ext.) all render $50.00 — never a taxed total.
    expect(screen.getAllByText(formatCurrency(EXPECTED_SUBTOTAL)).length).toBeGreaterThanOrEqual(2);
  });

  it('POPreviewDialog renders the org name (not FieldOS), no tax row, and Total equals Subtotal', () => {
    renderWithProviders(<POPreviewDialog open onClose={vi.fn()} po={PO_WITH_COSTS} />);
    expect(screen.queryByText(/FieldOS/i)).toBeNull();
    expect(screen.getAllByText(new RegExp(ORG_NAME, 'i')).length).toBeGreaterThan(0);
    expect(screen.queryByText(/^Tax$/)).toBeNull();
    expect(screen.getAllByText(formatCurrency(EXPECTED_SUBTOTAL)).length).toBeGreaterThanOrEqual(2);
  });
});
