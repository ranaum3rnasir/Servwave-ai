/**
 * Mobile slice 61 (PERF-03): the public estimate warms the decline dialog's chunk so the first tap
 * on Decline does not wait for it. It used to do that the moment the page mounted and was idle,
 * which is while the estimate itself is still being fetched: on a slow phone connection that
 * competed with the document for bandwidth and pushed the largest paint out by about half a
 * second. It now waits until the estimate is on screen, plus a quiet period.
 *
 * One test, in two parts, because the chunk's module is evaluated once per file: first a page whose
 * estimate never arrives (the chunk must not be fetched, however long it waits), then one that loads
 * (not fetched at once, fetched after the quiet period).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { screen } from '@testing-library/react';
import { renderPublicEstimate, servePublicEstimate } from '@/__tests__/harness/publicEstimatePage';

const dialogLoaded = vi.hoisted(() => ({ value: false }));
vi.mock('@/pages/v2/auth-public/components/declineDialog', () => {
  dialogLoaded.value = true;
  return { default: () => null, DeclineDialog: () => null };
});

vi.mock('react-router-dom', async () => (await import('@/__tests__/harness/publicEstimateMocks')).publicRouter());

// jsdom has no canvas; the signature pad is not what this test is about.
vi.mock('react-signature-canvas', async () => (await import('@/__tests__/harness/publicEstimateMocks')).blankPad());

const RESPONSE = {
  estimate: {
    id: 'est-warm',
    estimate_number: 'E00777',
    status: 'SENT',
    tax_rate: 0,
    subtotal: 100,
    tax_amount: 0,
    total_amount: 100,
    scope_notes: '',
    line_items: [],
    send_config: { deposit_required: false, deposit_percentage: 0, deposit_amount: 0, payment_methods: [], message_body: null },
    invoices: [],
    lead: { customer: { first_name: 'Pat', last_name: 'Customer', company_name: null } },
    customer: null,
    signature_data: null,
    signature_at: null,
  },
  organization: { name: 'Org', estimate_terms: null, phone: null },
  payment_instructions: {},
  expired: false,
};

describe('public estimate: warming the decline dialog', () => {
  beforeEach(() => {
    dialogLoaded.value = false;
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('waits for the estimate to be on screen, and then for a quiet period', async () => {
    // Part 1: a fetch that never answers, so the page stays on its loading state.
    servePublicEstimate({ never: true });
    const first = renderPublicEstimate({ id: 'est-warm', token: 'tok-warm' });
    await vi.advanceTimersByTimeAsync(20_000);
    expect(dialogLoaded.value, 'not fetched while the estimate is still loading').toBe(false);
    first.unmount();

    // Part 2: the estimate arrives.
    servePublicEstimate({ page: RESPONSE });
    renderPublicEstimate({ id: 'est-warm', token: 'tok-warm' });
    expect(await screen.findByRole('button', { name: /^Decline$/ })).toBeInTheDocument();
    expect(dialogLoaded.value, 'not at the moment the document appears').toBe(false);
    await vi.advanceTimersByTimeAsync(1000);
    expect(dialogLoaded.value, 'not within a second of it').toBe(false);
    await vi.advanceTimersByTimeAsync(8000);
    expect(dialogLoaded.value, 'but once the page has settled').toBe(true);
  });
});
