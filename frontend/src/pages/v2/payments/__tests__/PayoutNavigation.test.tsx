import { beforeEach, describe, expect, it } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useLocation } from 'react-router-dom';

import { renderWithProviders } from '@/__tests__/helpers';

import PaymentsPage from '../PaymentsPage';
import { makeDetail, makeRow, mockApi, serve } from './paymentsFixtures';
import { makePayout, makePayoutPayment, servePayouts } from './payoutsFixtures';

const PAYOUT = makePayout(7);
const ROW = makeRow(1, { payout: { id: PAYOUT.id, reference: PAYOUT.reference, status: 'PAID', arrival_date: '2026-10-05' } });

function Where() {
  const { search } = useLocation();
  return <div data-testid="search">{search}</div>;
}
const search = () => new URLSearchParams(document.querySelector('[data-testid="search"]')!.textContent ?? '');

beforeEach(() => {
  mockApi.get.mockReset();
  serve({ rows: [ROW], detail: () => makeDetail(ROW, {
    can_refund: false,
    timeline: [{ label: 'Paid', at: ROW.date, note: null, tone: 'success' }, { label: `Paid out in ${PAYOUT.reference}`, at: ROW.date, note: null, tone: 'neutral' }],
  }) });
  // The payments fixtures answer the list and the payment; the payouts fixtures add the payout routes on top.
  const withPayments = mockApi.get.getMockImplementation()!;
  servePayouts({ payouts: [PAYOUT], paymentsOf: { [PAYOUT.id]: [makePayoutPayment(1)] } });
  const withPayouts = mockApi.get.getMockImplementation()!;
  mockApi.get.mockImplementation(((url: string, config?: unknown) => {
    if (url === '/api/organization/stripe/status') {
      return Promise.resolve({ data: { connected: true, terms_accepted: true, stripe_charges_enabled: true, stripe_payouts_enabled: true, stripe_details_submitted: true, stripe_requirements_due: [], stripe_disabled_reason: null, collected_awaiting_payout: 0 } });
    }
    if (/^\/api\/payments-page\/payments(\/|$)/.test(url)) return (withPayments as (u: string, c?: unknown) => unknown)(url, config);
    return (withPayouts as (u: string, c?: unknown) => unknown)(url, config);
  }) as never);
});

describe('Paid out in a payout reference', () => {
  it('pushes the Payout on top of the Payment where it is, with Back to the Payment; the tab and the period stay put', async () => {
    const u = userEvent.setup();
    renderWithProviders(<><PaymentsPage /><Where /></>, { initialEntries: [`/payments?period=7&chip=succeeded&d=payment:${ROW.id}`] });
    const dialog = await screen.findByRole('dialog', { name: `Payment ${ROW.reference}` });
    await u.click(await within(dialog).findByRole('button', { name: PAYOUT.reference }));

    expect(await screen.findByRole('dialog', { name: `Payout ${PAYOUT.reference}` })).toBeInTheDocument();
    await waitFor(() => expect(search().get('d')).toBe(`payment:${ROW.id},payout:${PAYOUT.id}`));
    expect(search().get('period')).toBe('7');
    expect(search().get('chip')).toBe('succeeded');
    expect(search().has('tab')).toBe(false);
    expect(screen.getByRole('button', { name: 'Back to Payment' })).toBeInTheDocument();
  });

  it('a payment opened from a payout and its own "Paid out in" link cut the stack back to the payout', async () => {
    const u = userEvent.setup();
    const pay = makePayoutPayment(1);
    mockApi.get.mockReset();
    serve({ rows: [] });
    servePayouts({ payouts: [PAYOUT], paymentsOf: { [PAYOUT.id]: [pay] } });
    const inner = mockApi.get.getMockImplementation()!;
    mockApi.get.mockImplementation(((url: string, config?: unknown) => {
      if (url === '/api/organization/stripe/status') {
        return Promise.resolve({ data: { connected: true, terms_accepted: true, stripe_charges_enabled: true, stripe_payouts_enabled: true, stripe_details_submitted: true, stripe_requirements_due: [], stripe_disabled_reason: null, collected_awaiting_payout: 0 } });
      }
      if (url === `/api/payments-page/payments/${pay.id}`) {
        const row = makeRow(1, { id: pay.id, customer: pay.customer && { ...pay.customer, customer_number: 'C-1001' }, invoice: pay.invoice, payout: { id: PAYOUT.id, reference: PAYOUT.reference, status: 'PAID', arrival_date: null } });
        return Promise.resolve({ data: makeDetail(row, { can_refund: false, timeline: [{ label: `Paid out in ${PAYOUT.reference}`, at: row.date, note: null, tone: 'neutral' }] }) });
      }
      return (inner as (a: string, b?: unknown) => unknown)(url, config);
    }) as never);
    renderWithProviders(<><PaymentsPage /><Where /></>, { initialEntries: [`/payments?tab=payouts&d=payout:${PAYOUT.id},payment:${pay.id}`] });
    const paymentDrawer = await screen.findByRole('dialog', { name: /^Payment PMT-/ });
    await u.click(await within(paymentDrawer).findByRole('button', { name: PAYOUT.reference }));
    await waitFor(() => expect(search().get('d')).toBe(`payout:${PAYOUT.id}`));
    expect(await screen.findByRole('dialog', { name: `Payout ${PAYOUT.reference}` })).toBeInTheDocument();
  });
});
