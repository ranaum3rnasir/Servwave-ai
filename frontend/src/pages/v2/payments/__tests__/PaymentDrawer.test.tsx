import { beforeEach, describe, expect, it } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { renderWithProviders } from '@/__tests__/helpers';

import { buildAbility } from '@/lib/ability';

import { serveAttention, makeItem } from './attentionFixtures';
import { TabHarness, makeDetail, manyRows, mockApi, serve, urlSearch } from './paymentsFixtures';

const user = () => userEvent.setup();
const ROW1 = manyRows(3)[0]!;
const ID1 = ROW1.id;
const open = (entry = '/payments') => renderWithProviders(<TabHarness />, { initialEntries: [entry] });
const drawer = () => screen.findByRole('dialog', { name: `Payment ${ROW1.reference}` });
const dparam = () => new URLSearchParams(urlSearch()).get('d');

beforeEach(() => {
  mockApi.get.mockReset();
  serve({ rows: manyRows(3) });
});

describe('opening', () => {
  it('opens from a row, with the address in the URL, and shows the list row at once', async () => {
    const u = user();
    serve({ rows: manyRows(3), detail: () => new Promise(() => {}) as never });
    open();
    await u.click(await screen.findByText('Customer 1'));
    const dialog = await drawer();
    expect(dparam()).toBe(`payment:${ID1}`);
    // The seed from the row: amount, and "{method} · {detail} · {date}" before the detail arrives.
    expect(within(dialog).getByText('Credit card · Visa ending 4242 · Oct 12, 2026')).toBeInTheDocument();
    expect(within(dialog).getByText('$101.00', { selector: 'div' })).toBeInTheDocument();
  });

  it('names the view "Payment {reference}" and has no Back on the first view', async () => {
    open(`/payments?d=payment:${ID1}`);
    const dialog = await drawer();
    expect(within(dialog).queryByRole('button', { name: /^Back to/ })).not.toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: 'Close drawer' })).toBeInTheDocument();
  });

  it('still opens from the old ?payment= address, and rewrites it as d', async () => {
    open(`/payments?payment=${ID1}`);
    expect(await drawer()).toBeInTheDocument();
    await waitFor(() => expect(dparam()).toBe(`payment:${ID1}`));
    expect(urlSearch()).not.toContain('payment=');
  });

  it('opens from ?d=payment:{id} on a fresh load, even before the list has it', async () => {
    open(`/payments?d=payment:${ID1}`);
    expect(await drawer()).toBeInTheDocument();
  });

  it('says so when the payment cannot be read, offering Retry and Close', async () => {
    serve({ rows: manyRows(3), detail: () => Promise.reject(new Error('404')) });
    open('/payments?payment=00000000-0000-4000-8000-0000000000ff');
    expect(await screen.findByText('Couldn’t load this payment.')).toBeInTheDocument();
    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getAllByRole('button').map((b) => b.getAttribute('aria-label') ?? b.textContent)).toEqual(['Close drawer', 'Retry', 'Close']);
  });

  it('Escape closes it and the address loses d', async () => {
    const u = user();
    open(`/payments?d=payment:${ID1}`);
    await drawer();
    await u.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(urlSearch()).not.toContain('d=');
  });

  it('puts focus back on the row that opened it', async () => {
    const u = user();
    open();
    const row = (await screen.findByText('Customer 1')).closest('tr')!;
    row.focus();
    fireEvent.keyDown(row, { key: 'Enter' });
    await drawer();
    await u.click(screen.getByRole('button', { name: 'Close' }));
    await waitFor(() => expect(row).toHaveFocus());
  });
});

