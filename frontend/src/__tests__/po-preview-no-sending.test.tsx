// Purchasing Audit Verdict PR 1 (S1.1) — the printed PO no longer carries a
// "Ship To" branch block, no longer says the vendor signs via an emailed link,
// and has no Email button. The buyer signature field stays.
import { describe, it, expect, vi } from 'vitest';
import { screen } from '@testing-library/react';
import { renderWithProviders } from './helpers';
import { POPreviewDialog } from '@/components/inventory/POPreviewDialog';
import type { PurchaseOrder } from '@/lib/api/inventory';

vi.mock('@/lib/api/inventory', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api/inventory')>();
  const stable =
    <T,>(data: T) =>
    () => ({ data, isLoading: false, isError: false });
  return {
    ...actual,
    usePurchaseOrders: stable([]),
    useVendors: stable([{ id: 'v1', name: 'Acme Supply', category: 'Hardware', status: 'active' }]),
    useBranches: stable([{ id: 'b1', name: 'HQ', address: '1 Main St, Brooklyn NY', phone: '7185550100', managerName: 'Pat Manager' }]),
  };
});

vi.mock('@/lib/api/organization', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api/organization')>();
  return {
    ...actual,
    useOrganization: () => ({ data: { id: 'org-1', name: 'ServWave' }, isLoading: false, isError: false }),
  };
});

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
global.ResizeObserver = ResizeObserverStub as unknown as typeof ResizeObserver;

const PO: PurchaseOrder = {
  id: 'po-1',
  poNumber: 'PO-3102',
  vendor: 'Acme Supply',
  status: 'draft',
  orderedAt: '2026-08-01T00:00:00Z',
  jobNumber: 'J00042',
  customer: 'Jane Doe',
  lines: [{ id: 'l1', itemSku: 'A', itemName: 'Item A', uom: 'EA', qtyOrdered: 5, qtyReceived: 0, unitCost: 10 }],
};

describe('POPreviewDialog — document without sending language (S1.1)', () => {
  it('renders no Ship To block and no "signs via" line, keeps the buyer signature', () => {
    renderWithProviders(<POPreviewDialog open onClose={vi.fn()} po={PO} />);

    expect(screen.queryByText(/ship to/i)).toBeNull();
    expect(screen.queryByText(/signs via/i)).toBeNull();
    // Buyer signature field is still on the document.
    expect(screen.getByText(/authorized by/i)).toBeInTheDocument();
    // The job reference survives the Ship-to removal.
    expect(screen.getByText(/For Job · J00042/)).toBeInTheDocument();
  });

  it('offers no Email action — Print and Save as PDF are the only ways out', () => {
    renderWithProviders(<POPreviewDialog open onClose={vi.fn()} po={PO} />);

    expect(screen.queryByRole('button', { name: /email|send/i })).toBeNull();
    expect(screen.getByRole('button', { name: /^print$/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /save as pdf/i })).toBeInTheDocument();
  });
});
