import type { AxiosError } from 'axios';

/** The subset of the shadcn `toast()` surface this module uses. */
export interface ToastFn {
  (opts: { title: string; description?: string; variant?: 'default' | 'destructive' }): unknown;
}

/** Wait-seconds from a 429: the `Retry-After` header first, then the body's `retryAfter`. */
function parseRetryAfterSeconds(error: AxiosError): number | null {
  const header = error.response?.headers?.['retry-after'];
  const fromHeader = header != null ? Number(header) : NaN;
  if (Number.isFinite(fromHeader) && fromHeader > 0) return Math.ceil(fromHeader);
  const body = error.response?.data as { retryAfter?: unknown } | undefined;
  if (typeof body?.retryAfter === 'number' && body.retryAfter > 0) return Math.ceil(body.retryAfter);
  return null;
}

// De-dupe: a burst of 429s must not stack toasts. Module-level last-shown stamp.
// -Infinity (not 0) is the "never shown" sentinel so the first call after a
// reset is never accidentally throttled against a `now()` like 1000.
const DEDUPE_MS = 3000;
let lastShownAt = -Infinity;

/**
 * If `error` is a 429, show a throttled toast and return true; otherwise return
 * false so the caller keeps its normal error handling. NEVER retries — blind
 * retry on 429 only deepens the block. `now` is injected for testability.
 */
export function handle429(error: AxiosError, notify: ToastFn, now: () => number): boolean {
  if (error.response?.status !== 429) return false;
  if (now() - lastShownAt < DEDUPE_MS) return true; // handled: intentionally quiet
  lastShownAt = now();
  const secs = parseRetryAfterSeconds(error);
  notify({
    title: 'Slow down',
    description:
      secs != null
        ? `You're doing that too quickly. Try again in ~${secs}s.`
        : "You're doing that too quickly. Please wait a moment and try again.",
    variant: 'destructive',
  });
  return true;
}

/** Test-only: reset the de-dupe throttle between test cases. */
export function __resetHandle429Throttle(): void {
  lastShownAt = -Infinity;
}
