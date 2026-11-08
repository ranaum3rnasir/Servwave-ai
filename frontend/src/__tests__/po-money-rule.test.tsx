// Purchasing Audit Verdict PR 3 (S3.2) - one money rule everywhere.
//
// A PO whose lines carry NO unit cost but ARE linked to catalog items must show
// the SAME non-zero total in the grid, the CSV, the detail dialog and the
// print preview: line cost, then catalog cost, then $0 (`lib/inventory/po-money`).
// Before this slice the grid/detail/preview said $0.00 for such a PO while the
// vendor-spend leaderboard priced the same lines from the catalog.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithProviders } from './helpers';
import { formatCurrency } from '@/lib/utils';

const hoisted = vi.hoisted(() => {
  // 3 × $12.50 (catalog) + 2 × $4.00 (line cost wins over the $99 catalog) + 5 × $0 (unpriced) = 45.5
  const po = {
    id: 'f0000001-0000-0000-0000-000000000001',
    poNumber: 'PO-3201',
    vendor: 'Acme Supply',
    vendorId: 'e0000001-0000-0000-0000-000000000001',
    status: 'ordered' as const,
    orderedAt: '2026-08-01T12:00:00Z',
    orderedBy: null,
    expectedDate: '2026-08-10T00:00:00Z',
    receivedAt: null,
    leadTimeDays: null,
    notes: null,
    signatureData: null,
    signatureName: null,
    signatureAt: null,
    createdAt: '2026-07-30T09:00:00Z',
    lines: [
      { id: 'l1', itemSku: 'CAP-01', itemName: 'Run Capacitor', uom: 'ea', qtyOrdered: 3, qtyReceived: 0, catalogUnitCost: 12.5, priceBookItemId: 'i1' },
      { id: 'l2', itemSku: 'FUSE-02', itemName: 'Fuse', uom: 'ea', qtyOrdered: 2, qtyReceived: 0, unitCost: 4, catalogUnitCost: 99, priceBookItemId: 'i2' },
      { id: 'l3', itemSku: '', itemName: 'Custom bracket', uom: 'ea', qtyOrdered: 5, qtyReceived: 0, catalogUnitCost: null },
    ],
  };
  return {
    po,
    pos: [po],
    org: { id: 'org-1', name: 'ServWave Test Co', default_inventory_location_id: 'loc-1' as string | null },
    toCSV: vi.fn((_rows: Record<string, unknown>[]) => 'csv-content'),
    downloadCSV: vi.fn(),
  };
});
const EXPECTED_TOTAL = 45.5;

vi.mock('@/lib/inventory/csv', () => ({ toCSV: hoisted.toCSV, downloadCSV: hoisted.downloadCSV }));

vi.mock('@/lib/api/inventory', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api/inventory')>();
  const EMPTY: never[] = [];
  const stable = <T,>(data: T) => () => ({ data, isLoading: false, isError: false });
  const mutation = () => ({ mutate: vi.fn(), mutateAsync: vi.fn(), isPending: false });
  return {
    ...actual,
    usePurchaseOrders: stable(hoisted.pos as unknown as import('@/lib/api/inventory').PurchaseOrder[]),
    useInventoryJobs: stable(EMPTY),
    useVendors: stable(EMPTY),
    useInventoryItems: stable(EMPTY),
    useCategories: stable(EMPTY),
    useBrands: stable(EMPTY),
    useBranches: stable(EMPTY),
    useLocations: stable([{ id: 'loc-1', name: 'Main Warehouse', type: 'warehouse', branch: 'HQ' }]),
    usePOActivity: stable(EMPTY),
    useCreatePO: mutation,
    useReceivePO: mutation,
    useUpdatePO: mutation,
    useMarkOrdered: mutation,
    useDeletePO: mutation,
  };
});

vi.mock('@/lib/api/organization', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api/organization')>();
  return { ...actual, useOrganization: () => ({ data: hoisted.org, isLoading: false, isError: false }) };
});

const { default: PurchaseOrdersPage } = await import('@/pages/v2/inventory/PurchaseOrdersPage');
const { PODetailDialog } = await import('@/components/inventory/PODetailDialog');
const { POPreviewDialog } = await import('@/components/inventory/POPreviewDialog');

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
global.ResizeObserver = ResizeObserverStub as unknown as typeof ResizeObserver;

beforeEach(() => {
  vi.clearAllMocks();
});

const po = hoisted.po as unknown as import('@/lib/api/inventory').PurchaseOrder;

describe('one money rule (S3.2) - grid, CSV, detail and preview agree', () => {
  it('the Open grid row and its CSV export price catalog-linked lines by catalog cost', async () => {
    renderWithProviders(<PurchaseOrdersPage />, { initialEntries: ['/inventory/purchase-orders'] });
    const row = (await screen.findByText('PO-3201')).closest('tr')!;
    expect(within(row).getByText(formatCurrency(EXPECTED_TOTAL))).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: /^export$/i }));
    await waitFor(() => expect(hoisted.downloadCSV).toHaveBeenCalled());
    const rows = hoisted.toCSV.mock.calls[0]![0] as Record<string, unknown>[];
    expect(rows[0]).toMatchObject({ 'PO #': 'PO-3201', Total: EXPECTED_TOTAL });
  });

  it('the detail dialog shows the catalog cost per line and the same total', () => {
    renderWithProviders(<PODetailDialog open onClose={vi.fn()} po={po} onReceive={vi.fn()} />);
    // Subtotal + Total both print the rule's answer.
    expect(screen.getAllByText(formatCurrency(EXPECTED_TOTAL)).length).toBeGreaterThanOrEqual(2);
    // The catalog-priced line shows its effective unit cost and extension...
    const capRow = screen.getByText('Run Capacitor').closest('tr')!;
    expect(within(capRow).getByText(formatCurrency(12.5))).toBeInTheDocument();
    expect(within(capRow).getByText(formatCurrency(37.5))).toBeInTheDocument();
    // ...the line with its own cost ignores the catalog...
    const fuseRow = screen.getByText('Fuse').closest('tr')!;
    expect(within(fuseRow).getByText(formatCurrency(4))).toBeInTheDocument();
    expect(within(fuseRow).getByText(formatCurrency(8))).toBeInTheDocument();
    // ...and a line with no price from either source still renders "—", never a fake $0.
    const bracketRow = screen.getByText('Custom bracket').closest('tr')!;
    expect(within(bracketRow).getAllByText('—').length).toBeGreaterThanOrEqual(2);
  });

  it('the print preview prices the same way', () => {
    renderWithProviders(<POPreviewDialog open onClose={vi.fn()} po={po} />);
    expect(screen.getAllByText(formatCurrency(EXPECTED_TOTAL)).length).toBeGreaterThanOrEqual(2);
    const capRow = screen.getByText('Run Capacitor').closest('tr')!;
    expect(within(capRow).getByText(formatCurrency(12.5))).toBeInTheDocument();
    expect(within(capRow).getByText(formatCurrency(37.5))).toBeInTheDocument();
    const bracketRow = screen.getByText('Custom bracket').closest('tr')!;
    expect(within(bracketRow).getByText('—')).toBeInTheDocument();
  });
});
