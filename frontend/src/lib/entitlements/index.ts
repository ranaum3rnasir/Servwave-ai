import { useAuthStore } from '@/stores/auth.store';

export * from './catalog';
export { useModuleAccess } from './useModuleAccess';

// Stable empty reference: returning a fresh [] from a zustand selector
// re-renders the component on every unrelated store write (zustand 5).
const EMPTY: string[] = [];

/**
 * Whether the org has a feature.
 *
 * FAILS OPEN when org_features is undefined. That state means "we don't know
 * yet", not "denied": the store hydrates synchronously from a localStorage
 * cache (auth.store.ts sets `isLoading: !cachedUser`), so on the first paint
 * after this ships, every already-logged-in user has a cached payload with no
 * org_features. Failing closed there would grey out every module and
 * <Navigate replace> anyone on a gated route to /upgrade — destroying their
 * back button — for a fully-paid SCALE org.
 *
 * This is cosmetic only. The real boundary is the backend 402, which fails
 * CLOSED. Worst case here is a module briefly appearing available and then
 * returning 402, which the interceptor turns into a clean upgrade page.
 */
export function useFeature(key: string): boolean {
  return useAuthStore((s) => {
    const features = s.user?.org_features;
    if (features === undefined) return true; // unknown ≠ denied
    return features.includes(key);
  });
}

/**
 * Predicate form of `useFeature` for callers that must test MANY keys in one
 * render (e.g. filtering a report catalog) - a hook cannot be called per row.
 * Same fail-open contract as `useFeature`: selects the RAW `org_features`
 * value, not `?? EMPTY` - that collapses "unknown" into "denied" and would
 * destroy fail-open (the EMPTY sentinel below is already a stable reference,
 * so this is not about re-render churn).
 */
export function useHasFeature(): (key: string) => boolean {
  const features = useAuthStore((s) => s.user?.org_features);
  return (key) => features === undefined || features.includes(key);
}

/** Resolved feature list, or EMPTY when unknown. Callers must treat [] as "unknown". */
export function useOrgFeatures(): string[] {
  return useAuthStore((s) => s.user?.org_features ?? EMPTY);
}

/** True once the entitlement payload has actually arrived. */
export function useEntitlementsReady(): boolean {
  return useAuthStore((s) => s.user?.org_features !== undefined);
}

export function useOrgPlan(): string {
  return useAuthStore((s) => s.user?.org_plan ?? 'STARTER');
}
