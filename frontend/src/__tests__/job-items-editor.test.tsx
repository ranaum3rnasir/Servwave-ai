import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithProviders } from './helpers';
import { LineItemsEditor, JobScopeOfWorkCard } from '@/components/jobs/items/LineItemsEditor';
import { buildAbility } from '@/lib/ability';
import api from '@/lib/axios';
import type { JobLineItem, JobBilling, Scope } from '@/lib/api/jobs';
import * as invoicesApi from '@/lib/api/invoices';

// AddLineDialog's price-book search/browse goes straight through invoices.ts — mock just those
// functions so typing in the search box never hits the network. Everything the Items tab
// itself talks to (GET/POST/PATCH/DELETE /jobs/:id/line-items) goes through the REAL
// @/lib/api/jobs module down to the shared axios instance, which is spied on below — this is
// what lets the required test assert the exact URL a line-add hits (and that it's never
// `ensure-invoice`, which no longer exists as a route).
vi.mock('@/lib/api/invoices', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api/invoices')>('@/lib/api/invoices');
  return {
    ...actual,
    searchPriceBookItems: vi.fn().mockResolvedValue([]),
    listPriceBookItems: vi.fn().mockResolvedValue([]),
  };
});

// Inventory P1 — SyncStockDialog/AddLineDialog consume the inventory + organization seams.
// Mocked as STABLE resolved data (the sanctioned jsdom seed-loop pattern, see
// purchase-orders-deeplink.test.tsx) so they never hit the network in jsdom. The toast fn
// is mocked so the warn-mode branch can be asserted without mounting a Toaster.
const hoisted = vi.hoisted(() => ({
  LOC_MAIN_ID: 'aaaaaaa1-0000-4000-8000-000000000001',
  LOC_VAN_ID: 'aaaaaaa2-0000-4000-8000-000000000002',
  toast: vi.fn(),
}));

vi.mock('@/components/ui/use-toast', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/components/ui/use-toast')>();
  return { ...actual, toast: hoisted.toast };
});

vi.mock('@/lib/api/inventory', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api/inventory')>();
  const locations = [
    { id: hoisted.LOC_MAIN_ID, name: 'Main Warehouse', type: 'warehouse', branch: 'HQ' },
    { id: hoisted.LOC_VAN_ID, name: 'Van 12', type: 'truck', branch: 'HQ' },
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
    default_inventory_location_id: hoisted.LOC_MAIN_ID,
    block_negative_stock: false,
  };
  return {
    ...actual,
    useOrganization: () => ({ data: org, isLoading: false, isError: false }),
  };
});

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
// Cost/margin are gated on the SAME frontend ability check as the backend's canSeePricing gate.
// SRVW-140 - that check is now ability.can('read', 'Pricing'), the grant the Roles UI
// "See financial data" switch writes, NOT 'Invoice' (which is about invoice RECORDS).
const pricingAbility = () =>
  buildAbility([
    { action: 'manage_lines', subject: 'Job' },
    { action: 'read', subject: 'Pricing' },
  ]);

let getSpy: ReturnType<typeof vi.spyOn>;
let postSpy: ReturnType<typeof vi.spyOn>;
let patchSpy: ReturnType<typeof vi.spyOn>;
let deleteSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  vi.clearAllMocks();
  getSpy = vi.spyOn(api, 'get').mockResolvedValue({ data: { lines: [LINE], billing: billingFor([LINE]) } });
  postSpy = vi.spyOn(api, 'post').mockResolvedValue({ data: { line: LINE, billing: billingFor([LINE]) } });
  patchSpy = vi.spyOn(api, 'patch').mockResolvedValue({ data: { line: LINE, billing: billingFor([LINE]) } });
  deleteSpy = vi
    .spyOn(api, 'delete')
    .mockResolvedValue({ data: { billing: { total: 0, invoiced: 0, remaining: 0 } } });
});

