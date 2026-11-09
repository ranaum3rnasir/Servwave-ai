import { beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useLocation } from 'react-router-dom';

import { renderWithProviders } from '@/__tests__/helpers';
import { buildAbility } from '@/lib/ability';
import { toast } from '@/ui-kit/components/ui/sonner';

import { makeItem, serveAttention, findCard, CardWithDrawer } from './attentionFixtures';
import { makeDetail, makeRow, manyRows, mockApi } from './paymentsFixtures';

vi.mock('@/ui-kit/components/ui/sonner', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/ui-kit/components/ui/sonner')>()),
  toast: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn() }),
}));
vi.mock('@/lib/api/shared/mySwitches', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api/shared/mySwitches')>()),
  useMySwitches: () => ({ admin_box: false, values: { view_customers: true, contact_customers: true, show_text: true, show_email: true } }),
}));
vi.mock('@/lib/entitlements', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/entitlements')>()),
  useFeature: () => true,
}));
const INBOX = buildAbility([{ action: 'access_inbox', subject: 'Communication' }]);
const mockToast = vi.mocked(toast);
const mockPost = vi.mocked(mockApi.post);

function Where() {
  const { pathname, search, hash } = useLocation();
  return <div data-testid="where">{pathname}{search}{hash}</div>;
}
const where = () => screen.getByTestId('where').textContent ?? '';
const user = () => userEvent.setup();
const ROW1 = makeRow(1);

async function openWith(item: ReturnType<typeof makeItem>, buttonName: string, entry = '/payments') {
  serveAttention({ open: [item], rows: manyRows(3) });
  const u = user();
  renderWithProviders(<><CardWithDrawer /><Where /></>, { initialEntries: [entry] });
  const row = within(await findCard()).getByRole('listitem');
  await u.click(within(row).getByRole('button', { name: buttonName }));
  const dialog = await screen.findByRole('dialog');
  return { u, dialog };
}

const failedPayment = () => makeItem(1, 'failed_payment', { actions: ['contact_customer', 'mark_resolved'] });
const failedRefund = () => makeItem(1, 'failed_refund', { actions: ['refund_again', 'mark_resolved'] });
const unmatched = () => makeItem(5, 'unmatched_payment', { actions: ['refund', 'mark_resolved'], amount: 75 });
const keyOf = (item: { key: string }) => item.key;

beforeEach(() => {
  mockApi.get.mockReset();
  mockPost.mockReset();
  mockToast.success.mockReset();
  mockToast.error.mockReset();
});

describe('Contact customer (V7-07a: a dialog that sends nothing)', () => {
  const BLOCK = {
    restricted: false as const, id: 'cust-1', customer_number: 'C-1001', name: 'Dana Reyes', company: null, address: null,
    phone: '5551234567', email: 'dana@example.com', job: null, lead: null, invoice: { id: 'inv-1', number: 'INV-1001' },
  };
  const COMPOSE = { subject: 'Bank payment failed - Invoice INV-1001', body: 'Hi Dana, your bank payment failed.' };
  const serveBlock = (block: unknown) => {
    const base = mockApi.get.getMockImplementation()!;
    mockApi.get.mockImplementation(((url: string, config?: unknown) => {
      if (url === `/api/payments-page/payments/${ROW1.id}`) return Promise.resolve({ data: makeDetail(ROW1, { customer_block: block as never }) });
      return (base as (...a: unknown[]) => unknown)(url, config);
    }) as never);
  };
  const openContact = async (over: Partial<ReturnType<typeof failedPayment>> = {}, block: unknown = BLOCK) => {
    const item = { ...failedPayment(), payment_id: ROW1.id, compose: COMPOSE, ...over };
    serveAttention({ open: [item], rows: manyRows(3) });
    serveBlock(block);
    const u = user();
    renderWithProviders(<><CardWithDrawer /><Where /></>, { initialEntries: ['/payments'], ability: INBOX });
    const row = within(await findCard()).getByRole('listitem');
    await u.click(within(row).getByRole('button', { name: 'Contact customer' }));
    return { u, dialog: await screen.findByRole('dialog', { name: 'Contact customer' }) };
  };

  it('shows the customer with Call and Text by the phone, Email by the address, and Close; no confirm, nothing posted, no toast', async () => {
    const { dialog } = await openContact();
    expect(await within(dialog).findByText('Dana Reyes')).toBeInTheDocument();
    expect(within(dialog).getByText('(555) 123-4567')).toBeInTheDocument();
    expect(within(dialog).getByText('dana@example.com')).toBeInTheDocument();
    expect(within(dialog).getByRole('link', { name: /^Email/ })).toBeInTheDocument();
    expect(within(dialog).queryByRole('button', { name: /Send email/ })).not.toBeInTheDocument();
    expect(within(dialog).getAllByRole('button', { name: 'Close' }).length).toBeGreaterThan(0);
    expect(mockPost).not.toHaveBeenCalled();
    expect(mockToast.success).not.toHaveBeenCalled();
  });

  it('Email opens the compose window with the server\'s subject and body', async () => {
    const { dialog } = await openContact();
    const href = new URL((await within(dialog).findByRole('link', { name: /^Email/ })).getAttribute('href')!, 'http://h');
    expect(href.searchParams.get('subject')).toBe(COMPOSE.subject);
    expect(href.searchParams.get('body')).toBe(COMPOSE.body);
    expect(href.searchParams.get('to')).toBe('dana@example.com');
    expect(href.searchParams.get('invoiceId')).toBe('inv-1');
  });

  it('a customer with no phone or email reads the two "No ... on file" lines with dimmed buttons', async () => {
    const { dialog } = await openContact({}, { ...BLOCK, phone: null, email: null });
    expect(await within(dialog).findByText('No phone on file')).toBeInTheDocument();
    expect(within(dialog).getByText('No email on file')).toBeInTheDocument();
    for (const name of ['Call', 'Text', 'Email']) expect(within(dialog).getByRole('button', { name })).toHaveAttribute('aria-disabled', 'true');
  });

  it('Close closes it without sending, and it can be opened again', async () => {
    const { u, dialog } = await openContact();
    await within(dialog).findByText('Dana Reyes');
    await u.click(within(dialog).getAllByRole('button', { name: 'Close' }).at(-1)!);
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    await u.click(within(within(await findCard()).getByRole('listitem')).getByRole('button', { name: 'Contact customer' }));
    expect(await screen.findByRole('dialog', { name: 'Contact customer' })).toBeInTheDocument();
    expect(mockPost).not.toHaveBeenCalled();
  });

  it('a payment that cannot be loaded shows an error with Retry', async () => {
    const item = { ...failedPayment(), payment_id: ROW1.id };
    serveAttention({ open: [item], rows: manyRows(3) });
    const base = mockApi.get.getMockImplementation()!;
    mockApi.get.mockImplementation(((url: string, config?: unknown) =>
      url === `/api/payments-page/payments/${ROW1.id}` ? Promise.reject(new Error('boom')) : (base as (...a: unknown[]) => unknown)(url, config)) as never);
    const u = user();
    renderWithProviders(<><CardWithDrawer /><Where /></>, { initialEntries: ['/payments'] });
    await u.click(within(within(await findCard()).getByRole('listitem')).getByRole('button', { name: 'Contact customer' }));
    const dialog = await screen.findByRole('dialog', { name: 'Contact customer' });
    expect(await within(dialog).findByText('Couldn’t load the customer.')).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: 'Retry' })).toBeInTheDocument();
  });
});