describe('content', () => {
  it('shows the amounts: fee and refunded negative, a rule, then net and method', async () => {
    serve({
      rows: manyRows(3),
      detail: () => makeDetail(ROW1, { refunded: 10, net: 96.5, fee: 3.5, amount: 101, status: 'Partially refunded' }),
    });
    open(`/payments?d=payment:${ID1}`);
    const dialog = await drawer();
    const list = await waitFor(() => {
      const el = dialog.querySelector('[data-slot="description-list"]') as HTMLElement;
      if (!el || !el.textContent?.includes('Refunded')) throw new Error('detail not here yet');
      return el;
    });
    const terms = Array.from(list.querySelectorAll('dt')).map((t) => t.textContent);
    expect(terms).toEqual(['Amount', 'Fee', 'Refunded', 'Net', 'Method']);
    const values = Array.from(list.querySelectorAll('dd')).map((d) => d.textContent);
    expect(values).toEqual(['$101.00', '-$3.50', '-$10.00', '$86.50', 'Credit card']);
    expect(within(dialog).getByText('Partially refunded')).toBeInTheDocument();
  });

  it('shows a $0 fee as $0.00, never as a negative zero', async () => {
    serve({ rows: manyRows(3), detail: () => makeDetail(ROW1, { fee: 0, net: 101 }) });
    renderWithProviders(<TabHarness />, { initialEntries: [`/payments?d=payment:${ROW1.id}`] });
    const dialog = await screen.findByRole('dialog');
    await waitFor(() => expect(within(dialog).getByText('Fee').nextElementSibling).toHaveTextContent('$0.00'));
    expect(within(dialog).getByText('Fee').nextElementSibling).not.toHaveTextContent('-');
  });

  it('draws the customer block under the alerts, with the invoice as a chip', async () => {
    serve({
      rows: manyRows(3),
      detail: () => makeDetail(ROW1, {
        customer_block: {
          restricted: false, id: 'c1', customer_number: 'C-1001', name: 'Customer 1', company: null, address: null,
          phone: null, email: null, job: null, lead: null, invoice: { id: 'inv-1', number: 'INV-1001' },
        },
      }),
    });
    renderWithProviders(<TabHarness />, { initialEntries: [`/payments?d=payment:${ROW1.id}`], ability: buildAbility([{ action: 'read', subject: 'Invoice' }]) });
    const dialog = await drawer();
    const block = await within(dialog).findByRole('region', { name: 'Customer' });
    expect(within(block).getByRole('link', { name: /INV-1001/ })).toHaveAttribute('href', '/invoices/inv-1');
  });

  it('leaves Refunded out when nothing was refunded, and shows a dash for a fee not confirmed yet', async () => {
    serve({ rows: manyRows(3), detail: () => makeDetail(ROW1, { fee: null, net: null }) });
    open(`/payments?d=payment:${ID1}`);
    const dialog = await drawer();
    await waitFor(() => expect(dialog.querySelector('[data-slot="description-list"]')).not.toBeNull());
    const terms = Array.from(dialog.querySelectorAll('dt')).map((t) => t.textContent);
    expect(terms).toEqual(['Amount', 'Fee', 'Net', 'Method']);
    expect(Array.from(dialog.querySelectorAll('dd')).slice(1, 3).map((d) => d.textContent)).toEqual(['—', '—']);
  });

  it('shows the Failed alert with the reason', async () => {
    serve({ rows: manyRows(3), detail: () => makeDetail(ROW1, { status: 'Failed', failure_text: 'The bank account has too little money in it.' }) });
    open(`/payments?d=payment:${ID1}`);
    const dialog = await drawer();
    expect(await within(dialog).findByText('Payment failed.')).toBeInTheDocument();
    expect(within(dialog).getByText('The bank account has too little money in it.')).toBeInTheDocument();
  });

  it('reads the Failed alert as one sentence with a space, and does not repeat the reason in the timeline', async () => {
    const reason = 'The payment did not go through';
    serve({
      rows: manyRows(3),
      detail: () => makeDetail(ROW1, {
        status: 'Failed', failure_text: reason,
        timeline: [{ label: 'Failed', at: ROW1.date, note: reason, tone: 'danger' }],
      }),
    });
    open(`/payments?d=payment:${ID1}`);
    const dialog = await drawer();
    const lead = await within(dialog).findByText('Payment failed.');
    // The lead and the reason are ONE element's text, so the space between them survives the alert's flex layout.
    expect(lead.parentElement!.textContent).toBe(`Payment failed. ${reason}`);
    expect(lead.parentElement!.tagName).toBe('P');
    expect(within(dialog).getAllByText(reason, { exact: false })).toHaveLength(1);
    expect(within(dialog).getByText('Failed', { selector: 'b' })).toBeInTheDocument();
  });

  it('shows the danger alert for a dispute that needs a response', async () => {
    serve({
      rows: manyRows(3),
      detail: () => makeDetail(ROW1, {
        status: 'Disputed',
        dispute: { id: 'd1', reference: 'DSP-000001', status: 'NEEDS_RESPONSE', reason_text: 'The customer says they did not make this payment', amount: 101, respond_by: '2026-10-20T18:00:00.000Z', closed_at: null },
      }),
    });
    open(`/payments?d=payment:${ID1}`);
    const dialog = await drawer();
    expect(await within(dialog).findByText(/Dispute: The customer says they did not make this payment\./)).toBeInTheDocument();
    expect(dialog.textContent).toMatch(/Respond by Oct 20, 2026, \d{1,2}:\d{2}\s?[AP]M \(.+\)\./);
  });

  it('shows an info alert for a dispute already answered', async () => {
    serve({
      rows: manyRows(3),
      detail: () => makeDetail(ROW1, {
        dispute: { id: 'd1', reference: 'DSP-000001', status: 'UNDER_REVIEW', reason_text: 'The product was not received', amount: 101, respond_by: null, closed_at: null },
      }),
    });
    open(`/payments?d=payment:${ID1}`);
    const dialog = await drawer();
    expect(await within(dialog).findByText('Dispute under review.')).toBeInTheDocument();
    expect(within(dialog).getByText(/The product was not received/)).toBeInTheDocument();
    expect(within(dialog).queryByText(/Respond by/)).not.toBeInTheDocument();
  });

  it('draws the timeline from the API entries', async () => {
    serve({
      rows: manyRows(3),
      detail: () => makeDetail(ROW1, {
        timeline: [
          { label: 'Paid', at: '2026-10-12T15:00:00.000Z', note: null, tone: 'success' },
          { label: 'Refunded $10.00', at: '2026-10-13T15:00:00.000Z', note: null, tone: 'neutral' },
        ],
      }),
    });
    open(`/payments?d=payment:${ID1}`);
    const dialog = await drawer();
    expect(await within(dialog).findByText('Refunded $10.00')).toBeInTheDocument();
    expect(dialog.querySelectorAll('[data-slot="timeline-item"]')).toHaveLength(2);
  });

  it('turns "Paid out in PO-X" into a button that pushes the Payout view, with Back to the Payment', async () => {
    const detail = makeDetail(ROW1, {
      payout: { id: 'po-1', reference: 'PO-AB12CD34', status: 'PAID', arrival_date: '2026-10-14' },
      timeline: [{ label: 'Paid out in PO-AB12CD34', at: '2026-10-14T00:00:00.000Z', note: null, tone: 'success' }],
    });
    serve({ rows: manyRows(3), detail: () => detail });
    const base = mockApi.get.getMockImplementation()! as (u: string, c?: unknown) => unknown;
    mockApi.get.mockImplementation(((url: string, config?: unknown) => {
      if (url === '/api/payments-page/payouts/po-1') {
        return Promise.resolve({ data: { id: 'po-1', reference: 'PO-AB12CD34', status: 'PAID', arrival_date: '2026-10-14', destination_label: 'Chase', amount: 300, payment_count: 0, net_matches_payout: true, net_difference: 0, failure_text: null, actions: { update_bank_account: false }, totals: { amount: 0, fee: 0, net: 0 } } });
      }
      if (url === '/api/payments-page/payouts/po-1/payments') {
        return Promise.resolve({ data: { payments: [], payment_count: 0, voided_count: 0, pagination: { page: 1, limit: 25, total: 0, totalPages: 1 }, totals: { amount: 0, fee: 0, net: 0 } } });
      }
      return base(url, config);
    }) as never);
    open(`/payments?d=payment:${ID1}`);
    await user().click(await screen.findByRole('button', { name: 'PO-AB12CD34' }));
    await waitFor(() => expect(dparam()).toBe(`payment:${ID1},payout:po-1`));
    expect(await screen.findByRole('button', { name: 'Back to Payment' })).toBeInTheDocument();
  });

  it('shows the Refund failed pill and alert from refund_failed, and the Failed status never reads as success', async () => {
    serve({
      rows: manyRows(3),
      detail: () => makeDetail(ROW1, {
        status: 'Refund failed', refunded: 0,
        refund_failed: { amount: 40, failure_text: 'the card is closed', date: ROW1.date },
      }),
    });
    open(`/payments?d=payment:${ID1}`);
    const dialog = await drawer();
    const alert = (await within(dialog).findByText('Refund failed.', { selector: 'b' })).parentElement!;
    expect(alert.textContent).toBe('Refund failed. $40.00 could not be returned: the card is closed.');
    expect(within(dialog).getAllByText('Refund failed').length).toBeGreaterThan(0);
  });
});