describe('LineItemsEditor', () => {
  it('renders column headers and one row per line item, fetched from /jobs/:id/line-items', async () => {
    renderWithProviders(<LineItemsEditor jobId={JOB_ID} canManage />, { ability: adminAbility() });

    expect(await screen.findByText('Compressor swap')).toBeInTheDocument();
    expect(getSpy).toHaveBeenCalledWith(`/api/jobs/${JOB_ID}/line-items`);

    expect(screen.getByText('Item')).toBeInTheDocument();
    expect(screen.getByText('Qty')).toBeInTheDocument();
    expect(screen.getByText('Selling price')).toBeInTheDocument();
    expect(screen.getByText('Taxable')).toBeInTheDocument();
    expect(screen.getByText('Total')).toBeInTheDocument();
    expect(screen.getAllByTestId('line-item-row')).toHaveLength(1);
  });

  // Task 6c: the job-line API drops discount fields (add/update never send discount_type/value),
  // so the control would silently no-op and snap back — the Job grid hides it (showDiscount=false)
  // until real job-line discount support lands. Invoice/Estimate grids are unaffected (see
  // invoice-line-items-editor.test.tsx).
  it('hides the Discount column entirely (job-line API does not support it yet)', async () => {
    renderWithProviders(<LineItemsEditor jobId={JOB_ID} canManage />, { ability: adminAbility() });

    await screen.findByText('Compressor swap');
    expect(screen.queryByText('Discount')).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/discount type for compressor swap/i)).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/discount value for compressor swap/i)).not.toBeInTheDocument();
  });

  it('shows the "+" add affordance and per-row trash when canManage (update Job)', async () => {
    renderWithProviders(<LineItemsEditor jobId={JOB_ID} canManage />, { ability: adminAbility() });

    await screen.findByText('Compressor swap');
    expect(screen.getByRole('button', { name: /add item/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /remove compressor swap/i })).toBeInTheDocument();
  });

  it('exposes inline-editable qty/price fields when canEdit', async () => {
    renderWithProviders(<LineItemsEditor jobId={JOB_ID} canManage />, { ability: adminAbility() });

    await screen.findByText('Compressor swap');
    expect(screen.getByLabelText(/quantity for compressor swap/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/selling price for compressor swap/i)).toBeInTheDocument();
  });

  it('renders read-only values (no edit inputs, no trash, no "+") when ability grants nothing', async () => {
    renderWithProviders(<LineItemsEditor jobId={JOB_ID} canManage={false} />);

    await screen.findByText('Compressor swap');
    expect(screen.queryByRole('button', { name: /add item/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /remove compressor swap/i })).toBeNull();
    expect(screen.queryByLabelText(/quantity for compressor swap/i)).toBeNull();
  });

  it('commits a line update through PATCH /jobs/:id/line-items/:lineId on blur', async () => {
    renderWithProviders(<LineItemsEditor jobId={JOB_ID} canManage />, { ability: adminAbility() });

    const qty = await screen.findByLabelText(/quantity for compressor swap/i);
    await userEvent.clear(qty);
    await userEvent.type(qty, '3');
    await userEvent.tab(); // blur → commit

    await waitFor(() => {
      expect(patchSpy).toHaveBeenCalledWith(`/api/jobs/${JOB_ID}/line-items/line-1`, { quantity: 3 });
    });
  });

  it('does not delete until the confirm dialog is accepted', async () => {
    renderWithProviders(<LineItemsEditor jobId={JOB_ID} canManage />, { ability: adminAbility() });

    const trash = await screen.findByRole('button', { name: /remove compressor swap/i });
    await userEvent.click(trash);

    expect(await screen.findByText('Remove "Compressor swap"?')).toBeInTheDocument();
    expect(deleteSpy).not.toHaveBeenCalled();

    await userEvent.click(screen.getByRole('button', { name: /^cancel$/i }));
    expect(deleteSpy).not.toHaveBeenCalled();
  });

  it('deletes a line through DELETE /jobs/:id/line-items/:lineId once confirmed', async () => {
    renderWithProviders(<LineItemsEditor jobId={JOB_ID} canManage />, { ability: adminAbility() });

    const trash = await screen.findByRole('button', { name: /remove compressor swap/i });
    await userEvent.click(trash);

    await userEvent.click(await screen.findByRole('button', { name: /^remove$/i }));

    await waitFor(() => {
      expect(deleteSpy).toHaveBeenCalledWith(`/api/jobs/${JOB_ID}/line-items/line-1`);
    });
  });

  it('adds a line via /jobs/:id/line-items and never calls ensure-invoice', async () => {
    getSpy.mockResolvedValue({ data: { lines: [], billing: { total: 0, invoiced: 0, remaining: 0 } } });
    postSpy.mockResolvedValue({ data: { line: {}, billing: { total: 100, invoiced: 0, remaining: 100 } } });

    renderWithProviders(<LineItemsEditor jobId={JOB_ID} canManage />, { ability: adminAbility() });

    // Empty state — open the dialog via the header "+" affordance.
    await userEvent.click(await screen.findByRole('button', { name: /^add item$/i }));

    // Single-search flow: type a query, then choose "Add new item: <query>" (v12 wording —
    // the query itself is bolded inline in the button's accessible name).
    await userEvent.type(screen.getByLabelText(/search the price book/i), 'Diagnostic fee');
    await userEvent.click(await screen.findByRole('button', { name: /^add new item: diagnostic fee$/i }));

    // Name is prefilled from the query; set the unit price and submit.
    const priceInput = screen.getByLabelText(/^price \(\$\)$/i);
    await userEvent.clear(priceInput);
    await userEvent.type(priceInput, '95');
    await userEvent.click(screen.getByRole('button', { name: /^add item$/i }));

    await waitFor(() => {
      expect(postSpy).toHaveBeenCalledWith(
        `/api/jobs/${JOB_ID}/line-items`,
        expect.objectContaining({ description: 'Diagnostic fee', unit_price: 95 }),
      );
    });
    expect(postSpy).not.toHaveBeenCalledWith(expect.stringContaining('ensure-invoice'), expect.anything());
  });

  it('stacks the description under the item name inside one merged Item cell', async () => {
    const lineWithDetail: JobLineItem = {
      ...LINE,
      description: 'Compressor swap\nReplaced R410A compressor, 2-ton unit',
    };
    getSpy.mockResolvedValue({ data: { lines: [lineWithDetail], billing: billingFor([lineWithDetail]) } });

    renderWithProviders(<LineItemsEditor jobId={JOB_ID} canManage />, { ability: adminAbility() });

    const nameCell = (await screen.findByText('Compressor swap')).closest('td');
    const detailCell = screen.getByText(/Replaced R410A compressor/i).closest('td');
    expect(nameCell).not.toBeNull();
    expect(detailCell).toBe(nameCell);
    expect(screen.queryByRole('columnheader', { name: 'Description' })).not.toBeInTheDocument();
  });

  it('shows the Cost column and margin sub-line when the ability can read Invoice', async () => {
    const lineWithCost: JobLineItem = { ...LINE, unit_cost: 90 };
    getSpy.mockResolvedValue({ data: { lines: [lineWithCost], billing: billingFor([lineWithCost]) } });

    renderWithProviders(<LineItemsEditor jobId={JOB_ID} canManage />, { ability: pricingAbility() });

    await screen.findByText('Compressor swap');
    expect(screen.getByText('Cost')).toBeInTheDocument();
    expect(screen.getByLabelText(/cost for compressor swap/i)).toBeInTheDocument();
    // unit_price 150, unit_cost 90 → (150-90)/150 * 100 = 40% margin
    expect(screen.getByText('40% margin')).toBeInTheDocument();
  });

  it('hides the Cost column and margin sub-line entirely when the ability cannot read Invoice', async () => {
    const lineWithCost: JobLineItem = { ...LINE, unit_cost: 90 };
    getSpy.mockResolvedValue({ data: { lines: [lineWithCost], billing: billingFor([lineWithCost]) } });

    renderWithProviders(<LineItemsEditor jobId={JOB_ID} canManage />, { ability: adminAbility() });

    await screen.findByText('Compressor swap');
    expect(screen.queryByText('Cost')).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/cost for compressor swap/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/margin/i)).not.toBeInTheDocument();
  });

  // Reordering is drag-only — the per-row Move up/down chevrons were removed. The drag path's own
  // id-list arithmetic is covered directly in line-items-table-drag-reorder.test.ts.
  it('offers a drag handle and no Move up/down buttons for reordering', async () => {
    const line2: JobLineItem = { ...LINE, id: 'line-2', description: 'Refrigerant recharge' };
    const lines = [LINE, line2];
    getSpy.mockResolvedValue({ data: { lines, billing: billingFor(lines) } });

    renderWithProviders(<LineItemsEditor jobId={JOB_ID} canManage />, { ability: adminAbility() });

    await screen.findByText('Compressor swap');
    expect(screen.getByRole('button', { name: /drag to reorder compressor swap/i })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /move compressor swap down/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /move compressor swap up/i })).not.toBeInTheDocument();
  });

  // Stage 4: AddLineDialog doubles as an edit dialog for an existing line.
  // NOTE: these tests exercise the Markup %/Unit cost fields, which are now gated on
  // canSeePricing (Batch 3 pricing-visibility fix) — they need pricingAbility(), not
  // adminAbility(), or the fields wouldn't render at all. See the "pricing field
  // validation & visibility" describe block below for the canSeePricing=false coverage.
  describe('editing a line via the dialog', () => {
    it("opens the edit dialog pre-filled with the row's current values when Edit is clicked", async () => {
      const lineWithCost: JobLineItem = { ...LINE, unit_cost: 90, markup_percent: 66.67 };
      getSpy.mockResolvedValue({ data: { lines: [lineWithCost], billing: billingFor([lineWithCost]) } });

      renderWithProviders(<LineItemsEditor jobId={JOB_ID} canManage />, { ability: pricingAbility() });

      await userEvent.click(await screen.findByRole('button', { name: /edit compressor swap/i }));

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

    it('submits an edit through PATCH with only the changed fields, including cost derived from markup', async () => {
      renderWithProviders(<LineItemsEditor jobId={JOB_ID} canManage />, { ability: pricingAbility() });

      await userEvent.click(await screen.findByRole('button', { name: /edit compressor swap/i }));

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
        expect(patchSpy).toHaveBeenCalledWith(`/api/jobs/${JOB_ID}/line-items/line-1`, {
          quantity: 5,
          markup_percent: 50,
          unit_cost: 100,
        });
      });
    });

    it('auto-computes and disables Unit cost while Markup % has a value, then re-enables it when cleared', async () => {
      renderWithProviders(<LineItemsEditor jobId={JOB_ID} canManage />, { ability: pricingAbility() });

      await userEvent.click(await screen.findByRole('button', { name: /edit compressor swap/i }));

      const dialog = within(screen.getByRole('dialog'));
      const markupInput = dialog.getByLabelText(/markup/i);
      const costInput = dialog.getByLabelText(/unit cost/i);

      // LINE starts with unit_cost/markup_percent null — Unit cost starts freely editable.
      expect(costInput).not.toBeDisabled();

      await userEvent.type(markupInput, '50');

      expect(costInput).toBeDisabled();
      expect(costInput).toHaveValue(100); // 150 / (1 + 50/100)
      expect(dialog.getByText(/synced/i)).toBeInTheDocument();

      await userEvent.clear(markupInput);

      expect(costInput).not.toBeDisabled();
    });

    // #2012 — the wrapper's own PATCH-body whitelist dropped item_type before it ever reached
    // the network, even though AddLineDialog computed it correctly.
    it('#2012: changing Type from Service to Material sends item_type in the PATCH body', async () => {
      renderWithProviders(<LineItemsEditor jobId={JOB_ID} canManage />, { ability: pricingAbility() });

      await userEvent.click(await screen.findByRole('button', { name: /edit compressor swap/i }));

      const dialog = within(screen.getByRole('dialog'));
      await userEvent.click(dialog.getByLabelText(/item type/i));
      await userEvent.click(await screen.findByRole('option', { name: /^material$/i }));
      await userEvent.click(dialog.getByRole('button', { name: /save changes/i }));

      await waitFor(() => {
        expect(patchSpy).toHaveBeenCalledWith(`/api/jobs/${JOB_ID}/line-items/line-1`, {
          item_type: 'MATERIAL',
        });
      });
    });

    it('#2012: saving without a Type change sends no item_type key', async () => {
      renderWithProviders(<LineItemsEditor jobId={JOB_ID} canManage />, { ability: pricingAbility() });

      await userEvent.click(await screen.findByRole('button', { name: /edit compressor swap/i }));

      const dialog = within(screen.getByRole('dialog'));
      const qtyInput = dialog.getByLabelText('Quantity');
      await userEvent.clear(qtyInput);
      await userEvent.type(qtyInput, '5');
      await userEvent.click(dialog.getByRole('button', { name: /save changes/i }));

      await waitFor(() => {
        expect(patchSpy).toHaveBeenCalledWith(`/api/jobs/${JOB_ID}/line-items/line-1`, {
          quantity: 5,
        });
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
      const lineWithCost: JobLineItem = { ...LINE, unit_cost: 90, markup_percent: 66.67 };
      getSpy.mockResolvedValue({ data: { lines: [lineWithCost], billing: billingFor([lineWithCost]) } });

      renderWithProviders(<LineItemsEditor jobId={JOB_ID} canManage />, { ability: adminAbility() });

      await userEvent.click(await screen.findByRole('button', { name: /edit compressor swap/i }));

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
      renderWithProviders(<LineItemsEditor jobId={JOB_ID} canManage />, { ability: adminAbility() });

      await userEvent.click(await screen.findByRole('button', { name: /^add item$/i }));
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
      renderWithProviders(<LineItemsEditor jobId={JOB_ID} canManage />, { ability: adminAbility() });

      await userEvent.click(await screen.findByRole('button', { name: /^add item$/i }));

      const dialog = within(screen.getByRole('dialog'));
      await userEvent.type(dialog.getByLabelText(/search the price book/i), 'Diagnostic fee');
      await userEvent.click(await dialog.findByRole('button', { name: /^add new item: diagnostic fee$/i }));

      const priceInput = dialog.getByLabelText(/^price \(\$\)$/i);
      await userEvent.clear(priceInput);
      await userEvent.type(priceInput, '-5');
      await userEvent.click(dialog.getByRole('button', { name: /^add item$/i }));

      expect(await dialog.findByText('Selling price must be a non-negative number.')).toBeInTheDocument();
      expect(postSpy).not.toHaveBeenCalled();
    });

    it('shows the friendly "Selling price" error (not the stale "Unit price" wording) for a negative price in the edit form', async () => {
      renderWithProviders(<LineItemsEditor jobId={JOB_ID} canManage />, { ability: adminAbility() });

      await userEvent.click(await screen.findByRole('button', { name: /edit compressor swap/i }));

      const dialog = within(screen.getByRole('dialog'));
      const priceInput = dialog.getByLabelText(/^price \(\$\)$/i);
      await userEvent.clear(priceInput);
      await userEvent.type(priceInput, '-5');
      await userEvent.click(dialog.getByRole('button', { name: /save changes/i }));

      expect(await dialog.findByText('Selling price must be a non-negative number.')).toBeInTheDocument();
      expect(patchSpy).not.toHaveBeenCalled();
    });

    it('shows a friendly inline error and does NOT submit when Markup % is out of the backend-accepted [0, 100000] range', async () => {
      renderWithProviders(<LineItemsEditor jobId={JOB_ID} canManage />, { ability: pricingAbility() });

      await userEvent.click(await screen.findByRole('button', { name: /edit compressor swap/i }));

      const dialog = within(screen.getByRole('dialog'));
      const markupInput = dialog.getByLabelText(/markup/i);
      await userEvent.type(markupInput, '100001');
      await userEvent.click(dialog.getByRole('button', { name: /save changes/i }));

      expect(await dialog.findByText('Markup % must be between 0 and 100,000.')).toBeInTheDocument();
      expect(patchSpy).not.toHaveBeenCalled();
    });

    it('treats an emptied Markup % field on save as "no change" rather than silently nulling out a previously-set value', async () => {
      const lineWithMarkup: JobLineItem = { ...LINE, unit_cost: 90, markup_percent: 50 };
      getSpy.mockResolvedValue({ data: { lines: [lineWithMarkup], billing: billingFor([lineWithMarkup]) } });

      renderWithProviders(<LineItemsEditor jobId={JOB_ID} canManage />, { ability: pricingAbility() });

      await userEvent.click(await screen.findByRole('button', { name: /edit compressor swap/i }));

      const dialog = within(screen.getByRole('dialog'));
      await userEvent.clear(dialog.getByLabelText(/markup/i));

      const qtyInput = dialog.getByLabelText('Quantity');
      await userEvent.clear(qtyInput);
      await userEvent.type(qtyInput, '5');

      await userEvent.click(dialog.getByRole('button', { name: /save changes/i }));

      // Only quantity changed — markup_percent/unit_cost are absent, NOT nulled out.
      await waitFor(() => {
        expect(patchSpy).toHaveBeenCalledWith(`/api/jobs/${JOB_ID}/line-items/line-1`, { quantity: 5 });
      });
    });
  });
});

