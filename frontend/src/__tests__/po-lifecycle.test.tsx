// Purchasing Audit Verdict PR 2 (S2.2) — PODetailDialog lifecycle UI.
//
//   • draft → "Mark as ordered" (date input defaulting to today, POSTs mark-ordered)
//   • closed → "Reopen" (PATCH status received) · cancelled → no primary action
//   • a status select offering every status; Received / Partial open the Receive
//     dialog pre-filled with the remaining quantities, with "Skip, just set the
//     status" as the escape; Cancelled asks first
//   • Delete warns, DELETEs, and on 409 PO_HAS_RECEIPTS explains + offers Cancel PO
//   • "Notes to the vendor" PATCHes on blur
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
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
    ...actual, // useUpdatePO / useMarkOrdered / useDeletePO stay REAL — the wire calls are asserted
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

function po(over: Partial<PurchaseOrder> & { status: PurchaseOrder['status'] }): PurchaseOrder {
  return {
    id: `po-${over.status}-1`,
    poNumber: 'PO-7001',
    vendor: 'Acme Supply',
    orderedAt: over.status === 'draft' ? null : '2026-07-01T00:00:00Z',
    orderedBy: over.status === 'draft' ? null : { id: 'u1', name: 'Dana Buyer' },
    receivedAt: null,
    leadTimeDays: null,
    notes: null,
    signatureData: null,
    signatureName: null,
    signatureAt: null,
    createdAt: '2026-06-30T00:00:00Z',
    lines: [
      { id: 'l1', itemSku: 'A', itemName: 'Item A', uom: 'EA', qtyOrdered: 5, qtyReceived: 0, unitCost: 10 },
      { id: 'l2', itemSku: 'B', itemName: 'Item B', uom: 'EA', qtyOrdered: 3, qtyReceived: 1, unitCost: 4 },
    ],
    ...over,
  };
}

