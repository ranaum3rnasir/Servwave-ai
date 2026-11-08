import { describe, expect, it } from 'vitest';

import { allRoutes, overlaps, paramCount, parseRoutes } from './routeTable';

/**
 * Every route carries the guard stack it is supposed to carry.
 *
 * WHO MAY OPEN A PAGE is the one property of this migration that nothing else
 * checks and that fails silently when it breaks. Drop a `RequireFeature` and an
 * org that does not own the module reaches the page; widen an `allowedRoles` and
 * a technician reaches the standalone invoice form; lose `fallback` and a SALES
 * user is bounced to "/" instead of getting the in-place "no access" screen. In
 * every one of those the page still renders, so nothing looks broken from the
 * branch that did it.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THIS FILE USED TO ASSERT SOMETHING ELSE, AND WHY IT NO LONGER CAN.
 *
 * It was `guardParity.test.ts`, and its premise was that every `/v2/x` route had
 * a legacy twin at `x` in App.tsx and had to carry that twin's stack, guard for
 * guard. That premise is gone: these routes now own the bare paths, and App.tsx
 * declares no page route at all, so there is no second table left to diff
 * against. The check could not be kept - but it must not be dropped either,
 * because the property it protected is unchanged, and it is the property a
 * restyle is most likely to break by accident.
 *
 * So the twin table was replaced by the PIN below, seeded from that very table.
 * At the commit that un-prefixed the routes, the old assertion was re-run once
 * against `App.tsx@b1b7223cb` - the last revision that still held the legacy
 * route table - across all 73 routes. It reported 71 legacy routes, ZERO guard
 * mismatches, and ZERO legacy paths that stopped being routed; the only two
 * routes without a twin were the two that never had one (`/_kit-reference` and
 * `/not-authorized`). Every line of the pin is therefore the guard stack the
 * legacy route table carried, mechanically transcribed rather than retyped.
 *
 * WHEN THIS FILE FAILS, THE FIX IS ALMOST NEVER TO EDIT THE PIN. A changed stack
 * means the change either altered who can reach a page - in which case that is
 * the thing to review, and the pin moves in the same commit, deliberately - or
 * it did not, in which case the route file is wrong. Regenerating the pin to
 * match whatever the routes now say turns this file into a mirror, and a mirror
 * catches nothing.
 */

/**
 * Path -> the guards wrapping it, outermost first.
 *
 * `ProtectedRoute(roles=…, fallback=…)` normalises the two axes that decide
 * access; layouts are excluded, since chrome is not a permission. See
 * `routeTable.ts`.
 *
 * The outer `ProtectedRoute(roles=ADMIN|DISPATCHER|SALES|TECHNICIAN)` on most
 * entries rejects nobody on its own - its list is every role there is - but it
 * is the app-wide authenticated gate, and its ABSENCE would mean an unauthed
 * user reaching the page, so it is part of the stack.
 */
