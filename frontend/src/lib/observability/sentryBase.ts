/**
 * What the staff entry (`instrument.ts`) and the public entry (`instrument-public.ts`) share when
 * they start error reporting. Deliberately imports nothing from the SDK, so it adds no weight of
 * its own to either entry.
 */

import { runAfterSettle } from '@/lib/platform/runAfterSettle';

import { scrubEventUrls } from './scrubUrl';

/** Options common to both entries. */
export function sentryBaseOptions() {
  return {
    dsn: import.meta.env.VITE_SENTRY_DSN as string | undefined,
    // MODE is "production" for every `vite build`, so staging and prod would be
    // indistinguishable; each Vercel project sets VITE_SENTRY_ENVIRONMENT.
    environment: (import.meta.env.VITE_SENTRY_ENVIRONMENT ?? import.meta.env.MODE) as string,

    // Session Replay sampling: record 10% of all sessions, but 100% of any session
    // that hits an error. Read by the recorder when `loadReplayWhenIdle` adds it.
    replaysSessionSampleRate: 0.1,
    replaysOnErrorSampleRate: 1.0,

    // The Email compose address can carry a pay link: every URL the SDK sends is scrubbed first (see scrubUrl.ts).
    beforeSend: scrubEventUrls,
    beforeSendTransaction: scrubEventUrls,
    beforeBreadcrumb: scrubEventUrls,
  };
}

/**
 * Add Session Replay once the page has settled (mobile slice 47, then 61). The recorder is a large
 * chunk, and both entries import their instrument file first, so a recorder bundled there would be
 * paid by every visitor, including a customer opening an estimate on a phone. Added late, it
 * records from that point: the first moments of a page load are not in a replay, which is the
 * price of keeping it off the critical path. Masking is unchanged: this is a customer CRM, so
 * every text node is masked and all media is blocked.
 *
 * "Settled" is the load event, a quiet period and an idle moment (`runAfterSettle`). Slice 47 used
 * the first idle moment, which on a phone is while the page's own data is still on the wire, so the
 * recorder's 40 KB competed with the document for the connection.
 *
 * Nothing is loaded when Sentry has no DSN (dev, test and CI builds), as before.
 */
export function loadReplayWhenIdle(): void {
  if (!import.meta.env.VITE_SENTRY_DSN || typeof window === 'undefined') return;

  runAfterSettle(
    () => {
      import('./replay')
        .then(({ addSessionReplay }) => addSessionReplay())
        .catch(() => {
          // A failed chunk load costs the replay, never the page.
        });
    },
    { delayMs: 3000, timeoutMs: 5000 },
  );
}
