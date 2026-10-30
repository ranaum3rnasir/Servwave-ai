/* =============================================================================
   Roles & Permissions, PRD 9, slice S09.9 (scenario pass 3 fix) - the Unscheduled jobs tile counts and lists
   exactly what the Jobs list it opens shows.

   "View all" on the tile opens the Jobs page at ?status=UNSCHEDULED, and that page always asks the list for
   exclude_plan_visits=true (a service plan's booked visit jobs are managed inside the Service Plans module). On
   staging the tile read 156 and the page 154: the tile counted the two visit jobs the page hides.

   Everything goes through the public interface (GET /api/dashboard and GET /api/jobs), as people on the stock
   presets, with service plan visit jobs in the data. Real migrated database (TEST_DATABASE_URL); the suite skips when
   it is unset. Every org it creates is removed again.
   ========================================================================== */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import type { PrismaClient } from '@prisma/client';

// One factory for every client in this file (see permission-switches-db.test.ts for why).
const { realClient } = vi.hoisted(() => {
  const clientAt = (url: string) => {
    const { PrismaClient } = require('@prisma/client') as typeof import('@prisma/client');
    return new PrismaClient({ datasources: { db: { url } } });
  };
  const dbUrl = process.env.TEST_DATABASE_URL;
  return { realClient: dbUrl ? clientAt(dbUrl) : undefined };
});

// The suite-wide setup mocks the app's client; here it is the real one.
vi.mock('../lib/prisma', () => ({ prisma: realClient }));

import { switchFixture, type Person } from './permission-switches-fixture';

const suite = realClient ? describe : describe.skip;

suite('the Unscheduled jobs tile agrees with the Jobs list it opens (real database)', () => {
  const db = realClient as PrismaClient;
  const fx = switchFixture(db, async () => (await import('../app.js')).default as never);
  // Loading the whole app is slow on a loaded machine.
  beforeAll(async () => {
    await import('../app.js');
  }, 120_000);
  afterAll(() => fx.cleanup());

  type TileData = { count: number; jobs: Array<{ id: string }> };
  const tileOf = async (person: Person): Promise<TileData> => {
    const res = await (await fx.signedInAs(person)).get('/api/dashboard');
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    return res.body.data.unscheduled_jobs as TileData;
  };
  /** The list exactly as the Jobs page asks for it when the tile's "View all" opens it. */
  const listOf = async (person: Person) => {
    const res = await (await fx.signedInAs(person)).get('/api/jobs?status=UNSCHEDULED&exclude_plan_visits=true&limit=100');
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    return res.body as { jobs: Array<{ id: string }>; pagination: { total: number } };
  };

  /** Unscheduled jobs of the company, some of them a service plan's booked visit jobs, plus a scheduled one. */
  async function world() {
    const made = await fx.newOrg();
    const { org, customer } = made;
    const dispatcher = await fx.addUser(org, 'unsched-dispatcher', 'DISPATCHER');
    const sales = await fx.addUser(org, 'unsched-sales', 'SALES');
    const plan = await fx.addServicePlan(org, customer, { soldBy: sales.id });
    const plain = [
      await fx.addJob(org, customer, { status: 'UNSCHEDULED' }),
      await fx.addJob(org, customer, { status: 'UNSCHEDULED', dispatcher: dispatcher.id }),
      await fx.addJob(org, customer, { status: 'UNSCHEDULED', soldBy: sales.id }),
    ];
    const visits = [
      await fx.addJob(org, customer, { status: 'UNSCHEDULED', sourcePlan: plan.id }),
      await fx.addJob(org, customer, { status: 'UNSCHEDULED', sourcePlan: plan.id, soldBy: sales.id, dispatcher: dispatcher.id }),
    ];
    await fx.addJob(org, customer, { status: 'SCHEDULED' });
    return { ...made, dispatcher, sales, plain, visits };
  }

  it('leaves out a service plan visit job, exactly as the Jobs list does', async () => {
    const w = await world();

    const tile = await tileOf(w.admin);
    const list = await listOf(w.admin);

    expect(list.pagination.total).toBe(w.plain.length);
    expect(tile.count).toBe(w.plain.length);
    expect(tile.jobs.map((j) => j.id).sort()).toEqual(w.plain.map((j) => j.id).sort());
    for (const visit of w.visits) expect(JSON.stringify(tile)).not.toContain(visit.id);
  });

  it('shows a Dispatcher the same count and the same rows as the list opened from the tile', async () => {
    const w = await world();

    const tile = await tileOf(w.dispatcher);
    const list = await listOf(w.dispatcher);

    expect(list.pagination.total).toBe(w.plain.length);
    expect(tile.count).toBe(list.pagination.total);
    expect(tile.jobs.map((j) => j.id).sort()).toEqual(list.jobs.map((j) => j.id).sort());
  });

  it('agrees for a person whose Jobs scope is Attached, when a visit job they are on sits beside their own job', async () => {
    const w = await world();
    const { setRoleSwitchValues } = await import('../lib/permissions/switches/store.js');
    const { SWITCH_CATALOG } = await import('../lib/permissions/switches/catalog.js');
    const allOff = Object.fromEntries(SWITCH_CATALOG.filter((s) => s.kind === 'toggle').map((s) => [s.key, false]));
    await fx.addCustomRole(w.org, 'unsched-attached', 'TECHNICIAN', { madeFromBlank: true, copyGrants: false });
    await setRoleSwitchValues({
      organizationId: w.org, roleKey: 'unsched-attached', actorId: null, reason: 'manual',
      values: { ...allOff, view_jobs: true, jobs_scope: 'attached' },
    });
    const role = await db.customRole.findFirstOrThrow({ where: { organization_id: w.org, key: 'unsched-attached' } });
    const me = await fx.addUser(w.org, 'unsched-attached-user', 'TECHNICIAN', { customRoleId: role.id });
    const plan = await fx.addServicePlan(w.org, w.customer, { soldBy: me.id });
    const own = await fx.addJob(w.org, w.customer, { status: 'UNSCHEDULED', dispatcher: me.id });
    const visit = await fx.addJob(w.org, w.customer, { status: 'UNSCHEDULED', sourcePlan: plan.id, dispatcher: me.id });

    const tile = await tileOf(me);
    const list = await listOf(me);

    expect(list.jobs.map((j) => j.id)).toEqual([own.id]);
    expect(tile.count).toBe(list.pagination.total);
    expect(tile.jobs.map((j) => j.id)).toEqual([own.id]);
    expect(JSON.stringify(tile)).not.toContain(visit.id);
  });
});