const ROUTE_GUARDS: Record<string, string[]> = {
  // Public: no guard and no shell. Two of these are the only pages in this
  // product a customer ever sees.
  '/login': [],
  '/auth/callback': [],
  '/accept-invite': [],
  '/p/estimates/:id': [],
  '/p/invoices/:id': [],

  // Authenticated, but with NO role list, deliberately. The 402 interceptor is
  // global, so a TECHNICIAN who trips one must be able to land on /upgrade
  // rather than be bounced by a role list; /phone gates on the role-agnostic
  // `create Communication` grant instead; /not-authorized is the 403 screen
  // itself; /_kit-reference is unreleased UI holding no real data.
  '/upgrade': ['ProtectedRoute(roles=ANY, fallback=false)'],
  '/not-authorized': ['ProtectedRoute(roles=ANY, fallback=false)'],
  '/_kit-reference': ['ProtectedRoute(roles=ANY, fallback=false)'],
  '/phone': ['ProtectedRoute(roles=ANY, fallback=false)', 'RequireCommunicationCreate'],

  // The app root, and the plain authenticated pages.
  '/': ['ProtectedRoute(roles=ADMIN|DISPATCHER|SALES|TECHNICIAN, fallback=false)'],
  '/customers': ['ProtectedRoute(roles=ADMIN|DISPATCHER|SALES|TECHNICIAN, fallback=false)'],
  '/customers/new': ['ProtectedRoute(roles=ADMIN|DISPATCHER|SALES|TECHNICIAN, fallback=false)'],
  '/customers/:id/edit': ['ProtectedRoute(roles=ADMIN|DISPATCHER|SALES|TECHNICIAN, fallback=false)'],
  '/customers/:id': ['ProtectedRoute(roles=ADMIN|DISPATCHER|SALES|TECHNICIAN, fallback=false)'],
  '/customers/:customerId/statement': ['ProtectedRoute(roles=ADMIN|DISPATCHER|SALES|TECHNICIAN, fallback=false)'],
  '/estimates': ['ProtectedRoute(roles=ADMIN|DISPATCHER|SALES|TECHNICIAN, fallback=false)'],
  '/estimates/new': ['ProtectedRoute(roles=ADMIN|DISPATCHER|SALES|TECHNICIAN, fallback=false)'],
  '/estimates/:id': ['ProtectedRoute(roles=ADMIN|DISPATCHER|SALES|TECHNICIAN, fallback=false)'],
  // #2030 — a past version. Same guard stack as the workspace it belongs to: the route is meant
  // to be shareable with a colleague, and the API's own per-row ownership check is what decides
  // whether this particular estimate resolves for them.
  '/estimates/:id/versions/:version': ['ProtectedRoute(roles=ADMIN|DISPATCHER|SALES|TECHNICIAN, fallback=false)'],
  '/jobs': ['ProtectedRoute(roles=ADMIN|DISPATCHER|SALES|TECHNICIAN, fallback=false)'],
  '/jobs/new': ['ProtectedRoute(roles=ADMIN|DISPATCHER|SALES|TECHNICIAN, fallback=false)'],
  '/jobs/:id': ['ProtectedRoute(roles=ADMIN|DISPATCHER|SALES|TECHNICIAN, fallback=false)'],
  '/jobs/:jobId/statement': ['ProtectedRoute(roles=ADMIN|DISPATCHER|SALES|TECHNICIAN, fallback=false)'],
  '/invoices': ['ProtectedRoute(roles=ADMIN|DISPATCHER|SALES|TECHNICIAN, fallback=false)'],
  '/invoices/:id': ['ProtectedRoute(roles=ADMIN|DISPATCHER|SALES|TECHNICIAN, fallback=false)'],
  '/schedule': ['ProtectedRoute(roles=ADMIN|DISPATCHER|SALES|TECHNICIAN, fallback=false)'],
  '/tasks': ['ProtectedRoute(roles=ADMIN|DISPATCHER|SALES|TECHNICIAN, fallback=false)'],

  // Standalone invoice authoring - ADMIN + DISPATCHER only, matching the backend
  // 403 and the `create Invoice` grant. Technicians invoice only via their own
  // job. `fallback` means a SALES user gets the "no access" screen in place.
  '/invoices/new': [
    'ProtectedRoute(roles=ADMIN|DISPATCHER|SALES|TECHNICIAN, fallback=false)',
    'ProtectedRoute(roles=ADMIN|DISPATCHER, fallback=true)',
  ],

  // Reports - ADMIN + DISPATCHER only; the backend 403s SALES on /api/reports/*.
  '/reports': [
    'ProtectedRoute(roles=ADMIN|DISPATCHER|SALES|TECHNICIAN, fallback=false)',
    'ProtectedRoute(roles=ADMIN|DISPATCHER, fallback=true)',
  ],
  '/reports/:slug': [
    'ProtectedRoute(roles=ADMIN|DISPATCHER|SALES|TECHNICIAN, fallback=false)',
    'ProtectedRoute(roles=ADMIN|DISPATCHER, fallback=true)',
  ],

  // Marketing - a demo-only mock page with no /api/marketing behind it. The nav
  // lock is not enough on its own: the URL still resolves, hence DemoOnlyRoute.
  '/marketing': [
    'ProtectedRoute(roles=ADMIN|DISPATCHER|SALES|TECHNICIAN, fallback=false)',
    'DemoOnlyRoute',
  ],

  // Users admin - ADMIN only, with the in-place 403 screen.
  '/users': [
    'ProtectedRoute(roles=ADMIN|DISPATCHER|SALES|TECHNICIAN, fallback=false)',
    'ProtectedRoute(roles=ADMIN, fallback=true)',
  ],

  // Leads, entitlement-gated.
  '/leads': ['ProtectedRoute(roles=ADMIN|DISPATCHER|SALES|TECHNICIAN, fallback=false)', 'RequireFeature(leads)'],
  '/leads/new': ['ProtectedRoute(roles=ADMIN|DISPATCHER|SALES|TECHNICIAN, fallback=false)', 'RequireFeature(leads)'],
  '/leads/:id/edit': ['ProtectedRoute(roles=ADMIN|DISPATCHER|SALES|TECHNICIAN, fallback=false)', 'RequireFeature(leads)'],
  '/leads/:id': ['ProtectedRoute(roles=ADMIN|DISPATCHER|SALES|TECHNICIAN, fallback=false)', 'RequireFeature(leads)'],

  '/service-plans': [
    'ProtectedRoute(roles=ADMIN|DISPATCHER|SALES|TECHNICIAN, fallback=false)',
    'RequireFeature(service_plans)',
  ],

  // Automations - Admin + Dispatcher AND the entitlement; the backend 403s
  // Sales/Tech on /api/workflows/*.
  '/automations': [
    'ProtectedRoute(roles=ADMIN|DISPATCHER|SALES|TECHNICIAN, fallback=false)',
    'ProtectedRoute(roles=ADMIN|DISPATCHER, fallback=true)',
    'RequireFeature(automations)',
  ],
  '/automations/new': [
    'ProtectedRoute(roles=ADMIN|DISPATCHER|SALES|TECHNICIAN, fallback=false)',
    'ProtectedRoute(roles=ADMIN|DISPATCHER, fallback=true)',
    'RequireFeature(automations)',
  ],
  '/automations/:id': [
    'ProtectedRoute(roles=ADMIN|DISPATCHER|SALES|TECHNICIAN, fallback=false)',
    'ProtectedRoute(roles=ADMIN|DISPATCHER, fallback=true)',
    'RequireFeature(automations)',
  ],
  '/automations/:id/edit': [
    'ProtectedRoute(roles=ADMIN|DISPATCHER|SALES|TECHNICIAN, fallback=false)',
    'ProtectedRoute(roles=ADMIN|DISPATCHER, fallback=true)',
    'RequireFeature(automations)',
  ],

  // Inventory, entitlement-gated. `/inventory/approvals` is a redirect rather
  // than a page, and is gated the same way so it cannot become a hole.
  '/inventory': ['ProtectedRoute(roles=ADMIN|DISPATCHER|SALES|TECHNICIAN, fallback=false)', 'RequireFeature(inventory)'],
  '/inventory/staging': ['ProtectedRoute(roles=ADMIN|DISPATCHER|SALES|TECHNICIAN, fallback=false)', 'RequireFeature(inventory)'],
  '/inventory/assets': ['ProtectedRoute(roles=ADMIN|DISPATCHER|SALES|TECHNICIAN, fallback=false)', 'RequireFeature(inventory)'],
  '/inventory/low-stock': ['ProtectedRoute(roles=ADMIN|DISPATCHER|SALES|TECHNICIAN, fallback=false)', 'RequireFeature(inventory)'],
  '/inventory/activity': ['ProtectedRoute(roles=ADMIN|DISPATCHER|SALES|TECHNICIAN, fallback=false)', 'RequireFeature(inventory)'],
  '/inventory/logistic-orders': ['ProtectedRoute(roles=ADMIN|DISPATCHER|SALES|TECHNICIAN, fallback=false)', 'RequireFeature(inventory)'],
  '/inventory/approvals': ['ProtectedRoute(roles=ADMIN|DISPATCHER|SALES|TECHNICIAN, fallback=false)', 'RequireFeature(inventory)'],
  '/inventory/price-book': ['ProtectedRoute(roles=ADMIN|DISPATCHER|SALES|TECHNICIAN, fallback=false)', 'RequireFeature(inventory)'],
  '/inventory/purchase-orders': ['ProtectedRoute(roles=ADMIN|DISPATCHER|SALES|TECHNICIAN, fallback=false)', 'RequireFeature(inventory)'],
  '/inventory/vendors': ['ProtectedRoute(roles=ADMIN|DISPATCHER|SALES|TECHNICIAN, fallback=false)', 'RequireFeature(inventory)'],

  // Communication: TWO entitlements, not one. The CTM channels stay on `phone`
  // (Pro+); email is its own `email` key, which every plan includes. Gating the
  // inbox on `phone` would put a feature every plan owns behind a Pro switch.
  //
  // #2046 - moved deliberately, in this commit: the org-wide Communication
  // SECTION (this whole block) is no longer reachable on a role list. The
  // ability-gated `RequireCommunicationSection` replaces `allowedRoles` on
  // `ProtectedRoute` (now `roles=ANY`, matching `/phone`'s auth-only gate) and
  // sits directly under it, ahead of every `RequireFeature`, so a denied
  // caller never reaches the entitlement check or the page.
  '/communication/phone': ['ProtectedRoute(roles=ANY, fallback=false)', 'RequireCommunicationSection', 'RequireFeature(phone)'],
  '/communication/phone/:tab': ['ProtectedRoute(roles=ANY, fallback=false)', 'RequireCommunicationSection', 'RequireFeature(phone)'],
  '/communication/text': ['ProtectedRoute(roles=ANY, fallback=false)', 'RequireCommunicationSection', 'RequireFeature(phone)'],
  '/communication/text/:tab': ['ProtectedRoute(roles=ANY, fallback=false)', 'RequireCommunicationSection', 'RequireFeature(phone)'],
  '/communication/whatsapp': [
    'ProtectedRoute(roles=ANY, fallback=false)',
    'RequireCommunicationSection',
    'RequireFeature(phone)',
    'DemoOnlyRoute',
  ],
  '/communication/inbox': ['ProtectedRoute(roles=ANY, fallback=false)', 'RequireCommunicationSection', 'RequireFeature(email)'],

  // Settings: NO route-level role guard on any tab, and that is deliberate.
  // Every authenticated user of any role can deep-link to any settings page;
  // the nav LIST is CASL-filtered inside SettingsLayout, but the routes are
  // open, so a technician who types /settings/roles mounts the page, fires
  // GET /api/roles, gets a 403 and lands on an empty list. Adding a guard here
  // would change who can reach a page. There is no RequireFeature either, not
  // even on the two comm-gated tabs: the entitlement gates their nav entry and
  // each of those pages gates itself.
  '/settings': ['ProtectedRoute(roles=ADMIN|DISPATCHER|SALES|TECHNICIAN, fallback=false)'],
  '/settings/company': ['ProtectedRoute(roles=ADMIN|DISPATCHER|SALES|TECHNICIAN, fallback=false)'],
  '/settings/branding': ['ProtectedRoute(roles=ADMIN|DISPATCHER|SALES|TECHNICIAN, fallback=false)'],
  '/settings/locations': ['ProtectedRoute(roles=ADMIN|DISPATCHER|SALES|TECHNICIAN, fallback=false)'],
  '/settings/users': ['ProtectedRoute(roles=ADMIN|DISPATCHER|SALES|TECHNICIAN, fallback=false)'],
  '/settings/roles': ['ProtectedRoute(roles=ADMIN|DISPATCHER|SALES|TECHNICIAN, fallback=false)'],
  '/settings/security': ['ProtectedRoute(roles=ADMIN|DISPATCHER|SALES|TECHNICIAN, fallback=false)'],
  '/settings/payments': ['ProtectedRoute(roles=ADMIN|DISPATCHER|SALES|TECHNICIAN, fallback=false)'],
  '/settings/job-sub-statuses': ['ProtectedRoute(roles=ADMIN|DISPATCHER|SALES|TECHNICIAN, fallback=false)'],
  // Decline-reasons slice B. Same open stack as every sibling - but NOT for the reason
  // /settings/roles is open. "A 403-driven empty list" is not what a non-admin got here: this
  // page's GET is gated on the coarser `read Estimate` on purpose (slice C needs a rep to read
  // these words while declining their own estimate), so a SALES user who typed the URL got the
  // organisation's REAL list under controls that each 403. The PAGE therefore gates itself on
  // `update Organization` and renders NotAuthorizedPage - see DeclineReasonsPage.tsx, and
  // `settings-decline-reasons.test.tsx` for the assertions. This row records only that no ROUTE
  // guard was added, which is still true.
  '/settings/decline-reasons': ['ProtectedRoute(roles=ADMIN|DISPATCHER|SALES|TECHNICIAN, fallback=false)'],
  '/settings/phone-sms': ['ProtectedRoute(roles=ADMIN|DISPATCHER|SALES|TECHNICIAN, fallback=false)'],
  '/settings/phone-numbers': ['ProtectedRoute(roles=ADMIN|DISPATCHER|SALES|TECHNICIAN, fallback=false)'],
  '/settings/inventory': ['ProtectedRoute(roles=ADMIN|DISPATCHER|SALES|TECHNICIAN, fallback=false)'],
  '/settings/schedule-colors': ['ProtectedRoute(roles=ADMIN|DISPATCHER|SALES|TECHNICIAN, fallback=false)'],
  '/settings/profile': ['ProtectedRoute(roles=ADMIN|DISPATCHER|SALES|TECHNICIAN, fallback=false)'],
  // `/settings/lead-statuses` is the retired Lead Statuses tab: a redirect to the settings home,
  // under the same parent (and so the same stack) as every sibling above.
  '/settings/lead-statuses': ['ProtectedRoute(roles=ADMIN|DISPATCHER|SALES|TECHNICIAN, fallback=false)'],
  // The tabs with no kit rebuild yet, mounted from `src/pages/settings/`
  // under the same parent as every sibling above. Same stack as the rest of
  // settings, which is the point: re-homing them changed their chrome, not who
  // may open them.
  '/settings/tax-rates': ['ProtectedRoute(roles=ADMIN|DISPATCHER|SALES|TECHNICIAN, fallback=false)'],
  '/settings/email-sender': ['ProtectedRoute(roles=ADMIN|DISPATCHER|SALES|TECHNICIAN, fallback=false)'],
  '/spider': ['ProtectedRoute(roles=ADMIN, fallback=false)'],
  '/bee': ['ProtectedRoute(roles=ADMIN, fallback=false)'],
  // No entry for '/settings/custom-fields' - the tab is held out of the
  // 2026-08-17 release, so there is no route for a guard stack to describe.
};

