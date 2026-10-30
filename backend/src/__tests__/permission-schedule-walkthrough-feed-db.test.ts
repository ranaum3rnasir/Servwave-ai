/* =============================================================================
   Roles & Permissions, PRD 4, slice S04.10 - the Schedule's walkthrough feed under Leads scope Attached.

   Under Leads scope Attached the feed the Schedule board reads (the leads list asked for a walkthrough window)
   returns the walkthroughs the person is crewed on, plus the walkthroughs on leads they own or are assigned to
   only when they hold Book walkthroughs. Being only the lead's Dispatcher never adds a walkthrough. Team,
   Location and All are unchanged. A walkthrough with performers and no time ("To be scheduled") has no slot on
   the board and is in the unscheduled walkthroughs bucket with its crew.

   Everything goes through the public interface: the routes, called as people on custom roles built from switches
   (never a built-in role name) holding exactly the switch values under test. Real migrated database
   (TEST_DATABASE_URL); the suite skips when it is unset. Every org it creates is removed again.
   ========================================================================== */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
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
import { presetSwitchSet } from '../lib/permissions/switches/catalog';
import { setRoleSwitchValues } from '../lib/permissions/switches/store';

const suite = realClient ? describe : describe.skip;

const BASES: Role[] = ['TECHNICIAN', 'SALES', 'DISPATCHER'];

