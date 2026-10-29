/**
 * Mobile slice 75 follow-up: session replay skips embedded vendor frames.
 *
 * The recorder walks the page and, for every iframe it does not block, reaches into the frame's
 * document. For the cross-origin phone dialer that throws a SecurityError from our own page,
 * which the mobile gate's console check (rightly) fails on. The fix is to block every iframe
 * element, so the recorder keeps only its size and never opens it. This test reads the options the
 * real recorder was built with, not a mock of them.
 */
import { beforeAll, describe, expect, it, vi } from 'vitest';

type Recorder = { _recordingOptions: Record<string, unknown>; _initialOptions: Record<string, unknown> };
const added = vi.hoisted(() => ({ integration: undefined as undefined | Recorder }));

vi.mock('@sentry/react', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@sentry/react')>();
  return {
    ...actual,
    getClient: () => ({
      addIntegration: (integration: Recorder) => {
        added.integration = integration;
      },
    }),
  };
});

import { addSessionReplay } from './replay';

/** What the recorder blocks: the element is replaced by an empty box of the same size. */
function isBlocked(el: Element): boolean {
  const selector = added.integration?._recordingOptions?.blockSelector as string;
  return el.matches(selector);
}

describe('addSessionReplay', () => {
  beforeAll(() => {
    // The recorder refuses a second instance in one page, so it is built once for the file.
    addSessionReplay();
  });

  it('adds a recorder', () => {
    expect(added.integration).toBeDefined();
  });

  it('blocks a plain iframe', () => {
    const frame = document.createElement('iframe');
    frame.src = 'https://frames.example.invalid/embed';
    expect(isBlocked(frame)).toBe(true);
  });

  it('blocks the iframe inside the phone dialer embed', () => {
    const dialer = document.createElement('ctm-phone-embed');
    const frame = document.createElement('iframe');
    dialer.appendChild(frame);
    expect(isBlocked(frame)).toBe(true);
    expect(isBlocked(dialer)).toBe(true);
  });

  it('blocks an iframe that sits inside a shadow root', () => {
    const host = document.createElement('div');
    const shadow = host.attachShadow({ mode: 'open' });
    const frame = document.createElement('iframe');
    shadow.appendChild(frame);
    expect(isBlocked(frame)).toBe(true);
  });

  it('blocks the payment form container', () => {
    const container = document.createElement('div');
    container.setAttribute('data-sentry-block', '');
    expect(isBlocked(container)).toBe(true);
    const frame = document.createElement('iframe');
    container.appendChild(frame);
    expect(isBlocked(frame)).toBe(true);
  });

  it('still records our own markup', () => {
    for (const tag of ['div', 'button', 'section', 'p', 'form']) {
      expect(isBlocked(document.createElement(tag))).toBe(false);
    }
  });

  it('keeps the privacy masking: all text masked, inputs masked, media blocked', () => {
    const options = added.integration!._recordingOptions;
    expect(options.maskAllInputs).toBe(true);
    expect(options.maskTextSelector).toContain('.sentry-mask');
    expect(added.integration?._initialOptions.maskAllText).toBe(true);
    expect(isBlocked(document.createElement('img'))).toBe(true);
    expect(isBlocked(document.createElement('video'))).toBe(true);
  });

  it('does not try to record cross-origin frames', () => {
    expect(added.integration?._recordingOptions.recordCrossOriginIframes).toBe(false);
  });
});
