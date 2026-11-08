/**
 * Module 10 - Inventory. Legacy paths that have a v2 counterpart.
 *
 * Paths live in their own `.paths.ts` file, separate from the `.routes.tsx`
 * that declares the JSX, because `uiV2.ts` reads the collected paths and is
 * itself imported by every v2 page. If the collector pulled in the route files
 * it would pull in the pages, and the pages import `uiV2` - an import cycle.
 *
 * These are LEGACY paths, without the `/v2` prefix. `v2Path` adds it.
 *
 * TEN, not the six the behaviour map records and not the nine the task brief
 * lists. `App.tsx` mounts `/inventory/assets`, `/inventory/low-stock`,
 * `/inventory/activity` and `/inventory/logistic-orders` on `InventoryPage`
 * (all four postdate the map), `/inventory/approvals` is now a redirect rather
 * than a view, and `/inventory/vendors` - a real page - is missing from the
 * brief's list entirely. Every one of them is here because every one of them
 * is in `App.tsx`.
 */
export const INVENTORY_V2_PATHS = [
  '/inventory',
  '/inventory/staging',
  '/inventory/assets',
  '/inventory/low-stock',
  '/inventory/activity',
  '/inventory/logistic-orders',
  '/inventory/approvals',
  '/inventory/price-book',
  '/inventory/purchase-orders',
  '/inventory/vendors',
] as const;
