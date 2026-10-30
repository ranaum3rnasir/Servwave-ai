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
import { useEffect } from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { renderWithProviders } from '@/__tests__/helpers';

import PublicEstimatePage from '../PublicEstimatePage';

// The address the customer arrived on; a payment return adds its own parameters.
let query = 'token=tok-flows';

vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual<typeof import('react-router-dom')>('react-router-dom');
  return {
    ...actual,
    useParams: () => ({ id: 'est-flows' }),
    useSearchParams: () => [new URLSearchParams(query), vi.fn()],
  };
});

// `signed` flips per test: false leaves the signature pad empty, as for a customer who just arrived.
let signedOnMount = true;
function SignatureCanvasStub(props: { onEnd?: () => void }) {
  useEffect(() => {
    if (signedOnMount) props.onEnd?.();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return null;
}
vi.mock('react-signature-canvas', () => ({ default: SignatureCanvasStub }));

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
  const fetchMock = vi.fn().mockImplementation((_url: string, init?: RequestInit) => {
    if (init?.method === 'POST') {
      return Promise.resolve({ ok: post?.ok ?? true, json: async () => post?.body ?? { checkout_url: 'https://pay.example/session' } });
    }
    return Promise.resolve({ ok: true, json: async () => page });
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

const posts = (m: ReturnType<typeof vi.fn>) => m.mock.calls.filter(([, init]) => (init as RequestInit | undefined)?.method === 'POST');
const postUrl = (m: ReturnType<typeof vi.fn>) => String(posts(m)[0]![0]);
const postBody = (m: ReturnType<typeof vi.fn>) => JSON.parse(String((posts(m)[0]![1] as RequestInit).body));

let handedOffTo: string | null = null;
const realLocation = window.location;
beforeEach(() => {
  query = 'token=tok-flows';
  signedOnMount = true;
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
    renderWithProviders(<PublicEstimatePage />);

    await userEvent.setup().click(await screen.findByRole('button', { name: /pay with credit\/debit card/i }));

    await waitFor(() => expect(handedOffTo).toBe('https://pay.example/session'));
    expect(postUrl(m)).toContain('/api/estimates/est-flows/approve');
    expect(postBody(m).payment_method).toBe('CARD');
  });

  it('pays the deposit by bank in one step: the approval carries ACH and the checkout is followed', async () => {
    const m = stubApi(payload());
    renderWithProviders(<PublicEstimatePage />);

    await userEvent.setup().click(await screen.findByRole('button', { name: /pay by bank account/i }));

    await waitFor(() => expect(handedOffTo).toBe('https://pay.example/session'));
    expect(postBody(m).payment_method).toBe('ACH');
  });

  it('offers no bank row when the resolver does not offer one', async () => {
    stubApi(payload({ online: ['CARD'] }));
    renderWithProviders(<PublicEstimatePage />);

    await screen.findByRole('button', { name: /pay with credit\/debit card/i });
    expect(screen.queryByRole('button', { name: /bank account/i })).not.toBeInTheDocument();
  });
});

describe('public estimate - pay the deposit later', () => {
  it('approves on the signature alone, with no payment method to pick', async () => {
    const m = stubApi(payload({ policy: 'PAY_LATER' }), { body: { estimate: payload({ policy: 'PAY_LATER', status: 'WON' }).estimate } });
    renderWithProviders(<PublicEstimatePage />);

    expect(screen.queryByRole('button', { name: /pay with credit\/debit card/i })).not.toBeInTheDocument();
    await userEvent.setup().click(await screen.findByRole('button', { name: /approve estimate/i }));

    await waitFor(() => expect(posts(m)).toHaveLength(1));
    expect(postUrl(m)).toContain('/api/estimates/est-flows/approve');
    expect(postBody(m).payment_method).toBeNull();
    expect(handedOffTo).toBeNull();
  });

  it('says the deposit is due after approval', async () => {
    stubApi(payload({ policy: 'PAY_LATER' }));
    renderWithProviders(<PublicEstimatePage />);

    expect(await screen.findByText(/due after you approve/i)).toBeInTheDocument();
  });

  it('an approved estimate keeps its open deposit payable by card from the same page', async () => {
    const m = stubApi(payload({ policy: 'PAY_LATER', status: 'WON' }));
    renderWithProviders(<PublicEstimatePage />);

    await userEvent.setup().click(await screen.findByRole('button', { name: /pay deposit by card/i }));

    await waitFor(() => expect(handedOffTo).toBe('https://pay.example/session'));
    expect(postUrl(m)).toContain('/api/invoices/dep-inv-flows/public/checkout?token=dep-tok');
    expect(postBody(m)).toMatchObject({ method: 'card' });
  });

  it('asks the deposit checkout to bring the customer back to this estimate page', async () => {
    const m = stubApi(payload({ policy: 'PAY_LATER', status: 'WON' }));
    renderWithProviders(<PublicEstimatePage />);

    await userEvent.setup().click(await screen.findByRole('button', { name: /pay deposit by card/i }));

    await waitFor(() => expect(posts(m)).toHaveLength(1));
    expect(postBody(m)).toMatchObject({ return_to: 'estimate' });
  });

  it('a held pay-later deposit shows its reason and does not also promise it can be paid', async () => {
    signedOnMount = false;
    stubApi(payload({ policy: 'PAY_LATER', deposit: { pay_state: 'CHANGED', hold_reason: 'SUPERSEDED', payable_now: 0, processing_amount: 0 } }));
    renderWithProviders(<PublicEstimatePage />);

    expect(await screen.findByText(/out of date because the estimate has changed/)).toBeInTheDocument();
    expect(screen.queryByText(/You can pay it from this page/i)).not.toBeInTheDocument();
  });

  it('a held pay-later deposit still shows its reason after the customer has signed', async () => {
    stubApi(payload({ policy: 'PAY_LATER', deposit: { pay_state: 'CHANGED', hold_reason: 'SUPERSEDED', payable_now: 0, processing_amount: 0 } }));
    renderWithProviders(<PublicEstimatePage />);

    expect(await screen.findByText(/out of date because the estimate has changed/)).toBeInTheDocument();
    expect(screen.queryByText(/You can pay it from this page/i)).not.toBeInTheDocument();
  });

  it('an approved estimate keeps its open deposit payable by bank from the same page', async () => {
    const m = stubApi(payload({ policy: 'PAY_LATER', status: 'WON' }));
    renderWithProviders(<PublicEstimatePage />);

    await userEvent.setup().click(await screen.findByRole('button', { name: /pay deposit by bank/i }));

    await waitFor(() => expect(handedOffTo).toBe('https://pay.example/session'));
    expect(postBody(m)).toMatchObject({ method: 'bank' });
  });
});

describe('public estimate - a deposit that cannot be paid right now', () => {
  it('a held deposit says why, in place of the payment buttons', async () => {
    stubApi(payload({ deposit: { pay_state: 'CHANGED', hold_reason: 'ESTIMATE_IN_DRAFT', payable_now: 0, processing_amount: 0 } }));
    renderWithProviders(<PublicEstimatePage />);

    // The notice moves from the deposit line to the payment card once the signature registers.
    expect((await screen.findAllByText(/This deposit is on hold while the estimate is being updated/)).length).toBeGreaterThan(0);
    expect(screen.queryByRole('button', { name: /pay with credit\/debit card/i })).not.toBeInTheDocument();
  });

  it('a recalled (DRAFT) estimate shows the hold reason, not the generic unavailable line', async () => {
    signedOnMount = false;
    stubApi(payload({ status: 'DRAFT', deposit: { pay_state: 'CHANGED', hold_reason: 'ESTIMATE_IN_DRAFT', payable_now: 0, processing_amount: 0 } }));
    renderWithProviders(<PublicEstimatePage />);

    expect((await screen.findAllByText(/This deposit is on hold while the estimate is being updated/)).length).toBeGreaterThan(0);
    expect(screen.queryByText(/currently not available for action/)).not.toBeInTheDocument();
  });

  it('a held deposit says why before the customer has even signed', async () => {
    signedOnMount = false;
    stubApi(payload({ deposit: { pay_state: 'CHANGED', hold_reason: 'SUPERSEDED', payable_now: 0, processing_amount: 0 } }));
    renderWithProviders(<PublicEstimatePage />);

    expect(await screen.findByText(/out of date because the estimate has changed/)).toBeInTheDocument();
  });

  it('an out-of-date deposit says the estimate changed', async () => {
    stubApi(payload({ status: 'WON', policy: 'PAY_LATER', deposit: { pay_state: 'CHANGED', hold_reason: 'SUPERSEDED', payable_now: 0, processing_amount: 0 } }));
    renderWithProviders(<PublicEstimatePage />);

    expect(await screen.findByText(/out of date because the estimate has changed/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /pay deposit by card/i })).not.toBeInTheDocument();
  });

  it('a refusal at the approval door shows its own reason, not a generic error', async () => {
    stubApi(payload(), { ok: false, body: { error: 'This deposit is on hold while the estimate is being updated. Please contact us if you would like to pay it now.', code: 'DEPOSIT_ON_HOLD' } });
    renderWithProviders(<PublicEstimatePage />);

    await userEvent.setup().click(await screen.findByRole('button', { name: /pay with credit\/debit card/i }));

    expect(await screen.findByText(/This deposit is on hold while the estimate is being updated/)).toBeInTheDocument();
    expect(screen.queryByText(/something went wrong/i)).not.toBeInTheDocument();
  });

  it('a won estimate whose bank payment failed says the deposit is open and payable again', async () => {
    stubApi(payload({ status: 'WON' }));
    renderWithProviders(<PublicEstimatePage />);

    expect(await screen.findByText(/did not go through/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /pay deposit by card/i })).toBeInTheDocument();
  });

  it('a bank payment still clearing shows as processing, with nothing to pay', async () => {
    stubApi(payload({ status: 'WON', deposit: { pay_state: 'PROCESSING', hold_reason: null, payable_now: 0, processing_amount: 500 } }));
    renderWithProviders(<PublicEstimatePage />);

    expect(await screen.findByText(/bank payment of \$500\.00 is processing/i)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /pay deposit/i })).not.toBeInTheDocument();
  });
});

