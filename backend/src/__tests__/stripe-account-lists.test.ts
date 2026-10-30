import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Payments go-live slice 37: the reads the nightly reconcile makes of ONE connected account.
 * Each list is pinned to the account with the account header, pages until the processor says
 * there is no more, and refuses to answer with a partial list when it hits its page bound.
 */

// The global setup.ts mocks ../lib/stripe wholesale; this test exercises the REAL module.
vi.unmock('../lib/stripe');

vi.mock('../config/env', () => ({
  env: { STRIPE_SECRET_KEY: 'sk_test_dummy', STRIPE_WEBHOOK_SECRET: 'whsec_dummy', NODE_ENV: 'test' },
}));

const lists = vi.hoisted(() => ({
  charges: vi.fn(), refunds: vi.fn(), disputes: vi.fn(), sessions: vi.fn(),
}));

vi.mock('stripe', () => {
  class FakeStripe {
    charges = { list: lists.charges };
    refunds = { list: lists.refunds };
    disputes = { list: lists.disputes };
    checkout = { sessions: { list: lists.sessions } };
    static errors = {};
  }
  return { default: FakeStripe };
});

import { listAccountCharges, listAccountCheckoutSessions, listAccountDisputes, listAccountRefunds } from '../lib/stripe';

const page = (ids: string[], more: boolean) => ({ data: ids.map((id) => ({ id })), has_more: more });

beforeEach(() => {
  for (const fn of Object.values(lists)) fn.mockReset();
});

describe('account lists for the nightly reconcile', () => {
  it('reads every page, newest first as the processor returns them, always on the given connected account', async () => {
    lists.charges
      .mockResolvedValueOnce(page(['ch_1', 'ch_2'], true))
      .mockResolvedValueOnce(page(['ch_3'], false));

    const got = await listAccountCharges('acct_one', 1_700_000_000);

    expect(got.map((c) => c.id)).toEqual(['ch_1', 'ch_2', 'ch_3']);
    expect(lists.charges).toHaveBeenNthCalledWith(1, { created: { gte: 1_700_000_000 }, limit: 100 }, { stripeAccount: 'acct_one' });
    expect(lists.charges).toHaveBeenNthCalledWith(2, { created: { gte: 1_700_000_000 }, limit: 100, starting_after: 'ch_2' }, { stripeAccount: 'acct_one' });
  });

  it('lists refunds, disputes and checkout sessions the same way', async () => {
    lists.refunds.mockResolvedValue(page(['re_1'], false));
    lists.disputes.mockResolvedValue(page(['dp_1'], false));
    lists.sessions.mockResolvedValue(page(['cs_1'], false));

    expect((await listAccountRefunds('acct_two', 5)).map((r) => r.id)).toEqual(['re_1']);
    expect((await listAccountDisputes('acct_two', 5)).map((r) => r.id)).toEqual(['dp_1']);
    expect((await listAccountCheckoutSessions('acct_two', 5)).map((r) => r.id)).toEqual(['cs_1']);
    for (const fn of [lists.refunds, lists.disputes, lists.sessions]) {
      expect(fn).toHaveBeenCalledWith({ created: { gte: 5 }, limit: 100 }, { stripeAccount: 'acct_two' });
    }
  });

  it('throws instead of answering with a partial list when the page bound is hit', async () => {
    lists.charges.mockImplementation(async () => page(['ch_x'], true));

    await expect(listAccountCharges('acct_one', 1)).rejects.toThrow(/page bound/);
    expect(lists.charges).toHaveBeenCalledTimes(50);
  });
});
