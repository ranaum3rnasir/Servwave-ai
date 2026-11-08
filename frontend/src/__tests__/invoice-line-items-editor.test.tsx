import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor, within, fireEvent, createEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithProviders } from './helpers';
import {
  InvoiceLineItemsEditor,
  InvoiceScopeOfWorkCard,
  type InvoiceEditorInvoice,
  type InvoiceScopeOfWorkCardInvoice,
} from '@/components/invoices/InvoiceLineItemsEditor';
import { buildAbility } from '@/lib/ability';
import type { InvoiceLineItem, Scope } from '@/lib/api/jobs';
import * as invoicesApi from '@/lib/api/invoices';

// ── API surface mocks ───────────────────────────────────────
vi.mock('@/lib/api/invoices', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api/invoices')>('@/lib/api/invoices');
  return {
    ...actual,
    addInvoiceLine: vi.fn().mockResolvedValue({}),
    updateInvoiceLine: vi.fn().mockResolvedValue({}),
    deleteInvoiceLine: vi.fn().mockResolvedValue({}),
    updateInvoiceBilling: vi.fn().mockResolvedValue({}),
    reorderInvoiceLines: vi.fn().mockResolvedValue({}),
    searchPriceBookItems: vi.fn().mockResolvedValue([]),
    fetchStateTaxRates: vi.fn().mockResolvedValue([]),
    addInvoiceScope: vi.fn().mockResolvedValue({}),
    updateInvoiceScope: vi.fn().mockResolvedValue({}),
    deleteInvoiceScope: vi.fn().mockResolvedValue({}),
    reorderInvoiceScopes: vi.fn().mockResolvedValue({}),
  };
});

// Inventory P1 — SyncStockDialog/AddLineDialog consume the inventory + organization seams.
// Mocked as STABLE resolved data (the sanctioned jsdom seed-loop pattern, see
// purchase-orders-deeplink.test.tsx) so they never hit the network in jsdom.
const stockHoisted = vi.hoisted(() => ({
  LOC_MAIN_ID: 'aaaaaaa1-0000-4000-8000-000000000001',
}));

vi.mock('@/lib/api/inventory', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api/inventory')>();
  const locations = [
    { id: stockHoisted.LOC_MAIN_ID, name: 'Main Warehouse', type: 'warehouse', branch: 'HQ' },
  ];
  return {
    ...actual,
    useLocations: () => ({ data: locations, isLoading: false, isError: false }),
  };
});

vi.mock('@/lib/api/organization', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api/organization')>();
  const org = {
    id: 'org-1',
    default_inventory_location_id: stockHoisted.LOC_MAIN_ID,
    block_negative_stock: false,
  };
  return {
    ...actual,
    useOrganization: () => ({ data: org, isLoading: false, isError: false }),
  };
});

const INVOICE_ID = 'inv-abc-001';

const LINE: InvoiceLineItem = {
  id: 'line-1',
  sequence: 1,
  description: 'Compressor swap',
  quantity: 2,
  unit_price: 150,
  is_taxable: true,
  line_total: 300,
  discount_type: null,
  discount_value: null,
  discount_amount: 0,
  item_type: 'SERVICE',
  price_book_item_id: null,
};

function invoice(overrides: Partial<InvoiceEditorInvoice> = {}): InvoiceEditorInvoice {
  return {
    id: INVOICE_ID,
    status: 'DRAFT',
    subtotal: 300,
    tax_amount: 24.75,
    tax_rate: 0.0825,
    discount_amount: 0,
    tip: 0,
    total_amount: 324.75,
    line_items: [LINE],
    ...overrides,
  };
}

const adminAbility = () =>
  buildAbility([
    { action: 'update', subject: 'Invoice' },
    { action: 'manage_lines', subject: 'Invoice' },
  ]);
// Cost/margin are gated on the SAME frontend ability check as the backend's canSeePricing gate.
// SRVW-140 - that check is now ability.can('read', 'Pricing'), the grant the Roles UI
// "See financial data" switch writes, NOT 'Invoice' (which is about invoice RECORDS).
const pricingAbility = () =>
  buildAbility([
    { action: 'update', subject: 'Invoice' },
    { action: 'manage_lines', subject: 'Invoice' },
    { action: 'read', subject: 'Pricing' },
  ]);

beforeEach(() => {
  vi.clearAllMocks();
});

