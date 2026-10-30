import { beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useLocation } from 'react-router-dom';

import { renderWithProviders } from '@/__tests__/helpers';
import { toast } from '@/ui-kit/components/ui/sonner';

import { AttentionCard } from '../components/AttentionCard';
import { attentionCalls, makeItem, serveAttention } from './attentionFixtures';
import { makeDetail, makeRow, manyRows, mockApi } from './paymentsFixtures';

vi.mock('@/ui-kit/components/ui/sonner', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/ui-kit/components/ui/sonner')>()),
  toast: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn() }),
}));
const mockToast = vi.mocked(toast);
const mockPost = vi.mocked(mockApi.post);

function Where() {
  const { pathname, search } = useLocation();
  return <div data-testid="where">{pathname}{search}</div>;
}
const where = () => screen.getByTestId('where').textContent ?? '';
const user = () => userEvent.setup();
const ROW1 = makeRow(1);

async function openWith(item: ReturnType<typeof makeItem>, buttonName: string, entry = '/payments?payment=' + ROW1.id) {
  serveAttention({ open: [item], rows: manyRows(3) });
  const u = user();
  renderWithProviders(<><AttentionCard /><Where /></>, { initialEntries: [entry] });
  const row = within(await screen.findByRole('region', { name: /Needs attention/ })).getByRole('listitem');
  await u.click(within(row).getByRole('button', { name: buttonName }));
  const dialog = await screen.findByRole('dialog');
  return { u, dialog };
}

const failedPayment = () => makeItem(1, 'failed_payment', { actions: ['contact_customer', 'mark_resolved'] });
const failedRefund = () => makeItem(1, 'failed_refund', { actions: ['refund_again', 'mark_settled'] });
const unmatched = () => makeItem(5, 'unmatched_payment', { actions: ['refund', 'mark_resolved'], amount: 75 });
const keyOf = (item: { key: string }) => item.key;

beforeEach(() => {
  mockApi.get.mockReset();
  mockPost.mockReset();
  mockToast.success.mockReset();
  mockToast.error.mockReset();
});

describe('Contact customer', () => {
  it('asks in the spec\'s words and posts to the contact route', async () => {
    const item = failedPayment();
    mockPost.mockResolvedValue({ data: { sent: true } });
    const { u, dialog } = await openWith(item, 'Contact customer');
    expect(within(dialog).getByText('Email Customer 1 about the failed $101.00 payment on invoice INV-1001, with a link to pay again?')).toBeInTheDocument();
    const before = attentionCalls().length;
    await u.click(within(dialog).getByRole('button', { name: 'Send email' }));
    await waitFor(() => expect(mockPost).toHaveBeenCalledTimes(1));
    expect(mockPost.mock.calls[0]![0]).toBe(`/api/payments-page/attention/${keyOf(item)}/contact-customer`);
    await waitFor(() => expect(mockToast.success).toHaveBeenCalled());
    // The attention list is asked for again, the drawer closes, the dialog closes.
    await waitFor(() => expect(attentionCalls().length).toBeGreaterThan(before));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(where()).not.toContain('payment=');
  });

  it('shows a 409 inline and keeps the dialog open', async () => {
    mockPost.mockRejectedValue({ response: { status: 409, data: { error: 'Already sent a moment ago.' } } });
    const { u, dialog } = await openWith(failedPayment(), 'Contact customer');
    await u.click(within(dialog).getByRole('button', { name: 'Send email' }));
    expect(await within(dialog).findByText('Already sent a moment ago.')).toBeInTheDocument();
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(mockToast.success).not.toHaveBeenCalled();
  });

  it('a double click sends once', async () => {
    mockPost.mockImplementation(() => new Promise(() => {}));
    const { u, dialog } = await openWith(failedPayment(), 'Contact customer');
    const send = within(dialog).getByRole('button', { name: 'Send email' });
    await u.dblClick(send);
    expect(mockPost).toHaveBeenCalledTimes(1);
    expect(send).toBeDisabled();
  });
});

