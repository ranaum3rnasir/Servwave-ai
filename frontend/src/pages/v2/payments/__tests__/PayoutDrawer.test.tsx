import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { buildAbility } from '@/lib/ability';
import { renderWithProviders } from '@/__tests__/helpers';

import { mockApi, urlSearch } from './paymentsFixtures';
import {
  PayoutsHarness, makePayout, makePayoutPayment, payoutPaymentCalls, servePayouts,
} from './payoutsFixtures';

let switches: Record<string, boolean> = {};
vi.mock('@/lib/api/shared/mySwitches', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api/shared/mySwitches')>()),
  useMySwitches: () => ({ admin_box: false, values: switches }),
}));

const user = () => userEvent.setup();
const OWNER = buildAbility([{ action: 'manage_payout_account', subject: 'Organization' }, { action: 'view_payments', subject: 'Organization' }]);
const FAILED = makePayout(1, { status: 'FAILED' });
const PAID = makePayout(2);
const open = (entry: string, ability = OWNER) => renderWithProviders(<PayoutsHarness />, { initialEntries: [entry], ability });
const drawer = (name: string) => screen.findByRole('dialog', { name });

beforeEach(() => {
  switches = {};
  mockApi.get.mockReset();
  servePayouts({ payouts: [FAILED, PAID, ...Array.from({ length: 10 }, (_, i) => makePayout(i + 3))] });
});

describe('the header', () => {
  it('names the payout by reference, with date, destination, status and the big amount', async () => {
    open(`/payments?tab=payouts&payout=${PAID.id}`);
    const dialog = await drawer('Payout PO-000002');
    expect(within(dialog).getByText('Chase ending 4242', { exact: false })).toBeInTheDocument();
    expect(within(dialog).getByText('Paid')).toBeInTheDocument();
    expect(within(dialog).getAllByText('$1,002.00').length).toBeGreaterThan(0);
  });

  it('shows the failure alert with the lead and the reason in ONE element, and no alert for a paid payout', async () => {
    open(`/payments?tab=payouts&payout=${FAILED.id}`);
    const dialog = await drawer('Payout PO-000001');
    const alert = await within(dialog).findByRole('alert');
    expect(alert.textContent).toContain('Payout failed. The bank account could not be credited.');
    // The lead and the text are one flex item, so they never split into two squeezed columns.
    const lead = within(alert).getByText('Payout failed.');
    expect(lead.parentElement).not.toBe(alert);
    expect(lead.parentElement!.textContent).toContain('The bank account could not be credited.');
  });

  it('a paid payout has no alert', async () => {
    open(`/payments?tab=payouts&payout=${PAID.id}`);
    const dialog = await drawer('Payout PO-000002');
    await within(dialog).findByText('Payer 1');
    expect(within(dialog).queryByRole('alert')).not.toBeInTheDocument();
  });
});

describe('Update bank account', () => {
  it('a failed payout offers it as a button that opens the Update bank account dialog, then goes to the payout account page', async () => {
    open(`/payments?tab=payouts&payout=${FAILED.id}`);
    const dialog = await drawer('Payout PO-000001');
    const button = await within(dialog).findByRole('button', { name: 'Update bank account' });
    expect(button.className).toContain('max-md:min-h-11');
    expect(within(dialog).getByRole('button', { name: 'Close' })).toBeInTheDocument();
    await user().click(button);
    const ask = await screen.findByRole('dialog', { name: 'Update bank account' });
    expect(within(ask).getByText('Bank details are changed on the Payout account page, where they are entered securely.')).toBeInTheDocument();
    await user().click(within(ask).getByRole('button', { name: 'Open payout account' }));
    expect(urlSearch()).toBe('');
    expect(mockApi.post).not.toHaveBeenCalled();
  });

  it('is not offered when the actions of the payout do not allow it (the server decides, not the page ability): only Close', async () => {
    servePayouts({ payouts: [FAILED, PAID], canUpdateBank: false });
    open(`/payments?tab=payouts&payout=${FAILED.id}`, OWNER);
    const dialog = await drawer('Payout PO-000001');
    await within(dialog).findByText('Payer 1');
    expect(within(dialog).queryByRole('button', { name: 'Update bank account' })).not.toBeInTheDocument();
    expect(within(dialog).getAllByRole('button').map((b) => b.textContent)).toContain('Close');
  });

  it('is not offered on a payout that did not fail', async () => {
    open(`/payments?tab=payouts&payout=${PAID.id}`);
    const dialog = await drawer('Payout PO-000002');
    await within(dialog).findByText('Payer 1');
    expect(within(dialog).queryByRole('button', { name: 'Update bank account' })).not.toBeInTheDocument();
  });
});

