/**
 * PaymentFeeBreakdown — Task 3.4 (spec §7.3). One combined fee figure (Stripe processing +
 * ServWave's 0.5% platform fee) with a click-to-open drill-in revealing Gross / Stripe fee /
 * ServWave fee / Net. Must render nothing for cash/check/legacy payments or a CARD payment
 * whose fee capture (Task 3.3) hasn't landed yet — the null-safety this suite pins down.
 */
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { PaymentFeeBreakdown } from '@/components/crm/PaymentFeeBreakdown';

describe('PaymentFeeBreakdown', () => {
  it('renders nothing when stripe_fee_amount is null (cash/check/legacy payment)', () => {
    const { container } = render(
      <PaymentFeeBreakdown amount={500} stripeFeeAmount={null} platformFeeAmount={2.5} netAmount={482.75} />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it('renders nothing when platform_fee_amount is undefined (not yet reconciled)', () => {
    const { container } = render(
      <PaymentFeeBreakdown amount={500} stripeFeeAmount={14.75} platformFeeAmount={undefined} netAmount={482.75} />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it('renders nothing when net_amount is null', () => {
    const { container } = render(
      <PaymentFeeBreakdown amount={500} stripeFeeAmount={14.75} platformFeeAmount={2.5} netAmount={null} />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it('shows the combined fee figure (Stripe + ServWave) when all three columns are populated', () => {
    render(<PaymentFeeBreakdown amount={500} stripeFeeAmount={14.75} platformFeeAmount={2.5} netAmount={482.75} />);
    // Combined = 14.75 + 2.50 = 17.25
    expect(screen.getByRole('button', { name: /Fee \$17\.25/ })).toBeInTheDocument();
  });

  it('reveals the itemized Gross / Stripe fee / ServWave fee / Net split on click', async () => {
    const user = userEvent.setup();
    render(<PaymentFeeBreakdown amount={500} stripeFeeAmount={14.75} platformFeeAmount={2.5} netAmount={482.75} />);

    await user.click(screen.getByRole('button', { name: /Fee \$17\.25/ }));

    expect(await screen.findByText('Gross')).toBeInTheDocument();
    expect(screen.getByText('$500.00')).toBeInTheDocument();
    expect(screen.getByText('Stripe fee')).toBeInTheDocument();
    expect(screen.getByText('-$14.75')).toBeInTheDocument();
    // Fee-line label — spec §6.8 copy appendix, verbatim.
    expect(screen.getByText('ServWave platform fee — 0.5%')).toBeInTheDocument();
    expect(screen.getByText('-$2.50')).toBeInTheDocument();
    expect(screen.getByText('Net')).toBeInTheDocument();
    expect(screen.getByText('$482.75')).toBeInTheDocument();
  });

  it('accepts string-typed Decimal fields (as Prisma serializes them over JSON) and computes correctly', async () => {
    const user = userEvent.setup();
    render(
      <PaymentFeeBreakdown amount="1000.00" stripeFeeAmount="29.30" platformFeeAmount="5.00" netAmount="965.70" />,
    );

    expect(screen.getByRole('button', { name: /Fee \$34\.30/ })).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /Fee \$34\.30/ }));
    expect(await screen.findByText('$965.70')).toBeInTheDocument();
  });

  it('formats large fee totals as full comma-grouped numbers, never abbreviated (k/M)', () => {
    render(
      <PaymentFeeBreakdown amount={150000} stripeFeeAmount={4350.5} platformFeeAmount={750} netAmount={144899.5} />,
    );
    // Combined = 4350.50 + 750 = 5100.50
    expect(screen.getByRole('button', { name: /Fee \$5,100\.50/ })).toBeInTheDocument();
  });

  it('treats an all-zero fee (platform_fee_bps=0) as reconciled data, not "not yet captured"', () => {
    render(<PaymentFeeBreakdown amount={500} stripeFeeAmount={14.75} platformFeeAmount={0} netAmount={485.25} />);
    // platform_fee_amount is a real 0 (an org with the fee disabled), not null — must still render.
    expect(screen.getByRole('button', { name: /Fee \$14\.75/ })).toBeInTheDocument();
  });

  // Code-review finding: the rate text used to be a hardcoded "0.5%" literal, wrong for any org
  // whose platform_fee_bps differs from the 0.5% default. It must be DERIVED from this payment's
  // actual dollars (platformFeeAmount / amount), not a literal — proven here with a 1% fixture.
  it('derives the platform-fee percentage from the actual dollar amounts, not a hardcoded 0.5% literal', async () => {
    const user = userEvent.setup();
    // 1% rate: platformFeeAmount is 1% of amount (not the 0.5% default used elsewhere in this file).
    render(<PaymentFeeBreakdown amount={1000} stripeFeeAmount={29} platformFeeAmount={10} netAmount={961} />);

    await user.click(screen.getByRole('button', { name: /Fee \$39\.00/ }));

    expect(await screen.findByText('ServWave platform fee — 1%')).toBeInTheDocument();
    expect(screen.queryByText(/0\.5%/)).not.toBeInTheDocument();
  });

  it('falls back to a rate-agnostic label (no NaN%/Infinity%) when the gross amount is zero', async () => {
    const user = userEvent.setup();
    render(<PaymentFeeBreakdown amount={0} stripeFeeAmount={0} platformFeeAmount={0} netAmount={0} />);

    await user.click(screen.getByRole('button', { name: /Fee \$0\.00/ }));

    expect(await screen.findByText('ServWave platform fee')).toBeInTheDocument();
  });

  // ─── The charged basis (2026-08-04) ─────────────────────────────────────────
  // Payment.net_amount is derived from Stripe's charge.amount — the FULL amount
  // charged to the card (face + service fee + tip) — while `amount` is the invoice
  // face value only (D1/D10). Once a payment carries a fee or a tip, this popover's
  // four-row column stopped adding up: it showed Gross, minus two fees, then a Net
  // LARGER than the Gross it was subtracted from. The fee and tip rows are the
  // missing terms.
  describe('service fee and tip rows (so the column adds up)', () => {
    // Live evidence: staging payment 8b17c520-…, org 00000000-…-0001, 2026-08-04.
    const live = {
      amount: 533.13,
      serviceFeeAmount: 18.66,
      tipAmount: 80,
      stripeFeeAmount: 20.98,
      platformFeeAmount: 2.36,
      netAmount: 608.45,
    };

    it('itemizes the service fee and the tip so Gross + fee + tip - costs === Net', async () => {
      const user = userEvent.setup();
      render(<PaymentFeeBreakdown {...live} />);

      await user.click(screen.getByRole('button', { name: /Fee \$23\.34/ }));

      expect(await screen.findByText('Gross')).toBeInTheDocument();
      expect(screen.getByText('$533.13')).toBeInTheDocument();
      // Additive rows, signed so the column reads as arithmetic.
      expect(screen.getByText('Service fee (customer)')).toBeInTheDocument();
      expect(screen.getByText('+$18.66')).toBeInTheDocument();
      expect(screen.getByText('Tip (customer)')).toBeInTheDocument();
      expect(screen.getByText('+$80.00')).toBeInTheDocument();
      expect(screen.getByText('-$20.98')).toBeInTheDocument();
      expect(screen.getByText('-$2.36')).toBeInTheDocument();
      expect(screen.getByText('Net')).toBeInTheDocument();
      expect(screen.getByText('$608.45')).toBeInTheDocument();
      // 533.13 + 18.66 + 80.00 - 20.98 - 2.36 = 608.45 exactly.
      const sum = 533.13 + 18.66 + 80 - 20.98 - 2.36;
      expect(Math.round(sum * 100) / 100).toBe(608.45);
    });

    it('omits both rows entirely for a payment carrying neither (pre-feature rendering is unchanged)', async () => {
      const user = userEvent.setup();
      render(<PaymentFeeBreakdown amount={500} stripeFeeAmount={14.75} platformFeeAmount={2.5} netAmount={482.75} />);

      await user.click(screen.getByRole('button', { name: /Fee \$17\.25/ }));

      expect(await screen.findByText('Gross')).toBeInTheDocument();
      expect(screen.queryByText(/Service fee/)).not.toBeInTheDocument();
      expect(screen.queryByText(/^Tip/)).not.toBeInTheDocument();
    });

    it('shows only the fee row when there is no tip, and only the tip row when there is no fee', async () => {
      const user = userEvent.setup();
      const { unmount } = render(
        <PaymentFeeBreakdown amount={1000} serviceFeeAmount={35} stripeFeeAmount={30.32} platformFeeAmount={4.68} netAmount={1000} />,
      );
      await user.click(screen.getByRole('button', { name: /Fee \$35\.00/ }));
      expect(await screen.findByText('Service fee (customer)')).toBeInTheDocument();
      expect(screen.queryByText(/^Tip/)).not.toBeInTheDocument();
      unmount();

      render(
        <PaymentFeeBreakdown amount={1000} tipAmount={50} stripeFeeAmount={30.75} platformFeeAmount={5} netAmount={1014.25} />,
      );
      await user.click(screen.getByRole('button', { name: /Fee \$35\.75/ }));
      expect(await screen.findByText('Tip (customer)')).toBeInTheDocument();
      expect(screen.queryByText(/Service fee/)).not.toBeInTheDocument();
    });

    it('treats a real $0 fee as data and omits the row (nothing was collected, so nothing to itemize)', async () => {
      const user = userEvent.setup();
      render(
        <PaymentFeeBreakdown amount={500} serviceFeeAmount={0} tipAmount={0} stripeFeeAmount={14.75} platformFeeAmount={2.5} netAmount={482.75} />,
      );
      await user.click(screen.getByRole('button', { name: /Fee \$17\.25/ }));
      expect(await screen.findByText('Gross')).toBeInTheDocument();
      expect(screen.queryByText(/Service fee/)).not.toBeInTheDocument();
      expect(screen.queryByText(/^Tip/)).not.toBeInTheDocument();
    });

    it('accepts string-typed Decimals for the two new columns, as Prisma serializes them', async () => {
      const user = userEvent.setup();
      render(
        <PaymentFeeBreakdown amount="533.13" serviceFeeAmount="18.66" tipAmount="80.00" stripeFeeAmount="20.98" platformFeeAmount="2.36" netAmount="608.45" />,
      );
      await user.click(screen.getByRole('button', { name: /Fee \$23\.34/ }));
      expect(await screen.findByText('+$18.66')).toBeInTheDocument();
      expect(screen.getByText('+$80.00')).toBeInTheDocument();
    });

    // The platform fee stopped being a rate on `amount` the moment the service fee
    // shipped: it is derived as `serviceFee - estimatedStripeFee` (D2), so dividing
    // it by the face amount fabricates a percentage the org was never charged (the
    // live row above would read "0.44%"). Suppress the suffix rather than print a
    // number that means nothing.
    it('drops the derived rate suffix when a service fee is present (the platform fee is no longer a rate)', async () => {
      const user = userEvent.setup();
      render(<PaymentFeeBreakdown {...live} />);

      await user.click(screen.getByRole('button', { name: /Fee \$23\.34/ }));

      expect(await screen.findByText('ServWave platform fee')).toBeInTheDocument();
      expect(screen.queryByText(/ServWave platform fee — /)).not.toBeInTheDocument();
      expect(screen.queryByText(/0\.44%/)).not.toBeInTheDocument();
    });

    it('still derives the rate for a payment with no service fee (legacy 0.5% path unchanged)', async () => {
      const user = userEvent.setup();
      render(<PaymentFeeBreakdown amount={500} stripeFeeAmount={14.75} platformFeeAmount={2.5} netAmount={482.75} />);

      await user.click(screen.getByRole('button', { name: /Fee \$17\.25/ }));

      expect(await screen.findByText('ServWave platform fee — 0.5%')).toBeInTheDocument();
    });
  });
});
