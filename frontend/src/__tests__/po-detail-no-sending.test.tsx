// Purchasing Audit Verdict PR 1 (S1.1) — ServWave never sends a PO. The PO
// detail dialog has exactly two tabs (Lines · Activity), offers no Send/Email
// action for any status, and a draft's primary action is Preview / Print.
import { describe, it, expect, vi } from 'vitest';
import { screen } from '@testing-library/react';
import { renderWithProviders } from './helpers';
import { PODetailDialog } from '@/components/inventory/PODetailDialog';
import type { PurchaseOrder } from '@/lib/api/inventory';

vi.mock('@/lib/api/inventory', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api/inventory')>();
  const stable =
    <T,>(data: T) =>
    () => ({ data, isLoading: false, isError: false });
  return {
    ...actual,
    useLocations: stable([]),
    usePurchaseOrders: stable([]),
    useVendors: stable([]),
    useBranches: stable([]),
    useUpdatePO: () => ({ mutate: vi.fn(), isPending: false }),
    usePOActivity: stable([]),
  };
});

vi.mock('@/lib/api/organization', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api/organization')>();
  return {
    ...actual,
    useOrganization: () => ({ data: { id: 'org-1', name: 'ServWave', default_inventory_location_id: null }, isLoading: false, isError: false }),
  };
});

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
global.ResizeObserver = ResizeObserverStub as unknown as typeof ResizeObserver;

function po(status: PurchaseOrder['status']): PurchaseOrder {
  return {
    id: `po-${status}`,
    poNumber: 'PO-3101',
    vendor: 'Acme Supply',
    status,
    orderedAt: '2026-08-01T00:00:00Z',
    lines: [{ id: 'l1', itemSku: 'A', itemName: 'Item A', uom: 'EA', qtyOrdered: 5, qtyReceived: status === 'received' ? 5 : 0, unitCost: 10 }],
  };
}

describe('PODetailDialog — no sending surface (S1.1)', () => {
  it('a draft PO shows exactly two tabs, Lines and Activity', () => {
    renderWithProviders(<PODetailDialog open onClose={vi.fn()} po={po('draft')} onReceive={vi.fn()} />);

    expect(screen.getByRole('button', { name: /^lines/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^activity$/i })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /documents/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /3-way match/i })).toBeNull();
  });

  it.each(['draft', 'sent', 'partial', 'received', 'closed'] as const)(
    'offers no Send or Email action for a %s PO',
    (status) => {
      renderWithProviders(<PODetailDialog open onClose={vi.fn()} po={po(status)} onReceive={vi.fn()} />);
      expect(screen.queryByRole('button', { name: /send|email/i })).toBeNull();
    },
  );

  it("a draft PO offers Preview / Print once, not twice", () => {
    renderWithProviders(<PODetailDialog open onClose={vi.fn()} po={po('draft')} onReceive={vi.fn()} />);
    expect(screen.getAllByRole('button', { name: /preview \/ print/i })).toHaveLength(1);
  });
});
