/**
 * price-book-line-seeding.test.tsx — what a line ACTUALLY carries when it is seeded from
 * a catalog item, and what the picker's footer promises before it is.
 *
 * The reported defect: a catalog item priced at $500 added a line at $0.00. An item's
 * selling price lives in `sell_price` OR `unit_price`; the backend resolves which and
 * sends the answer as `sellPrice` (lib/catalog/item-resolution), but the three host
 * editors still seeded from the raw legacy column, and the picker's footer still summed
 * it. Once the card started showing the resolved price, the card said $500.00 while the
 * footer 200px below said $0.00 and a $0.00 line landed on the estimate — an estimate
 * could go out under-priced with nobody noticing.
 *
 * These tests run through the real host editors (Job / Invoice / Estimate), because the
 * seeding lives in each host's `handlePriceBookAdd`, not in the picker.
 *
 * Every price fixture here is shaped as the defect: the truth is in the resolved answer
 * and the raw legacy column says something else. A site that reads the raw column
 * therefore produces a visibly wrong number rather than passing by coincidence.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithProviders } from './helpers';
import { LineItemsEditor } from '@/components/jobs/items/LineItemsEditor';
import { InvoiceLineItemsEditor, type InvoiceEditorInvoice } from '@/components/invoices/InvoiceLineItemsEditor';
import { EstimateLineItemsEditor } from '@/components/estimates/EstimateLineItemsEditor';
import { buildAbility } from '@/lib/ability';
import api from '@/lib/axios';
import type { JobLineItem, JobBilling } from '@/lib/api/jobs';
import * as invoicesApi from '@/lib/api/invoices';
import * as estimatesApi from '@/lib/api/estimates';

vi.mock('@/lib/api/estimates', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api/estimates')>('@/lib/api/estimates');
  return {
    ...actual,
    addEstimateLine: vi.fn().mockResolvedValue({ estimate: {} }),
    updateEstimateLine: vi.fn().mockResolvedValue({ estimate: {} }),
    deleteEstimateLine: vi.fn().mockResolvedValue({ estimate: {} }),
    reorderEstimateLines: vi.fn().mockResolvedValue({ estimate: {} }),
    addEstimateScope: vi.fn().mockResolvedValue({ estimate: {} }),
    updateEstimateScope: vi.fn().mockResolvedValue({ estimate: {} }),
    deleteEstimateScope: vi.fn().mockResolvedValue({ estimate: {} }),
    reorderEstimateScopes: vi.fn().mockResolvedValue({ estimate: {} }),
  };
});

vi.mock('@/lib/api/invoices', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api/invoices')>('@/lib/api/invoices');
  return {
    ...actual,
    searchPriceBookItems: vi.fn().mockResolvedValue([]),
    listPriceBookItems: vi.fn().mockResolvedValue([]),
    addInvoiceLine: vi.fn().mockResolvedValue({}),
    updateInvoiceLine: vi.fn().mockResolvedValue({}),
    deleteInvoiceLine: vi.fn().mockResolvedValue({}),
    reorderInvoiceLines: vi.fn().mockResolvedValue({}),
    fetchStateTaxRates: vi.fn().mockResolvedValue([]),
  };
});

const hoisted = vi.hoisted(() => ({ LOC_MAIN_ID: 'aaaaaaa1-0000-4000-8000-000000000001' }));

vi.mock('@/components/ui/use-toast', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/components/ui/use-toast')>();
  return { ...actual, toast: vi.fn() };
});

vi.mock('@/lib/api/inventory', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api/inventory')>();
  const locations = [{ id: hoisted.LOC_MAIN_ID, name: 'Main Warehouse', type: 'warehouse', branch: 'HQ' }];
  return { ...actual, useLocations: () => ({ data: locations, isLoading: false, isError: false }) };
});

vi.mock('@/lib/api/organization', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api/organization')>();
  const org = { id: 'org-1', default_inventory_location_id: hoisted.LOC_MAIN_ID, block_negative_stock: false };
  return { ...actual, useOrganization: () => ({ data: org, isLoading: false, isError: false }) };
});

/**
 * The defect's own shape: the price reached the canonical column, so the resolved answer
 * is $500 while the raw legacy column the seeding used to read says 0.
 */
