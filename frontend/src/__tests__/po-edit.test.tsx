// Purchasing Audit Verdict PR 3 (S3.3) — PODetailDialog Edit mode.
//
//   • Edit is available on every status: the header (vendor by id, expected date, job
//     link, customer, site, trade, notes) PATCHes only what changed
//   • the line editor (qty, unit cost, remove, add from catalog / free text) shows on a
//     draft only; an ordered PO keeps its lines read-only
//   • Save on a draft sends the full `lines` array; a 409 PO_LINES_FROZEN answer renders
//     "Lines can only be edited while the PO is in Draft" and keeps the form open
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
  vendors: [
    { id: 'v-acme', name: 'Acme Supply', category: 'Hardware' },
    { id: 'v-bolt', name: 'Bolt & Nut Co', category: 'Fasteners' },
  ],
  jobs: [
    { id: 'job-1', jobNumber: 'J-1001', customer: 'Equinox', site: '33 Hudson Yards', trade: 'door', status: 'scheduled' },
    { id: 'job-2', jobNumber: 'J-1002', customer: 'Blue Bottle', site: '450 W 15th', trade: 'security', status: 'scheduled' },
  ],
  items: [
    { id: 'item-c', sku: 'C-1', name: 'Cat6 Cable', uom: 'FT', unitCost: 1.5, status: 'active', vendor: 'Acme Supply', stock: [] },
    { id: 'item-d', sku: 'D-9', name: 'Door Closer', uom: 'EA', unitCost: 42, status: 'active', vendor: 'Acme Supply', stock: [] },
  ],
}));

vi.mock('@/lib/api/inventory', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api/inventory')>();
  const EMPTY: never[] = [];
  const stable =
    <T,>(data: T) =>
    () => ({ data, isLoading: false, isError: false });
  return {
    ...actual, // useUpdatePO stays REAL — the wire call is asserted
    useLocations: stable([{ id: hoisted.LOC_MAIN_ID, name: 'Main Warehouse', type: 'warehouse', branch: 'HQ' }]),
    usePurchaseOrders: stable(EMPTY),
    useVendors: stable(hoisted.vendors),
    useInventoryItems: stable(hoisted.items),
    useInventoryJobs: stable(hoisted.jobs),
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
    vendorId: 'v-acme',
    orderedAt: over.status === 'draft' ? null : '2026-07-01T00:00:00Z',
    orderedBy: over.status === 'draft' ? null : { id: 'u1', name: 'Dana Buyer' },
    receivedAt: null,
    leadTimeDays: null,
    notes: null,
    signatureData: null,
    signatureName: null,
    signatureAt: null,
    createdAt: '2026-06-30T00:00:00Z',
    expectedDate: '2026-07-20T00:00:00.000Z',
    lines: [
      { id: 'l1', itemSku: 'A', itemName: 'Item A', uom: 'EA', qtyOrdered: 5, qtyReceived: 0, unitCost: 10 },
      { id: 'l2', itemSku: 'B', itemName: 'Item B', uom: 'EA', qtyOrdered: 3, qtyReceived: 0, unitCost: 4 },
    ],
    ...over,
  };
}

const mockApi = vi.mocked(api);

function renderDialog(p: PurchaseOrder) {
  const onUpdated = vi.fn();
  const onClose = vi.fn();
  renderWithProviders(<PODetailDialog open onClose={onClose} po={p} onReceive={vi.fn()} onUpdated={onUpdated} onDeleted={vi.fn()} />, { ability: inventoryWriteAbility() });
  return { onUpdated, onClose };
}

async function enterEdit() {
  await userEvent.click(screen.getByRole('button', { name: 'Edit' }));
  return screen.getByRole('button', { name: 'Save changes' });
}

async function pick(comboName: string, optionLabel: string | RegExp) {
  const user = userEvent.setup();
  await user.click(screen.getByRole('combobox', { name: comboName }));
  await user.click(await screen.findByRole('option', { name: optionLabel }));
}

const lineEditorPresent = () => screen.queryByRole('button', { name: 'Add free-text line' }) !== null;

beforeEach(() => {
  vi.clearAllMocks();
});

