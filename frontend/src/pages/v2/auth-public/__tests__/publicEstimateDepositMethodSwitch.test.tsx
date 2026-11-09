/**
 * #2980 - after signing, the customer may pick or switch to check, Zelle, bank transfer or card by
 * phone (ruling Q2: until the deposit is paid).
 *
 * - The signed-not-paid list shows every method the estimate was sent with; card by phone folds
 *   into card when card is offered, as at signing.
 * - A manual pick shows its instructions and "Confirm"; Confirm stores the choice through the
 *   approval door's retry (no signature, no terms flag: both are on file).
 * - A return visit with a stored manual method shows "You chose to pay by {method} - {amount}",
 *   the instructions and "Pay another way", which opens the list.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { posts, renderPublicEstimate, servePublicEstimate } from '@/__tests__/harness/publicEstimatePage';

vi.mock('react-signature-canvas', async () => (await import('@/__tests__/harness/publicEstimateMocks')).blankPad());

const CHECK_TEXT = 'Make checks payable to Org.\nMail to 1 Test Way.';

function estimate(o: { sent?: string[]; method?: string | null } = {}) {
  return {
    id: 'est-switch',
    estimate_number: 'E02980',
    status: 'PENDING',
    tax_rate: 0, subtotal: 1000, tax_amount: 0, total_amount: 1000,
    scope_notes: '', line_items: [],
    send_config: { deposit_required: true, deposit_percentage: 50, deposit_amount: 500, payment_methods: o.sent ?? ['CARD', 'ACH', 'CHECK', 'ZELLE', 'BANK_TRANSFER'], message_body: null },
    invoices: [{ id: 'dep-inv-switch', kind: 'DEPOSIT', status: 'SENT', total_amount: 500, amount_due: 500, public_token: 'dep-tok' }],
    lead: { customer: { first_name: 'Pat', last_name: 'Customer', company_name: null } },
    customer: null,
    signature_data: 'data:image/png;base64,abc',
    signature_at: '2026-10-30T14:42:00.000Z',
    approved_at: null,
    terms_accepted: true,
    deposit_method: o.method ?? null,
  };
}

function page(est: ReturnType<typeof estimate>) {
  return {
    estimate: est,
    organization: { name: 'Org', estimate_terms: 'Work is guaranteed for one year.', phone: '5551234567' },
    payment_instructions: { check: CHECK_TEXT, bank_transfer: 'Wire to account 000.' },
    payment_options: { deposit_policy: 'REQUIRED_BEFORE_APPROVAL' },
    deposit: { pay_state: 'PAYABLE', hold_reason: null, payable_now: 500, processing_amount: 0 },
    expired: false,
  };
}

/** A stateful server: an approval POST stores the method, and the next page read returns it. */
function stubApi(initial: ReturnType<typeof estimate>) {
  let current = initial;
  return servePublicEstimate({
    page: () => page(current),
    write: (url, init) => {
      if (url.includes('/approve')) {
        const body = JSON.parse(String(init!.body));
        current = { ...current, deposit_method: body.payment_method };
        return { body: { estimate: current } };
      }
      return { body: { checkout_url: 'https://pay.example/session' } };
    },
  });
}

function open() {
  return renderPublicEstimate({ routed: true, entry: '/p/estimates/est-switch?token=tok-switch' });
}

afterEach(() => vi.unstubAllGlobals());

