/**
 * repro-2088.test.tsx — #2088 (slice 1b of #2053's PRD): replace the "Selected" switch with a row
 * checkbox + Included/Not included/Declined caption, and gain a receipt-card summary line.
 * FROZEN per bfd-reproduce Pass B — do not edit to make these pass; fix the production code
 * instead.
 *
 * Section 2 carries ONE amendment, dated 2026-09-18 and explained at the describe itself: the
 * product owner reversed the "state it twice" half of #2088. Everything else here is untouched.
 *
 * Verified on base (89312f4ab):
 *   - AddLineDialog.tsx renders a `Switch` with `aria-label="Selected for new line"` /
 *     "Selected for this line" once Optional is on (frontend/src/components/jobs/items/
 *     AddLineDialog.tsx:886-893, 1133-1142) — the issue's "the Selected switch is removed
 *     everywhere ... AddLineDialog" is not yet true.
 *   - LineItemRow.tsx renders a `Switch` with `aria-label={`Selected for ${name}`}` on an
 *     optional, editable row (frontend/src/components/jobs/items/LineItemRow.tsx:309-326) — no
 *     leading checkbox, no "Included"/"Not included" caption exist anywhere in that file (`grep -n
 *     "Included\|role=\"checkbox\"" LineItemRow.tsx` finds nothing).
 *   - EstimateReceiptCard.tsx / ReceiptCard.tsx contain no "optional add-on" copy at all (`grep -n
 *     "optional add-on\|add-ons included" EstimateReceiptCard.tsx ReceiptCard.tsx` finds nothing)
 *     — the AC4 "N of M optional add-ons included" line does not exist.
 *
 * Render patterns mirror the neighbouring suites: LineItemRow via LineItemRow.test.tsx's
 * DndContext/SortableContext + renderWithProviders wrapper (LineItemRow calls useQueryClient
 * unconditionally through useLineImageUpload, so plain `render` throws "No QueryClient set"
 * regardless of the fixture — a harness requirement, not a red flag under test), AddLineDialog via
 * add-line-dialog-optional-toggle.test.tsx's plain `render`, and EstimateReceiptCard via
 * estimate-receipt-card.test.tsx (renderWithProviders + the same api mocks).
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { DndContext } from '@dnd-kit/core';
import { SortableContext } from '@dnd-kit/sortable';
import { renderWithProviders } from './helpers';
import { LineItemRow } from '@/components/jobs/items/LineItemRow';
import { AddLineDialog } from '@/components/jobs/items/AddLineDialog';
import { EstimateReceiptCard, type EstimateReceiptCardEstimate } from '@/components/estimates/EstimateReceiptCard';
import type { InvoiceLineItem } from '@/lib/api/jobs';

vi.mock('@/lib/api/invoices', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api/invoices')>('@/lib/api/invoices');
  return {
    ...actual,
    searchPriceBookItems: vi.fn().mockResolvedValue([]),
    listPriceBookItems: vi.fn().mockResolvedValue([]),
    fetchStateTaxRates: vi.fn().mockResolvedValue([]),
  };
});

vi.mock('@/lib/api/estimates', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api/estimates')>('@/lib/api/estimates');
  return {
    ...actual,
    updateEstimate: vi.fn().mockResolvedValue({}),
  };
});

// ════════════════════════════════════════════════════════════════════════════
// 1 — no "Selected" control anywhere in the editor DOM
// ════════════════════════════════════════════════════════════════════════════
describe('#2088: the "Selected" switch is gone from the editor', () => {
  it('AddLineDialog (showOptionalToggle, Optional on) renders no switch named /selected/i', async () => {
    const user = userEvent.setup();
    render(
      <AddLineDialog
        open
        onOpenChange={vi.fn()}
        onAdd={vi.fn()}
        onUpdate={vi.fn()}
        initialQuery="New line"
        showOptionalToggle
      />,
    );
    await user.click(screen.getByRole('switch', { name: /optional for new line/i }));
    expect(screen.queryByRole('switch', { name: /selected/i })).not.toBeInTheDocument();
  });

  it('LineItemRow (showOptionalToggle, optional + editable row) renders no switch named /selected/i', () => {
    renderOptionalRow({ is_optional: true, is_selected: true, canEdit: true });
    expect(screen.queryByRole('switch', { name: /selected/i })).not.toBeInTheDocument();
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 2 — an optional row's checkbox + caption + price + tag; a non-optional row has none of it
// ════════════════════════════════════════════════════════════════════════════
const OPTIONAL_LINE: InvoiceLineItem = {
  id: 'line-2088-optional',
  sequence: 1,
  description: 'Smart thermostat upgrade',
  quantity: 1,
  unit_price: 250,
  unit_cost: null,
  markup_percent: null,
  is_taxable: true,
  line_total: 250,
  discount_type: null,
  discount_value: null,
  discount_amount: 0,
  item_type: 'SERVICE',
  price_book_item_id: null,
  is_optional: true,
  is_selected: true,
};

function renderOptionalRow(over: Partial<InvoiceLineItem> & { canEdit?: boolean } = {}) {
  const { canEdit = true, ...lineOver } = over;
  const line: InvoiceLineItem = { ...OPTIONAL_LINE, ...lineOver };
  renderWithProviders(
    <DndContext>
      <table>
        <tbody>
          <SortableContext items={[line.id]}>
            <LineItemRow
              line={line}
              canEdit={canEdit}
              canManage={canEdit}
              canSeePricing
              onUpdate={vi.fn()}
              onDelete={vi.fn()}
              onEdit={vi.fn()}
              showOptionalToggle
            />
          </SortableContext>
        </tbody>
      </table>
    </DndContext>,
  );
  return line;
}

// FROZEN-TEST AMENDMENT, 2026-09-18 (revision decision 3). The two assertions below used to
// require an optional row to state its state TWICE before the customer had answered: an
// "Optional" tag beside the item name AND an "Included"/"Not included" caption under the amount.
// The product owner has since ruled that the editor says nothing about a row until the customer
// answers, and then says it once. That is a direct contradiction of what #2088 froze, so the two
// cases are INVERTED here rather than deleted, and the row's two live parts that #2088 actually
// bought - the checkbox and the price - are asserted exactly as before. What #2088 guarded
// against (a rep-vocabulary "Selected" switch, section 1 above; a read-only twin that disagreed
// with the editable row) is untouched and still enforced. The full new rule lives in
// estimate-optional-row-one-tag.test.tsx.
describe('#2088: optional-row checkbox + tag', () => {
  it('an optional, selected row renders a checkbox named "Include <description>", the price, and ONE tag, which before the customer answers reads "Optional"', () => {
    renderOptionalRow({ is_optional: true, is_selected: true });

    expect(screen.getByRole('checkbox', { name: 'Include Smart thermostat upgrade' })).toBeInTheDocument();
    expect(screen.getByText('Optional')).toBeInTheDocument();
    expect(screen.getByText('$250.00')).toBeInTheDocument();
    expect(screen.queryByText('Included')).not.toBeInTheDocument();
  });

  it('an optional, unselected row shows the checkbox unchecked, and still no second readout under the amount', () => {
    renderOptionalRow({ is_optional: true, is_selected: false });

    const box = screen.getByRole('checkbox', { name: 'Include Smart thermostat upgrade' });
    expect(box).not.toBeChecked();
    expect(screen.getByText('Optional')).toBeInTheDocument();
    expect(screen.queryByText('Not included')).not.toBeInTheDocument();
  });

  it('a non-optional row renders neither the checkbox nor any tag', () => {
    renderOptionalRow({ is_optional: false, is_selected: true });

    expect(screen.queryByRole('checkbox', { name: /include /i })).not.toBeInTheDocument();
    expect(screen.queryByText('Included')).not.toBeInTheDocument();
    expect(screen.queryByText('Not included')).not.toBeInTheDocument();
    expect(screen.queryByText('Optional')).not.toBeInTheDocument();
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 3 — the receipt card's "N of M optional add-ons included" line
// ════════════════════════════════════════════════════════════════════════════
function estimate(overrides: Partial<EstimateReceiptCardEstimate> = {}): EstimateReceiptCardEstimate {
  return {
    id: 'est-2088',
    subtotal: 1000,
    discount_amount: 0,
    discount_type: null,
    discount_value: null,
    discount_name: null,
    tax_rate: 0,
    tax_amount: 0,
    total_amount: 1000,
    deposit_type: null,
    deposit_value: null,
    send_config: null,
    line_items: [],
    scopes: [],
    ...overrides,
  };
}

describe('#2088: receipt card "N of M optional add-ons included"', () => {
  it('shows "1 of 2 optional add-ons included" with no currency figure when one of two optional lines is selected', () => {
    renderWithProviders(
      <EstimateReceiptCard
        estimate={estimate({
          line_items: [
            { id: 'l1', description: 'Base unit', quantity: 1, unit_price: 500, line_total: 500, is_taxable: true, is_optional: false, is_selected: true },
            { id: 'l2', description: 'Extended warranty', quantity: 1, unit_price: 100, line_total: 100, is_taxable: true, is_optional: true, is_selected: true },
            { id: 'l3', description: 'Premium filter', quantity: 1, unit_price: 50, line_total: 50, is_taxable: true, is_optional: true, is_selected: false },
          ] as EstimateReceiptCardEstimate['line_items'],
        })}
        canEditNow
      />,
    );

    expect(screen.getByText('1 of 2 optional add-ons included')).toBeInTheDocument();
    expect(screen.queryByText(/\$.*optional add-ons/i)).not.toBeInTheDocument();
  });

  it('is absent when there are no optional lines/scopes (M = 0)', () => {
    renderWithProviders(
      <EstimateReceiptCard
        estimate={estimate({
          line_items: [
            { id: 'l1', description: 'Base unit', quantity: 1, unit_price: 500, line_total: 500, is_taxable: true, is_optional: false, is_selected: true },
          ] as EstimateReceiptCardEstimate['line_items'],
        })}
        canEditNow
      />,
    );

    expect(screen.queryByText(/optional add-ons included/i)).not.toBeInTheDocument();
  });
});