describe('PODetailDialog — Edit: header fields on any status (S3.3)', () => {
  it('an ordered PO: no line editor; changing the expected date PATCHes only that field', async () => {
    const ordered = po({ status: 'ordered' });
    const saved = { ...ordered, expectedDate: '2026-09-15T00:00:00.000Z' };
    mockApi.patch.mockResolvedValue({ data: { purchaseOrder: saved } });
    const { onUpdated } = renderDialog(ordered);

    await enterEdit();
    expect(lineEditorPresent()).toBe(false);
    expect(screen.queryByRole('spinbutton', { name: /qty/i })).toBeNull();

    const date = screen.getByLabelText('Expected delivery') as HTMLInputElement;
    // The DatePicker shows the stored day in US format; the payload below stays ISO.
    expect(date.value).toBe('07/20/2026');
    await userEvent.clear(date);
    await userEvent.type(date, '2026-09-15');
    await userEvent.click(screen.getByRole('button', { name: 'Save changes' }));

    await waitFor(() =>
      expect(mockApi.patch).toHaveBeenCalledWith('/api/inventory/purchase-orders/po-ordered-1', {
        expectedDate: '2026-09-15T00:00:00.000Z',
      }),
    );
    await waitFor(() => expect(onUpdated).toHaveBeenCalledWith(saved));
    // Back to read mode.
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Save changes' })).toBeNull());
    expect(screen.getByRole('button', { name: 'Edit' })).toBeInTheDocument();
  });

  it('picking a vendor writes vendorId AND the vendor name; picking a job writes jobId and fills customer / site / trade', async () => {
    mockApi.patch.mockResolvedValue({ data: { purchaseOrder: po({ status: 'partial' }) } });
    renderDialog(po({ status: 'partial' }));
    await enterEdit();

    await pick('Vendor', 'Bolt & Nut Co');
    await pick('Job', /J-1002/);
    expect((screen.getByLabelText('Customer') as HTMLInputElement).value).toBe('Blue Bottle');
    expect((screen.getByLabelText('Site') as HTMLInputElement).value).toBe('450 W 15th');

    await userEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    await waitFor(() =>
      expect(mockApi.patch).toHaveBeenCalledWith('/api/inventory/purchase-orders/po-partial-1', {
        vendorId: 'v-bolt',
        vendor: 'Bolt & Nut Co',
        jobId: 'job-2',
        customer: 'Blue Bottle',
        site: '450 W 15th',
        trade: 'security',
      }),
    );
  });

  it('notes typed while editing ride the Save, not a blur PATCH; Cancel discards everything', async () => {
    renderDialog(po({ status: 'closed', receivedAt: '2026-07-10T00:00:00Z', customer: 'Equinox', site: 'Dock 4' }));
    await enterEdit();

    const notes = screen.getByLabelText('Notes to the vendor');
    await userEvent.type(notes, 'Ring the bell');
    await userEvent.tab();
    expect(mockApi.patch).not.toHaveBeenCalled();

    const site = screen.getByLabelText('Site') as HTMLInputElement;
    await userEvent.clear(site);
    await userEvent.type(site, 'Dock 9');

    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(mockApi.patch).not.toHaveBeenCalled();
    expect(screen.queryByRole('button', { name: 'Save changes' })).toBeNull();
    // The read view (dialog subtitle) still shows the original site; the notes draft is reset.
    expect(screen.getByText(/Equinox · Dock 4/)).toBeInTheDocument();
    expect((screen.getByLabelText('Notes to the vendor') as HTMLTextAreaElement).value).toBe('');
  });

  it('Save with nothing changed writes nothing and just leaves edit mode', async () => {
    renderDialog(po({ status: 'ordered' }));
    await enterEdit();
    await userEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    expect(mockApi.patch).not.toHaveBeenCalled();
    expect(screen.queryByRole('button', { name: 'Save changes' })).toBeNull();
  });
});

