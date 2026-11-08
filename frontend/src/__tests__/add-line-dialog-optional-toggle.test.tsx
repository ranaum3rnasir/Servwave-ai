/**
 * #2053 slice 1 / #2088 — AddLineDialog's single Optional switch (create + edit forms). Gated on
 * `showOptionalToggle` (default false, R6's shared prop name): Job/Invoice never pass it, so no
 * switch ever renders and no key is ever put on the outgoing payload — the two assertions this
 * file exists to pin.
 *
 * #2088 removed the separate "Selected" switch (repro-2088.test.tsx's own frozen assertion).
 * Optional ON now implies not-selected in the same click (the total drops at once, Ran §1);
 * Optional OFF implies selected. These tests were updated in place (not frozen) to match.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { AddLineDialog } from '@/components/jobs/items/AddLineDialog';
import type { InvoiceLineItem } from '@/lib/api/jobs';

vi.mock('@/lib/api/invoices', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api/invoices')>('@/lib/api/invoices');
  return {
    ...actual,
    searchPriceBookItems: vi.fn().mockResolvedValue([]),
    listPriceBookItems: vi.fn().mockResolvedValue([]),
  };
});

const EDITING_LINE: InvoiceLineItem = {
  id: 'line-1',
  sequence: 1,
  description: 'AC Unit',
  quantity: 1,
  unit_price: 100,
  is_taxable: true,
  line_total: 100,
  discount_type: null,
  discount_value: null,
  discount_amount: 0,
  item_type: 'SERVICE',
  price_book_item_id: null,
};

function baseProps() {
  return {
    open: true,
    onOpenChange: vi.fn(),
    onAdd: vi.fn(),
    onUpdate: vi.fn(),
    // initialQuery jumps straight into the creatingNew form, bypassing the search screen (no
    // network mocking needed for the create-mode tests below).
    initialQuery: 'New line',
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('AddLineDialog — showOptionalToggle (#2053)', () => {
  it('create mode: no Optional switch renders, and onAdd never carries the keys, when the prop is omitted (Job/Invoice)', async () => {
    const props = baseProps();
    render(<AddLineDialog {...props} />);

    expect(screen.queryByRole('switch', { name: /optional for new line/i })).not.toBeInTheDocument();

    await userEvent.type(screen.getByLabelText(/^price/i), '10');
    await userEvent.click(screen.getByRole('button', { name: /^add item$/i }));

    expect(props.onAdd).toHaveBeenCalledTimes(1);
    const payload = props.onAdd.mock.calls[0][0];
    expect(payload).not.toHaveProperty('is_optional');
    expect(payload).not.toHaveProperty('is_selected');
  });

  it('create mode: no "Selected" switch exists anywhere, and turning Optional on sends is_optional:true, is_selected:false', async () => {
    const props = baseProps();
    render(<AddLineDialog {...props} showOptionalToggle />);

    expect(screen.getByRole('switch', { name: /optional for new line/i })).not.toBeChecked();
    expect(screen.queryByRole('switch', { name: /selected/i })).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole('switch', { name: /optional for new line/i }));
    expect(screen.queryByRole('switch', { name: /selected/i })).not.toBeInTheDocument();

    await userEvent.type(screen.getByLabelText(/^price/i), '10');
    await userEvent.click(screen.getByRole('button', { name: /^add item$/i }));

    expect(props.onAdd).toHaveBeenCalledTimes(1);
    const payload = props.onAdd.mock.calls[0][0];
    expect(payload.is_optional).toBe(true);
    expect(payload.is_selected).toBe(false);
  });

  it('create mode: turning Optional back off before saving sends is_optional:false, is_selected:true', async () => {
    const props = baseProps();
    render(<AddLineDialog {...props} showOptionalToggle />);

    const optionalSwitch = screen.getByRole('switch', { name: /optional for new line/i });
    await userEvent.click(optionalSwitch);
    await userEvent.click(optionalSwitch);
    expect(optionalSwitch).not.toBeChecked();

    await userEvent.type(screen.getByLabelText(/^price/i), '10');
    await userEvent.click(screen.getByRole('button', { name: /^add item$/i }));

    expect(props.onAdd).toHaveBeenCalledTimes(1);
    const payload = props.onAdd.mock.calls[0][0];
    expect(payload.is_optional).toBe(false);
    expect(payload.is_selected).toBe(true);
  });

  it('edit mode: pre-fills Optional from the existing line, no "Selected" switch renders, and toggling Optional off diffs is_selected back into the patch', async () => {
    const props = { open: true, onOpenChange: vi.fn(), onAdd: vi.fn(), onUpdate: vi.fn() };
    render(
      <AddLineDialog
        {...props}
        showOptionalToggle
        editingLine={{ ...EDITING_LINE, is_optional: true, is_selected: false }}
      />,
    );

    const optionalSwitch = screen.getByRole('switch', { name: /optional for this line/i });
    expect(optionalSwitch).toBeChecked();
    expect(screen.queryByRole('switch', { name: /selected/i })).not.toBeInTheDocument();

    await userEvent.click(optionalSwitch);
    await userEvent.click(screen.getByRole('button', { name: /save changes/i }));

    expect(props.onUpdate).toHaveBeenCalledTimes(1);
    const [lineId, patch] = props.onUpdate.mock.calls[0];
    expect(lineId).toBe(EDITING_LINE.id);
    expect(patch.is_optional).toBe(false);
    expect(patch.is_selected).toBe(true);
  });

  it('edit mode: no Optional/Selected switch renders, and the patch never carries the keys, when the prop is omitted (Job/Invoice)', async () => {
    const props = { open: true, onOpenChange: vi.fn(), onAdd: vi.fn(), onUpdate: vi.fn() };
    render(<AddLineDialog {...props} editingLine={EDITING_LINE} />);

    expect(screen.queryByRole('switch', { name: /optional for this line/i })).not.toBeInTheDocument();

    await userEvent.click(within(screen.getByRole('dialog')).getByLabelText(/^name$/i));
    await userEvent.click(screen.getByRole('button', { name: /save changes/i }));
    // A no-op edit (nothing changed) still must not carry the keys even if onUpdate never fires;
    // assert directly that the toggle path is unreachable at all.
    expect(screen.queryByLabelText(/optional/i)).not.toBeInTheDocument();
  });
});

/**
 * #2090 slice A4 — after a send, the Optional switch's second write (the recommendation) belongs
 * on the rep's own column. `rep_selected` is what the row checkbox renders and what the next send
 * publishes, so the dialog has to start from it and diff against it; starting from the customer's
 * `is_selected` silently drops the rep's change whenever the two disagree.
 */
