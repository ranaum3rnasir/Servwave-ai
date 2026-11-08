/**
 * Purchasing Audit Verdict PR 3 (S3.2) - vendor spend on the Vendors page is
 * keyed on the vendor ID, counts ordered-or-later POs only, prices lines by the
 * one money rule, and a vendor with no spend is still on the leaderboard at $0.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { renderWithProviders } from '@/__tests__/helpers';

const hoisted = vi.hoisted(() => {
  const ACME_ID = 'e0000001-0000-0000-0000-000000000001';
  const BORDER_ID = 'e0000002-0000-0000-0000-000000000001';
  function vendor(id: string, name: string, category: string) {
    return { id, name, category, contactPersonName: `Rep ${name}`, status: 'active' as const };
  }
  function po(n: number, vendorId: string, vendorName: string, status: 'draft' | 'ordered' | 'received') {
    return {
      id: `f000000${n}-0000-0000-0000-000000000001`,
      poNumber: `PO-320${n}`,
      vendor: vendorName,
      vendorId,
      status,
      orderedAt: status === 'draft' ? null : new Date().toISOString(),
      orderedBy: null,
      receivedAt: null,
      leadTimeDays: null,
      notes: null,
      signatureData: null,
      signatureName: null,
      signatureAt: null,
      createdAt: new Date().toISOString(),
      lines: [
        // No line cost: priced from the catalog cost the server ships on the line.
        { id: `l${n}`, itemSku: 'CAP-01', itemName: 'Run Capacitor', uom: 'ea', qtyOrdered: 10, qtyReceived: 0, catalogUnitCost: 12 },
      ],
    };
  }
  return {
    ACME_ID,
    BORDER_ID,
    // Acme was RENAMED after its PO was placed: the PO's name snapshot is stale,
    // only the id still matches.
    vendors: [vendor(ACME_ID, 'ACME Industrial', 'HVAC'), vendor(BORDER_ID, 'Border Parts', 'Electrical')],
    pos: [
      po(1, ACME_ID, 'Acme Supply', 'received'),   // $120 counts
      po(2, BORDER_ID, 'Border Parts', 'draft'),   // $0 - a draft is not spend
    ],
    items: [],
  };
});

/** Seam-mocked with stable data (see vendorSpendBulkExport.test.tsx for why). */
vi.mock('@/lib/api/inventory', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api/inventory')>();
  type Api = typeof import('@/lib/api/inventory');
  const stable = <T,>(data: T) => () => ({ data, isLoading: false, isError: false });
  const mutation = () => ({ mutate: vi.fn(), mutateAsync: vi.fn(), isPending: false });
  return {
    ...actual,
    useVendors: stable(hoisted.vendors as unknown as ReturnType<Api['useVendors']>['data']),
    usePurchaseOrders: stable(hoisted.pos as unknown as ReturnType<Api['usePurchaseOrders']>['data']),
    useInventoryItems: stable(hoisted.items as unknown as ReturnType<Api['useInventoryItems']>['data']),
    useUpsertVendor: mutation,
    useDeleteVendor: mutation,
  };
});

const { VendorsPage } = await import('../VendorsPage');

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
global.ResizeObserver = ResizeObserverStub as unknown as typeof ResizeObserver;

beforeEach(() => {
  vi.clearAllMocks();
});

describe('vendor spend - one money rule, keyed on id (S3.2)', () => {
  it('a renamed vendor keeps its spend, a draft-only vendor ranks at $0, and the YTD tile is the sum', async () => {
    renderWithProviders(<VendorsPage />, { initialEntries: ['/inventory/vendors'] });
    await userEvent.click(await screen.findByRole('tab', { name: /Spend Analytics/ }));

    const acmeRow = (await screen.findByText('ACME Industrial')).closest('tr')!;
    expect(within(acmeRow).getByText('$120')).toBeInTheDocument();

    // Border Parts has only a draft: still listed, at $0 (not filtered out).
    const borderRow = screen.getByText('Border Parts').closest('tr')!;
    expect(within(borderRow).getByText('$0')).toBeInTheDocument();

    // The stat tile reads the same index.
    expect(screen.getByText('Total Spend YTD').parentElement!.textContent).toContain('$120');
  });

  it('the directory cards read the same index: the renamed vendor at $120, the draft-only vendor at $0 with no orders', async () => {
    renderWithProviders(<VendorsPage />, { initialEntries: ['/inventory/vendors'] });
    // VendorCard's root is a whole-card <button>; its spend strip prints fmtMoney(spend.ytd).
    const acmeCard = (await screen.findByText('ACME Industrial')).closest('button')!;
    expect(within(acmeCard).getByText('$120')).toBeInTheDocument();
    expect(within(acmeCard).getByText(/1 POs/)).toBeInTheDocument();

    const borderCard = screen.getByText('Border Parts').closest('button')!;
    expect(within(borderCard).getByText('$0')).toBeInTheDocument();
    expect(within(borderCard).getByText(/0 POs/)).toBeInTheDocument();
    expect(within(borderCard).getByText('no orders')).toBeInTheDocument();
  });
});
