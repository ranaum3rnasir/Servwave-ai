/**
 * Which vendor packages the build pins into a fixed chunk (vite.config.ts `manualChunks`).
 * Everything not named here is left to the bundler, which puts a module in the chunk that serves
 * the entries that use it (mobile slice 47; budgets are enforced by
 * scripts/check-public-bundle-budget.mjs).
 *
 * The function form, with a few groups. The object form it replaced pinned radix, query and a
 * "utils" group (axios, date-fns, lucide-react, zustand) into fixed chunks, and with it every
 * module those packages share with anything else (react's jsx runtime, tslib) went into the fixed
 * chunk too. A fixed chunk is downloaded whole, so the public estimate page paid for every icon
 * and package the staff app uses, plus the identity SDK's chunk that tslib dragged in behind them.
 *
 * Chunk names reach the served head as modulepreload URLs, so none may name a vendor (slice 06).
 */
export function vendorChunk(id: string): string | undefined {
  if (!id.includes('/node_modules/')) return undefined;
  if (/\/node_modules\/(react|react-dom|react-router|react-router-dom|scheduler|tslib)\//.test(id)) {
    return 'vendor-react';
  }
  // The query client rides in the staff first download; the table and virtual-list engines (about
  // 138 KB of source) are only used by lazy pages, so each gets its own chunk. One group for all of
  // @tanstack put them in the first download for nothing (mobile slice 61, PERF-01).
  if (/\/node_modules\/@tanstack\/(react-table|table-core)\//.test(id)) return 'vendor-table';
  if (/\/node_modules\/@tanstack\/(react-virtual|virtual-core)\//.test(id)) return 'vendor-virtual';
  if (id.includes('/node_modules/@tanstack/')) return 'vendor-query';
  if (id.includes('/node_modules/@supabase/') || id.includes('/node_modules/iceberg-js/')) {
    return 'vendor-auth';
  }
  return undefined;
}