describe('the signed-not-paid list offers every method the estimate was sent with', () => {
  it('card, bank, check, Zelle and bank transfer, each with the deposit amount', async () => {
    stubApi(estimate());
    open();
    expect(await screen.findByText('Select Payment Method')).toBeInTheDocument();
    for (const name of [/pay with credit\/debit card/i, /pay by bank account/i, /pay by check/i, /pay by zelle/i, /pay by bank transfer/i]) {
      expect(screen.getByRole('button', { name })).toHaveTextContent('$500.00');
    }
  });

  it('card by phone folds into card when card is offered, as at signing', async () => {
    stubApi(estimate({ sent: ['CARD', 'EXTERNAL_CARD', 'CHECK'] }));
    open();
    await screen.findByText('Select Payment Method');
    expect(screen.getAllByRole('button', { name: /pay with credit\/debit card/i })).toHaveLength(1);
  });

  it('card by phone alone is its own row, and shows the call-us instructions and Confirm', async () => {
    const m = stubApi(estimate({ sent: ['EXTERNAL_CARD', 'CHECK'] }));
    open();
    await userEvent.setup().click(await screen.findByRole('button', { name: /pay with credit\/debit card/i }));
    expect(screen.getByText(/to pay by credit card, please call our office/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Confirm' })).toBeInTheDocument();
    expect(posts(m)).toHaveLength(0);
  });
});

describe('picking a manual method after signing', () => {
  it('shows its instructions and Confirm; Confirm stores it through the approval retry and shows the choice', async () => {
    const m = stubApi(estimate());
    open();
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: /pay by check/i }));

    expect(screen.getByText('Pay by Check - $500.00')).toBeInTheDocument();
    expect(screen.getByText(/make checks payable to org/i)).toBeInTheDocument();
    expect(posts(m)).toHaveLength(0);

    await user.click(screen.getByRole('button', { name: 'Confirm' }));

    await waitFor(() => expect(posts(m)).toHaveLength(1));
    const [url, init] = posts(m)[0]!;
    expect(String(url)).toContain('/api/estimates/est-switch/approve?token=tok-switch');
    const body = JSON.parse(String((init as RequestInit).body));
    expect(body.payment_method).toBe('CHECK');
    expect(body).not.toHaveProperty('signature_data');
    expect(await screen.findByText('You chose to pay by Check - $500.00')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Pay another way' })).toBeInTheDocument();
  });

  it('Back to payment methods returns to the list without posting', async () => {
    const m = stubApi(estimate());
    open();
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: /pay by zelle/i }));
    await user.click(screen.getByRole('button', { name: /back to payment methods/i }));
    expect(screen.getByText('Select Payment Method')).toBeInTheDocument();
    expect(posts(m)).toHaveLength(0);
  });
});

describe('a return visit with a stored method', () => {
  it('a manual method: "You chose to pay by", its instructions and "Pay another way", which opens the list', async () => {
    stubApi(estimate({ method: 'CHECK' }));
    open();
    expect(await screen.findByText('You chose to pay by Check - $500.00')).toBeInTheDocument();
    expect(screen.getByText(/make checks payable to org/i)).toBeInTheDocument();
    expect(screen.queryByText('Select Payment Method')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /pay with credit\/debit card/i })).not.toBeInTheDocument();

    await userEvent.setup().click(screen.getByRole('button', { name: 'Pay another way' }));

    expect(screen.getByText('Select Payment Method')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /pay with credit\/debit card/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /pay by bank transfer/i })).toBeInTheDocument();
  });

  it('switching from the stored check to bank transfer shows the new instructions after Confirm', async () => {
    stubApi(estimate({ method: 'CHECK' }));
    open();
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Pay another way' }));
    await user.click(screen.getByRole('button', { name: /pay by bank transfer/i }));
    await user.click(screen.getByRole('button', { name: 'Confirm' }));
    expect(await screen.findByText('You chose to pay by Bank transfer - $500.00')).toBeInTheDocument();
    expect(screen.getByText('Wire to account 000.')).toBeInTheDocument();
  });

  it.each(['CARD', 'ACH'])('a stored online method (%s) shows the list, not a chosen-method card', async (method) => {
    stubApi(estimate({ method }));
    open();
    expect(await screen.findByText('Select Payment Method')).toBeInTheDocument();
    expect(screen.queryByText(/you chose to pay by/i)).not.toBeInTheDocument();
  });
});

describe('a refused manual Confirm (#2981 messages, in the card that failed)', () => {
  it.each([
    [429, /We are experiencing issues\. Please try again in a few minutes or call us at \(555\) 123-4567\./],
    [404, /This link is out of date\. Please open the latest link we sent you, or call us at \(555\) 123-4567\./],
  ] as const)('a %s on Confirm shows the message beside Confirm, and keeps the choice open', async (status, message) => {
    const est = estimate();
    servePublicEstimate({ page: () => page(est), write: { ok: false, status, body: { error: 'refused' } } });
    open();
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: /pay by check/i }));
    await user.click(screen.getByRole('button', { name: 'Confirm' }));
    expect((await screen.findByTestId('public-action-error')).textContent).toMatch(message);
    expect(screen.getByText('Pay by Check - $500.00')).toBeInTheDocument();
    expect(screen.queryByText(/you chose to pay by/i)).not.toBeInTheDocument();
  });
});