describe('the payments inside', () => {
  const BIG = Array.from({ length: 300 }, (_, i) => makePayoutPayment(i + 1, { amount: 10 + (i % 5), fee: 1, net: 9 + (i % 5) }));
  const TOTALS = { amount: 4321.5, fee: 300, net: 4021.5 };

  beforeEach(() => {
    servePayouts({ payouts: [PAID], paymentsOf: { [PAID.id]: BIG }, totals: TOTALS });
  });

  it('pages 300 payments 25 at a time, with Previous and Next and no duplicates', async () => {
    const u = user();
    open(`/payments?tab=payouts&payout=${PAID.id}`);
    const dialog = await drawer('Payout PO-000002');
    expect(await within(dialog).findByText('300 payments in this payout')).toBeInTheDocument();
    const seen = new Set<string>();
    const pageNames = () => within(dialog).getAllByText(/^Payer \d+$/).map((n) => n.textContent!);
    expect(pageNames()).toHaveLength(25);
    pageNames().forEach((n) => seen.add(n));
    expect(within(dialog).getByRole('button', { name: 'Previous page' })).toBeDisabled();
    expect(within(dialog).getByText('Page 1 of 12')).toBeInTheDocument();

    await u.click(within(dialog).getByRole('button', { name: 'Next page' }));
    await within(dialog).findByText('Payer 26');
    expect(payoutPaymentCalls(PAID.id).at(-1)).toEqual({ page: 2, limit: 25 });
    expect(pageNames()).toHaveLength(25);
    pageNames().forEach((n) => { expect(seen.has(n), n).toBe(false); seen.add(n); });
    expect(within(dialog).getByText('Page 2 of 12')).toBeInTheDocument();

    await u.click(within(dialog).getByRole('button', { name: 'Previous page' }));
    await within(dialog).findByText('Payer 1');
    expect(within(dialog).getByText('Page 1 of 12')).toBeInTheDocument();
  });

  it('the footer totals are the API\'s whole-payout totals, not the sum of the visible page', async () => {
    open(`/payments?tab=payouts&payout=${PAID.id}`);
    const dialog = await drawer('Payout PO-000002');
    await within(dialog).findByText('Payer 1');
    const footer = dialog.querySelector('tfoot')!;
    expect(within(footer as HTMLElement).getByText('$4,321.50')).toBeInTheDocument();
    expect(within(footer as HTMLElement).getByText('-$300.00')).toBeInTheDocument();
    expect(within(footer as HTMLElement).getByText('$4,021.50')).toBeInTheDocument();
    // The visible page alone would sum to far less than the whole payout.
    const visibleAmount = BIG.slice(0, 25).reduce((t, r) => t + r.amount, 0);
    expect(visibleAmount).toBeLessThan(TOTALS.amount);
  });

  it('shows columns Customer over invoice, Amount, Fee and Net with money right-aligned', async () => {
    open(`/payments?tab=payouts&payout=${PAID.id}`);
    const dialog = await drawer('Payout PO-000002');
    await within(dialog).findByText('Payer 1');
    expect(within(dialog).getAllByRole('columnheader').map((h) => h.textContent)).toEqual(['Customer', 'Amount', 'Fee', 'Net']);
    const row = within(dialog).getByText('Payer 1').closest('tr')!;
    expect(within(row).getByText('INV-2001')).toBeInTheDocument();
    expect(within(row).getByText('$10.00')).toHaveClass('text-right', 'tabular-nums');
  });

  it('a failed page load shows Retry inside the drawer', async () => {
    const u = user();
    mockApi.get.mockImplementation(((url: string) => {
      if (url === `/api/payments-page/payouts/${PAID.id}/payments`) return Promise.reject(new Error('boom'));
      if (url === `/api/payments-page/payouts/${PAID.id}`) return Promise.resolve({ data: { ...PAID, failure_text: null, actions: { update_bank_account: false }, totals: TOTALS, net_matches_payout: true, net_difference: 0 } });
      return Promise.resolve({ data: {} });
    }) as never);
    open(`/payments?tab=payouts&payout=${PAID.id}`);
    const dialog = await drawer('Payout PO-000002');
    expect(await within(dialog).findByText('Couldn’t load the payments in this payout.')).toBeInTheDocument();
    await u.click(within(dialog).getByRole('button', { name: 'Retry' }));
    expect(payoutPaymentCalls(PAID.id).length).toBeGreaterThan(1);
  });
});

