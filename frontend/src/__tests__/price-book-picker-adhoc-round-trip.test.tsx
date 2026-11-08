/**
 * SRVW-221 - the price-book picker in jobs strands you after adding a new item.
 *
 * Before this fix, PriceBookPicker's dashed "Add new item: <query>" card handed the query to
 * the parent and the parent CLOSED the picker before opening AddLineDialog in create mode. That
 * lost the picker's browse state (its own useEffect wiped tab/category/search/qtys on the next
 * open) and, on Job specifically, `onCreateAdhoc` took no argument at all and silently dropped
 * the typed query.
 *
 * These tests exercise the fixed round trip on all three surfaces that share `onCreateAdhoc`:
 * Job (LineItemsEditor, via the shared LineItemsTable's embedded AddLineDialog), Invoice
 * (InvoiceLineItemsEditor, same embedded-dialog path as Job), and Estimate
 * (EstimateLineItemsEditor, which renders its own separate AddLineDialog instance).
 *
 * The picker still closes itself on hand-off (AddLineDialog needs the screen) and reopens via
 * AddLineDialog's `onBackToPicker` - what the fix changed is that reopening no longer wipes
 * tab/category/search/qtys (PriceBookPicker.tsx's `pendingReturnRef` skips that one reset).
 * Scroll position is honestly NOT covered here: jsdom has no layout/scroll model, and in a real
 * browser this Dialog's content still unmounts while closed, so scrollTop is lost like any other
 * close/reopen - see PriceBookPicker.tsx's file header for why a "keep it mounted the whole time"
 * approach (which would also have saved scroll) was tried and reverted for a flaky cross-dialog
 * dismissal interaction, in favor of this simpler, reliable close/reopen with state carried over.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithProviders } from './helpers';
import { LineItemsEditor } from '@/components/jobs/items/LineItemsEditor';
import { InvoiceLineItemsEditor, type InvoiceEditorInvoice } from '@/components/invoices/InvoiceLineItemsEditor';
import { EstimateLineItemsEditor } from '@/components/estimates/EstimateLineItemsEditor';
import { buildAbility } from '@/lib/ability';
import api from '@/lib/axios';
import type { JobLineItem, JobBilling } from '@/lib/api/jobs';
import * as invoicesApi from '@/lib/api/invoices';

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

const hoisted = vi.hoisted(() => ({
  LOC_MAIN_ID: 'aaaaaaa1-0000-4000-8000-000000000001',
}));

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

const PB_ITEM: invoicesApi.PriceBookItem = {
  id: 'pb-1',
  name: 'Air Filter 20x20',
  description: null,
  image_url: null,
  type: 'MATERIAL',
  unit_cost: 8,
  unit_price: 25,
  taxable: true,
  category: null,
};

// The picker's own dialog is identified by its title's accessible name ("Price book" - the
// title also carries a leading "$" glyph span, so this is intentionally not anchored) so it can
// be distinguished from AddLineDialog ("Add line item").
const pickerDialog = () => screen.getByRole('dialog', { name: /price book/i });
// Distinct from LineItemsTable's own empty-state "Add line item" CTA button, which carries the
// exact same visible text on a DIFFERENT element - always assert on the dialog role, not on
// screen.findByText('Add line item') alone, or that CTA button can produce a false positive.
const addDialog = () => screen.getByRole('dialog', { name: /add line item/i });

describe('SRVW-221 - Job (LineItemsEditor): price-book picker adhoc-create round trip', () => {
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
  function billingFor(lines: JobLineItem[]): JobBilling {
    const total = lines.reduce((s, l) => s + Number(l.line_total), 0);
    return { total, invoiced: 0, remaining: total };
  }
  const adminAbility = () => buildAbility([{ action: 'manage_lines', subject: 'Job' }]);

  beforeEach(() => {
    vi.clearAllMocks();
    // URL-aware rather than a single blanket mockResolvedValue: the job line-items load hits this
    // same api.get spy alongside PriceBookPicker's own /api/price-book/categories and
    // /api/inventory/item-groups, plus CreatePOFromJobDialog's vendors fetch - a single fixed
    // shape for all of them left the vendors query resolving `data.vendors` to undefined, which
    // React Query logs as a dev-mode error and made this suite measurably flakier under a full run.
    vi.spyOn(api, 'get').mockImplementation(async (url: string) => {
      if (url.includes('/scopes')) return { data: { scopes: [], billing: { total: 0, invoiced: 0, remaining: 0 } } };
      if (url.includes('/price-book/categories')) return { data: { data: [] } };
      if (url.includes('/inventory/item-groups')) return { data: { itemGroups: [] } };
      if (url.includes('/inventory/vendors')) return { data: { vendors: [] } };
      return { data: { lines: [LINE], billing: billingFor([LINE]) } };
    });
    vi.spyOn(api, 'post').mockResolvedValue({ data: { line: LINE, billing: billingFor([LINE]) } });
    vi.mocked(invoicesApi.listPriceBookItems).mockResolvedValue([PB_ITEM]);
    // Once the picker's search box is typed into, its items query switches from
    // listPriceBookItems to searchPriceBookItems - keep returning the same catalog item so a
    // quantity selected before typing doesn't vanish from the grid (and the assertion with it).
    vi.mocked(invoicesApi.searchPriceBookItems).mockResolvedValue([PB_ITEM]);
  });

  async function openPickerAndHandOff() {
    renderWithProviders(<LineItemsEditor jobId={JOB_ID} canManage />, { ability: adminAbility() });
    await screen.findByText('Compressor swap');

    await userEvent.click(screen.getByRole('button', { name: /^price book$/i }));
    await within(pickerDialog()).findByText('Air Filter 20x20');

    // Select a quantity on the catalog item - a stand-in for "browse state" (selections) that
    // must survive the round trip alongside tab/category/search.
    await userEvent.click(within(pickerDialog()).getByLabelText('Increase quantity'));
    await userEvent.click(within(pickerDialog()).getByLabelText('Increase quantity'));
    await waitFor(() => expect(within(pickerDialog()).getByText('×2')).toBeInTheDocument());

    await userEvent.type(within(pickerDialog()).getByLabelText(/search the price book/i), 'Diagnostic fee');
    await waitFor(() =>
      expect(
        within(pickerDialog()).getByRole('button', { name: /^add new item: diagnostic fee/i }),
      ).toBeInTheDocument(),
    );
    await userEvent.click(
      within(pickerDialog()).getByRole('button', { name: /^add new item: diagnostic fee/i }),
    );

    // The picker closes itself on hand-off (unchanged from before this fix) - AddLineDialog gets
    // the screen. Confirmed here so every test starts from the same known state.
    await waitFor(() => expect(screen.queryByRole('dialog', { name: /price book/i })).not.toBeInTheDocument());
  }

  it('hands the typed query through instead of discarding it (the critical Job-specific bug) and pre-fills the create form', async () => {
    await openPickerAndHandOff();

    expect(await screen.findByRole('dialog', { name: /add line item/i })).toBeInTheDocument();
    expect(within(addDialog()).getByLabelText('Name')).toHaveValue('Diagnostic fee');
  });

  it('AC#1/AC#2: "Back to price book" reopens the picker with the original query and the selected quantity intact', async () => {
    await openPickerAndHandOff();
    await screen.findByRole('dialog', { name: /add line item/i });

    const backButton = within(addDialog()).getByRole('button', { name: /back to price book/i });
    await userEvent.click(backButton);

    // AddLineDialog is gone; the picker reopened with its browse state restored, not blank.
    await waitFor(() => expect(screen.queryByRole('dialog', { name: /add line item/i })).not.toBeInTheDocument());
    expect(pickerDialog()).toBeInTheDocument();
    expect(within(pickerDialog()).getByLabelText(/search the price book/i)).toHaveValue('Diagnostic fee');
    expect(within(pickerDialog()).getByText('×2')).toBeInTheDocument();
  });

  it('AC#3: Cancel on the new-item form also returns to the picker rather than closing everything', async () => {
    await openPickerAndHandOff();
    await screen.findByRole('dialog', { name: /add line item/i });

    await userEvent.click(within(addDialog()).getByRole('button', { name: /^cancel$/i }));

    await waitFor(() => expect(screen.queryByRole('dialog', { name: /add line item/i })).not.toBeInTheDocument());
    expect(pickerDialog()).toBeInTheDocument();
    expect(within(pickerDialog()).getByLabelText(/search the price book/i)).toHaveValue('Diagnostic fee');
  });

  it('a successful create closes the create dialog and does not force the picker back open', async () => {
    await openPickerAndHandOff();
    await screen.findByRole('dialog', { name: /add line item/i });

    const priceInput = within(addDialog()).getByLabelText(/^price \(\$\)$/i);
    await userEvent.clear(priceInput);
    await userEvent.type(priceInput, '95');
    await userEvent.click(within(addDialog()).getByRole('button', { name: /^add item$/i }));

    await waitFor(() => {
      expect(screen.queryByRole('dialog', { name: /add line item/i })).not.toBeInTheDocument();
    });
    // Task done - neither dialog is left open (the picker is only reopened by an explicit
    // Back/Cancel, not automatically after a successful add).
    expect(screen.queryByRole('dialog', { name: /price book/i })).not.toBeInTheDocument();
  });

  it('REGRESSION: a fresh picker open after a COMPLETED round trip resets normally instead of stranding the old browse state', async () => {
    // The blocker this guards: `pendingReturnRef` is set right before the hand-off closes the
    // picker, but a successful create resolves via addMutation's onSuccess -> setAddOpen(false),
    // which bypasses onBackToPicker entirely - the picker's `open` prop never flips back to true,
    // so its reset-on-open effect never runs and never gets a normal chance to consume the ref.
    // Left stranded `true`, the picker's NEXT open (this one - an ordinary, unrelated "Price Book"
    // click, not a return trip) would wrongly skip its reset and reopen on the old search text
    // and quantity, offering to add "Diagnostic fee" and the ticked catalog item a second time.
    await openPickerAndHandOff();
    await screen.findByRole('dialog', { name: /add line item/i });

    const priceInput = within(addDialog()).getByLabelText(/^price \(\$\)$/i);
    await userEvent.clear(priceInput);
    await userEvent.type(priceInput, '95');
    await userEvent.click(within(addDialog()).getByRole('button', { name: /^add item$/i }));

    await waitFor(() => {
      expect(screen.queryByRole('dialog', { name: /add line item/i })).not.toBeInTheDocument();
    });
    expect(screen.queryByRole('dialog', { name: /price book/i })).not.toBeInTheDocument();

    // Later, a completely ordinary "Price Book" click - unrelated to the earlier hand-off.
    await userEvent.click(screen.getByRole('button', { name: /^price book$/i }));
    await within(pickerDialog()).findByText('Air Filter 20x20');

    expect(within(pickerDialog()).getByLabelText(/search the price book/i)).toHaveValue('');
    expect(within(pickerDialog()).queryByText('×2')).not.toBeInTheDocument();
  });

  it.each([
    ['Escape', async () => userEvent.keyboard('{Escape}')],
    ['the close X', async () => userEvent.click(within(addDialog()).getByRole('button', { name: /^close$/i }))],
    // Radix's modal Dialog sets `pointer-events: none` on <body> while open (the scroll lock), so
    // `userEvent`'s realistic pointer path correctly refuses to "click" it - real browsers hit-test
    // the overlay element instead, which visually sits above body and isn't affected by that CSS.
    // `fireEvent` bypasses that hit-testing (there is no overlay node to target in jsdom's layout-
    // free DOM) and dispatches the same pointerdown -> click sequence DismissableLayer listens for
    // to recognize a press outside the dialog's content.
    [
      'an overlay dismissal',
      async () => {
        fireEvent.pointerDown(document.body);
        fireEvent.click(document.body);
      },
    ],
  ])('AC#3: dismissing the create form via %s also returns to the picker, not a plain close', async (_label, dismiss) => {
    await openPickerAndHandOff();
    await screen.findByRole('dialog', { name: /add line item/i });

    await dismiss();

    await waitFor(() => expect(screen.queryByRole('dialog', { name: /add line item/i })).not.toBeInTheDocument());
    expect(pickerDialog()).toBeInTheDocument();
    expect(within(pickerDialog()).getByLabelText(/search the price book/i)).toHaveValue('Diagnostic fee');
  });
});

describe('SRVW-221 - Invoice (InvoiceLineItemsEditor): shares the same LineItemsTable-embedded round trip', () => {
  const INVOICE_ID = 'inv-abc-001';
  function invoice(overrides: Partial<InvoiceEditorInvoice> = {}): InvoiceEditorInvoice {
    return {
      id: INVOICE_ID,
      status: 'DRAFT',
      subtotal: 0,
      tax_amount: 0,
      tax_rate: 0,
      discount_amount: 0,
      tip: 0,
      total_amount: 0,
      line_items: [],
      ...overrides,
    };
  }
  const adminAbility = () =>
    buildAbility([
      { action: 'update', subject: 'Invoice' },
      { action: 'manage_lines', subject: 'Invoice' },
    ]);

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(invoicesApi.listPriceBookItems).mockResolvedValue([PB_ITEM]);
    vi.mocked(invoicesApi.searchPriceBookItems).mockResolvedValue([PB_ITEM]);
  });

  it('"Back to price book" reopens the picker with the original query intact', async () => {
    renderWithProviders(<InvoiceLineItemsEditor invoice={invoice()} />, { ability: adminAbility() });

    await userEvent.click(screen.getByRole('button', { name: /^price book$/i }));
    await within(pickerDialog()).findByText('Air Filter 20x20');
    await userEvent.type(within(pickerDialog()).getByLabelText(/search the price book/i), 'Diagnostic fee');
    await waitFor(() =>
      expect(
        within(pickerDialog()).getByRole('button', { name: /^add new item: diagnostic fee/i }),
      ).toBeInTheDocument(),
    );
    await userEvent.click(
      within(pickerDialog()).getByRole('button', { name: /^add new item: diagnostic fee/i }),
    );

    expect(await screen.findByRole('dialog', { name: /add line item/i })).toBeInTheDocument();
    expect(within(addDialog()).getByLabelText('Name')).toHaveValue('Diagnostic fee');
    expect(screen.queryByRole('dialog', { name: /price book/i })).not.toBeInTheDocument();

    await userEvent.click(within(addDialog()).getByRole('button', { name: /back to price book/i }));

    await waitFor(() => expect(screen.queryByRole('dialog', { name: /add line item/i })).not.toBeInTheDocument());
    expect(pickerDialog()).toBeInTheDocument();
    expect(within(pickerDialog()).getByLabelText(/search the price book/i)).toHaveValue('Diagnostic fee');
  });
});

describe('SRVW-221 - Estimate (EstimateLineItemsEditor): own AddLineDialog instance, same round trip', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(invoicesApi.listPriceBookItems).mockResolvedValue([PB_ITEM]);
    vi.mocked(invoicesApi.searchPriceBookItems).mockResolvedValue([PB_ITEM]);
  });

  it('Cancel on the new-item form reopens the picker with the original query intact', async () => {
    renderWithProviders(
      <EstimateLineItemsEditor
        estimate={{ id: 'est-1', line_items: [], total_amount: 0 }}
        canManage
        canSeePricing={false}
        canSaveToPriceBook={false}
      />,
    );

    await userEvent.click(screen.getByRole('button', { name: /^price book$/i }));
    await within(pickerDialog()).findByText('Air Filter 20x20');
    await userEvent.type(within(pickerDialog()).getByLabelText(/search the price book/i), 'Diagnostic fee');
    await waitFor(() =>
      expect(
        within(pickerDialog()).getByRole('button', { name: /^add new item: diagnostic fee/i }),
      ).toBeInTheDocument(),
    );
    await userEvent.click(
      within(pickerDialog()).getByRole('button', { name: /^add new item: diagnostic fee/i }),
    );

    expect(await screen.findByRole('dialog', { name: /add line item/i })).toBeInTheDocument();
    expect(within(addDialog()).getByLabelText('Name')).toHaveValue('Diagnostic fee');
    expect(screen.queryByRole('dialog', { name: /price book/i })).not.toBeInTheDocument();

    await userEvent.click(within(addDialog()).getByRole('button', { name: /^cancel$/i }));

    await waitFor(() => expect(screen.queryByRole('dialog', { name: /add line item/i })).not.toBeInTheDocument());
    expect(pickerDialog()).toBeInTheDocument();
    expect(within(pickerDialog()).getByLabelText(/search the price book/i)).toHaveValue('Diagnostic fee');
  });
});
