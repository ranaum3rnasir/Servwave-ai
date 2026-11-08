// PRD-1 (S1.3): ServWave never sends a PO. The staging "Create Pickup" dialog
// used to carry an "Email PO to Vendor" / "Email N Vendor POs" action that
// composed one synthetic sub-PO per vendor and emailed each. That button, its
// tooltip and the synthetic-PO queue are gone; Preview PO and Create Pickup
// remain the only footer actions besides Cancel.
import { describe, it, expect, vi } from 'vitest';
import { screen } from '@testing-library/react';
import { renderWithProviders } from './helpers';
import { CreateStageDialog } from '@/components/inventory/CreateStageDialog';
import type { Location, PurchaseOrder } from '@/lib/api/inventory';

vi.mock('@/lib/api/inventory', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api/inventory')>();
  const items = [
    {
      id: 'itm_1', sku: 'SKU-001', name: 'Deadbolt', category: 'Locksets', trade: 'locksmith',
      kind: 'material', uom: 'EA', unitCost: 10, sellPrice: 25, serialized: false, hazmat: false,
      status: 'active', vendor: 'Acme', stock: [], updatedAt: '2026-05-01T00:00:00Z',
    },
  ];
  const vendors = [{ id: 'vnd_1', name: 'Acme', category: 'Hardware' }];
  const jobs = [
    { id: 'job_1', jobNumber: 'J-1850', customer: 'Rolex 5th Ave', site: '665 Fifth Ave, NY', trade: 'multi', status: 'scheduled' },
  ];
  const purchaseOrders = [
    {
      id: 'po_1', poNumber: 'PO-2401', vendor: 'Acme', status: 'ordered', jobNumber: 'J-1850',
      orderedAt: '2026-05-20T00:00:00Z',
      lines: [{ id: 'l1', itemSku: 'SKU-001', itemName: 'Deadbolt', uom: 'EA', qtyOrdered: 2, qtyReceived: 0 }],
    },
  ];
  const stable = <T,>(data: T) => () => ({ data, isLoading: false, isError: false });
  return {
    ...actual,
    useInventoryItems: stable(items),
    useVendors: stable(vendors),
    usePurchaseOrders: stable(purchaseOrders),
    useInventoryJobs: stable(jobs),
    useTechs: stable([]),
    useCreateStage: () => ({ mutateAsync: vi.fn(), mutate: vi.fn(), isPending: false }),
  };
});

const LOCATIONS: Location[] = [
  { id: 'loc_1', name: 'Main Warehouse', type: 'warehouse', branch: 'Brooklyn HQ' },
];

const LINKED_PO = {
  id: 'po_1', poNumber: 'PO-2401', vendor: 'Acme', status: 'ordered', jobNumber: 'J-1850',
  orderedAt: '2026-05-20T00:00:00Z',
  lines: [{ id: 'l1', itemSku: 'SKU-001', itemName: 'Deadbolt', uom: 'EA', qtyOrdered: 2, qtyReceived: 0 }],
} as unknown as PurchaseOrder;

describe('CreateStageDialog — no email action (PRD-1 S1.3)', () => {
  it('offers Preview PO and Create Pickup, and nothing that emails', () => {
    renderWithProviders(
      <CreateStageDialog open onClose={vi.fn()} locations={LOCATIONS} onCreate={vi.fn()} />,
    );

    expect(screen.getByRole('button', { name: /preview po/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /create pickup/i })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /email/i })).not.toBeInTheDocument();
    expect(screen.queryByText(/split po on email/i)).not.toBeInTheDocument();
  });

  it('with a linked PO (the case that used to enable the email button) there is still no email action', () => {
    renderWithProviders(
      <CreateStageDialog
        open
        onClose={vi.fn()}
        locations={LOCATIONS}
        onCreate={vi.fn()}
        prefilledFromPO={LINKED_PO}
      />,
    );

    // Preview PO appears in the footer and beside the "Linked to PO-2401" pill.
    expect(screen.getAllByRole('button', { name: /preview po/i }).length).toBeGreaterThan(0);
    expect(screen.getByRole('button', { name: /create pickup/i })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /email/i })).not.toBeInTheDocument();
    expect(screen.queryByTitle(/email/i)).not.toBeInTheDocument();
  });
});