suite('the Schedule walkthrough feed under Leads scope Attached (real database)', () => {
  const db = realClient as PrismaClient;
  const fx = switchFixture(db, async () => (await import('../app.js')).default as never);
  // Loading the whole app is slow on a loaded machine.
  beforeAll(async () => {
    await import('../app.js');
  }, 120_000);
  afterAll(() => fx.cleanup());

  type Api = Awaited<ReturnType<typeof fx.signedInAs>>;
  let sequence = 0;

  /** A person on a fresh custom role of this base holding the Dispatcher preset's values with these changed. */
  async function personWith(
    org: string,
    values: Record<string, boolean | string>,
    base: Role = 'DISPATCHER',
    preset: Role = 'DISPATCHER',
  ): Promise<Person & { api: () => Promise<Api> }> {
    const key = `wt-feed-role-${++sequence}`;
    const role = await fx.addCustomRole(org, key, base);
    await setRoleSwitchValues({
      organizationId: org, roleKey: key, values: { ...presetSwitchSet(preset), view_leads: true, ...values }, actorId: null, reason: 'manual',
    });
    const person = await fx.addUser(org, `w${sequence}`, base, { customRoleId: role.id });
    return Object.assign(person, { api: () => fx.signedInAs(person) });
  }

  /** The window the board asks for: full instants around the walkthroughs the fixture books (a day ahead). */
  const boardWindow = () => {
    const after = new Date(Date.now() - 86_400_000).toISOString();
    const before = new Date(Date.now() + 10 * 86_400_000).toISOString();
    return `walkthrough_after=${encodeURIComponent(after)}&walkthrough_before=${encodeURIComponent(before)}`;
  };

  /** The board's feed: each lead in it, with the ids of the walkthrough visits it carries. */
  async function feed(api: Api) {
    const res = await api.get(`/api/leads?${boardWindow()}&limit=500`);
    expect(res.status).toBe(200);
    return new Map<string, string[]>(
      res.body.leads.map((l: { id: string; walkthrough_visits: { id: string }[] }) => [l.id, l.walkthrough_visits.map((v) => v.id).sort()]),
    );
  }

  /** The unscheduled walkthroughs bucket's feed. */
  async function bucket(api: Api) {
    const res = await api.get('/api/leads?walkthrough_status=needs_scheduling&limit=100');
    expect(res.status).toBe(200);
    return res.body.leads as Array<{
      id: string; walkthrough_scheduled_at: string | null; walkthrough_to_be_scheduled: boolean;
      walkthrough_performers: Array<{ user: { id: string } }>;
    }>;
  }

  /** A lead with one timed walkthrough (tomorrow) crewed by `crew`. */
  async function leadWithWalkthrough(org: string, customer: string, crew: string[], opts: { owner?: string; assignees?: string[]; dispatcher?: string } = {}) {
    const lead = await fx.addLead(org, customer, { walkthroughCrew: crew, ...opts });
    return { id: lead.id, visit: lead.walkthroughId! };
  }

  describe('Leads scope Attached', () => {
    it('shows a walkthrough the person is crewed on, whatever the role is based on and whether or not they hold Book walkthroughs', async () => {
      const { org, customer, admin } = await fx.newOrg();
      for (const base of BASES) {
        for (const book of [false, true]) {
          const me = await personWith(org, { leads_scope: 'attached', book_walkthroughs: book }, base);
          const lead = await leadWithWalkthrough(org, customer, [me.id, admin.id]);
          const seen = await feed(await me.api());
          expect(seen.get(lead.id), `${base} book=${book}`).toEqual([lead.visit]);
        }
      }
    });

    it('leaves out a walkthrough on a lead the person owns or is assigned to when someone else is crewed and Book walkthroughs is off', async () => {
      const { org, customer, admin } = await fx.newOrg();
      for (const base of BASES) {
        const me = await personWith(org, { leads_scope: 'attached', book_walkthroughs: false }, base);
        const owned = await leadWithWalkthrough(org, customer, [admin.id], { owner: me.id });
        const assigned = await leadWithWalkthrough(org, customer, [admin.id], { assignees: [me.id] });
        const api = await me.api();
        const seen = await feed(api);
        expect(seen.has(owned.id), `${base} owned lead on the board`).toBe(false);
        expect(seen.has(assigned.id), `${base} assigned lead on the board`).toBe(false);
        // The lead itself is still theirs: the Leads list and the lead page open it.
        expect((await api.get(`/api/leads/${owned.id}`)).status, `${base} lead page`).toBe(200);
      }
    });

    it('shows the same walkthroughs, whoever is crewed, once Book walkthroughs is on', async () => {
      const { org, customer, admin } = await fx.newOrg();
      for (const base of BASES) {
        const me = await personWith(org, { leads_scope: 'attached', book_walkthroughs: true }, base);
        const owned = await leadWithWalkthrough(org, customer, [admin.id], { owner: me.id });
        const assigned = await leadWithWalkthrough(org, customer, [admin.id], { assignees: [me.id] });
        const seen = await feed(await me.api());
        expect(seen.get(owned.id), `${base} owned`).toEqual([owned.visit]);
        expect(seen.get(assigned.id), `${base} assigned`).toEqual([assigned.visit]);
      }
    });

    it('never adds a walkthrough because the person is only the lead\'s Dispatcher, with or without Book walkthroughs', async () => {
      const { org, customer, admin } = await fx.newOrg();
      for (const base of BASES) {
        for (const book of [false, true]) {
          const me = await personWith(org, { leads_scope: 'attached', book_walkthroughs: book }, base);
          const lead = await leadWithWalkthrough(org, customer, [admin.id], { dispatcher: me.id });
          const api = await me.api();
          expect((await feed(api)).has(lead.id), `${base} book=${book}`).toBe(false);
          expect((await api.get(`/api/leads/${lead.id}`)).status, `${base} book=${book} lead page`).toBe(200);
        }
      }
    });

    it('keeps only the person\'s own walkthrough on a lead with two, when Book walkthroughs is off', async () => {
      const { org, customer, admin } = await fx.newOrg();
      const me = await personWith(org, { leads_scope: 'attached', book_walkthroughs: false });
      const lead = await leadWithWalkthrough(org, customer, [me.id], { owner: me.id });
      const other = await fx.addVisit(org, { leadId: lead.id, purpose: 'WALKTHROUGH', crew: [admin.id], daysFromNow: 2, seq: 2 });
      const seen = await feed(await me.api());
      expect(seen.get(lead.id)).toEqual([lead.visit]);
      expect(seen.get(lead.id)).not.toContain(other);
    });

    it('does not mix two walkthroughs: the person\'s own one outside the window and another crew\'s inside it is not on the board', async () => {
      const { org, customer, admin } = await fx.newOrg();
      const me = await personWith(org, { leads_scope: 'attached', book_walkthroughs: false });
      const lead = await leadWithWalkthrough(org, customer, [admin.id], { assignees: [me.id] });
      await fx.addVisit(org, { leadId: lead.id, purpose: 'WALKTHROUGH', crew: [me.id], daysFromNow: 60, seq: 2 });
      expect((await feed(await me.api())).has(lead.id)).toBe(false);
    });

    it('takes a walkthrough off the board on the next request once the person is taken off its crew', async () => {
      const { org, customer, admin } = await fx.newOrg();
      const me = await personWith(org, { leads_scope: 'attached', book_walkthroughs: false });
      const lead = await leadWithWalkthrough(org, customer, [me.id, admin.id]);
      const api = await me.api();
      expect((await feed(api)).get(lead.id)).toEqual([lead.visit]);
      await fx.removeCrew(lead.visit, me.id);
      expect((await feed(api)).has(lead.id)).toBe(false);
    });

    it('lets a person on the Sales preset\'s values keep the walkthroughs on leads they own or are assigned to', async () => {
      const { org, customer, admin } = await fx.newOrg();
      const me = await personWith(org, {}, 'SALES', 'SALES');
      const owned = await leadWithWalkthrough(org, customer, [admin.id], { owner: me.id });
      const assigned = await leadWithWalkthrough(org, customer, [admin.id], { assignees: [me.id] });
      const stranger = await leadWithWalkthrough(org, customer, [admin.id]);
      const seen = await feed(await me.api());
      expect(seen.get(owned.id)).toEqual([owned.visit]);
      expect(seen.get(assigned.id)).toEqual([assigned.visit]);
      expect(seen.has(stranger.id)).toBe(false);
    });
  });

  describe('every other scope and any other request is unchanged', () => {
    it('shows the walkthroughs of other people under All, Team and Location, whatever Book walkthroughs says', async () => {
      const { org, customer, admin } = await fx.newOrg();
      const department = await fx.addDepartment(org, 'Field');
      const location = await fx.addLocation(org, 'Yard');
      const teammate = await fx.addUser(org, 'team', 'TECHNICIAN', { departmentId: department, locationId: location });
      const lead = await leadWithWalkthrough(org, customer, [teammate.id, admin.id]);

      for (const scope of ['all', 'team']) {
        const me = await personWith(org, { leads_scope: scope, book_walkthroughs: false });
        await db.user.update({ where: { id: me.id }, data: { department_id: department, location_id: location } });
        expect((await feed(await me.api())).get(lead.id), scope).toEqual([lead.visit]);
      }
    });

    it('does not narrow the Leads list: a lead with a colleague\'s walkthrough is listed with the walkthrough_visits the page always had', async () => {
      const { org, customer, admin } = await fx.newOrg();
      const me = await personWith(org, { leads_scope: 'attached', book_walkthroughs: false });
      const lead = await leadWithWalkthrough(org, customer, [admin.id], { owner: me.id });
      const res = await (await me.api()).get('/api/leads?limit=50');
      expect(res.status).toBe(200);
      const listed = res.body.leads.find((l: { id: string }) => l.id === lead.id);
      expect(listed.walkthrough_visits.map((v: { id: string }) => v.id)).toEqual([lead.visit]);
    });
  });

  describe('"To be scheduled" walkthroughs', () => {
    /** A lead with a walkthrough visit that has people on it and no time. */
    async function untimedWalkthrough(org: string, customer: string, crew: string[], opts: { owner?: string; assignees?: string[] } = {}) {
      const lead = await fx.addLead(org, customer, opts);
      const visit = await fx.addVisit(org, { leadId: lead.id, purpose: 'WALKTHROUGH', crew, daysFromNow: 1 });
      await db.visit.update({ where: { id: visit }, data: { scheduled_at: null, scheduled_end: null } });
      return { id: lead.id, visit };
    }

    it('has no slot on the board, even to the person crewed on it', async () => {
      const { org, customer, admin } = await fx.newOrg();
      const me = await personWith(org, { leads_scope: 'attached', book_walkthroughs: true });
      const lead = await untimedWalkthrough(org, customer, [me.id, admin.id], { owner: me.id });
      expect((await feed(await me.api())).has(lead.id)).toBe(false);
    });

    it('is in the unscheduled walkthroughs bucket with its crew, for a person with Book walkthroughs who owns the lead', async () => {
      const { org, customer, admin } = await fx.newOrg();
      const me = await personWith(org, { leads_scope: 'attached', book_walkthroughs: true });
      const lead = await untimedWalkthrough(org, customer, [admin.id], { owner: me.id });
      const row = (await bucket(await me.api())).find((l) => l.id === lead.id);
      expect(row, 'in the bucket').toBeTruthy();
      expect(row!.walkthrough_scheduled_at).toBeNull();
      expect(row!.walkthrough_to_be_scheduled).toBe(true);
      expect(row!.walkthrough_performers.map((p) => p.user.id)).toEqual([admin.id]);
    });

    it('is in the bucket for a performer who is crewed on it', async () => {
      const { org, customer, admin } = await fx.newOrg();
      const me = await personWith(org, { leads_scope: 'attached', book_walkthroughs: false });
      const lead = await untimedWalkthrough(org, customer, [me.id, admin.id]);
      const row = (await bucket(await me.api())).find((l) => l.id === lead.id);
      expect(row!.walkthrough_performers.map((p) => p.user.id).sort()).toEqual([me.id, admin.id].sort());
    });

    it('does not take a lead with a timed walkthrough out of the board, nor put it in the bucket', async () => {
      const { org, customer, admin } = await fx.newOrg();
      const me = await personWith(org, { leads_scope: 'attached', book_walkthroughs: true });
      const timed = await leadWithWalkthrough(org, customer, [me.id, admin.id]);
      const api = await me.api();
      expect((await feed(api)).get(timed.id)).toEqual([timed.visit]);
      expect((await bucket(api)).some((l) => l.id === timed.id)).toBe(false);
    });

    it('still lists a lead with no walkthrough at all in the bucket', async () => {
      const { org, customer } = await fx.newOrg();
      const me = await personWith(org, { leads_scope: 'attached', book_walkthroughs: true });
      const lead = await fx.addLead(org, customer, { owner: me.id });
      expect((await bucket(await me.api())).some((l) => l.id === lead.id)).toBe(true);
    });
  });
});
