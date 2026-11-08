// Inventory P2 §2 (D16 entry #2) — "Create PO" from the Job Items tab.
//
// Contract under test:
//   • The header button is gated on `create PurchaseOrder` (hidden without it)
//     and hidden when the job has zero MATERIAL lines.
//   • Submit posts the standard create endpoint /api/inventory/purchase-orders
//     with `jobId` present (the whole point: PurchaseOrder.job_id linkage),
//     vendor + vendorId, status 'draft', and catalog-resolved lines with
//     priceBookItemId + qtyReceived 0.
//   • Free-text MATERIAL lines (no price_book_item_id) render disabled with the
//     no-catalog hint and never enter the payload.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithProviders } from './helpers';
import { LineItemsEditor } from '@/components/jobs/items/LineItemsEditor';
import { buildAbility } from '@/lib/ability';
import api from '@/lib/axios';
import type { JobLineItem, JobBilling } from '@/lib/api/jobs';

// AddLineDialog's price-book search goes through invoices.ts — mock just those
// so typing never hits the network (job-items-editor.test.tsx convention).
vi.mock('@/lib/api/invoices', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api/invoices')>('@/lib/api/invoices');
  return {
    ...actual,
    searchPriceBookItems: vi.fn().mockResolvedValue([]),
    listPriceBookItems: vi.fn().mockResolvedValue([]),
  };
});

const hoisted = vi.hoisted(() => ({
  ITEM_ID: 'bbbbbbb1-0000-4000-8000-000000000001',
  VENDOR_ID: 'ccccccc1-0000-4000-8000-000000000001',
  LOC_MAIN_ID: 'aaaaaaa1-0000-4000-8000-000000000001',
  toast: vi.fn(),
}));

vi.mock('@/components/ui/use-toast', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/components/ui/use-toast')>();
  return { ...actual, toast: hoisted.toast };
});

// Stable resolved seam data (jsdom seed-loop learning). useCreatePO stays REAL
// so the axios post spy can assert the exact URL + payload.
vi.mock('@/lib/api/inventory', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api/inventory')>();
  const items = [
    {
      id: hoisted.ITEM_ID,
      sku: 'SKU-001',
      name: 'HES 1006 Electric Strike',
      category: 'Hardware',
      trade: 'security',
      kind: 'material',
      uom: 'EA',
      unitCost: 120,
      sellPrice: 199,
      serialized: false,
      hazmat: false,
      status: 'active',
      vendor: 'ADI / Anixter',
      stock: [],
      updatedAt: '2026-07-01T00:00:00Z',
    },
  ];
  const vendors = [
    {
      id: hoisted.VENDOR_ID,
      name: 'ADI / Anixter',
      category: 'Security',
      paymentTerms: 'Net 30',
      leadTimeDays: 3,
      transmitMethod: 'email',
      status: 'active',
    },
  ];
  const locations = [
    { id: hoisted.LOC_MAIN_ID, name: 'Main Warehouse', type: 'warehouse', branch: 'HQ' },
  ];
  return {
    ...actual,
    useInventoryItems: () => ({ data: items, isLoading: false, isError: false }),
    useVendors: () => ({ data: vendors, isLoading: false, isError: false }),
    useLocations: () => ({ data: locations, isLoading: false, isError: false }),
  };
});

vi.mock('@/lib/api/organization', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api/organization')>();
  const org = { id: 'org-1', default_inventory_location_id: hoisted.LOC_MAIN_ID };
  return { ...actual, useOrganization: () => ({ data: org, isLoading: false, isError: false }) };
});

const JOB_ID = 'j0000000-0000-0000-0000-000000000001';

const MATERIAL_LINE: JobLineItem = {
  id: 'line-mat-1',
  job_id: JOB_ID,
  sequence: 1,
  description: 'HES 1006 Electric Strike',
  quantity: 2,
  unit_price: 199,
  unit_cost: null,
  markup_percent: null,
  is_taxable: true,
  line_total: 398,
  discount_type: null,
  discount_value: null,
  discount_amount: 0,
  item_type: 'MATERIAL',
  price_book_item_id: hoisted.ITEM_ID,
};

const FREETEXT_MATERIAL: JobLineItem = {
  ...MATERIAL_LINE,
  id: 'line-mat-2',
  sequence: 2,
  description: 'Misc anchors from the truck',
  price_book_item_id: null,
};

const SERVICE_LINE: JobLineItem = {
  ...MATERIAL_LINE,
  id: 'line-svc-1',
  sequence: 3,
  description: 'Install labor',
  item_type: 'SERVICE',
  price_book_item_id: null,
};

