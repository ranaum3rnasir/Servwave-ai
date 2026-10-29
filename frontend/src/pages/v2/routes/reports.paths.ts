/**
 * Module 9 - Reports. Legacy paths that have a v2 counterpart.
 *
 * Three, exactly the three `App.tsx` declares: the landing grid, the
 * `:slug` dispatcher that fans out to roughly twenty report pages, and the
 * demo-only Marketing analytics page. Marketing lives in this module rather
 * than one of its own because it sits in the reports catalog
 * (`report-catalog.ts`, slug `marketing`) and shares the same chart chrome.
 *
 * React must never be imported here; see `leads.paths.ts` for why.
 */
export const REPORTS_V2_PATHS = [
  '/reports',
  '/reports/:slug',
  '/marketing',
] as const;