describe('Mark resolved', () => {
  const reasonOptions = async (u: ReturnType<typeof user>, dialog: HTMLElement) => {
    await u.click(within(dialog).getByRole('combobox', { name: 'Reason' }));
    const texts = (await screen.findAllByRole('option')).map((o) => o.textContent);
    await u.keyboard('{Escape}');
    return texts;
  };

  it('is titled "Mark as resolved", says no money moves, and has one Reason field and no note', async () => {
    const { dialog } = await openWith(failedPayment(), 'Mark resolved');
    expect(within(dialog).getByRole('heading', { name: 'Mark as resolved' })).toBeInTheDocument();
    expect(within(dialog).getByText('Close this item without moving any money. It moves to Resolved items.')).toBeInTheDocument();
    expect(within(dialog).getByRole('combobox', { name: 'Reason' })).toHaveTextContent('Handled outside ServWave');
    expect(within(dialog).queryByRole('textbox')).not.toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: 'Cancel' })).toBeInTheDocument();
    expect(dialog.textContent ?? '').not.toMatch(/settle/i);
  });

  it('offers the three reasons for a failed payment and sends the first one chosen on open', async () => {
    const item = failedPayment();
    mockPost.mockResolvedValue({ data: {} });
    const { u, dialog } = await openWith(item, 'Mark resolved');
    expect(await reasonOptions(u, dialog)).toEqual(['Handled outside ServWave', 'Duplicate entry', 'Not our payment']);
    await u.click(within(dialog).getByRole('button', { name: 'Mark resolved' }));
    await waitFor(() => expect(mockPost).toHaveBeenCalledTimes(1));
    expect(mockPost.mock.calls[0]![0]).toBe(`/api/payments-page/attention/${keyOf(item)}/resolve`);
    expect(mockPost.mock.calls[0]![1]).toEqual({ reason: 'Handled outside ServWave' });
    await waitFor(() => expect(mockToast.success).toHaveBeenCalledWith('Marked as resolved'));
  });

  it('sends the reason the person picked', async () => {
    mockPost.mockResolvedValue({ data: {} });
    const { u, dialog } = await openWith(failedPayment(), 'Mark resolved');
    await u.click(within(dialog).getByRole('combobox', { name: 'Reason' }));
    await u.click(await screen.findByRole('option', { name: 'Duplicate entry' }));
    await u.click(within(dialog).getByRole('button', { name: 'Mark resolved' }));
    await waitFor(() => expect(mockPost).toHaveBeenCalled());
    expect(mockPost.mock.calls[0]![1]).toEqual({ reason: 'Duplicate entry' });
  });

  it('a failed refund offers its own two reasons, first "Returned the money another way"', async () => {
    const item = failedRefund();
    mockPost.mockResolvedValue({ data: {} });
    const { u, dialog } = await openWith(item, 'Mark resolved');
    expect(await reasonOptions(u, dialog)).toEqual(['Returned the money another way', 'Handled outside ServWave']);
    await u.click(within(dialog).getByRole('button', { name: 'Mark resolved' }));
    await waitFor(() => expect(mockPost).toHaveBeenCalledTimes(1));
    expect(mockPost.mock.calls[0]![0]).toBe(`/api/payments-page/attention/${keyOf(item)}/resolve`);
    expect(mockPost.mock.calls[0]![1]).toEqual({ reason: 'Returned the money another way' });
  });

  it('unmatched money sends the reason to its own door', async () => {
    const item = unmatched();
    mockPost.mockResolvedValue({ data: { item: {} } });
    const { u, dialog } = await openWith(item, 'Mark resolved');
    expect(await reasonOptions(u, dialog)).toEqual(['Handled outside ServWave', 'Duplicate entry', 'Not our payment']);
    await u.click(within(dialog).getByRole('button', { name: 'Mark resolved' }));
    await waitFor(() => expect(mockPost).toHaveBeenCalledTimes(1));
    expect(mockPost.mock.calls[0]![0]).toBe(`/api/payments-needing-attention/${item.key.split(':')[1]}/resolve`);
    expect(mockPost.mock.calls[0]![1]).toEqual({ reason: 'Handled outside ServWave' });
  });

  it('moves focus to the "Needs attention" heading once the item is resolved', async () => {
    mockPost.mockResolvedValue({ data: {} });
    const { u, dialog } = await openWith(failedPayment(), 'Mark resolved');
    await u.click(within(dialog).getByRole('button', { name: 'Mark resolved' }));
    await waitFor(() => expect(screen.getByRole('heading', { name: /Needs attention/ })).toHaveFocus());
    expect(screen.getByRole('heading', { name: /Needs attention/ })).toHaveAttribute('tabindex', '-1');
  });

  it('shows a server refusal inline', async () => {
    mockPost.mockRejectedValue({ response: { status: 409, data: { error: 'This no longer needs attention.' } } });
    const { u, dialog } = await openWith(failedPayment(), 'Mark resolved');
    await u.click(within(dialog).getByRole('button', { name: 'Mark resolved' }));
    expect(await within(dialog).findByText('This no longer needs attention.')).toBeInTheDocument();
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });

  it('starts clean again when reopened', async () => {
    const { u, dialog } = await openWith(failedPayment(), 'Mark resolved');
    await u.click(within(dialog).getByRole('combobox', { name: 'Reason' }));
    await u.click(await screen.findByRole('option', { name: 'Not our payment' }));
    expect(within(dialog).getByRole('combobox', { name: 'Reason' })).toHaveTextContent('Not our payment');
    await u.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    await u.click(screen.getByRole('button', { name: 'Mark resolved' }));
    expect(await screen.findByRole('combobox', { name: 'Reason' })).toHaveTextContent('Handled outside ServWave');
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
    renderWithProviders(<><CardWithDrawer /><Where /></>, { initialEntries: ['/payments'] });
    const row = within(await findCard()).getByRole('listitem');
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
  it('opens the amount dialog, then refunds that amount through the existing route', async () => {
    const item = unmatched();
    mockPost.mockResolvedValue({ data: { item: {} } });
    const { u, dialog } = await openWith(item, 'Refund');
    expect(within(dialog).getByLabelText('Amount')).toHaveValue('75.00');
    await u.click(within(dialog).getByRole('button', { name: 'Refund' }));
    await waitFor(() => expect(mockPost).toHaveBeenCalledTimes(1));
    expect(mockPost.mock.calls[0]![0]).toBe(`/api/payments-needing-attention/${item.key.split(':')[1]}/refund`);
    expect(mockPost.mock.calls[0]![1]).toEqual({ amount: 75 });
    await waitFor(() => expect(mockToast.success).toHaveBeenCalledWith('Refunded $75.00'));
  });
});

describe('Update bank account', () => {
  it('explains, then goes to the payout account page and calls nothing', async () => {
    const { u, dialog } = await openWith(makeItem(4, 'failed_payout', { actions: ['update_bank_account'] }), 'Update bank account');
    expect(within(dialog).getByText('Bank details are changed on the Payout account page, where they are entered securely.')).toBeInTheDocument();
    expect(within(dialog).queryByRole('textbox')).not.toBeInTheDocument();
    await u.click(within(dialog).getByRole('button', { name: 'Open payout account' }));
    expect(where()).toBe('/settings/servwave-payments#payout-account');
    expect(mockPost).not.toHaveBeenCalled();
  });
});

describe('wording', () => {
  it('no dialog names the payment processor', async () => {
    const { dialog } = await openWith(unmatched(), 'Refund');
    expect(dialog.textContent).not.toMatch(/stripe/i);
  });
});
