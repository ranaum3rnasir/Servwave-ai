/* =============================================================================
   Roles & Permissions, scenario pass 1 fix - resolving the switches of many people at once (real database).

   The batch resolver must give every person the answer the one-at-a-time resolver gives, for every kind of person a
   company holds: built-in roles, custom roles, a person with values of their own, the Admin box, an inactive
   person, a role with no stored rows, a role made from blank. And the two pages that stalled on a company of 217
   people (the roster pickers, the Inventory page) are exercised with 200 people on 100 roles: right answers, and
   a database read count that does not grow with the people. Real migrated database (TEST_DATABASE_URL); the suite
   skips when it is unset. Every org it creates is removed again.
   ========================================================================== */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import type { PrismaClient, Role } from '@prisma/client';

// One factory for every client in this file (see permission-switches-db.test.ts for why). It counts the queries
// it sends, so a test can say how many reads a request cost.
const { realClient, queries } = vi.hoisted(() => {
  const counter = { count: 0 };
  const clientAt = (url: string) => {
    const { PrismaClient } = require('@prisma/client') as typeof import('@prisma/client');
    const client = new PrismaClient({ datasources: { db: { url } }, log: [{ emit: 'event', level: 'query' }] });
    (client as unknown as { $on: (e: string, cb: () => void) => void }).$on('query', () => { counter.count += 1; });
    return client;
  };
  const dbUrl = process.env.TEST_DATABASE_URL;
  return { realClient: dbUrl ? clientAt(dbUrl) : undefined, queries: counter };
});

// The suite-wide setup mocks the app's client; here it is the real one.
vi.mock('../lib/prisma', () => ({ prisma: realClient }));

import { switchFixture, type Person } from './permission-switches-fixture';
import { SWITCH_CATALOG } from '../lib/permissions/switches/catalog';
import { clearAllSwitchCaches } from '../lib/permissions/switches/cache';

const suite = realClient ? describe : describe.skip;

