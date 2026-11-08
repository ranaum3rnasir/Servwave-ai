/**
 * SRVW-285 slice C - both pickers offer the ORGANISATION's reasons.
 *
 * Slice B gave an admin a settings screen for this list and, by design, pointed nothing at it.
 * The gap that left was visible from the product: an admin could add "Went with a designer", save
 * it, reopen the screen and see it there - and no customer and no rep was ever offered it. These
 * are the tests for closing it, on both surfaces, because the two get the list from DIFFERENT
 * places and only one of them has a session:
 *
 *   - the STAFF dialog reads `GET /api/lost-reason-options` through axios, the same authenticated
 *     route the settings screen uses;
 *   - the PUBLIC page has no account at all, so it reads the token-scoped
 *     `GET /api/estimates/:id/decline-reasons?token=` with bare `fetch` (decision D6).
 *
 * WHAT EACH CASE IS REALLY PINNING. It is easy to write this suite so that it passes against the
 * old hardcoded five - assert "Price" is offered and it always will be. So every list case below
 * turns on a word the built-ins DO NOT contain (a reason the admin added) or on one they DO
 * contain being ABSENT (a reason the admin switched off). Either of those fails on the pre-slice
 * build, which is the point.
 *
 * THE FALLBACK IS TESTED AS DELIBERATELY AS THE FETCH. Both pickers fall back to the five
 * built-ins when the list has not arrived or cannot be had, and that is not politeness - a
 * picker that renders empty costs the reason, and on the customer's side an empty picker may cost
 * the decline itself, which is worth far more. So "the request failed and the customer can still
 * decline" is a first-class case here and not an afterthought.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { renderWithProviders } from './helpers';
import { buildAbility } from '@/lib/ability';
import { LOST_REASON_OPTIONS } from '@/constants/lostReasons';
import { DeclineEstimateInternalDialog } from '@/components/estimates/DeclineEstimateInternalDialog';
import PublicEstimatePage from '@/pages/v2/auth-public/PublicEstimatePage';
import api from '@/lib/axios';

const adminAbility = buildAbility([{ action: 'manage', subject: 'all' }]);

vi.mock('@/lib/axios', () => ({
  default: { get: vi.fn(), post: vi.fn(), patch: vi.fn() },
}));

const mockApi = api as unknown as { get: ReturnType<typeof vi.fn>; patch: ReturnType<typeof vi.fn> };

/**
 * The curated list, as both routes would answer it. "Timing" is switched OFF and the last row is
 * one the admin added - the two rows that make this list distinguishable from the built-in five.
 */
const ORG_ROWS = [
  { code: 'PRICE', label: 'Price', is_active: true, sort_order: 0, is_builtin: true },
  { code: 'TIMING', label: 'Timing', is_active: false, sort_order: 1, is_builtin: true },
  { code: 'OTHER', label: 'Other', is_active: true, sort_order: 2, is_builtin: true },
  { code: 'WENT_WITH_A_DESIGNER', label: 'Went with a designer', is_active: true, sort_order: 3, is_builtin: false },
];

/** What the public route returns: code + label, active only, nothing else (D6). */
const PUBLIC_ROWS = ORG_ROWS.filter((r) => r.is_active).map((r) => ({ code: r.code, label: r.label }));

const ADDED_LABEL = 'Went with a designer';

beforeEach(() => {
  vi.clearAllMocks();
});

// ═══════════════════════════════════════════════════════════════════
// The staff dialog
// ═══════════════════════════════════════════════════════════════════

/** Serves the org list to the authenticated hook; `null` stands for a request that never answers. */
function armStaffList(rows: unknown[] | null) {
  mockApi.get.mockImplementation(async (url: string) => {
    if (url.includes('/api/lost-reason-options')) {
      if (rows === null) return new Promise(() => {}); // in flight, forever
      return { data: { lost_reason_options: rows } };
    }
    return { data: {} };
  });
}

async function openStaffDialog() {
  const user = userEvent.setup();
  renderWithProviders(
    <DeclineEstimateInternalDialog open onOpenChange={() => {}} estimateId="est-1" estimateNumber="E00921" />,
    { ability: adminAbility },
  );
  await screen.findByRole('dialog');
  return user;
}

describe('the staff decline dialog offers the organisation\'s reasons', () => {
  it('offers a reason the admin added', async () => {
    armStaffList(ORG_ROWS);
    const user = await openStaffDialog();

    await user.click(screen.getByRole('combobox'));

    // Not in the built-in five. On the pre-slice build this option cannot exist.
    expect(await screen.findByRole('option', { name: ADDED_LABEL })).toBeInTheDocument();
  });

  it('does not offer a reason the admin switched off', async () => {
    armStaffList(ORG_ROWS);
    const user = await openStaffDialog();

    await user.click(screen.getByRole('combobox'));
    await screen.findByRole('option', { name: 'Price' });

    // "Timing" IS one of the built-in five, so a dialog still reading the hardcoded array shows
    // it here and fails. That is exactly the regression this case exists for.
    expect(screen.queryByRole('option', { name: 'Timing' })).toBeNull();
  });

  it('offers exactly the live rows, in the order the admin arranged them', async () => {
    armStaffList(ORG_ROWS);
    const user = await openStaffDialog();

    await user.click(screen.getByRole('combobox'));
    await screen.findByRole('option', { name: ADDED_LABEL });

    expect(screen.getAllByRole('option').map((o) => o.textContent)).toEqual([
      'Price',
      'Other',
      ADDED_LABEL,
    ]);
  });

  it('falls back to the five built-ins while the list is still in flight', async () => {
    // A dialog that renders an empty picker for as long as the request takes is a dialog a rep
    // meets empty, and the reason is REQUIRED on this path - they would be unable to record the
    // loss at all until it settled.
    armStaffList(null);
    const user = await openStaffDialog();

    await user.click(screen.getByRole('combobox'));

    for (const option of LOST_REASON_OPTIONS) {
      expect(await screen.findByRole('option', { name: option.label })).toBeInTheDocument();
    }
  });
});

