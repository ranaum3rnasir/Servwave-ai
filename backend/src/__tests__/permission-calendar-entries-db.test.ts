/* =============================================================================
   Roles & Permissions, PRD 4, slice S04.8 - calendar entries follow the participant rule.

   Listing, opening and searching calendar entries (meetings, blocks) need View events. On Events scope Attached a
   person gets only the entries that list them as a user participant (being the creator does not count); on Team the
   entries that list anyone in their department; on All every entry (P6).
   The rule holds on the entries list, the entry detail, the Schedule's own search and the customer page's
   schedule tab (the same list, narrowed to a customer).

   Everything goes through the public interface: the routes, called as people on custom roles built from switches
   (never a built-in role name) holding exactly the switch values under test. Real migrated database
   (TEST_DATABASE_URL); the suite skips when it is unset. Every org it creates is removed again.
   ========================================================================== */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { randomUUID } from 'crypto';
import type { PrismaClient, Role } from '@prisma/client';

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
import { SWITCH_CATALOG, presetSwitchSet } from '../lib/permissions/switches/catalog';
import { setRoleSwitchValues } from '../lib/permissions/switches/store';

const suite = realClient ? describe : describe.skip;

const BASES: Role[] = ['TECHNICIAN', 'SALES', 'DISPATCHER', 'ADMIN'];

