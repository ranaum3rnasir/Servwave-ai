// V7-09c: Refund for an unapplied payment (spec 7.16): an amount field, partial refunds leave the item open.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { renderWithProviders } from '@/__tests__/helpers';
import { toast } from '@/ui-kit/components/ui/sonner';

import { TabHarness, mockApi, urlSearch } from './paymentsFixtures';
import { CAPTURE_ID, PAYMENT_KEY, makeUnapplied, serveUnapplied } from './unappliedFixtures';

vi.mock('@/ui-kit/components/ui/sonner', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/ui-kit/components/ui/sonner')>()),
  toast: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn() }),
}));

const mockToast = vi.mocked(toast);
const dparam = () => new URLSearchParams(urlSearch()).get('d');
const URL_REFUND = `/api/payments-needing-attention/${CAPTURE_ID}/refund`;

async function openRefund() {
  serveUnapplied();
  const u = userEvent.setup();
  renderWithProviders(<TabHarness />, { initialEntries: [`/payments?d=item:${PAYMENT_KEY}`] });
  const drawer = await screen.findByRole('dialog', { name: 'Unapplied payment' });
  await u.click(await within(drawer).findByRole('button', { name: 'Refund' }));
  const dialog = await screen.findByRole('dialog', { name: 'Refund payment' });
  return { u, dialog, drawer };
}

beforeEach(() => {
  mockApi.get.mockReset();
  mockApi.post.mockReset();
  mockToast.success.mockReset();
});