const PRICED_ITEM: invoicesApi.PriceBookItem = {
  id: 'pb-priced',
  name: 'Condenser Coil',
  description: null,
  image_url: null,
  photoUrl: null,
  sellPrice: 500,
  unitCost: 200,
  type: 'MATERIAL',
  unit_cost: 200,
  unit_price: 0,
  taxable: true,
  category: null,
};

/**
 * An item whose cost column is empty. The backend resolves that to an explicit absence
 * (`unitCost: null`) while the raw column still arrives as the empty string it is — and
 * `Number('')` is 0, which is how a seeding path that reads the raw column mints a cost
 * of zero (a 100% margin) for an item nobody ever costed.
 */
const UNCOSTED_ITEM: invoicesApi.PriceBookItem = {
  ...PRICED_ITEM,
  id: 'pb-uncosted',
  name: 'Site Survey',
  unit_cost: '',
  unitCost: null,
};

const pickerDialog = () => screen.getByRole('dialog', { name: /price book/i });

/** Open the host's picker, tick one of the catalog item, and press the host's Add button. */
async function addOneFromPicker(itemName: string, addButton: RegExp) {
  await userEvent.click(screen.getByRole('button', { name: /^price book$/i }));
  await within(pickerDialog()).findByText(itemName);
  await userEvent.click(within(pickerDialog()).getByLabelText('Increase quantity'));
  await userEvent.click(within(pickerDialog()).getByRole('button', { name: addButton }));
}