function todayISODate(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

const mockApi = vi.mocked(api);

function renderDialog(p: PurchaseOrder, extra: Partial<React.ComponentProps<typeof PODetailDialog>> = {}) {
  const onUpdated = vi.fn();
  const onDeleted = vi.fn();
  const onReceive = vi.fn();
  const onClose = vi.fn();
  renderWithProviders(
    <PODetailDialog open onClose={onClose} po={p} onReceive={onReceive} onUpdated={onUpdated} onDeleted={onDeleted} {...extra} />,
    { ability: inventoryWriteAbility() },
  );
  return { onUpdated, onDeleted, onReceive, onClose };
}

async function pickStatus(label: string) {
  const user = userEvent.setup();
  await user.click(screen.getByRole('combobox', { name: 'Status' }));
  await user.click(await screen.findByRole('option', { name: label }));
  return user;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('PODetailDialog — status-adaptive primary action (S2.2)', () => {
  it('draft: "Mark as ordered" opens a dated prompt (default today) and POSTs mark-ordered', async () => {
    const draft = po({ status: 'draft' });
    const ordered = { ...draft, status: 'ordered', orderedAt: '2026-09-02T04:00:00.000Z' };
    mockApi.post.mockResolvedValue({ data: { purchaseOrder: ordered } });
    const { onUpdated } = renderDialog(draft);

    // No Receive for an unordered PO; the primary action is the mark.
    expect(screen.queryByRole('button', { name: /receive items/i })).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: 'Mark as ordered' }));

    const dialog = await screen.findByRole('dialog', { name: /mark PO-7001 as ordered/i });
    const date = within(dialog).getByLabelText('Ordered on') as HTMLInputElement;
    // The DatePicker shows the day in US format; the ISO day still drives the payload below.
    expect(date.value).toBe(new Date(`${todayISODate()}T00:00:00`).toLocaleDateString('en-US', { month: '2-digit', day: '2-digit', year: 'numeric' }));

    await userEvent.click(within(dialog).getByRole('button', { name: 'Mark as ordered' }));

    await waitFor(() =>
      expect(mockApi.post).toHaveBeenCalledWith('/api/inventory/purchase-orders/po-draft-1/mark-ordered', {
        orderedAt: new Date(`${todayISODate()}T00:00:00`).toISOString(),
      }),
    );
    await waitFor(() => expect(onUpdated).toHaveBeenCalledWith(ordered));
    expect(mockApi.patch).not.toHaveBeenCalled();
  });

  it('a back-dated order date is sent as that day', async () => {
    mockApi.post.mockResolvedValue({ data: { purchaseOrder: po({ status: 'ordered' }) } });
    renderDialog(po({ status: 'draft' }));

    await userEvent.click(screen.getByRole('button', { name: 'Mark as ordered' }));
    const dialog = await screen.findByRole('dialog', { name: /mark PO-7001 as ordered/i });
    const date = within(dialog).getByLabelText('Ordered on');
    await userEvent.clear(date);
    await userEvent.type(date, '2026-08-20');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Mark as ordered' }));

    await waitFor(() =>
      expect(mockApi.post).toHaveBeenCalledWith(
        '/api/inventory/purchase-orders/po-draft-1/mark-ordered',
        { orderedAt: new Date('2026-08-20T00:00:00').toISOString() },
      ),
    );
  });

  it('ordered: Receive; received: Close PO; closed: Reopen patches status received; cancelled: nothing', async () => {
    const { unmount: u1 } = renderWithProviders(<PODetailDialog open onClose={vi.fn()} po={po({ status: 'ordered' })} />, { ability: inventoryWriteAbility() });
    expect(screen.getByRole('button', { name: /receive items/i })).toBeInTheDocument();
    u1();

    const { unmount: u2 } = renderWithProviders(<PODetailDialog open onClose={vi.fn()} po={po({ status: 'received', receivedAt: '2026-07-10T00:00:00Z' })} />, { ability: inventoryWriteAbility() });
    expect(screen.getByRole('button', { name: /close po/i })).toBeInTheDocument();
    u2();

    mockApi.patch.mockResolvedValue({ data: { purchaseOrder: po({ status: 'received' }) } });
    const { onUpdated } = renderDialog(po({ status: 'closed', receivedAt: '2026-07-10T00:00:00Z' }));
    await userEvent.click(screen.getByRole('button', { name: 'Reopen' }));
    await waitFor(() =>
      expect(mockApi.patch).toHaveBeenCalledWith('/api/inventory/purchase-orders/po-closed-1', { status: 'received' }),
    );
    await waitFor(() => expect(onUpdated).toHaveBeenCalled());
  });

  it('cancelled: no primary action, only Close / Preview / Delete', () => {
    renderDialog(po({ status: 'cancelled' }));
    const names = screen.getAllByRole('button').map((b) => b.textContent?.trim());
    expect(names).toEqual(expect.arrayContaining(['Close', 'Preview / Print', 'Delete']));
    expect(names).not.toEqual(expect.arrayContaining(['Mark as ordered', 'Receive items', 'Close PO', 'Reopen']));
  });

  it('shows who marked it ordered, and the received date once stamped', () => {
    renderDialog(po({ status: 'received', receivedAt: '2026-07-12T12:00:00Z' }));
    expect(screen.getByText(/by Dana Buyer/)).toBeInTheDocument();
    // The header's "Received <date>" pair (the chip and the column header say
    // "Received" too, so anchor on the stamp itself).
    expect(screen.getByText('Jul 12, 2026')).toBeInTheDocument();
  });
});