describe('rows', () => {
  const RESTRICTED = makePayoutPayment(1, { restricted: true, customer: null, invoice: null });
  const NORMAL = makePayoutPayment(2);

  beforeEach(() => {
    servePayouts({ payouts: [PAID], paymentsOf: { [PAID.id]: [RESTRICTED, NORMAL] } });
  });

  it('a Restricted row shows the lock, is not clickable and not focusable', async () => {
    const u = user();
    open(`/payments?tab=payouts&payout=${PAID.id}`);
    const dialog = await drawer('Payout PO-000002');
    const restricted = (await within(dialog).findByText('Restricted')).closest('tr')!;
    expect(restricted).not.toHaveAttribute('tabindex');
    await u.click(restricted);
    expect(urlSearch()).not.toContain('payment');
  });

  it('a normal row pushes the Payment onto the Payout and puts both in the address', async () => {
    const u = user();
    open(`/payments?tab=payouts&payout=${PAID.id}`);
    const dialog = await drawer('Payout PO-000002');
    await u.click(await within(dialog).findByText('Payer 2'));
    await waitFor(() => expect(new URLSearchParams(urlSearch()).get('d')).toBe(`payout:${PAID.id},payment:${NORMAL.id}`));
    // The same drawer now shows the Payment, with Back to the Payout.
    expect(await screen.findByRole('dialog', { name: /^Payment PMT-/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Back to Payout' })).toBeInTheDocument();
  });

  it('a voided row says so and counts nothing', async () => {
    servePayouts({ payouts: [PAID], paymentsOf: { [PAID.id]: [makePayoutPayment(3, { voided: true, amount: 0, fee: 0, net: 0, charged_amount: 100 })] } });
    open(`/payments?tab=payouts&payout=${PAID.id}`);
    const dialog = await drawer('Payout PO-000002');
    const row = (await within(dialog).findByText('Payer 3')).closest('tr')!;
    expect(within(row).getByText('Voided')).toBeInTheDocument();
  });

  it('counts the voided rows it lists and says so, so the heading matches the rows', async () => {
    servePayouts({
      payouts: [PAID],
      paymentsOf: { [PAID.id]: [
        makePayoutPayment(3), makePayoutPayment(4), makePayoutPayment(5, { voided: true, amount: 0, fee: 0, net: 0, charged_amount: 100 }),
      ] },
    });
    open(`/payments?tab=payouts&payout=${PAID.id}`);
    const dialog = await drawer('Payout PO-000002');
    expect(await within(dialog).findByText('2 payments in this payout · 1 voided')).toBeInTheDocument();
    expect(dialog.querySelectorAll('tbody tr')).toHaveLength(3);
  });
});

describe('closing', () => {
  it('Close removes ?payout= and returns focus to the payout row', async () => {
    const u = user();
    open('/payments?tab=payouts');
    const row = (await screen.findByText('PO-000002')).closest('tr')!;
    await u.click(row);
    const dialog = await drawer('Payout PO-000002');
    await within(dialog).findByText('Payer 1');
    await u.click(within(dialog).getByRole('button', { name: 'Close' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(urlSearch()).not.toContain('d=');
    await waitFor(() => expect(row).toHaveFocus());
  });

  it('Escape closes it too', async () => {
    const u = user();
    open(`/payments?tab=payouts&payout=${PAID.id}`);
    await drawer('Payout PO-000002');
    await u.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(urlSearch()).not.toContain('d=');
  });

  it('says so when the payout cannot be read, with Retry and Close', async () => {
    servePayouts({ detailError: true });
    open('/payments?tab=payouts&payout=00000000-0000-4000-9000-0000000000ff');
    expect(await screen.findByText('Couldn’t load this payout.')).toBeInTheDocument();
    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getAllByRole('button').map((b) => b.getAttribute('aria-label') ?? b.textContent)).toEqual(['Close drawer', 'Retry', 'Close']);
  });
});

describe('reload', () => {
  it('?d= with a payout and a payment settles without hanging: one drawer, the payment on top, Back to the payout', async () => {
    const pay = makePayoutPayment(2);
    servePayouts({ payouts: [PAID], paymentsOf: { [PAID.id]: [pay] } });
    open(`/payments?tab=payouts&d=payout:${PAID.id},payment:${pay.id}`);
    expect(await screen.findByRole('dialog', { name: /^Payment PMT-/ })).toBeInTheDocument();
    expect(screen.getAllByRole('dialog', { hidden: true })).toHaveLength(1);
    expect(screen.getByRole('button', { name: 'Back to Payout' })).toBeInTheDocument();
  });
});

describe('keyboard', () => {
  it('a payment row is a tab stop and Enter opens it', async () => {
    servePayouts({ payouts: [PAID], paymentsOf: { [PAID.id]: [makePayoutPayment(2)] } });
    open(`/payments?tab=payouts&payout=${PAID.id}`);
    const dialog = await drawer('Payout PO-000002');
    const row = (await within(dialog).findByText('Payer 2')).closest('tr')!;
    expect(row).toHaveAttribute('tabindex', '0');
    row.focus();
    fireEvent.keyDown(row, { key: 'Enter' });
    await waitFor(() => expect(new URLSearchParams(urlSearch()).get('d')).toContain(',payment:'));
  });
});

describe('the customer ID under each payment row (V7-07a)', () => {
  it('is a new-tab link to the customer for a person who may view customers, and opening it does not open the payment', async () => {
    switches = { view_customers: true };
    open(`/payments?tab=payouts&payout=${PAID.id}`);
    const dialog = await drawer('Payout PO-000002');
    await within(dialog).findByText('Payer 1');
    const link = within(dialog).getAllByRole('link', { name: /^C-3001/ })[0]!;
    expect(link).toHaveAttribute('href', '/customers/c1');
    expect(link).toHaveAttribute('target', '_blank');
    await user().click(link);
    expect(screen.getByRole('dialog', { name: 'Payout PO-000002' })).toBeInTheDocument();
    expect(new URLSearchParams(urlSearch()).get('d')).toBe(`payout:${PAID.id}`);
  });

  it('is plain text for a person who may not view customers, and a restricted row shows none', async () => {
    servePayouts({
      payouts: [PAID],
      paymentsOf: { [PAID.id]: [makePayoutPayment(1), makePayoutPayment(2, { restricted: true, customer: null, invoice: null })] },
    });
    open(`/payments?tab=payouts&payout=${PAID.id}`);
    const dialog = await drawer('Payout PO-000002');
    await within(dialog).findByText('Payer 1');
    expect(within(dialog).getByText('C-3001')).toBeInTheDocument();
    expect(within(dialog).queryByRole('link', { name: /C-3001/ })).not.toBeInTheDocument();
    expect(within(dialog).queryByText('C-3002')).not.toBeInTheDocument();
  });
});
