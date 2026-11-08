/**
 * SRVW-285 slice 1 - the customer's end of the public decline.
 *
 * Before this slice `handleDecline` posted NO BODY at all and the dialog behind it was a bare
 * yes/no confirm. This file pins the four things that make the replacement safe:
 *
 *   1. THE ANSWER IS OPTIONAL, AND THAT IS LOAD-BEARING. Requiring a reason risks a customer
 *      abandoning the decline and simply going silent - which loses the reason AND the status. So
 *      "open the dialog, press Decline, change nothing" must still fire the same request the page
 *      fired before, and the confirm button must never be disabled. Both are asserted below, and
 *      the first one asserts the REQUEST BODY, not just that a request happened.
 *
 *   2. THE COMMENT BOX IS ALWAYS VISIBLE. Not revealed by picking "Other". A box that appears on
 *      one branch only teaches the customer that the other branches do not want to hear from them.
 *
 *   3. THE OPTIONS COME FROM ONE EXPORTED ARRAY. Slice 2 swaps that array's source for a
 *      per-organisation list and must not have to touch this dialog - so the test drives the
 *      rendered options FROM the shared constant rather than from five retyped string literals.
 *      A hardcoded list in the dialog fails here even though the visible words would be identical.
 *
 *   4. THE PAGE IMPORTED IS THE ROUTED ONE. `pages/v2/auth-public/PublicEstimatePage` is what
 *      `pages/v2/routes/auth-public.routes.tsx` lazily mounts at `/p/estimates/:id`. The v1 twin
 *      at `pages/PublicEstimatePage.tsx` is imported by nothing but three older specs - testing it
 *      would be testing dead code.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithProviders } from './helpers';
import PublicEstimatePage from '@/pages/v2/auth-public/PublicEstimatePage';
import { LOST_REASON_OPTIONS, LOST_REASON_NOTE_MAX } from '@/constants/lostReasons';

vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual<typeof import('react-router-dom')>('react-router-dom');
  return {
    ...actual,
    useParams: () => ({ id: 'est-decline-1' }),
    useSearchParams: () => [new URLSearchParams('token=tok-decline'), vi.fn()],
  };
});

// The page mounts a signature pad even on a no-deposit estimate. A null stub is enough and the
// pad is deliberately left UNDRAWN: on this fixture `deposit_required` is false, so `needsPayment`
// is false whatever the signature does, and the Approve/Decline pair renders either way. Reporting
// "drawn" here would only couple the test to a branch it is not about.
vi.mock('react-signature-canvas', () => ({ default: () => null }));

/** SENT, no deposit - the branch that renders the Approve / Decline pair. */
const SENT_ESTIMATE_RESPONSE = {
  estimate: {
    id: 'est-decline-1',
    estimate_number: 'E00421',
    status: 'SENT',
    tax_rate: 0,
    subtotal: 1800,
    tax_amount: 0,
    total_amount: 1800,
    scope_notes: '',
    line_items: [],
    send_config: {
      deposit_required: false,
      deposit_percentage: 0,
      deposit_amount: 0,
      payment_methods: [],
      message_body: null,
    },
    invoices: [],
    lead: { customer: { first_name: 'Dana', last_name: 'Whitfield', company_name: null } },
    customer: null,
    signature_data: null,
    signature_at: null,
  },
  organization: { name: 'Northgate Door Co', estimate_terms: null },
  payment_instructions: {},
  expired: false,
};

/**
 * Stubs fetch and hands back the spy. GET serves the estimate; POST reports success with the
 * estimate flipped to DECLINED, exactly as the route does.
 */
function stubFetch() {
  const spy = vi.fn().mockImplementation((_url: string, init?: RequestInit) => {
    if (init?.method === 'POST') {
      return Promise.resolve({
        ok: true,
        json: async () => ({
          estimate: { ...SENT_ESTIMATE_RESPONSE.estimate, status: 'DECLINED' },
        }),
      });
    }
    return Promise.resolve({ ok: true, json: async () => SENT_ESTIMATE_RESPONSE });
  });
  vi.stubGlobal('fetch', spy);
  return spy;
}