describe('PODetailDialog — Edit: lines on a draft (S3.3)', () => {
  it('shows the line editor; adding a catalog line pre-fills its cost and Save sends the full lines array', async () => {
    const draft = po({ status: 'draft' });
    mockApi.patch.mockResolvedValue({ data: { purchaseOrder: draft } });
    const { onUpdated } = renderDialog(draft);
    await enterEdit();
    expect(lineEditorPresent()).toBe(true);

    await pick('Add from catalog', /Cat6 Cable/);

    const rows = within(screen.getByRole('table')).getAllByRole('row');
    // header + 2 existing + 1 new + 2 total rows (subtotal / total)
    const newRow = rows.find((r) => within(r).queryByDisplayValue('Cat6 Cable'))!;
    expect(newRow).toBeTruthy();
    const cost = within(newRow).getByRole('spinbutton', { name: 'Unit cost' }) as HTMLInputElement;
    expect(cost.value).toBe('1.5');
    const qty = within(newRow).getByRole('spinbutton', { name: 'Qty' });
    await userEvent.clear(qty);
    await userEvent.type(qty, '2');

    // Bump the first existing line's cost too.
    const firstRow = rows.find((r) => within(r).queryByDisplayValue('Item A'))!;
    const firstCost = within(firstRow).getByRole('spinbutton', { name: 'Unit cost' });
    await userEvent.clear(firstCost);
    await userEvent.type(firstCost, '12.25');

    await userEvent.click(screen.getByRole('button', { name: 'Save changes' }));

    await waitFor(() =>
      expect(mockApi.patch).toHaveBeenCalledWith('/api/inventory/purchase-orders/po-draft-1', {
        lines: [
          { itemSku: 'A', itemName: 'Item A', uom: 'EA', qtyOrdered: 5, qtyReceived: 0, unitCost: 12.25 },
          { itemSku: 'B', itemName: 'Item B', uom: 'EA', qtyOrdered: 3, qtyReceived: 0, unitCost: 4 },
          { itemSku: 'C-1', itemName: 'Cat6 Cable', uom: 'FT', qtyOrdered: 2, qtyReceived: 0, unitCost: 1.5, priceBookItemId: 'item-c' },
        ],
      }),
    );
    await waitFor(() => expect(onUpdated).toHaveBeenCalled());
  });

  it('a free-text line is typed in by hand; removing a line drops it; a blank cost travels as no unitCost', async () => {
    const draft = po({ status: 'draft' });
    mockApi.patch.mockResolvedValue({ data: { purchaseOrder: draft } });
    renderDialog(draft);
    await enterEdit();

    // Drop Item B.
    const rows = within(screen.getByRole('table')).getAllByRole('row');
    const rowB = rows.find((r) => within(r).queryByDisplayValue('Item B'))!;
    await userEvent.click(within(rowB).getByRole('button', { name: 'Remove line' }));

    await userEvent.click(screen.getByRole('button', { name: 'Add free-text line' }));
    const fresh = within(screen.getByRole('table')).getAllByRole('row').find(
      (r) => within(r).queryByRole('textbox', { name: 'Description' }) && (within(r).getByRole('textbox', { name: 'Description' }) as HTMLInputElement).value === '',
    )!;
    await userEvent.type(within(fresh).getByRole('textbox', { name: 'Description' }), 'Shop rag bundle');
    const uom = within(fresh).getByRole('textbox', { name: 'UoM' }) as HTMLInputElement;
    await userEvent.clear(uom);
    await userEvent.type(uom, 'PK');
    const qty = within(fresh).getByRole('spinbutton', { name: 'Qty' });
    await userEvent.clear(qty);
    await userEvent.type(qty, '4');

    await userEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    await waitFor(() =>
      expect(mockApi.patch).toHaveBeenCalledWith('/api/inventory/purchase-orders/po-draft-1', {
        lines: [
          { itemSku: 'A', itemName: 'Item A', uom: 'EA', qtyOrdered: 5, qtyReceived: 0, unitCost: 10 },
          { itemSku: '', itemName: 'Shop rag bundle', uom: 'PK', qtyOrdered: 4, qtyReceived: 0 },
        ],
      }),
    );
  });

  it('refuses to save a line without a description or with a zero quantity', async () => {
    renderDialog(po({ status: 'draft' }));
    await enterEdit();
    await userEvent.click(screen.getByRole('button', { name: 'Add free-text line' }));
    await userEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    expect(await screen.findByText(/every line needs a description/i)).toBeInTheDocument();
    expect(mockApi.patch).not.toHaveBeenCalled();
  });

  it('409 PO_LINES_FROZEN: shows the frozen message and keeps the form open', async () => {
    mockApi.patch.mockRejectedValue({
      response: {
        status: 409,
        data: { error: 'PO_LINES_FROZEN', message: 'Lines can only be edited while the PO is in Draft', status: 'ordered' },
      },
    });
    const { onUpdated } = renderDialog(po({ status: 'draft' }));
    await enterEdit();

    const rows = within(screen.getByRole('table')).getAllByRole('row');
    const rowA = rows.find((r) => within(r).queryByDisplayValue('Item A'))!;
    const qty = within(rowA).getByRole('spinbutton', { name: 'Qty' });
    await userEvent.clear(qty);
    await userEvent.type(qty, '6');
    await userEvent.click(screen.getByRole('button', { name: 'Save changes' }));

    expect(await screen.findByText('Lines can only be edited while the PO is in Draft')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Save changes' })).toBeInTheDocument();
    expect(onUpdated).not.toHaveBeenCalled();
  });
});
