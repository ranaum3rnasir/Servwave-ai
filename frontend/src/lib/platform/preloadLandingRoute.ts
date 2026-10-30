type ChunkLoader = () => Promise<unknown>;

/**
 * The landing pages worth fetching early, keyed by path. Each is the SAME dynamic import the route
 * table uses (`pages/v2/routes/<module>.routes.tsx`), so the bundler gives both one chunk and the
 * router finds it already downloaded.
 *
 * Only the scheduler is listed: it is the largest chunk on a first-run path (the scheduler and its board), and the
 * phone it runs on is the slowest line in the field. Everyone's home page is the dashboard, so the app root preloads
 * nothing.
 */
export const LANDING_CHUNKS: Record<string, ChunkLoader> = {
  '/schedule': () => import('@/pages/v2/schedule/SchedulePage'),
};

/**
 * Is there a stored sign-in on this device? The auth client keeps its session in local storage
 * under `sb-<project>-auth-token`. Someone without one is about to be sent to the sign-in page,
 * and should not spend a phone data plan on the scheduler first.
 */
export function hasStoredSession(storage: Pick<Storage, 'length' | 'key'> | undefined = safeLocalStorage()): boolean {
  try {
    if (!storage) return false;
    for (let i = 0; i < storage.length; i += 1) {
      const key = storage.key(i);
      if (key && /^sb-.+-auth-token$/.test(key)) return true;
    }
  } catch {
    // storage blocked: treat as signed out, the router fetches the chunk when it needs it
  }
  return false;
}

function safeLocalStorage(): Storage | undefined {
  try {
    return typeof localStorage === 'undefined' ? undefined : localStorage;
  } catch {
    return undefined;
  }
}

const normalise = (path: string) => (path.replace(/\/+$/, '') || '/').toLowerCase();

/**
 * Start downloading the page's chunk now, from the staff entry, instead of when the router first renders it (mobile
 * slice 61, PERF-03).
 *
 * On a cold start the router renders "Loading..." until the sign-in check answers, and only then
 * the page, whose chunk is requested at that moment. The download is therefore queued behind a
 * network round trip it does not depend on. Asked at entry, the two run side by side.
 *
 * Only the address bar decides: `/schedule` is preloaded as itself. The app root is the dashboard for everyone, which
 * is not worth a preload, so it (like any page without a listed chunk) preloads nothing.
 *
 * A failed preload is swallowed: nothing here depends on it, and the router's own import of the
 * same chunk then runs, fails the same way and goes through the stale-chunk recovery as before.
 */
export function preloadLandingRoute({
  pathname,
  signedIn,
  loaders = LANDING_CHUNKS,
}: {
  pathname: string;
  /** Whether this device holds a sign-in (see `hasStoredSession`); without one nothing is fetched. */
  signedIn: boolean;
  loaders?: Record<string, ChunkLoader>;
}): void {
  if (!signedIn) return;
  const load = loaders[normalise(pathname)];
  if (!load) return;
  void load().catch(() => {});
}
