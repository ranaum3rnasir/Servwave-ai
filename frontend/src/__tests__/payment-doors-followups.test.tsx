/**
 * Payments go-live slice 28b - the money dialogs of an invoice, in the cases the run's reviews and
 * staging acceptance found (routed v2 invoice page dialogs only):
 *   - the Refund dialog offers a hand method only when the refund is recorded by hand (a hand-paid
 *     source, or a bank payment past 180 days); a processor refund records the payment's own method;
 *   - the bank messages follow whichever payments a refund or give-back would draw from, including
 *     "Auto / oldest" when no one payment covers the amount, and in the Issue Credit dialog;
 *   - a refund the processor refuses shows the ServWave message, not the generic server-error toast;
 *   - Cancel payment confirms with a toast.
 *
 * `api` is globally mocked (setup.ts).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import api from '@/lib/axios';
import { renderWithProviders } from './helpers';
import { RefundInvoiceDialog } from '@/components/invoices/RefundInvoiceDialog';
import { CreditInvoiceDialog } from '@/components/invoices/CreditInvoiceDialog';
import { CancelBankPaymentDialog } from '@/components/invoices/CancelBankPaymentDialog';

const toastMock = vi.hoisted(() => vi.fn());
vi.mock('@/components/ui/use-toast', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/components/ui/use-toast')>();
  return { ...actual, toast: toastMock };
});

const mockApi = vi.mocked(api);

const DUAL_CREDIT_WARNING = 'If the customer also disputes this payment with their bank within 60 days, they could be credited twice.';
const WINDOW_MESSAGE = 'Bank payments can only be refunded within 180 days. Refund the customer another way, then record it here.';
const daysAgo = (days: number) => new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();

const pay = (id: string, method: string, over: Record<string, unknown> = {}) => ({
  id, amount: 200, method, paid_at: daysAgo(5), state: 'SUCCEEDED',
  paid_through_processor: method === 'CARD' || method === 'ACH', ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  mockApi.post.mockResolvedValue({ data: { success: true } });
});

describe('RefundInvoiceDialog - the hand-method picker', () => {
  it('is not offered for a refund that goes back through the processor (a card payment)', () => {
    renderWithProviders(
      <RefundInvoiceDialog open onOpenChange={vi.fn()} invoiceId="inv-1" netPaid={200} payments={[pay('c1', 'CARD')]} />,
    );
    expect(screen.queryByRole('combobox', { name: 'Refund method' })).not.toBeInTheDocument();
  });

  it('is not offered for a bank payment within 180 days', () => {
    renderWithProviders(
      <RefundInvoiceDialog open onOpenChange={vi.fn()} invoiceId="inv-1" netPaid={200} payments={[pay('b1', 'ACH')]} />,
    );
    expect(screen.queryByRole('combobox', { name: 'Refund method' })).not.toBeInTheDocument();
  });

  it('is offered when the payment was taken by hand', () => {
    renderWithProviders(
      <RefundInvoiceDialog open onOpenChange={vi.fn()} invoiceId="inv-1" netPaid={200} payments={[pay('h1', 'CASH')]} />,
    );
    expect(screen.getByRole('combobox', { name: 'Refund method' })).toBeInTheDocument();
  });

  it('is offered for a bank payment past 180 days', () => {
    renderWithProviders(
      <RefundInvoiceDialog open onOpenChange={vi.fn()} invoiceId="inv-1" netPaid={200} payments={[pay('b2', 'ACH', { paid_at: daysAgo(200) })]} />,
    );
    expect(screen.getByRole('combobox', { name: 'Refund method' })).toBeInTheDocument();
  });

  it('never sends a hand method picked earlier once the refund goes through the processor', async () => {
    const user = userEvent.setup();
    renderWithProviders(
      <RefundInvoiceDialog open onOpenChange={vi.fn()} invoiceId="inv-1" netPaid={400} payments={[pay('h1', 'CASH'), pay('c1', 'CARD')]} />,
    );
    await user.click(screen.getByRole('combobox', { name: 'Refund method' }));
    await user.click(screen.getByRole('option', { name: 'Check' }));
    // Now point the refund at the card payment: the picker goes away, and so does the choice.
    await user.click(screen.getByRole('combobox', { name: 'Reverse a specific payment' }));
    await user.click(screen.getByRole('option', { name: /Credit Card/ }));
    await user.click(screen.getByRole('combobox', { name: 'Reason category' }));
    await user.click(screen.getByRole('option', { name: 'Customer request' }));
    await user.type(screen.getByPlaceholderText(/details about this refund/i), 'Test');
    await user.click(screen.getByRole('button', { name: 'Issue Refund' }));

    await waitFor(() => expect(mockApi.post).toHaveBeenCalled());
    expect(mockApi.post.mock.calls[0][1]).not.toHaveProperty('method', 'CHECK');
    expect((mockApi.post.mock.calls[0][1] as { method?: string }).method).toBeUndefined();
  });
});

describe('RefundInvoiceDialog - "Auto / oldest" with no single payment that covers the amount', () => {
  it('warns about a second credit when a payment it would draw from is a bank payment', () => {
    renderWithProviders(
      <RefundInvoiceDialog open onOpenChange={vi.fn()} invoiceId="inv-1" netPaid={400} payments={[pay('c1', 'CARD'), pay('b1', 'ACH')]} />,
    );
    expect(screen.getByText(DUAL_CREDIT_WARNING)).toBeInTheDocument();
  });

  it('says to refund another way when one of them is a bank payment past 180 days', () => {
    renderWithProviders(
      <RefundInvoiceDialog open onOpenChange={vi.fn()} invoiceId="inv-1" netPaid={400} payments={[pay('c1', 'CARD'), pay('b2', 'ACH', { paid_at: daysAgo(200) })]} />,
    );
    expect(screen.getByText(WINDOW_MESSAGE)).toBeInTheDocument();
  });
});

describe('CreditInvoiceDialog - the bank messages for a give-back', () => {
  async function giveBack(payments: ReturnType<typeof pay>[], amount = '150') {
    const user = userEvent.setup();
    renderWithProviders(
      <CreditInvoiceDialog open onOpenChange={vi.fn()} invoiceId="inv-1" balanceOwed={100} canRefund payments={payments} refunds={[]} />,
    );
    await user.type(document.querySelector<HTMLInputElement>('input[inputmode="decimal"]')!, amount);
    return user;
  }

  it('warns about a second credit when the excess goes back to a bank payment', async () => {
    await giveBack([pay('b1', 'ACH', { amount: 300 })]);
    expect(screen.getByText(DUAL_CREDIT_WARNING)).toBeInTheDocument();
  });

  it('shows neither message when the give-back goes to a card payment', async () => {
    await giveBack([pay('c1', 'CARD', { amount: 300 })]);
    expect(screen.queryByText(DUAL_CREDIT_WARNING)).not.toBeInTheDocument();
    expect(screen.queryByText(WINDOW_MESSAGE)).not.toBeInTheDocument();
  });

  it('shows neither message when the amount only lowers the balance (nothing goes back)', async () => {
    await giveBack([pay('b1', 'ACH', { amount: 300 })], '50');
    expect(screen.queryByText(DUAL_CREDIT_WARNING)).not.toBeInTheDocument();
  });

  it('past 180 days it says to refund another way and cannot be sent until a hand method is picked', async () => {
    const user = await giveBack([pay('b2', 'ACH', { amount: 300, paid_at: daysAgo(200) })]);
    await user.type(screen.getByPlaceholderText(/details about this credit/i), 'Goodwill');
    expect(screen.getByText(WINDOW_MESSAGE)).toBeInTheDocument();
    expect(screen.getByTestId('credit-invoice-submit')).toBeDisabled();

    await user.click(screen.getByRole('combobox', { name: 'Refund method' }));
    await user.click(screen.getByRole('option', { name: 'Check' }));

    expect(screen.queryByText(WINDOW_MESSAGE)).not.toBeInTheDocument();
    expect(screen.getByTestId('credit-invoice-submit')).toBeEnabled();
  });

  it('offers no hand "Refund method" picker when the give-back goes back to a card', async () => {
    await giveBack([pay('c1', 'CARD', { amount: 300 })]);
    expect(screen.queryByRole('combobox', { name: 'Refund method' })).not.toBeInTheDocument();
  });

  it('offers no hand picker when the give-back goes back to a bank payment inside 180 days', async () => {
    await giveBack([pay('b1', 'ACH', { amount: 300 })]);
    expect(screen.queryByRole('combobox', { name: 'Refund method' })).not.toBeInTheDocument();
  });

  it('offers the picker when the money was taken by hand', async () => {
    await giveBack([pay('h1', 'CASH', { amount: 300 })]);
    expect(screen.getByRole('combobox', { name: 'Refund method' })).toBeInTheDocument();
  });

  it('never sends a hand method picked earlier once the give-back goes through the processor', async () => {
    const user = userEvent.setup();
    renderWithProviders(
      <CreditInvoiceDialog open onOpenChange={vi.fn()} invoiceId="inv-1" balanceOwed={0} canRefund payments={[pay('h1', 'CASH', { amount: 100 }), pay('c1', 'CARD', { amount: 300, paid_at: daysAgo(10) })]} refunds={[]} />,
    );
    await user.type(document.querySelector<HTMLInputElement>('input[inputmode="decimal"]')!, '350');
    await user.click(screen.getByRole('combobox', { name: 'Refund method' }));
    await user.click(screen.getByRole('option', { name: 'Check' }));
    // The amount shrinks to what the (older) card payment alone can give back: the hand payment is no longer drawn from.
    const input = document.querySelector<HTMLInputElement>('input[inputmode="decimal"]')!;
    await user.clear(input);
    await user.type(input, '150');
    await user.type(screen.getByPlaceholderText(/details about this credit/i), 'Goodwill');
    await user.click(screen.getByTestId('credit-invoice-submit'));

    await waitFor(() => expect(mockApi.post).toHaveBeenCalled());
    const sent = mockApi.post.mock.calls[0][1] as Record<string, unknown>;
    expect(sent.method).toBeUndefined();
  });
});

describe('the dialogs show the server\'s own reason for a refused request', () => {
  const refused = (message: string) => Object.assign(new Error('Request failed with status code 500'), {
    isAxiosError: true, response: { status: 500, data: { error: message } },
  });

  it('a refund the processor refuses shows the message and opts out of the generic server-error toast', async () => {
    const user = userEvent.setup();
    mockApi.post.mockRejectedValueOnce(refused("This refund couldn't be sent through ServWave Payments. Refund the customer another way, then record it here."));
    renderWithProviders(
      <RefundInvoiceDialog open onOpenChange={vi.fn()} invoiceId="inv-1" netPaid={200} payments={[pay('c1', 'CARD')]} />,
    );
    await user.click(screen.getByRole('combobox', { name: 'Reason category' }));
    await user.click(screen.getByRole('option', { name: 'Customer request' }));
    await user.type(screen.getByPlaceholderText(/details about this refund/i), 'Test');
    await user.click(screen.getByRole('button', { name: 'Issue Refund' }));

    expect(await screen.findByText(/couldn't be sent through ServWave Payments/)).toBeInTheDocument();
    expect(mockApi.post).toHaveBeenCalledWith('/api/invoices/inv-1/refund', expect.any(Object), { silentErrors: true });
  });

  it('a give-back the processor refuses opts out of the generic toast too', async () => {
    const user = userEvent.setup();
    renderWithProviders(
      <CreditInvoiceDialog open onOpenChange={vi.fn()} invoiceId="inv-1" balanceOwed={0} canRefund payments={[pay('c1', 'CARD')]} refunds={[]} />,
    );
    await user.type(document.querySelector<HTMLInputElement>('input[inputmode="decimal"]')!, '30');
    await user.type(screen.getByPlaceholderText(/details about this credit/i), 'Goodwill');
    await user.click(screen.getByTestId('credit-invoice-submit'));

    await waitFor(() => expect(mockApi.post).toHaveBeenCalled());
    expect(mockApi.post).toHaveBeenCalledWith('/api/invoices/inv-1/credit', expect.any(Object), { silentErrors: true });
  });
});

describe('CancelBankPaymentDialog - confirmation', () => {
  it('confirms with a toast once the payment is cancelled', async () => {
    const user = userEvent.setup();
    renderWithProviders(
      <CancelBankPaymentDialog open onOpenChange={vi.fn()} invoiceId="inv-1" payment={{ id: 'pay-ach', amount: 250 }} />,
    );

    await user.click(screen.getByRole('button', { name: 'Cancel payment' }));

    await waitFor(() => expect(toastMock).toHaveBeenCalledWith(expect.objectContaining({ title: 'Bank payment cancelled' })));
    expect(JSON.stringify(toastMock.mock.calls)).not.toMatch(/stripe/i);
  });
});
