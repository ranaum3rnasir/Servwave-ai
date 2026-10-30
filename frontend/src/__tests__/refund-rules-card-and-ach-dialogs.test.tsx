/**
 * Payments go-live slice 29 - refund rules for card and bank payments, as the dialogs show them
 * (D17). The server enforces every rule (backend refund-rules-card-and-ach-db.test.ts); this file
 * covers what a person sees before they press the button:
 *   - refunding a bank payment warns that a bank dispute could credit the customer twice;
 *   - a bank payment past 180 days says to refund another way, and cannot be submitted;
 *   - a bank payment still processing is cancelled from its own dialog ("Cancel payment");
 *   - without the refund permission, the credit dialog never offers to send money back.
 *
 * `api` is globally mocked (setup.ts).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import api from '@/lib/axios';
import { renderWithProviders } from './helpers';
import { RefundInvoiceDialog } from '@/components/invoices/RefundInvoiceDialog';
import { CancelBankPaymentDialog } from '@/components/invoices/CancelBankPaymentDialog';
import { CreditInvoiceDialog } from '@/components/invoices/CreditInvoiceDialog';

const mockApi = vi.mocked(api);

const DUAL_CREDIT_WARNING = 'If the customer also disputes this payment with their bank within 60 days, they could be credited twice.';
const WINDOW_MESSAGE = 'Bank payments can only be refunded within 180 days. Refund the customer another way, then record it here.';

const daysAgo = (days: number) => new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();

const bank = (id: string, paidDaysAgo = 5) => ({
  id, amount: 300, method: 'ACH', paid_at: daysAgo(paidDaysAgo), state: 'SUCCEEDED', paid_through_processor: true,
});
const card = (id: string, paidDaysAgo = 5) => ({
  id, amount: 300, method: 'CARD', paid_at: daysAgo(paidDaysAgo), state: 'SUCCEEDED', paid_through_processor: true,
});

async function choosePayment(user: ReturnType<typeof userEvent.setup>, label: RegExp) {
  await user.click(screen.getByRole('combobox', { name: 'Reverse a specific payment' }));
  await user.click(screen.getByRole('option', { name: label }));
}

beforeEach(() => {
  vi.clearAllMocks();
  mockApi.post.mockResolvedValue({ data: { success: true } });
});

describe('RefundInvoiceDialog - bank payments', () => {
  it('warns that a bank dispute could credit the customer twice when the refund goes back to a bank payment', async () => {
    const user = userEvent.setup();
    renderWithProviders(
      <RefundInvoiceDialog open onOpenChange={vi.fn()} invoiceId="inv-1" netPaid={600} payments={[card('pay-card', 9), bank('pay-bank', 3)]} />,
    );
    // A $300 refund comes from the oldest payment that can return it (the card): no bank warning.
    await user.type(screen.getByTestId('refund-amount-input'), '300');
    expect(screen.queryByText(DUAL_CREDIT_WARNING)).not.toBeInTheDocument();

    await choosePayment(user, /ACH/);

    expect(screen.getByText(DUAL_CREDIT_WARNING)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Issue Refund' })).toBeDisabled(); // no reason yet
  });

  it('warns on "Auto" too, when the payment the refund comes from is a bank payment', () => {
    renderWithProviders(
      <RefundInvoiceDialog open onOpenChange={vi.fn()} invoiceId="inv-1" netPaid={300} payments={[bank('pay-bank')]} />,
    );

    expect(screen.getByText(DUAL_CREDIT_WARNING)).toBeInTheDocument();
  });

  it('a bank payment past 180 days says to refund another way, and the refund cannot be sent', async () => {
    const user = userEvent.setup();
    renderWithProviders(
      <RefundInvoiceDialog open onOpenChange={vi.fn()} invoiceId="inv-1" netPaid={300} payments={[bank('pay-old', 181)]} />,
    );

    expect(screen.getByText(WINDOW_MESSAGE)).toBeInTheDocument();
    await user.click(screen.getByRole('combobox', { name: 'Reason category' }));
    await user.click(screen.getByRole('option', { name: 'Customer request' }));
    await user.type(screen.getByPlaceholderText(/details about this refund/i), 'Too late for the bank');
    expect(screen.getByRole('button', { name: 'Issue Refund' })).toBeDisabled();
  });

  it('past 180 days, a refund handed back another way (a hand method picked) can be recorded', async () => {
    const user = userEvent.setup();
    renderWithProviders(
      <RefundInvoiceDialog open onOpenChange={vi.fn()} invoiceId="inv-1" netPaid={300} payments={[bank('pay-old', 200)]} />,
    );
    await user.click(screen.getByRole('combobox', { name: 'Reason category' }));
    await user.click(screen.getByRole('option', { name: 'Customer request' }));
    await user.type(screen.getByPlaceholderText(/details about this refund/i), 'Paid back by check');
    expect(screen.getByRole('button', { name: 'Issue Refund' })).toBeDisabled();

    await user.click(screen.getByRole('combobox', { name: 'Refund method' }));
    await user.click(screen.getByRole('option', { name: 'Check' }));

    // Nothing goes back to the bank, so neither the window message nor the bank warning applies.
    expect(screen.queryByText(WINDOW_MESSAGE)).not.toBeInTheDocument();
    expect(screen.queryByText(DUAL_CREDIT_WARNING)).not.toBeInTheDocument();
    const submit = screen.getByRole('button', { name: 'Issue Refund' });
    expect(submit).toBeEnabled();
    await user.click(submit);
    await waitFor(() => {
      expect(mockApi.post).toHaveBeenCalledWith('/api/invoices/inv-1/refund', expect.objectContaining({ method: 'CHECK' }), { silentErrors: true });
    });

    // Back on "Auto", the refund would go to the bank: the message returns and it cannot be sent.
    await user.click(screen.getByRole('combobox', { name: 'Refund method' }));
    await user.click(screen.getByRole('option', { name: 'Auto (match original payment)' }));
    expect(screen.getByText(WINDOW_MESSAGE)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Issue Refund' })).toBeDisabled();
  });

  it('a bank payment within 180 days, and a card payment of any age, can be refunded', () => {
    renderWithProviders(
      <RefundInvoiceDialog open onOpenChange={vi.fn()} invoiceId="inv-1" netPaid={300} payments={[card('pay-old-card', 400)]} />,
    );

    expect(screen.queryByText(WINDOW_MESSAGE)).not.toBeInTheDocument();
    expect(screen.queryByText(DUAL_CREDIT_WARNING)).not.toBeInTheDocument();
  });

  it('names no payment processor', () => {
    renderWithProviders(
      <RefundInvoiceDialog open onOpenChange={vi.fn()} invoiceId="inv-1" netPaid={300} payments={[bank('pay-bank', 200)]} />,
    );

    expect(screen.getByTestId('refund-invoice-dialog').textContent).not.toMatch(/stripe/i);
  });
});

describe('CancelBankPaymentDialog - "Cancel payment" for a bank payment still processing', () => {
  it('says what cancelling does, and cancels the payment', async () => {
    const user = userEvent.setup();
    const onOpenChange = vi.fn();
    renderWithProviders(
      <CancelBankPaymentDialog open onOpenChange={onOpenChange} invoiceId="inv-1" payment={{ id: 'pay-ach', amount: 250 }} />,
    );

    const dialog = screen.getByTestId('cancel-bank-payment-dialog');
    expect(dialog).toHaveTextContent('Cancel payment');
    expect(dialog).toHaveTextContent('This bank payment of $250.00 has not cleared yet.');
    expect(dialog.textContent).not.toMatch(/stripe/i);

    await user.click(screen.getByRole('button', { name: 'Cancel payment' }));

    await waitFor(() => {
      expect(mockApi.post).toHaveBeenCalledWith('/api/invoices/inv-1/cancel-bank-payment', { payment_id: 'pay-ach' }, { silentErrors: true });
    });
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
  });

  it('shows the server\'s reason when the payment can no longer be cancelled, and stays open', async () => {
    const user = userEvent.setup();
    const onOpenChange = vi.fn();
    mockApi.post.mockRejectedValueOnce(Object.assign(new Error('Request failed with status code 400'), {
      isAxiosError: true,
      response: { status: 400, data: { error: 'This bank payment can no longer be cancelled. It can be refunded once it clears.' } },
    }));
    renderWithProviders(
      <CancelBankPaymentDialog open onOpenChange={onOpenChange} invoiceId="inv-1" payment={{ id: 'pay-ach', amount: 250 }} />,
    );

    await user.click(screen.getByRole('button', { name: 'Cancel payment' }));

    expect(await screen.findByText('This bank payment can no longer be cancelled. It can be refunded once it clears.')).toBeInTheDocument();
    expect(onOpenChange).not.toHaveBeenCalledWith(false);
  });
});

describe('CreditInvoiceDialog - without the refund permission', () => {
  it('never offers to send money back, and caps the credit at what is owed', async () => {
    const user = userEvent.setup();
    renderWithProviders(
      <CreditInvoiceDialog open onOpenChange={vi.fn()} invoiceId="inv-1" balanceOwed={100} canRefund={false} />,
    );

    const dialog = screen.getByTestId('credit-invoice-dialog');
    expect(screen.queryByTestId('credit-refund-instead')).not.toBeInTheDocument();
    expect(dialog.textContent).not.toMatch(/refund/i);

    await user.type(document.querySelector<HTMLInputElement>('input[inputmode="decimal"]')!, '150');
    await user.type(screen.getByPlaceholderText(/details about this credit/i), 'Goodwill');

    expect(screen.queryByRole('combobox', { name: 'Refund method' })).not.toBeInTheDocument();
    expect(screen.getByText('A credit can be at most the $100.00 still owed.')).toBeInTheDocument();
    expect(screen.getByTestId('credit-invoice-submit')).toBeDisabled();
  });

  it('with the permission, the excess is still sent back as before', async () => {
    const user = userEvent.setup();
    renderWithProviders(
      <CreditInvoiceDialog open onOpenChange={vi.fn()} invoiceId="inv-1" balanceOwed={100} canRefund />,
    );

    expect(screen.getByTestId('credit-refund-instead')).toBeInTheDocument();
    await user.type(document.querySelector<HTMLInputElement>('input[inputmode="decimal"]')!, '150');
    expect(screen.getByText(/\$50\.00 refunded as excess/)).toBeInTheDocument();
  });
});
