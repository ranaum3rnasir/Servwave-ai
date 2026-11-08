// Inventory P2 §7 (D15) — the shared InternalCostsCard's "Materials purchased (POs)" actuals
// row. The D15 regression lock: the prop is an ADDITIVE DISPLAY ROW and must never move the
// Profit/Total-cost numbers computed from the cost model (calculateCostSummary).
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { InternalCostsCard } from '@/components/crm/InternalCostsCard';
import type { InvoiceLineItem, Scope } from '@/lib/api/jobs';

const LINES: InvoiceLineItem[] = [
  {
    id: 'line-1',
    sequence: 1,
    description: 'Panel',
    quantity: 2,
    unit_price: 500,
    unit_cost: 200,
    markup_percent: null,
    is_taxable: true,
    line_total: 1000,
    discount_type: null,
    discount_value: null,
    discount_amount: 0,
    item_type: 'MATERIAL',
    price_book_item_id: null,
  },
  {
    id: 'line-2',
    sequence: 2,
    description: 'Install labor',
    quantity: 3,
    unit_price: 100,
    unit_cost: 40,
    markup_percent: null,
    is_taxable: true,
    line_total: 300,
    discount_type: null,
    discount_value: null,
    discount_amount: 0,
    item_type: 'SERVICE',
    price_book_item_id: null,
  },
];
const SCOPES: Scope[] = [];

const baseProps = {
  lineItems: LINES,
  scopes: SCOPES,
  discountedSubtotal: 1300,
  orgLaborRate: 0,
  orgOverheadMode: 'PERCENTAGE' as const,
  orgOverheadValue: 0,
  canEditNow: false,
  onCommitLaborHours: () => {},
  onCommitOverhead: () => {},
};

function totalAndProfit(container: HTMLElement) {
  const rows = Array.from(container.querySelectorAll('div,p')).map((el) => el.textContent);
  const total = rows.find((t) => t?.startsWith('Total cost'));
  const profit = rows.find((t) => t?.startsWith('Profit'));
  return { total, profit };
}

describe('InternalCostsCard — Materials purchased (POs) actuals row (D15)', () => {
  it('renders the row, count line, and tooltip copy when the prop is set', async () => {
    render(
      <InternalCostsCard
        {...baseProps}
        materialsPurchased={{ amount: 1234.56, lineCount: 3 }}
      />,
    );

    expect(screen.getByText('Materials purchased (POs)')).toBeInTheDocument();
    expect(screen.getByText('$1,234.56')).toBeInTheDocument();
    expect(screen.getByText(/3 received PO lines · actuals, not in profit/)).toBeInTheDocument();

    // Tooltip copy — radix opens on keyboard (visible) focus of the trigger; the info icon is
    // the only focusable stop with canEditNow: false (no labor-hours/overhead inputs rendered).
    await userEvent.tab();
    expect(screen.getByLabelText('About materials purchased')).toHaveFocus();
    // findAll — radix renders the content plus a visually-hidden a11y duplicate.
    const copies = await screen.findAllByText(/not PO actuals/i, undefined, {
      timeout: 3000,
    });
    expect(copies.length).toBeGreaterThan(0);
  });

  it('D15 regression lock: Total cost and Profit are IDENTICAL with and without the prop', () => {
    const withProp = render(
      <InternalCostsCard
        {...baseProps}
        materialsPurchased={{ amount: 99999, lineCount: 7 }}
      />,
    );
    const withValues = totalAndProfit(withProp.container);
    withProp.unmount();

    const withoutProp = render(
      <InternalCostsCard {...baseProps} materialsPurchased={null} />,
    );
    const withoutValues = totalAndProfit(withoutProp.container);

    expect(withValues.total).toBeTruthy();
    expect(withValues.profit).toBeTruthy();
    expect(withValues.total).toEqual(withoutValues.total);
    expect(withValues.profit).toEqual(withoutValues.profit);
  });

  it('renders a zero-amount row when lineCount > 0 (a received-at-$0 PO is information)', () => {
    render(
      <InternalCostsCard
        {...baseProps}
        materialsPurchased={{ amount: 0, lineCount: 2 }}
      />,
    );
    expect(screen.getByText('Materials purchased (POs)')).toBeInTheDocument();
    expect(screen.getByText(/2 received PO lines/)).toBeInTheDocument();
  });

  it('renders nothing for a null prop', () => {
    render(<InternalCostsCard {...baseProps} materialsPurchased={null} />);
    expect(screen.queryByText('Materials purchased (POs)')).not.toBeInTheDocument();
  });

  it('renders nothing when the prop is omitted entirely (Estimate/Invoice callers)', () => {
    render(<InternalCostsCard {...baseProps} />);
    expect(screen.queryByText('Materials purchased (POs)')).not.toBeInTheDocument();
  });
});
