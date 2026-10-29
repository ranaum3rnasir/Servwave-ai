// Imported and re-exported rather than declared here, so the registry has one
// owner. This module is imported by every page in this layer, so it must stay
// free of React and of anything that reaches a page; `routes/paths.ts` globs
// only `.paths.ts` files for exactly that reason.
import { V2_ROUTES } from './routes/paths';

export { V2_ROUTES };

/**
 * The presentation layer's route registry.
 *
 * There is no longer a `/v2` prefix and no feature flag: these routes ARE the
 * app, mounted at the bare paths (`/leads`, `/jobs`, ...). The registry stays
 * because it is what proves each path is claimed exactly once - see
 * `__tests__/uiV2.test.ts` and `__tests__/routeUniqueness.test.ts`.
 *
 * Adding a module: create `routes/<module>.paths.ts` and
 * `routes/<module>.routes.tsx`. Both are auto-discovered, so no shared file -
 * including this one - is edited. See `routes/README.md`.
 */

/**
 * Does one route pattern match one pathname?
 *
 * Compares segment by segment so `:id`-style params match any single segment.
 * A pattern only matches a path with the same segment count, so `/jobs` never
 * swallows `/jobs/new`.
 *
 * Exported so tests can exercise the real matcher rather than a copy of its
 * rules.
 */
export function matchesPattern(pattern: string, pathname: string): boolean {
  const norm = (s: string) => s.replace(/\/+$/, '') || '/';
  // Both sides lowercased because React Router matches case-insensitively:
  // without it, /Jobs and /jobs would disagree about whether the path is
  // registered. Patterns are normalised too - a stray trailing slash on an
  // entry would otherwise make it unmatchable and the entry silently dead.
  const a = norm(pattern).toLowerCase().split('/');
  const b = norm(pathname).toLowerCase().split('/');
  // Equal segment counts, so '/jobs' can never swallow '/jobs/new'.
  if (a.length !== b.length) return false;
  return a.every((seg, i) => seg.startsWith(':') || seg === b[i]);
}

/** Is `pathname` a path this layer declares a route for? */
export function hasV2Page(pathname: string): boolean {
  return V2_ROUTES.some((pattern) => matchesPattern(pattern, pathname));
}

/**
 * NO-OP SHIMS, KEPT DELIBERATELY.
 *
 * Both functions used to rewrite a path into the parallel `/v2` URL space. That
 * space is gone - this layer owns the bare paths - so the correct return value
 * for both is now the path they were handed, unchanged.
 *
 * They are kept rather than inlined because there are 62 non-test files calling
 * them. Deleting them means editing every one of those files to unwrap an
 * argument, which is a very large diff for exactly zero behaviour change, and a
 * very large diff is where a real mistake hides. A caller reads the same either
 * way: `navigate(v2Path('/jobs/1'))` goes to `/jobs/1`.
 *
 * If they are ever removed, remove them mechanically and in a commit that does
 * nothing else.
 */
export function v2Path(pathname: string): string {
  return pathname;
}

/** See `v2Path` - a no-op shim, kept for its 62 call sites. */
export function preferV2Path(url: string): string {
  return url;
}
