import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { allRoutes, stripComments } from './routeTable';

/**
 * Every settings tab is BOTH routed and reachable by clicking.
 *
 * Settings is the one module where the two can come apart. Its pages are not
 * linked from anywhere else in the app - no row click, no breadcrumb, no command
 * palette entry reaches `/settings/tax-rates` - so a page whose route exists
 * while its nav row does not is a page only someone who already knows the URL
 * can open. That is indistinguishable from having deleted it.
 *
 * It very nearly happened. Four tabs - Lead Statuses (since retired, see below), Tax
 * Rates, Sender Address and Custom Fields - were never rebuilt on the kit, so the rebuilt shell's NAV
 * listed twelve entries where the original listed sixteen. When the rebuilt
 * `/settings` took over the bare path, those routes had to move under it
 * (`routes/settings.routes.tsx`) and their nav rows had to be added to the
 * shell, or the move would have quietly cost four working admin pages. This test
 * is what makes that a failure rather than a discovery.
 *
 * Two of the four are asserted below, and Lead Statuses is asserted GONE. Custom Fields is the exception: it is
 * held out of the 2026-08-17 release entirely - no route, no nav row, no claimed
 * path - because the feature has never been exercised by a human in a real org.
 * That is a deliberate absence, so the case below asserts it stays absent rather
 * than leaving a gap a future edit could fill by accident.
 *
 * Source-parsed for the reason `routeTable.ts` explains: NAV is a module-private
 * array, and rendering the shell to read it needs an ability, an entitlements
 * cache and an org. The array is a static literal, so its text is its value.
 */

const V2_DIR = join(__dirname, '..');
const SETTINGS_LAYOUT = join(V2_DIR, 'settings', 'SettingsLayout.tsx');

/** The `to:` slug of every row in the shell's NAV array. */
function navSlugs(): string[] {
  const src = readFileSync(SETTINGS_LAYOUT, 'utf8');
  const start = src.indexOf('const NAV: NavItem[] = [');
  expect(start, 'NAV array not found in SettingsLayout.tsx - has it been renamed?').toBeGreaterThan(-1);
  const end = src.indexOf('];', start);
  const block = src.slice(start, end);

  return [...block.matchAll(/\bto:\s*'([^']+)'/g)].map((m) => m[1]!);
}

/**
 * Retired tabs: the old URL is kept only as a redirect (to the settings home, or to the Payments page for
 * `servwave-payments`, whose area moved there in payments go-live P8), so it is routed (and claimed) without a nav
 * row, on purpose.
 */
const RETIRED_SLUGS = ['lead-statuses', 'payments', 'payout-account'];

/**
 * Child pages: a settings route that is not a tab of its own but is opened from a tab's page.
 * They get no nav row, and instead of being exempted they are PROVED reachable: the parent
 * slug must be a routed tab with a nav row, and the routed source file named here must really
 * navigate to the child's path. A parent page that stops linking to its child fails the test.
 */
const CHILD_PAGES: { path: string; parent: string; linkedFrom: string }[] = [
  // A person's Permissions page, opened from the Permissions action on a Users & Teams row.
  { path: 'users/:userId/permissions', parent: 'users', linkedFrom: join('settings', 'UsersTeamsPage.tsx') },
];

/** Every `/settings/<child>` route, by its final segment. */
function routedSlugs(): string[] {
  return allRoutes()
    .filter((r) => r.path.startsWith('/settings/'))
    .map((r) => r.path.slice('/settings/'.length));
}

