/* =============================================================================
   Roles & Permissions security, M7 (ticket 36): each export switch off closes its export route.

   The table is read from the route files (every route guarded by an Export switch), so an export route added later joins it.
   For each: a person on a custom role who may open the list and holds every other Export switch is refused (403) with that
   one Export switch off, and served (200) with it on; and one Export switch never stands in for another. Called as people on
   custom roles, never a built-in role name, against a real migrated database (TEST_DATABASE_URL); the suite skips when unset.
   ========================================================================== */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { readdirSync, readFileSync } from 'fs';
import { join } from 'path';
import type { PrismaClient } from '@prisma/client';

const { realClient } = vi.hoisted(() => {
  const clientAt = (url: string) => {
    const { PrismaClient } = require('@prisma/client') as typeof import('@prisma/client');
    return new PrismaClient({ datasources: { db: { url } } });
  };
  const dbUrl = process.env.TEST_DATABASE_URL;
  return { realClient: dbUrl ? clientAt(dbUrl) : undefined };
});

vi.mock('../lib/prisma', () => ({ prisma: realClient }));

import { switchFixture } from './permission-switches-fixture';
import { scanRouteGates } from './permission-communication-routes-scan';
import { setRoleSwitchValues } from '../lib/permissions/switches/store';

const suite = realClient ? describe : describe.skip;

/** Where each route file is mounted (app.ts), for the files that hold an export route. */
const MOUNTS: Record<string, string> = {
  'customer.routes.ts': '/api/customers', 'lead.routes.ts': '/api/leads', 'job.routes.ts': '/api/jobs',
  'estimate.routes.ts': '/api/estimates', 'invoice.routes.ts': '/api/invoices',
};
/** The View switch whose list the export is a download of. */
const VIEW_FOR: Record<string, string> = {
  export_customers: 'view_customers', export_leads: 'view_leads', export_jobs: 'view_jobs',
  export_estimates: 'view_estimates', export_invoices: 'view_invoices',
};

const ROUTES_DIR = join(__dirname, '..', 'routes');
const EXPORT_ROUTES = readdirSync(ROUTES_DIR)
  .filter((f) => f.endsWith('.routes.ts'))
  .flatMap((file) => scanRouteGates(readFileSync(join(ROUTES_DIR, file), 'utf8'), MOUNTS[file] ?? `/unmounted/${file}`))
  .filter((r) => r.grants.some((g) => g.startsWith('export:')))
  .map((r) => ({ method: r.method, path: r.path, exportKey: r.switches[0]! }));

suite('each Export switch closes its export route (real database)', () => {
  const db = realClient as PrismaClient;
  const fx = switchFixture(db, async () => (await import('../app.js')).default as never);
  beforeAll(async () => {
    await import('../app.js');
  }, 120_000);
  afterAll(() => fx.cleanup());

  let sequence = 0;
  async function personWith(org: string, values: Record<string, boolean | string>) {
    const key = `ex-role-${++sequence}`;
    const role = await fx.addCustomRole(org, key, 'DISPATCHER');
    await setRoleSwitchValues({ organizationId: org, roleKey: key, values, actorId: null, reason: 'manual' });
    const person = await fx.addUser(org, `p${sequence}`, 'DISPATCHER', { customRoleId: role.id });
    return { api: () => fx.signedInAs(person), set: (more: Record<string, boolean | string>) => setRoleSwitchValues({ organizationId: org, roleKey: key, values: more, actorId: null, reason: 'manual' }) };
  }
  const viewable = { ...Object.fromEntries(Object.values(VIEW_FOR).map((k) => [k, true])), leads_scope: 'all', jobs_scope: 'all' };
  const everyExport = (on: boolean) => Object.fromEntries(Object.keys(VIEW_FOR).map((k) => [k, on]));

  it('finds the export routes (guards against a table that reads nothing and so passes)', () => {
    expect(EXPORT_ROUTES.map((r) => `${r.method} ${r.path}`).sort()).toEqual([
      'get /api/customers/export', 'get /api/estimates/export', 'get /api/invoices/export', 'get /api/jobs/export', 'get /api/leads/export',
    ]);
    expect(EXPORT_ROUTES.map((r) => r.exportKey).sort()).toEqual(Object.keys(VIEW_FOR).sort());
  });

  it.each(EXPORT_ROUTES)('$path: refused with its Export switch off while View is on, served with it on', async (route) => {
    const { org } = await fx.newOrg();
    const me = await personWith(org, { ...viewable, ...everyExport(true), [route.exportKey]: false });
    const api = await me.api();
    expect((await api.get(route.path.replace('/export', ''))).status, 'the list with View on').toBe(200);
    expect((await api.get(route.path)).status).toBe(403);
    await me.set({ [route.exportKey]: true });
    expect((await api.get(route.path)).status).toBe(200);
  });

  it('lets each Export switch decide its own route alone: with only one on, only that route is served', async () => {
    const { org } = await fx.newOrg();
    for (const only of EXPORT_ROUTES) {
      const me = await personWith(org, { ...viewable, ...everyExport(false), [only.exportKey]: true });
      const api = await me.api();
      for (const r of EXPORT_ROUTES) {
        expect((await api.get(r.path)).status, `${r.path} with only ${only.exportKey} on`).toBe(r === only ? 200 : 403);
      }
    }
  });
});