describe('PODetailDialog — status select (S2.2)', () => {
  it('lists all six statuses, labelled off the registry', async () => {
    renderDialog(po({ status: 'ordered' }));
    const user = userEvent.setup();
    await user.click(screen.getByRole('combobox', { name: 'Status' }));
    const options = (await screen.findAllByRole('option')).map((o) => o.textContent);
    expect(options).toEqual(['Draft', 'Ordered', 'Partial', 'Received', 'Closed', 'Cancelled']);
  });

  it('picking Received opens the Receive dialog pre-filled with the remaining quantities', async () => {
    const { onReceive } = renderDialog(po({ status: 'ordered' }));
    await pickStatus('Received');

    // Receive mode: one spinbutton per line, seeded at the ORDERED quantity.
    const inputs = screen.getAllByRole('spinbutton') as HTMLInputElement[];
    expect(inputs.map((i) => i.value)).toEqual(['5', '3']);
    expect(screen.getByRole('button', { name: 'Skip, just set the status' })).toBeInTheDocument();
    expect(mockApi.patch).not.toHaveBeenCalled();

    await userEvent.click(screen.getByRole('button', { name: /save receipt/i }));
    expect(onReceive).toHaveBeenCalledWith({
      poId: 'po-ordered-1',
      destinationLocationId: hoisted.LOC_MAIN_ID,
      lines: [{ lineId: 'l1', qtyReceived: 5 }, { lineId: 'l2', qtyReceived: 3 }],
    });
  });

  it('"Skip, just set the status" PATCHes the status without touching stock', async () => {
    mockApi.patch.mockResolvedValue({ data: { purchaseOrder: po({ status: 'received' }) } });
    const { onReceive, onUpdated } = renderDialog(po({ status: 'ordered' }));
    await pickStatus('Received');

    await userEvent.click(screen.getByRole('button', { name: 'Skip, just set the status' }));

    await waitFor(() =>
      expect(mockApi.patch).toHaveBeenCalledWith('/api/inventory/purchase-orders/po-ordered-1', { status: 'received' }),
    );
    expect(onReceive).not.toHaveBeenCalled();
    await waitFor(() => expect(onUpdated).toHaveBeenCalled());
    // Receive mode is gone.
    expect(screen.queryByRole('button', { name: /save receipt/i })).toBeNull();
  });

  it('Partial pre-fills too; Cancel in the receive footer leaves the status alone', async () => {
    renderDialog(po({ status: 'ordered' }));
    await pickStatus('Partial');
    expect(screen.getByRole('button', { name: 'Skip, just set the status' })).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('button', { name: 'Skip, just set the status' })).toBeNull();
    expect(mockApi.patch).not.toHaveBeenCalled();
  });

  it('picking Cancelled asks first; Keep PO does nothing, Cancel PO patches', async () => {
    mockApi.patch.mockResolvedValue({ data: { purchaseOrder: po({ status: 'cancelled' }) } });
    renderDialog(po({ status: 'ordered' }));

    await pickStatus('Cancelled');
    expect(await screen.findByText('Cancel PO-7001?')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Keep PO' }));
    expect(mockApi.patch).not.toHaveBeenCalled();

    await pickStatus('Cancelled');
    await userEvent.click(await screen.findByRole('button', { name: 'Cancel PO' }));
    await waitFor(() =>
      expect(mockApi.patch).toHaveBeenCalledWith('/api/inventory/purchase-orders/po-ordered-1', { status: 'cancelled' }),
    );
  });

  it('picking Ordered on a never-ordered PO routes through Mark as ordered', async () => {
    renderDialog(po({ status: 'draft' }));
    await pickStatus('Ordered');
    expect(await screen.findByRole('dialog', { name: /mark PO-7001 as ordered/i })).toBeInTheDocument();
    expect(mockApi.patch).not.toHaveBeenCalled();
  });

  it('other picks (e.g. Closed) PATCH straight away', async () => {
    mockApi.patch.mockResolvedValue({ data: { purchaseOrder: po({ status: 'closed' }) } });
    renderDialog(po({ status: 'received', receivedAt: '2026-07-10T00:00:00Z' }));
    await pickStatus('Closed');
    await waitFor(() =>
      expect(mockApi.patch).toHaveBeenCalledWith('/api/inventory/purchase-orders/po-received-1', { status: 'closed' }),
    );
  });
});

