import { queryClient } from '@/lib/queryClient';
import { registerStoreReset } from '@/lib/storeReset';

/**
 * P17 - the client refreshes its copy of the person's switches when the server says they changed, not on a timer.
 *
 * Every authenticated response carries a version stamp of the signed-in person's switches (their own rows, their
 * role's rows, their role assignment). The first stamp seen is held; a later response with a different stamp means
 * an Admin changed something since, so the held copy of the switches is marked stale and refetched at once. The
 * server still decides every request: this only keeps menus and buttons from lagging behind a change.
 *
 * The header name is mirrored in the backend (`SWITCHES_STAMP_HEADER`); axios lower-cases header names.
 */
export const SWITCHES_STAMP_HEADER = 'x-access-stamp';

/** The query the stamp invalidates. Declared here, not imported from mySwitches, so that module can import this one. */
export const MY_SWITCHES_QUERY_KEY = ['permission-switches', 'me'] as const;

let held: string | null = null;

/** Called with the stamp of every authenticated response. A change since the held one refetches the switches. */
export function noteSwitchesStamp(stamp: unknown): void {
  if (typeof stamp !== 'string' || stamp === '') return;
  const previous = held;
  held = stamp;
  if (previous !== null && previous !== stamp) {
    void queryClient.invalidateQueries({ queryKey: MY_SWITCHES_QUERY_KEY });
  }
}

/** The stamp currently held, for a test. */
export function heldSwitchesStamp(): string | null {
  return held;
}

// A different account must not inherit the previous one's stamp.
registerStoreReset(() => {
  held = null;
});