describe('InvoiceLineItemsEditor', () => {
  it('renders column headers and one row per line item', () => {
    renderWithProviders(<InvoiceLineItemsEditor invoice={invoice()} />, { ability: adminAbility() });

    expect(screen.getByText('Item')).toBeInTheDocument();
    expect(screen.getByText('Qty')).toBeInTheDocument();
    expect(screen.getByText('Selling price')).toBeInTheDocument();
    expect(screen.getByText('Taxable')).toBeInTheDocument();
    // B4 fix: v12 has no per-line Discount column anywhere (plan §3) — Invoice now passes
    // showDiscount={false} (mirrors Job), so the column is absent, not just non-editable.
    expect(screen.queryByText('Discount')).not.toBeInTheDocument();
    expect(screen.getByText('Total')).toBeInTheDocument();

    expect(screen.getByText('Compressor swap')).toBeInTheDocument();
    expect(screen.getAllByTestId('line-item-row')).toHaveLength(1);
  });

  it('commits a line update through updateInvoiceLine keyed to the INVOICE id', async () => {
    renderWithProviders(<InvoiceLineItemsEditor invoice={invoice()} />, { ability: adminAbility() });

    const qty = screen.getByLabelText(/quantity for compressor swap/i);
    await userEvent.clear(qty);
    await userEvent.type(qty, '3');
    await userEvent.tab(); // blur → commit

    await waitFor(() => {
      expect(invoicesApi.updateInvoiceLine).toHaveBeenCalledWith(INVOICE_ID, 'line-1', {
        quantity: 3,
      });
    });
  });

  it('does not delete a line until the confirm dialog is accepted', async () => {
    renderWithProviders(<InvoiceLineItemsEditor invoice={invoice()} />, { ability: adminAbility() });

    await userEvent.click(screen.getByRole('button', { name: /remove compressor swap/i }));

    expect(await screen.findByText('Remove "Compressor swap"?')).toBeInTheDocument();
    expect(invoicesApi.deleteInvoiceLine).not.toHaveBeenCalled();

    await userEvent.click(screen.getByRole('button', { name: /^cancel$/i }));
    expect(invoicesApi.deleteInvoiceLine).not.toHaveBeenCalled();

    await userEvent.click(screen.getByRole('button', { name: /remove compressor swap/i }));
    await userEvent.click(await screen.findByRole('button', { name: /^remove$/i }));

    await waitFor(() => {
      expect(invoicesApi.deleteInvoiceLine).toHaveBeenCalledWith(INVOICE_ID, 'line-1');
    });
  });

  it('adds a line through addInvoiceLine keyed to the INVOICE id (no ensure-invoice)', async () => {
    // Empty draft → no row inputs, so the only "unit price" field is the dialog's.
    renderWithProviders(<InvoiceLineItemsEditor invoice={invoice({ line_items: [] })} />, {
      ability: adminAbility(),
    });

    // Open the add dialog via the header "+" affordance.
    await userEvent.click(screen.getByRole('button', { name: /^add item$/i }));

    // Single-search flow: type a query, then choose "Add new item: <query>" (v12 wording —
    // the query itself is bolded inline in the button's accessible name).
    await userEvent.type(screen.getByLabelText(/search the price book/i), 'Diagnostic fee');
    await userEvent.click(await screen.findByRole('button', { name: /^add new item: diagnostic fee$/i }));

    const priceInput = screen.getByLabelText(/^price \(\$\)$/i);
    await userEvent.clear(priceInput);
    await userEvent.type(priceInput, '95');
    await userEvent.click(screen.getByRole('button', { name: /^add item$/i }));

    await waitFor(() => {
      expect(invoicesApi.addInvoiceLine).toHaveBeenCalledWith(
        INVOICE_ID,
        expect.objectContaining({ description: 'Diagnostic fee', unit_price: 95 }),
      );
    });
  });

  it('renders EDITABLE on a SENT invoice (P2: editable until settled)', () => {
    renderWithProviders(
      <InvoiceLineItemsEditor invoice={invoice({ status: 'SENT' })} />,
      { ability: adminAbility() },
    );

    // SENT is no longer locked — add + per-row edit affordances are present.
    expect(screen.getByRole('button', { name: /add item/i })).toBeInTheDocument();
    expect(screen.getByLabelText(/quantity for compressor swap/i)).toBeInTheDocument();
  });

  it('renders read-only (no edit inputs, no trash, no "+") on a locked (PAID) invoice', () => {
    renderWithProviders(
      <InvoiceLineItemsEditor invoice={invoice({ status: 'PAID' })} />,
      { ability: adminAbility() },
    );

    expect(screen.queryByRole('button', { name: /add item/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /remove compressor swap/i })).toBeNull();
    expect(screen.queryByLabelText(/quantity for compressor swap/i)).toBeNull();
    // The line still renders, read-only.
    expect(screen.getByText('Compressor swap')).toBeInTheDocument();
  });

  it('renders read-only when ability grants nothing, even on a DRAFT invoice', () => {
    renderWithProviders(<InvoiceLineItemsEditor invoice={invoice()} />);

    expect(screen.queryByRole('button', { name: /add item/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /remove compressor swap/i })).toBeNull();
    expect(screen.queryByLabelText(/quantity for compressor swap/i)).toBeNull();
    expect(screen.getByText('Compressor swap')).toBeInTheDocument();
  });

  // A tip lives on the invoice independently of the line rows, so it can outlive the last line.
  // v12 receipt consolidation (plan §3/§4 "FIX/CONSOLIDATE Card A"): tip/discount/tax-rate editing
  // now lives EXCLUSIVELY on the page-level <InvoiceReceiptCard> (Card A, wired in
  // InvoiceDetailPage.tsx) — this editor always passes canEditBilling={false} into
  // <LineItemsTable>, so its own embedded <TotalsFooter> renders the orphaned tip read-only here,
  // not as a second competing money input.
  it('keeps the tip visible but read-only when a DRAFT owns zero lines but still has a tip (editing lives on Card A)', () => {
    const empty = invoice({ line_items: [], subtotal: 0, tax_amount: 0, tax_rate: 0, tip: 20, total_amount: 20 });
    renderWithProviders(<InvoiceLineItemsEditor invoice={empty} />, { ability: adminAbility() });

    // Empty-state CTA AND the totals footer both render.
    expect(screen.getByRole('button', { name: /add the first line item/i })).toBeInTheDocument();
    const tipRow = screen.getByText('Tip').closest('div');
    expect(tipRow).not.toBeNull();
    expect(within(tipRow as HTMLElement).getByText('$20.00')).toBeInTheDocument();

    // No editable tip input here — Card A is the sole editable money surface post-consolidation.
    expect(screen.queryByLabelText(/tip amount/i)).not.toBeInTheDocument();
  });

  it('renders NO totals footer when a DRAFT owns zero lines and has no residual tip/discount', () => {
    const blank = invoice({ line_items: [], subtotal: 0, tax_amount: 0, tax_rate: 0, tip: 0, discount_amount: 0, total_amount: 0 });
    renderWithProviders(<InvoiceLineItemsEditor invoice={blank} />, { ability: adminAbility() });

    expect(screen.getByRole('button', { name: /add the first line item/i })).toBeInTheDocument();
    expect(screen.queryByLabelText(/tip amount/i)).toBeNull();
    expect(screen.queryByText(/invoice total/i)).toBeNull();
  });

  it('shows a residual tip read-only on a locked (PAID) invoice (footer present, no inputs)', () => {
    const lockedEmpty = invoice({ status: 'PAID', line_items: [], subtotal: 0, tax_amount: 0, tax_rate: 0, tip: 20, total_amount: 20 });
    renderWithProviders(<InvoiceLineItemsEditor invoice={lockedEmpty} />, { ability: adminAbility() });

    expect(screen.queryByLabelText(/tip amount/i)).toBeNull(); // not editable
    expect(screen.getByText(/invoice total/i)).toBeInTheDocument(); // but still shown
  });

  it('stacks the description under the item name inside one merged Item cell', () => {
    const lineWithDetail: InvoiceLineItem = {
      ...LINE,
      description: 'Compressor swap\nReplaced R410A compressor, 2-ton unit',
    };
    renderWithProviders(
      <InvoiceLineItemsEditor invoice={invoice({ line_items: [lineWithDetail] })} />,
      { ability: adminAbility() },
    );

    const nameCell = screen.getByText('Compressor swap').closest('td');
    const detailCell = screen.getByText(/Replaced R410A compressor/i).closest('td');
    expect(nameCell).not.toBeNull();
    expect(detailCell).toBe(nameCell);
    expect(screen.queryByRole('columnheader', { name: 'Description' })).not.toBeInTheDocument();
  });

  it('shows the Cost column and margin sub-line when the ability can read Invoice', () => {
    const lineWithCost: InvoiceLineItem = { ...LINE, unit_cost: 90 };
    renderWithProviders(
      <InvoiceLineItemsEditor invoice={invoice({ line_items: [lineWithCost] })} />,
      { ability: pricingAbility() },
    );

    expect(screen.getByText('Cost')).toBeInTheDocument();
    expect(screen.getByLabelText(/cost for compressor swap/i)).toBeInTheDocument();
    // unit_price 150, unit_cost 90 → (150-90)/150 * 100 = 40% margin
    expect(screen.getByText('40% margin')).toBeInTheDocument();
  });

  it('hides the Cost column and margin sub-line entirely when the ability cannot read Invoice', () => {
    const lineWithCost: InvoiceLineItem = { ...LINE, unit_cost: 90 };
    renderWithProviders(
      <InvoiceLineItemsEditor invoice={invoice({ line_items: [lineWithCost] })} />,
      { ability: adminAbility() },
    );

    expect(screen.queryByText('Cost')).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/cost for compressor swap/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/margin/i)).not.toBeInTheDocument();
  });

  // Reordering is drag-only — the per-row Move up/down chevrons were removed. The drag path's own
  // id-list arithmetic is covered directly in line-items-table-drag-reorder.test.ts.
  it('offers a drag handle and no Move up/down buttons for reordering', () => {
    const line2: InvoiceLineItem = { ...LINE, id: 'line-2', description: 'Refrigerant recharge' };
    renderWithProviders(
      <InvoiceLineItemsEditor invoice={invoice({ line_items: [LINE, line2] })} />,
      { ability: adminAbility() },
    );

    expect(screen.getByRole('button', { name: /drag to reorder compressor swap/i })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /move compressor swap down/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /move compressor swap up/i })).not.toBeInTheDocument();
  });

  // The item image is the price-book item's own, rendered in the Item cell — never uploaded per
  // line, and never inside the Description cell.
  it("renders the price-book item's image in the Item cell, with no per-line upload control", () => {
    const lineWithPhoto: InvoiceLineItem = {
      ...LINE,
      price_book_item: { image_url: 'http://img/compressor.png', photo_url: null },
    } as InvoiceLineItem;
    renderWithProviders(
      <InvoiceLineItemsEditor invoice={invoice({ line_items: [lineWithPhoto] })} />,
      { ability: adminAbility() },
    );

    const img = screen.getByAltText('Compressor swap');
    expect(img).toHaveAttribute('src', 'http://img/compressor.png');
    expect(img.closest('td')).toBe(screen.getByText('Compressor swap').closest('td'));
    expect(screen.queryByLabelText(/add photo/i)).not.toBeInTheDocument();
  });

  // Stage 4: AddLineDialog doubles as an edit dialog for an existing line.
  // NOTE: these tests exercise the Markup %/Unit cost fields, which are now gated on
  // canSeePricing (Batch 3 pricing-visibility fix) — they need pricingAbility(), not
  // adminAbility(), or the fields wouldn't render at all. See the "pricing field
  // validation & visibility" describe block below for the canSeePricing=false coverage.
  describe('editing a line via the dialog', () => {
    it("opens the edit dialog pre-filled with the row's current values when Edit is clicked", async () => {
      const lineWithCost: InvoiceLineItem = { ...LINE, unit_cost: 90, markup_percent: 66.67 };
      renderWithProviders(
        <InvoiceLineItemsEditor invoice={invoice({ line_items: [lineWithCost] })} />,
        { ability: pricingAbility() },
      );

      await userEvent.click(screen.getByRole('button', { name: /edit compressor swap/i }));

      const dialog = within(screen.getByRole('dialog'));
      expect(dialog.getByText('Edit line item')).toBeInTheDocument();
      expect(dialog.getByLabelText('Name')).toHaveValue('Compressor swap');
      expect(dialog.getByLabelText('Quantity')).toHaveValue(2);
      expect(dialog.getByLabelText(/^price \(\$\)$/i)).toHaveValue(150);
      expect(dialog.getByLabelText(/markup/i)).toHaveValue(66.67);
      expect(dialog.getByLabelText(/unit cost/i)).toHaveValue(90);
      // Editing an existing line never touches the price-book catalog.
      expect(dialog.queryByText(/also save to price book/i)).not.toBeInTheDocument();
    });

    it('submits an edit through updateInvoiceLine with only the changed fields, including cost derived from markup', async () => {
      renderWithProviders(<InvoiceLineItemsEditor invoice={invoice()} />, { ability: pricingAbility() });

      await userEvent.click(screen.getByRole('button', { name: /edit compressor swap/i }));

      const dialog = within(screen.getByRole('dialog'));
      const qtyInput = dialog.getByLabelText('Quantity');
      await userEvent.clear(qtyInput);
      await userEvent.type(qtyInput, '5');

      const markupInput = dialog.getByLabelText(/markup/i);
      await userEvent.type(markupInput, '50');

      await userEvent.click(dialog.getByRole('button', { name: /save changes/i }));

      // unit_price (150, unchanged) / (1 + 50/100) = 100 — derived cost accompanies the markup.
      // unit_price/is_taxable are untouched, so they're absent — only the changed fields ship.
      await waitFor(() => {
        expect(invoicesApi.updateInvoiceLine).toHaveBeenCalledWith(INVOICE_ID, 'line-1', {
          quantity: 5,
          markup_percent: 50,
          unit_cost: 100,
        });
      });
    });

    it('auto-computes and disables Unit cost while Markup % has a value, then re-enables it when cleared', async () => {
      renderWithProviders(<InvoiceLineItemsEditor invoice={invoice()} />, { ability: pricingAbility() });

      await userEvent.click(screen.getByRole('button', { name: /edit compressor swap/i }));

      const dialog = within(screen.getByRole('dialog'));
      const markupInput = dialog.getByLabelText(/markup/i);
      const costInput = dialog.getByLabelText(/unit cost/i);

      // LINE starts with unit_cost/markup_percent unset — Unit cost starts freely editable.
      expect(costInput).not.toBeDisabled();

      await userEvent.type(markupInput, '50');

      expect(costInput).toBeDisabled();
      expect(costInput).toHaveValue(100); // 150 / (1 + 50/100)
      expect(dialog.getByText(/synced/i)).toBeInTheDocument();

      await userEvent.clear(markupInput);

      expect(costInput).not.toBeDisabled();
    });
  });

  // #2012 — a line row's body opens the same edit dialog the pencil does (AC1/AC3/AC8), a
  // price-book add carries the catalog cost (AC4/R4), the edit form derives Markup % from
  // cost/price only when that's a legal markup (AC5/R3), an untouched derived value persists
  // neither markup_percent nor unit_cost (AC6/R2), and clicks/keys landing on the row's own
  // controls (including Radix portals) never also open the dialog (AC2/R1).
  describe('#2012 — clickable row, price-book cost, derived markup, edit-mode Type', () => {
    it('AC1/AC8: clicking a rendered line row body opens its edit dialog (editor-level, not just LineItemRow in isolation)', async () => {
      renderWithProviders(<InvoiceLineItemsEditor invoice={invoice()} />, { ability: pricingAbility() });

      await userEvent.click(screen.getByText('Compressor swap'));

      const dialog = within(screen.getByRole('dialog'));
      expect(dialog.getByText('Edit line item')).toBeInTheDocument();
      expect(dialog.getByLabelText('Name')).toHaveValue('Compressor swap');
    });

    it('AC3: pressing Space while the row itself is focused opens the edit dialog (and does not fire the page scroll)', () => {
      renderWithProviders(<InvoiceLineItemsEditor invoice={invoice()} />, { ability: pricingAbility() });

      const row = screen.getByTestId('line-item-row');
      const event = createEvent.keyDown(row, { key: ' ' });
      fireEvent(row, event);

      expect(event.defaultPrevented).toBe(true);
      const dialog = within(screen.getByRole('dialog'));
      expect(dialog.getByText('Edit line item')).toBeInTheDocument();
    });

    it('R1(ii): pressing Enter inside the inline Quantity input commits the value but does not also open the edit dialog', async () => {
      renderWithProviders(<InvoiceLineItemsEditor invoice={invoice()} />, { ability: pricingAbility() });

      const qtyInput = screen.getByLabelText(/quantity for compressor swap/i);
      await userEvent.clear(qtyInput);
      await userEvent.type(qtyInput, '5{Enter}');

      await waitFor(() => {
        expect(invoicesApi.updateInvoiceLine).toHaveBeenCalledWith(INVOICE_ID, 'line-1', { quantity: 5 });
      });
      expect(screen.queryByText('Edit line item')).not.toBeInTheDocument();
    });

    it('R1(i): clicking inside the delete-confirm dialog (a Radix portal) does not also open the edit dialog', async () => {
      renderWithProviders(<InvoiceLineItemsEditor invoice={invoice()} />, { ability: pricingAbility() });

      await userEvent.click(screen.getByRole('button', { name: /remove compressor swap/i }));
      const confirmDialog = await screen.findByRole('dialog', { name: /remove "compressor swap"\?/i });

      await userEvent.click(within(confirmDialog).getByText(/remove "compressor swap"\?/i));
      expect(screen.queryByText('Edit line item')).not.toBeInTheDocument();

      await userEvent.click(within(confirmDialog).getByRole('button', { name: /^cancel$/i }));
      expect(invoicesApi.deleteInvoiceLine).not.toHaveBeenCalled();
    });

    it('AC4/R4: a price-book add carries the catalog unit_cost; markup_percent stays absent', async () => {
      vi.mocked(invoicesApi.searchPriceBookItems).mockResolvedValue([
        {
          id: 'pb-2012', name: 'Catalog compressor', description: null, image_url: null,
          type: 'SERVICE', unit_cost: 40, unit_price: 178, taxable: true, category: null,
        },
      ]);
      renderWithProviders(<InvoiceLineItemsEditor invoice={invoice({ line_items: [] })} />, {
        ability: pricingAbility(),
      });

      await userEvent.click(screen.getByRole('button', { name: /^add item$/i }));
      await userEvent.type(screen.getByLabelText(/search the price book/i), 'Catalog');
      await userEvent.click(await screen.findByText('Catalog compressor'));
      await userEvent.click(screen.getByRole('button', { name: /^add item$/i }));

      await waitFor(() => {
        expect(invoicesApi.addInvoiceLine).toHaveBeenCalledWith(
          INVOICE_ID,
          expect.objectContaining({ unit_cost: 40 }),
        );
      });
      const addedPayload = vi.mocked(invoicesApi.addInvoiceLine).mock.calls[0][1];
      expect(addedPayload.markup_percent).toBeUndefined();
    });

    it('R4: a price-book item with no cost (unit_cost null) adds a line with no unit_cost key at all', async () => {
      vi.mocked(invoicesApi.searchPriceBookItems).mockResolvedValue([
        {
          id: 'pb-2013', name: 'Costless labor', description: null, image_url: null,
          type: 'SERVICE', unit_cost: null as unknown as number, unit_price: 60, taxable: true, category: null,
        },
      ]);
      renderWithProviders(<InvoiceLineItemsEditor invoice={invoice({ line_items: [] })} />, {
        ability: pricingAbility(),
      });

      await userEvent.click(screen.getByRole('button', { name: /^add item$/i }));
      await userEvent.type(screen.getByLabelText(/search the price book/i), 'Costless');
      await userEvent.click(await screen.findByText('Costless labor'));
      await userEvent.click(screen.getByRole('button', { name: /^add item$/i }));

      await waitFor(() => expect(invoicesApi.addInvoiceLine).toHaveBeenCalled());
      const addedPayload = vi.mocked(invoicesApi.addInvoiceLine).mock.calls[0][1];
      expect('unit_cost' in addedPayload).toBe(false);
    });

    it('AC5/R3: derives Markup % = 345 for unit_cost 40 / unit_price 178 (stored markup null); Unit cost stays editable and shows 40', async () => {
      const lineWithCostNoMarkup: InvoiceLineItem = { ...LINE, unit_cost: 40, unit_price: 178, markup_percent: null };
      renderWithProviders(
        <InvoiceLineItemsEditor invoice={invoice({ line_items: [lineWithCostNoMarkup] })} />,
        { ability: pricingAbility() },
      );

      await userEvent.click(screen.getByRole('button', { name: /edit compressor swap/i }));
      const dialog = within(screen.getByRole('dialog'));
      expect(dialog.getByLabelText(/markup/i)).toHaveValue(345);
      const costInput = dialog.getByLabelText(/unit cost/i);
      expect(costInput).not.toBeDisabled();
      expect(costInput).toHaveValue(40);
    });

    it('AC6/R2: saving that AC5 dialog untouched persists neither markup_percent nor unit_cost', async () => {
      const lineWithCostNoMarkup: InvoiceLineItem = { ...LINE, unit_cost: 40, unit_price: 178, markup_percent: null };
      renderWithProviders(
        <InvoiceLineItemsEditor invoice={invoice({ line_items: [lineWithCostNoMarkup] })} />,
        { ability: pricingAbility() },
      );

      await userEvent.click(screen.getByRole('button', { name: /edit compressor swap/i }));
      const dialog = within(screen.getByRole('dialog'));
      // Touch an unrelated field so the patch isn't empty (there must be SOMETHING to save), and
      // assert the untouched-derived markup/cost still ship no keys of their own.
      await userEvent.type(dialog.getByLabelText(/description/i), 'x');
      await userEvent.click(dialog.getByRole('button', { name: /save changes/i }));

      await waitFor(() => expect(invoicesApi.updateInvoiceLine).toHaveBeenCalled());
      const patch = vi.mocked(invoicesApi.updateInvoiceLine).mock.calls[0][2];
      expect(patch.markup_percent).toBeUndefined();
      expect(patch.unit_cost).toBeUndefined();
    });

    it('R3: a below-cost line (unit_price < unit_cost) shows an empty Markup %, not a negative derived value', async () => {
      const belowCost: InvoiceLineItem = { ...LINE, unit_cost: 200, unit_price: 150, markup_percent: null };
      renderWithProviders(
        <InvoiceLineItemsEditor invoice={invoice({ line_items: [belowCost] })} />,
        { ability: pricingAbility() },
      );

      await userEvent.click(screen.getByRole('button', { name: /edit compressor swap/i }));
      const dialog = within(screen.getByRole('dialog'));
      expect(dialog.getByLabelText(/markup/i)).toHaveValue(null);
    });

    it('R3: a stored markup of 0 renders as 0, not re-derived and not blank', async () => {
      const zeroMarkup: InvoiceLineItem = { ...LINE, unit_cost: 100, unit_price: 100, markup_percent: 0 };
      renderWithProviders(
        <InvoiceLineItemsEditor invoice={invoice({ line_items: [zeroMarkup] })} />,
        { ability: pricingAbility() },
      );

      await userEvent.click(screen.getByRole('button', { name: /edit compressor swap/i }));
      const dialog = within(screen.getByRole('dialog'));
      expect(dialog.getByLabelText(/markup/i)).toHaveValue(0);
    });

    it("edit mode: the Type select is seeded from the line's item_type and a change PATCHes item_type; 'Save to price book' uses the edited type", async () => {
      const materialLine: InvoiceLineItem = { ...LINE, item_type: 'MATERIAL' };
      renderWithProviders(
        <InvoiceLineItemsEditor invoice={invoice({ line_items: [materialLine] })} />,
        { ability: pricingAbility() },
      );

      await userEvent.click(screen.getByRole('button', { name: /edit compressor swap/i }));
      const dialog = within(screen.getByRole('dialog'));
      const typeSelect = dialog.getByLabelText(/^type$/i) ?? dialog.getByLabelText(/item type/i);
      await userEvent.click(typeSelect);
      await userEvent.click(await screen.findByRole('option', { name: /^service$/i }));
      await userEvent.click(dialog.getByRole('button', { name: /save changes/i }));

      await waitFor(() => {
        expect(invoicesApi.updateInvoiceLine).toHaveBeenCalledWith(
          INVOICE_ID,
          'line-1',
          expect.objectContaining({ item_type: 'SERVICE' }),
        );
      });
    });
  });

  // Batch 3 fixes: stale "Unit price" copy → "Selling price"; Markup %/Unit cost gated on
  // canSeePricing (absent, not merely disabled, matching LineItemRow's Cost column); client-side
  // range validation on Markup %/Unit cost (mirroring Quantity/Selling price's existing pattern);
  // and an emptied Markup % on save is treated as "no change", never a silent unconfirmed null-out.
  describe('pricing field validation & visibility (AddLineDialog canSeePricing gate)', () => {
    // M5 fix: AddLineDialog's 4-up grid always renders (Markup %/Unit cost columns are never
    // removed) — only the VALUES are masked blank + disabled for a caller who can't see pricing.
    // Was "hides the Markup %/Unit cost inputs" (asserted absent) — that was the anti-pattern M5
    // named for replacement (gate values, not the whole row).
    it('masks the Markup %/Unit cost inputs (present, disabled, blank) in the EDIT form when the ability cannot read Invoice', async () => {
      const lineWithCost: InvoiceLineItem = { ...LINE, unit_cost: 90, markup_percent: 66.67 };
      renderWithProviders(
        <InvoiceLineItemsEditor invoice={invoice({ line_items: [lineWithCost] })} />,
        { ability: adminAbility() },
      );

      await userEvent.click(screen.getByRole('button', { name: /edit compressor swap/i }));

      const dialog = within(screen.getByRole('dialog'));
      expect(dialog.getByText('Edit line item')).toBeInTheDocument();
      const markupInput = dialog.getByLabelText(/markup/i);
      const costInput = dialog.getByLabelText(/unit cost/i);
      expect(markupInput).toBeInTheDocument();
      expect(markupInput).toBeDisabled();
      expect(markupInput).toHaveValue(null);
      expect(markupInput).toHaveAttribute('placeholder', '—');
      expect(costInput).toBeInTheDocument();
      expect(costInput).toBeDisabled();
      expect(costInput).toHaveValue(null);
      expect(costInput).toHaveAttribute('placeholder', '—');
    });

    it('masks the Markup %/Unit cost inputs (present, disabled, blank) in the NEW-ITEM form when the ability cannot read Invoice', async () => {
      renderWithProviders(
        <InvoiceLineItemsEditor invoice={invoice({ line_items: [] })} />,
        { ability: adminAbility() },
      );

      await userEvent.click(screen.getByRole('button', { name: /^add item$/i }));
      await userEvent.type(screen.getByLabelText(/search the price book/i), 'Diagnostic fee');
      await userEvent.click(await screen.findByRole('button', { name: /^add new item: diagnostic fee$/i }));

      const markupInput = screen.getByLabelText(/markup/i);
      const costInput = screen.getByLabelText(/unit cost/i);
      expect(markupInput).toBeInTheDocument();
      expect(markupInput).toBeDisabled();
      expect(markupInput).toHaveValue(null);
      expect(costInput).toBeInTheDocument();
      expect(costInput).toBeDisabled();
      expect(costInput).toHaveValue(null);
    });

    it('shows the friendly "Selling price" error (not the stale "Unit price" wording) for a negative price in the new-item form', async () => {
      renderWithProviders(
        <InvoiceLineItemsEditor invoice={invoice({ line_items: [] })} />,
        { ability: adminAbility() },
      );

      await userEvent.click(screen.getByRole('button', { name: /^add item$/i }));
      await userEvent.type(screen.getByLabelText(/search the price book/i), 'Diagnostic fee');
      await userEvent.click(await screen.findByRole('button', { name: /^add new item: diagnostic fee$/i }));

      const priceInput = screen.getByLabelText(/^price \(\$\)$/i);
      await userEvent.clear(priceInput);
      await userEvent.type(priceInput, '-5');
      await userEvent.click(screen.getByRole('button', { name: /^add item$/i }));

      expect(await screen.findByText('Selling price must be a non-negative number.')).toBeInTheDocument();
      expect(invoicesApi.addInvoiceLine).not.toHaveBeenCalled();
    });

    it('shows the friendly "Selling price" error (not the stale "Unit price" wording) for a negative price in the edit form', async () => {
      renderWithProviders(<InvoiceLineItemsEditor invoice={invoice()} />, { ability: adminAbility() });

      await userEvent.click(screen.getByRole('button', { name: /edit compressor swap/i }));

      const dialog = within(screen.getByRole('dialog'));
      const priceInput = dialog.getByLabelText(/^price \(\$\)$/i);
      await userEvent.clear(priceInput);
      await userEvent.type(priceInput, '-5');
      await userEvent.click(dialog.getByRole('button', { name: /save changes/i }));

      expect(await dialog.findByText('Selling price must be a non-negative number.')).toBeInTheDocument();
      expect(invoicesApi.updateInvoiceLine).not.toHaveBeenCalled();
    });

    it('shows a friendly inline error and does NOT submit when Markup % is out of the backend-accepted [0, 100000] range', async () => {
      renderWithProviders(<InvoiceLineItemsEditor invoice={invoice()} />, { ability: pricingAbility() });

      await userEvent.click(screen.getByRole('button', { name: /edit compressor swap/i }));

      const dialog = within(screen.getByRole('dialog'));
      const markupInput = dialog.getByLabelText(/markup/i);
      await userEvent.type(markupInput, '100001');
      await userEvent.click(dialog.getByRole('button', { name: /save changes/i }));

      expect(await dialog.findByText('Markup % must be between 0 and 100,000.')).toBeInTheDocument();
      expect(invoicesApi.updateInvoiceLine).not.toHaveBeenCalled();
    });

    it('treats an emptied Markup % field on save as "no change" rather than silently nulling out a previously-set value', async () => {
      const lineWithMarkup: InvoiceLineItem = { ...LINE, unit_cost: 90, markup_percent: 50 };
      renderWithProviders(
        <InvoiceLineItemsEditor invoice={invoice({ line_items: [lineWithMarkup] })} />,
        { ability: pricingAbility() },
      );

      await userEvent.click(screen.getByRole('button', { name: /edit compressor swap/i }));

      const dialog = within(screen.getByRole('dialog'));
      await userEvent.clear(dialog.getByLabelText(/markup/i));

      const qtyInput = dialog.getByLabelText('Quantity');
      await userEvent.clear(qtyInput);
      await userEvent.type(qtyInput, '5');

      await userEvent.click(dialog.getByRole('button', { name: /save changes/i }));

      // Only quantity changed — markup_percent/unit_cost are absent, NOT nulled out.
      await waitFor(() => {
        expect(invoicesApi.updateInvoiceLine).toHaveBeenCalledWith(INVOICE_ID, 'line-1', { quantity: 5 });
      });
    });
  });
});

