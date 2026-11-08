import { QueryClient } from '@tanstack/react-query';

/**
 * The app's single QueryClient. It lives here rather than in App.tsx so non-React
 * modules (the auth store, the auth listener) can reach it - clearing the cache on
 * sign-out is not something a component can be trusted to do.
 */
export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: 1,
      staleTime: 5 * 60 * 1000,
      refetchOnWindowFocus: false,
    },
  },
});

/**
 * Drop every cached query. MUST run on sign-out.
 *
 * The client is module-scoped and login navigates client-side (no reload), so without
 * this the previous account's data survives into the next session: signing out of one
 * org and into another left the new session rendering the OLD org's records for as long
 * as they stayed cached (Settings > Payments showed a different org's methods and
 * deposit, and saving that stale form PATCHed it into the org the user had just signed
 * into). That is a cross-tenant leak, not just staleness, so it is cleared eagerly rather
 * than left to each query's staleTime.
 */
export function clearQueryCache(): void {
  queryClient.clear();
}
