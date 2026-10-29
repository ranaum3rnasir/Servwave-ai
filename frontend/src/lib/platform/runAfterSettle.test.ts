/**
 * Mobile slice 61 (PERF-03): work that nobody is waiting for must not compete with the first
 * paint. `runAfterSettle` is the one rule for it: wait for the page's load event, then a quiet
 * period, then an idle moment, and only then run. Used for the error-reporting recorder and for the
 * public estimate's decline dialog, both of which used to start the moment the page was idle, which
 * on a phone is during the document's own data fetch.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runAfterSettle } from './runAfterSettle';

function setReadyState(state: DocumentReadyState) {
  Object.defineProperty(document, 'readyState', { configurable: true, get: () => state });
}

describe('runAfterSettle', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    setReadyState('complete');
    // An engine with requestIdleCallback that runs the callback as soon as it is asked.
    (window as unknown as { requestIdleCallback: unknown }).requestIdleCallback = (cb: () => void) => setTimeout(cb, 0);
    (window as unknown as { cancelIdleCallback: unknown }).cancelIdleCallback = (h: number) => clearTimeout(h);
  });
  afterEach(() => {
    vi.useRealTimers();
    delete (window as unknown as { requestIdleCallback?: unknown }).requestIdleCallback;
    delete (window as unknown as { cancelIdleCallback?: unknown }).cancelIdleCallback;
    // Remove the own-property override so jsdom's own `readyState` shows again.
    delete (document as unknown as { readyState?: unknown }).readyState;
  });

  it('does not run the task straight away, even when the page is loaded and idle', () => {
    const task = vi.fn();
    runAfterSettle(task, { delayMs: 3000 });
    vi.advanceTimersByTime(2999);
    expect(task).not.toHaveBeenCalled();
  });

  it('runs it once, after the quiet period and an idle moment', () => {
    const task = vi.fn();
    runAfterSettle(task, { delayMs: 3000 });
    vi.advanceTimersByTime(3001);
    expect(task).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(60_000);
    expect(task).toHaveBeenCalledTimes(1);
  });

  it('waits for the load event: the quiet period does not start while the page is still loading', () => {
    setReadyState('loading');
    const task = vi.fn();
    runAfterSettle(task, { delayMs: 3000 });
    vi.advanceTimersByTime(30_000);
    expect(task).not.toHaveBeenCalled();
    window.dispatchEvent(new Event('load'));
    vi.advanceTimersByTime(2999);
    expect(task).not.toHaveBeenCalled();
    vi.advanceTimersByTime(2);
    expect(task).toHaveBeenCalledTimes(1);
  });

  it('can be cancelled before it runs, including before the load event', () => {
    const early = vi.fn();
    const cancelEarly = runAfterSettle(early, { delayMs: 3000 });
    vi.advanceTimersByTime(1000);
    cancelEarly();
    vi.advanceTimersByTime(60_000);
    expect(early).not.toHaveBeenCalled();

    setReadyState('loading');
    const unloaded = vi.fn();
    const cancelUnloaded = runAfterSettle(unloaded, { delayMs: 3000 });
    cancelUnloaded();
    window.dispatchEvent(new Event('load'));
    vi.advanceTimersByTime(60_000);
    expect(unloaded).not.toHaveBeenCalled();
  });

  it('still runs where the engine has no requestIdleCallback', () => {
    delete (window as unknown as { requestIdleCallback?: unknown }).requestIdleCallback;
    const task = vi.fn();
    runAfterSettle(task, { delayMs: 3000 });
    vi.advanceTimersByTime(3001);
    expect(task).toHaveBeenCalledTimes(1);
  });
});