// LO-4 (spec §14) — the invoice line editor's legacy stock sync is retired: no per-line
// chips, no header "N not synced" pill, no "Sync all", no per-line Sync action, on any
// status. Logistic orders own stock movement now.
describe('InvoiceLineItemsEditor — inventory sync retired (LO-4)', () => {
  const SYNCED_LINE: InvoiceLineItem = {
    ...LINE,
    id: 'line-syn',
    description: 'Filter 20x20',
    item_type: 'MATERIAL',
    price_book_item_id: 'pb-1',
    stock_status: 'SYNCED',
    stock_location_id: stockHoisted.LOC_MAIN_ID,
  };
  const UNSYNCED_LINE: InvoiceLineItem = {
    ...LINE,
    id: 'line-uns',
    description: 'Wire spool',
    item_type: 'MATERIAL',
    price_book_item_id: 'pb-2',
    stock_status: 'UNSYNCED',
    stock_location_id: null,
  };

  it('renders no chips, header pill, Sync-all, or per-line Sync on an editable invoice', () => {
    renderWithProviders(
      <InvoiceLineItemsEditor invoice={invoice({ line_items: [SYNCED_LINE, UNSYNCED_LINE] })} />,
      { ability: adminAbility() },
    );

    expect(screen.queryByText(/^synced$/i)).toBeNull();
    expect(screen.queryByText(/not synced/i)).toBeNull();
    expect(screen.queryByRole('button', { name: /^sync all/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /sync .* with inventory/i })).toBeNull();
  });
});