suite('many people at once (real database)', () => {
  const db = realClient as PrismaClient;
  const fx = switchFixture(db, async () => (await import('../app.js')).default as never);
  // Loading the whole app is slow on a loaded machine.
  beforeAll(async () => {
    await import('../app.js');
  }, 120_000);
  afterAll(() => fx.cleanup());

  const store = () => import('../lib/permissions/switches/store.js');
  let sequence = 0;

  /** A stored person, as the app reads one, for the resolvers. */
  const subjectOf = (id: string) =>
    db.user.findUniqueOrThrow({
      where: { id },
      select: { id: true, organization_id: true, role: true, is_admin: true, custom_role_id: true, custom_role: { select: { key: true } } },
    });

  async function customRole(org: string, base: Role, values: Record<string, boolean | string | string[]> | null, opts: { blank?: boolean } = {}) {
    const key = `many-role-${++sequence}`;
    const role = await fx.addCustomRole(org, key, base, { madeFromBlank: opts.blank, copyGrants: false });
    if (values) {
      await db.permissionRoleSwitch.createMany({
        data: Object.entries(values).map(([switch_key, value]) => ({ organization_id: org, role_key: key, switch_key, value })),
      });
    }
    return { key, role };
  }

  describe('the answer for each person', () => {
    it('equals resolveSwitches person by person, for a mixed company', async () => {
      const { org, admin } = await fx.newOrg();
      const { resolveSwitches, resolveSwitchesForPeople } = await store();
      const people: Person[] = [admin];
      for (const base of ['SALES', 'DISPATCHER', 'TECHNICIAN', 'ADMIN'] as const) {
        // A built-in role with a stored row for one switch (the role was edited), and one with none.
        people.push(await fx.addUser(org, `builtin${++sequence}`, base));
      }
      await db.permissionRoleSwitch.create({ data: { organization_id: org, role_key: 'TECHNICIAN', switch_key: 'can_be_dispatcher', value: true } });
      const editedTech = await customRole(org, 'TECHNICIAN', { can_be_dispatcher: true, can_own_leads: true, inventory_view: 'counter' });
      const dispatcherBase = await customRole(org, 'DISPATCHER', { can_be_dispatcher: false });
      const noRows = await customRole(org, 'SALES', null);
      const blank = await customRole(org, 'TECHNICIAN', { can_be_on_crew: true }, { blank: true });
      const adminDerived = await customRole(org, 'ADMIN', { can_be_on_crew: false });
      for (const r of [editedTech, dispatcherBase, noRows, blank, adminDerived]) {
        people.push(await fx.addUser(org, `custom${++sequence}`, r.role.base_role, { customRoleId: r.role.id }));
      }
      // Someone with values of their own on top of their role, one inactive, one based on a role other than the
      // one they were given, one whose role no longer exists.
      const overridden = await fx.addUser(org, `own${++sequence}`, 'TECHNICIAN', { customRoleId: editedTech.role.id });
      await db.permissionUserSwitch.createMany({
        data: [
          { organization_id: org, user_id: overridden.id, switch_key: 'can_be_dispatcher', value: false },
          { organization_id: org, user_id: overridden.id, switch_key: 'inventory_view', value: 'field' },
        ],
      });
      people.push(overridden);
      const inactive = await fx.addUser(org, `inactive${++sequence}`, 'TECHNICIAN', { customRoleId: editedTech.role.id });
      await db.user.update({ where: { id: inactive.id }, data: { is_active: false } });
      people.push(inactive);
      people.push(await fx.addUser(org, `based${++sequence}`, 'TECHNICIAN', { customRoleId: editedTech.role.id, basedOnRoleKey: dispatcherBase.key }));
      people.push(await fx.addUser(org, `gone${++sequence}`, 'SALES', { basedOnRoleKey: 'a-role-that-was-deleted' }));
      // A person of another company in the same call.
      const other = await fx.newOrg();
      people.push(other.admin);
      people.push(await fx.addUser(other.org, `other${++sequence}`, 'DISPATCHER'));
      clearAllSwitchCaches();

      const subjects = await Promise.all(people.map((p) => subjectOf(p.id)));
      const batch = await resolveSwitchesForPeople(subjects);
      expect(batch.size).toBe(people.length);
      clearAllSwitchCaches();
      for (const s of subjects) {
        expect(batch.get(s.id), s.id).toEqual(await resolveSwitches(s));
      }

      // Named switches answer the same values, and nothing else.
      clearAllSwitchCaches();
      const keys = ['can_be_dispatcher', 'inventory_view', 'can_be_on_crew'];
      const named = await resolveSwitchesForPeople(subjects, keys);
      for (const s of subjects) {
        const whole = batch.get(s.id)!;
        expect(named.get(s.id), s.id).toEqual(Object.fromEntries(keys.map((k) => [k, whole[k]])));
      }
    });

    it('reads a role change on the next call once the cache window has passed, and at once for named switches', async () => {
      const { org } = await fx.newOrg();
      const { resolveSwitchesForPeople, setRoleSwitchValues, clearSwitchCacheForOrg } = await store();
      const role = await customRole(org, 'TECHNICIAN', { can_be_dispatcher: false });
      const person = await fx.addUser(org, `change${++sequence}`, 'TECHNICIAN', { customRoleId: role.role.id });
      const subject = await subjectOf(person.id);
      expect((await resolveSwitchesForPeople([subject])).get(person.id)!.can_be_dispatcher).toBe(false);

      await setRoleSwitchValues({ organizationId: org, roleKey: role.key, values: { can_be_dispatcher: true }, actorId: null, reason: 'manual' });
      // Named switches are always read fresh.
      expect((await resolveSwitchesForPeople([subject], ['can_be_dispatcher'])).get(person.id)!.can_be_dispatcher).toBe(true);
      // The whole set follows the cache's own rule: dropped on a change, so the next call shows it.
      clearSwitchCacheForOrg(org);
      expect((await resolveSwitchesForPeople([subject])).get(person.id)!.can_be_dispatcher).toBe(true);
    });

    it('never answers one company with another company\'s role rows', async () => {
      const a = await fx.newOrg();
      const b = await fx.newOrg();
      const { resolveSwitchesForPeople } = await store();
      // Two companies, the same role key, opposite values.
      const key = `shared-key-${++sequence}`;
      const make = async (org: string, value: boolean) => {
        const role = await fx.addCustomRole(org, key, 'TECHNICIAN', { copyGrants: false });
        await db.permissionRoleSwitch.create({ data: { organization_id: org, role_key: key, switch_key: 'can_be_dispatcher', value } });
        return fx.addUser(org, `iso${++sequence}`, 'TECHNICIAN', { customRoleId: role.id });
      };
      const inA = await make(a.org, true);
      const inB = await make(b.org, false);
      clearAllSwitchCaches();
      const answers = await resolveSwitchesForPeople([await subjectOf(inA.id), await subjectOf(inB.id)], ['can_be_dispatcher']);
      expect(answers.get(inA.id)!.can_be_dispatcher).toBe(true);
      expect(answers.get(inB.id)!.can_be_dispatcher).toBe(false);
    });
  });

  describe('a company of 200 people on 100 roles', () => {
    const PEOPLE = 200;
    const ROLES = 100;

    async function bigCompany() {
      const { org, admin } = await fx.newOrg();
      // Even-numbered roles let their people be dispatchers and hold the Field inventory view; odd ones do not.
      const roles = [];
      for (let i = 0; i < ROLES; i++) {
        roles.push(await customRole(org, 'TECHNICIAN', { can_be_dispatcher: i % 2 === 0, inventory_view: i % 2 === 0 ? 'field' : 'counter' }));
      }
      const people: { person: Person; dispatcher: boolean }[] = [];
      for (let i = 0; i < PEOPLE; i++) {
        const role = roles[i % ROLES]!;
        people.push({ person: await fx.addUser(org, `big${++sequence}`, 'TECHNICIAN', { customRoleId: role.role.id }), dispatcher: (i % ROLES) % 2 === 0 });
      }
      // Each person holds a full set of their own, the way giving a person a role copies it.
      const rows = await db.user.findMany({ where: { organization_id: org, role: 'TECHNICIAN' }, select: { id: true, custom_role: { select: { key: true } } } });
      const { resolveRoleSwitchValues } = await store();
      for (const user of rows) {
        const values = await resolveRoleSwitchValues(org, user.custom_role!.key, 'TECHNICIAN');
        await db.permissionUserSwitch.createMany({
          data: SWITCH_CATALOG.map((s) => ({ organization_id: org, user_id: user.id, switch_key: s.key, value: values[s.key]! })),
        });
      }
      clearAllSwitchCaches();
      return { org, admin, people };
    }

    it('lists exactly the people who can be a dispatcher, in a number of reads that does not grow with the people', async () => {
      const { admin, people } = await bigCompany();
      const api = await fx.signedInAs(admin);
      // The first request signs the requester in; the count is taken on the one after it.
      await api.get('/api/users/assignable?purpose=directory&eligible_for=dispatcher');
      const before = queries.count;
      const started = Date.now();
      const res = await api.get('/api/users/assignable?purpose=directory&eligible_for=dispatcher');
      const elapsed = Date.now() - started;
      const reads = queries.count - before;
      console.info(`[many-people] roster of ${PEOPLE + 1} people on ${ROLES} roles: ${reads} queries, ${elapsed} ms`);

      expect(res.status).toBe(200);
      const listed = new Set((res.body as { id: string }[]).map((u) => u.id));
      expect(listed.has(admin.id)).toBe(true);
      for (const { person, dispatcher } of people) expect(listed.has(person.id), person.email).toBe(dispatcher);
      expect(reads).toBeLessThan(40);
    }, 60_000);

    it('lists every person on the Inventory page, each with the view their switch gives, in a constant number of reads', async () => {
      const { admin, people } = await bigCompany();
      const api = await fx.signedInAs(admin);
      // Cold: nobody's switches are cached, which is how the page opens after a minute of quiet.
      clearAllSwitchCaches();
      const before = queries.count;
      const started = Date.now();
      const res = await api.get('/api/inventory/techs');
      const elapsed = Date.now() - started;
      const reads = queries.count - before;
      console.info(`[many-people] inventory techs of ${PEOPLE + 1} people on ${ROLES} roles: ${reads} queries, ${elapsed} ms`);

      expect(res.status).toBe(200);
      const viewOf = new Map((res.body.techs as { id: string; inventoryView: string }[]).map((t) => [t.id, t.inventoryView]));
      expect(viewOf.size).toBe(PEOPLE + 1);
      for (const { person, dispatcher } of people) expect(viewOf.get(person.id), person.email).toBe(dispatcher ? 'field' : 'counter');
      expect(reads).toBeLessThan(40);
    }, 60_000);
  });
});
