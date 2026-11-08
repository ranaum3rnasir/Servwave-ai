/**
 * Module 2 - Leads. Legacy paths that have a v2 counterpart.
 *
 * Paths live in their own `.paths.ts` file, separate from the `.routes.tsx`
 * that declares the JSX, because `uiV2.ts` reads the collected paths and is
 * itself imported by every v2 page. If the collector pulled in the route files
 * it would pull in the pages, and the pages import `uiV2` - an import cycle.
 * Keeping the path list free of React keeps that cycle impossible.
 *
 * These are LEGACY paths, without the `/v2` prefix. `v2Path` adds it.
 */
export const LEADS_V2_PATHS = [
  '/leads',
  '/leads/new',
  '/leads/:id/edit',
  '/leads/:id',
] as const;
