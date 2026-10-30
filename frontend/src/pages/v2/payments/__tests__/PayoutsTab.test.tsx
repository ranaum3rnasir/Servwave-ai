import { beforeEach, describe, expect, it } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { buildAbility } from '@/lib/ability';
import { renderWithProviders } from '@/__tests__/helpers';

import { mockApi, urlSearch } from './paymentsFixtures';
import {
  PayoutsHarness, makePayout, payoutListCalls, servePayouts,
} from './payoutsFixtures';

const user = () => userEvent.setup();
const OWNER = buildAbility([{ action: 'manage_payout_account', subject: 'Organization' }, { action: 'view_payments', subject: 'Organization' }, { action: 'read', subject: 'Prices' }]);
const open = (entry = '/payments?tab=payouts', ability = OWNER) =>
  renderWithProviders(<PayoutsHarness />, { initialEntries: [entry], ability });
const bodyRows = () => within(screen.getAllByRole('rowgroup')[1]!).getAllByRole('row');

beforeEach(() => {
  mockApi.get.mockReset();
  servePayouts();
});

describe('the payouts list', () => {
  it('pages the 60-payout fixture on the server, 25 at a time, and ignores the period', async () => {
    const u = user();
    open();
    await screen.findByText('PO-000001');
    expect(bodyRows()).toHaveLength(25);
    expect(payoutListCalls().at(-1)).toEqual({ page: 1, limit: 25 });
    await u.click(screen.getAllByRole('button', { name: 'Next page' })[0]!);
    await waitFor(() => expect(payoutListCalls().at(-1)).toEqual({ page: 2, limit: 25 }));
    expect(await screen.findByText('PO-000026')).toBeInTheDocument();
    expect(screen.queryByText('PO-000001')).not.toBeInTheDocument();
    for (const call of payoutListCalls()) {
      expect(call).not.toHaveProperty('from');
      expect(call).not.toHaveProperty('to');
    }
  });

  it('shows date with the reference under it, status, destination and a right-aligned amount', async () => {
    servePayouts({ payouts: [makePayout(1, { arrival_date: '2026-10-05', amount: 2410.5 })] });
    open();
    const row = (await screen.findByText('PO-000001')).closest('tr')!;
    expect(within(row).getByText('Oct 5, 2026')).toBeInTheDocument();
    expect(within(row).getByText('Chase ending 4242')).toBeInTheDocument();
    expect(within(row).getByText('$2,410.50').closest('[data-money], td')).toHaveClass('tabular-nums');
  });

  it('words all five statuses', async () => {
    servePayouts({
      payouts: [
        makePayout(1, { status: 'PAID' }), makePayout(2, { status: 'IN_TRANSIT' }), makePayout(3, { status: 'PENDING' }),
        makePayout(4, { status: 'FAILED' }), makePayout(5, { status: 'CANCELED' }),
      ],
    });
    open();
    await screen.findByText('PO-000001');
    const texts = bodyRows().map((r) => within(r).getAllByRole('cell')[1]!.textContent);
    expect(texts).toEqual(['Paid', 'In transit', 'Scheduled', 'Failed', 'Canceled']);
  });

  it('a payout with no arrival date shows a dash, never "Invalid Date"', async () => {
    servePayouts({ payouts: [makePayout(1, { arrival_date: null, status: 'PENDING' })] });
    open();
    const row = (await screen.findByText('PO-000001')).closest('tr')!;
    expect(row.textContent).not.toMatch(/Invalid/);
    expect(within(row).getAllByRole('cell')[0]!.textContent).toContain('—');
  });

  it('says so when there are none', async () => {
    servePayouts({ payouts: [] });
    open();
    expect(await screen.findByText('No payouts yet')).toBeInTheDocument();
  });

  it('a failed load offers Retry and then shows the rows', async () => {
    const u = user();
    servePayouts({ listError: true });
    open();
    expect(await screen.findByText('Couldn’t load payouts.')).toBeInTheDocument();
    servePayouts();
    await u.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByText('PO-000001')).toBeInTheDocument();
  });

  it('names no payment processor anywhere in the rendered text', async () => {
    open();
    await screen.findByText('PO-000001');
    expect(document.body.textContent).not.toMatch(/stripe/i);
  });
});

describe('opening a payout', () => {
  it('a row opens the drawer and puts the payout in the address', async () => {
    const u = user();
    const p = makePayout(1);
    open();
    await u.click(await screen.findByText('PO-000001'));
    expect(new URLSearchParams(urlSearch()).get('d')).toBe(`payout:${p.id}`);
    expect(await screen.findByRole('dialog', { name: 'Payout PO-000001' })).toBeInTheDocument();
  });

  it('a reload with ?payout= opens it again', async () => {
    const p = makePayout(2);
    open(`/payments?tab=payouts&payout=${p.id}`);
    expect(await screen.findByRole('dialog', { name: 'Payout PO-000002' })).toBeInTheDocument();
  });

  it('keeps the row focusable and Enter opens it', async () => {
    open();
    const row = (await screen.findByText('PO-000003')).closest('tr')!;
    expect(row).toHaveAttribute('tabindex', '0');
    row.focus();
    fireEvent.keyDown(row, { key: 'Enter' });
    expect(await screen.findByRole('dialog', { name: 'Payout PO-000003' })).toBeInTheDocument();
  });
});

