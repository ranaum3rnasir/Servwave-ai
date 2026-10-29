import { useEffect, useRef } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import api from '@/lib/axios';
import { mapOwnedNumber, type PhoneNumberRow } from '@/lib/api/communication';
import { NUMBER_ASSIGNMENTS_KEY } from '@/lib/api/phoneNumbers';

/** POST /api/communication/numbers/sync-if-stale response. `numbers` is the
 *  org's list in the GET /numbers shape. `stillRunning` is true when the sync
 *  outlasted the server's wait: `numbers` is the list as stored before it, and
 *  the run carries on. */
export type BackgroundNumberSyncResponse = {
  changed: boolean;
  stillRunning?: boolean;
  numbers: PhoneNumberRow[];
};

const SYNC_IF_STALE_URL = '/api/communication/numbers/sync-if-stale';
const NUMBERS_KEY = ['communication', 'numbers'] as const;

/** How long the screen waits before asking once more when the server said the
 *  sync was still running. The server waits 15 seconds for a run; this gives a
 *  slow run a little longer to finish before the second ask. */
export const BACKGROUND_SYNC_RETRY_MS = 20_000;

/**
 * Opening a phone-numbers screen syncs the org's numbers in the background, so
 * a number added in the phone system shows up without anyone pressing Sync.
 *
 * Call it once at the top of the screen. It asks the server once per mount
 * (the server skips the sync when the org synced in the last minute) and, only
 * when the server reports `changed`:
 *  - puts the returned list into the Communication numbers cache (the Phone
 *    page seeds its list from that cache);
 *  - refetches the Caller ID list (numbers plus who can use them), which comes
 *    from its own endpoint and so cannot be patched from this response.
 *
 * When the server answers `stillRunning` (the sync outlasted its wait), the
 * hook asks ONCE more after `BACKGROUND_SYNC_RETRY_MS` and applies that list
 * whatever its `changed` says: by then the run has usually finished, so the
 * second answer comes from the server's one-minute window (`changed: false`)
 * with the list the run stored, which the screen has not seen. A second answer
 * that is again `stillRunning` is ignored. The second ask is never repeated,
 * and is dropped when the screen closes first.
 *
 * The screen shows its stored list meanwhile. A failure is silent by design:
 * no toast (the request opts out of the app-wide error toasts), no error
 * state, the list stays as it was. The server logs it.
 *
 * Once per mount: a ref guards the request, because React StrictMode runs a
 * mount effect twice in development and the ref survives that.
 */
export function useBackgroundNumberSync({
  enabled = true,
}: {
  /** False until the screen may load its list at all. */
  enabled?: boolean;
} = {}): void {
  const qc = useQueryClient();
  const requested = useRef(false);
  const mounted = useRef(false);
  const retryTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  // Tracks the screen being open, for the second ask. Its own effect, so
  // StrictMode's simulated unmount and remount leave it true.
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      clearTimeout(retryTimer.current);
    };
  }, []);

  useEffect(() => {
    if (!enabled || requested.current) return;
    requested.current = true;

    async function ask(): Promise<BackgroundNumberSyncResponse | undefined> {
      // silentErrors: the app-wide error toasts (server error, rate limit,
      // plan) must not fire for a sync the viewer never asked for.
      const res = await api.post(SYNC_IF_STALE_URL, undefined, { silentErrors: true });
      return res?.data as BackgroundNumberSyncResponse | undefined;
    }

    async function apply(body: BackgroundNumberSyncResponse): Promise<void> {
      if (!Array.isArray(body.numbers)) return;
      const numbers = body.numbers.map(mapOwnedNumber);
      // A list fetch still in flight would land after this and put the
      // older list back.
      await qc.cancelQueries({ queryKey: NUMBERS_KEY });
      qc.setQueryData(NUMBERS_KEY, numbers);
      void qc.invalidateQueries({ queryKey: NUMBER_ASSIGNMENTS_KEY });
    }

    void (async () => {
      try {
        const body = await ask();
        if (body?.changed === true) await apply(body);
        if (body?.stillRunning === true && mounted.current) {
          retryTimer.current = setTimeout(() => {
            void (async () => {
              try {
                const late = await ask();
                // Still running again: the list is the stored one mid-run,
                // not the result, so there is nothing new to show.
                if (late && late.stillRunning !== true && mounted.current) await apply(late);
              } catch {
                // Silent, like the first ask.
              }
            })();
          }, BACKGROUND_SYNC_RETRY_MS);
        }
      } catch {
        // Silent: the stored list stays on screen. The server logged it.
      }
    })();
  }, [enabled, qc]);
}