// ═══════════════════════════════════════════════════════════════════
// The customer's page
// ═══════════════════════════════════════════════════════════════════

vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual<typeof import('react-router-dom')>('react-router-dom');
  return {
    ...actual,
    useParams: () => ({ id: 'est-decline-1' }),
    useSearchParams: () => [new URLSearchParams('token=tok-decline'), vi.fn()],
  };
});

vi.mock('react-signature-canvas', () => ({ default: () => null }));

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
 * Stubs `fetch` for the three calls this page can make. `reasonsOk: false` is the failure case -
 * the route answers non-2xx and the picker must still be usable.
 */
function stubPublicFetch({ reasonsOk = true }: { reasonsOk?: boolean } = {}) {
  const spy = vi.fn().mockImplementation((url: string, init?: RequestInit) => {
    if (init?.method === 'POST') {
      return Promise.resolve({
        ok: true,
        json: async () => ({ estimate: { ...SENT_ESTIMATE_RESPONSE.estimate, status: 'DECLINED' } }),
      });
    }
    if (String(url).includes('/decline-reasons')) {
      return reasonsOk
        ? Promise.resolve({ ok: true, json: async () => ({ decline_reasons: PUBLIC_ROWS }) })
        : Promise.resolve({ ok: false, json: async () => ({ error: 'nope' }) });
    }
    return Promise.resolve({ ok: true, json: async () => SENT_ESTIMATE_RESPONSE });
  });
  vi.stubGlobal('fetch', spy);
  return spy;
}

function reasonsCalls(spy: ReturnType<typeof vi.fn>) {
  return spy.mock.calls.filter(([url]) => String(url).includes('/decline-reasons'));
}

async function openPublicDeclineDialog() {
  const user = userEvent.setup();
  renderWithProviders(<PublicEstimatePage />);
  await screen.findByRole('button', { name: /Decline/i });
  await user.click(screen.getByRole('button', { name: /^Decline$/i }));
  await screen.findByRole('dialog');
  return user;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('the public decline dialog offers the organisation\'s reasons', () => {
  it('offers a reason the admin added, and not one they switched off', async () => {
    stubPublicFetch();
    const user = await openPublicDeclineDialog();

    await user.click(screen.getByRole('combobox'));

    expect(await screen.findByRole('option', { name: ADDED_LABEL })).toBeInTheDocument();
    expect(screen.queryByRole('option', { name: 'Timing' })).toBeNull();
  });

  it('asks for the list only when the dialog opens, not on page load', async () => {
    // Decision D6, and the reason this is a route of its own rather than a field on the estimate
    // payload: slice 1's acceptance says the decline dialog must not start returning anything the
    // page did not already have. Everyone holding a link loads this page; almost none of them
    // decline.
    const spy = stubPublicFetch();
    const user = userEvent.setup();
    renderWithProviders(<PublicEstimatePage />);
    await screen.findByRole('button', { name: /Decline/i });

    expect(reasonsCalls(spy)).toHaveLength(0);

    await user.click(screen.getByRole('button', { name: /^Decline$/i }));
    await screen.findByRole('dialog');

    await waitFor(() => expect(reasonsCalls(spy).length).toBeGreaterThan(0));
    // The token is the only credential the customer holds, so it has to be on the request.
    expect(String(reasonsCalls(spy)[0]![0])).toContain('token=tok-decline');
  });

  it('still lets the customer decline when the list cannot be had', async () => {
    // The whole point of failing open. A customer meeting an empty picker - or a spinner - may
    // abandon the decline, and the business would lose the STATUS and not merely the reason.
    const spy = stubPublicFetch({ reasonsOk: false });
    const user = await openPublicDeclineDialog();

    await user.click(screen.getByRole('combobox'));
    for (const option of LOST_REASON_OPTIONS) {
      expect(await screen.findByRole('option', { name: option.label })).toBeInTheDocument();
    }

    await user.keyboard('{Escape}');
    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: /Decline Estimate/i }));

    await waitFor(() =>
      expect(spy.mock.calls.some(([, init]) => (init as RequestInit | undefined)?.method === 'POST')).toBe(true),
    );
  });

  it('sends the code of the reason the customer picked', async () => {
    const spy = stubPublicFetch();
    const user = await openPublicDeclineDialog();

    await user.click(screen.getByRole('combobox'));
    await user.click(await screen.findByRole('option', { name: ADDED_LABEL }));
    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: /Decline Estimate/i }));

    await waitFor(() => {
      const post = spy.mock.calls.find(([, init]) => (init as RequestInit | undefined)?.method === 'POST');
      expect(post).toBeDefined();
      // The CODE, never the label: `estimates.lost_reason` stores this string and the conversion
      // report groups on it.
      expect(JSON.parse((post![1] as RequestInit).body as string)).toMatchObject({
        lost_reason: 'WENT_WITH_A_DESIGNER',
      });
    });
  });
});
