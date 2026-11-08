/**
 * Module 3 - Customers. Legacy paths that have a v2 counterpart.
 *
 * Paths live in their own `.paths.ts` file, separate from the `.routes.tsx`
 * that declares the JSX, because `uiV2.ts` reads the collected paths and is
 * itself imported by every v2 page. If the collector pulled in the route files
 * it would pull in the pages, and the pages import `uiV2` - an import cycle.
 *
 * These are LEGACY paths, without the `/v2` prefix. `v2Path` adds it.
 *
 * `/customers/:customerId/statement` is registered here even though the same
 * page is also mounted at `/jobs/:jobId/statement` by the Jobs module: this
 * list is per-PATH, and each module registers the paths it owns. The page file
 * itself is shared - see `pages/v2/customers/StatementPage.tsx`.
 */
export const CUSTOMERS_V2_PATHS = [
  '/customers',
  '/customers/new',
  '/customers/:id/edit',
  '/customers/:id',
  '/customers/:customerId/statement',
] as const;
