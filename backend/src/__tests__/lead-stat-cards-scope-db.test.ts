/* =============================================================================
   Roles & Permissions, PRD 4, slice S04.3 - the Leads page's tiles follow each Leads scope.

   Total, Won, Lost, New This Week and the "No owner" card show for every scope, and each counts only the
   leads the person can open. Every tile is checked against the rows the list itself returns for the same
   question (the tile's own click, or the Owner filter's "No owner" choice), and against a hand-written
   expectation for the scope, so a tile and its list cannot drift apart and a scope cannot widen a count.

   Real migrated database (TEST_DATABASE_URL); the suite skips when it is unset. Every org it creates is
   removed again.
   ========================================================================== */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import type { LeadStatus, PrismaClient, Role } from '@prisma/client';

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

import { switchFixture } from './permission-switches-fixture';
import { setRoleSwitchValues } from '../lib/permissions/switches/store';

const suite = realClient ? describe : describe.skip;

type Scope = 'all' | 'team' | 'attached';

const DAY = 86_400_000;

suite('Leads page tiles under each Leads scope (real database)', () => {
  const db = realClient as PrismaClient;
  const fx = switchFixture(db, async () => (await import('../app.js')).default as never);
  // Loading the whole app is slow on a loaded machine.
  beforeAll(async () => {
    await import('../app.js');
  }, 120_000);
  afterAll(() => fx.cleanup());

  let sequence = 0;

  /** A person on a fresh custom role of this base holding exactly these switch values. */
  async function personWith(
    org: string,
    values: Record<string, boolean | string>,
    opts: { base?: Role; locationId?: string; departmentId?: string } = {},
  ) {
    const base = opts.base ?? 'DISPATCHER';
    const key = `tile-role-${++sequence}`;
    const role = await fx.addCustomRole(org, key, base);
    await setRoleSwitchValues({
      organizationId: org, roleKey: key, values: { leads_scope: 'all', ...values }, actorId: null, reason: 'manual',
    });
    return fx.addUser(org, `t${sequence}`, base, { customRoleId: role.id, locationId: opts.locationId, departmentId: opts.departmentId });
  }

  async function lead(
    org: string,
    customer: string,
    status: LeadStatus,
    people: Parameters<typeof fx.addLead>[2] = {},
    stamps: { lostAt?: Date; createdAt?: Date } = {},
  ) {
    const row = await fx.addLead(org, customer, people);
    await db.lead.update({
      where: { id: row.id },
      data: { status, ...(stamps.lostAt ? { lost_at: stamps.lostAt } : {}), ...(stamps.createdAt ? { created_at: stamps.createdAt } : {}) },
    });
    return row.id;
  }

  /**
   * One org, one viewer on the given scope, and a spread of leads: some on the viewer, some on a colleague at
   * the viewer's team and location, some on a person elsewhere, some on nobody. Returns the ids by name.
   */
  async function world(scope: Scope) {
    const { org, customer } = await fx.newOrg();
    const here = await fx.addLocation(org, 'here');
    const there = await fx.addLocation(org, 'there');
    const myTeam = await fx.addDepartment(org, 'mine');
    const otherTeam = await fx.addDepartment(org, 'theirs');
    const viewer = await personWith(org, { leads_scope: scope }, { locationId: here, departmentId: myTeam });
    const mate = await personWith(org, {}, { locationId: here, departmentId: myTeam });
    const stranger = await personWith(org, {}, { locationId: there, departmentId: otherTeam });

    const now = new Date();
    const thisMonth = new Date(now.getTime() - 60_000);
    const lastMonth = new Date(now.getTime() - 40 * DAY);

    const ids: Record<string, string> = {
      // Open, no Owner, on the viewer (Dispatcher).
      mineNew: await lead(org, customer, 'NEW', { dispatcher: viewer.id }),
      // Open, no Owner, on a colleague at the viewer's team and location.
      mateWalkthroughScheduled: await lead(org, customer, 'WALKTHROUGH_SCHEDULED', { dispatcher: mate.id }),
      mateWalkthroughCompleted: await lead(org, customer, 'WALKTHROUGH_COMPLETED', { walkthroughCrew: [mate.id] }),
      // Open, no Owner, on someone elsewhere, and on nobody.
      strangerNew: await lead(org, customer, 'NEW', { dispatcher: stranger.id }),
      nobodyNew: await lead(org, customer, 'CONTACTED'),
      // Open with an Owner.
      strangerOwned: await lead(org, customer, 'NEW', { owner: stranger.id, assignees: [stranger.id] }),
      mateOwned: await lead(org, customer, 'ESTIMATED', { owner: mate.id, assignees: [mate.id] }),
      // Closed, no Owner, on the viewer and on a colleague.
      mineWon: await lead(org, customer, 'WON', { dispatcher: viewer.id }),
      mateLost: await lead(org, customer, 'LOST', { dispatcher: mate.id }, { lostAt: thisMonth }),
      // Lost last month, reachable on every scope but Attached.
      mateLostLastMonth: await lead(org, customer, 'LOST', { dispatcher: mate.id }, { lostAt: lastMonth }),
      // Closed on someone elsewhere: only the widest scope reaches them, so no other tile may count them.
      strangerWon: await lead(org, customer, 'WON', { dispatcher: stranger.id }),
      strangerLost: await lead(org, customer, 'LOST', { dispatcher: stranger.id }, { lostAt: thisMonth }),
      // Created before this week.
      mineOld: await lead(org, customer, 'NEW', { dispatcher: viewer.id }, { createdAt: new Date(now.getTime() - 21 * DAY) }),
    };
    return { org, ids, api: await fx.signedInAs(viewer) };
  }

  /** What each scope reaches, written out from the PRD: Attached is the viewer's own, Team adds colleagues. */
  const REACH: Record<Scope, string[]> = {
    attached: ['mineNew', 'mineWon', 'mineOld'],
    team: ['mineNew', 'mateWalkthroughScheduled', 'mateWalkthroughCompleted', 'mateOwned', 'mineWon', 'mateLost', 'mateLostLastMonth', 'mineOld'],
    all: [
      'mineNew', 'mateWalkthroughScheduled', 'mateWalkthroughCompleted', 'strangerNew', 'nobodyNew', 'strangerOwned', 'mateOwned',
      'mineWon', 'mateLost', 'mateLostLastMonth', 'strangerWon', 'strangerLost', 'mineOld',
    ],
  };
  /** Of those, the open ones with no Owner: the No owner card's leads. */
  const NO_OWNER: Record<Scope, string[]> = {
    attached: ['mineNew', 'mineOld'],
    team: ['mineNew', 'mateWalkthroughScheduled', 'mateWalkthroughCompleted', 'mineOld'],
    all: ['mineNew', 'mateWalkthroughScheduled', 'mateWalkthroughCompleted', 'strangerNew', 'nobodyNew', 'mineOld'],
  };

  for (const scope of ['all', 'team', 'attached'] as const) {
    describe(`Leads scope ${scope}`, () => {
      type Api = Awaited<ReturnType<typeof fx.signedInAs>>;
      const idsOf = (body: { leads: Array<{ id: string }> }) => body.leads.map((l) => l.id).sort();
      const list = async (api: Api, query: string) => {
        const res = await api.get(`/api/leads?limit=100${query ? `&${query}` : ''}`);
        expect(res.status, query).toBe(200);
        return res;
      };
      const named = (ids: Record<string, string>, names: string[]) => names.map((n) => ids[n]!).sort();

      it('lists only the leads the person can open', async () => {
        const { ids, api } = await world(scope);
        expect(idsOf((await list(api, '')).body)).toEqual(named(ids, REACH[scope]));
      });

      it('counts on the No owner card only the open leads with no Owner in that scope, and the card and the filter return them', async () => {
        const { ids, api } = await world(scope);
        const expected = named(ids, NO_OWNER[scope]);

        const all = await list(api, '');
        expect(all.body.stats.no_owner).toBe(expected.length);
        const filtered = await list(api, 'assigned_to=NO_OWNER');
        expect(idsOf(filtered.body)).toEqual(expected);
        expect(filtered.body.pagination.total).toBe(all.body.stats.no_owner);
        // The same card, asked for with the filter and a status in the way, never reaches a closed lead.
        const stats = await api.get('/api/leads/stats');
        expect(stats.body.no_owner).toBe(expected.length);
      });

      it('shows Total, Won, Lost and New This Week, each matching the rows its click returns', async () => {
        const { ids, api } = await world(scope);
        const reach = new Set(REACH[scope]);
        const reached = (...names: string[]) => names.filter((n) => reach.has(n));
        const weekStart = new Date();
        weekStart.setDate(weekStart.getDate() - weekStart.getDay());
        weekStart.setHours(0, 0, 0, 0);

        const res = await list(api, '');
        const { stats } = res.body;
        expect(stats.total).toBe(REACH[scope].length);
        expect(stats.won).toBe(reached('mineWon', 'strangerWon').length);
        expect(stats.lost).toBe(reached('mateLost', 'mateLostLastMonth', 'strangerLost').length);
        expect(stats.new_this_week).toBe(REACH[scope].filter((n) => n !== 'mineOld').length);

        expect(idsOf((await list(api, '')).body)).toHaveLength(stats.total);
        expect(idsOf((await list(api, 'status=WON')).body)).toEqual(named(ids, reached('mineWon', 'strangerWon')));
        expect(idsOf((await list(api, 'status=LOST')).body)).toEqual(named(ids, reached('mateLost', 'mateLostLastMonth', 'strangerLost')));
        expect((await list(api, `created_after=${encodeURIComponent(weekStart.toISOString())}`)).body.pagination.total).toBe(stats.new_this_week);
      });

      it('counts a lead in Walkthrough Scheduled or Completed as open: in the card, never in Won or Lost', async () => {
        const { ids, api } = await world(scope);
        const reach = new Set(REACH[scope]);
        const stats = (await list(api, '')).body.stats;
        const walkthroughs = ['mateWalkthroughScheduled', 'mateWalkthroughCompleted'].filter((n) => reach.has(n));
        const inCard = idsOf((await list(api, 'assigned_to=NO_OWNER')).body);
        for (const n of walkthroughs) expect(inCard).toContain(ids[n]);
        const closed = [...idsOf((await list(api, 'status=WON')).body), ...idsOf((await list(api, 'status=LOST')).body)];
        for (const n of walkthroughs) expect(closed).not.toContain(ids[n]);
        expect(stats.won + stats.lost).toBe(
          ['mineWon', 'strangerWon', 'mateLost', 'mateLostLastMonth', 'strangerLost'].filter((n) => reach.has(n)).length,
        );
      });

      it('counts Lost leads by their lost date in "Lost this month", all of them in the Lost tile', async () => {
        const { api } = await world(scope);
        const reach = new Set(REACH[scope]);
        const stats = await api.get('/api/leads/stats');
        expect(stats.status).toBe(200);
        // Only the lead lost this month counts for the month; the one lost 40 days ago does not.
        expect(stats.body.lost_this_month).toBe(['mateLost', 'strangerLost'].filter((n) => reach.has(n)).length);
        expect((await list(api, '')).body.stats.lost).toBe(
          ['mateLost', 'mateLostLastMonth', 'strangerLost'].filter((n) => reach.has(n)).length,
        );
      });
    });
  }
});