// LO-4 (spec §14) — the legacy line-stock sync is retired: no per-line stock chips, no
// header "N not synced" pill, no "Sync all", no per-line Sync action, and adding a tracked
// item never offers a "Deduct from" location select or sends stock_location_id. Logistic
// orders own stock movement now.
describe('LineItemsEditor — inventory sync retired (LO-4)', () => {
  const TRACKED_SYNCED: JobLineItem = {
    ...LINE,
    id: 'line-synced',
    description: 'Filter 20x20',
    item_type: 'MATERIAL',
    price_book_item_id: 'pb-1',
    stock_status: 'SYNCED',
    stock_location_id: hoisted.LOC_MAIN_ID,
  };
  const TRACKED_UNSYNCED: JobLineItem = {
    ...LINE,
    id: 'line-1',
    price_book_item_id: 'pb-2',
    stock_status: 'UNSYNCED',
    stock_location_id: null,
  };
  const NOT_TRACKED_LINE: JobLineItem = {
    ...LINE,
    id: 'line-nt',
    description: 'Custom labor',
    stock_status: 'NOT_TRACKED',
  };

  const TRACKED_PB: invoicesApi.PriceBookItem = {
    id: 'pb-9',
    name: 'Water Heater',
    description: null,
    image_url: null,
    type: 'MATERIAL',
    unit_cost: 100,
    unit_price: 200,
    taxable: true,
    category: null,
    track_inventory: true,
  };

  it('renders no stock chips, header pill, Sync-all, or per-line Sync for any line state', async () => {
    const lines = [TRACKED_SYNCED, TRACKED_UNSYNCED, NOT_TRACKED_LINE];
    getSpy.mockResolvedValue({ data: { lines, billing: billingFor(lines) } });

    renderWithProviders(<LineItemsEditor jobId={JOB_ID} canManage />, { ability: adminAbility() });

    await screen.findByText('Compressor swap');
    expect(screen.queryByText(/^synced$/i)).toBeNull();
    expect(screen.queryByText(/not synced/i)).toBeNull();
    expect(screen.queryByRole('button', { name: /^sync all/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /sync .* with inventory/i })).toBeNull();
  });

  it('adds a tracked item with no "Deduct from" select and no stock_location_id in the payload', async () => {
    getSpy.mockResolvedValue({ data: { lines: [], billing: { total: 0, invoiced: 0, remaining: 0 } } });
    vi.mocked(invoicesApi.searchPriceBookItems).mockResolvedValue([TRACKED_PB]);

    renderWithProviders(<LineItemsEditor jobId={JOB_ID} canManage />, { ability: adminAbility() });

    await userEvent.click(await screen.findByRole('button', { name: /^add item$/i }));
    await userEvent.type(screen.getByLabelText(/search the price book/i), 'Water');
    await userEvent.click(await screen.findByText('Water Heater'));

    // The retired Deduct-from select never renders — just the plain Quantity field.
    expect(screen.queryByRole('combobox', { name: 'Deduct from' })).toBeNull();
    expect(screen.getByLabelText('Quantity')).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: /^add item$/i }));

    await waitFor(() => expect(postSpy).toHaveBeenCalled());
    const body = postSpy.mock.calls.at(-1)![1] as Record<string, unknown>;
    expect(body).toMatchObject({ price_book_item_id: 'pb-9' });
    expect(body).not.toHaveProperty('stock_location_id');
  });
});

