/**
 * ReceiptCard — the shared Card A "Totals" primitive (v12 unified line-items, plan §3). Covers
 * what `InvoiceReceiptCard`'s own test suite can't reach directly: the Estimate/Job variants (no
 * per-surface wrapper exists yet — those land in a later wiring wave), the breakdown-row
 * omit/include behavior, and the "a control is interactive iff its handler prop is provided" rule
 * for the Tax-rate select and the Estimate deposit-% select.
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ReceiptCard } from '@/components/jobs/items/ReceiptCard';

describe('ReceiptCard — common rows', () => {
  it('skips Line items / Scope of work rows when omitted, and skips the Subtotal bold divider', () => {
    render(<ReceiptCard variant="job" subtotal={500} total={500} />);

    expect(screen.queryByText('Line items')).not.toBeInTheDocument();
    expect(screen.queryByText('Scope of work')).not.toBeInTheDocument();
    expect(screen.getByText('Subtotal')).toBeInTheDocument();
  });

  it('renders Line items / Scope of work rows when both are supplied', () => {
    render(<ReceiptCard variant="job" lineItemsSubtotal={400} scopeSubtotal={100} subtotal={500} total={500} />);

    expect(screen.getByText('Line items')).toBeInTheDocument();
    expect(screen.getByText('$400.00')).toBeInTheDocument();
    expect(screen.getByText('Scope of work')).toBeInTheDocument();
    expect(screen.getByText('$100.00')).toBeInTheDocument();
  });

  it('omits all tax rows when taxRate is not passed at all', () => {
    render(<ReceiptCard variant="job" subtotal={500} total={500} />);

    expect(screen.queryByText('Taxable')).not.toBeInTheDocument();
    expect(screen.queryByText('Tax rate')).not.toBeInTheDocument();
    expect(screen.queryByText('Tax')).not.toBeInTheDocument();
  });
});

describe('ReceiptCard — job variant', () => {
  // The hero was "Job subtotal" while the job's figure was an untaxed running tally.
  // job-items-estimate-parity D1/D2 made it tax-inclusive and discount-applied, so it names a
  // real total now - and matching Estimate/Invoice is the point (see the parity suite below).
  it('labels the hero row "Total" with no tip/deposit/balance rows', () => {
    render(<ReceiptCard variant="job" subtotal={500} total={500} />);

    expect(screen.getByText('Total')).toBeInTheDocument();
    expect(screen.queryByText('Job subtotal')).not.toBeInTheDocument();
    expect(screen.queryByText('Tip')).not.toBeInTheDocument();
    expect(screen.queryByText('Balance due')).not.toBeInTheDocument();
    expect(screen.queryByText('Deposit due now')).not.toBeInTheDocument();
  });
});

/**
 * job-items-estimate-parity: Estimate, Job and Invoice must render the SAME money breakdown for
 * the same inputs - whatever a user reads in the estimate's totals, they read the same rows on the
 * job's Items tab and on the invoice. Each variant still ADDS its own rows on top (estimate: the
 * deposit box; invoice: tip / deposit credit / balance due), but the shared spine cannot diverge.
 */