describe('Job (LineItemsEditor) — a line seeded from the catalog', () => {
  const JOB_ID = 'j0000000-0000-0000-0000-000000000001';
  const LINE: JobLineItem = {
    id: 'line-1',
    job_id: JOB_ID,
    sequence: 1,
    description: 'Compressor swap',
    quantity: 2,
    unit_price: 150,
    unit_cost: null,
    markup_percent: null,
    is_taxable: true,
    line_total: 300,
    discount_type: null,
    discount_value: null,
    discount_amount: 0,
    item_type: 'SERVICE',
    price_book_item_id: null,
  };
  const billing: JobBilling = { total: 300, invoiced: 0, remaining: 300 };
  const adminAbility = () => buildAbility([{ action: 'manage_lines', subject: 'Job' }]);

  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(api, 'get').mockImplementation(async (url: string) => {
      if (url.includes('/scopes')) return { data: { scopes: [], billing } };
      if (url.includes('/price-book/categories')) return { data: { data: [] } };
      if (url.includes('/inventory/item-groups')) return { data: { itemGroups: [] } };
      if (url.includes('/inventory/vendors')) return { data: { vendors: [] } };
      return { data: { lines: [LINE], billing } };
    });
    vi.spyOn(api, 'post').mockResolvedValue({ data: { line: LINE, billing } });
    vi.mocked(invoicesApi.listPriceBookItems).mockResolvedValue([PRICED_ITEM]);
    vi.mocked(invoicesApi.searchPriceBookItems).mockResolvedValue([PRICED_ITEM]);
  });

  /**
   * The picker's footer is the last figure the operator sees before committing, so it has
   * to be the figure that commits. Both halves are asserted in one test on purpose: the
   * acceptance criterion is that the total shown BEFORE adding equals the total added.
   */
  it('shows a footer total that matches what the lines actually cost', async () => {
    renderWithProviders(<LineItemsEditor jobId={JOB_ID} canManage />, { ability: adminAbility() });
    await screen.findByText('Compressor swap');

    await userEvent.click(screen.getByRole('button', { name: /^price book$/i }));
    await within(pickerDialog()).findByText('Condenser Coil');
    await userEvent.click(within(pickerDialog()).getByLabelText('Increase quantity'));
    await userEvent.click(within(pickerDialog()).getByLabelText('Increase quantity'));

    // 2 x the resolved $500, not 2 x the raw legacy column's 0.
    const footer = await within(pickerDialog()).findByText(/2 units/);
    expect(footer).toHaveTextContent('$1,000.00');

    await userEvent.click(within(pickerDialog()).getByRole('button', { name: /^add to job/i }));

    await waitFor(() => expect(api.post).toHaveBeenCalled());
    const body = vi.mocked(api.post).mock.calls.at(-1)?.[1] as { unit_price: number; quantity: number };
    expect(body.quantity * body.unit_price).toBe(1000);
  });

  /** THE reported defect, and the regression guard for this whole cluster. */
  it('carries the catalog selling price, and never seeds zero for a priced item', async () => {
    renderWithProviders(<LineItemsEditor jobId={JOB_ID} canManage />, { ability: adminAbility() });
    await screen.findByText('Compressor swap');

    await addOneFromPicker('Condenser Coil', /^add to job/i);

    await waitFor(() =>
      expect(api.post).toHaveBeenCalledWith(
        `/api/jobs/${JOB_ID}/line-items`,
        expect.objectContaining({ unit_price: 500 }),
      ),
    );
    const body = vi.mocked(api.post).mock.calls.at(-1)?.[1] as { unit_price: number };
    expect(body.unit_price).not.toBe(0);
  });

  // CHARACTERIZATION, not a regression guard: the old seeding also carried this cost, from
  // the raw column. It is here because the fix moved cost onto the resolved answer, and if
  // that answer ever stops reaching the client the line silently goes out uncosted and its
  // margin with it — which no other test in this file would notice.
  it('carries the catalog cost, so the line has real numbers to compute a margin from', async () => {
    renderWithProviders(<LineItemsEditor jobId={JOB_ID} canManage />, { ability: adminAbility() });
    await screen.findByText('Compressor swap');

    await addOneFromPicker('Condenser Coil', /^add to job/i);

    await waitFor(() =>
      expect(api.post).toHaveBeenCalledWith(
        `/api/jobs/${JOB_ID}/line-items`,
        expect.objectContaining({ unit_cost: 200 }),
      ),
    );
  });

  it('leaves an uncosted item uncosted instead of seeding a cost of zero', async () => {
    vi.mocked(invoicesApi.listPriceBookItems).mockResolvedValue([UNCOSTED_ITEM]);
    vi.mocked(invoicesApi.searchPriceBookItems).mockResolvedValue([UNCOSTED_ITEM]);

    renderWithProviders(<LineItemsEditor jobId={JOB_ID} canManage />, { ability: adminAbility() });
    await screen.findByText('Compressor swap');

    await addOneFromPicker('Site Survey', /^add to job/i);

    await waitFor(() => expect(api.post).toHaveBeenCalled());
    const body = vi.mocked(api.post).mock.calls.at(-1)?.[1] as Record<string, unknown>;
    // Absent, not zero: a zero cost against a $500 price is a 100% margin, where an
    // uncosted line is supposed to show an em dash.
    expect(body).not.toHaveProperty('unit_cost');
  });
});

/**
 * AddLineDialog is the fourth reader of the same catalog item — the precise single-line
 * path, beside the picker's bulk one. It owns a search list and a selected-item preview of
 * its own, and both read the item directly, so before this fix its rows disagreed with the
 * picker's card about the very same row.
 */
