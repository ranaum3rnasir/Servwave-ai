import { readdirSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { V2_ROUTES, hasV2Page, matchesPattern, preferV2Path, v2Path } from '../uiV2';

import { allRoutes } from './routeTable';

const V2_DIR = join(__dirname, '..');
const ROUTES_DIR = join(V2_DIR, 'routes');

/**
 * Every path the route files actually declare.
 *
 * This used to be a regex over `path="/v2/…"` literals in the raw source. Both
 * halves of that stopped working when the routes took the bare paths: the
 * prefix it keyed on is gone, and a bare `path="/…"` regex over raw text would
 * also match route JSX quoted inside a docstring, inventing routes that do not
 * exist. `routeTable.parseRoutes` strips comments and resolves nesting, so it is
 * used here too rather than a second, weaker reader.
 */
function declaredRoutePaths(): string[] {
  return allRoutes().map((route) => route.path);
}

describe('module registration', () => {
  /**
   * The two halves of a module's registration are separate files, and only one
   * of them is React-free (see leads.paths.ts). A module that ships routes but
   * no paths renders fine while `hasV2Page` denies the path exists; one that
   * ships paths but no routes registers a page the router cannot serve. Neither
   * is visible from reading either file alone.
   */
  it('every module file has its counterpart', () => {
    const names = readdirSync(ROUTES_DIR);
    const withPaths = names.filter((n) => n.endsWith('.paths.ts')).map((n) => n.replace('.paths.ts', ''));
    const withRoutes = names.filter((n) => n.endsWith('.routes.tsx')).map((n) => n.replace('.routes.tsx', ''));

    expect(withPaths.filter((m) => !withRoutes.includes(m)), 'modules with .paths.ts but no .routes.tsx').toEqual([]);
    expect(withRoutes.filter((m) => !withPaths.includes(m)), 'modules with .routes.tsx but no .paths.ts').toEqual([]);
  });

  it('discovers at least one module, so the glob is not silently matching nothing', () => {
    // A glob pattern that matches no file fails open: V2_ROUTES becomes empty
    // and every hasV2Page returns false, with no error anywhere. This is the
    // canary for that.
    expect(V2_ROUTES.length).toBeGreaterThan(0);
  });
});

describe('V2_ROUTES registry', () => {
  /**
   * The registry and the route blocks are two lists derived from two sets of
   * files, and only a test makes them agree. A registered path with no <Route>
   * is a path `hasV2Page` claims exists while the router falls through it to
   * `path="*"` and bounces the user to "/".
   *
   * `routeUniqueness.test.ts` owns the reverse direction and the duplicate
   * check; this is the registry's own half.
   */
  it('every registered path has a matching route', () => {
    const declared = declaredRoutePaths();
    const missing = V2_ROUTES.filter((p) => !declared.includes(p));
    expect(missing, `V2_ROUTES entries with no <Route> in the route tree: ${missing.join(', ')}`)
      .toEqual([]);
  });

  it('registered paths are absolute, slash-prefixed and free of trailing slashes', () => {
    for (const p of V2_ROUTES) {
      expect(p.startsWith('/'), `"${p}" must start with /`).toBe(true);
      expect(p === '/' || !p.endsWith('/'), `"${p}" must not end with /`).toBe(true);
      expect(p.startsWith('/v2'), `"${p}" carries the retired /v2 prefix`).toBe(false);
    }
  });

  it('registers each path once, so two modules cannot claim the same route', () => {
    // Auto-discovery makes this possible in a way the old hand-written array
    // did not: two module files can each claim '/customers' and both merge
    // cleanly, because they never touch the same file.
    const duplicates = V2_ROUTES.filter((p, i) => V2_ROUTES.indexOf(p) !== i);
    expect([...new Set(duplicates)], 'paths registered by more than one module').toEqual([]);
  });
});

/**
 * `isUiV2Enabled` and its describe block were deleted here.
 *
 * The function read `VITE_UI_V2` and decided whether the new design was served
 * at all. There is nothing left for it to decide: the design owns the bare paths
 * and the legacy routes are gone, so no value of any variable can bring them
 * back and a flag that cannot change an outcome is worse than no flag - it reads
 * as a rollback that exists. Rolling back now means reverting the commit.
 */

describe('hasV2Page', () => {
  it('returns false for a path no module has registered', () => {
    // Durable rather than a phase freeze: asserting V2_ROUTES is empty would
    // start failing on the first module branch, which is not a regression.
    expect(hasV2Page('/__not-a-registered-route__')).toBe(false);
  });

  it('agrees with the registry - every registered pattern matches a concrete path', () => {
    for (const pattern of V2_ROUTES) {
      // Substitute a value for each :param to build a matching URL.
      const concrete = pattern.replace(/:[^/]+/g, 'sample');
      expect(hasV2Page(concrete), `hasV2Page("${concrete}") should match "${pattern}"`).toBe(true);
    }
  });

  it('matches segment-wise, so a shorter pattern cannot swallow a longer path', () => {
    // Exercises the REAL matcher. An earlier version of this test reimplemented
    // the matching rules inline, which meant deleting them from uiV2.ts left it
    // green - it was asserting against a copy of the code.
    expect(matchesPattern('/jobs', '/jobs')).toBe(true);
    expect(matchesPattern('/jobs', '/jobs/new')).toBe(false);
    expect(matchesPattern('/jobs/:id', '/jobs/123')).toBe(true);
    expect(matchesPattern('/jobs/:id', '/jobs')).toBe(false);
    expect(matchesPattern('/jobs/:id', '/leads/123')).toBe(false);
    expect(matchesPattern('/jobs/', '/jobs')).toBe(true); // trailing slash normalised
    expect(matchesPattern('/jobs', '/Jobs')).toBe(true); // router is case-insensitive
    expect(matchesPattern('/JOBS', '/jobs')).toBe(true); // ...in both directions
    expect(matchesPattern('/', '/')).toBe(true);
  });

});

/**
 * `v2Path` and `preferV2Path` are NO-OP SHIMS now, and these are the tests that
 * hold them to it.
 *
 * They used to rewrite a path into the parallel `/v2` URL space; that space is
 * gone, so returning the argument unchanged is the whole of their correct
 * behaviour. They are kept because 62 non-test files call them, and unwrapping
 * every one of those call sites is a very large diff for zero behaviour change.
 *
 * The cases below are the ones the old implementation got WRONG at least once,
 * kept deliberately rather than collapsed into a single identity assertion: a
 * query string must survive (the sidebar's `/estimates?action=new-estimate`
 * handshake broke when it did not), a fragment must survive, and an unregistered
 * path must come back untouched instead of being rewritten or dropped. If either
 * function ever grows logic again, these are the shapes it has to handle.
 */
describe('the v2Path / preferV2Path shims', () => {
  it('returns a bare path unchanged', () => {
    expect(v2Path('/estimates')).toBe('/estimates');
    expect(preferV2Path('/estimates')).toBe('/estimates');
    expect(v2Path('/')).toBe('/');
  });

  it('preserves a query string or a hash', () => {
    expect(preferV2Path('/estimates?action=new-estimate')).toBe('/estimates?action=new-estimate');
    expect(preferV2Path('/tasks?action=new-task')).toBe('/tasks?action=new-task');
    expect(preferV2Path('/leads/123#notes')).toBe('/leads/123#notes');
    expect(preferV2Path('/estimates?a=1#frag')).toBe('/estimates?a=1#frag');
  });

  it('leaves an unregistered path alone, query and all', () => {
    expect(preferV2Path('/nope?action=x')).toBe('/nope?action=x');
    expect(preferV2Path('/nope')).toBe('/nope');
  });

  it('never emits a /v2 URL', () => {
    for (const input of ['/leads', '/leads/1', '/estimates?a=1', '/', '/nope']) {
      expect(v2Path(input)).not.toMatch(/^\/v2\b/);
      expect(preferV2Path(input)).not.toMatch(/^\/v2\b/);
    }
  });
});
