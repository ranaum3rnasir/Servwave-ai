// Payments go-live slice 33b - the sign-out frame watcher does not outlive its purpose. After sign-out it
// removes the processor's late-mounted frames; it stops on the next successful sign-in, or after about
// 30 seconds, whichever comes first.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// The REAL auth store (the global setup replaces it with a selector stub): a sign-in is what ends the watch.
vi.unmock('@/stores/auth.store');

import api from '@/lib/axios';
import { resetAccountScopedStores } from '@/lib/storeReset';
import { useAuthStore } from '@/stores/auth.store';
import { getViewerConnect, getPayoutConnect } from '@/lib/payments/payout-connect';

// The processor's script is third-party and would load over the network: stand it in. The watcher is ours.
vi.mock('@stripe/connect-js/pure', () => ({ loadConnectAndInitialize: vi.fn(() => ({ logout: vi.fn() })) }));

const signIn = () => {
  vi.mocked(api.post).mockResolvedValue({ data: { user: { id: 'u1', organization_id: 'o1', email: 'a@b.test' }, abilityRules: [] } } as never);
  return useAuthStore.getState().finalizeOAuthLogin();
};

const processorFrame = () => {
  const frame = document.createElement('iframe');
  frame.src = 'https://js.stripe.com/v3/connect-preconnect.html';
  document.body.appendChild(frame);
  return frame;
};
/** MutationObserver callbacks run as microtasks. */
const settle = () => Promise.resolve().then(() => Promise.resolve());

beforeEach(() => {
  vi.useFakeTimers();
  document.body.innerHTML = '';
});
afterEach(() => {
  vi.useRealTimers();
});

describe('the sign-out frame watcher', () => {
  it('removes a processor frame that is mounted late, after sign-out', async () => {
    resetAccountScopedStores();

    const frame = processorFrame();
    await settle();

    expect(frame.isConnected).toBe(false);
  });

  it('stops once someone signs in again: a frame mounted after that is left alone', async () => {
    resetAccountScopedStores();
    await settle(); // let the one-off sweep right after sign-out run first: it is not what is under test
    await signIn();

    const frame = processorFrame();
    await settle();

    expect(frame.isConnected).toBe(true);
  });

  it('stops after about 30 seconds even if nobody signs in', async () => {
    resetAccountScopedStores();
    const early = processorFrame();
    await settle();
    expect(early.isConnected).toBe(false);

    vi.advanceTimersByTime(31_000);
    const late = processorFrame();
    await settle();

    expect(late.isConnected).toBe(true);
  });

  it('keeps watching inside the 30 seconds', async () => {
    resetAccountScopedStores();
    vi.advanceTimersByTime(20_000);

    const frame = processorFrame();
    await settle();

    expect(frame.isConnected).toBe(false);
  });

  it('stops when a new viewer session starts (the Payments page): its own frames are never deleted', async () => {
    resetAccountScopedStores();
    await settle();

    getViewerConnect();
    const frame = processorFrame();
    await settle();

    expect(frame.isConnected).toBe(true);
  });

  it('stops when a new owner session starts (the payout account page) too', async () => {
    resetAccountScopedStores();
    await settle();

    getPayoutConnect();
    const frame = processorFrame();
    await settle();

    expect(frame.isConnected).toBe(true);
  });
});
