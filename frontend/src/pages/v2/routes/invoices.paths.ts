/**
 * Module 6 - Invoices. Legacy paths that have a v2 counterpart.
 *
 * Paths live in their own `.paths.ts` file, separate from the `.routes.tsx`
 * that declares the JSX, because `uiV2.ts` reads the collected paths and is
 * itself imported by every v2 page. If the collector pulled in the route files
 * it would pull in the pages, and the pages import `uiV2` - an import cycle.
 *
 * These are LEGACY paths, without the `/v2` prefix. `v2Path` adds it.
 * `/invoices/new` is listed - and declared - before `/invoices/:id` for the
 * same reason it is in App.tsx: otherwise `new` is captured as an id.
 */
export const INVOICES_V2_PATHS = [
  '/invoices',
  '/invoices/new',
  '/invoices/:id',
] as const;
