import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { InvoiceReceiptCard, type InvoiceReceiptCardInvoice } from '@/components/invoices/InvoiceReceiptCard';

// subtotal 1000, with 200 of it non-taxable → taxable base 800, 8% tax → $64 tax. Deliberately
// distinct from subtotal so a test asserting on one figure can't accidentally match the other.
function invoice(overrides: Partial<InvoiceReceiptCardInvoice> = {}): InvoiceReceiptCardInvoice {
  return {
    subtotal: 1000,
    discount_amount: 0,
    tax_rate: 0.08,
    tax_amount: 64,
    tip: 0,
    total_amount: 1064,
    deposit_credit: 0,
    amount_due: 1064,
    ...overrides,
  };
}

describe('InvoiceReceiptCard', () => {
  it('renders Subtotal, the v12 Tax rate/Tax row split, and Total from the server-computed invoice fields', () => {
    render(<InvoiceReceiptCard invoice={invoice()} />);

    expect(screen.getByText('Subtotal')).toBeInTheDocument();
    expect(screen.getByText('$1,000.00')).toBeInTheDocument();
    expect(screen.getByText('Tax rate')).toBeInTheDocument();
    expect(screen.getByText('8%')).toBeInTheDocument();
    expect(screen.getByText('Tax')).toBeInTheDocument();
    expect(screen.getByText('$64.00')).toBeInTheDocument();
    expect(screen.getByText('Total')).toBeInTheDocument();
    // Total ($1,064.00) and Balance due ($1,064.00) both render this figure.
    expect(screen.getAllByText('$1,064.00')).toHaveLength(2);
  });

  it('back-derives the Taxable base from tax_amount / tax_rate and shows it muted', () => {
    // 800 taxable out of 1000 subtotal (200 non-taxable), 10% tax → $80 tax.
    render(
      <InvoiceReceiptCard
        invoice={invoice({ subtotal: 1000, tax_rate: 0.1, tax_amount: 80, total_amount: 1080, amount_due: 1080 })}
      />,
    );

    expect(screen.getByText('Taxable')).toBeInTheDocument();
    expect(screen.getByText('$800.00')).toBeInTheDocument();
  });

  it('hides the Taxable row but still shows Tax rate/Tax (muted, 0%/$0) when tax_rate is 0 (no tax)', () => {
    render(<InvoiceReceiptCard invoice={invoice({ tax_rate: 0, tax_amount: 0, total_amount: 1000, amount_due: 1000 })} />);

    expect(screen.queryByText('Taxable')).not.toBeInTheDocument();
    expect(screen.getByText('Tax rate')).toBeInTheDocument();
    expect(screen.getByText('0%')).toBeInTheDocument();
    expect(screen.getByText('Tax')).toBeInTheDocument();
  });

  // job-items-estimate-parity: Discount is part of the money breakdown SPINE that Estimate / Job /
  // Invoice must render identically, so it now shows whenever the surface supplies a figure - 
  // including $0 - rather than only when non-zero or editable. (Previously a read-only invoice hid
  // it at $0 while an editable estimate showed it, so the same money read differently by surface.)
  // Tip and Deposit credit are NOT spine rows - they are invoice-only concepts with no estimate or
  // job counterpart - so they keep hiding at zero.
  it('shows the Discount row at $0 (spine parity) but still hides Tip and Deposit credit', () => {
    render(<InvoiceReceiptCard invoice={invoice()} />);

    expect(screen.getByText('Discount')).toBeInTheDocument();
    expect(screen.queryByText('Tip')).not.toBeInTheDocument();
    expect(screen.queryByText('Deposit credit')).not.toBeInTheDocument();
  });

  it('shows Discount, Tip, and Deposit credit rows (signed) when each is present', () => {
    render(
      <InvoiceReceiptCard
        invoice={invoice({ discount_amount: 50, tip: 20, deposit_credit: 100, total_amount: 1050, amount_due: 950 })}
      />,
    );

    expect(screen.getByText('Discount')).toBeInTheDocument();
    expect(screen.getByText('-$50.00')).toBeInTheDocument();
    expect(screen.getByText('Tip')).toBeInTheDocument();
    expect(screen.getByText('$20.00')).toBeInTheDocument();
    expect(screen.getByText('Deposit credit')).toBeInTheDocument();
    expect(screen.getByText('-$100.00')).toBeInTheDocument();
  });

  it('renders Balance due from amount_due, distinct from Total when a deposit credit applies', () => {
    render(
      <InvoiceReceiptCard
        invoice={invoice({ deposit_credit: 300, total_amount: 1080, amount_due: 780 })}
      />,
    );

    expect(screen.getByText('Balance due')).toBeInTheDocument();
    expect(screen.getByTestId('invoice-receipt-balance-due')).toHaveTextContent('$780.00');
  });

  it('colors Balance due with the danger token when overdue', () => {
    render(<InvoiceReceiptCard invoice={invoice()} overdue />);

    expect(screen.getByTestId('invoice-receipt-balance-due')).toHaveClass('text-danger');
  });

  it('colors Balance due with the sage success token when fully paid (amount_due === 0)', () => {
    render(<InvoiceReceiptCard invoice={invoice({ amount_due: 0, total_amount: 1080 })} />);

    expect(screen.getByTestId('invoice-receipt-balance-due')).toHaveClass('text-sage-700');
  });

  it('renders a 100% collected progress caption when amount_due is 0', () => {
    render(<InvoiceReceiptCard invoice={invoice({ amount_due: 0, total_amount: 1080 })} />);

    expect(screen.getByText('100% collected')).toBeInTheDocument();
  });

  it('renders a 0% collected progress caption on a brand-new, unpaid invoice', () => {
    render(<InvoiceReceiptCard invoice={invoice({ amount_due: 1080, total_amount: 1080 })} />);

    expect(screen.getByText('0% collected')).toBeInTheDocument();
  });

  it('derives the Line items / Scope of work breakdown rows when line_items/scopes are supplied', () => {
    render(
      <InvoiceReceiptCard
        invoice={invoice({
          line_items: [
            {
              id: 'l1',
              sequence: 1,
              description: 'Line',
              quantity: 1,
              unit_price: 700,
              unit_cost: null,
              is_taxable: true,
              line_total: 700,
              discount_type: null,
              discount_value: null,
              discount_amount: 0,
              item_type: 'SERVICE',
              price_book_item_id: null,
            },
          ],
          scopes: [{ id: 's1', title: 'Scope', body: '', flat_price: 300, is_taxable: true, internal_cost: null }],
        })}
      />,
    );

    expect(screen.getByText('Line items')).toBeInTheDocument();
    expect(screen.getByText('$700.00')).toBeInTheDocument();
    expect(screen.getByText('Scope of work')).toBeInTheDocument();
    expect(screen.getByText('$300.00')).toBeInTheDocument();
  });

  it('skips the Line items / Scope of work breakdown rows when line_items/scopes are omitted', () => {
    render(<InvoiceReceiptCard invoice={invoice()} />);

    expect(screen.queryByText('Line items')).not.toBeInTheDocument();
    expect(screen.queryByText('Scope of work')).not.toBeInTheDocument();
  });

  it('stays read-only (no editable Discount/Tip inputs) when no editing handlers are passed — current InvoiceDetailPage wiring', () => {
    render(<InvoiceReceiptCard invoice={invoice({ discount_amount: 50, tip: 20 })} />);

    expect(screen.queryByLabelText('Discount amount')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Tip amount')).not.toBeInTheDocument();
  });

  it('renders an editable Discount input and forwards its committed value when onDiscountChange is passed', async () => {
    const user = userEvent.setup();
    const onDiscountChange = vi.fn();
    render(<InvoiceReceiptCard invoice={invoice()} onDiscountChange={onDiscountChange} />);

    const input = screen.getByLabelText('Discount amount');
    await user.clear(input);
    await user.type(input, '25');
    await user.tab();

    expect(onDiscountChange).toHaveBeenCalledWith(25);
  });

  // ─── Reversal-aware progress + rows (#843) ────────────────────────────────
  describe('reversal-aware progress bar and rows', () => {
    it('bases "% collected" on settledTotal, NOT (total - amount_due)', () => {
      // A $1,000 invoice paid in full then refunded $400. The backend deliberately never reopens
      // amount_due on a refund, so the legacy (total − amount_due)/total reading says 100%
      // collected at $0.00 balance due. settledTotal=600 → 60%.
      render(
        <InvoiceReceiptCard
          invoice={invoice({ subtotal: 1000, tax_rate: 0, tax_amount: 0, total_amount: 1000, amount_due: 0 })}
          refundedTotal={400}
          settledTotal={600}
        />,
      );

      expect(screen.getByText('60% collected')).toBeInTheDocument();
      expect(screen.queryByText('100% collected')).not.toBeInTheDocument();
    });

    it('shows a signed "Refunded" row when refundedTotal > 0', () => {
      render(
        <InvoiceReceiptCard
          invoice={invoice({ total_amount: 1000, amount_due: 0 })}
          refundedTotal={400}
          settledTotal={600}
        />,
      );

      expect(screen.getByText('Refunded')).toBeInTheDocument();
      expect(screen.getByText('-$400.00')).toBeInTheDocument();
    });

    it('shows a signed "Credited" row when creditedTotal > 0', () => {
      render(
        <InvoiceReceiptCard
          invoice={invoice({ total_amount: 1000, amount_due: 0 })}
          creditedTotal={75}
          settledTotal={1000}
        />,
      );

      expect(screen.getByText('Credited')).toBeInTheDocument();
      expect(screen.getByText('-$75.00')).toBeInTheDocument();
    });

    it('shows an "Overpaid" row when overpaidAmount > 0, and caps the bar at 100%', () => {
      // amount_due 200 is deliberate: the legacy (total − amount_due)/total path would read 80%
      // here, so only the settledTotal path (clamped) yields 100% - the assertion goes red if the
      // source reverts to the amount_due-based reading.
      render(
        <InvoiceReceiptCard
          invoice={invoice({ total_amount: 1000, amount_due: 200 })}
          settledTotal={1200}
          overpaidAmount={200}
        />,
      );

      expect(screen.getByText('Overpaid')).toBeInTheDocument();
      expect(screen.getByText('+$200.00')).toBeInTheDocument();
      expect(screen.getByText('100% collected')).toBeInTheDocument();
      expect(screen.queryByText('80% collected')).not.toBeInTheDocument();
    });

    it('clamps the bar at 0% rather than going negative when net cash is negative', () => {
      render(
        <InvoiceReceiptCard invoice={invoice({ total_amount: 1000, amount_due: 0 })} settledTotal={-50} />,
      );

      expect(screen.getByText('0% collected')).toBeInTheDocument();
    });

    it('hides Refunded / Credited / Overpaid entirely when their amounts are 0', () => {
      render(<InvoiceReceiptCard invoice={invoice()} refundedTotal={0} creditedTotal={0} overpaidAmount={0} />);

      expect(screen.queryByText('Refunded')).not.toBeInTheDocument();
      expect(screen.queryByText('Credited')).not.toBeInTheDocument();
      expect(screen.queryByText('Overpaid')).not.toBeInTheDocument();
    });

    it('keeps the legacy amount_due reading when settledTotal is omitted (no behavior change)', () => {
      // 750 of a 1000 invoice collected → 75%, the pre-#843 reading, unchanged for any caller that
      // does not supply the new prop.
      render(
        <InvoiceReceiptCard
          invoice={invoice({ subtotal: 1000, tax_rate: 0, tax_amount: 0, total_amount: 1000, amount_due: 250 })}
        />,
      );

      expect(screen.getByText('75% collected')).toBeInTheDocument();
    });
  });
});
