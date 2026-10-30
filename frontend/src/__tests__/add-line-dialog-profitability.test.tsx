/**
 * The line dialog's live total bar (PRD #2186, slice 09).
 *
 * `AddLineDialog` is the shared add/edit form behind the Estimate, Job and
 * Invoice line tables. Its total bar used to compute margin inline and drop the
 * figure off screen entirely when there was nothing to divide by. It now reads
 * the shared calculator and shows margin and markup side by side under their
 * full words, with an em dash where there is no figure.
 *
 * The Markup % READOUT is the stored field echoed back, not a re-derivation -
 * "Markup is stored on the line, not re-derived" (#2012 R2/R3) - so only its
 * spelling comes from the shared formatter.
 */
import { describe, it, expect, vi } from 'vitest';
import { screen, within } from '@testing-library/react';
import { renderWithProviders } from './helpers';
import { AddLineDialog } from '@/components/jobs/items/AddLineDialog';
import type { InvoiceLineItem } from '@/lib/api/jobs';

vi.mock('@/components/ui/use-toast', () => ({ toast: vi.fn() }));
vi.mock('@/lib/api/invoices', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api/invoices')>('@/lib/api/invoices');
  return {
    ...actual,
    searchPriceBookItems: vi.fn().mockResolvedValue([]),
    listPriceBookItems: vi.fn().mockResolvedValue([]),
  };
});

const BASE_LINE: InvoiceLineItem = {
  id: 'line-2186',
  sequence: 1,
  description: 'Compressor swap',
  quantity: 1,
  unit_price: 150,
  unit_cost: null,
  markup_percent: null,
  is_taxable: true,
  line_total: 150,
  discount_type: null,
  discount_value: null,
  discount_amount: 0,
  item_type: 'SERVICE',
  price_book_item_id: null,
};

function renderEdit(line: Partial<InvoiceLineItem>, { canSeePricing = true } = {}) {
  renderWithProviders(
    <AddLineDialog
      open
      onOpenChange={() => {}}
      onAdd={vi.fn()}
      editingLine={{ ...BASE_LINE, ...line }}
      canSeePricing={canSeePricing}
    />,
  );
}

function figureUnder(word: string) {
  const pair = screen.getByRole('group', { name: /profitability/i });
  return within(pair).getByText(word).parentElement?.querySelector('dd')?.textContent ?? '';
}

describe('AddLineDialog total bar — margin and markup', () => {
  it('shows margin and markup side by side under their full words', () => {
    renderEdit({ unit_cost: 90, unit_price: 150 });

    // margin (150-90)/150 = 40%; the Markup % field derives to 66.67 -> 67%.
    expect(figureUnder('Margin')).toBe('40%');
    expect(figureUnder('Markup')).toBe('67%');
  });

  it('shows an em dash, never 100%, when no cost was ever entered', () => {
    renderEdit({ unit_cost: null, unit_price: 150 });

    expect(figureUnder('Margin')).toBe('—');
    expect(figureUnder('Markup')).toBe('—');
    const pair = screen.getByRole('group', { name: /profitability/i });
    expect(within(pair).queryByText('100%')).not.toBeInTheDocument();
  });

  it('prints no implementation footnote under the total bar', () => {
    renderEdit({ unit_cost: 90, unit_price: 150 });
    expect(screen.getByRole('group', { name: /profitability/i })).toBeInTheDocument();
    expect(screen.queryByText(/not re-derived/i)).not.toBeInTheDocument();
  });

  it('shows nothing at all to a viewer without pricing access', () => {
    renderEdit({ unit_cost: 90, unit_price: 150 }, { canSeePricing: false });

    expect(screen.queryByRole('group', { name: /profitability/i })).not.toBeInTheDocument();
    expect(screen.queryByText('Margin')).not.toBeInTheDocument();
    expect(screen.queryByText('Markup')).not.toBeInTheDocument();
  });
});
