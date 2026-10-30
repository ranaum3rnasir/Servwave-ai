import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { PAYMENTS_CHANNEL, channelAvailable, postAttached, subscribe } from '../paymentsChannel';

/** A same-name registry, like the browser's: a message posted on one instance reaches the OTHER instances of that name. */
class FakeChannel {
  static all: FakeChannel[] = [];
  closed = false;
  onmessage: ((e: { data: unknown }) => void) | null = null;
  constructor(public name: string) {
    FakeChannel.all.push(this);
  }
  postMessage(data: unknown) {
    for (const c of FakeChannel.all) if (c !== this && !c.closed && c.name === this.name) c.onmessage?.({ data });
  }
  close() {
    this.closed = true;
  }
}

describe('paymentsChannel', () => {
  beforeEach(() => {
    FakeChannel.all = [];
    vi.stubGlobal('BroadcastChannel', FakeChannel);
  });
  afterEach(() => vi.unstubAllGlobals());

  it('hands the invoice tab\'s message to the Payments tab on the shared channel name', () => {
    const seen = vi.fn();
    subscribe(seen);
    postAttached({ invoice_number: 'INV-1042', amount: 150 });
    expect(FakeChannel.all.every((c) => c.name === PAYMENTS_CHANNEL)).toBe(true);
    expect(seen).toHaveBeenCalledWith({ invoice_number: 'INV-1042', amount: 150 });
  });

  it('closes the channel it opened to post, and the one it opened to listen when unsubscribed', () => {
    const stop = subscribe(vi.fn());
    postAttached({ invoice_number: 'INV-1', amount: 10 });
    const [listener, poster] = FakeChannel.all as [FakeChannel, FakeChannel];
    expect(poster.closed).toBe(true);
    expect(listener.closed).toBe(false);
    stop();
    expect(listener.closed).toBe(true);
  });

  it('ignores a message that is not the attached shape', () => {
    const seen = vi.fn();
    subscribe(seen);
    const stranger = new FakeChannel(PAYMENTS_CHANNEL);
    stranger.postMessage({ type: 'something-else' });
    stranger.postMessage({ type: 'unapplied-attached', invoice_number: 5, amount: 'x' });
    stranger.postMessage(null);
    expect(seen).not.toHaveBeenCalled();
  });

  it.each([
    ['a zero amount', { invoice_number: 'INV-1', amount: 0 }],
    ['a negative amount', { invoice_number: 'INV-1', amount: -5 }],
    ['a non-finite amount', { invoice_number: 'INV-1', amount: Infinity }],
    ['an invoice number that is not an invoice number', { invoice_number: 'Click here to win', amount: 5 }],
    ['an over-long invoice number', { invoice_number: 'INV-' + '1'.repeat(40), amount: 5 }],
  ])('ignores %s', (_n, body) => {
    const seen = vi.fn();
    subscribe(seen);
    new FakeChannel(PAYMENTS_CHANNEL).postMessage({ type: 'unapplied-attached', ...body });
    expect(seen).not.toHaveBeenCalled();
  });

  it('reports whether it can listen, so a page knows when it needs a fallback', () => {
    expect(channelAvailable()).toBe(true);
    vi.stubGlobal('BroadcastChannel', undefined);
    expect(channelAvailable()).toBe(false);
  });

  it('does nothing, and does not throw, in a browser with no BroadcastChannel', () => {
    vi.stubGlobal('BroadcastChannel', undefined);
    const stop = subscribe(vi.fn());
    expect(() => postAttached({ invoice_number: 'INV-1', amount: 10 })).not.toThrow();
    expect(() => stop()).not.toThrow();
  });
});
