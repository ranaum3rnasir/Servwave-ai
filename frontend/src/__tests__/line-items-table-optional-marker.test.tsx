/**
 * #2053 slice 1 AC11 / #2088 — LineItemsTable/LineItemRow's "Optional" marker + row checkbox.
 * Gated on `showOptionalToggle` (default false, R6's shared prop name): a non-optional row (and
 * every row on Job/Invoice, which never pass the prop) renders nothing extra.
 *
 * #2088 replaced the inline "Selected" switch with a leading `Include <description>` checkbox
 * (repro-2088.test.tsx's own frozen assertion) — updated in place (not frozen) to match.
 */
import { describe, it, expect, vi } from 'vitest';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { LineItemsTable } from '@/components/jobs/items/LineItemsTable';
import type { InvoiceLineItem } from '@/lib/api/jobs';
import { renderWithProviders as render } from './helpers';

vi.mock('@/lib/api/invoices', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api/invoices')>('@/lib/api/invoices');
  return {
    ...actual,
    searchPriceBookItems: vi.fn().mockResolvedValue([]),
    listPriceBookItems: vi.fn().mockResolvedValue([]),
  };
});

function line(over: Partial<InvoiceLineItem> & { id: string }): InvoiceLineItem {
  return {
    sequence: 1,
    description: 'Base line',
    quantity: 1,
    unit_price: 100,
    unit_cost: null,
    markup_percent: null,
    is_taxable: true,
    line_total: 100,
    discount_type: null,
    discount_value: null,
    discount_amount: 0,
    item_type: 'SERVICE',
    price_book_item_id: null,
    ...over,
  };
}

function baseProps(lines: InvoiceLineItem[]) {
  return {
    lines,
    canAdd: true,
    canManageRows: true,
    canEditRows: true,
    canEditBilling: false,
    canSeePricing: true,
    busy: false,
    hasInvoice: false,
    subtotal: null,
    tax_amount: null,
    tax_rate: null,
    discount_amount: null,
    tip: null,
    total_amount: null,
    addOpen: false,
    onAddOpenChange: vi.fn(),
    canSaveToPriceBook: false,
    editingLine: null,
    onEditingLineChange: vi.fn(),
    onAdd: vi.fn(),
    onUpdate: vi.fn(),
    onDelete: vi.fn(),
    onReorder: vi.fn(),
    onTipChange: vi.fn(),
    onDiscountChange: vi.fn(),
    onTaxRateChange: vi.fn(),
  };
}

describe('LineItemsTable — Optional marker (#2053 AC11 / #2088)', () => {
  it('an optional row shows the marker + an unchecked Include checkbox; a non-optional row shows nothing, and no Selected switch exists anywhere', () => {
    const lines = [
      line({ id: 'l1', description: 'Base line', is_optional: false, is_selected: true }),
      line({ id: 'l2', description: 'Add-on', is_optional: true, is_selected: false }),
    ];
    render(<LineItemsTable {...baseProps(lines)} showOptionalToggle />);

    expect(screen.getAllByText('Optional')).toHaveLength(1);
    expect(screen.queryByRole('switch', { name: /selected/i })).not.toBeInTheDocument();
    const includeCheckbox = screen.getByRole('checkbox', { name: 'Include Add-on' });
    expect(includeCheckbox).not.toBeChecked();
  });

  it('the row checkbox fires onUpdate with just is_selected', async () => {
    const lines = [line({ id: 'l2', description: 'Add-on', is_optional: true, is_selected: false })];
    const props = baseProps(lines);
    render(<LineItemsTable {...props} showOptionalToggle />);

    await userEvent.click(screen.getByRole('checkbox', { name: 'Include Add-on' }));
    expect(props.onUpdate).toHaveBeenCalledWith('l2', { is_selected: true });
  });

  it('no marker and no checkbox render anywhere when the prop is omitted (Job/Invoice)', () => {
    const lines = [line({ id: 'l2', description: 'Add-on', is_optional: true, is_selected: false })];
    render(<LineItemsTable {...baseProps(lines)} />);

    expect(screen.queryByText('Optional')).not.toBeInTheDocument();
    expect(screen.queryByRole('checkbox', { name: /include /i })).not.toBeInTheDocument();
  });
});
