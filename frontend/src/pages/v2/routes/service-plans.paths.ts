/**
 * Module 15 - Service Plans. Legacy paths that have a v2 counterpart.
 *
 * Paths live in their own `.paths.ts` file, separate from the `.routes.tsx`
 * that declares the JSX, because `uiV2.ts` reads the collected paths and is
 * itself imported by every v2 page. If the collector pulled in the route files
 * it would pull in the pages, and the pages import `uiV2` - an import cycle.
 *
 * These are LEGACY paths, without the `/v2` prefix. `v2Path` adds it.
 *
 * One entry only: the module is a single route with no children, no params and
 * no query params. The plan detail is a sheet driven by page state, not a URL.
 */
export const SERVICE_PLANS_V2_PATHS = [
  '/service-plans',
] as const;
