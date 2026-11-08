/**
 * Module 13 - Auth & Public. Legacy paths that have a v2 counterpart.
 *
 * Paths live in their own `.paths.ts` file, separate from the `.routes.tsx`
 * that declares the JSX, because `uiV2.ts` reads the collected paths and is
 * itself imported by every v2 page. If the collector pulled in the route files
 * it would pull in the pages, and the pages import `uiV2` - an import cycle.
 *
 * These are LEGACY paths, without the `/v2` prefix. `v2Path` adds it.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * `/auth/callback` IS DELIBERATELY ABSENT, and this is the one entry to read
 * carefully before "completing" the list.
 *
 * `auth-public.routes.tsx` DOES declare `/auth/callback` - the OAuth return has
 * to resolve to a page - but the path is left out of this registry, and the
 * omission is now cosmetic rather than load-bearing. It mattered while a
 * redirect consulted the registry: `lib/auth-listener.ts` compares the current
 * pathname against its `OAUTH_CALLBACK_PATHS` list with `===` and SKIPS its
 * INITIAL_SESSION and SIGNED_IN handling on a match, so the global listener
 * cannot call `checkAuth()` in parallel with AuthCallbackPage's
 * `finalizeOAuthLogin()`. Registering the path used to make the flag redirect
 * hop the live OAuth return to a `/v2`-prefixed pathname that the `===` no
 * longer matched, and a `checkAuth()` racing the finalize signs the user
 * straight back out - `/api/auth/me` 401s for a Google identity that has not
 * been finalized yet. That was Google sign-in broken, from a registration line.
 *
 * With the prefix and the redirect both gone, the callback resolves at
 * `/auth/callback`, which is the first entry in that list, so the skip holds.
 * The entry stays out of the registry because nothing needs it in: the registry
 * feeds `hasV2Page`, and no caller asks that question about the OAuth return.
 * `routeUniqueness.test.ts` names this path explicitly as one of the three
 * routed-but-unregistered paths, so the gap is asserted rather than assumed.
 *
 * `NotAuthorizedPage` is absent for a different reason: it has no route of its
 * own in the original tree at all - `ProtectedRoute` renders it in place of
 * `<Outlet/>`. See `auth-public.routes.tsx`.
 */
export const AUTH_PUBLIC_V2_PATHS = [
  '/login',
  '/accept-invite',
  '/p/estimates/:id',
  '/p/invoices/:id',
  '/upgrade',
] as const;
