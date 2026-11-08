import type { AxiosError } from 'axios';
import type { ToastFn } from './handle429';

// De-dupe: an outage fails every in-flight request at once (a dashboard alone
// fires ~a dozen), and each must not stack its own toast. Module-level last-shown
// stamp, matching handle429. -Infinity is the "never shown" sentinel so the
// first call after a reset is never accidentally throttled against a `now()`
// like 1000.
const DEDUPE_MS = 3000;
let lastShownAt = -Infinity;

/**
 * If `error` is a 500, show a throttled toast and return true; otherwise return
 * false so the caller keeps its normal error handling. Reads and writes both
 * toast: unlike a 402/429, a 500 means the server itself is erroring, which
 * nothing at the call site can distinguish from "the whole app is broken" -
 * silence here would just look like the request vanished. `now` is injected
 * for testability, matching handle429/handle402.
 */
export function handle500(error: AxiosError, notify: ToastFn, now: () => number): boolean {
  if (error.response?.status !== 500) return false;
  if (now() - lastShownAt < DEDUPE_MS) return true; // handled: intentionally quiet
  lastShownAt = now();
  notify({
    title: 'Something went wrong on our end',
    description: "We're having trouble reaching the server. Please try again in a moment.",
    variant: 'destructive',
  });
  return true;
}

/** Test-only: reset the de-dupe throttle between test cases. */
export function __resetHandle500Throttle(): void {
  lastShownAt = -Infinity;
}