describe('public estimate - coming back from a deposit payment', () => {
  it('a card deposit return says the deposit was received, not that the estimate was just approved', async () => {
    query = 'token=tok-flows&payment=success&method=card&deposit=1';
    stubApi(payload({ policy: 'PAY_LATER', status: 'WON', deposit: { pay_state: 'PAID', hold_reason: null, payable_now: 0, processing_amount: 0 } }));
    renderWithProviders(<PublicEstimatePage />);

    expect(await screen.findByText(/Deposit received/i)).toBeInTheDocument();
    expect(screen.queryByText(/Your estimate has been approved/i)).not.toBeInTheDocument();
  });

  it('a bank deposit return says the payment has started and will be confirmed', async () => {
    query = 'token=tok-flows&payment=success&method=bank&deposit=1';
    stubApi(payload({ policy: 'PAY_LATER', status: 'WON', deposit: { pay_state: 'PROCESSING', hold_reason: null, payable_now: 0, processing_amount: 500 } }));
    renderWithProviders(<PublicEstimatePage />);

    expect(await screen.findByText(/Your bank payment has started/i)).toBeInTheDocument();
  });

  it('a return from the approval checkout keeps the existing wording', async () => {
    query = 'token=tok-flows&payment=success';
    stubApi(payload({ status: 'WON' }));
    renderWithProviders(<PublicEstimatePage />);

    expect(await screen.findByText(/Payment received! Your estimate has been approved/i)).toBeInTheDocument();
  });
});
