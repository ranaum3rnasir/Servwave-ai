/**
 * Module 14 - Automations. Legacy paths that have a v2 counterpart.
 *
 * Paths live in their own `.paths.ts` file, separate from the `.routes.tsx`
 * that declares the JSX, because `uiV2.ts` reads the collected paths and is
 * itself imported by every v2 page. If the collector pulled in the route files
 * it would pull in the pages, and the pages import `uiV2` - an import cycle.
 * Keeping the path list free of React keeps that cycle impossible.
 *
 * These are LEGACY paths, without the `/v2` prefix. `v2Path` adds it.
 *
 * `/automations/:id/edit` is listed: it is a real declared route in App.tsx (a
 * redirect for old deep links to the retired single-action editor), so it needs
 * a v2 counterpart or a bookmark pointing at it would land back in the legacy
 * layer while every sibling path redirected.
 */
export const AUTOMATIONS_V2_PATHS = [
  '/automations',
  '/automations/new',
  '/automations/:id',
  '/automations/:id/edit',
] as const;