// Batch 3: JobScopeOfWorkCard, exported alongside LineItemsEditor from the same source file —
// GET/POST/PATCH/DELETE /api/jobs/:id/scopes. getSpy is shared with the LineItemsEditor tests
// above and is mocked without regard to URL there, so every test in this block re-mocks it with
// a URL-aware implementation (line-items calls fall back to an empty/zero response).
describe('JobScopeOfWorkCard', () => {
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
  const EMPTY_LINE_ITEMS = { lines: [], billing: { total: 0, invoiced: 0, remaining: 0 } };

  function mockScopesGet(scopes: Scope[]) {
    getSpy.mockImplementation(async (url: string) => {
      if (url.includes('/scopes')) {
        const total = scopes.reduce((s, sc) => s + (sc.flat_price ?? 0), 0);
        return { data: { scopes, billing: { total, invoiced: 0, remaining: total } } };
      }
      return { data: EMPTY_LINE_ITEMS };
    });
  }

  beforeEach(() => {
    mockScopesGet([SCOPE]);
    postSpy.mockResolvedValue({ data: { scopes: [SCOPE], billing: { total: 250, invoiced: 0, remaining: 250 } } });
    patchSpy.mockResolvedValue({ data: { scopes: [SCOPE], billing: { total: 250, invoiced: 0, remaining: 250 } } });
    deleteSpy.mockResolvedValue({ data: { billing: { total: 0, invoiced: 0, remaining: 0 } } });
  });

  it('fetches scopes from GET /jobs/:id/scopes and renders a block', async () => {
    renderWithProviders(<JobScopeOfWorkCard jobId={JOB_ID} canManage />, { ability: adminAbility() });

    expect(await screen.findByDisplayValue('Demo & haul-away')).toBeInTheDocument();
    expect(getSpy).toHaveBeenCalledWith(`/api/jobs/${JOB_ID}/scopes`);
  });

  it('adds a scope through POST /jobs/:id/scopes', async () => {
    renderWithProviders(<JobScopeOfWorkCard jobId={JOB_ID} canManage />, { ability: adminAbility() });

    // Wait for the real (loaded) block first — "Add scope of work" also renders in the
    // transient empty-state CTA before the fetch resolves, and clicking that stale node right
    // before the swap to the loaded SectionCard silently drops the click.
    await screen.findByDisplayValue('Demo & haul-away');
    await userEvent.click(screen.getByRole('button', { name: /add scope of work/i }));
    await userEvent.type(screen.getByLabelText(/new scope title/i), 'Permit filing');
    await userEvent.click(screen.getByRole('button', { name: /^add$/i }));

    await waitFor(() => {
      // `is_taxable` now rides along from the add form's Taxable pill, which defaults to Yes
      // (matching the backend's own `is_taxable` default). No `flat_price` key: the price field
      // was left blank, which stays a legitimate "not priced yet" block.
      expect(postSpy).toHaveBeenCalledWith(`/api/jobs/${JOB_ID}/scopes`, {
        title: 'Permit filing',
        body: '',
        is_taxable: true,
      });
    });
  });

  it('commits a title edit through PATCH /jobs/:id/scopes/:idx on blur', async () => {
    renderWithProviders(<JobScopeOfWorkCard jobId={JOB_ID} canManage />, { ability: adminAbility() });

    const titleInput = await screen.findByLabelText(/title for scope 1/i);
    await userEvent.clear(titleInput);
    await userEvent.type(titleInput, 'Demo & disposal');
    await userEvent.tab();

    await waitFor(() => {
      expect(patchSpy).toHaveBeenCalledWith(`/api/jobs/${JOB_ID}/scopes/0`, { title: 'Demo & disposal' });
    });
  });

  it('deletes a scope through DELETE /jobs/:id/scopes/:idx', async () => {
    renderWithProviders(<JobScopeOfWorkCard jobId={JOB_ID} canManage />, { ability: adminAbility() });

    await userEvent.click(await screen.findByRole('button', { name: /delete scope 1/i }));

    await waitFor(() => {
      expect(deleteSpy).toHaveBeenCalledWith(`/api/jobs/${JOB_ID}/scopes/0`);
    });
  });

  it('persists a Move down through the atomic PATCH /jobs/:id/scopes/reorder endpoint (single request, no concurrent PATCH race)', async () => {
    mockScopesGet([SCOPE, SCOPE_B]);
    patchSpy.mockResolvedValue({
      data: { scopes: [SCOPE_B, SCOPE], billing: { total: 250, invoiced: 0, remaining: 250 } },
    });

    renderWithProviders(<JobScopeOfWorkCard jobId={JOB_ID} canManage />, { ability: pricingAbility() });

    await userEvent.click(await screen.findByRole('button', { name: /move scope 1 down/i }));

    await waitFor(() => {
      expect(patchSpy).toHaveBeenCalledWith(`/api/jobs/${JOB_ID}/scopes/reorder`, {
        order: [SCOPE_B.id, SCOPE.id],
      });
    });
    // Exactly one atomic call — never the old two-concurrent-PATCH diff strategy (which hit
    // /scopes/0 and /scopes/1 as two separate index-addressed requests).
    expect(patchSpy).toHaveBeenCalledTimes(1);
  });

  it('hides the internal_cost field when the ability cannot read Invoice', async () => {
    renderWithProviders(<JobScopeOfWorkCard jobId={JOB_ID} canManage />, { ability: adminAbility() });

    await screen.findByDisplayValue('Demo & haul-away');
    expect(screen.queryByLabelText(/internal cost for scope 1/i)).not.toBeInTheDocument();
  });

  it('shows an editable internal_cost field when the ability can read Invoice', async () => {
    renderWithProviders(<JobScopeOfWorkCard jobId={JOB_ID} canManage />, { ability: pricingAbility() });

    expect(await screen.findByLabelText(/internal cost for scope 1/i)).toHaveValue(100);
  });

  it('renders read-only, with no add/edit/delete affordances, when the ability grants nothing', async () => {
    renderWithProviders(<JobScopeOfWorkCard jobId={JOB_ID} canManage={false} />);

    await screen.findByText('Demo & haul-away');
    expect(screen.queryByRole('button', { name: /add scope of work/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /delete scope 1/i })).toBeNull();
    expect(screen.queryByLabelText(/title for scope 1/i)).toBeNull();
  });
});

