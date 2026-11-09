/* =============================================================================
   The after-response tracker: work a route starts after (or beside) its answer is registered, and a test waits for ALL of it
   to be over instead of sleeping. A drain that does not finish in time FAILS.
   ========================================================================== */

import { describe, it, expect } from 'vitest';
import { queueAlertAfterResponse } from '../services/notifications/reviewAttentionQueue';
import { trackAfterResponse, afterResponseDrained, pendingAfterResponse, forgetPendingAfterResponse } from '../lib/after-response';

const later = <T>(ms: number, value: T) => new Promise<T>((resolve) => setTimeout(() => resolve(value), ms));

describe('after-response tracker', () => {
  it('hands back the very promise it was given, result and failure alike', async () => {
    await expect(trackAfterResponse(Promise.resolve(7))).resolves.toBe(7);
    const failing = Promise.reject(new Error('boom'));
    await expect(trackAfterResponse(failing)).rejects.toThrow('boom');
    await afterResponseDrained();
  });

  it('a drain waits until tracked work has finished', async () => {
    let done = false;
    trackAfterResponse(later(60, 1).then(() => { done = true; }));
    expect(pendingAfterResponse()).toBe(1);
    await afterResponseDrained();
    expect(done).toBe(true);
    expect(pendingAfterResponse()).toBe(0);
  });

  it('a drain also waits for work that tracked work starts while it runs', async () => {
    let second = false;
    trackAfterResponse(later(30, 1).then(() => { trackAfterResponse(later(60, 1).then(() => { second = true; })); }));
    await afterResponseDrained();
    expect(second).toBe(true);
  });

  it('a drain with nothing pending answers at once', async () => {
    await afterResponseDrained();
  });

  it('a drain that times out FAILS and says how much work was still pending', async () => {
    const never = new Promise<void>(() => undefined);
    trackAfterResponse(never);
    await expect(afterResponseDrained({ timeoutMs: 50 })).rejects.toThrow(/1 piece of after-response work still pending/);
    // leave the tracker clean for later cases in this file
    forgetPendingAfterResponse();
    expect(pendingAfterResponse()).toBe(0);
  });

  it('failing tracked work does not make the drain fail (the route already logged it)', async () => {
    trackAfterResponse(Promise.reject(new Error('logged elsewhere'))).catch(() => undefined);
    await afterResponseDrained();
  });

  it('a queued review-attention alert holds the drain until it has been sent', async () => {
    let sent = false;
    queueAlertAfterResponse({ orgId: 'o', actorId: null, send: async () => { await later(80, 1); sent = true; } });
    await afterResponseDrained();
    expect(sent).toBe(true);
  });

  it('a review-attention alert that never finishes makes the drain FAIL', async () => {
    queueAlertAfterResponse({ orgId: 'o', actorId: null, send: () => new Promise<void>(() => undefined) });
    await expect(afterResponseDrained({ timeoutMs: 50 })).rejects.toThrow(/still pending/);
  });
});
