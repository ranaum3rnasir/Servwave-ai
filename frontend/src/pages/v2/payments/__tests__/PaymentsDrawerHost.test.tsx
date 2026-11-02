// V7-07b: the one drawer host - the `d` stack in the address, Back, focus, scroll, Escape order and the unsaved-work
// question. The views themselves are covered in PaymentDrawer, PayoutDrawer, ItemViews and Dispute*.
import { beforeEach, describe, expect, it } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useNavigate } from 'react-router-dom';

import { renderWithProviders } from '@/__tests__/helpers';
import { buildAbility } from '@/lib/ability';
import { Button } from '@/ui-kit/components/ui/button';

import { PaymentsDrawerHost } from '../components/PaymentsDrawerHost';
import { PaymentsDrawerProvider } from '../drawerHost';
import { DISPUTE_ID, makeEvidence } from './disputeFixtures';
import { makeItem, serveAttention } from './attentionFixtures';
import { TabHarness, makeDetail, manyRows, mockApi, urlSearch } from './paymentsFixtures';

const ROW1 = manyRows(3)[0]!;
const PAYOUT = { id: 'po-1', reference: 'PO-AB12CD34', status: 'PAID', arrival_date: '2026-10-14' };
const dparam = () => new URLSearchParams(urlSearch()).get('d');
const user = () => userEvent.setup();

function BrowserBack() {
  const navigate = useNavigate();
  return <Button type="button" onClick={() => navigate(-1)}>browser-back</Button>;
}

function serveAll(extra: Parameters<typeof makeDetail>[1] = {}, open = [makeItem(1, 'failed_payment', { payment_id: ROW1.id })]) {
  serveAttention({
    rows: manyRows(3),
    open,
    detail: () => makeDetail(ROW1, {
      payout: PAYOUT,
      timeline: [{ label: `Paid out in ${PAYOUT.reference}`, at: ROW1.date, note: null, tone: 'success' }],
      customer_block: {
        restricted: false, id: 'c1', customer_number: 'C-1001', name: 'Dana Reyes', company: null, address: null,
        phone: '5551234567', email: 'dana@example.com', job: null, lead: null, invoice: { id: 'inv-1', number: 'INV-1001' },
      },
      can_refund: false,
      ...extra,
    }),
  });
  const base = mockApi.get.getMockImplementation()! as (u: string, c?: unknown) => unknown;
  mockApi.get.mockImplementation(((url: string, config?: unknown) => {
    if (url === `/api/payments-page/payouts/${PAYOUT.id}`) {
      return Promise.resolve({ data: { ...PAYOUT, reference: PAYOUT.reference, destination_label: 'Chase', amount: 300, payment_count: 1, net_matches_payout: true, net_difference: 0, failure_text: null, actions: { update_bank_account: false }, totals: { amount: 0, fee: 0, net: 0 } } });
    }
    if (url === `/api/payments-page/payouts/${PAYOUT.id}/payments`) {
      return Promise.resolve({ data: { payments: [], payment_count: 0, voided_count: 0, pagination: { page: 1, limit: 25, total: 0, totalPages: 1 }, totals: { amount: 0, fee: 0, net: 0 } } });
    }
    if (url === `/api/payments-page/disputes/${DISPUTE_ID}/evidence`) return Promise.resolve({ data: makeEvidence() });
    if (typeof url === 'string' && url.startsWith('/api/attachments/')) return Promise.resolve({ data: { attachments: [] } });
    return base(url, config);
  }) as never);
}

// Edit invoices needs View invoices and See prices.
const render = (
  entry: string,
  ability = buildAbility([
    { action: 'read', subject: 'Invoice' },
    { action: 'read', subject: 'Prices' },
    { action: 'update', subject: 'Invoice' },
  ]),
) =>
  renderWithProviders(<><TabHarness /><BrowserBack /></>, { initialEntries: [entry], ability });
const dialogNamed = (name: string | RegExp) => screen.findByRole('dialog', { name });

beforeEach(() => mockApi.get.mockReset());

describe('reading the address', () => {
  it('a reload on a 3-deep address settles on the top view with ONE sheet (no hang)', async () => {
    serveAll();
    const key = makeItem(1, 'failed_payment', { payment_id: ROW1.id }).key;
    render(`/payments?d=payment:${ROW1.id},payout:${PAYOUT.id},item:${key}`);
    expect(await dialogNamed('Bank payment failed')).toBeInTheDocument();
    expect(screen.getAllByRole('dialog', { hidden: true })).toHaveLength(1);
    expect(screen.getByRole('button', { name: 'Back to Payout' })).toBeInTheDocument();
  });

  it('ignores an unknown kind and a malformed entry, and shows what is left', async () => {
    serveAll();
    render(`/payments?d=bogus:1,nothing,payment:${ROW1.id}`);
    expect(await dialogNamed(`Payment ${ROW1.reference}`)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Back to/ })).not.toBeInTheDocument();
  });

  it('shows nothing for an address with no usable entry', async () => {
    serveAll();
    render('/payments?d=bogus:1');
    await screen.findByText('Customer 1');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });
});