describe('actions', () => {
  it('offers Refund and Close when the payment can be refunded', async () => {
    open(`/payments?d=payment:${ID1}`);
    const dialog = await drawer();
    expect(await within(dialog).findByRole('button', { name: 'Refund' })).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: 'Close' })).toBeInTheDocument();
  });

  it('shows no Refund and no other button for a view-only payload: only Close', async () => {
    serve({ rows: manyRows(3), detail: () => makeDetail(ROW1, { can_refund: false, can_respond_dispute: false, refundable_amount: 0 }) });
    open(`/payments?d=payment:${ID1}`);
    const dialog = await drawer();
    await within(dialog).findByText('Timeline');
    expect(within(dialog).getAllByRole('button').map((b) => b.getAttribute('aria-label') ?? b.textContent)).toEqual(['Close drawer', 'Close']);
  });

  it('does not offer Refund while the detail is still loading', async () => {
    serve({ rows: manyRows(3), detail: () => new Promise(() => {}) as never });
    open(`/payments?d=payment:${ID1}`);
    const dialog = await screen.findByRole('dialog', { name: 'Payment' });
    expect(within(dialog).queryByRole('button', { name: 'Refund' })).not.toBeInTheDocument();
  });

  it('puts the payment\'s open items\' actions before Refund and Close, and Close at the far right', async () => {
    serveAttention({
      rows: manyRows(3),
      open: [makeItem(1, 'failed_payment', { payment_id: ID1 })],
    });
    open(`/payments?d=payment:${ID1}`);
    const dialog = await drawer();
    await within(dialog).findByRole('button', { name: 'Refund' });
    const footer = dialog.querySelector('[data-slot="sheet-footer"]') as HTMLElement;
    expect(within(footer).getAllByRole('button').map((b) => b.textContent)).toEqual(['Contact customer', 'Mark resolved', 'Refund', 'Close']);
    expect(within(footer).getByRole('button', { name: 'Close' })).toHaveClass('ml-auto');
  });

  it('while a refund has failed the footer offers Refund again INSTEAD of Refund, never both, with one filled button', async () => {
    serveAttention({
      rows: manyRows(3),
      open: [makeItem(1, 'failed_refund', { payment_id: ID1 })],
    });
    open(`/payments?d=payment:${ID1}`);
    const dialog = await drawer();
    await within(dialog).findByRole('button', { name: 'Refund again' });
    expect(within(dialog).queryByRole('button', { name: 'Refund' })).not.toBeInTheDocument();
    const footer = dialog.querySelector('[data-slot="sheet-footer"]') as HTMLElement;
    const filled = within(footer).getAllByRole('button').filter((b) => b.className.includes('bg-primary'));
    expect(filled.map((b) => b.textContent)).toEqual(['Refund again']);
  });

  it('Respond to dispute is the one filled button when a dispute needs a response', async () => {
    serveAttention({
      rows: manyRows(3),
      open: [makeItem(1, 'failed_payment', { payment_id: ID1 })],
      detail: () => makeDetail(ROW1, {
        status: 'Disputed', can_respond_dispute: true,
        dispute: { id: 'd1', reference: 'DSP-000001', status: 'NEEDS_RESPONSE', reason_text: 'Not recognised', amount: 101, respond_by: '2026-10-20T18:00:00.000Z', closed_at: null },
      }),
    });
    open(`/payments?d=payment:${ID1}`);
    const dialog = await drawer();
    await within(dialog).findByRole('button', { name: 'Respond to dispute' });
    await within(dialog).findByRole('button', { name: 'Contact customer' });
    const footer = dialog.querySelector('[data-slot="sheet-footer"]') as HTMLElement;
    const filled = within(footer).getAllByRole('button').filter((b) => b.className.includes('bg-primary'));
    expect(filled.map((b) => b.textContent)).toEqual(['Respond to dispute']);
  });
});
