/* =============================================================================
   Roles & Permissions, PRD 7, slice S07.21 - Service Plans and Automations follow their switches, and the plan gates
   stay on top of them.

   Everything goes through the public interface: the role store and the schedule's service-plan bucket, the service
   plan list and the workflow list, called as people on custom roles (never a built-in role name) whose switch values
   are the ones under test. Real migrated database (TEST_DATABASE_URL); the suite skips when it is unset. Every org it
   creates is removed again.
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
import { SWITCH_CATALOG } from '../lib/permissions/switches/catalog';
import { setRoleSwitchValues } from '../lib/permissions/switches/store';

const suite = realClient ? describe : describe.skip;

suite('service plans and automations follow their switches (real database)', () => {
  const db = realClient as PrismaClient;
  const fx = switchFixture(db, async () => (await import('../app.js')).default as never);
  // Loading the whole app is slow on a loaded machine.
  beforeAll(async () => {
    await import('../app.js');
  }, 120_000);
  afterAll(() => fx.cleanup());

  type Api = Awaited<ReturnType<typeof fx.signedInAs>>;
  let sequence = 0;

  /** A person on a fresh custom role holding exactly these switch values on top of the base role's preset. */
  async function personWith(
    org: string,
    values: Record<string, boolean>,
    base: 'ADMIN' | 'DISPATCHER' | 'SALES' | 'TECHNICIAN' = 'DISPATCHER',
  ): Promise<Person & { api: () => Promise<Api> }> {
    const key = `sp-role-${++sequence}`;
    const role = await fx.addCustomRole(org, key, base);
    // A switch turned off takes the switches that need it with it, the way the Roles screen does.
    const withDependants = { ...values };
    for (const [switchKey, value] of Object.entries(values)) {
      if (value) continue;
      for (const entry of SWITCH_CATALOG) if (entry.requires.includes(switchKey)) withDependants[entry.key] = false;
    }
    await setRoleSwitchValues({ organizationId: org, roleKey: key, values: withDependants, actorId: null, reason: 'manual' });
    const person = await fx.addUser(org, `p${sequence}`, base, { customRoleId: role.id });
    return Object.assign(person, { api: () => fx.signedInAs(person) });
  }

  /** The switch a person sees under this label, looked up in the catalog so a rename fails here. */
  const key = (label: string) => {
    const found = SWITCH_CATALOG.find((s) => s.label === label);
    if (!found) throw new Error(`No switch labelled "${label}"`);
    return found.key;
  };

  describe("the schedule's service-plan bucket", () => {
    it('is served to a person who holds Access Schedule and View service plans', async () => {
      const { org } = await fx.newOrg();
      const person = await personWith(org, { [key('Access Schedule')]: true, [key('View service plans')]: true });
      const res = await (await person.api()).get('/api/service-plans/scheduler-bucket');
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body.plans)).toBe(true);
    });

    it('is refused to a person who holds Access Schedule but not View service plans', async () => {
      const { org } = await fx.newOrg();
      const person = await personWith(org, { [key('Access Schedule')]: true, [key('View service plans')]: false });
      expect((await (await person.api()).get('/api/service-plans/scheduler-bucket')).status).toBe(403);
    });

    it('is refused to a person who holds View service plans but not Access Schedule', async () => {
      const { org } = await fx.newOrg();
      const person = await personWith(org, { [key('Access Schedule')]: false, [key('View service plans')]: true });
      expect((await (await person.api()).get('/api/service-plans/scheduler-bucket')).status).toBe(403);
    });

    it('leaves the schedule otherwise loading: the job list answers without View service plans', async () => {
      const { org } = await fx.newOrg();
      const person = await personWith(org, {
        [key('Access Schedule')]: true,
        [key('View service plans')]: false,
        [key('View jobs')]: true,
      });
      expect((await (await person.api()).get('/api/jobs')).status).toBe(200);
    });
  });

  describe('the plan gates stay on top of every switch', () => {
    // One request per module: the plan decides, whatever the switch says.
    const modules = [
      { name: 'Service Plans', on: 'View service plans', call: (api: Api) => api.get('/api/service-plans'), feature: 'service_plans' },
      { name: 'Automations', on: 'View automations', call: (api: Api) => api.get('/api/workflows'), feature: 'automations' },
    ];

    it.each(modules)('lets $name in on a plan that has it, with the switch on', async ({ on, call }) => {
      const { org } = await fx.newOrg();
      const person = await personWith(org, { [key(on)]: true });
      expect((await call(await person.api())).status).toBe(200);
    });

    it.each(modules)('refuses $name with 402 on a plan that lacks it, with the same switch on', async ({ on, call, feature }) => {
      const { org } = await fx.newOrg();
      await db.organization.update({ where: { id: org }, data: { plan: 'STARTER' } });
      const person = await personWith(org, { [key(on)]: true });
      const refused = await call(await person.api());
      expect(refused.status).toBe(402);
      expect(refused.body.feature).toBe(feature);
    });
  });
});