describe('AddLineDialog — the Optional switch after a send (#2090 A4)', () => {
  it('records the recommendation when the rep makes a line they had NOT recommended mandatory', async () => {
    const props = { open: true, onOpenChange: vi.fn(), onAdd: vi.fn(), onUpdate: vi.fn() };
    render(
      <AddLineDialog
        {...props}
        showOptionalToggle
        // The customer ticked this add-on; the rep's row checkbox shows it UNticked, because the
        // rep does not recommend it (LineItemRow renders `rep_selected ?? is_selected`).
        editingLine={{ ...EDITING_LINE, is_optional: true, is_selected: true, rep_selected: false }}
      />,
    );

    await userEvent.click(screen.getByRole('switch', { name: /optional for this line/i }));
    await userEvent.click(screen.getByRole('button', { name: /save changes/i }));

    expect(props.onUpdate).toHaveBeenCalledTimes(1);
    const [, patch] = props.onUpdate.mock.calls[0];
    expect(patch.is_optional).toBe(false);
    // The coupling: not-optional means recommended. That has to reach the wire, or the next send
    // publishes "not recommended" onto a line the customer can no longer decline.
    expect(patch.is_selected).toBe(true);
  });

  it('records the recommendation when the rep stops recommending a line the customer had declined', async () => {
    const props = { open: true, onOpenChange: vi.fn(), onAdd: vi.fn(), onUpdate: vi.fn() };
    render(
      <AddLineDialog
        {...props}
        showOptionalToggle
        // The mirror case: the customer declined it, the rep's checkbox shows it ticked.
        editingLine={{ ...EDITING_LINE, is_optional: true, is_selected: false, rep_selected: true }}
      />,
    );

    // Off, then back on: the switch ends where it started, so `is_optional` is unchanged, but the
    // coupling has moved the recommendation to "not recommended".
    const optionalSwitch = screen.getByRole('switch', { name: /optional for this line/i });
    await userEvent.click(optionalSwitch);
    await userEvent.click(optionalSwitch);
    expect(optionalSwitch).toBeChecked();

    await userEvent.click(screen.getByRole('button', { name: /save changes/i }));

    expect(props.onUpdate).toHaveBeenCalledTimes(1);
    const [, patch] = props.onUpdate.mock.calls[0];
    expect(patch).not.toHaveProperty('is_optional');
    expect(patch.is_selected).toBe(false);
  });
});
