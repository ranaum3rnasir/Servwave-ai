import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import api from '@/lib/axios';
import { renderWithProviders } from '@/__tests__/helpers';
import { toast } from '@/ui-kit/components/ui/sonner';

import { TabHarness, makeDetail, manyRows, mockApi, serve } from './paymentsFixtures';

vi.mock('@/ui-kit/components/ui/sonner', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/ui-kit/components/ui/sonner')>()),
  toast: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn() }),
}));
const mockToast = vi.mocked(toast);
const mockPost = vi.mocked(api.post);

const ROWS = manyRows(3);
const ROW1 = ROWS[0]!;
const user = () => userEvent.setup();

async function openRefund(over: Parameters<typeof makeDetail>[1] = {}, rowOver: Partial<typeof ROW1> = {}) {
  const row = { ...ROW1, ...rowOver };
  serve({ rows: [row, ...ROWS.slice(1)], detail: () => makeDetail(row, over) });
  const u = user();
  renderWithProviders(<TabHarness />, { initialEntries: [`/payments?payment=${ROW1.id}`] });
  await u.click(await screen.findByRole('button', { name: 'Refund' }));
  const dialog = await screen.findByRole('dialog', { name: 'Refund payment' });
  return { u, dialog };
}

const amountField = () => screen.getByLabelText('Amount') as HTMLInputElement;
const submitButton = (dialog: HTMLElement, name: RegExp = /^Refund \$/) => within(dialog).getByRole('button', { name });

beforeEach(() => {
  mockApi.get.mockReset();
  mockPost.mockReset();
  mockToast.success.mockReset();
  mockToast.error.mockReset();
});

describe('the form', () => {
  it('prefills the refundable amount and names the amount, the customer and the invoice', async () => {
    const { dialog } = await openRefund();
    expect(amountField().value).toBe('101.00');
    expect(within(dialog).getByText('$101.00 left to refund')).toBeInTheDocument();
    expect(within(dialog).getByText('Return $101.00 to Customer 1 for invoice INV-1001. This cannot be undone.')).toBeInTheDocument();
    expect(submitButton(dialog)).toHaveTextContent('Refund $101.00');
    expect(amountField()).toHaveClass('text-right');
  });

  it('follows the amount typed in the confirm text and the button', async () => {
    const { u, dialog } = await openRefund();
    await u.clear(amountField());
    await u.type(amountField(), '1');
    expect(within(dialog).getByText('Return $1.00 to Customer 1 for invoice INV-1001. This cannot be undone.')).toBeInTheDocument();
    expect(submitButton(dialog)).toHaveTextContent('Refund $1.00');
  });

  it('offers the six reasons, defaulting to Customer request, and the note follows the choice until edited', async () => {
    const { u, dialog } = await openRefund();
    const note = screen.getByLabelText('Note') as HTMLTextAreaElement;
    expect(note.value).toBe('Customer request');
    await u.click(within(dialog).getByRole('combobox', { name: 'Reason' }));
    const options = (await screen.findAllByRole('option')).map((o) => o.textContent);
    expect(options).toEqual(['Customer request', 'Billing error', 'Goodwill', 'Overpayment', 'Chargeback', 'Other']);
    await u.click(screen.getByRole('option', { name: 'Goodwill' }));
    expect(note.value).toBe('Goodwill');
    await u.clear(note);
    await u.type(note, 'Visit cancelled');
    await u.click(within(dialog).getByRole('combobox', { name: 'Reason' }));
    await u.click(await screen.findByRole('option', { name: 'Other' }));
    expect(note.value).toBe('Visit cancelled');
  });

  it('shows the bank warnings for a bank payment only', async () => {
    const { dialog } = await openRefund({ method: 'ACH', method_label: 'Bank (ACH)', date: new Date().toISOString() }, { method: 'ACH' });
    expect(within(dialog).getByText(/could be credited twice/)).toBeInTheDocument();
    expect(within(dialog).queryByText(/within 180 days/)).not.toBeInTheDocument();
  });

  it('shows neither bank warning for a card payment', async () => {
    const { dialog } = await openRefund();
    expect(within(dialog).queryByText(/could be credited twice/)).not.toBeInTheDocument();
    expect(within(dialog).queryByText(/within 180 days/)).not.toBeInTheDocument();
  });

  it('says a bank payment past 180 days cannot be refunded here, and blocks the button', async () => {
    const old = new Date(Date.now() - 200 * 86_400_000).toISOString();
    const { dialog } = await openRefund({ method: 'ACH', method_label: 'Bank (ACH)', date: old }, { method: 'ACH' });
    expect(within(dialog).getByText(/Bank payments can only be refunded within 180 days/)).toBeInTheDocument();
    expect(submitButton(dialog)).toBeDisabled();
  });
});

