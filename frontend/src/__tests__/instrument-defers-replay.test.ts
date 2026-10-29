/**
 * Mobile slice 47: session replay is a large recorder, and it used to be part of the first
 * script every page downloads. It is now added after the page has settled.
 *
 * Each entry imports its instrument file first (`instrument.ts` for the staff app,
 * `instrument-public.ts` for the page a customer's link opens), so what either puts in its
 * initial graph is paid by every visitor to that entry.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const sentry = vi.hoisted(() => ({
  init: vi.fn(),
  addIntegration: vi.fn(),
  addEventProcessor: vi.fn(),
  replayIntegration: vi.fn(() => ({ name: 'Replay' })),
  reactRouterV7BrowserTracingIntegration: vi.fn(() => ({ name: 'BrowserTracing' })),
}));

vi.mock('@sentry/react', () => ({
  init: sentry.init,
  addEventProcessor: sentry.addEventProcessor,
  getClient: () => ({ addIntegration: sentry.addIntegration }),
  replayIntegration: sentry.replayIntegration,
  reactRouterV7BrowserTracingIntegration: sentry.reactRouterV7BrowserTracingIntegration,
}));

function initOptions() {
  return sentry.init.mock.calls[0]![0] as { integrations?: { name: string }[] } & Record<string, unknown>;
}

describe.each([
  ['staff', '../instrument'],
  ['public', '../instrument-public'],
])('%s instrument', (_entry, file) => {
  beforeEach(() => {
    vi.resetModules();
    vi.useFakeTimers();
    vi.stubEnv('VITE_SENTRY_DSN', 'https://key@example.invalid/1');
    sentry.init.mockClear();
    sentry.addIntegration.mockClear();
    sentry.addEventProcessor.mockClear();
    sentry.replayIntegration.mockClear();
    sentry.reactRouterV7BrowserTracingIntegration.mockClear();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
  });

  it('starts Sentry without the replay recorder in its initial integrations', async () => {
    await import(/* @vite-ignore */ file);
    expect(sentry.init).toHaveBeenCalledTimes(1);
    expect((initOptions().integrations ?? []).map((i) => i.name)).not.toContain('Replay');
    expect(sentry.replayIntegration).not.toHaveBeenCalled();
  });

  it('registers the address scrubber as an event processor, so replay events lose the compose parameters', async () => {
    await import(/* @vite-ignore */ file);
    expect(sentry.addEventProcessor).toHaveBeenCalledTimes(1);
  });

  it('keeps the replay sampling rates and the environment label, so nothing else about reporting moves', async () => {
    vi.stubEnv('VITE_SENTRY_ENVIRONMENT', 'staging');
    await import(/* @vite-ignore */ file);
    const options = initOptions();
    expect(options.replaysSessionSampleRate).toBe(0.1);
    expect(options.replaysOnErrorSampleRate).toBe(1.0);
    expect(options.environment).toBe('staging');
    expect(options.dsn).toBe('https://key@example.invalid/1');
  });

  it('adds the recorder later, masked exactly as before, once the page is idle', async () => {
    await import(/* @vite-ignore */ file);
    await vi.advanceTimersByTimeAsync(10_000);
    await vi.dynamicImportSettled();
    // Masking is unchanged; the blocked selectors are the embedded frames the recorder must not open
    // (mobile slice 75 follow-up; the selectors themselves are pinned in replay.test.ts).
    expect(sentry.replayIntegration).toHaveBeenCalledWith({
      maskAllText: true,
      blockAllMedia: true,
      block: ['iframe', 'ctm-phone-embed'],
      // The recording's page addresses are scrubbed of the compose parameters (V7-07a).
      beforeAddRecordingEvent: expect.any(Function),
    });
    expect(sentry.addIntegration).toHaveBeenCalledTimes(1);
  });

  it('loads no recorder at all when Sentry has no DSN', async () => {
    vi.stubEnv('VITE_SENTRY_DSN', '');
    await import(/* @vite-ignore */ file);
    await vi.advanceTimersByTimeAsync(10_000);
    await vi.dynamicImportSettled();
    expect(sentry.replayIntegration).not.toHaveBeenCalled();
    expect(sentry.addIntegration).not.toHaveBeenCalled();
  });
});

describe('what each entry traces', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.useFakeTimers();
    sentry.init.mockClear();
    sentry.reactRouterV7BrowserTracingIntegration.mockClear();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('the staff app keeps page-load and navigation tracing', async () => {
    await import('../instrument');
    expect(sentry.reactRouterV7BrowserTracingIntegration).toHaveBeenCalledTimes(1);
    expect(initOptions().tracesSampleRate).toBeGreaterThan(0);
  });

  it('the page a customer opens reports errors only: no tracing integration, whose weight breaks the 200 KB budget', async () => {
    await import('../instrument-public');
    expect(sentry.reactRouterV7BrowserTracingIntegration).not.toHaveBeenCalled();
    expect(initOptions().integrations ?? []).toEqual([]);
    expect(initOptions().tracesSampleRate).toBeUndefined();
  });
});
