import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { mountPublicEstimate, postBody, postUrl, posts, renderPublicEstimate, servePublicEstimate, setPublicRoute } from '@/__tests__/harness/publicEstimatePage';
import { renderWithProviders } from '@/__tests__/helpers';
import PublicInvoicePage from '@/pages/v2/auth-public/PublicInvoicePage';
import { useAuthStore } from '@/stores/auth.store';

vi.mock('react-router-dom', async () => (await import('@/__tests__/harness/publicEstimateMocks')).publicRouter());
vi.mock('react-signature-canvas', async () => (await import('@/__tests__/harness/publicEstimateMocks')).signedPad());

// Each source used to be a file of its own, so each started from the setup file's signed-in user and bare client calls.
// `clearAllMocks` keeps implementations: reset them here, so a block states its own user and answers in its own `beforeEach`.
beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(useAuthStore).mockReset();
});

describe('public-estimate-card-unavailable-copy', () => {
  /**
   * Task 2.6 - §6.5/§6.8: when an org is paused/restricted between send and view, the
   * deposit-checkout POST to /approve can fail with the raw backend string ("Card payment
   * is not available"). Before the fix this rendered verbatim in the estimate page's error
   * banner; the homeowner-facing copy must replace it with friendly wording (org name
   * present), matching the same treatment applied to PublicInvoicePage.
   *
   * Targets `pages/v2/auth-public/PublicEstimatePage`, which is what
   * `/p/estimates/:id` actually mounts. It previously imported the unrouted
   * `pages/PublicEstimatePage`, so the "raw backend string must never reach the
   * homeowner" guarantee was being proved against a page no homeowner could load.
   * The v2 page maps the same error with the same regex, so the assertions carry
   * over unchanged.
   *
   * Isolated in its own spec (rather than extending public-estimate-deposit.test.tsx)
   * because it needs the signature canvas to report "drawn" so the deposit+CARD payment
   * step renders - a mock behavior the existing file's tests don't need.
   */

  const CARD_DEPOSIT_ESTIMATE_RESPONSE = {
    estimate: {
      id: 'est-card-gate-1',
      estimate_number: 'E00777',
      status: 'SENT',
      tax_rate: 0,
      subtotal: 500,
      tax_amount: 0,
      total_amount: 500,
      scope_notes: '',
      line_items: [],
      send_config: {
        deposit_required: true,
        deposit_percentage: 100,
        deposit_amount: 500,
        payment_methods: ['CARD'],
        message_body: null,
      },
      invoices: [
        { id: 'dep-inv-card-gate', status: 'SENT', total_amount: 500, amount_due: 500, public_token: 'dep-tok' },
      ],
      lead: { customer: { first_name: 'Homer', last_name: 'Owner', company_name: null } },
      customer: null,
      signature_data: null,
      signature_at: null,
    },
    organization: { name: 'ServWave HVAC', estimate_terms: null },
    payment_instructions: {},
    expired: false,
  };

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  describe('PublicEstimatePage — CARD-unavailable deposit-checkout copy (Task 2.6)', () => {
    it('shows friendly homeowner copy instead of the raw backend error when CARD is unavailable', async () => {
      mountPublicEstimate({
        page: CARD_DEPOSIT_ESTIMATE_RESPONSE,
        write: { ok: false, body: { error: 'Card payment is not available' } },
        id: 'est-card-gate-1',
        token: 'tok-card-gate',
      });

      const payButton = await screen.findByRole('button', { name: /pay with credit\/debit card/i });
      await userEvent.click(payButton);

      // Friendly §6.8 copy renders, with the org name interpolated in.
      await waitFor(() => {
        expect(screen.getByText(/ServWave HVAC isn't accepting card payments right now/i)).toBeInTheDocument();
      });

      // The raw backend string must never reach the homeowner.
      expect(screen.queryByText('Card payment is not available')).not.toBeInTheDocument();
    });
    // Payments go-live slice 16, carried by slice 25: a refusal that carries its own homeowner
    // message (the plan gate's neutral 403) shows that message, not "something went wrong".
    it('shows the door\'s own homeowner message when online payment is unavailable', async () => {
      mountPublicEstimate({
        page: CARD_DEPOSIT_ESTIMATE_RESPONSE,
        write: { ok: false, body: { code: 'ONLINE_PAYMENT_UNAVAILABLE', error: "Paying online isn't available for this estimate." } },
        id: 'est-card-gate-1',
        token: 'tok-card-gate',
      });

      await userEvent.click(await screen.findByRole('button', { name: /pay with credit\/debit card/i }));

      await waitFor(() => {
        expect(screen.getByText("Paying online isn't available for this estimate.")).toBeInTheDocument();
      });
      expect(screen.queryByText(/Something went wrong starting your payment/)).not.toBeInTheDocument();
    });

    // Fix round 2 - the approve door's deposit refusals (depositCheckoutRefusal) are written for the
    // homeowner too. A homeowner approving against a deposit that is already paid, cancelled, closed,
    // out of date or on hold is told why, never "please try again".
    it.each([
      ['DEPOSIT_ALREADY_PAID', 'This deposit has already been paid.'],
      ['DEPOSIT_VOIDED', 'This deposit request has been cancelled. Please contact us if you have any questions.'],
      ['DEPOSIT_CLOSED', 'This deposit cannot be paid online right now. Please contact us to arrange payment.'],
      [
        'DEPOSIT_SUPERSEDED',
        'This deposit request is out of date because the estimate has changed. Please contact us for the current amount.',
      ],
      [
        'DEPOSIT_ON_HOLD',
        'This deposit request is on hold while the estimate is being updated. Please contact us if you would like to pay it now.',
      ],
    ])('shows the door\'s own homeowner message for a %s refusal', async (code, message) => {
      mountPublicEstimate({
        page: CARD_DEPOSIT_ESTIMATE_RESPONSE,
        write: { ok: false, body: { code, error: message } },
        id: 'est-card-gate-1',
        token: 'tok-card-gate',
      });

      await userEvent.click(await screen.findByRole('button', { name: /pay with credit\/debit card/i }));

      await waitFor(() => {
        expect(screen.getByText(message)).toBeInTheDocument();
      });
      expect(screen.queryByText(/Something went wrong starting your payment/)).not.toBeInTheDocument();
    });
  });
});

describe('public-estimate-v2-no-methods', () => {
  /**
   * #2044 — the ROUTED public estimate page (`pages/v2/auth-public/PublicEstimatePage.tsx`;
   * `pages/v2/routes/auth-public.routes.tsx` maps `/p/estimates/:id` here). The v1
   * `pages/PublicEstimatePage.tsx` this note used to contrast against has been deleted,
   * and every `public-estimate-*.test.tsx` file now targets this same routed page.
   *
   * With `send_config.deposit_required: true` and `payment_methods: []`, once the customer signs,
   * the page must render the "Online payment is not available..." fallback line instead of an
   * empty "Select Payment Method" card, must not offer any "Pay by/with" button, and must still
   * offer Decline.
   */

  function buildResponse(orgPhone: string | null) {
    return {
      estimate: {
        id: 'est-2044-no-methods',
        estimate_number: 'E00888',
        status: 'SENT',
        tax_rate: 0,
        subtotal: 1000,
        tax_amount: 0,
        total_amount: 1000,
        scope_notes: '',
        line_items: [],
        send_config: {
          deposit_required: true,
          deposit_percentage: 50,
          deposit_amount: 500,
          payment_methods: [],
          message_body: null,
        },
        invoices: [
          { id: 'dep-inv-2044', status: 'SENT', total_amount: 500, amount_due: 500, public_token: 'dep-tok' },
        ],
        lead: { customer: { first_name: 'Pat', last_name: 'Customer', company_name: null } },
        customer: null,
        signature_data: null,
        signature_at: null,
      },
      organization: { name: 'Org', estimate_terms: null, phone: orgPhone },
      payment_instructions: {},
      expired: false,
    };
  }

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  describe('#2044 — public estimate page, zero configured payment methods', () => {
    it('renders the fallback line (with phone) instead of an empty method list, and keeps Decline', async () => {
      mountPublicEstimate({ page: buildResponse('5555550123'), id: 'est-2044-no-methods', token: 'tok-2044' });

      await waitFor(() => {
        expect(screen.getByText(/Select Payment Method/i)).toBeInTheDocument();
      });

      // The fallback line renders, with the phone inserted after "contact us" (not at the end).
      const fallback = await screen.findByText(
        /Online payment is not available for this estimate\. Please contact us at \(555\) 555-0123 to arrange your deposit and complete your approval\./,
      );
      expect(fallback).toBeInTheDocument();

      // No dead method buttons.
      expect(screen.queryByRole('button', { name: /pay (with|by)/i })).not.toBeInTheDocument();

      // Decline still works.
      expect(screen.getByRole('button', { name: /decline estimate/i })).toBeInTheDocument();
    });

    it('omits the phone clause when the org has none set', async () => {
      mountPublicEstimate({ page: buildResponse(null), id: 'est-2044-no-methods', token: 'tok-2044' });

      const fallback = await screen.findByText(
        /Online payment is not available for this estimate\. Please contact us to arrange your deposit and complete your approval\./,
      );
      expect(fallback).toBeInTheDocument();
    });
  });
});

describe('publicEstimateNoCardFee', () => {
  /**
   * Payments go-live slice 02 (D9) - card payments carry no service fee. The ROUTED public estimate
   * page must say nothing about one, even if a payload (an older backend, a cached response) still
   * carries `service_fee_preview`: neither on the card button in the deposit method picker nor in
   * the "Approved - Deposit Pending" notice.
   */

  function buildResponse(status: 'SENT' | 'PENDING') {
    return {
      estimate: {
        id: 'est-no-fee',
        estimate_number: 'E00777',
        status,
        tax_rate: 0,
        subtotal: 1000,
        tax_amount: 0,
        total_amount: 1000,
        scope_notes: '',
        line_items: [],
        send_config: {
          deposit_required: true,
          deposit_percentage: 50,
          deposit_amount: 500,
          payment_methods: ['CARD', 'CHECK'],
          message_body: null,
        },
        invoices: [
          { id: 'dep-inv-no-fee', status: 'SENT', total_amount: 500, amount_due: 500, public_token: 'dep-tok' },
        ],
        lead: { customer: { first_name: 'Pat', last_name: 'Customer', company_name: null } },
        customer: null,
        signature_data: status === 'PENDING' ? 'data:image/png;base64,abc' : null,
        signature_at: status === 'PENDING' ? '2026-10-01T12:00:00.000Z' : null,
      },
      organization: { name: 'Org', estimate_terms: null, phone: null },
      payment_instructions: {},
      expired: false,
      // A stale quote of the retired 3.5% fee on the $500.00 deposit.
      service_fee_preview: 17.5,
    };
  }

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  describe('public estimate page - no card service fee (payments go-live D9)', () => {
    it('shows no fee on the card button of the deposit method picker, even when the payload quotes one', async () => {
      const { container } = mountPublicEstimate({ page: buildResponse('SENT'), id: 'est-no-fee', token: 'tok-no-fee' });

      await waitFor(() => {
        expect(screen.getByRole('button', { name: /pay with credit\/debit card/i })).toBeInTheDocument();
      });

      expect(container.textContent).not.toMatch(/service fee/i);
      expect(container.textContent).not.toContain('$17.50');
    });

    it('shows no card fee in the deposit-pending notice, even when the payload quotes one', async () => {
      const { container } = mountPublicEstimate({ page: buildResponse('PENDING'), id: 'est-no-fee', token: 'tok-no-fee' });

      await waitFor(() => {
        expect(screen.getByText(/Approved - Deposit Pending/)).toBeInTheDocument();
      });

      expect(container.textContent).not.toMatch(/service fee/i);
      expect(container.textContent).not.toContain('$17.50');
    });
  });
});

describe('publicEstimateDepositFlows', () => {
  /**
   * Payments go-live slice 27 - the ROUTED public estimate page and the deposit policies.
   *
   * - Deposit required: sign, then pay the deposit by card or by bank in one step. The approval
   *   carries the chosen method; a hosted checkout URL in the answer is followed.
   * - Pay later: sign and approve with no payment step; once approved the deposit stays open and is
   *   paid from the same page, by card or by bank, through the deposit's own checkout.
   * - A held deposit says why instead of showing a generic error.
   * - A won estimate whose bank deposit failed says the deposit is open and payable.
   */

  type DepositState = { pay_state: string; hold_reason: string | null; payable_now: number; processing_amount: number } | null;

  interface Options {
    status?: 'SENT' | 'PENDING' | 'WON' | 'DRAFT';
    policy?: 'REQUIRED_BEFORE_APPROVAL' | 'PAY_LATER';
    online?: string[];
    deposit?: DepositState;
  }

  function payload(o: Options = {}) {
    const online = o.online ?? ['CARD', 'ACH'];
    const status = o.status ?? 'SENT';
    return {
      estimate: {
        id: 'est-flows',
        estimate_number: 'E00900',
        status,
        tax_rate: 0, subtotal: 1000, tax_amount: 0, total_amount: 1000,
        scope_notes: '', line_items: [],
        send_config: { deposit_required: true, deposit_percentage: 50, deposit_amount: 500, payment_methods: [...online, 'CHECK'], message_body: null },
        invoices: [{ id: 'dep-inv-flows', kind: 'DEPOSIT', status: 'SENT', total_amount: 500, amount_due: 500, public_token: 'dep-tok' }],
        lead: { customer: { first_name: 'Pat', last_name: 'Customer', company_name: null } },
        customer: null,
        signature_data: status === 'SENT' ? null : 'data:image/png;base64,abc',
        signature_at: status === 'SENT' ? null : '2026-10-01T12:00:00.000Z',
        approved_at: status === 'WON' ? '2026-10-01T12:00:00.000Z' : null,
      },
      organization: { name: 'Org', estimate_terms: null, phone: '5551234567' },
      payment_instructions: {},
      payment_options: {
        methods: [...online, 'CHECK'], online_methods: online,
        tips: { enabled: false, presets: [] }, allow_partial: false,
        deposit_policy: o.policy ?? 'REQUIRED_BEFORE_APPROVAL',
      },
      deposit: o.deposit === undefined
        ? { pay_state: 'PAYABLE', hold_reason: null, payable_now: 500, processing_amount: 0 }
        : o.deposit,
      expired: false,
    };
  }

  function stubApi(page: unknown, post?: { ok?: boolean; body: unknown }) {
    return servePublicEstimate({ page, write: { ok: post?.ok ?? true, body: post?.body ?? { checkout_url: 'https://pay.example/session' } } });
  }

  let handedOffTo: string | null = null;
  const realLocation = window.location;
  beforeEach(() => {
    handedOffTo = null;
    Object.defineProperty(window, 'location', {
      configurable: true,
      value: { ...realLocation, get href() { return realLocation.href; }, set href(next: string) { handedOffTo = next; } },
    });
  });
  afterEach(() => {
    Object.defineProperty(window, 'location', { configurable: true, value: realLocation });
    vi.unstubAllGlobals();
  });

  describe('public estimate - deposit required before approval', () => {
    it('pays the deposit by card in one step: the approval carries CARD and the checkout is followed', async () => {
      const m = stubApi(payload());
      renderPublicEstimate({ id: 'est-flows', token: 'tok-flows' });

      await userEvent.setup().click(await screen.findByRole('button', { name: /pay with credit\/debit card/i }));

      await waitFor(() => expect(handedOffTo).toBe('https://pay.example/session'));
      expect(postUrl(m)).toContain('/api/estimates/est-flows/approve');
      expect(postBody(m).payment_method).toBe('CARD');
    });

    it('pays the deposit by bank in one step: the approval carries ACH and the checkout is followed', async () => {
      const m = stubApi(payload());
      renderPublicEstimate({ id: 'est-flows', token: 'tok-flows' });

      await userEvent.setup().click(await screen.findByRole('button', { name: /pay by bank account/i }));

      await waitFor(() => expect(handedOffTo).toBe('https://pay.example/session'));
      expect(postBody(m).payment_method).toBe('ACH');
    });

    it('offers no bank row when the resolver does not offer one', async () => {
      stubApi(payload({ online: ['CARD'] }));
      renderPublicEstimate({ id: 'est-flows', token: 'tok-flows' });

      await screen.findByRole('button', { name: /pay with credit\/debit card/i });
      expect(screen.queryByRole('button', { name: /bank account/i })).not.toBeInTheDocument();
    });
  });

  describe('public estimate - pay the deposit later', () => {
    it('approves on the signature alone, with no payment method to pick', async () => {
      const m = stubApi(payload({ policy: 'PAY_LATER' }), { body: { estimate: payload({ policy: 'PAY_LATER', status: 'WON' }).estimate } });
      renderPublicEstimate({ id: 'est-flows', token: 'tok-flows' });

      expect(screen.queryByRole('button', { name: /pay with credit\/debit card/i })).not.toBeInTheDocument();
      await userEvent.setup().click(await screen.findByRole('button', { name: /approve estimate/i }));

      await waitFor(() => expect(posts(m)).toHaveLength(1));
      expect(postUrl(m)).toContain('/api/estimates/est-flows/approve');
      expect(postBody(m).payment_method).toBeNull();
      expect(handedOffTo).toBeNull();
    });

    it('says the deposit is due after approval', async () => {
      stubApi(payload({ policy: 'PAY_LATER' }));
      renderPublicEstimate({ id: 'est-flows', token: 'tok-flows' });

      expect(await screen.findByText(/due after you approve/i)).toBeInTheDocument();
    });

    it('an approved estimate keeps its open deposit payable by card from the same page', async () => {
      const m = stubApi(payload({ policy: 'PAY_LATER', status: 'WON' }));
      renderPublicEstimate({ id: 'est-flows', token: 'tok-flows' });

      await userEvent.setup().click(await screen.findByRole('button', { name: /pay deposit by card/i }));

      await waitFor(() => expect(handedOffTo).toBe('https://pay.example/session'));
      expect(postUrl(m)).toContain('/api/invoices/dep-inv-flows/public/checkout?token=dep-tok');
      expect(postBody(m)).toMatchObject({ method: 'card' });
    });

    it('asks the deposit checkout to bring the customer back to this estimate page', async () => {
      const m = stubApi(payload({ policy: 'PAY_LATER', status: 'WON' }));
      renderPublicEstimate({ id: 'est-flows', token: 'tok-flows' });

      await userEvent.setup().click(await screen.findByRole('button', { name: /pay deposit by card/i }));

      await waitFor(() => expect(posts(m)).toHaveLength(1));
      expect(postBody(m)).toMatchObject({ return_to: 'estimate' });
    });

    it('a held pay-later deposit shows its reason and does not also promise it can be paid', async () => {
      stubApi(payload({ policy: 'PAY_LATER', deposit: { pay_state: 'CHANGED', hold_reason: 'SUPERSEDED', payable_now: 0, processing_amount: 0 } }));
      renderPublicEstimate({ id: 'est-flows', token: 'tok-flows', signed: false });

      expect(await screen.findByText(/out of date because the estimate has changed/)).toBeInTheDocument();
      expect(screen.queryByText(/You can pay it from this page/i)).not.toBeInTheDocument();
    });

    it('a held pay-later deposit still shows its reason after the customer has signed', async () => {
      stubApi(payload({ policy: 'PAY_LATER', deposit: { pay_state: 'CHANGED', hold_reason: 'SUPERSEDED', payable_now: 0, processing_amount: 0 } }));
      renderPublicEstimate({ id: 'est-flows', token: 'tok-flows' });

      expect(await screen.findByText(/out of date because the estimate has changed/)).toBeInTheDocument();
      expect(screen.queryByText(/You can pay it from this page/i)).not.toBeInTheDocument();
    });

    it('an approved estimate keeps its open deposit payable by bank from the same page', async () => {
      const m = stubApi(payload({ policy: 'PAY_LATER', status: 'WON' }));
      renderPublicEstimate({ id: 'est-flows', token: 'tok-flows' });

      await userEvent.setup().click(await screen.findByRole('button', { name: /pay deposit by bank/i }));

      await waitFor(() => expect(handedOffTo).toBe('https://pay.example/session'));
      expect(postBody(m)).toMatchObject({ method: 'bank' });
    });
  });

  describe('public estimate - a deposit that cannot be paid right now', () => {
    it('a held deposit says why, in place of the payment buttons', async () => {
      stubApi(payload({ deposit: { pay_state: 'CHANGED', hold_reason: 'ESTIMATE_IN_DRAFT', payable_now: 0, processing_amount: 0 } }));
      renderPublicEstimate({ id: 'est-flows', token: 'tok-flows' });

      // The notice moves from the deposit line to the payment card once the signature registers.
      expect((await screen.findAllByText(/This deposit is on hold while the estimate is being updated/)).length).toBeGreaterThan(0);
      expect(screen.queryByRole('button', { name: /pay with credit\/debit card/i })).not.toBeInTheDocument();
    });

    it('a recalled (DRAFT) estimate shows the hold reason, not the generic unavailable line', async () => {
      stubApi(payload({ status: 'DRAFT', deposit: { pay_state: 'CHANGED', hold_reason: 'ESTIMATE_IN_DRAFT', payable_now: 0, processing_amount: 0 } }));
      renderPublicEstimate({ id: 'est-flows', token: 'tok-flows', signed: false });

      expect((await screen.findAllByText(/This deposit is on hold while the estimate is being updated/)).length).toBeGreaterThan(0);
      expect(screen.queryByText(/currently not available for action/)).not.toBeInTheDocument();
    });

    it('a held deposit says why before the customer has even signed', async () => {
      stubApi(payload({ deposit: { pay_state: 'CHANGED', hold_reason: 'SUPERSEDED', payable_now: 0, processing_amount: 0 } }));
      renderPublicEstimate({ id: 'est-flows', token: 'tok-flows', signed: false });

      expect(await screen.findByText(/out of date because the estimate has changed/)).toBeInTheDocument();
    });

    it('an out-of-date deposit says the estimate changed', async () => {
      stubApi(payload({ status: 'WON', policy: 'PAY_LATER', deposit: { pay_state: 'CHANGED', hold_reason: 'SUPERSEDED', payable_now: 0, processing_amount: 0 } }));
      renderPublicEstimate({ id: 'est-flows', token: 'tok-flows' });

      expect(await screen.findByText(/out of date because the estimate has changed/)).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: /pay deposit by card/i })).not.toBeInTheDocument();
    });

    it('a refusal at the approval door shows its own reason, not a generic error', async () => {
      stubApi(payload(), { ok: false, body: { error: 'This deposit is on hold while the estimate is being updated. Please contact us if you would like to pay it now.', code: 'DEPOSIT_ON_HOLD' } });
      renderPublicEstimate({ id: 'est-flows', token: 'tok-flows' });

      await userEvent.setup().click(await screen.findByRole('button', { name: /pay with credit\/debit card/i }));

      expect(await screen.findByText(/This deposit is on hold while the estimate is being updated/)).toBeInTheDocument();
      expect(screen.queryByText(/something went wrong/i)).not.toBeInTheDocument();
    });

    it('a won estimate whose bank payment failed says the deposit is open and payable again', async () => {
      stubApi(payload({ status: 'WON' }));
      renderPublicEstimate({ id: 'est-flows', token: 'tok-flows' });

      expect(await screen.findByText(/did not go through/i)).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /pay deposit by card/i })).toBeInTheDocument();
    });

    it('a bank payment still clearing shows as processing, with nothing to pay', async () => {
      stubApi(payload({ status: 'WON', deposit: { pay_state: 'PROCESSING', hold_reason: null, payable_now: 0, processing_amount: 500 } }));
      renderPublicEstimate({ id: 'est-flows', token: 'tok-flows' });

      expect(await screen.findByText(/bank payment of \$500\.00 is processing/i)).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: /pay deposit/i })).not.toBeInTheDocument();
    });
  });

  describe('public estimate - coming back from a deposit payment', () => {
    it('a card deposit return says the deposit was received, not that the estimate was just approved', async () => {
      stubApi(payload({ policy: 'PAY_LATER', status: 'WON', deposit: { pay_state: 'PAID', hold_reason: null, payable_now: 0, processing_amount: 0 } }));
      renderPublicEstimate({ id: 'est-flows', query: 'token=tok-flows&payment=success&method=card&deposit=1' });

      expect(await screen.findByText(/Deposit received/i)).toBeInTheDocument();
      expect(screen.queryByText(/Your estimate has been approved/i)).not.toBeInTheDocument();
    });

    it('a bank deposit return says the payment has started and will be confirmed', async () => {
      stubApi(payload({ policy: 'PAY_LATER', status: 'WON', deposit: { pay_state: 'PROCESSING', hold_reason: null, payable_now: 0, processing_amount: 500 } }));
      renderPublicEstimate({ id: 'est-flows', query: 'token=tok-flows&payment=success&method=bank&deposit=1' });

      expect(await screen.findByText(/Your bank payment has started/i)).toBeInTheDocument();
    });

    it('a return from the approval checkout keeps the existing wording', async () => {
      stubApi(payload({ status: 'WON' }));
      renderPublicEstimate({ id: 'est-flows', query: 'token=tok-flows&payment=success' });

      expect(await screen.findByText(/Payment received! Your estimate has been approved/i)).toBeInTheDocument();
    });
  });
});

