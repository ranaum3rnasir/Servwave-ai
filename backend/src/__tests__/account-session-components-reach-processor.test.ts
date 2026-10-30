// Payments go-live slice 34b (carry-over from the slice 34 review) - the component set of the requested
// surface reaches the processor call. The spy sits at the SDK boundary, under the real session builder
// in lib/stripe.ts, not on a mocked helper above it.
import { describe, it, expect, beforeEach, vi } from 'vitest';

const { sessionsCreate } = vi.hoisted(() => ({ sessionsCreate: vi.fn() }));

vi.unmock('../lib/stripe');
vi.mock('stripe', () => ({
  default: class RecordingProcessorClient {
    accountSessions = { create: sessionsCreate };
  },
}));

import { createAccountSession } from '../lib/stripe';
import { env } from '../config/env';
import { enabledComponentsFor } from '../lib/account-session-surfaces';

beforeEach(() => {
  vi.clearAllMocks();
  (env as { STRIPE_SECRET_KEY?: string }).STRIPE_SECRET_KEY ??= 'sk_test_recorded';
  sessionsCreate.mockResolvedValue({ client_secret: 'cs_secret_abc' });
});

describe('the account session handed to the processor', () => {
  it('the owner surface sends exactly the owner components for that account', async () => {
    const secret = await createAccountSession('acct_1', 'owner');

    expect(secret).toBe('cs_secret_abc');
    expect(sessionsCreate).toHaveBeenCalledTimes(1);
    const params = sessionsCreate.mock.calls[0][0];
    expect(params.account).toBe('acct_1');
    expect(Object.keys(params.components).sort()).toEqual(['account_management', 'account_onboarding', 'notification_banner']);
    expect(Object.keys(params.components).sort()).toEqual([...enabledComponentsFor('owner')].sort());
  });

  it('the viewer surface sends exactly the viewer components, with refunds and capture off', async () => {
    await createAccountSession('acct_1', 'viewer');

    const { components } = sessionsCreate.mock.calls[0][0];
    expect(Object.keys(components).sort()).toEqual([
      'disputes_list', 'documents', 'payment_details', 'payment_disputes', 'payments', 'payout_details', 'payouts_list',
    ]);
    expect(components.payment_disputes).toMatchObject({ enabled: true });
    expect(components.payments.features).toMatchObject({ refund_management: false, capture_payments: false });
    expect(components.balances).toBeUndefined();
    expect(components.payouts).toBeUndefined();
  });

  it('every payment-family component carries the same feature flags (the processor rejects a session where they differ)', async () => {
    await createAccountSession('acct_1', 'viewer');

    const { components } = sessionsCreate.mock.calls[0][0];
    const expected = { refund_management: false, dispute_management: true, capture_payments: false };
    for (const name of ['payments', 'payment_details', 'disputes_list']) {
      expect(components[name].features, name).toEqual(expected);
    }
    // The dispute pane has no capture flag at the processor; the two it has must agree with the rest.
    expect(components.payment_disputes.features).toEqual({ refund_management: false, dispute_management: true });
  });

  it('the two surfaces send different component sets (a surface argument that is ignored fails here)', async () => {
    await createAccountSession('acct_1', 'owner');
    await createAccountSession('acct_1', 'viewer');

    const [owner, viewer] = sessionsCreate.mock.calls.map((c) => Object.keys(c[0].components).sort());
    expect(owner).not.toEqual(viewer);
    expect(owner).not.toContain('payments');
    expect(viewer).not.toContain('account_onboarding');
  });
});
