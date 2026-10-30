/**
 * Payments go-live slice 33 - the rendered side of the vendor-name guard. The source scan
 * (no-processor-name-in-copy.guard.test.ts) reads string literals; this renders the payment
 * surfaces whose copy was rewritten and checks the DOM and the console, so a name that arrives
 * by another route (a prop, a join) is caught too. The processor's own embedded frames are not
 * rendered here (they are a mocked boundary in every payments test).
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithProviders } from './helpers';
import { RefundDepositDialog } from '@/components/estimates/RefundDepositDialog';
import { PaymentFeeBreakdown } from '@/components/crm/PaymentFeeBreakdown';

afterEach(() => vi.restoreAllMocks());

describe('payment surfaces render no processor name', () => {
  it('the deposit refund dialog, for a card deposit, says the refund is automatic and names no vendor', () => {
    const log = vi.spyOn(console, 'log');
    const warn = vi.spyOn(console, 'warn');
    renderWithProviders(
      <RefundDepositDialog open onOpenChange={() => {}} estimateId="e1" depositInvoiceId="i1" depositAmount={250} hasStripePayment />,
    );
    expect(screen.getByText('The refund will be processed automatically.')).toBeInTheDocument();
    expect(document.body.innerHTML).not.toMatch(/stripe/i);
    expect(JSON.stringify([...log.mock.calls, ...warn.mock.calls])).not.toMatch(/stripe/i);
  });

  it('the fee drill-in labels the processing fee in ServWave terms', async () => {
    const user = userEvent.setup();
    renderWithProviders(<PaymentFeeBreakdown amount={500} stripeFeeAmount={14.75} platformFeeAmount={2.5} netAmount={482.75} />);
    await user.click(screen.getByRole('button', { name: /Fee \$17\.25/ }));
    expect(await screen.findByText('Card processing fee')).toBeInTheDocument();
    expect(document.body.innerHTML).not.toMatch(/stripe/i);
  });
});