function billingFor(lines: JobLineItem[]): JobBilling {
  const total = lines.reduce((s, l) => s + Number(l.line_total), 0);
  return { total, invoiced: 0, remaining: total };
}

const poAbility = () =>
  buildAbility([
    { action: 'manage_lines', subject: 'Job' },
    { action: 'create', subject: 'PurchaseOrder' },
  ]);
const noPoAbility = () => buildAbility([{ action: 'manage_lines', subject: 'Job' }]);

let getSpy: ReturnType<typeof vi.spyOn>;
let postSpy: ReturnType<typeof vi.spyOn>;

function seedLines(lines: JobLineItem[]) {
  getSpy = vi
    .spyOn(api, 'get')
    .mockResolvedValue({ data: { lines, billing: billingFor(lines) } });
}

beforeEach(() => {
  vi.clearAllMocks();
  postSpy = vi.spyOn(api, 'post').mockResolvedValue({
    data: { purchaseOrder: { id: 'po-1', poNumber: 'P00042', vendor: 'ADI / Anixter', status: 'draft', orderedAt: '', lines: [] } },
  });
});

describe('Job Items tab — Create PO from job (P2 §2)', () => {
  it('hides the button without create PurchaseOrder', async () => {
    seedLines([MATERIAL_LINE]);
    renderWithProviders(<LineItemsEditor jobId={JOB_ID} canManage />, { ability: noPoAbility() });

    await screen.findByText(/HES 1006/);
    expect(screen.queryByRole('button', { name: /create po/i })).not.toBeInTheDocument();
  });

  it('hides the button when the job has zero MATERIAL lines', async () => {
    seedLines([SERVICE_LINE]);
    renderWithProviders(<LineItemsEditor jobId={JOB_ID} canManage />, { ability: poAbility() });

    await screen.findByText(/Install labor/);
    expect(screen.queryByRole('button', { name: /create po/i })).not.toBeInTheDocument();
  });

  it('posts /api/inventory/purchase-orders with jobId + catalog-resolved lines; free-text lines stay out', async () => {
    seedLines([MATERIAL_LINE, FREETEXT_MATERIAL]);
    renderWithProviders(<LineItemsEditor jobId={JOB_ID} canManage />, { ability: poAbility() });

    await userEvent.click(await screen.findByRole('button', { name: /create po/i }));

    // Free-text line renders disabled with the no-catalog hint.
    expect(
      screen.getByText(/No catalog item — add it to the price book to order it/),
    ).toBeInTheDocument();

    // Vendor is preselected (every resolvable line's item names ADI / Anixter),
    // so the sage submit is live immediately.
    await userEvent.click(screen.getByRole('button', { name: /create purchase order/i }));

    await waitFor(() => {
      expect(postSpy).toHaveBeenCalledWith(
        '/api/inventory/purchase-orders',
        expect.objectContaining({
          vendor: 'ADI / Anixter',
          vendorId: hoisted.VENDOR_ID,
          status: 'draft',
          jobId: JOB_ID,
          lines: [
            expect.objectContaining({
              itemSku: 'SKU-001',
              itemName: 'HES 1006 Electric Strike',
              uom: 'EA',
              qtyOrdered: 2,
              qtyReceived: 0,
              priceBookItemId: hoisted.ITEM_ID,
            }),
          ],
        }),
      );
    });

    // Exactly ONE line went out — the free-text material never entered the payload.
    const body = postSpy.mock.calls.find((c) => c[0] === '/api/inventory/purchase-orders')?.[1] as {
      lines: unknown[];
      jobId: string;
    };
    expect(body.lines).toHaveLength(1);
    expect(body.jobId).toBe(JOB_ID);
    // P0 §A lock (moved here from the retired purchase-orders-create.test.tsx —
    // convert is server-side in P2): the create payload NEVER carries a client
    // id or poNumber; both are server-assigned via allocateNumber.
    expect(body).not.toHaveProperty('poNumber');
    expect(body).not.toHaveProperty('id');
  });

  it('omits unit costs from the payload without read Invoice (cost inputs hidden)', async () => {
    seedLines([MATERIAL_LINE]);
    renderWithProviders(<LineItemsEditor jobId={JOB_ID} canManage />, { ability: poAbility() });

    await userEvent.click(await screen.findByRole('button', { name: /create po/i }));
    expect(screen.queryByLabelText(/unit cost for/i)).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: /create purchase order/i }));

    await waitFor(() => expect(postSpy).toHaveBeenCalled());
    const body = postSpy.mock.calls.find((c) => c[0] === '/api/inventory/purchase-orders')?.[1] as {
      lines: Record<string, unknown>[];
    };
    expect(body.lines[0]).not.toHaveProperty('unitCost');
  });
});