describe('settings tabs', () => {
  it('finds both lists, so the check is not vacuous', () => {
    expect(navSlugs().length, 'nav rows').toBeGreaterThan(10);
    expect(routedSlugs().length, 'routed settings children').toBeGreaterThan(10);
  });

  it('routes every nav row', () => {
    const routed = new Set(routedSlugs());
    const unrouted = navSlugs().filter((slug) => !routed.has(slug));

    expect(
      unrouted,
      'settings nav rows with no route - clicking one falls through to path="*" and bounces to "/"',
    ).toEqual([]);
  });

  it('gives every routed tab a nav row', () => {
    const inNav = new Set(navSlugs());
    const unreachable = routedSlugs().filter(
      (slug) => !inNav.has(slug)
        && !RETIRED_SLUGS.includes(slug)
        && !CHILD_PAGES.some((child) => child.path === slug),
    );

    expect(
      unreachable,
      'settings pages with a route but no nav row - nothing else in the app links to them, '
      + 'so they are reachable only by typing the URL',
    ).toEqual([]);
  });

  /**
   * A child page is exempt from the nav row only because something real opens it. The link is
   * read from the parent page's source with comments removed, so a docstring that still
   * mentions the path cannot keep a deleted navigation alive.
   */
  it.each(CHILD_PAGES)('reaches the child page $path from its parent tab $parent', (child) => {
    expect(routedSlugs(), `/settings/${child.path} must be routed`).toContain(child.path);
    expect(routedSlugs(), `parent tab ${child.parent} must be routed`).toContain(child.parent);
    expect(navSlugs(), `parent tab ${child.parent} must have a nav row`).toContain(child.parent);

    const file = join(V2_DIR, child.linkedFrom);
    expect(existsSync(file), `${child.linkedFrom} must exist`).toBe(true);
    const src = stripComments(readFileSync(file, 'utf8'));

    // `:userId` in the route is a template placeholder in the link: `/settings/users/${u.id}/...`.
    const target = child.path
      .split('/')
      .map((seg) => (seg.startsWith(':') ? '\\$\\{[^}]+\\}' : seg))
      .join('/');
    const navigation = new RegExp(`(navigate\\(|\\bto=\\{?)\\s*[\`'"]/settings/${target}[\`'"]`);
    expect(
      src,
      `${child.linkedFrom} must navigate to /settings/${child.path} - otherwise the page is reachable only by typing the URL`,
    ).toMatch(navigation);
  });

  /**
   * Named individually, not just covered by the two set comparisons above,
   * because these are the ones that had to be re-homed by hand. A future
   * edit that drops one would still satisfy both comparisons - the route and the
   * nav row would disappear together - and look tidy doing it.
   */
  it.each([
    ['tax-rates', 'Tax Rates'],
    ['email-sender', 'Sender Address'],
  ])('keeps the not-yet-rebuilt %s tab routed and in the nav', (slug, label) => {
    expect(routedSlugs(), `/settings/${slug} must stay routed`).toContain(slug);
    expect(navSlugs(), `${label} must stay in the settings nav`).toContain(slug);
    expect(readFileSync(SETTINGS_LAYOUT, 'utf8')).toContain(`label: '${label}'`);
  });

  it('mounts those two from their original modules, since no rebuild exists yet', () => {
    // The import path is the evidence that no rebuilt page was silently swapped
    // in. If one lands, this line changes in the same commit as the import.
    const src = readFileSync(join(V2_DIR, 'routes', 'settings.routes.tsx'), 'utf8');
    for (const page of ['TaxRatesPage', 'EmailSenderPage']) {
      expect(src).toContain(`import('@/pages/settings/${page}')`);
    }
  });

  /**
   * Lead statuses are fixed (walkthrough lead-statuses PRD, D12): the tab is retired, not held
   * out. There is no nav row in either settings shell and no page behind the old URL, which is
   * a redirect to the settings home rather than a route to a page. (That the redirect LANDS on
   * the home is proved by rendering it, in `settings-lead-statuses-retired.test.tsx`.)
   */
  it('has no Lead Statuses nav row in either settings shell', () => {
    expect(navSlugs(), 'the routed settings shell').not.toContain('lead-statuses');

    for (const shell of [SETTINGS_LAYOUT, join(V2_DIR, '..', 'settings', 'SettingsLayout.tsx')]) {
      const src = readFileSync(shell, 'utf8');
      expect(src, shell).not.toContain("label: 'Lead Statuses'");
      expect(src, shell).not.toContain("to: 'lead-statuses'");
    }
  });

  it('mounts no page for the old Lead Statuses URL, only a redirect to the settings home', () => {
    const routes = readFileSync(join(V2_DIR, 'routes', 'settings.routes.tsx'), 'utf8');
    expect(routes).not.toContain('LeadStatusesPage');
    expect(routes).toMatch(/path="\/settings\/lead-statuses"\s+element=\{<Navigate to="\/settings" replace \/>\}/);
    expect(existsSync(join(V2_DIR, '..', 'settings', 'LeadStatusesPage.tsx'))).toBe(false);
  });

  /**
   * The inverse of every case above. Custom Fields is held out of the release, and
   * "held out" has to mean all three of route, nav row and claimed path - any one
   * of them coming back on its own is either a dead nav row or a URL-only page,
   * which is the exact failure this file exists to catch.
   */
  it('keeps Custom Fields out of the route table, the nav and the path registry', () => {
    expect(routedSlugs(), '/settings/custom-fields must not be routed').not.toContain('custom-fields');
    expect(navSlugs(), 'Custom Fields must not appear in the settings nav').not.toContain('custom-fields');

    const routes = readFileSync(join(V2_DIR, 'routes', 'settings.routes.tsx'), 'utf8');
    expect(routes).not.toContain("import('@/pages/settings/CustomFieldsPage')");

    const paths = readFileSync(join(V2_DIR, 'routes', 'settings.paths.ts'), 'utf8');
    expect(paths).not.toContain("'/settings/custom-fields'");
  });
});