const routes = allRoutes();

describe('the route parser', () => {
  /**
   * The canary. Every assertion below iterates the parsed list, so a parser that
   * silently matched nothing would turn this whole file green while checking
   * nothing at all. The floor is well under today's count, so a module landing
   * or being removed does not touch it.
   */
  it('finds the route table', () => {
    expect(routes.length, 'routes parsed from the route files').toBeGreaterThan(60);
  });

  it('resolves a nested relative child against its parent path', () => {
    // No route file writes a relative child today - they are all absolute, so
    // that `uiV2.test.ts` can see the literals - but the parser must keep
    // handling the form, because App.tsx used it for the whole settings block
    // and a future file may again. Asserted against a synthetic source rather
    // than a real file, so it cannot quietly stop being exercised.
    const parsed = parseRoutes(
      '<Route path="/settings" element={<Layout />}><Route path="company" element={<Page />} /></Route>',
      0,
      'synthetic',
    );
    expect(parsed.map((r) => r.path)).toEqual(['/settings', '/settings/company']);
  });

  it('reads guards off the pathless wrappers, outermost first', () => {
    const invoicesNew = routes.find((r) => r.path === '/invoices/new');
    expect(invoicesNew?.guards).toEqual([
      'ProtectedRoute(roles=ADMIN|DISPATCHER|SALES|TECHNICIAN, fallback=false)',
      'ProtectedRoute(roles=ADMIN|DISPATCHER, fallback=true)',
    ]);
  });

  it('does not treat a layout as a guard', () => {
    // V2AppLayout wraps nearly every route. If it were counted as a guard, every
    // stack below would be wrong, and the temptation would be to "fix" the pin.
    const leads = routes.find((r) => r.path === '/leads');
    expect(leads?.guards).not.toContain('V2AppLayout');
  });
});