// Batch 3: InvoiceScopeOfWorkCard, exported alongside InvoiceLineItemsEditor from the same source
// file. Unlike the Job side, an invoice's scopes ride along on the SAME detail fetch (no separate
// GET) — the card takes them straight off the `invoice` prop, so these tests never mock GET.
describe('InvoiceScopeOfWorkCard', () => {
  const SCOPE: Scope = {
    id: 'scope-1',
    title: 'Demo & haul-away',
    body: 'Remove old unit and dispose responsibly.',
    flat_price: 250,
    is_taxable: true,
    internal_cost: 100,
  };
  const SCOPE_B: Scope = {
    id: 'scope-2',
    title: 'Permit filing',
    body: '',
    flat_price: null,
    is_taxable: false,
    internal_cost: null,
  };

  function scopeInvoice(overrides: Partial<InvoiceScopeOfWorkCardInvoice> = {}): InvoiceScopeOfWorkCardInvoice {
    return {
      id: INVOICE_ID,
      status: 'DRAFT',
      scopes: [SCOPE],
      ...overrides,
    };
  }

  // Both `manage_lines` AND `update` Invoice — the backend's B6 (add/delete) + B7 (update) split
  // on /scopes routes, matching the single canEdit flag ScopeOfWorkCard exposes.
  const fullEditAbility = () =>
    buildAbility([
      { action: 'manage_lines', subject: 'Invoice' },
      { action: 'update', subject: 'Invoice' },
    ]);
  const pricingAbility = () =>
    buildAbility([
      { action: 'manage_lines', subject: 'Invoice' },
      { action: 'update', subject: 'Invoice' },
      // SRVW-140 - the cost/margin gate is `read Pricing`, not `read Invoice`.
      { action: 'read', subject: 'Pricing' },
    ]);
  // Mirrors SALES' default grant (defaultGrants.ts): manage_lines Invoice via OWN_INVOICE_VIA_LEAD,
  // but NOT update.
  const manageLinesOnlyAbility = () => buildAbility([{ action: 'manage_lines', subject: 'Invoice' }]);
  // Inverse combination — reachable in the ability model (e.g. a custom per-user grant override)
  // even though no default role produces `update` Invoice without `manage_lines` Invoice today
  // (defaultGrants.ts: DISPATCHER/ADMIN hold both; SALES holds neither on `update`).
  const updateOnlyAbility = () => buildAbility([{ action: 'update', subject: 'Invoice' }]);

  beforeEach(() => {
    vi.mocked(invoicesApi.addInvoiceScope).mockResolvedValue({});
    vi.mocked(invoicesApi.updateInvoiceScope).mockResolvedValue({});
    vi.mocked(invoicesApi.deleteInvoiceScope).mockResolvedValue({});
    vi.mocked(invoicesApi.reorderInvoiceScopes).mockResolvedValue({});
  });

  it('renders the invoice-embedded scopes with no separate fetch', () => {
    renderWithProviders(<InvoiceScopeOfWorkCard invoice={scopeInvoice()} />, { ability: fullEditAbility() });

    expect(screen.getByDisplayValue('Demo & haul-away')).toBeInTheDocument();
  });

  it('adds a scope through addInvoiceScope keyed to the INVOICE id', async () => {
    renderWithProviders(<InvoiceScopeOfWorkCard invoice={scopeInvoice()} />, { ability: fullEditAbility() });

    await userEvent.click(screen.getByRole('button', { name: /add scope of work/i }));
    await userEvent.type(screen.getByLabelText(/new scope title/i), 'Permit filing');
    await userEvent.click(screen.getByRole('button', { name: /^add$/i }));

    await waitFor(() => {
      // `is_taxable` now rides along from the add form's Taxable pill, which defaults to Yes
      // (matching the backend's own `is_taxable` default). No `flat_price` key: the price field
      // was left blank, which stays a legitimate "not priced yet" block.
      expect(invoicesApi.addInvoiceScope).toHaveBeenCalledWith(INVOICE_ID, {
        title: 'Permit filing',
        body: '',
        is_taxable: true,
      });
    });
  });

  it('commits a title edit through updateInvoiceScope on blur', async () => {
    renderWithProviders(<InvoiceScopeOfWorkCard invoice={scopeInvoice()} />, { ability: fullEditAbility() });

    const titleInput = screen.getByLabelText(/title for scope 1/i);
    await userEvent.clear(titleInput);
    await userEvent.type(titleInput, 'Demo & disposal');
    await userEvent.tab();

    await waitFor(() => {
      expect(invoicesApi.updateInvoiceScope).toHaveBeenCalledWith(INVOICE_ID, 0, { title: 'Demo & disposal' });
    });
  });

  it('deletes a scope through deleteInvoiceScope', async () => {
    renderWithProviders(<InvoiceScopeOfWorkCard invoice={scopeInvoice()} />, { ability: fullEditAbility() });

    await userEvent.click(screen.getByRole('button', { name: /delete scope 1/i }));

    await waitFor(() => {
      expect(invoicesApi.deleteInvoiceScope).toHaveBeenCalledWith(INVOICE_ID, 0);
    });
  });

  it('persists a Move down through the atomic reorderInvoiceScope endpoint (single request, no concurrent PATCH race)', async () => {
    renderWithProviders(
      <InvoiceScopeOfWorkCard invoice={scopeInvoice({ scopes: [SCOPE, SCOPE_B] })} />,
      { ability: pricingAbility() },
    );

    await userEvent.click(screen.getByRole('button', { name: /move scope 1 down/i }));

    await waitFor(() => {
      expect(invoicesApi.reorderInvoiceScopes).toHaveBeenCalledWith(INVOICE_ID, [SCOPE_B.id, SCOPE.id]);
    });
    // Exactly one atomic call — never the old two-concurrent-PATCH diff strategy.
    expect(invoicesApi.reorderInvoiceScopes).toHaveBeenCalledTimes(1);
    expect(invoicesApi.updateInvoiceScope).not.toHaveBeenCalled();
  });

  it('hides the internal_cost field when the ability cannot read Invoice', () => {
    renderWithProviders(<InvoiceScopeOfWorkCard invoice={scopeInvoice()} />, { ability: fullEditAbility() });

    expect(screen.queryByLabelText(/internal cost for scope 1/i)).not.toBeInTheDocument();
  });

  it('shows an editable internal_cost field when the ability can read Invoice', () => {
    renderWithProviders(<InvoiceScopeOfWorkCard invoice={scopeInvoice()} />, { ability: pricingAbility() });

    expect(screen.getByLabelText(/internal cost for scope 1/i)).toHaveValue(100);
  });

  it('renders read-only, with no add/edit/delete affordances, when the ability grants nothing', () => {
    renderWithProviders(<InvoiceScopeOfWorkCard invoice={scopeInvoice()} />);

    expect(screen.getByText('Demo & haul-away')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /add scope of work/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /delete scope 1/i })).toBeNull();
    expect(screen.queryByLabelText(/title for scope 1/i)).toBeNull();
  });

  // Invoice-specific nuance (no Job equivalent — Job gates everything on one ability): SALES
  // carries manage_lines Invoice without update by default (defaultGrants.ts). The backend's
  // actual route gates are asymmetric — POST/DELETE /scopes require only manage_lines; PATCH
  // /scopes/:idx and /scopes/reorder require only update — so this ability SHOULD see working
  // Add/Delete affordances, just not inline field editing or reorder (which would 403).
  it('shows Add/Delete but hides inline edit + reorder when the ability has manage_lines Invoice but NOT update (mirrors SALES)', () => {
    renderWithProviders(
      <InvoiceScopeOfWorkCard invoice={scopeInvoice({ scopes: [SCOPE, SCOPE_B] })} />,
      { ability: manageLinesOnlyAbility() },
    );

    // Add + Delete work — backend gates POST/DELETE /scopes on manage_lines only.
    expect(screen.getByRole('button', { name: /add scope of work/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /delete scope 1/i })).toBeInTheDocument();

    // Inline field editing + reorder are unavailable — backend gates those on update only,
    // which this ability lacks.
    expect(screen.queryByLabelText(/title for scope 1/i)).toBeNull();
    expect(screen.queryByLabelText(/description for scope 1/i)).toBeNull();
    expect(screen.queryByRole('switch', { name: /taxable for scope 1/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /move scope 1 down/i })).toBeNull();
  });

  // Inverse split: update without manage_lines. Not produced by any default role today, but the
  // component must honor the grants it's given regardless of which role combination produces them.
  it('shows inline edit + reorder but hides Add/Delete when the ability has update Invoice but NOT manage_lines', () => {
    renderWithProviders(
      <InvoiceScopeOfWorkCard invoice={scopeInvoice({ scopes: [SCOPE, SCOPE_B] })} />,
      { ability: updateOnlyAbility() },
    );

    expect(screen.queryByRole('button', { name: /add scope of work/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /delete scope 1/i })).toBeNull();

    expect(screen.getByLabelText(/title for scope 1/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /move scope 1 down/i })).toBeInTheDocument();
  });

  it('renders read-only on a locked (PAID) invoice even with full edit grants', () => {
    renderWithProviders(
      <InvoiceScopeOfWorkCard invoice={scopeInvoice({ status: 'PAID' })} />,
      { ability: fullEditAbility() },
    );

    expect(screen.queryByRole('button', { name: /add scope of work/i })).toBeNull();
    expect(screen.queryByLabelText(/title for scope 1/i)).toBeNull();
  });
});
