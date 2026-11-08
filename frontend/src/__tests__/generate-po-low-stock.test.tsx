// Inventory P2 §3 (D16 entry #3, QA-612) — GeneratePODialog: low-stock
// proposals grouped per vendor, editable quantities, sequential per-group
// draft-PO creation (one failure doesn't abort the rest), navigate on success.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithProviders } from './helpers';
import { GeneratePODialog } from '@/components/inventory/GeneratePODialog';
import type { Item, Location } from '@/lib/api/inventory';

const hoisted = vi.hoisted(() => ({
  navigate: vi.fn(),
  mutateAsync: vi.fn(),
  toast: vi.fn(),
}));

vi.mock('react-router-dom', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-router-dom')>();
  return { ...actual, useNavigate: () => hoisted.navigate };
});

vi.mock('@/components/ui/use-toast', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/components/ui/use-toast')>();
  return { ...actual, toast: hoisted.toast };
});

vi.mock('@/lib/api/inventory', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api/inventory')>();
  const vendors = [
    { id: 'vnd-acme', name: 'Acme', category: 'Hardware', paymentTerms: 'Net 30', leadTimeDays: 3, transmitMethod: 'email', status: 'active' },
    { id: 'vnd-zeta', name: 'Zeta Supply', category: 'Hardware', paymentTerms: 'Net 30', leadTimeDays: 5, transmitMethod: 'email', status: 'active' },
  ];
  return {
    ...actual,
    useVendors: () => ({ data: vendors, isLoading: false, isError: false }),
    useCreatePO: () => ({ mutateAsync: hoisted.mutateAsync, mutate: vi.fn(), isPending: false }),
  };
});

const LOC: Location = { id: 'loc-1', name: 'Main Warehouse', type: 'warehouse', branch: 'HQ' };

let itemSeq = 0;
function lowItem(vendor: string, suggested = 3): Item {
  itemSeq += 1;
  return {
    id: `10000000-0000-4000-8000-00000000000${itemSeq}`,
    sku: `LOW-00${itemSeq}`,
    name: `Low item ${itemSeq}`,
    category: 'Hardware',
    trade: 'security',
    kind: 'material',
    uom: 'EA',
    unitCost: 25,
    sellPrice: 60,
    serialized: false,
    hazmat: false,
    status: 'active',
    vendor,
    stock: [{ locationId: LOC.id, onHand: 0, min: suggested }],
    updatedAt: '2026-07-01T00:00:00Z',
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  itemSeq = 0;
  hoisted.mutateAsync.mockResolvedValue({ purchaseOrder: { poNumber: 'P00042' } });
});

describe('GeneratePODialog — low-stock proposals (P2 §3, QA-612)', () => {
  it('creates one draft PO per vendor group, sequentially, and deep-links to the drafts', async () => {
    const items = [lowItem('Acme'), lowItem('Acme', 5), lowItem('Zeta Supply', 2)];
    renderWithProviders(
      <GeneratePODialog open onClose={vi.fn()} items={items} locations={[LOC]} />,
    );

    await userEvent.click(screen.getByRole('button', { name: /create 2 draft pos/i }));

    await waitFor(() => expect(hoisted.mutateAsync).toHaveBeenCalledTimes(2));
    // Alphabetical group order: Acme (2 lines) then Zeta Supply (1 line).
    expect(hoisted.mutateAsync.mock.calls[0][0]).toMatchObject({
      vendor: 'Acme',
      vendorId: 'vnd-acme',
      status: 'draft',
    });
    expect(hoisted.mutateAsync.mock.calls[0][0].lines).toHaveLength(2);
    expect(hoisted.mutateAsync.mock.calls[0][0].lines[0]).toMatchObject({
      itemSku: 'LOW-001',
      qtyOrdered: 3,
      qtyReceived: 0,
      unitCost: 25,
    });
    expect(hoisted.mutateAsync.mock.calls[1][0]).toMatchObject({
      vendor: 'Zeta Supply',
      vendorId: 'vnd-zeta',
    });

    expect(hoisted.navigate).toHaveBeenCalledWith('/inventory/purchase-orders?status=draft');
  });

  it('edited quantities override the suggestion in the payload', async () => {
    const items = [lowItem('Acme', 3)];
    renderWithProviders(
      <GeneratePODialog open onClose={vi.fn()} items={items} locations={[LOC]} />,
    );

    const qty = screen.getByLabelText('Quantity for Low item 1');
    await userEvent.clear(qty);
    await userEvent.type(qty, '12');
    await userEvent.click(screen.getByRole('button', { name: /create 1 draft po/i }));

    await waitFor(() => expect(hoisted.mutateAsync).toHaveBeenCalledTimes(1));
    expect(hoisted.mutateAsync.mock.calls[0][0].lines[0].qtyOrdered).toBe(12);
  });

  it('one failing group does not abort the rest — both attempted, navigation still fires', async () => {
    hoisted.mutateAsync
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValueOnce({ purchaseOrder: { poNumber: 'P00043' } });
    const items = [lowItem('Acme'), lowItem('Zeta Supply')];
    renderWithProviders(
      <GeneratePODialog open onClose={vi.fn()} items={items} locations={[LOC]} />,
    );

    await userEvent.click(screen.getByRole('button', { name: /create 2 draft pos/i }));

    await waitFor(() => expect(hoisted.mutateAsync).toHaveBeenCalledTimes(2));
    // Aggregate failure surfaced once, success path still navigates (1 created).
    expect(hoisted.toast).toHaveBeenCalledWith(
      expect.objectContaining({ variant: 'destructive' }),
    );
    expect(hoisted.navigate).toHaveBeenCalledWith('/inventory/purchase-orders?status=draft');
  });

  it('the no-vendor group blocks Create until a vendor is picked (other groups unaffected)', async () => {
    const items = [lowItem('Ghost Vendor')]; // matches no vendor row → null group
    renderWithProviders(
      <GeneratePODialog open onClose={vi.fn()} items={items} locations={[LOC]} />,
    );

    expect(screen.getByText('No preferred vendor')).toBeInTheDocument();
    const createBtn = screen.getByRole('button', { name: /create 0 draft pos/i });
    expect(createBtn).toBeDisabled();
    expect(screen.getByText(/skipped until a vendor is picked/i)).toBeInTheDocument();

    await userEvent.click(
      screen.getByRole('combobox', { name: 'Vendor for unassigned items' }),
    );
    await userEvent.click(await screen.findByText('Acme'));

    const enabled = await screen.findByRole('button', { name: /create 1 draft po/i });
    expect(enabled).toBeEnabled();

    await userEvent.click(enabled);
    await waitFor(() => expect(hoisted.mutateAsync).toHaveBeenCalledTimes(1));
    expect(hoisted.mutateAsync.mock.calls[0][0]).toMatchObject({ vendor: 'Acme', vendorId: 'vnd-acme' });
  });
});