describe('PODetailDialog — Delete (S2.2)', () => {
  it('warns, then DELETEs and reports up', async () => {
    mockApi.delete.mockResolvedValue({ status: 204 });
    const { onDeleted, onClose } = renderDialog(po({ status: 'ordered' }));

    await userEvent.click(screen.getByRole('button', { name: 'Delete' }));
    expect(await screen.findByText('Delete PO-7001?')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Delete PO' }));

    await waitFor(() => expect(mockApi.delete).toHaveBeenCalledWith('/api/inventory/purchase-orders/po-ordered-1'));
    await waitFor(() => expect(onDeleted).toHaveBeenCalledWith('po-ordered-1'));
    expect(onClose).toHaveBeenCalled();
  });

  it('Keep at the warning deletes nothing', async () => {
    renderDialog(po({ status: 'draft' }));
    await userEvent.click(screen.getByRole('button', { name: 'Delete' }));
    await userEvent.click(await screen.findByRole('button', { name: 'Keep' }));
    expect(mockApi.delete).not.toHaveBeenCalled();
  });

  it('409 PO_HAS_RECEIPTS: explains the block and offers Cancel PO instead', async () => {
    mockApi.delete.mockRejectedValue({
      response: {
        status: 409,
        data: {
          error: 'PO_HAS_RECEIPTS',
          message: 'Stock has been received against this PO. Correct the receipt to zero first, or cancel the PO instead.',
        },
      },
    });
    mockApi.patch.mockResolvedValue({ data: { purchaseOrder: po({ status: 'cancelled' }) } });
    const { onDeleted, onUpdated } = renderDialog(po({ status: 'partial' }));

    await userEvent.click(screen.getByRole('button', { name: 'Delete' }));
    await userEvent.click(await screen.findByRole('button', { name: 'Delete PO' }));

    expect(await screen.findByText("This PO can't be deleted")).toBeInTheDocument();
    expect(screen.getByText(/correct the receipt to zero first/i)).toBeInTheDocument();
    expect(onDeleted).not.toHaveBeenCalled();

    await userEvent.click(screen.getByRole('button', { name: 'Cancel PO instead' }));
    await waitFor(() =>
      expect(mockApi.patch).toHaveBeenCalledWith('/api/inventory/purchase-orders/po-partial-1', { status: 'cancelled' }),
    );
    await waitFor(() => expect(onUpdated).toHaveBeenCalled());
    await waitFor(() => expect(screen.queryByText("This PO can't be deleted")).toBeNull());
  });
});

describe('PODetailDialog — notes to the vendor (S2.2)', () => {
  it('PATCHes the notes when the field is left, and only when changed', async () => {
    mockApi.patch.mockResolvedValue({ data: { purchaseOrder: po({ status: 'draft', notes: 'Deliver to the back dock' }) } });
    renderDialog(po({ status: 'draft' }));

    const notes = screen.getByLabelText('Notes to the vendor');
    // Leaving an untouched field writes nothing.
    await userEvent.click(notes);
    await userEvent.tab();
    expect(mockApi.patch).not.toHaveBeenCalled();

    await userEvent.type(notes, 'Deliver to the back dock');
    await userEvent.tab();
    await waitFor(() =>
      expect(mockApi.patch).toHaveBeenCalledWith('/api/inventory/purchase-orders/po-draft-1', {
        notes: 'Deliver to the back dock',
      }),
    );
  });

  it('seeds the field from the PO and clears it to null', async () => {
    mockApi.patch.mockResolvedValue({ data: { purchaseOrder: po({ status: 'ordered', notes: null }) } });
    renderDialog(po({ status: 'ordered', notes: 'Gate code 4411' }));
    const notes = screen.getByLabelText('Notes to the vendor') as HTMLTextAreaElement;
    expect(notes.value).toBe('Gate code 4411');
    await userEvent.clear(notes);
    await userEvent.tab();
    await waitFor(() =>
      expect(mockApi.patch).toHaveBeenCalledWith('/api/inventory/purchase-orders/po-ordered-1', { notes: null }),
    );
  });
});