describe('Mark resolved and Mark settled', () => {
  it('sends the note to the resolve route', async () => {
    const item = failedPayment();
    mockPost.mockResolvedValue({ data: {} });
    const { u, dialog } = await openWith(item, 'Mark resolved');
    await u.type(within(dialog).getByLabelText('Note (optional)'), 'Paid by check');
    await u.click(within(dialog).getByRole('button', { name: 'Mark resolved' }));
    await waitFor(() => expect(mockPost).toHaveBeenCalledTimes(1));
    expect(mockPost.mock.calls[0]![0]).toBe(`/api/payments-page/attention/${keyOf(item)}/resolve`);
    expect(mockPost.mock.calls[0]![1]).toEqual({ note: 'Paid by check' });
    await waitFor(() => expect(mockToast.success).toHaveBeenCalled());
  });

  it('sends no note when none was written', async () => {
    mockPost.mockResolvedValue({ data: {} });
    const { u, dialog } = await openWith(failedPayment(), 'Mark resolved');
    await u.click(within(dialog).getByRole('button', { name: 'Mark resolved' }));
    await waitFor(() => expect(mockPost).toHaveBeenCalled());
    expect(mockPost.mock.calls[0]![1]).toEqual({});
  });

  it('focuses the note first and counts from 400 characters', async () => {
    const { u, dialog } = await openWith(failedPayment(), 'Mark resolved');
    const note = within(dialog).getByLabelText('Note (optional)');
    expect(note).toHaveFocus();
    expect(within(dialog).queryByText(/\/500/)).not.toBeInTheDocument();
    await u.click(note);
    await u.paste('x'.repeat(401));
    expect(within(dialog).getByText('401/500')).toBeInTheDocument();
  });

  it('turns the counter danger-toned once the note is over 500', async () => {
    const { u, dialog } = await openWith(failedPayment(), 'Mark resolved');
    const note = within(dialog).getByLabelText('Note (optional)');
    await u.click(note);
    await u.paste('x'.repeat(450));
    expect(within(dialog).getByText('450/500').className).not.toMatch(/text-danger/);
    await u.paste('x'.repeat(51));
    expect(within(dialog).getByText('501/500').className).toMatch(/text-danger/);
  });

  it('turns the field itself invalid as soon as the note is over 500, and back when it is not', async () => {
    const { u, dialog } = await openWith(failedPayment(), 'Mark resolved');
    const note = within(dialog).getByLabelText('Note (optional)');
    await u.click(note);
    await u.paste('x'.repeat(500));
    expect(note).not.toHaveAttribute('aria-invalid');
    await u.paste('x');
    expect(note).toHaveAttribute('aria-invalid', 'true');
    await u.type(note, '{Backspace}');
    expect(note).not.toHaveAttribute('aria-invalid');
  });

  it('refuses a note over 500 characters next to the field and sends nothing', async () => {
    const { u, dialog } = await openWith(failedPayment(), 'Mark resolved');
    const note = within(dialog).getByLabelText('Note (optional)');
    await u.click(note);
    await u.paste('x'.repeat(501));
    await u.click(within(dialog).getByRole('button', { name: 'Mark resolved' }));
    expect(await within(dialog).findByText('Keep the note to 500 characters or fewer.')).toBeInTheDocument();
    expect(note).toHaveFocus();
    expect(note).toHaveAttribute('aria-invalid', 'true');
    expect(mockPost).not.toHaveBeenCalled();
  });

  it('Mark settled words the refund and posts to the same resolve route', async () => {
    const item = failedRefund();
    mockPost.mockResolvedValue({ data: {} });
    const { u, dialog } = await openWith(item, 'Mark settled');
    expect(within(dialog).getByText('Mark the $101.00 refund to Customer 1 on invoice INV-1001 as settled? Use this when you returned the money another way.')).toBeInTheDocument();
    await u.click(within(dialog).getByRole('button', { name: 'Mark settled' }));
    await waitFor(() => expect(mockPost).toHaveBeenCalledTimes(1));
    expect(mockPost.mock.calls[0]![0]).toBe(`/api/payments-page/attention/${keyOf(item)}/resolve`);
  });

  it('unmatched money is resolved through the existing route', async () => {
    const item = unmatched();
    mockPost.mockResolvedValue({ data: { item: {} } });
    const { u, dialog } = await openWith(item, 'Mark resolved');
    await u.click(within(dialog).getByRole('button', { name: 'Mark resolved' }));
    await waitFor(() => expect(mockPost).toHaveBeenCalledTimes(1));
    expect(mockPost.mock.calls[0]![0]).toBe(`/api/payments-needing-attention/${item.key.split(':')[1]}/resolve`);
  });

  it('shows a server refusal inline', async () => {
    mockPost.mockRejectedValue({ response: { status: 409, data: { error: 'This no longer needs attention.' } } });
    const { u, dialog } = await openWith(failedPayment(), 'Mark resolved');
    await u.click(within(dialog).getByRole('button', { name: 'Mark resolved' }));
    expect(await within(dialog).findByText('This no longer needs attention.')).toBeInTheDocument();
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });

  it('starts empty again when reopened', async () => {
    const { u, dialog } = await openWith(failedPayment(), 'Mark resolved');
    await u.type(within(dialog).getByLabelText('Note (optional)'), 'Left over');
    await u.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    await u.click(screen.getByRole('button', { name: 'Mark resolved' }));
    expect(await screen.findByLabelText('Note (optional)')).toHaveValue('');
  });
});

