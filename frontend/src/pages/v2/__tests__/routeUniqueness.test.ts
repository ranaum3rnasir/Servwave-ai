import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { V2_ROUTES } from '../uiV2';

import { allRoutes, overlaps, parseRoutes, routeSourceFiles } from './routeTable';

/**
 * NO PATH IS DECLARED TWICE.
 *
 * This is the failure mode the migration to bare paths risks most, and the only
 * one with no visible symptom short of a user landing on the wrong page.
 *
 * While the new design lived under `/v2`, the two layers could not collide: one
 * route table held `/leads`, the other held `/v2/leads`. Dropping the prefix put
 * both at `/leads`, and React Router does not complain about that - it ranks the
 * candidates and silently serves whichever scores higher. Two <Route>s for one
 * path therefore means the page a user sees is decided by a scoring detail that
 * nobody wrote down, that no type checks, and that can invert when either
 * pattern is edited. `V2FlagRedirect`, deleted in the same change, existed
 * precisely to avoid duplicate paths; its docstring said so. This file is that
 * reasoning, mechanised, now that the redirect is gone.
 *
 * It reads App.tsx as well as every module route file, because the collision to
 * catch is a legacy `<Route>` reappearing in App.tsx beside the module route
 * that replaced it - which is exactly what removing 71 of them by hand could
 * have got wrong, and exactly what a later "restore the old page for a moment"
 * would do.
 */

const routes = allRoutes();

describe('route table uniqueness', () => {
  it('parses more than one file, so the check spans the whole table', () => {
    // The canary. If the file list or the parser silently produced one file's
    // worth of routes - or none - every assertion below would pass while looking
    // at a fraction of the table.
    expect(routeSourceFiles().length, 'route source files').toBeGreaterThan(15);
    expect(routes.length, 'routes parsed').toBeGreaterThan(60);
  });

  it('declares every path exactly once, across App.tsx and every module', () => {
    const seen = new Map<string, string[]>();
    for (const route of routes) {
      const files = seen.get(route.path) ?? [];
      files.push(route.file);
      seen.set(route.path, files);
    }

    const duplicates = [...seen.entries()]
      .filter(([, files]) => files.length > 1)
      .map(([path, files]) => `${path} declared ${files.length} times: ${files.join(', ')}`);

    expect(
      duplicates,
      'paths declared by more than one <Route>. React Router would pick a winner '
      + 'by ranking, so one of the two pages becomes unreachable at random',
    ).toEqual([]);
  });

  /**
   * A weaker collision than an identical path, and a real one: two DIFFERENT
   * patterns that some single URL matches. `/jobs/:id` and `/jobs/:slug` are not
   * equal strings, so the check above passes them, yet `/jobs/7` matches both.
   *
   * Overlaps that are legitimate are the literal-versus-param pairs the app
   * relies on - `/jobs/new` against `/jobs/:id` - so those are allowed, and
   * `guardStacks.test.ts` separately requires the literal to be declared first.
   * What is NOT allowed is two patterns that overlap and are BOTH parameterised
   * in the overlapping segment, because then no declaration order helps: one is
   * simply dead.
   */
  it('has no two parameterised patterns that overlap', () => {
    const ambiguous: string[] = [];

    for (let a = 0; a < routes.length; a++) {
      for (let b = a + 1; b < routes.length; b++) {
        const first = routes[a]!;
        const second = routes[b]!;
        if (first.path === second.path) continue; // covered above
        if (!overlaps(first.path, second.path)) continue;

        const left = first.path.split('/');
        const right = second.path.split('/');
        // Overlapping and every differing segment is a param on BOTH sides.
        const allParams = left.every(
          (segment, k) => segment === right[k] || (segment.startsWith(':') && right[k]!.startsWith(':')),
        );
        if (allParams) {
          ambiguous.push(`${first.path} (${first.file}) and ${second.path} (${second.file})`);
        }
      }
    }

    expect(ambiguous, 'pattern pairs where one is unreachable whatever the order').toEqual([]);
  });

  it('routes the catch-all exactly once, and only in App.tsx', () => {
    // The parser drops `path="*"` on purpose, so count it from the sources. Two
    // catch-alls would mean the second is dead; a catch-all inside a module
    // block would swallow that module's siblings.
    const withCatchAll = routeSourceFiles().filter((file) =>
      /<Route\s+path="\*"/.test(readFileSync(file, 'utf8')),
    );

    expect(withCatchAll.map((f) => f.split(/[\\/]/).pop())).toEqual(['App.tsx']);
  });
});

describe('the path registry agrees with the route table', () => {
  /**
   * `V2_ROUTES` is assembled from the `*.paths.ts` files, the route table from
   * the `*.routes.tsx` files. They are two lists derived from two sets of files
   * and nothing but a test makes them agree. A registered path with no route is
   * a page the sidebar and `hasV2Page` believe in and the router does not.
   */
  it('registers no path that the route table does not declare', () => {
    const declared = new Set(routes.map((r) => r.path));
    const missing = V2_ROUTES.filter((p) => !declared.has(p));

    expect(missing, 'registered paths with no <Route> anywhere').toEqual([]);
  });

  it('registers each path once, so two modules cannot claim the same route', () => {
    // Auto-discovery makes this possible in a way a hand-written array did not:
    // two module files can each claim '/customers' and both merge cleanly,
    // because they never touch the same file.
    const duplicates = V2_ROUTES.filter((p, i) => V2_ROUTES.indexOf(p) !== i);
    expect([...new Set(duplicates)], 'paths registered by more than one module').toEqual([]);
  });

  it('the parser and the registry describe the same shape of table', () => {
    // Guards the two lists against drifting apart in SIZE, which is how a
    // registry stops being a useful cross-check: the route table may hold a few
    // paths the registry does not (the two that never had a legacy counterpart,
    // `/auth/callback`, which is deliberately unregistered), but not many.
    const unregistered = routes.filter((r) => !V2_ROUTES.includes(r.path)).map((r) => r.path).sort();
    expect(unregistered).toEqual(['/_kit-reference', '/auth/callback', '/not-authorized']);
  });
});

describe('no /v2 URL survives anywhere in the route table', () => {
  it('declares no path under /v2', () => {
    const prefixed = routes.filter((r) => r.path === '/v2' || r.path.startsWith('/v2/'));
    expect(prefixed.map((r) => `${r.path} (${r.file})`), 'routes still under the retired /v2 prefix').toEqual([]);
  });

  it('registers no path under /v2', () => {
    expect(V2_ROUTES.filter((p) => p === '/v2' || p.startsWith('/v2/'))).toEqual([]);
  });

  it('has a synthetic collision fail the uniqueness check, so it is not vacuous', () => {
    // The uniqueness assertions above pass on a table that is already correct,
    // which cannot distinguish a working check from a broken one. This feeds the
    // parser a table with a real duplicate and proves the detection fires.
    const parsed = parseRoutes(
      '<Route path="/leads" element={<A />} /><Route path="/leads" element={<B />} />',
      0,
      'synthetic',
    );
    const paths = parsed.map((r) => r.path);
    expect(paths).toEqual(['/leads', '/leads']);
    expect(paths.filter((p, i) => paths.indexOf(p) !== i)).toEqual(['/leads']);
  });
});
