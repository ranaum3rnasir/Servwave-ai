/**
 * #2031 slice 5 — the public deposit page while the deposit link is on hold.
 *
 * The deposit invoice keeps its own live link after a material edit to the estimate, and after a
 * recall to draft, and the backend declines to open a checkout in either case. The page must say
 * WHICH — "the amount is out of date" and "your estimate is being updated" are different things to
 * read — rather than offering a Pay button that is going to be refused.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import userEvent from '@testing-library/user-event';
import { screen, waitFor } from '@testing-library/react';
import { renderWithProviders } from './helpers';
import PublicInvoicePage from '@/pages/PublicInvoicePage';

vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual<typeof import('react-router-dom')>('react-router-dom');
  return {
    ...actual,
    useParams: () => ({ id: 'dep-inv-1' }),
    useSearchParams: () => [new URLSearchParams('token=tok-123'), vi.fn()],
  };
});

type HoldReason = 'SUPERSEDED' | 'ESTIMATE_IN_DRAFT' | null;

function depositResponse(holdReason: HoldReason) {
  return {
    invoice: {
      id: 'dep-inv-1',
      invoice_number: 'I00009',
      status: 'SENT',
      kind: 'DEPOSIT',
      subtotal: 300,
      discount_amount: 0,
      tax_amount: 0,
      deposit_credit: 0,
      total_amount: 300,
      amount_due: 300,
      due_date: null,
      sent_at: '2026-03-01T00:00:00.000Z',
      paid_at: null,
      created_at: '2026-03-01T00:00:00.000Z',
      job: null,
      customer: { first_name: 'Dana', last_name: 'Deposit', email: 'dana@example.com', phone: '5550001111' },
      line_items: [
        { id: 'li-1', sequence: 1, description: 'Project deposit', quantity: 1, unit_price: 300, is_taxable: false, line_total: 300 },
      ],
      payments: [],
    },
    organization: { name: 'Acme Services' },
    available_payment_methods: ['CARD'],
    payment_instructions: {},
    deposit_hold_reason: holdReason,
  };
}

function stubFetch(holdReason: HoldReason) {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
    ok: true,
    json: async () => depositResponse(holdReason),
  }));
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('a deposit whose estimate has changed since it was sent', () => {
  it('withdraws the payment options and explains why', async () => {
    stubFetch('SUPERSEDED');
    renderWithProviders(<PublicInvoicePage />);

    await waitFor(() => {
      expect(screen.getByText('Dana Deposit')).toBeInTheDocument();
    });

    // The document still renders — the link is alive, it just cannot take money right now.
    expect(screen.getByText('Project deposit')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Pay .* by Card/i })).not.toBeInTheDocument();
    expect(screen.getByText(/estimate has changed/i)).toBeInTheDocument();
  });

  /**
   * F5 — the page the customer already had open. It loaded while the deposit was still payable, so
   * it is offering a Pay button; the edit lands, they click it, and the checkout is refused. The
   * page used to answer "Something went wrong starting your payment. Please try again" — advice
   * that can never work, because retrying is exactly what cannot succeed here.
   */
  it('explains the refusal instead of telling the customer to try again', async () => {
    const getBody = depositResponse(null);
    vi.stubGlobal('fetch', vi.fn().mockImplementation((_url: string, init?: RequestInit) => {
      if (init?.method === 'POST') {
        return Promise.resolve({
          ok: false,
          status: 400,
          json: async () => ({
            error: 'This deposit request is out of date because the estimate has changed. Please contact us for the current amount.',
            code: 'DEPOSIT_SUPERSEDED',
          }),
        });
      }
      return Promise.resolve({ ok: true, json: async () => getBody });
    }));

    renderWithProviders(<PublicInvoicePage />);
    // Choosing card reveals the fee breakdown; the button under it is the one that checks out.
    await userEvent.click(await screen.findByRole('button', { name: /Pay .* by Card/i }));
    await userEvent.click(await screen.findByRole('button', { name: /^Pay \$/i }));

    // The refusal the server actually sent, verbatim, where the customer just clicked.
    expect(await screen.findByText(/Please contact us for the current amount/i)).toBeInTheDocument();
    expect(screen.queryByText(/Something went wrong/i)).not.toBeInTheDocument();
    // And the page converges on the state the server would have rendered: no payment options at
    // all, including the checkout button the customer just pressed.
    await waitFor(() => {
      expect(screen.queryByRole('button', { name: /^Pay \$/i })).not.toBeInTheDocument();
    });
    expect(screen.queryByRole('button', { name: /Pay .* by Card/i })).not.toBeInTheDocument();
  });

  it('offers payment as usual once the deposit is back in step', async () => {
    stubFetch(null);
    renderWithProviders(<PublicInvoicePage />);

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /Pay .* by Card/i })).toBeInTheDocument();
    });
    expect(screen.queryByText(/estimate has changed/i)).not.toBeInTheDocument();
  });
});

/**
 * Ran's policy call: recalling an estimate to draft suspends its deposit link until the estimate is
 * sent again. Nothing is out of date yet — the document has been withdrawn for changes — so the
 * page must not tell the customer their amount is wrong, and must not offer a button that will be
 * refused.
 */
describe('a deposit whose estimate has been recalled to draft', () => {
  it('withdraws the payment options and says the estimate is being updated', async () => {
    stubFetch('ESTIMATE_IN_DRAFT');
    renderWithProviders(<PublicInvoicePage />);

    await waitFor(() => {
      expect(screen.getByText('Dana Deposit')).toBeInTheDocument();
    });

    // Suspended, not dead: the customer can still read what they were sent.
    expect(screen.getByText('Project deposit')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Pay .* by Card/i })).not.toBeInTheDocument();
    // The headline says what happened to the REQUEST; the body says what happened to the estimate.
    expect(screen.getByText('This deposit request is on hold')).toBeInTheDocument();
    expect(screen.getByText(/your estimate is being updated/i)).toBeInTheDocument();
    // And it does not claim the amount is out of date, which is a different thing that has not
    // happened.
    expect(screen.queryByText(/out of date/i)).not.toBeInTheDocument();
  });

  it('explains a refusal that arrives after the page was already open', async () => {
    const getBody = depositResponse(null);
    vi.stubGlobal('fetch', vi.fn().mockImplementation((_url: string, init?: RequestInit) => {
      if (init?.method === 'POST') {
        return Promise.resolve({
          ok: false,
          status: 400,
          json: async () => ({
            error: 'This deposit request is on hold while the estimate is being updated. Please contact us if you would like to pay it now.',
            code: 'DEPOSIT_ON_HOLD',
          }),
        });
      }
      return Promise.resolve({ ok: true, json: async () => getBody });
    }));

    renderWithProviders(<PublicInvoicePage />);
    await userEvent.click(await screen.findByRole('button', { name: /Pay .* by Card/i }));
    await userEvent.click(await screen.findByRole('button', { name: /^Pay \$/i }));

    expect(await screen.findByText(/on hold while the estimate is being updated/i)).toBeInTheDocument();
    expect(screen.queryByText(/Something went wrong/i)).not.toBeInTheDocument();
    // Converges on the state a fresh load would have rendered.
    await waitFor(() => {
      expect(screen.queryByRole('button', { name: /^Pay \$/i })).not.toBeInTheDocument();
    });
    expect(screen.queryByRole('button', { name: /Pay .* by Card/i })).not.toBeInTheDocument();
  });
});