describe('Back, Close and the history', () => {
  it('Back pops one view and does not add a history entry; the browser Back steps through the pushes', async () => {
    serveAll();
    const u = user();
    render('/payments');
    await u.click(await screen.findByText('Customer 1'));
    const first = await dialogNamed(`Payment ${ROW1.reference}`);
    await u.click(await within(first).findByRole('button', { name: PAYOUT.reference }));
    await dialogNamed(`Payout ${PAYOUT.reference}`);
    expect(dparam()).toBe(`payment:${ROW1.id},payout:${PAYOUT.id}`);

    // In-drawer Back replaces: going back in the browser from here lands on the opening, not on the payout again.
    await u.click(screen.getByRole('button', { name: 'Back to Payment' }));
    await dialogNamed(`Payment ${ROW1.reference}`);
    expect(dparam()).toBe(`payment:${ROW1.id}`);
    fireEvent.click(screen.getByText('browser-back'));
    await waitFor(() => expect(dparam()).toBe(`payment:${ROW1.id}`));
    expect(screen.getByRole('dialog', { name: `Payment ${ROW1.reference}` })).toBeInTheDocument();
  });

  it('the browser Back steps back through two pushes, one view each', async () => {
    serveAll();
    const u = user();
    render('/payments');
    await u.click(await screen.findByText('Customer 1'));
    const first = await dialogNamed(`Payment ${ROW1.reference}`);
    await u.click(await within(first).findByRole('button', { name: PAYOUT.reference }));
    await dialogNamed(`Payout ${PAYOUT.reference}`);
    fireEvent.click(screen.getByText('browser-back'));
    expect(await dialogNamed(`Payment ${ROW1.reference}`)).toBeInTheDocument();
    fireEvent.click(screen.getByText('browser-back'));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(dparam()).toBeNull();
  });

  it('arriving on a deeper view puts focus on Back', async () => {
    serveAll();
    const u = user();
    render(`/payments?d=payment:${ROW1.id}`);
    const first = await dialogNamed(`Payment ${ROW1.reference}`);
    await u.click(await within(first).findByRole('button', { name: PAYOUT.reference }));
    const back = await screen.findByRole('button', { name: 'Back to Payment' });
    await waitFor(() => expect(back).toHaveFocus());
  });

  it('the X closes the whole drawer from three deep, and the address loses d', async () => {
    serveAll();
    const key = makeItem(1, 'failed_payment', { payment_id: ROW1.id }).key;
    render(`/payments?d=payment:${ROW1.id},payout:${PAYOUT.id},item:${key}`);
    const dialog = await dialogNamed('Bank payment failed');
    await within(dialog).findByText('Bank payment failed.', { selector: 'b' });
    await user().click(within(dialog).getByRole('button', { name: 'Close drawer' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(urlSearch()).not.toContain('d=');
  });

  it('Back shows the earlier view as it was left, scroll position included', async () => {
    serveAll();
    const u = user();
    render(`/payments?d=payment:${ROW1.id}`);
    const first = await dialogNamed(`Payment ${ROW1.reference}`);
    const body = () => (screen.getByRole('dialog').querySelector('.overflow-y-auto') as HTMLElement);
    await within(first).findByText('Timeline');
    body().scrollTop = 180;
    fireEvent.scroll(body());
    await u.click(await within(first).findByRole('button', { name: PAYOUT.reference }));
    await dialogNamed(`Payout ${PAYOUT.reference}`);
    expect(body().scrollTop).toBe(0);
    await u.click(screen.getByRole('button', { name: 'Back to Payment' }));
    await dialogNamed(`Payment ${ROW1.reference}`);
    await waitFor(() => expect(body().scrollTop).toBe(180));
  });
});

describe('after Back by keyboard', () => {
  const disputed = { status: 'Disputed' as const, can_respond_dispute: false, dispute: { id: DISPUTE_ID, reference: 'DSP-000001', status: 'NEEDS_RESPONSE', reason_text: 'Not recognised', amount: 101, respond_by: '2026-10-20T18:00:00.000Z', closed_at: null } };

  it('focus returns to the control that pushed the view (View), not the sheet container', async () => {
    serveAll(disputed);
    const u = user();
    render(`/payments?d=payment:${ROW1.id}`);
    const first = await dialogNamed(`Payment ${ROW1.reference}`);
    await u.click(await within(first).findByRole('button', { name: 'View' }));
    const back = await screen.findByRole('button', { name: 'Back to Payment' });
    await waitFor(() => expect(back).toHaveFocus());
    await u.keyboard('{Enter}');
    const view = await within(await dialogNamed(`Payment ${ROW1.reference}`)).findByRole('button', { name: 'View' });
    await waitFor(() => expect(view).toHaveFocus());
  });
});

describe('the dispute alert and the body padding', () => {
  it('keeps View at the right (no wrap) and 44px wherever the sheet is full screen', async () => {
    serveAll({ status: 'Disputed', dispute: { id: DISPUTE_ID, reference: 'DSP-000001', status: 'NEEDS_RESPONSE', reason_text: 'Not recognised', amount: 101, respond_by: '2026-10-20T18:00:00.000Z', closed_at: null } });
    render(`/payments?d=payment:${ROW1.id}`);
    const view = await within(await dialogNamed(`Payment ${ROW1.reference}`)).findByRole('button', { name: 'View' });
    expect(view).toHaveClass('max-md:h-11');
    expect(view.className).not.toContain('max-sm:h-11');
    expect(view.parentElement!.className).not.toContain('flex-wrap');
  });

  it('the scrolling body has the mockup\'s 20px padding all round, top included', async () => {
    serveAll();
    render(`/payments?d=payment:${ROW1.id}`);
    const dialog = await dialogNamed(`Payment ${ROW1.reference}`);
    expect(dialog.querySelector('.overflow-y-auto')).toHaveClass('p-5');
  });
});

describe('Escape and focus (a dialog over the one host)', () => {
  it('Escape closes the dialog first, then the whole drawer; focus returns to the button that opened the dialog', async () => {
    serveAll();
    const u = user();
    const it1 = makeItem(1, 'failed_payment', { payment_id: ROW1.id });
    render(`/payments?d=payment:${ROW1.id},item:${it1.key}`);
    const drawer = await dialogNamed('Bank payment failed');
    const contact = await within(drawer).findByRole('button', { name: 'Contact customer' });
    await u.click(contact);
    expect(await screen.findByRole('dialog', { name: 'Contact customer' })).toBeInTheDocument();
    await u.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Contact customer' })).not.toBeInTheDocument());
    // The drawer is still there, on the same view, and the opener has focus again.
    expect(screen.getByRole('dialog', { name: 'Bank payment failed' })).toBeInTheDocument();
    expect(dparam()).toContain('item:');
    await waitFor(() => expect(contact).toHaveFocus());
    await u.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(urlSearch()).not.toContain('d=');
  });

  it('Mark resolved (a dialog over the drawer) closes on Escape without closing the drawer', async () => {
    serveAll();
    const u = user();
    const it1 = makeItem(1, 'failed_payment', { payment_id: ROW1.id });
    render(`/payments?d=payment:${ROW1.id},item:${it1.key}`);
    const drawer = await dialogNamed('Bank payment failed');
    await u.click(await within(drawer).findByRole('button', { name: 'Mark resolved' }));
    await screen.findByRole('dialog', { name: 'Mark as resolved' });
    await u.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Mark as resolved' })).not.toBeInTheDocument());
    expect(screen.getByRole('dialog', { name: 'Bank payment failed' })).toBeInTheDocument();
  });
});

describe('unsaved work', () => {
  it('Back and Close from the Respond form ask before discarding what was typed', async () => {
    serveAll({
      status: 'Disputed', can_respond_dispute: true,
      dispute: { id: DISPUTE_ID, reference: 'DSP-000001', status: 'NEEDS_RESPONSE', reason_text: 'Not recognised', amount: 101, respond_by: '2026-10-20T18:00:00.000Z', closed_at: null },
    });
    const u = user();
    render(`/payments?d=payment:${ROW1.id},dispute:${DISPUTE_ID},respond:${DISPUTE_ID}`);
    const form = await dialogNamed('Respond to dispute');
    fireEvent.change(await within(form).findByLabelText('Your explanation'), { target: { value: 'Typed, not saved' } });
    await u.click(within(form).getByRole('button', { name: 'Back to Dispute' }));
    expect(await screen.findByText('Discard your changes?')).toBeInTheDocument();
    // Keep editing: nothing moved.
    await u.click(screen.getByRole('button', { name: 'Keep editing' }));
    expect(dparam()).toBe(`payment:${ROW1.id},dispute:${DISPUTE_ID},respond:${DISPUTE_ID}`);
    // Discard: the Dispute view shows.
    await u.click(within(screen.getByRole('dialog', { name: 'Respond to dispute' })).getByRole('button', { name: 'Back to Dispute' }));
    await u.click(await screen.findByRole('button', { name: 'Discard' }));
    expect(await dialogNamed(/^Dispute DSP-/)).toBeInTheDocument();
    expect(dparam()).toBe(`payment:${ROW1.id},dispute:${DISPUTE_ID}`);
  });
});

describe('the host without a stack', () => {
  it('draws nothing until something is opened', async () => {
    serveAll();
    renderWithProviders(<PaymentsDrawerProvider><PaymentsDrawerHost /></PaymentsDrawerProvider>, { initialEntries: ['/payments'] });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });
});
