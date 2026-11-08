import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import api from '@/lib/axios';
import { renderWithProviders } from './helpers';
import { RefundInvoiceDialog } from '@/components/invoices/RefundInvoiceDialog';
import { CreditInvoiceDialog } from '@/components/invoices/CreditInvoiceDialog';
import { VoidPaymentDialog } from '@/components/invoices/VoidPaymentDialog';
import { RecordPaymentDialog } from '@/components/invoices/RecordPaymentDialog';

const mockApi = vi.mocked(api);

beforeEach(() => {
  vi.clearAllMocks();
  mockApi.post.mockResolvedValue({ data: { invoice: {} } });
});

describe('RefundInvoiceDialog (partial refund)', () => {
  it('caps the amount at net-paid and disables submit when exceeded', async () => {
    const user = userEvent.setup();
    renderWithProviders(
      <RefundInvoiceDialog open onOpenChange={vi.fn()} invoiceId="inv-1" netPaid={100} />
    );

    // Amount over the cap → invalid hint shown, submit stays disabled.
    await user.type(screen.getByRole('spinbutton'), '150');
    expect(screen.getByText(/Amount must be between/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Issue Refund' })).toBeDisabled();
  });

  it('POSTs a partial refund with amount, category and reason', async () => {
    const user = userEvent.setup();
    renderWithProviders(
      <RefundInvoiceDialog open onOpenChange={vi.fn()} invoiceId="inv-1" netPaid={500} />
    );

    await user.type(screen.getByRole('spinbutton'), '120');
    // Reason category is now a SelectField (Radix Select) — open it and click
    // the option by its rendered label rather than `selectOptions` by value.
    await user.click(screen.getByRole('combobox', { name: 'Reason category' }));
    await user.click(screen.getByRole('option', { name: 'Customer request' }));
    await user.type(screen.getByPlaceholderText(/details about this refund/i), 'Partial give-back');
    await user.click(screen.getByRole('button', { name: 'Issue Refund' }));

    await waitFor(() => {
      expect(mockApi.post).toHaveBeenCalledWith(
        '/api/invoices/inv-1/refund',
        expect.objectContaining({
          amount: 120,
          reason_category: 'CUSTOMER_REQUEST',
          reason: 'Partial give-back',
        })
      );
    });
  });
});

describe('CreditInvoiceDialog', () => {
  it('POSTs a credit with amount and reason', async () => {
    const user = userEvent.setup();
    renderWithProviders(
      <CreditInvoiceDialog open onOpenChange={vi.fn()} invoiceId="inv-9" balanceOwed={200} />
    );

    await user.type(screen.getByRole('spinbutton'), '50');
    await user.type(screen.getByPlaceholderText(/details about this credit/i), 'Goodwill adjustment');
    await user.click(screen.getByRole('button', { name: 'Issue Credit' }));

    await waitFor(() => {
      expect(mockApi.post).toHaveBeenCalledWith(
        '/api/invoices/inv-9/credit',
        expect.objectContaining({ amount: 50, reason: 'Goodwill adjustment' })
      );
    });
  });

  // SRVW-97: refund_instead sends the FULL amount as cash, not just the excess, and the dialog
  // previously misdescribed that (docs/adr/0004-refund-never-reopens-amount-due.md).
  it('with refund instead ticked, the preview shows the full amount as cash out and zero credited', async () => {
    const user = userEvent.setup();
    renderWithProviders(
      <CreditInvoiceDialog open onOpenChange={vi.fn()} invoiceId="inv-9" balanceOwed={600} />
    );

    await user.type(screen.getByRole('spinbutton'), '400');
    await user.click(screen.getByTestId('credit-refund-instead'));

    expect(screen.getByText(/\$400\.00 refunded as cash/)).toBeInTheDocument();
    expect(screen.getByText(/nothing credited to the balance/)).toBeInTheDocument();
    expect(screen.queryByText(/refunded as excess/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/excess/i, { selector: 'label' })).not.toBeInTheDocument();
  });

  it('names what happens to the outstanding balance in each mode', async () => {
    const user = userEvent.setup();
    renderWithProviders(
      <CreditInvoiceDialog open onOpenChange={vi.fn()} invoiceId="inv-9" balanceOwed={600} />
    );

    await user.type(screen.getByRole('spinbutton'), '400');
    await user.click(screen.getByTestId('credit-refund-instead'));

    expect(screen.getByText(/\$600\.00/)).toBeInTheDocument();
    expect(screen.getByText(/write-off credit/i)).toBeInTheDocument();

    await user.click(screen.getByTestId('credit-reopen-balance'));

    expect(screen.getByText(/\$1,000\.00/)).toBeInTheDocument();
    expect(screen.getByText(/reopens as unpaid/i)).toBeInTheDocument();
  });

  it('the reversal checkbox appears only under refund-instead and clears when refund-instead is unticked', async () => {
    const user = userEvent.setup();
    const { rerender } = renderWithProviders(
      <CreditInvoiceDialog open onOpenChange={vi.fn()} invoiceId="inv-9" balanceOwed={600} />
    );

    expect(screen.queryByTestId('credit-reopen-balance')).not.toBeInTheDocument();

    await user.click(screen.getByTestId('credit-refund-instead'));
    expect(screen.getByTestId('credit-reopen-balance')).toBeInTheDocument();
    await user.click(screen.getByTestId('credit-reopen-balance'));
    expect(screen.getByTestId('credit-reopen-balance')).toBeChecked();

    // Unticking refund-instead hides AND clears the reversal so a later submit does not carry a
    // stale reopen_balance: true.
    await user.click(screen.getByTestId('credit-refund-instead'));
    expect(screen.queryByTestId('credit-reopen-balance')).not.toBeInTheDocument();
    await user.click(screen.getByTestId('credit-refund-instead'));
    expect(screen.getByTestId('credit-reopen-balance')).not.toBeChecked();

    // With balanceOwed=0 the reversal option never appears, even with refund-instead ticked -
    // this mirrors the backend guard but does not substitute for it.
    rerender(
      <CreditInvoiceDialog open onOpenChange={vi.fn()} invoiceId="inv-9" balanceOwed={0} />
    );
    expect(screen.queryByTestId('credit-reopen-balance')).not.toBeInTheDocument();
  });

  it('POSTs reopen_balance: true when the reversal checkbox is ticked', async () => {
    const user = userEvent.setup();
    renderWithProviders(
      <CreditInvoiceDialog open onOpenChange={vi.fn()} invoiceId="inv-9" balanceOwed={600} />
    );

    await user.click(screen.getByTestId('credit-refund-instead'));
    await user.click(screen.getByTestId('credit-reopen-balance'));
    await user.type(screen.getByRole('spinbutton'), '400');
    await user.type(screen.getByPlaceholderText(/details about this credit/i), 'Customer disputed the charge');
    await user.click(screen.getByRole('button', { name: 'Issue Credit' }));

    await waitFor(() => {
      expect(mockApi.post).toHaveBeenCalledWith(
        '/api/invoices/inv-9/credit',
        expect.objectContaining({ amount: 400, refund_instead: true, reopen_balance: true })
      );
    });
  });
});

// #843: the API accepts an overpayment and only flags it on the timeline, so the UI must make it a
// deliberate, acknowledged choice rather than a silent slip.
describe('RecordPaymentDialog (overpayment gate)', () => {
  const props = {
    open: true as const,
    onOpenChange: vi.fn(),
    invoiceId: 'inv-1',
    invoiceNumber: 'I00001',
    amountDue: 200,
    onSuccess: vi.fn(),
  };

  it('shows the balance due, no override toggle, and an enabled submit when amount <= balance', () => {
    renderWithProviders(<RecordPaymentDialog {...props} />);

    expect(screen.getByText('Balance due: $200.00')).toBeInTheDocument();
    // Default amount === amountDue: no overpayment, so no toggle and no warning.
    expect(screen.queryByRole('checkbox')).not.toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Record Payment' })).toBeEnabled();
  });

  it('requires an explicit acknowledgement before submit when amount > balance', async () => {
    const user = userEvent.setup();
    renderWithProviders(<RecordPaymentDialog {...props} />);

    const amountInput = screen.getByRole('spinbutton');
    await user.clear(amountInput);
    await user.type(amountInput, '250');

    // Surplus named, warning is an alert, submit blocked.
    expect(screen.getByRole('alert')).toBeInTheDocument();
    expect(screen.getByText(/overpayment of \$50\.00/i)).toBeInTheDocument();
    const submit = screen.getByRole('button', { name: 'Record Payment' });
    expect(submit).toBeDisabled();

    // Acknowledge → unlocked.
    await user.click(screen.getByRole('checkbox'));
    expect(screen.getByRole('button', { name: 'Record Payment' })).toBeEnabled();
  });

  it('re-arms the acknowledgement when the amount changes again', async () => {
    const user = userEvent.setup();
    renderWithProviders(<RecordPaymentDialog {...props} />);

    const amountInput = screen.getByRole('spinbutton');
    await user.clear(amountInput);
    await user.type(amountInput, '250');
    await user.click(screen.getByRole('checkbox'));
    expect(screen.getByRole('button', { name: 'Record Payment' })).toBeEnabled();

    // Typing another digit ($2,500) must NOT carry the old acknowledgement forward.
    await user.type(amountInput, '0');
    expect(screen.getByText(/overpayment of \$2,300\.00/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Record Payment' })).toBeDisabled();
  });

  it('coerces a cleared amount field to 0 instead of NaN, and keeps submit disabled', async () => {
    const user = userEvent.setup();
    renderWithProviders(<RecordPaymentDialog {...props} />);

    const amountInput = screen.getByRole('spinbutton') as HTMLInputElement;
    await user.clear(amountInput);

    expect(amountInput.value).toBe('0');
    expect(screen.getByRole('button', { name: 'Record Payment' })).toBeDisabled();
  });

  it('POSTs the full over-amount once acknowledged', async () => {
    const user = userEvent.setup();
    mockApi.post.mockResolvedValue({ data: { invoice: {}, payment: {}, overpaid: 50 } });
    renderWithProviders(<RecordPaymentDialog {...props} />);

    const amountInput = screen.getByRole('spinbutton');
    await user.clear(amountInput);
    await user.type(amountInput, '250');
    await user.click(screen.getByRole('checkbox'));
    await user.click(screen.getByRole('button', { name: 'Record Payment' }));

    await waitFor(() => {
      expect(mockApi.post).toHaveBeenCalledWith(
        '/api/invoices/inv-1/payments',
        expect.objectContaining({ amount: 250 }),
      );
    });
  });
});

describe('VoidPaymentDialog', () => {
  const payment = { id: 'pay-1', amount: 75, method: 'CHECK', reference_number: '1234' };

  it('disables submit until a category and reason are provided', () => {
    renderWithProviders(
      <VoidPaymentDialog open onOpenChange={vi.fn()} invoiceId="inv-1" payment={payment} />
    );
    expect(screen.getByRole('button', { name: 'Void Payment' })).toBeDisabled();
  });

  it('POSTs the void with payment_id, void_category and reason', async () => {
    const user = userEvent.setup();
    renderWithProviders(
      <VoidPaymentDialog open onOpenChange={vi.fn()} invoiceId="inv-1" payment={payment} />
    );

    // Reason category is now a SelectField (Radix Select) — open it and click
    // the option by its rendered label rather than `selectOptions` by value.
    await user.click(screen.getByRole('combobox', { name: 'Reason category' }));
    await user.click(screen.getByRole('option', { name: 'Bounced (NSF / returned)' }));
    await user.type(screen.getByPlaceholderText(/why is this payment being voided/i), 'Check returned NSF');
    await user.click(screen.getByRole('button', { name: 'Void Payment' }));

    await waitFor(() => {
      expect(mockApi.post).toHaveBeenCalledWith(
        '/api/invoices/inv-1/void-payment',
        { payment_id: 'pay-1', void_category: 'BOUNCED', reason: 'Check returned NSF' }
      );
    });
  });
});
