import { getClient, replayIntegration } from '@sentry/react';

import { scrubEventUrls } from './scrubUrl';

/**
 * Embedded frames the recorder must never open. By default it serializes the document inside
 * every iframe it does not block, and for a cross-origin frame (the phone dialer, a payment form)
 * the browser answers with a SecurityError thrown from our own page, which lands in the console.
 * A blocked element is recorded as an empty box of the same size and its contents are never read.
 * The SDK adds its own blocked selectors (`.sentry-block`, `[data-sentry-block]`, `base`, media
 * elements) to this list; it does not replace them.
 */
export const REPLAY_BLOCKED_SELECTORS = [
  'iframe',
  // The phone dialer's wrapper element holds the dialer iframe (also reached through its shadow root).
  'ctm-phone-embed',
] as const;

/**
 * The session-replay recorder, kept in its own module so the bundler can put it in a chunk of its
 * own. `instrument.ts` loads it with `import()` once the page is idle; nothing may import this
 * file statically, or the recorder is back in the first script (mobile slice 47).
 */
export function addSessionReplay(): void {
  getClient()?.addIntegration(
    replayIntegration({
      maskAllText: true,
      blockAllMedia: true,
      block: [...REPLAY_BLOCKED_SELECTORS],
      // Page addresses inside the recording (page meta, navigation) lose the compose parameters too.
      beforeAddRecordingEvent: scrubEventUrls,
    }),
  );
}