describe('publicActionFailureMessages', () => {
  /**
   * #2981 - what a customer is told when a sign or pay try is refused, on BOTH public pages.
   *
   * - 429: "We are experiencing issues. Please try again in a few minutes or call us at {phone}." with the
   *   phone as a call link; with no phone on file the sentence ends after "a few minutes".
   * - 404 on an action: "This link is out of date. Please open the latest link we sent you, or call us at
   *   {phone}."
   * - Anything else keeps the page's generic message. No message names a vendor.
   */

  const WAIT = /We are experiencing issues\. Please try again in a few minutes/;
  const STALE = /This link is out of date\. Please open the latest link we sent you/;
  const GENERIC = /Something went wrong starting your payment\. Please try again or contact us\./;

  const estimatePage = (phone: string | null) => ({
    estimate: {
      id: 'doc-1', estimate_number: 'E00900', status: 'SENT',
      tax_rate: 0, subtotal: 1000, tax_amount: 0, total_amount: 1000, scope_notes: '', line_items: [],
      send_config: { deposit_required: true, deposit_percentage: 50, deposit_amount: 500, payment_methods: ['CARD', 'CHECK'], message_body: null },
      invoices: [{ id: 'dep-inv-flows', kind: 'DEPOSIT', status: 'SENT', total_amount: 500, amount_due: 500, public_token: 'dep-tok' }], lead: { customer: { first_name: 'Pat', last_name: 'Customer', company_name: null } }, customer: null,
      signature_data: null, signature_at: null, approved_at: null,
    },
    organization: { name: 'Org', estimate_terms: null, phone },
    payment_instructions: {},
    payment_options: { methods: ['CARD', 'CHECK'], online_methods: ['CARD'], tips: { enabled: false, presets: [] }, allow_partial: false, deposit_policy: 'REQUIRED_BEFORE_APPROVAL' },
    deposit: { pay_state: 'PAYABLE', hold_reason: null, payable_now: 500, processing_amount: 0 },
    expired: false,
  });

  const invoicePage = (phone: string | null) => ({
    invoice: {
      id: 'doc-1', invoice_number: 'I00009', status: 'SENT', kind: 'STANDARD',
      subtotal: 300, discount_amount: 0, tax_amount: 0, deposit_credit: 0, total_amount: 300, amount_due: 300,
      due_date: null, sent_at: '2026-03-01T00:00:00.000Z', paid_at: null, created_at: '2026-03-01T00:00:00.000Z',
      job: null,
      customer: { first_name: 'Dana', last_name: 'Deposit', email: 'dana@example.com', phone: '5550001111' },
      line_items: [{ id: 'li-1', sequence: 1, description: 'Work', quantity: 1, unit_price: 300, is_taxable: false, line_total: 300 }],
      payments: [],
    },
    organization: { name: 'Acme Services', phone, phone_ext: phone ? '12' : null },
    available_payment_methods: ['CARD'],
    payment_instructions: {},
  });

  function stub(page: unknown, post: { status: number; body: unknown }) {
    servePublicEstimate({ page, write: { ok: false, status: post.status, body: post.body } });
  }

  /** Mount the estimate page, or the invoice page (the public sibling that shares this failure copy). */
  const openEstimate = () => renderPublicEstimate({ id: 'doc-1', token: 'tok', entry: '/p/x/doc-1?token=tok' });
  const openInvoice = () => {
    setPublicRoute({ id: 'doc-1', token: 'tok' });
    renderWithProviders(<PublicInvoicePage />, { initialEntries: ['/p/x/doc-1?token=tok'] });
  };

  const payOnEstimate = async () => userEvent.setup().click(await screen.findByRole('button', { name: /pay with credit\/debit card/i }));
  const payOnInvoice = async () => userEvent.click(await screen.findByRole('button', { name: 'Pay by card' }));

  afterEach(() => vi.unstubAllGlobals());

  describe.each([
    ['estimate page', openEstimate, estimatePage, payOnEstimate, GENERIC],
    ['invoice page', openInvoice, invoicePage, payOnInvoice, GENERIC],
  ] as const)('%s', (_name, open, payload, pay, generic) => {
    it('429 shows the wait message with the company phone as a call link', async () => {
      stub(payload('5551234567'), { status: 429, body: { error: 'Too many requests', retryAfter: 600 } });
      open();
      await pay();

      const alert = await screen.findByTestId('public-action-error');
      expect(alert).toHaveTextContent(/We are experiencing issues\. Please try again in a few minutes or call us at \(555\) 123-4567/);
      expect(within(alert).getByRole('link', { name: '(555) 123-4567' })).toHaveAttribute('href', 'tel:5551234567');
      expect(alert.textContent).not.toMatch(/redis|stripe|supabase|resend|render|vercel|too many requests/i);
    });

    it('429 with no phone on file ends the sentence after "a few minutes"', async () => {
      stub(payload(null), { status: 429, body: { error: 'Too many requests', retryAfter: 600 } });
      open();
      await pay();

      const alert = await screen.findByTestId('public-action-error');
      expect(alert.textContent).toBe('We are experiencing issues. Please try again in a few minutes.');
      expect(within(alert).queryByRole('link')).not.toBeInTheDocument();
    });

    it('404 on the action says the link is out of date, with the phone as a call link', async () => {
      stub(payload('5551234567'), { status: 404, body: { error: 'Not found' } });
      open();
      await pay();

      const alert = await screen.findByTestId('public-action-error');
      expect(alert).toHaveTextContent(STALE);
      expect(alert).toHaveTextContent(/or call us at \(555\) 123-4567/);
      expect(within(alert).getByRole('link', { name: '(555) 123-4567' })).toHaveAttribute('href', 'tel:5551234567');
    });

    it('any other failure keeps the generic message', async () => {
      stub(payload('5551234567'), { status: 500, body: { error: 'internal detail' } });
      open();
      await pay();

      await waitFor(() => expect(screen.getByTestId('public-action-error')).toHaveTextContent(generic));
      expect(screen.queryByText(WAIT)).not.toBeInTheDocument();
      expect(screen.queryByText(STALE)).not.toBeInTheDocument();
    });
  });
});