describe('AddLineDialog — the single-line path reads the same item the picker does', () => {
  const JOB_ID = 'j0000000-0000-0000-0000-000000000002';
  const billing: JobBilling = { total: 0, invoiced: 0, remaining: 0 };
  const adminAbility = () => buildAbility([{ action: 'manage_lines', subject: 'Job' }]);

  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(api, 'get').mockImplementation(async (url: string) => {
      if (url.includes('/scopes')) return { data: { scopes: [], billing } };
      if (url.includes('/price-book/categories')) return { data: { data: [] } };
      if (url.includes('/inventory/item-groups')) return { data: { itemGroups: [] } };
      if (url.includes('/inventory/vendors')) return { data: { vendors: [] } };
      return { data: { lines: [], billing } };
    });
    vi.spyOn(api, 'post').mockResolvedValue({ data: { line: null, billing } });
    vi.mocked(invoicesApi.listPriceBookItems).mockResolvedValue([PRICED_ITEM]);
    vi.mocked(invoicesApi.searchPriceBookItems).mockResolvedValue([PRICED_ITEM]);
  });

  const addDialog = () => screen.getByRole('dialog', { name: /add line item/i });

  async function openAndSearch() {
    renderWithProviders(<LineItemsEditor jobId={JOB_ID} canManage />, { ability: adminAbility() });
    await userEvent.click(await screen.findByRole('button', { name: /^add item$/i }));
    await userEvent.type(within(addDialog()).getByLabelText(/search the price book/i), 'Coil');
    return within(addDialog()).findByText('Condenser Coil');
  }

  it('lists the item at its resolved price, not at the raw legacy column', async () => {
    const row = await openAndSearch();

    expect(row.closest('button')).toHaveTextContent('$500.00');
    expect(row.closest('button')).not.toHaveTextContent('$0.00');
  });

  it('previews the picked item at its resolved price', async () => {
    const row = await openAndSearch();
    await userEvent.click(row.closest('button') as HTMLElement);

    const preview = await within(addDialog()).findByText(/Material ·/);
    expect(preview).toHaveTextContent('$500.00');
    expect(preview).not.toHaveTextContent('$0.00');
  });

  it('adds the line at the resolved price and cost', async () => {
    const row = await openAndSearch();
    await userEvent.click(row.closest('button') as HTMLElement);
    await userEvent.click(within(addDialog()).getByRole('button', { name: /^add item$/i }));

    await waitFor(() =>
      expect(api.post).toHaveBeenCalledWith(
        `/api/jobs/${JOB_ID}/line-items`,
        expect.objectContaining({ unit_price: 500, unit_cost: 200 }),
      ),
    );
  });
});

describe('Invoice (InvoiceLineItemsEditor) — a line seeded from the catalog', () => {
  const INVOICE_ID = 'inv-abc-001';
  const invoice: InvoiceEditorInvoice = {
    id: INVOICE_ID,
    status: 'DRAFT',
    subtotal: 0,
    tax_amount: 0,
    tax_rate: 0,
    discount_amount: 0,
    tip: 0,
    total_amount: 0,
    line_items: [],
  };
  const adminAbility = () =>
    buildAbility([
      { action: 'update', subject: 'Invoice' },
      { action: 'manage_lines', subject: 'Invoice' },
    ]);

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(invoicesApi.listPriceBookItems).mockResolvedValue([PRICED_ITEM]);
    vi.mocked(invoicesApi.searchPriceBookItems).mockResolvedValue([PRICED_ITEM]);
  });

  it('carries the catalog selling price, and never seeds zero for a priced item', async () => {
    renderWithProviders(<InvoiceLineItemsEditor invoice={invoice} />, { ability: adminAbility() });

    await addOneFromPicker('Condenser Coil', /^add to invoice/i);

    await waitFor(() =>
      expect(invoicesApi.addInvoiceLine).toHaveBeenCalledWith(
        INVOICE_ID,
        expect.objectContaining({ unit_price: 500 }),
      ),
    );
  });
});

describe('Estimate (EstimateLineItemsEditor) — a line seeded from the catalog', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(invoicesApi.listPriceBookItems).mockResolvedValue([PRICED_ITEM]);
    vi.mocked(invoicesApi.searchPriceBookItems).mockResolvedValue([PRICED_ITEM]);
  });

  it('carries the catalog selling price, and never seeds zero for a priced item', async () => {
    renderWithProviders(
      <EstimateLineItemsEditor
        estimate={{ id: 'est-1', line_items: [], total_amount: 0 }}
        canManage
        canSeePricing
        canSaveToPriceBook={false}
      />,
    );

    await addOneFromPicker('Condenser Coil', /^add to estimate/i);

    await waitFor(() =>
      expect(estimatesApi.addEstimateLine).toHaveBeenCalledWith(
        'est-1',
        expect.objectContaining({ unit_price: 500 }),
      ),
    );
  });
});
