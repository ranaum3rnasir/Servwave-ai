/**
 * The estimate/job/invoice money rail's profitability (PRD #2186, slice 09).
 *
 * The rail's Profit row used to carry a bare parenthetical percentage computed
 * inside the cost model — a margin under another name, with no markup beside it
 * and its own rounding. The percentage pair now comes from the shared
 * calculator, side by side under their full words, with an em dash where there
 * is no figure and no cap on either.
 */
import { describe, it, expect } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { InternalCostsCard } from '@/components/crm/InternalCostsCard';
import type { InvoiceLineItem, Scope } from '@/lib/api/jobs';

function line(unitCost: number | null): InvoiceLineItem {
  return {
    id: 'line-1',
    sequence: 1,
    description: 'Panel',
    quantity: 2,
    unit_price: 500,
    unit_cost: unitCost,
    markup_percent: null,
    is_taxable: true,
    line_total: 1000,
    discount_type: null,
    discount_value: null,
    discount_amount: 0,
    item_type: 'MATERIAL',
    price_book_item_id: null,
  };
}

const SCOPES: Scope[] = [];

function renderCard(unitCost: number | null, discountedSubtotal = 1000) {
  render(
    <InternalCostsCard
      lineItems={[line(unitCost)]}
      scopes={SCOPES}
      discountedSubtotal={discountedSubtotal}
      orgLaborRate={0}
      orgOverheadMode="PERCENTAGE"
      orgOverheadValue={0}
      canEditNow={false}
      onCommitLaborHours={() => {}}
      onCommitOverhead={() => {}}
    />,
  );
}

function figureUnder(word: string) {
  const pair = screen.getByRole('group', { name: /profitability/i });
  return within(pair).getByText(word).parentElement?.querySelector('dd')?.textContent ?? '';
}

describe('InternalCostsCard — margin and markup on the money rail', () => {
  it('shows margin and markup side by side under their full words', () => {
    // 2 x $200 cost against $1,000 revenue: margin 600/1000 = 60%, markup 600/400 = 150%.
    renderCard(200);

    expect(figureUnder('Margin')).toBe('60%');
    expect(figureUnder('Markup')).toBe('150%');
  });

  it('never abbreviates the words and never says GM', () => {
    renderCard(200);
    expect(screen.queryByText(/\bGM\b/)).not.toBeInTheDocument();
  });

  it('shows an em dash rather than a percentage when there is no revenue to divide by', () => {
    renderCard(200, 0);

    expect(figureUnder('Margin')).toBe('—');
    expect(figureUnder('Markup')).toBe('—');
  });
});