describe('Refund again', () => {
  it('opens the refund dialog prefilled from the item and refunds that amount', async () => {
    mockPost.mockResolvedValue({ data: {} });
    const { u, dialog } = await openWith(failedRefund(), 'Refund again');
    const form = await screen.findByRole('dialog', { name: 'Refund payment' });
    expect(form).toBe(dialog);
    expect(within(form).getByLabelText('Amount')).toHaveValue('40.00');
    expect(within(form).getByRole('combobox', { name: 'Reason' })).toHaveTextContent('Goodwill');
    expect(within(form).getByLabelText('Note')).toHaveValue('Kept the customer happy');
    expect(within(form).getByText(/Return \$40\.00 to Customer 1 for invoice INV-1001/)).toBeInTheDocument();
    await u.click(within(form).getByRole('button', { name: 'Refund $40.00' }));
    await waitFor(() => expect(mockPost).toHaveBeenCalledTimes(1));
    expect(mockPost.mock.calls[0]![0]).toBe('/api/invoices/inv-1/refund');
    expect(mockPost.mock.calls[0]![1]).toEqual({ amount: 40, payment_id: ROW1.id, reason_category: 'GOODWILL', reason: 'Kept the customer happy' });
  });
});

describe('Refund again while the payment loads', () => {
  const openRefundAgain = async () => {
    const u = user();
    renderWithProviders(<><AttentionCard /><Where /></>, { initialEntries: ['/payments'] });
    const row = within(await screen.findByRole('region', { name: /Needs attention/ })).getByRole('listitem');
    await u.click(within(row).getByRole('button', { name: 'Refund again' }));
    return u;
  };

  it('shows the dialog at once, with a loading line and a confirm that waits', async () => {
    serveAttention({ open: [failedRefund()], rows: manyRows(3), detail: () => new Promise(() => {}) as never });
    await openRefundAgain();
    const dialog = screen.getByRole('dialog', { name: 'Refund payment' });
    expect(within(dialog).getByText('Loading the payment…')).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: 'Refund' })).toBeDisabled();
    expect(within(dialog).getByRole('button', { name: 'Cancel' })).toBeEnabled();
  });

  it('says so when the payment cannot be read, and Retry loads the form', async () => {
    let fail = true;
    serveAttention({
      open: [failedRefund()], rows: manyRows(3),
      detail: (id: string) => (fail ? Promise.reject(new Error('boom')) : makeDetail(manyRows(3).find((r) => r.id === id)!)),
    });
    const u = await openRefundAgain();
    const dialog = await screen.findByRole('dialog', { name: 'Refund payment' });
    expect(await within(dialog).findByText('Couldn’t load this payment.')).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: 'Refund' })).toBeDisabled();
    fail = false;
    await u.click(within(dialog).getByRole('button', { name: 'Retry' }));
    expect(await screen.findByLabelText('Amount')).toHaveValue('40.00');
    expect(screen.getByRole('button', { name: 'Refund $40.00' })).toBeEnabled();
  });
});

describe('Refund on unmatched money', () => {
  it('confirms with the amount, then refunds through the existing route', async () => {
    const item = unmatched();
    mockPost.mockResolvedValue({ data: { item: {} } });
    const { u, dialog } = await openWith(item, 'Refund');
    expect(within(dialog).getByText('$75.00 goes back to the customer.')).toBeInTheDocument();
    await u.click(within(dialog).getByRole('button', { name: 'Refund $75.00' }));
    await waitFor(() => expect(mockPost).toHaveBeenCalledTimes(1));
    expect(mockPost.mock.calls[0]![0]).toBe(`/api/payments-needing-attention/${item.key.split(':')[1]}/refund`);
    await waitFor(() => expect(mockToast.success).toHaveBeenCalledWith('Refund sent. The customer gets the money back through ServWave Payments.'));
  });
});

describe('Update bank account', () => {
  it('explains, then goes to the payout account page and calls nothing', async () => {
    const { u, dialog } = await openWith(makeItem(4, 'failed_payout', { actions: ['update_bank_account'] }), 'Update bank account');
    expect(within(dialog).getByText('Bank details are changed on the Payout account page, where they are entered securely.')).toBeInTheDocument();
    expect(within(dialog).queryByRole('textbox')).not.toBeInTheDocument();
    await u.click(within(dialog).getByRole('button', { name: 'Open payout account' }));
    expect(where()).toBe('/settings/payout-account');
    expect(mockPost).not.toHaveBeenCalled();
  });
});

describe('wording', () => {
  it('no dialog names the payment processor', async () => {
    const { dialog } = await openWith(unmatched(), 'Refund');
    expect(dialog.textContent).not.toMatch(/stripe/i);
  });
});
