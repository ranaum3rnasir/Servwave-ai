/* =============================================================================
   Roles & Permissions, PRD 3, slice S03.5 - the Missing lead owner predicate, the Leads page's
   "No owner" card and filter option, and the Dispatcher filter.

   Missing lead owner: open leads (New, Contacted, Walkthrough Scheduled, Walkthrough Completed or
   Estimate Sent) with no Owner, whatever else is on them. The module is the one place that says so; the
   Leads list's card, its Owner filter's "No owner" option, its export and the stats route all read it, so
   they are checked here against the module and against each other, as a viewer and over the HTTP routes.

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

import { switchFixture, type Person } from './permission-switches-fixture';
import { setRoleSwitchValues } from '../lib/permissions/switches/store';
import { SWITCH_CATALOG } from '../lib/permissions/switches/catalog';
import type { PermissionUser } from '../lib/permissions/enforce';

const suite = realClient ? describe : describe.skip;

// The statuses the PRD names, written out: the module's own list must agree with them.
const COUNTED: LeadStatus[] = ['NEW', 'CONTACTED', 'WALKTHROUGH_SCHEDULED', 'WALKTHROUGH_COMPLETED', 'ESTIMATED'];
const NOT_COUNTED: LeadStatus[] = ['WON', 'LOST'];

suite('Missing lead owner, the No owner card and the Dispatcher filter (real database)', () => {
  const db = realClient as PrismaClient;
  const fx = switchFixture(db, async () => (await import('../app.js')).default as never);
  // Loading the whole app is slow on a loaded machine.
  beforeAll(async () => {
    await import('../app.js');
  }, 120_000);
  afterAll(() => fx.cleanup());

  type Api = Awaited<ReturnType<typeof fx.signedInAs>>;
  let sequence = 0;

  /** A person on a fresh custom role of this base holding exactly these switch values. */
  async function personWith(org: string, values: Record<string, boolean | string>, base: Role = 'DISPATCHER') {
    const key = `no-owner-role-${++sequence}`;
    const role = await fx.addCustomRole(org, key, base);
    await setRoleSwitchValues({
      organizationId: org, roleKey: key, values: { leads_scope: 'all', ...values }, actorId: null, reason: 'manual',
    });
    const person = await fx.addUser(org, `p${sequence}`, base, { customRoleId: role.id });
    return Object.assign(person, { api: () => fx.signedInAs(person) });
  }

  /** View leads off, together with every switch that needs it, directly or through another that does. */
  const viewLeadsOff = (): Record<string, boolean> => {
    const off: string[] = ['view_leads'];
    for (let i = 0; i < off.length; i += 1) {
      for (const sw of SWITCH_CATALOG) if (sw.kind === 'toggle' && sw.requires.includes(off[i]!) && !off.includes(sw.key)) off.push(sw.key);
    }
    return Object.fromEntries(off.map((key) => [key, false]));
  };

  /** The person as the request layer hands them to the permission code. */
  const asViewer = async (person: Person): Promise<PermissionUser> =>
    (await db.user.findUniqueOrThrow({
      where: { id: person.id },
      select: { id: true, role: true, organization_id: true, custom_role_id: true, custom_role: { select: { key: true } }, department_id: true, location_id: true },
    })) as PermissionUser;

  async function leadWithStatus(org: string, customer: string, status: LeadStatus, opts: Parameters<typeof fx.addLead>[2] = {}) {
    const lead = await fx.addLead(org, customer, opts);
    if (status !== 'NEW') await db.lead.update({ where: { id: lead.id }, data: { status } });
    return lead;
  }

  const idsOf = (body: { leads: Array<{ id: string }> }) => body.leads.map((l) => l.id).sort();
  const list = async (api: Api, query: string) => {
    const res = await api.get(`/api/leads?limit=100${query ? `&${query}` : ''}`);
    expect(res.status, query).toBe(200);
    return res;
  };

  describe('the predicate', () => {
    it('counts an open lead with no Owner whatever else is on it, and no closed one', async () => {
      const { findMissingLeadOwner, countMissingLeadOwner } = await import('../lib/missingLeadOwner.js');
      const { org, customer, admin } = await fx.newOrg();
      const dispatcher = await personWith(org, {});
      const viewer = await asViewer(admin);

      const counted: string[] = [];
      for (const status of COUNTED) counted.push((await leadWithStatus(org, customer, status)).id);
      // A Dispatcher and a walkthrough crew are not an Owner.
      counted.push((await leadWithStatus(org, customer, 'NEW', { dispatcher: dispatcher.id, walkthroughCrew: [dispatcher.id] })).id);
      for (const status of NOT_COUNTED) await leadWithStatus(org, customer, status);

      expect((await findMissingLeadOwner(viewer)).map((l) => l.id).sort()).toEqual(counted.sort());
      expect(await countMissingLeadOwner(viewer)).toBe(counted.length);
    });

    it('does not count a lead that has an Owner, however the Owner is stored', async () => {
      const { findMissingLeadOwner } = await import('../lib/missingLeadOwner.js');
      const { org, customer, admin } = await fx.newOrg();
      const owner = await personWith(org, {});
      const viewer = await asViewer(admin);

      await fx.addLead(org, customer, { owner: owner.id });
      await fx.addLead(org, customer, { assignees: [owner.id] });
      const ownerless = await fx.addLead(org, customer);

      expect((await findMissingLeadOwner(viewer)).map((l) => l.id)).toEqual([ownerless.id]);
    });

    it('counts a Won lead with no Owner once it is reopened, and leaves once an Owner is set', async () => {
      const { findMissingLeadOwner } = await import('../lib/missingLeadOwner.js');
      const { org, customer, admin } = await fx.newOrg();
      const owner = await personWith(org, {});
      const viewer = await asViewer(admin);

      const lead = await leadWithStatus(org, customer, 'WON');
      expect(await findMissingLeadOwner(viewer)).toEqual([]);
      await db.lead.update({ where: { id: lead.id }, data: { status: 'CONTACTED' } });
      expect((await findMissingLeadOwner(viewer)).map((l) => l.id)).toEqual([lead.id]);
      await db.lead.update({ where: { id: lead.id }, data: { commission_owner_id: owner.id } });
      expect(await findMissingLeadOwner(viewer)).toEqual([]);
    });

    it('counts only the leads the viewer can open', async () => {
      const { countMissingLeadOwner } = await import('../lib/missingLeadOwner.js');
      const { org, customer } = await fx.newOrg();
      const attachedViewer = await personWith(org, { leads_scope: 'attached' }, 'SALES');
      const noLeads = await personWith(org, viewLeadsOff(), 'SALES');

      // Ownerless leads: one the viewer is the Dispatcher of, one nobody is on.
      await fx.addLead(org, customer, { dispatcher: attachedViewer.id });
      await fx.addLead(org, customer);

      expect(await countMissingLeadOwner(await asViewer(attachedViewer))).toBe(1);
      expect(await countMissingLeadOwner(await asViewer(noLeads))).toBe(0);
    });
  });

  describe('the Leads page', () => {
    it('shows the same leads on the "No owner" card, the Owner filter option, the export and the stats route', async () => {
      const { findMissingLeadOwner } = await import('../lib/missingLeadOwner.js');
      const { org, customer, admin } = await fx.newOrg();
      const owner = await personWith(org, {});
      const api = await fx.signedInAs(admin);

      await leadWithStatus(org, customer, 'NEW');
      await leadWithStatus(org, customer, 'WALKTHROUGH_SCHEDULED', { dispatcher: owner.id });
      await leadWithStatus(org, customer, 'WALKTHROUGH_COMPLETED');
      await leadWithStatus(org, customer, 'WON');
      await leadWithStatus(org, customer, 'LOST');
      await leadWithStatus(org, customer, 'NEW', { owner: owner.id });
      const expected = (await findMissingLeadOwner(await asViewer(admin))).map((l) => l.id).sort();
      expect(expected).toHaveLength(3);

      const all = await list(api, '');
      expect(all.body.stats.no_owner).toBe(expected.length);
      expect(all.body.stats).not.toHaveProperty('unassigned');

      const filtered = await list(api, 'assigned_to=NO_OWNER');
      expect(idsOf(filtered.body)).toEqual(expected);

      const exported = await api.get('/api/leads/export?assigned_to=NO_OWNER');
      expect(exported.status).toBe(200);
      expect(idsOf(exported.body)).toEqual(expected);

      const stats = await api.get('/api/leads/stats');
      expect(stats.status).toBe(200);
      expect(stats.body.no_owner).toBe(expected.length);
      expect(stats.body).not.toHaveProperty('unassigned');
    });

    it('answers the same for a viewer with a narrower scope, card and filter alike', async () => {
      const { countMissingLeadOwner } = await import('../lib/missingLeadOwner.js');
      const { org, customer } = await fx.newOrg();
      const viewer = await personWith(org, { leads_scope: 'attached' }, 'SALES');
      const api = await viewer.api();

      const mine = await fx.addLead(org, customer, { dispatcher: viewer.id });
      await fx.addLead(org, customer); // not attached to the viewer
      await leadWithStatus(org, customer, 'WON', { dispatcher: viewer.id });

      const all = await list(api, '');
      expect(all.body.stats.no_owner).toBe(await countMissingLeadOwner(await asViewer(viewer)));
      expect(all.body.stats.no_owner).toBe(1);
      expect(idsOf((await list(api, 'assigned_to=NO_OWNER')).body)).toEqual([mine.id]);
    });

    it('takes "No owner" together with named owners, and a named owner alone', async () => {
      const { org, customer, admin } = await fx.newOrg();
      const owner = await personWith(org, {});
      const other = await personWith(org, {});
      const api = await fx.signedInAs(admin);
      const bare = await fx.addLead(org, customer);
      const mine = await fx.addLead(org, customer, { owner: owner.id, assignees: [owner.id] });
      await fx.addLead(org, customer, { owner: other.id, assignees: [other.id] });

      expect(idsOf((await list(api, `assigned_to=${owner.id}`)).body)).toEqual([mine.id]);
      expect(idsOf((await list(api, `assigned_to=NO_OWNER&assigned_to=${owner.id}`)).body)).toEqual([bare.id, mine.id].sort());
    });

    it('still takes the old wire value for a saved "No owner" filter', async () => {
      const { org, customer, admin } = await fx.newOrg();
      const api = await fx.signedInAs(admin);
      const lead = await fx.addLead(org, customer);

      expect(idsOf((await list(api, 'assigned_to=UNASSIGNED')).body)).toEqual([lead.id]);
    });

    it('does not let a No owner choice widen what a viewer who sees only their own leads can see', async () => {
      const { org, customer } = await fx.newOrg();
      const seller = await personWith(org, { leads_scope: 'attached' }, 'SALES');
      const api = await seller.api();
      await fx.addLead(org, customer); // ownerless, nobody on it
      const mine = await fx.addLead(org, customer, { owner: seller.id });

      expect(idsOf((await list(api, 'assigned_to=NO_OWNER')).body)).toEqual([]);
      expect(idsOf((await list(api, '')).body)).toEqual([mine.id]);
    });

    it('lists a lead with an Owner and no Dispatcher under "No dispatcher" and not under No owner', async () => {
      const { org, customer, admin } = await fx.newOrg();
      const owner = await personWith(org, {});
      const dispatcher = await personWith(org, {});
      const api = await fx.signedInAs(admin);

      const ownedNoDispatcher = await fx.addLead(org, customer, { owner: owner.id });
      const dispatched = await fx.addLead(org, customer, { owner: owner.id, dispatcher: dispatcher.id });
      const bare = await fx.addLead(org, customer);

      const noDispatcher = await list(api, 'dispatcher=NO_DISPATCHER');
      expect(idsOf(noDispatcher.body)).toEqual([ownedNoDispatcher.id, bare.id].sort());
      const noOwner = await list(api, 'assigned_to=NO_OWNER');
      expect(idsOf(noOwner.body)).toEqual([bare.id]);
      expect(noOwner.body.stats.no_owner).toBe(1);

      expect(idsOf((await list(api, `dispatcher=${dispatcher.id}`)).body)).toEqual([dispatched.id]);
      expect(idsOf((await list(api, `dispatcher=${dispatcher.id}&dispatcher=NO_DISPATCHER`)).body))
        .toEqual([ownedNoDispatcher.id, dispatched.id, bare.id].sort());
    });

    it('ignores a Dispatcher filter value that is not a person', async () => {
      const { org, customer, admin } = await fx.newOrg();
      const api = await fx.signedInAs(admin);
      const lead = await fx.addLead(org, customer);

      expect(idsOf((await list(api, 'dispatcher=not-a-person')).body)).toEqual([lead.id]);
    });

    it('keeps the Dispatcher filter inside the viewer\'s scope', async () => {
      const { org, customer } = await fx.newOrg();
      const seller = await personWith(org, { leads_scope: 'attached' }, 'SALES');
      const other = await personWith(org, {});
      const api = await seller.api();
      await fx.addLead(org, customer, { dispatcher: other.id });
      const mine = await fx.addLead(org, customer, { owner: seller.id });

      expect(idsOf((await list(api, 'dispatcher=NO_DISPATCHER')).body)).toEqual([mine.id]);
      expect(idsOf((await list(api, `dispatcher=${other.id}`)).body)).toEqual([]);
    });
  });
});