describe('ReceiptCard - breakdown parity across variants', () => {
  const SHARED = {
    lineItemsSubtotal: 1000,
    scopeSubtotal: 0,
    subtotal: 1000,
    discountAmount: 100,
    taxRate: 0.0625,
    taxAmount: 56.25,
    total: 956.25,
  } as const;

  const SPINE = ['Line items', 'Scope of work', 'Subtotal', 'Discount', 'Taxable', 'Tax rate', 'Tax', 'Total'];

  it.each(['estimate', 'job', 'invoice'] as const)('renders the full breakdown spine on the %s variant', (variant) => {
    render(<ReceiptCard variant={variant} {...SHARED} />);

    for (const row of SPINE) {
      expect(screen.getByText(row)).toBeInTheDocument();
    }
  });

  it.each(['estimate', 'job', 'invoice'] as const)(
    'shows the Discount row on the %s variant even at $0, so a zero-discount job still lines up with its estimate',
    (variant) => {
      render(<ReceiptCard variant={variant} {...SHARED} discountAmount={0} />);

      expect(screen.getByText('Discount')).toBeInTheDocument();
    },
  );

  it('still skips the Discount row entirely when no discount figure is supplied at all', () => {
    render(<ReceiptCard variant="job" subtotal={500} total={500} />);

    expect(screen.queryByText('Discount')).not.toBeInTheDocument();
  });

  // Several states share a rate (IL/MA/TX are all 6.25%), so a bare percent does not say what is
  // actually being charged. The editable surfaces name the state in their select; a read-only one
  // (the Job, whose rate is derived) must name it too rather than degrading to a bare number.
  const NJ = [{ state_code: 'NJ', state_name: 'New Jersey', tax_rate: 0.06625 }] as const;

  it('names the jurisdiction on a READ-ONLY tax row when taxRates are supplied', () => {
    render(
      <ReceiptCard
        variant="job"
        subtotal={200}
        total={213.25}
        taxRate={0.06625}
        taxAmount={13.25}
        taxRates={NJ as never}
        taxStateCode="NJ"
      />,
    );

    expect(screen.getByText('New Jersey (6.625%)')).toBeInTheDocument();
  });

  it('falls back to a bare percent when no taxRates are supplied to match against', () => {
    render(<ReceiptCard variant="job" subtotal={200} total={213.25} taxRate={0.06625} taxAmount={13.25} />);

    expect(screen.getByText('6.625%')).toBeInTheDocument();
  });
});

describe('ReceiptCard — estimate variant', () => {
  it('labels the hero row "Total" with a "Customer pays" caption', () => {
    render(<ReceiptCard variant="estimate" subtotal={500} total={500} />);

    expect(screen.getByText('Total')).toBeInTheDocument();
    expect(screen.getByText('Customer pays')).toBeInTheDocument();
  });

  it('does not render the deposit box when depositDuePercent is omitted (no fake selector)', () => {
    render(<ReceiptCard variant="estimate" subtotal={500} total={500} />);

    expect(screen.queryByText('Deposit due now')).not.toBeInTheDocument();
  });

  it('renders the sage deposit box once depositDuePercent is supplied', () => {
    render(
      <ReceiptCard
        variant="estimate"
        subtotal={1000}
        total={1000}
        depositDuePercent={50}
        depositDueAmount={500}
        balanceOnCompletion={500}
      />,
    );

    expect(screen.getByText('Deposit due now')).toBeInTheDocument();
    expect(screen.getByText('50%')).toBeInTheDocument();
    expect(screen.getByText('Balance on completion')).toBeInTheDocument();
    // Static (non-interactive) percent — no "change the %" hint without a handler.
    expect(screen.queryByText(/Change the % or amount/)).not.toBeInTheDocument();
  });

  it('makes the deposit-% selector interactive and forwards the picked value when a handler + options are supplied', async () => {
    const user = userEvent.setup();
    const onDepositPercentChange = vi.fn();
    render(
      <ReceiptCard
        variant="estimate"
        subtotal={1000}
        total={1000}
        depositDuePercent={50}
        depositDueAmount={500}
        balanceOnCompletion={500}
        depositPercentOptions={[25, 50, 100]}
        onDepositPercentChange={onDepositPercentChange}
      />,
    );

    expect(screen.getByText(/Change the % or amount/)).toBeInTheDocument();
    await user.click(screen.getByRole('combobox'));
    await user.click(screen.getByRole('option', { name: '100%' }));

    expect(onDepositPercentChange).toHaveBeenCalledWith(100);
  });

  it('shows a fixed-dollar input (not the percent select) and a %/$ toggle when depositMode="FIXED"', async () => {
    const user = userEvent.setup();
    const onDepositFixedValueChange = vi.fn();
    const onDepositModeChange = vi.fn();
    render(
      <ReceiptCard
        variant="estimate"
        subtotal={1000}
        total={1000}
        depositDuePercent={33}
        depositDueAmount={333.33}
        balanceOnCompletion={666.67}
        depositMode="FIXED"
        onDepositModeChange={onDepositModeChange}
        onDepositFixedValueChange={onDepositFixedValueChange}
      />,
    );

    // No percent select in FIXED mode — a dollar input instead.
    expect(screen.queryByRole('combobox')).not.toBeInTheDocument();
    const input = screen.getByLabelText('Deposit amount');
    await user.clear(input);
    await user.type(input, '400');
    await user.tab();
    expect(onDepositFixedValueChange).toHaveBeenCalledWith(400);

    // The %/$ toggle is present and switching to % forwards the mode change.
    await user.click(screen.getByRole('button', { name: 'Deposit as a percentage' }));
    expect(onDepositModeChange).toHaveBeenCalledWith('PERCENTAGE');
  });

  it('omits the deposit %/$ toggle when onDepositModeChange is not supplied (no fake control)', () => {
    render(
      <ReceiptCard
        variant="estimate"
        subtotal={1000}
        total={1000}
        depositDuePercent={50}
        depositDueAmount={500}
        balanceOnCompletion={500}
      />,
    );

    expect(screen.queryByRole('group', { name: 'Deposit type' })).not.toBeInTheDocument();
  });
});