describe('Refund an unapplied payment', () => {
  it('asks how much, starting at the whole amount, with the body sentence and no Reason or Note field', async () => {
    const { dialog } = await openRefund();
    expect(within(dialog).getByText('Return money to Dana Reyes (Visa •••• 4242). This payment is not on an invoice. This cannot be undone.')).toBeInTheDocument();
    const amount = within(dialog).getByLabelText('Amount');
    expect(amount).toHaveValue('120.00');
    expect(amount.className).toContain('text-right');
    expect(within(dialog).getByText('$120.00 left to refund')).toBeInTheDocument();
    expect(within(dialog).queryByLabelText(/Reason|Note/)).not.toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: 'Cancel' })).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: 'Refund' })).toHaveClass('bg-destructive-solid');
  });

  it('leaves out the parts it does not know', async () => {
    serveUnapplied({ unapplied: makeUnapplied({ customer_block: null, payer: null }) });
    const u = userEvent.setup();
    renderWithProviders(<TabHarness />, { initialEntries: [`/payments?d=item:${PAYMENT_KEY}`] });
    await u.click(await within(await screen.findByRole('dialog', { name: 'Unapplied payment' })).findByRole('button', { name: 'Refund' }));
    const dialog = await screen.findByRole('dialog', { name: 'Refund payment' });
    expect(within(dialog).getByText('Return money to the customer. This payment is not on an invoice. This cannot be undone.')).toBeInTheDocument();
  });

  it('zero, nothing or a negative amount says "Enter an amount above $0.00." on the field and focuses it', async () => {
    const { u, dialog } = await openRefund();
    const amount = within(dialog).getByLabelText('Amount');
    await u.clear(amount);
    await u.type(amount, '0');
    await u.click(within(dialog).getByRole('button', { name: 'Refund' }));
    expect(within(dialog).getByRole('alert')).toHaveTextContent('Enter an amount above $0.00.');
    expect(amount).toHaveAttribute('aria-invalid', 'true');
    expect(amount).toHaveFocus();
    expect(mockApi.post).not.toHaveBeenCalled();
  });

  it('more than is left says "Enter $120.00 or less."', async () => {
    const { u, dialog } = await openRefund();
    const amount = within(dialog).getByLabelText('Amount');
    await u.clear(amount);
    await u.type(amount, '120.01');
    await u.click(within(dialog).getByRole('button', { name: 'Refund' }));
    expect(within(dialog).getByRole('alert')).toHaveTextContent('Enter $120.00 or less.');
    expect(mockApi.post).not.toHaveBeenCalled();
  });

  it('the whole amount posts it, toasts, and closes the drawer', async () => {
    mockApi.post.mockResolvedValue({ data: { item: { status: 'REFUNDED' } } });
    const { u, dialog } = await openRefund();
    await u.click(within(dialog).getByRole('button', { name: 'Refund' }));
    await waitFor(() => expect(mockApi.post).toHaveBeenCalledWith(URL_REFUND, { amount: 120 }, { silentErrors: true }));
    await waitFor(() => expect(mockToast.success).toHaveBeenCalledWith('Refunded $120.00 to Dana Reyes'));
    await waitFor(() => expect(dparam()).toBeNull());
  });

  it('a part posts that amount, and the item stays open on the drawer showing what is left', async () => {
    mockApi.post.mockResolvedValue({ data: { item: { status: 'OPEN', amount: 80 } } });
    const { u, dialog } = await openRefund();
    // After the refund the server reports 80.00 still on the item.
    const base = mockApi.get.getMockImplementation()! as (url: string, c?: unknown) => unknown;
    mockApi.get.mockImplementation(((url: string, c?: unknown) =>
      url === `/api/payments-page/attention/${PAYMENT_KEY}` ? Promise.resolve({ data: makeUnapplied({ amount: 80, suggested_invoices: [] }) }) : base(url, c)) as never);
    const amount = within(dialog).getByLabelText('Amount');
    await u.clear(amount);
    await u.type(amount, '40');
    await u.click(within(dialog).getByRole('button', { name: 'Refund' }));
    await waitFor(() => expect(mockApi.post).toHaveBeenCalledWith(URL_REFUND, { amount: 40 }, { silentErrors: true }));
    await waitFor(() => expect(mockToast.success).toHaveBeenCalledWith('Refunded $40.00 to Dana Reyes'));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Refund payment' })).not.toBeInTheDocument());
    const drawer = screen.getByRole('dialog', { name: 'Unapplied payment' });
    expect(await within(drawer).findByText('$80.00', { selector: 'div' })).toBeInTheDocument();
    // Give a wrongly-closing drawer time to reach the address before asserting it is still there.
    await new Promise((r) => setTimeout(r, 150));
    expect(dparam()).toBe(`item:${PAYMENT_KEY}`);
    expect(screen.getByRole('dialog', { name: 'Unapplied payment' })).toBeInTheDocument();
    // Focus goes back to the Refund button that opened the dialog.
    await waitFor(() => expect(within(drawer).getByRole('button', { name: 'Refund' })).toHaveFocus());
  });

  it('a server refusal of the amount lands on the field; any other refusal shows in the dialog, with no success', async () => {
    mockApi.post.mockRejectedValueOnce({ isAxiosError: true, response: { status: 400, data: { error: 'Enter $120.00 or less.', field: 'amount' } } });
    const { u, dialog } = await openRefund();
    await u.click(within(dialog).getByRole('button', { name: 'Refund' }));
    expect(await within(dialog).findByText('Enter $120.00 or less.')).toBeInTheDocument();
    expect(within(dialog).getByLabelText('Amount')).toHaveAttribute('aria-invalid', 'true');
    mockApi.post.mockRejectedValueOnce({ isAxiosError: true, response: { status: 409, data: { error: 'This payment was already refunded.' } } });
    await u.click(within(dialog).getByRole('button', { name: 'Refund' }));
    expect(await within(dialog).findByText('This payment was already refunded.')).toBeInTheDocument();
    expect(mockToast.success).not.toHaveBeenCalled();
  });

  it('Enter in the field submits', async () => {
    mockApi.post.mockResolvedValue({ data: { item: { status: 'REFUNDED' } } });
    const { u, dialog } = await openRefund();
    await u.type(within(dialog).getByLabelText('Amount'), '{Enter}');
    await waitFor(() => expect(mockApi.post).toHaveBeenCalledTimes(1));
  });

  it('Escape closes only the dialog; reopening shows the full amount again', async () => {
    const { u, drawer } = await openRefund();
    const amount = screen.getByLabelText('Amount');
    await u.clear(amount);
    await u.type(amount, '5');
    await u.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Refund payment' })).not.toBeInTheDocument());
    expect(screen.getByRole('dialog', { name: 'Unapplied payment' })).toBeInTheDocument();
    await u.click(within(drawer).getByRole('button', { name: 'Refund' }));
    expect(await screen.findByLabelText('Amount')).toHaveValue('120.00');
  });

  it('no text names the payment processor', async () => {
    const { dialog } = await openRefund();
    expect(dialog.textContent).not.toMatch(/stripe/i);
  });
});
