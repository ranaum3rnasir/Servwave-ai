import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';
import { matchRoutes, type RouteObject } from 'react-router-dom';

import { V2_ROUTES, hasV2Page } from '../../uiV2';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROUTES_DIR = join(HERE, '..', '..', 'routes');

/**
 * The dashboard is the ONE module whose path is `/`, and that makes its
 * registration the one that cannot be eyeballed.
 *
 * `/` is the app root, so this route is what a user gets on opening the product
 * and what every "home" affordance points at - the shell's brand mark, the
 * breadcrumb trail's first crumb, the Close button in Settings. If it stops
 * resolving here, the whole app lands on `path="*"` and bounces back to `/`,
 * which is a redirect loop rather than a page.
 *
 * WHAT THIS FILE USED TO CHECK: while the design lived under `/v2`, this
 * module's route was declared `path="/v2/"` with a trailing slash, and it
 * OVERLAPPED a `<Route path="/v2" element={<Navigate to="/v2/leads" />} />`
 * placeholder in `V2Routes.tsx`. Which of the two won was decided by React
 * Router's ranking rather than by anything anyone wrote, so the tiebreak was
 * pinned here. Both the prefix and that placeholder are gone: the route is now
 * plain `path="/"`, declared once, and `routeUniqueness.test.ts` fails the build
 * if anything else ever claims the root again. The ranking assertion is kept in
 * a narrowed form below, because `/` is still the pattern most easily swallowed
 * by a sibling and it is still the router, not this repo, that decides.
 */
describe('dashboard route registration', () => {
  it('registers the app root', () => {
    expect(V2_ROUTES).toContain('/');
    expect(hasV2Page('/')).toBe(true);
  });

  it('declares the root literal, and no trailing-slash variant of it', () => {
    const src = readFileSync(join(ROUTES_DIR, 'dashboard.routes.tsx'), 'utf8');
    expect(src).toContain('path="/"');
    // `path="/v2/"` was the old literal. A stray one would now be a dead route.
    expect(src).not.toContain('path="/v2');
  });

  it('resolves "/" to this module rather than to a sibling pattern', () => {
    // Same shape as the real tree: the module's route sits under two pathless
    // guard routes (ProtectedRoute, then V2AppLayout), with other modules'
    // top-level patterns as siblings.
    const routes: RouteObject[] = [
      { path: '/leads' },
      { path: '*' },
      { children: [{ children: [{ path: '/' }] }] },
    ];

    expect(matchRoutes(routes, '/')?.at(-1)?.route.path).toBe('/');
  });

  it('does not let the root swallow the paths beneath it', () => {
    // Guards the assertion above against over-reach: `/` answers only `/`.
    const routes: RouteObject[] = [
      { path: '/leads' },
      { children: [{ path: '/' }] },
    ];
    expect(matchRoutes(routes, '/leads')?.at(-1)?.route.path).toBe('/leads');
  });
});
