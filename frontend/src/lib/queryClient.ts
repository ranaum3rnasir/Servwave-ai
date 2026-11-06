import { QueryClient } from '@tanstack/react-query';

/**
 * The HTTP status the app's API errors carry. Every request goes through the axios instance in
 * `lib/axios.ts`, so a failed one is an AxiosError: the status is `error.response.status`. A network
 * error (no response) or a thrown non-HTTP error has none.
 */
function httpStatusOf(error: unknown): number | undefined {
  return (error as { response?: { status?: unknown } } | null)?.response?.status as number | undefined;
}

/**
 * True for a 4xx the server answered with a "no" that asking again only repeats (a 429 deepens the lockout).
 * A 401 is the exception: it is the session-refresh path. The axios interceptor (`lib/axios.ts`) refreshes the
 * session and resends only the first read that got a 401; any other read that 401s during the refresh is
 * rejected, and React Query's one retry is what resends it with the new token. A 401 keeps that retry.
 */
export function isClientErrorStatus(error: unknown): boolean {
  const status = httpStatusOf(error);
  return typeof status === 'number' && status >= 400 && status < 500 && status !== 401;
}

/**
 * Builds React Query's `retry` function: never after a 4xx other than 401 (429 included), otherwise up to `maxRetries`
 * retries, which is what the client allowed before this rule. Network errors and 5xx keep that count.
 */
export function retryUnlessClientError(maxRetries: number) {
  return (failureCount: number, error: unknown): boolean =>
    !isClientErrorStatus(error) && failureCount < maxRetries;
}

/**
 * The app's single QueryClient. It lives here rather than in App.tsx so non-React
 * modules (the auth store, the auth listener) can reach it - clearing the cache on
 * sign-out is not something a component can be trusted to do.
 */
export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: retryUnlessClientError(1),
      staleTime: 5 * 60 * 1000,
      refetchOnWindowFocus: false,
    },
    // React Query's own mutation default is 0 retries; the rule keeps that and spells it out.
    mutations: {
      retry: retryUnlessClientError(0),
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