/** The parsed body of the one POST the page fired, or `undefined` if it sent none. */
function declineBody(spy: ReturnType<typeof vi.fn>): Record<string, unknown> | undefined {
  const post = spy.mock.calls.find(([, init]) => (init as RequestInit | undefined)?.method === 'POST');
  const raw = (post?.[1] as RequestInit | undefined)?.body;
  return typeof raw === 'string' ? JSON.parse(raw) : undefined;
}

/** Renders, waits for the estimate, opens the decline dialog, returns the userEvent instance. */
async function openDeclineDialog() {
  const user = userEvent.setup();
  renderWithProviders(<PublicEstimatePage />);
  await screen.findByRole('button', { name: /Decline/i });
  await user.click(screen.getByRole('button', { name: /^Decline$/i }));
  await screen.findByRole('dialog');
  return user;
}

/** The dialog's confirm button, queried inside the dialog so the page's own Decline never matches. */
function confirmButton() {
  return within(screen.getByRole('dialog')).getByRole('button', { name: /Decline Estimate/i });
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe('PublicEstimatePage - the decline dialog asks why', () => {
  it('offers every reason from the shared options array, under the shared labels', async () => {
    // Driven from the constant, not from retyped literals: this is what makes slice 2 a
    // one-module change. If the dialog ever hardcodes its own list, this loop still sees the
    // right words on screen only by coincidence - and breaks the moment the array moves.
    stubFetch();
    const user = await openDeclineDialog();

    await user.click(screen.getByRole('combobox'));

    for (const option of LOST_REASON_OPTIONS) {
      expect(await screen.findByRole('option', { name: option.label })).toBeInTheDocument();
    }
    expect(screen.getAllByRole('option')).toHaveLength(LOST_REASON_OPTIONS.length);
  });

  it('shows the comment box immediately, not only once a reason is picked', async () => {
    stubFetch();
    await openDeclineDialog();

    const note = within(screen.getByRole('dialog')).getByRole('textbox');
    expect(note).toBeVisible();
    // Capped in the markup too, so the server truncation rule is a backstop and not the first
    // thing a customer meets.
    expect(note).toHaveAttribute('maxlength', String(LOST_REASON_NOTE_MAX));
  });

  it('wires both labels to their controls, so each is reachable BY ITS LABEL', async () => {
    // This dialog hand-writes its ids rather than going through FormField (the page composes kit
    // primitives directly and is unauthenticated). Hand-wiring is exactly how the repo ended up
    // with the unwired label/control pairs that `formfield-reason-dialogs.test.tsx` exists to
    // prevent, so the wiring is asserted as the API contract - reachable by label - not as two
    // strings that happen to match. `SelectField` puts the id on the Radix TRIGGER, the real
    // labelable element; a regression that let it land on Radix's Root would leave label[for]
    // pointing at nothing and fail here.
    stubFetch();
    await openDeclineDialog();

    const dialog = within(screen.getByRole('dialog'));
    expect(dialog.getByLabelText(/Why are you declining/i)).toBe(screen.getByRole('combobox'));
    expect(dialog.getByLabelText(/Anything you would like us to know/i)).toBe(dialog.getByRole('textbox'));
  });

  it('never disables the confirm button - there is no required-field guard', async () => {
    stubFetch();
    await openDeclineDialog();

    expect(confirmButton()).toBeEnabled();
  });
});

describe('PublicEstimatePage - skipping the question declines exactly as before', () => {
  it('posts a body carrying neither field when the customer answers nothing', async () => {
    const spy = stubFetch();
    const user = await openDeclineDialog();

    await user.click(confirmButton());

    await waitFor(() => expect(declineBody(spy)).toBeDefined());
    const body = declineBody(spy)!;
    // Key-set equality, not `toBeUndefined()` on each: only this shape catches an implementation
    // that helpfully posts `{ lost_reason: '', lost_reason_note: '' }`, which the server would
    // then have to defend against.
    expect(Object.keys(body)).toEqual([]);
  });

  it('still hits the same route, with the same method, as the bare confirm did', async () => {
    const spy = stubFetch();
    const user = await openDeclineDialog();

    await user.click(confirmButton());

    await waitFor(() => {
      const post = spy.mock.calls.find(([, init]) => (init as RequestInit | undefined)?.method === 'POST');
      expect(post).toBeDefined();
      expect(post![0]).toContain('/api/estimates/est-decline-1/decline?token=tok-decline');
    });
  });
});

describe('PublicEstimatePage - what the customer says reaches the route', () => {
  it('sends the chosen reason as lost_reason', async () => {
    const spy = stubFetch();
    const user = await openDeclineDialog();

    await user.click(screen.getByRole('combobox'));
    await user.click(await screen.findByRole('option', { name: 'Price' }));
    await user.click(confirmButton());

    await waitFor(() => expect(declineBody(spy)?.lost_reason).toBe('PRICE'));
    expect(declineBody(spy)).not.toHaveProperty('lost_reason_note');
  });

  it('sends the reason and the comment together', async () => {
    const spy = stubFetch();
    const user = await openDeclineDialog();

    await user.click(screen.getByRole('combobox'));
    await user.click(await screen.findByRole('option', { name: 'Went with a competitor' }));
    await user.type(
      within(screen.getByRole('dialog')).getByRole('textbox'),
      'Another bid came in about 20% lower.',
    );
    await user.click(confirmButton());

    await waitFor(() => expect(declineBody(spy)?.lost_reason).toBe('COMPETITOR'));
    expect(declineBody(spy)?.lost_reason_note).toBe('Another bid came in about 20% lower.');
  });

  it('sends a comment written with no reason chosen', async () => {
    // The always-visible box makes this the shape a hurried customer produces most often.
    const spy = stubFetch();
    const user = await openDeclineDialog();

    await user.type(
      within(screen.getByRole('dialog')).getByRole('textbox'),
      'The designer was not the right fit for us.',
    );
    await user.click(confirmButton());

    await waitFor(() =>
      expect(declineBody(spy)?.lost_reason_note).toBe('The designer was not the right fit for us.'),
    );
    expect(declineBody(spy)).not.toHaveProperty('lost_reason');
  });

  it('omits a comment the customer only put spaces in', async () => {
    // The server stores null for this, but the page should not make it do that work: an empty
    // box is not an answer and should not travel.
    const spy = stubFetch();
    const user = await openDeclineDialog();

    await user.type(within(screen.getByRole('dialog')).getByRole('textbox'), '    ');
    await user.click(confirmButton());

    await waitFor(() => expect(declineBody(spy)).toBeDefined());
    expect(declineBody(spy)).not.toHaveProperty('lost_reason_note');
  });
});

/**
 * The integrations ServWave presents as its OWN capabilities. Naming them here is the one place
 * these words belong on the frontend - a guard whose whole purpose is keeping them out of rendered
 * copy. Real customer and company names are banned outright, comments included, so none appear in
 * this list; the org-name half of the rule is covered by the assertion below instead.
 */
const VENDOR_NAMES_NEVER_IN_CUSTOMER_COPY = [
  'CallTrackingMetrics',
  'CTM',
  'Supabase',
  'Render',
  'Stripe',
  'Twilio',
];

describe('PublicEstimatePage - the dialog is ServWave\'s own voice', () => {
  it('names no third-party vendor in the decline copy', async () => {
    // The page is served to a homeowner on a token URL. Every capability behind it is presented as
    // the business's own; a vendor surfacing in a dialog the customer reads breaks that.
    stubFetch();
    await openDeclineDialog();

    const copy = screen.getByRole('dialog').textContent ?? '';
    for (const vendor of VENDOR_NAMES_NEVER_IN_CUSTOMER_COPY) {
      expect(copy).not.toContain(vendor);
    }
  });

  it('speaks as the business itself, naming no company at all', async () => {
    // The dialog is first-person ("we will be notified"), so it carries no company name - not the
    // viewing org's, and certainly not another org's. Asserting the ABSENCE of the fixture org's
    // name is what catches a future edit that starts interpolating an org into this copy, which is
    // the path by which one customer's name reaches another customer's screen.
    stubFetch();
    await openDeclineDialog();

    const copy = screen.getByRole('dialog').textContent ?? '';
    expect(copy).not.toContain(SENT_ESTIMATE_RESPONSE.organization.name);
  });
});