describe('checking the amount', () => {
  it('marks a zero amount, moves focus to the field and reads as specified', async () => {
    const { u, dialog } = await openRefund();
    await u.clear(amountField());
    await u.type(amountField(), '0');
    await u.click(submitButton(dialog));
    expect(await within(dialog).findByText('Enter an amount above $0.00.')).toBeInTheDocument();
    expect(amountField()).toHaveAttribute('aria-invalid', 'true');
    expect(amountField()).toHaveFocus();
    expect(mockPost).not.toHaveBeenCalled();
  });

  it('marks an amount over the limit with how much is left', async () => {
    const { u, dialog } = await openRefund();
    await u.clear(amountField());
    await u.type(amountField(), '101.01');
    await u.click(submitButton(dialog));
    expect(await within(dialog).findByText('Enter $101.00 or less.')).toBeInTheDocument();
    expect(amountField()).toHaveFocus();
    expect(mockPost).not.toHaveBeenCalled();
  });

  it('marks an empty note and focuses it', async () => {
    const { u, dialog } = await openRefund();
    await u.clear(screen.getByLabelText('Note'));
    await u.click(submitButton(dialog));
    expect(await within(dialog).findByText('Enter a short reason.')).toBeInTheDocument();
    expect(screen.getByLabelText('Note')).toHaveFocus();
    expect(mockPost).not.toHaveBeenCalled();
  });
});

describe('sending it', () => {
  it('sends the exact body to the invoice refund route', async () => {
    mockPost.mockResolvedValue({ data: {} });
    const { u, dialog } = await openRefund();
    await u.clear(amountField());
    await u.type(amountField(), '1');
    await u.click(submitButton(dialog));
    await waitFor(() => expect(mockPost).toHaveBeenCalledTimes(1));
    expect(mockPost).toHaveBeenCalledWith(
      '/api/invoices/inv-1/refund',
      { amount: 1, payment_id: ROW1.id, reason_category: 'CUSTOMER_REQUEST', reason: 'Customer request' },
      { silentErrors: true },
    );
  });

  it('on success toasts, closes, and refetches the summary, the list and the payment', async () => {
    mockPost.mockResolvedValue({ data: {} });
    const { u, dialog } = await openRefund();
    const before = (url: string) => mockApi.get.mock.calls.filter(([x]) => x === url).length;
    const counts = {
      summary: before('/api/payments-page/summary'),
      list: before('/api/payments-page/payments'),
      detail: before(`/api/payments-page/payments/${ROW1.id}`),
    };
    await u.clear(amountField());
    await u.type(amountField(), '1');
    await u.click(submitButton(dialog));
    await waitFor(() => expect(mockToast.success).toHaveBeenCalledWith('Refunded $1.00 to Customer 1'));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Refund payment' })).not.toBeInTheDocument());
    await waitFor(() => {
      expect(before('/api/payments-page/summary')).toBeGreaterThan(counts.summary);
      expect(before('/api/payments-page/payments')).toBeGreaterThan(counts.list);
      expect(before(`/api/payments-page/payments/${ROW1.id}`)).toBeGreaterThan(counts.detail);
    });
  });

  it('shows the server message inline and keeps the dialog open', async () => {
    mockPost.mockRejectedValue({ response: { status: 400, data: { error: 'Refund exceeds net paid' } } });
    const { u, dialog } = await openRefund();
    await u.click(submitButton(dialog));
    expect(await within(dialog).findByText('Refund exceeds net paid')).toBeInTheDocument();
    expect(screen.getByRole('dialog', { name: 'Refund payment' })).toBeInTheDocument();
    expect(mockToast.success).not.toHaveBeenCalled();
    // The person can try again.
    expect(submitButton(dialog)).toBeEnabled();
  });

  it('sends one request however fast the button is pressed twice', async () => {
    let resolve!: (v: unknown) => void;
    mockPost.mockImplementation((() => new Promise((r) => { resolve = r; })) as never);
    const { u, dialog } = await openRefund();
    const button = submitButton(dialog);
    await u.dblClick(button);
    expect(mockPost).toHaveBeenCalledTimes(1);
    resolve({ data: {} });
    await waitFor(() => expect(mockToast.success).toHaveBeenCalled());
  });

  it('shows no processor name anywhere in the dialog', async () => {
    const { dialog } = await openRefund();
    expect(dialog.textContent).not.toMatch(/stripe|ctm|supabase/i);
  });
});

