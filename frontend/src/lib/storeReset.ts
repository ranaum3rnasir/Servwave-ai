/**
 * Account-scoped store reset, run on logout.
 *
 * `clearQueryCache()` drops the TanStack Query cache, but a Zustand store is a plain module
 * singleton: it is created once per page load and survives a logout entirely. Signing back in
 * is a CLIENT-SIDE navigation - nothing remounts the module - so whatever the previous account
 * fetched is still sitting there for the next one.
 *
 * That is not merely stale, it is a cross-account leak. `tasksStore` hydrates once and then
 * short-circuits (`if (get().loading || get().loaded) return`), so after an admin had loaded the
 * board, a technician signing in on the same tab kept the admin's org-wide task list and never
 * re-fetched it - the API had answered correctly with only their own row.
 *
 * A registry rather than a direct import so the next store to cache account data cannot be
 * forgotten: it registers itself and logout picks it up. Only modules that have actually been
 * imported register, which is exactly right - a store nobody loaded holds nothing to leak.
 */
type ResetFn = () => void;

const resetters = new Set<ResetFn>();

/** Call at module scope, next to the store's `create()`. */
export function registerStoreReset(fn: ResetFn): void {
  resetters.add(fn);
}

/** Drop every registered store back to its signed-out state. Never throws. */
export function resetAccountScopedStores(): void {
  for (const reset of resetters) {
    try {
      reset();
    } catch {
      // One bad store must not strand the rest of the logout.
    }
  }
}