// #588 — Browse price book inside the add-line dialog. Ported from the pre-SERV10X-38 test
// shape (the old editor added lines to an invoice via addInvoiceLine); the job editor now owns
// its lines, so the add posts to /jobs/:id/line-items through the spied axios instance.
describe('AddLineDialog — browse price book (#588)', () => {
  // Two active catalog rows in the type/taxable shape the API returns (see PriceBookItem).
  const PB_ITEMS: invoicesApi.PriceBookItem[] = [
    {
      id: 'pb-1',
      name: 'Air Filter 20x20',
      description: null,
      image_url: null,
      type: 'MATERIAL',
      unit_cost: 8,
      unit_price: 25,
      taxable: true,
      category: null,
    },
    {
      id: 'pb-2',
      name: 'Diagnostic Service',
      description: null,
      image_url: null,
      type: 'SERVICE',
      unit_cost: 0,
      unit_price: 120,
      taxable: false,
      category: null,
    },
  ];

  const adminAbility = () => buildAbility([{ action: 'manage_lines', subject: 'Job' }]);

  it('AC#1/AC#2: Browse lists the catalog without typing and adds the pick through the job-lines API', async () => {
    vi.mocked(invoicesApi.listPriceBookItems).mockResolvedValue(PB_ITEMS);

    renderWithProviders(<LineItemsEditor jobId={JOB_ID} canManage />, { ability: adminAbility() });
    await screen.findByText('Compressor swap');

    await userEvent.click(screen.getByRole('button', { name: /add item/i }));

    // AC#1: the Browse button is present alongside an empty search box.
    const browseBtn = await screen.findByRole('button', { name: /browse price book/i });
    expect(screen.getByLabelText(/search the price book/i)).toHaveValue('');

    // Click Browse → the active catalog loads without typing a query.
    await userEvent.click(browseBtn);
    expect(await screen.findByText('Air Filter 20x20')).toBeInTheDocument();
    expect(screen.getByText('Diagnostic Service')).toBeInTheDocument();
    expect(vi.mocked(invoicesApi.listPriceBookItems)).toHaveBeenCalled();

    // AC#2: pick one, set quantity, add → the payload carries the catalog reference fields.
    await userEvent.click(screen.getByText('Air Filter 20x20'));
    const qty = screen.getByLabelText('Quantity');
    await userEvent.clear(qty);
    await userEvent.type(qty, '2');
    await userEvent.click(screen.getByRole('button', { name: /^add item$/i }));

    await waitFor(() => {
      expect(postSpy).toHaveBeenCalledWith(
        `/api/jobs/${JOB_ID}/line-items`,
        expect.objectContaining({
          description: 'Air Filter 20x20',
          item_type: 'MATERIAL',
          is_taxable: true,
          price_book_item_id: 'pb-1',
          quantity: 2,
          unit_price: 25,
        }),
      );
    });
  });

  it('AC#1: Browse still shows on an empty catalog and reports emptiness', async () => {
    vi.mocked(invoicesApi.listPriceBookItems).mockResolvedValue([]);

    renderWithProviders(<LineItemsEditor jobId={JOB_ID} canManage />, { ability: adminAbility() });
    await screen.findByText('Compressor swap');

    await userEvent.click(screen.getByRole('button', { name: /add item/i }));

    const browseBtn = await screen.findByRole('button', { name: /browse price book/i });
    await userEvent.click(browseBtn);

    expect(await screen.findByText(/price book is empty/i)).toBeInTheDocument();
  });
});