describe('opening it again', () => {
  it('after a cancel, starts clean: the refundable amount, the default reason, no old error', async () => {
    mockPost.mockRejectedValue({ response: { status: 400, data: { error: 'Refund exceeds net paid' } } });
    const { u, dialog } = await openRefund();
    await u.clear(amountField());
    await u.type(amountField(), '5');
    await u.clear(screen.getByLabelText('Note'));
    await u.type(screen.getByLabelText('Note'), 'Typed note');
    await u.click(submitButton(dialog));
    expect(await within(dialog).findByText('Refund exceeds net paid')).toBeInTheDocument();
    await u.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Refund payment' })).not.toBeInTheDocument());

    await u.click(await screen.findByRole('button', { name: 'Refund' }));
    const again = await screen.findByRole('dialog', { name: 'Refund payment' });
    expect(amountField().value).toBe('101.00');
    expect((screen.getByLabelText('Note') as HTMLTextAreaElement).value).toBe('Customer request');
    expect(within(again).queryByText('Refund exceeds net paid')).not.toBeInTheDocument();
    expect(submitButton(again)).toHaveTextContent('Refund $101.00');
  });

  it('after a part refund, prefills what is left now and sends that, not the amount typed last time', async () => {
    let detailNow = makeDetail(ROW1, { refundable_amount: 101 });
    serve({ rows: ROWS, detail: () => detailNow });
    mockPost.mockImplementation((async () => {
      detailNow = makeDetail(ROW1, { refundable_amount: 100 });
      return { data: {} };
    }) as never);
    const u = user();
    renderWithProviders(<TabHarness />, { initialEntries: [`/payments?payment=${ROW1.id}`] });
    await u.click(await screen.findByRole('button', { name: 'Refund' }));
    const dialog = await screen.findByRole('dialog', { name: 'Refund payment' });
    await u.clear(amountField());
    await u.type(amountField(), '1');
    await u.click(submitButton(dialog));
    await waitFor(() => expect(mockToast.success).toHaveBeenCalledWith('Refunded $1.00 to Customer 1'));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Refund payment' })).not.toBeInTheDocument());

    await u.click(await screen.findByRole('button', { name: 'Refund' }));
    const again = await screen.findByRole('dialog', { name: 'Refund payment' });
    await waitFor(() => expect(within(again).getByText('$100.00 left to refund')).toBeInTheDocument());
    expect(amountField().value).toBe('100.00');
    expect(submitButton(again)).toHaveTextContent('Refund $100.00');
    await u.click(submitButton(again));
    await waitFor(() => expect(mockPost).toHaveBeenCalledTimes(2));
    expect(mockPost.mock.calls[1]![1]).toMatchObject({ amount: 100 });
  });
});

describe('the double-submit guard', () => {
  it('sends one request when two presses land before the screen updates', async () => {
    mockPost.mockImplementation((() => new Promise(() => {})) as never);
    const { dialog } = await openRefund();
    const button = submitButton(dialog);
    // Both clicks inside one act: React cannot re-render (and disable the button) between them.
    act(() => { button.click(); button.click(); });
    await waitFor(() => expect(mockPost).toHaveBeenCalledTimes(1));
    await new Promise((r) => setTimeout(r, 50));
    expect(mockPost).toHaveBeenCalledTimes(1);
  });
});

describe('a payment with nothing left to refund', () => {
  it('says so and offers no "Refund $0.00" button, even when a failed refund is being sent again', async () => {
    const { RefundPaymentDialog } = await import('../components/RefundPaymentDialog');
    renderWithProviders(
      <RefundPaymentDialog
        open
        onOpenChange={() => {}}
        payment={makeDetail(ROW1, { refundable_amount: 0 })}
        prefill={{ amount: 20, category: 'CUSTOMER_REQUEST', reason: 'Customer asked' }}
      />,
    );
    const dialog = await screen.findByRole('dialog', { name: 'Refund payment' });
    expect(within(dialog).getByText('Nothing is left to refund on this payment.')).toBeInTheDocument();
    expect(within(dialog).queryByRole('button', { name: /^Refund \$/ })).not.toBeInTheDocument();
    expect(within(dialog).queryByText(/^\$[\d.,]+ left to refund/)).not.toBeInTheDocument();
    expect(within(dialog).queryByText(/^Return \$/)).not.toBeInTheDocument();
  });
});