describe('ReceiptCard — discount mode toggle (review fix M1)', () => {
  it('falls back to the plain dollar-only editor (no toggle) when discountMode is omitted', async () => {
    const user = userEvent.setup();
    const onDiscountChange = vi.fn();
    render(<ReceiptCard variant="invoice" subtotal={1000} total={1000} discountAmount={0} onDiscountChange={onDiscountChange} />);

    expect(screen.queryByRole('group', { name: 'Discount type' })).not.toBeInTheDocument();
    const input = screen.getByLabelText('Discount amount');
    await user.clear(input);
    await user.type(input, '25');
    await user.tab();
    expect(onDiscountChange).toHaveBeenCalledWith(25);
  });

  it('renders a $/% toggle + raw-value input when discountMode is supplied, seeded from discountRawValue not discountAmount', () => {
    render(
      <ReceiptCard
        variant="estimate"
        subtotal={1000}
        total={900}
        discountAmount={100}
        discountMode="PERCENTAGE"
        discountRawValue={10}
        onDiscountChange={vi.fn()}
      />,
    );

    expect(screen.getByRole('group', { name: 'Discount type' })).toBeInTheDocument();
    // Seeded from the raw percent (10), not the computed dollar discountAmount (100).
    expect(screen.getByLabelText('Discount value')).toHaveValue(10);
  });

  it('forwards the typed value with the current mode on blur', async () => {
    const user = userEvent.setup();
    const onDiscountChange = vi.fn();
    render(
      <ReceiptCard
        variant="estimate"
        subtotal={1000}
        total={950}
        discountAmount={50}
        discountMode="FIXED_AMOUNT"
        discountRawValue={50}
        onDiscountChange={onDiscountChange}
      />,
    );

    const input = screen.getByLabelText('Discount value');
    await user.clear(input);
    await user.type(input, '75');
    await user.tab();

    expect(onDiscountChange).toHaveBeenCalledWith(75, 'FIXED_AMOUNT');
  });

  it('re-commits the current draft under the new unit when the mode toggle is clicked (no auto-conversion)', async () => {
    const user = userEvent.setup();
    const onDiscountChange = vi.fn();
    render(
      <ReceiptCard
        variant="estimate"
        subtotal={1000}
        total={900}
        discountAmount={100}
        discountMode="FIXED_AMOUNT"
        discountRawValue={100}
        onDiscountChange={onDiscountChange}
      />,
    );

    await user.click(screen.getByRole('button', { name: 'Discount as a percentage' }));

    expect(onDiscountChange).toHaveBeenCalledWith(100, 'PERCENTAGE');
  });
});