suite('calendar entries follow the participant rule (real database)', () => {
  const db = realClient as PrismaClient;
  const fx = switchFixture(db, async () => (await import('../app.js')).default as never);
  // Loading the whole app is slow on a loaded machine.
  beforeAll(async () => {
    await import('../app.js');
  }, 120_000);

  const orgs: string[] = [];
  afterAll(async () => {
    const quietly = (p: Promise<unknown>) => p.catch(() => undefined);
    for (const org of orgs) await quietly(db.$executeRawUnsafe(`DELETE FROM calendar_entries WHERE organization_id = '${org}'`));
    await fx.cleanup();
  });

  type Api = Awaited<ReturnType<typeof fx.signedInAs>>;
  let sequence = 0;

  async function newOrg() {
    const made = await fx.newOrg();
    orgs.push(made.org);
    return made;
  }

  /** A person on a fresh custom role of this base holding the Dispatcher preset's values with these changed. */
  async function personWith(
    org: string,
    values: Record<string, boolean | string>,
    base: Role = 'DISPATCHER',
    departmentId?: string,
  ): Promise<Person & { api: () => Promise<Api> }> {
    const key = `cal-role-${++sequence}`;
    const role = await fx.addCustomRole(org, key, base);
    await setRoleSwitchValues({
      organizationId: org, roleKey: key, values: { ...presetSwitchSet('DISPATCHER'), ...values }, actorId: null, reason: 'manual',
    });
    const person = await fx.addUser(org, `c${sequence}`, base, { customRoleId: role.id, departmentId });
    return Object.assign(person, { api: () => fx.signedInAs(person) });
  }

  const word = () => `Quokka${++sequence}x${randomUUID().slice(0, 6)}`;

  /** A calendar entry; `users` are its user participants, `customers` its customer participants. */
  async function addEntry(
    org: string,
    createdBy: string,
    opts: { title?: string; users?: string[]; customers?: string[] } = {},
  ) {
    const id = randomUUID();
    const soon = Date.now() + 86_400_000;
    await db.calendarEntry.create({
      data: {
        id, organization_id: org, title: opts.title ?? word(), start: new Date(soon), end: new Date(soon + 3_600_000), created_by: createdBy,
        participants: {
          create: [
            ...(opts.users ?? []).map((user_id) => ({ organization_id: org, kind: 'USER' as const, user_id })),
            ...(opts.customers ?? []).map((customer_id) => ({ organization_id: org, kind: 'CUSTOMER' as const, customer_id })),
          ],
        },
      },
    });
    return id;
  }

  const idsOf = (rows: { id: string }[]) => rows.map((r) => r.id).sort();

  async function listed(api: Api, query = '') {
    const res = await api.get(`/api/calendar-entries${query}`);
    expect(res.status).toBe(200);
    return idsOf(res.body.calendar_entries);
  }

  async function searched(api: Api, q: string) {
    const res = await api.get(`/api/search?q=${encodeURIComponent(q)}&scope=schedule`);
    expect(res.status).toBe(200);
    return idsOf(res.body.results.calendarEntries);
  }

  /** Two entries sharing a title word: one the person is a participant of, one they created and are not part of. */
  async function mineAndCreated(org: string, me: Person, other: Person) {
    const title = word();
    const mine = await addEntry(org, other.id, { title: `${title} mine`, users: [me.id] });
    const createdNotIn = await addEntry(org, me.id, { title: `${title} created`, users: [other.id] });
    const theirs = await addEntry(org, other.id, { title: `${title} theirs`, users: [other.id] });
    return { title, mine, createdNotIn, theirs };
  }

  describe('on Events scope Attached', () => {
    it('lists, opens and searches only the entries that name the person as a participant, whatever the role is based on', async () => {
      const { org, admin } = await newOrg();
      for (const base of BASES) {
        const me = await personWith(org, { view_events: true, events_scope: 'attached' }, base);
        const e = await mineAndCreated(org, me, admin);
        const api = await me.api();

        expect(await listed(api), `${base} list`).toEqual([e.mine]);
        expect((await api.get(`/api/calendar-entries/${e.mine}`)).status, `${base} open mine`).toBe(200);
        expect(await searched(api, e.title), `${base} search`).toEqual([e.mine]);
        // Not shown, not openable: the same answer as an entry that does not exist.
        for (const hidden of [e.theirs, e.createdNotIn]) {
          expect((await api.get(`/api/calendar-entries/${hidden}`)).status, `${base} open hidden`).toBe(404);
        }
      }
    });

    it('does not count being the creator: the creator who is not a participant never sees the entry', async () => {
      const { org, admin } = await newOrg();
      const me = await personWith(org, { view_events: true, events_scope: 'attached' });
      const e = await mineAndCreated(org, me, admin);
      const api = await me.api();

      expect(await listed(api)).not.toContain(e.createdNotIn);
      expect(await searched(api, e.title)).not.toContain(e.createdNotIn);
      expect((await api.get(`/api/calendar-entries/${e.createdNotIn}`)).status).toBe(404);
    });

    it('does not count an entry that carries only a customer participant, or only someone else', async () => {
      const { org, admin, customer } = await newOrg();
      const me = await personWith(org, { view_events: true, events_scope: 'attached' });
      const title = word();
      const forCustomer = await addEntry(org, admin.id, { title: `${title} customer`, customers: [customer] });
      const nobody = await addEntry(org, admin.id, { title: `${title} nobody` });
      const api = await me.api();

      expect(await listed(api)).toEqual([]);
      expect(await searched(api, title)).toEqual([]);
      for (const id of [forCustomer, nobody]) expect((await api.get(`/api/calendar-entries/${id}`)).status).toBe(404);
    });

    it('narrows the customer page schedule tab the same way: the customer\'s entries, and only those the person takes part in', async () => {
      const { org, admin, customer } = await newOrg();
      const me = await personWith(org, { view_events: true, events_scope: 'attached' });
      const withMe = await addEntry(org, admin.id, { users: [me.id], customers: [customer] });
      await addEntry(org, admin.id, { users: [admin.id], customers: [customer] });
      await addEntry(org, admin.id, { users: [me.id] });
      const api = await me.api();

      expect(await listed(api, `?customer_id=${customer}`)).toEqual([withMe]);
    });

    it('narrows a date window the same way', async () => {
      const { org, admin } = await newOrg();
      const me = await personWith(org, { view_events: true, events_scope: 'attached' });
      const e = await mineAndCreated(org, me, admin);
      const api = await me.api();
      const after = new Date(Date.now()).toISOString();
      const before = new Date(Date.now() + 3 * 86_400_000).toISOString();

      expect(await listed(api, `?start_after=${after}&start_before=${before}`)).toEqual([e.mine]);
    });

    it('drops an entry on the very next request after the person is taken off it, and shows one they are added to', async () => {
      const { org, admin } = await newOrg();
      const me = await personWith(org, { view_events: true, events_scope: 'attached' });
      const entry = await addEntry(org, admin.id, { users: [me.id] });
      const other = await addEntry(org, admin.id, { users: [admin.id] });
      const api = await me.api();
      expect(await listed(api)).toEqual([entry]);

      await db.calendarEntryParticipant.deleteMany({ where: { calendar_entry_id: entry } });
      await db.calendarEntryParticipant.create({ data: { calendar_entry_id: other, organization_id: org, kind: 'USER', user_id: me.id } });

      expect(await listed(api)).toEqual([other]);
      expect((await api.get(`/api/calendar-entries/${entry}`)).status).toBe(404);
      expect((await api.get(`/api/calendar-entries/${other}`)).status).toBe(200);
    });

    it('keeps one company from reading another\'s entries', async () => {
      const here = await newOrg();
      const there = await newOrg();
      const me = await personWith(here.org, { view_events: true, events_scope: 'all' });
      const foreign = await addEntry(there.org, there.admin.id, { users: [there.admin.id] });
      const api = await me.api();

      expect(await listed(api)).not.toContain(foreign);
      expect((await api.get(`/api/calendar-entries/${foreign}`)).status).toBe(404);
    });
  });

  describe('on Events scope Team', () => {
    it('lists, opens and searches the entries anyone in the department takes part in, and no other department\'s, whatever the role is based on', async () => {
      const { org, admin } = await newOrg();
      const north = await fx.addDepartment(org, 'North');
      const south = await fx.addDepartment(org, 'South');
      const mate = await fx.addUser(org, 'mate', 'TECHNICIAN', { departmentId: north });
      const stranger = await fx.addUser(org, 'stranger', 'TECHNICIAN', { departmentId: south });
      for (const base of BASES) {
        const me = await personWith(org, { view_events: true, events_scope: 'team' }, base, north);
        const title = word();
        const withMate = await addEntry(org, admin.id, { title: `${title} mate`, users: [mate.id] });
        const withMe = await addEntry(org, admin.id, { title: `${title} me`, users: [me.id] });
        const withStranger = await addEntry(org, admin.id, { title: `${title} stranger`, users: [stranger.id] });
        const api = await me.api();

        expect(await searched(api, title), `${base} search`).toEqual([withMate, withMe].sort());
        expect((await api.get(`/api/calendar-entries/${withMate}`)).status, `${base} open a teammate's`).toBe(200);
        expect((await api.get(`/api/calendar-entries/${withStranger}`)).status, `${base} open another department's`).toBe(404);
        const listedIds = await listed(api);
        expect(listedIds, `${base} list`).toEqual(expect.arrayContaining([withMate, withMe]));
        expect(listedIds, `${base} list`).not.toContain(withStranger);
      }
    });

    it('reaches nothing for a person with no department (fail closed, P3)', async () => {
      const { org, admin } = await newOrg();
      const north = await fx.addDepartment(org, 'North');
      const mate = await fx.addUser(org, 'mate', 'TECHNICIAN', { departmentId: north });
      const me = await personWith(org, { view_events: true, events_scope: 'team' });
      const entry = await addEntry(org, admin.id, { users: [mate.id, me.id] });
      const api = await me.api();

      expect(await listed(api)).toEqual([]);
      expect((await api.get(`/api/calendar-entries/${entry}`)).status).toBe(404);
    });
  });

  describe('on Events scope All', () => {
    it('lists, opens and searches every entry in the company, whatever the role is based on', async () => {
      const { org, admin } = await newOrg();
      for (const base of BASES) {
        const me = await personWith(org, { view_events: true, events_scope: 'all' }, base);
        const e = await mineAndCreated(org, me, admin);
        const api = await me.api();

        expect((await listed(api)), `${base} list`).toEqual(expect.arrayContaining([e.mine, e.createdNotIn, e.theirs]));
        for (const id of [e.mine, e.createdNotIn, e.theirs]) {
          expect((await api.get(`/api/calendar-entries/${id}`)).status, `${base} open`).toBe(200);
        }
        expect(await searched(api, e.title), `${base} search`).toEqual([e.mine, e.createdNotIn, e.theirs].sort());
      }
    });

    it('shows every entry of a customer on the schedule tab', async () => {
      const { org, admin, customer } = await newOrg();
      const me = await personWith(org, { view_events: true, events_scope: 'all' });
      const a = await addEntry(org, admin.id, { users: [admin.id], customers: [customer] });
      const b = await addEntry(org, admin.id, { users: [me.id], customers: [customer] });
      await addEntry(org, admin.id, { users: [me.id] });
      const api = await me.api();

      expect(await listed(api, `?customer_id=${customer}`)).toEqual([a, b].sort());
    });
  });

  describe('without View events', () => {
    it('refuses the list and the detail, and finds nothing in the Schedule search, even for an entry the person takes part in', async () => {
      const { org, admin } = await newOrg();
      for (const base of BASES) {
        const me = await personWith(org, { view_events: false, create_events: false, edit_events: false, delete_events: false, events_scope: 'attached' }, base);
        const title = word();
        const entry = await addEntry(org, admin.id, { title, users: [me.id] });
        const api = await me.api();

        expect((await api.get('/api/calendar-entries')).status, `${base} list`).toBe(403);
        expect((await api.get(`/api/calendar-entries/${entry}`)).status, `${base} open`).toBe(403);
        const search = await api.get(`/api/search?q=${encodeURIComponent(title)}&scope=schedule`);
        expect(search.status, `${base} search`).toBe(200);
        expect(search.body.results.calendarEntries, `${base} search`).toEqual([]);
      }
    });
  });

  describe('Edit events and Delete events keep their own switches', () => {
    it('lets a person who edits and deletes events do so without the participant rule narrowing the switch itself', async () => {
      const { org, admin } = await newOrg();
      const me = await personWith(org, { view_events: true, edit_events: true, delete_events: true, events_scope: 'attached' });
      const api = await me.api();
      const entry = await addEntry(org, admin.id, { users: [me.id] });
      const toDelete = await addEntry(org, admin.id, { users: [me.id] });

      expect((await api.patch(`/api/calendar-entries/${entry}`, { title: 'Moved to the yard' })).status).toBe(200);
      expect((await api.delete(`/api/calendar-entries/${toDelete}`)).status).toBe(204);

      const without = await personWith(org, { view_events: true, create_events: false, edit_events: false, delete_events: false, events_scope: 'attached' }); // Create requires Edit (AL-04)
      const apiWithout = await without.api();
      const mine = await addEntry(org, admin.id, { users: [without.id] });
      expect((await apiWithout.patch(`/api/calendar-entries/${mine}`, { title: 'No' })).status).toBe(403);
      expect((await apiWithout.delete(`/api/calendar-entries/${mine}`)).status).toBe(403);
    });
  });

  describe('the switch catalog', () => {
    const entryOf = (key: string) => SWITCH_CATALOG.find((s) => s.key === key)!;

    it('names a server check for View events and leaves nothing pending; Events scope is a scope switch that narrows the same routes', () => {
      expect(entryOf('view_events').serverChecks.length).toBeGreaterThan(0);
      expect(entryOf('view_events').pending).toBeUndefined();
      expect(entryOf('events_scope')).toMatchObject({ kind: 'choice', choices: ['attached', 'team', 'all'], serverChecks: [] });
    });

    it('has a route-level row, one let in and one refused, for every server check of the two switches', async () => {
      const { org, admin } = await newOrg();
      const table: { switchKey: string; check: string; run: (api: Api, me: Person) => Promise<{ allowed: boolean }> }[] = [
        { switchKey: 'view_events', check: 'calendar-entry-list', run: async (api) => ({ allowed: (await api.get('/api/calendar-entries')).status === 200 }) },
        {
          switchKey: 'view_events', check: 'calendar-entry-detail',
          run: async (api, me) => ({ allowed: (await api.get(`/api/calendar-entries/${await addEntry(org, admin.id, { users: [me.id] })}`)).status === 200 }),
        },
        {
          switchKey: 'view_events', check: 'calendar-entry-search',
          run: async (api, me) => {
            const title = word();
            await addEntry(org, admin.id, { title, users: [me.id] });
            return { allowed: (await searched(api, title)).length === 1 };
          },
        },
        {
          switchKey: 'events_scope', check: 'calendar-entry-list-all',
          run: async (api) => {
            const stranger = await addEntry(org, admin.id, { users: [admin.id] });
            return { allowed: (await listed(api)).includes(stranger) };
          },
        },
        {
          switchKey: 'events_scope', check: 'calendar-entry-detail-all',
          run: async (api) => ({ allowed: (await api.get(`/api/calendar-entries/${await addEntry(org, admin.id, { users: [admin.id] })}`)).status === 200 }),
        },
        {
          switchKey: 'events_scope', check: 'calendar-entry-search-all',
          run: async (api) => {
            const title = word();
            await addEntry(org, admin.id, { title, users: [admin.id] });
            return { allowed: (await searched(api, title)).length === 1 };
          },
        },
      ];

      // Every check the catalog lists for View events has a row, and no row is for a check the catalog lacks; the rows of
      // Events scope (All) prove the narrowing on the same three routes.
      const listed2 = entryOf('view_events').serverChecks.map((c) => `view_events:${c}`);
      expect(table.filter((p) => p.switchKey === 'view_events').map((p) => `${p.switchKey}:${p.check}`).sort()).toEqual(listed2.sort());

      for (const probe of table) {
        const base = { view_events: true, events_scope: 'attached' };
        // View events on: let in. The scope rows keep View events on and flip only the scope.
        const onValues = probe.switchKey === 'view_events' ? base : { ...base, events_scope: 'all' };
        const offValues = probe.switchKey === 'view_events'
          ? { view_events: false, create_events: false, edit_events: false, delete_events: false, events_scope: 'attached' }
          : base;
        const on = await personWith(org, onValues);
        const off = await personWith(org, offValues);
        expect((await probe.run(await on.api(), on)).allowed, `${probe.check} with the switch on`).toBe(true);
        const refused = await probe.run(await off.api(), off).catch(() => ({ allowed: false }));
        expect(refused.allowed, `${probe.check} with the switch off`).toBe(false);
      }
    });
  });
});
