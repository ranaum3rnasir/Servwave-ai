/**
 * #2031 slice 5 (F2) — the real checkout-expiry sweep.
 *
 * setup.ts mocks `../lib/stripe` wholesale so controller tests can assert the wiring; this file
 * tests the implementation those tests stand in for.
 *
 * The contract that matters is the failure contract. Expiring is an external call on a path that
 * must succeed regardless — an estimate edit, a send — so nothing here may throw. What it must do
 * instead is tell the truth: `ok` is false whenever the sweep cannot prove that no open session
 * for the invoice survives, because the caller's whole reason for calling is to be able to say the
 * customer's old link is dead.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.unmock('../lib/stripe');

import { expireOpenCheckoutSessionsForInvoice, expireCheckoutSession } from '../lib/stripe';

const INVOICE_ID = 'aaaaaaaa-0000-4000-8000-0000000000e1';

function session(id: string, invoiceId?: string) {
  return { id, metadata: invoiceId ? { invoiceId } : {} };
}

function stripeWith(pages: Array<{ data: unknown[]; has_more?: boolean }>) {
  const list = vi.fn();
  pages.forEach((page) => list.mockResolvedValueOnce({ has_more: false, ...page }));
  const expire = vi.fn().mockResolvedValue({});
  return { stripe: { checkout: { sessions: { list, expire } } } as never, list, expire };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('expireOpenCheckoutSessionsForInvoice', () => {
  it('expires only the open sessions that belong to this invoice, on the connected account', async () => {
    const { stripe, list, expire } = stripeWith([{
      data: [session('cs_other', 'some-other-invoice'), session('cs_mine', INVOICE_ID), session('cs_none')],
    }]);

    const result = await expireOpenCheckoutSessionsForInvoice(INVOICE_ID, { stripe, stripeAccount: 'acct_x' });

    expect(result).toEqual({ expired: ['cs_mine'], failed: 0, ok: true });
    // Only OPEN sessions can settle; a completed or already-expired one is not our business.
    expect(list.mock.calls[0][0]).toMatchObject({ status: 'open' });
    expect(list.mock.calls[0][1]).toEqual({ stripeAccount: 'acct_x' });
    expect(expire).toHaveBeenCalledTimes(1);
    expect(expire.mock.calls[0][0]).toBe('cs_mine');
    expect(expire.mock.calls[0][2]).toEqual({ stripeAccount: 'acct_x' });
  });

  it('walks past the first page — the invoice\'s session may not be on it', async () => {
    const { stripe, expire, list } = stripeWith([
      { data: [session('cs_a', 'other'), session('cs_b', 'other')], has_more: true },
      { data: [session('cs_mine', INVOICE_ID)], has_more: false },
    ]);

    const result = await expireOpenCheckoutSessionsForInvoice(INVOICE_ID, { stripe });

    expect(result.expired).toEqual(['cs_mine']);
    expect(result.ok).toBe(true);
    expect(list.mock.calls[1][0]).toMatchObject({ starting_after: 'cs_b' });
  });

  it('reports a sweep it could not finish rather than throwing', async () => {
    const stripe = {
      checkout: { sessions: { list: vi.fn().mockRejectedValue(new Error('stripe is down')), expire: vi.fn() } },
    } as never;

    const result = await expireOpenCheckoutSessionsForInvoice(INVOICE_ID, { stripe });

    expect(result.ok).toBe(false);
    expect(result.expired).toEqual([]);
  });

  it('reports a session Stripe refused to expire, and keeps going', async () => {
    const { stripe, expire } = stripeWith([{
      data: [session('cs_stuck', INVOICE_ID), session('cs_ok', INVOICE_ID)],
    }]);
    expire.mockRejectedValueOnce(new Error('cannot expire'));

    const result = await expireOpenCheckoutSessionsForInvoice(INVOICE_ID, { stripe });

    expect(result).toEqual({ expired: ['cs_ok'], failed: 1, ok: false });
  });

  it('does not claim success when there are more open pages than it will read', async () => {
    const list = vi.fn().mockResolvedValue({ data: [session('cs_x', 'other')], has_more: true });
    const stripe = { checkout: { sessions: { list, expire: vi.fn() } } } as never;

    const result = await expireOpenCheckoutSessionsForInvoice(INVOICE_ID, { stripe });

    expect(result.ok).toBe(false);
  });
});

describe('expireCheckoutSession', () => {
  it('answers false instead of throwing when Stripe refuses', async () => {
    const stripe = {
      checkout: { sessions: { expire: vi.fn().mockRejectedValue(new Error('nope')) } },
    } as never;

    await expect(expireCheckoutSession('cs_1', { stripe })).resolves.toBe(false);
  });
});