describe('ReceiptCard — invoice variant editing gates', () => {
  it('renders the Tax rate as static text when no onTaxRateChange/taxRates are supplied', () => {
    render(<ReceiptCard variant="invoice" subtotal={1000} taxRate={0.08} taxAmount={80} total={1080} amountDue={1080} />);

    expect(screen.getByText('8%')).toBeInTheDocument();
    expect(screen.queryByRole('combobox')).not.toBeInTheDocument();
  });

  it('renders an interactive Tax rate select and forwards the picked rate when onTaxRateChange + taxRates are supplied', async () => {
    const user = userEvent.setup();
    const onTaxRateChange = vi.fn();
    render(
      <ReceiptCard
        variant="invoice"
        subtotal={1000}
        taxRate={0.08}
        taxAmount={80}
        total={1080}
        amountDue={1080}
        onTaxRateChange={onTaxRateChange}
        taxRates={[{ id: 't1', state_code: 'TX', state_name: 'Texas', tax_rate: 0.0825 }]}
      />,
    );

    await user.click(screen.getByRole('combobox'));
    await user.click(screen.getByRole('option', { name: /Texas/ }));

    expect(onTaxRateChange).toHaveBeenCalledWith(0.0825);
  });

  it('renders a 5-decimal tax rate (R5c) at full precision instead of rounding off the 5th digit', () => {
    render(<ReceiptCard variant="invoice" subtotal={1000} taxRate={0.06875} taxAmount={68.75} total={1068.75} amountDue={1068.75} />);

    expect(screen.getByText('6.875%')).toBeInTheDocument();
  });

  it('does not conflate a custom rate with a state rate a few ten-thousandths away (R5c)', async () => {
    const user = userEvent.setup();
    render(
      <ReceiptCard
        variant="invoice"
        subtotal={1000}
        taxRate={0.08625}
        taxAmount={86.25}
        total={1086.25}
        amountDue={1086.25}
        onTaxRateChange={vi.fn()}
        taxRates={[{ id: 's1', state_code: 'NJ', state_name: 'New Jersey', tax_rate: 0.0863 }]}
      />,
    );

    await user.click(screen.getByRole('combobox'));
    expect(screen.getByRole('option', { name: /Custom rate \(8\.625%\)/ })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: /New Jersey \(8\.63%\)/ })).toBeInTheDocument();
  });
});

/**
 * #843 scope guard. The reversal props are Invoice-only. This card is SHARED with the Estimate and
 * Job surfaces, so passing them on those variants must be a total no-op - no stray row, no bar, no
 * altered markup - even though the props type-check on every variant.
 */
describe('ReceiptCard - invoice-only reversal props are inert on estimate/job', () => {
  const reversalProps = {
    refundedTotal: 400,
    creditedTotal: 75,
    settledTotal: 600,
    overpaidAmount: 200,
  } as const;

  it.each(['estimate', 'job'] as const)(
    'renders %s byte-identical markup with and without the reversal props',
    (variant) => {
      const base = { variant, subtotal: 1000, total: 1000, amountDue: 0 } as const;

      const { container: without, unmount } = render(<ReceiptCard {...base} />);
      const htmlWithout = without.innerHTML;
      unmount();

      const { container: withProps } = render(<ReceiptCard {...base} {...reversalProps} />);
      expect(withProps.innerHTML).toBe(htmlWithout);
    },
  );

  it.each(['estimate', 'job'] as const)('never renders a reversal row or a progress bar on %s', (variant) => {
    render(<ReceiptCard variant={variant} subtotal={1000} total={1000} amountDue={0} {...reversalProps} />);

    expect(screen.queryByText('Refunded')).not.toBeInTheDocument();
    expect(screen.queryByText('Credited')).not.toBeInTheDocument();
    expect(screen.queryByText('Overpaid')).not.toBeInTheDocument();
    // "% collected" is the invoice variant's progress caption and must not leak onto these.
    expect(screen.queryByText(/% collected/)).not.toBeInTheDocument();
  });
});
