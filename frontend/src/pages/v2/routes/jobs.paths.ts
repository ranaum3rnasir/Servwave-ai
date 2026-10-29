/**
 * Module 5 - Jobs. Legacy paths that have a v2 counterpart.
 *
 * Paths live in their own `.paths.ts` file, separate from the `.routes.tsx`
 * that declares the JSX, because `uiV2.ts` reads the collected paths and is
 * itself imported by every v2 page. If the collector pulled in the route files
 * it would pull in the pages, and the pages import `uiV2` - an import cycle.
 *
 * These are LEGACY paths, without the `/v2` prefix. `v2Path` adds it.
 * `/jobs/new` is listed - and declared - before `/jobs/:id` for the same reason
 * it is in App.tsx: otherwise `new` is captured as an id.
 *
 * `/jobs/:jobId/statement` is a distinct four-segment pattern, so it can never
 * be confused with `/jobs/:id`; it is served by the SAME component the
 * Customers module registered for `/customers/:customerId/statement`, exactly
 * as App.tsx mounts one `StatementPage` on both routes.
 */
export const JOBS_V2_PATHS = [
  '/jobs',
  '/jobs/new',
  '/jobs/:id',
  '/jobs/:jobId/statement',
] as const;
