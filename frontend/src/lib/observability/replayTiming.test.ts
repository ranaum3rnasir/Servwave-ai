/**
 * Mobile slice 61 (PERF-03): the session-replay recorder (a 40 KB chunk) used to be fetched the
 * first time the page was idle, which on a phone is while the document's own data is still on the
 * wire. It now waits for the load event and a quiet period (`runAfterSettle`), so it cannot slow
 * the first paint of a customer's estimate.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The recorder's module is evaluated once per file, so loading is observed by its entry point being called.
const addSessionReplay = vi.hoisted(() => vi.fn());
vi.mock('./replay', () => ({ addSessionReplay }));

import { loadReplayWhenIdle } from './sentryBase';

describe('loadReplayWhenIdle', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubEnv('VITE_SENTRY_DSN', 'https://key@example.invalid/1');
    addSessionReplay.mockClear();
    (window as unknown as { requestIdleCallback: unknown }).requestIdleCallback = (cb: () => void) => setTimeout(cb, 0);
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
    delete (window as unknown as { requestIdleCallback?: unknown }).requestIdleCallback;
  });

  it('does not fetch the recorder at the first idle moment', async () => {
    loadReplayWhenIdle();
    await vi.advanceTimersByTimeAsync(1000);
    expect(addSessionReplay).not.toHaveBeenCalled();
  });

  it('fetches it once the page has been quiet for a few seconds', async () => {
    loadReplayWhenIdle();
    await vi.advanceTimersByTimeAsync(5000);
    expect(addSessionReplay).toHaveBeenCalledTimes(1);
  });

  it('fetches nothing without a DSN, as before', async () => {
    vi.stubEnv('VITE_SENTRY_DSN', '');
    loadReplayWhenIdle();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(addSessionReplay).not.toHaveBeenCalled();
  });
});
