/**
 * Module 1 - Dashboard. Legacy paths that have a v2 counterpart.
 *
 * The dashboard's legacy path is the app root, `/`, not `/dashboard` - see
 * `NAV_REGISTRY`, whose `dashboard` destination has `href: '/'`. So the single
 * entry here is `/`, and its v2 counterpart is `/v2/` (`v2Path('/')`).
 *
 * The route registry test already anticipates this: its trailing-slash rule is
 * written `p === '/' || !p.endsWith('/')`, i.e. `/` is the one registered path
 * allowed to end in a slash, and `matchesPattern('/', '/')` is asserted there
 * too. `V2AppLayout` reads the same way - it strips the `/v2` prefix and
 * comments that "`/v2` itself is the dashboard, whose href is `/`" - so the
 * travelling sidebar rail highlights Dashboard only when this route is active.
 *
 * React must never be imported here; see `leads.paths.ts` for why.
 */
export const DASHBOARD_V2_PATHS = [
  '/',
] as const;