describe('guard stacks', () => {
  it('every routed path carries exactly its pinned stack', () => {
    const mismatches: string[] = [];

    for (const route of routes) {
      const expected = ROUTE_GUARDS[route.path];
      if (!expected) continue; // reported by the completeness test below

      if (JSON.stringify(route.guards) !== JSON.stringify(expected)) {
        mismatches.push(
          `${route.path}  (${route.file})`
          + `\n  actual: ${route.guards.join(' > ') || '(none)'}`
          + `\n  pinned: ${expected.join(' > ') || '(none)'}`,
        );
      }
    }

    expect(mismatches, 'routes whose guard stack differs from the pin').toEqual([]);
  });

  /**
   * Both directions, because each catches a different mistake. A route missing
   * from the pin is a NEW page whose access rules nobody stated - the case where
   * an unguarded route slips in. A pin entry with no route is a stale rule that
   * reads as protecting something it no longer protects.
   */
  it('pins every routed path, and pins nothing that is not routed', () => {
    const declared = new Set(routes.map((r) => r.path));

    const unpinned = [...declared].filter((p) => !ROUTE_GUARDS[p]);
    expect(unpinned, 'routed paths with no ROUTE_GUARDS entry - state their guards there').toEqual([]);

    const stale = Object.keys(ROUTE_GUARDS).filter((p) => !declared.has(p));
    expect(stale, 'ROUTE_GUARDS entries naming a path that is not routed anywhere').toEqual([]);
  });

  /**
   * Two access rules the pin encodes, restated as properties, so that a future
   * edit to the pin which quietly opens a page has to argue with something
   * other than itself.
   */
  it('leaves exactly the five public paths unguarded', () => {
    const unguarded = routes.filter((r) => r.guards.length === 0).map((r) => r.path).sort();
    expect(unguarded).toEqual([
      '/accept-invite',
      '/auth/callback',
      '/login',
      '/p/estimates/:id',
      '/p/invoices/:id',
    ]);
  });

  it('gates every entitlement-gated module on the right feature key', () => {
    const featureOf = (path: string) =>
      routes.find((r) => r.path === path)?.guards.find((g) => g.startsWith('RequireFeature'));

    expect(featureOf('/leads')).toBe('RequireFeature(leads)');
    expect(featureOf('/service-plans')).toBe('RequireFeature(service_plans)');
    expect(featureOf('/automations')).toBe('RequireFeature(automations)');
    expect(featureOf('/inventory')).toBe('RequireFeature(inventory)');
    expect(featureOf('/communication/text')).toBe('RequireFeature(phone)');
    // The inbox is on `email`, NOT on `phone` - every plan includes email.
    expect(featureOf('/communication/inbox')).toBe('RequireFeature(email)');
  });
});

describe('declaration order', () => {
  /**
   * Order only decides an outcome where two patterns are ambiguous for some
   * concrete URL - `/estimates/new` against `/estimates/:id`. Where that
   * happens the more specific pattern must be declared first, or the loose one
   * captures the literal: `/jobs/new` read as a job whose id is "new".
   *
   * This replaces an earlier check that compared each pair's order against the
   * legacy table's order for the same pair. That table is gone, and the rule is
   * better stated directly anyway - it says WHY the order matters instead of
   * deferring to what another file happened to do.
   */
  it('declares the more specific of two overlapping patterns first', () => {
    const inverted: string[] = [];

    for (let a = 0; a < routes.length; a++) {
      for (let b = a + 1; b < routes.length; b++) {
        const first = routes[a]!;
        const second = routes[b]!;
        if (first.path === second.path) continue; // the uniqueness test owns this
        if (!overlaps(first.path, second.path)) continue;

        if (paramCount(first.path) > paramCount(second.path)) {
          inverted.push(
            `${first.path} (${first.file}) is declared before the more specific `
            + `${second.path} (${second.file}), so it captures its URLs first`,
          );
        }
      }
    }

    expect(inverted, 'overlapping patterns declared loosest-first').toEqual([]);
  });
});
