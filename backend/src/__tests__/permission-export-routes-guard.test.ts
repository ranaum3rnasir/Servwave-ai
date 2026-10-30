/* =============================================================================
   Roles & Permissions security, M7 (ticket 36): each export switch closes its export route.

   Pure: no database. The route files are read and every export route in them is accounted for: it is guarded by exactly
   one Export switch of the catalog, or it is a declared exception with its reason. Every Export switch of the catalog has
   such a route, or it is a declared browser-built export (no server route exists to close). A route or a switch added later
   fails here until it is accounted for. The behaviour is proven against a real database by permission-export-routes-db.test.ts.
   ========================================================================== */

import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'fs';
import { join } from 'path';
import { SWITCH_CATALOG } from '../lib/permissions/switches/catalog';
import { scanRouteGates } from './permission-communication-routes-scan';

const ROUTES_DIR = join(__dirname, '..', 'routes');
const keyOf = (file: string, r: { method: string; path: string }) => `${file}: ${r.method.toUpperCase()} ${r.path}`;

const ALL = readdirSync(ROUTES_DIR)
  .filter((f) => f.endsWith('.routes.ts'))
  .flatMap((file) => scanRouteGates(readFileSync(join(ROUTES_DIR, file), 'utf8'), '').map((r) => ({ file, ...r })));

/** A route that serves a download but is not held by an Export switch, and why. */
const NOT_AN_EXPORT_SWITCH: Record<string, string> = {
  'payments-page.routes.ts: GET /payments/export': 'the payments list download is part of View payments and payouts (payments-page-export), which has no Export switch',
  'aiFarm.routes.ts: GET /spider/history/export': 'the Spider history download sits behind the Spider gate and its Admin check',
  'aiFarm.routes.ts: POST /spider/history/export': 'the Spider history download sits behind the Spider gate and its Admin check',
};

/** Export switches whose file is built in the browser from rows the list already serves: there is no server route to close. */
const BROWSER_BUILT = ['export_call_log', 'export_price_book', 'export_purchase_orders', 'export_reports', 'export_stock', 'export_vendors'];

const exportSwitches = SWITCH_CATALOG.filter((s) => s.key.startsWith('export_'));

describe('every export route is closed by its Export switch', () => {
  const exportRoutes = ALL.filter((r) => r.grants.some((g) => g.startsWith('export:')));

  it('finds the routes (guards against a scan that reads nothing and so passes)', () => {
    expect(exportRoutes.map((r) => keyOf(r.file, r))).toEqual(expect.arrayContaining([
      'customer.routes.ts: GET /export', 'lead.routes.ts: GET /export', 'job.routes.ts: GET /export',
      'estimate.routes.ts: GET /export', 'invoice.routes.ts: GET /export',
    ]));
  });

  it('guards each export route with exactly one Export switch of the catalog', () => {
    const wrong = exportRoutes.filter((r) => r.switches.length !== 1 || !r.switches[0]!.startsWith('export_')).map((r) => keyOf(r.file, r));
    expect(wrong).toEqual([]);
  });

  it('guards every route that serves an export, or declares why it is not held by an Export switch', () => {
    const served = ALL.filter((r) => /(^|\/)export(\/|$)/.test(r.path));
    const unaccounted = served
      .filter((r) => !r.grants.some((g) => g.startsWith('export:')) && !(keyOf(r.file, r) in NOT_AN_EXPORT_SWITCH))
      .map((r) => keyOf(r.file, r));
    expect(unaccounted).toEqual([]);
  });

  it('lists no declared exception that is no longer a route', () => {
    const real = new Set(ALL.map((r) => keyOf(r.file, r)));
    expect(Object.keys(NOT_AN_EXPORT_SWITCH).filter((k) => !real.has(k))).toEqual([]);
  });

  it('gives each Export switch a server route, or declares it browser-built with no server check', () => {
    const guarded = new Set(exportRoutes.flatMap((r) => r.switches));
    const withoutRoute = exportSwitches.filter((s) => !guarded.has(s.key));
    expect(withoutRoute.map((s) => s.key).sort()).toEqual(BROWSER_BUILT);
    for (const s of withoutRoute) {
      expect(s.serverChecks, s.key).toEqual([]);
      expect(s.pending, s.key).toMatch(/built in the browser|no server report export exists/);
    }
    for (const s of exportSwitches.filter((x) => guarded.has(x.key))) expect(s.serverChecks.length, s.key).toBeGreaterThan(0);
  });

  it('would fail on a planted export route with no Export switch', () => {
    const planted = scanRouteGates(`router.get('/export', canDo('read', 'Vendor'), h);`, '/api/inventory');
    expect(planted.filter((r) => /(^|\/)export(\/|$)/.test(r.path) && !r.grants.some((g) => g.startsWith('export:')))).toHaveLength(1);
  });
});
