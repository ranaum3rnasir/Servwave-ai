/**
 * SRVW-248 - line item delete on the Estimate workspace must not fire until the confirm
 * dialog is accepted. Two separate paths reach the same delete mutation on Estimate:
 *   1. The row's trash icon, guarded in the shared `LineItemRow.tsx` (one useConfirm instance
 *      covers Job/Estimate/Invoice alike) - mirrors job-items-editor.test.tsx's and
 *      invoice-line-items-editor.test.tsx's own "does not delete until confirmed" coverage.
 *   2. Estimate's OWN `<AddLineDialog>` instance (EstimateLineItemsEditor.tsx:408-427) - the
 *      only surface that renders a second AddLineDialog wired with `onDelete`, since Job/Invoice
 *      only use LineItemsTable's built-in instance, which never receives that prop. Its edit-form
 *      footer Delete button is guarded directly inside `AddLineDialog.tsx`'s own `handleDelete`.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithProviders } from './helpers';
import { EstimateLineItemsEditor } from '@/components/estimates/EstimateLineItemsEditor';
import { buildAbility } from '@/lib/ability';
import type { EstimateLineItem } from '@/lib/api/estimates';
import * as estimatesApi from '@/lib/api/estimates';

vi.mock('@/lib/api/estimates', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api/estimates')>('@/lib/api/estimates');
  return {
    ...actual,
    addEstimateLine: vi.fn().mockResolvedValue({ estimate: { line_items: [] } }),
    updateEstimateLine: vi.fn().mockResolvedValue({ estimate: {} }),
    deleteEstimateLine: vi.fn().mockResolvedValue({ estimate: { line_items: [] } }),
    reorderEstimateLines: vi.fn().mockResolvedValue({ estimate: {} }),
  };
});

vi.mock('@/lib/api/invoices', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api/invoices')>();
  return { ...actual, searchPriceBookItems: vi.fn().mockResolvedValue([]) };
});

const ESTIMATE_ID = 'est-abc-001';

const LINE: EstimateLineItem = {
  id: 'line-1',
  estimate_id: ESTIMATE_ID,
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

const adminAbility = () => buildAbility([{ action: 'update', subject: 'Estimate' }]);

beforeEach(() => {
  vi.clearAllMocks();
});

describe('EstimateLineItemsEditor - delete confirm', () => {
  it('does not delete a line via the row trash icon until the confirm dialog is accepted', async () => {
    renderWithProviders(
      <EstimateLineItemsEditor
        estimate={{ id: ESTIMATE_ID, line_items: [LINE], total_amount: 300 }}
        canManage
        canSeePricing={false}
        canSaveToPriceBook={false}
      />,
      { ability: adminAbility() },
    );

    const trash = await screen.findByRole('button', { name: /remove compressor swap/i });
    await userEvent.click(trash);

    expect(await screen.findByText('Remove "Compressor swap"?')).toBeInTheDocument();
    expect(estimatesApi.deleteEstimateLine).not.toHaveBeenCalled();

    await userEvent.click(screen.getByRole('button', { name: /^cancel$/i }));
    expect(estimatesApi.deleteEstimateLine).not.toHaveBeenCalled();

    await userEvent.click(trash);
    await userEvent.click(await screen.findByRole('button', { name: /^remove$/i }));

    await waitFor(() => {
      expect(estimatesApi.deleteEstimateLine).toHaveBeenCalledWith(ESTIMATE_ID, 'line-1');
    });
  });

  it('does not delete a line via the edit dialog footer Delete button until confirmed', async () => {
    renderWithProviders(
      <EstimateLineItemsEditor
        estimate={{ id: ESTIMATE_ID, line_items: [LINE], total_amount: 300 }}
        canManage
        canSeePricing={false}
        canSaveToPriceBook={false}
      />,
      { ability: adminAbility() },
    );

    await userEvent.click(await screen.findByRole('button', { name: /edit compressor swap/i }));
    await userEvent.click(await screen.findByRole('button', { name: /^delete$/i }));

    // Both the edit dialog and the confirm dialog are mounted at once here (each has its own
    // "Cancel" button with the same accessible name) - scope to the confirm dialog specifically,
    // found by its title, rather than the ambiguous unscoped query.
    const confirmDialog = await screen.findByRole('dialog', { name: /remove "compressor swap"\?/i });
    expect(estimatesApi.deleteEstimateLine).not.toHaveBeenCalled();

    await userEvent.click(within(confirmDialog).getByRole('button', { name: /^cancel$/i }));
    expect(estimatesApi.deleteEstimateLine).not.toHaveBeenCalled();

    await userEvent.click(screen.getByRole('button', { name: /^delete$/i }));
    const confirmDialogAgain = await screen.findByRole('dialog', { name: /remove "compressor swap"\?/i });
    await userEvent.click(within(confirmDialogAgain).getByRole('button', { name: /^remove$/i }));

    await waitFor(() => {
      expect(estimatesApi.deleteEstimateLine).toHaveBeenCalledWith(ESTIMATE_ID, 'line-1');
    });
  });
});

// #2012 — EstimateLineItemsEditor's own updateMutation built the PATCH body from an explicit
// field whitelist that never included item_type, so a Type change computed correctly by
// AddLineDialog was silently dropped before the network call ever fired.
describe('EstimateLineItemsEditor - item_type on update (#2012)', () => {
  it('changing Type from Service to Material sends item_type in the PATCH body', async () => {
    renderWithProviders(
      <EstimateLineItemsEditor
        estimate={{ id: ESTIMATE_ID, line_items: [LINE], total_amount: 300 }}
        canManage
        canSeePricing
        canSaveToPriceBook={false}
      />,
      { ability: adminAbility() },
    );

    await userEvent.click(await screen.findByRole('button', { name: /edit compressor swap/i }));
    const dialog = within(screen.getByRole('dialog'));
    await userEvent.click(dialog.getByLabelText(/item type/i));
    await userEvent.click(await screen.findByRole('option', { name: /^material$/i }));
    await userEvent.click(dialog.getByRole('button', { name: /save changes/i }));

    await waitFor(() => {
      expect(estimatesApi.updateEstimateLine).toHaveBeenCalledWith(
        ESTIMATE_ID,
        'line-1',
        expect.objectContaining({ item_type: 'MATERIAL' }),
      );
    });
  });

  it('saving without a Type change sends no item_type key', async () => {
    renderWithProviders(
      <EstimateLineItemsEditor
        estimate={{ id: ESTIMATE_ID, line_items: [LINE], total_amount: 300 }}
        canManage
        canSeePricing
        canSaveToPriceBook={false}
      />,
      { ability: adminAbility() },
    );

    await userEvent.click(await screen.findByRole('button', { name: /edit compressor swap/i }));
    const dialog = within(screen.getByRole('dialog'));
    const qtyInput = dialog.getByLabelText('Quantity');
    await userEvent.clear(qtyInput);
    await userEvent.type(qtyInput, '5');
    await userEvent.click(dialog.getByRole('button', { name: /save changes/i }));

    await waitFor(() => expect(estimatesApi.updateEstimateLine).toHaveBeenCalled());
    const [, , body] = vi.mocked(estimatesApi.updateEstimateLine).mock.calls[0];
    expect('item_type' in body).toBe(false);
  });
});
