/* =============================================================================
   Roles & Permissions, PRD 1, slice S01.7 - lead people and lead closing follow switches.

   Assign people to leads decides who may name the Owner of a lead (on create and on reassign); Change
   lead status by hand decides who may use a lead's status menu; the lead cancel endpoint is gone and
   cancelling a single walkthrough follows Book walkthroughs.

   Everything goes through the public interface: the lead routes, called as people on custom roles
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

// The suite-wide setup hands every record the same number; these cases create several leads in one company.
vi.mock('../lib/numbering', () => {
  let issued = 0;
  return {
    allocateNumber: vi.fn(async (_tx: unknown, entity: string) => `${entity[0]!.toUpperCase()}T${Date.now()}${++issued}`),
  };
});

import { switchFixture, type Person } from './permission-switches-fixture';
import { setRoleSwitchValues } from '../lib/permissions/switches/store';
import { SWITCH_CATALOG } from '../lib/permissions/switches/catalog';
import { DEFAULT_GRANTS } from '../lib/permissions/defaultGrants';
import { clearPermissionCache } from '../lib/permissions/permissionCache';

const suite = realClient ? describe : describe.skip;

suite('lead people and lead closing follow switches (real database)', () => {
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
  async function personWith(
    org: string,
    values: Record<string, boolean | string>,
    opts: { base?: Role; name?: string } = {},
  ): Promise<Person & { api: () => Promise<Api> }> {
    const key = `lead-people-role-${++sequence}`;
    const base = opts.base ?? 'DISPATCHER';
    // The role copies the legacy grants of its base the way creating a role does; the catalog, not
    // those stored grants, decides what the person may do with the lead people and status switches.
    const role = await fx.addCustomRole(org, key, base);
    await setRoleSwitchValues({
      organizationId: org, roleKey: key, values: { leads_scope: 'all', jobs_scope: 'all', ...values }, actorId: null, reason: 'manual',
    });
    const person = await fx.addUser(org, opts.name ?? `p${sequence}`, base, { customRoleId: role.id });
    return Object.assign(person, { api: () => fx.signedInAs(person) });
  }

  /** The stored grants a built-in role has in a real company (a new test company has none until they are written). */
  async function seedBuiltInRole(org: string, role: 'SALES' | 'DISPATCHER') {
    for (const g of DEFAULT_GRANTS.filter((x) => x.role === role)) {
    }
    clearPermissionCache(org);
  }

  /** The owner of a lead as stored: the commission owner and the one assignee row that mirrors it. */
  async function ownerOf(leadId: string) {
    const lead = await db.lead.findUniqueOrThrow({ where: { id: leadId }, select: { commission_owner_id: true, lead_assignees: { select: { user_id: true } } } });
    return { owner: lead.commission_owner_id, assignees: lead.lead_assignees.map((a) => a.user_id) };
  }

  describe('Assign people to leads', () => {
    it('refuses a reassign without the switch and lets it in with the switch, for a custom role', async () => {
      const { org, customer } = await fx.newOrg();
      const target = await fx.addUser(org, `target${++sequence}`, 'SALES');
      const without = await personWith(org, { assign_people_to_leads: false });
      const withIt = await personWith(org, { assign_people_to_leads: true });

      const refusedLead = await fx.addLead(org, customer);
      const refused = await (await without.api()).post(`/api/leads/${refusedLead.id}/assign`, { assigned_to: target.id });
      expect(refused.status).toBe(403);
      expect(await ownerOf(refusedLead.id)).toEqual({ owner: null, assignees: [] });

      const allowedLead = await fx.addLead(org, customer);
      const allowed = await (await withIt.api()).post(`/api/leads/${allowedLead.id}/assign`, { assigned_to: target.id });
      expect(allowed.status).toBe(200);
      expect(await ownerOf(allowedLead.id)).toEqual({ owner: target.id, assignees: [target.id] });
    });

    it('keeps the creator as the Owner on create whatever the request names, and lets a holder name someone else', async () => {
      const { org, customer } = await fx.newOrg();
      const named = await fx.addUser(org, `named${++sequence}`, 'TECHNICIAN');
      // A Dispatcher-based role without the switch is held to it exactly as a Sales-based one is: no role name decides.
      // What each lands as is the creator rule's (S03.15): the Sales base can own leads, the Dispatcher base can only dispatch.
      for (const base of ['DISPATCHER', 'SALES'] as const) {
        const creator = await personWith(org, { assign_people_to_leads: false }, { base });
        const res = await (await creator.api()).post('/api/leads', { customer_id: customer, service_request: 'Fix the door', assigned_to: named.id });
        expect(res.status, base).toBe(201);
        expect(await ownerOf(res.body.lead.id), base).toEqual(
          base === 'SALES' ? { owner: creator.id, assignees: [creator.id] } : { owner: null, assignees: [] },
        );
      }

      for (const base of ['DISPATCHER', 'SALES'] as const) {
        const holder = await personWith(org, { assign_people_to_leads: true }, { base });
        const res = await (await holder.api()).post('/api/leads', { customer_id: customer, service_request: 'Fix the door', assigned_to: named.id });
        expect(res.status, base).toBe(201);
        expect(await ownerOf(res.body.lead.id), base).toEqual({ owner: named.id, assignees: [named.id] });
      }
    });

    it('accepts a lead saved with nobody on it, on create and on clearing the Owner', async () => {
      const { org, customer } = await fx.newOrg();
      const holder = await personWith(org, { assign_people_to_leads: true });
      const api = await holder.api();

      const created = await api.post('/api/leads', { customer_id: customer, service_request: 'Fix the door' });
      expect(created.status).toBe(201);
      expect(await ownerOf(created.body.lead.id)).toEqual({ owner: null, assignees: [] });

      const owned = await fx.addLead(org, customer, { owner: holder.id, assignees: [holder.id] });
      const cleared = await api.post(`/api/leads/${owned.id}/assign`, { assigned_to: null });
      expect(cleared.status).toBe(200);
      expect(await ownerOf(owned.id)).toEqual({ owner: null, assignees: [] });
    });

    it('treats a built-in role without a stored set by its preset: Sales is kept as Owner, Dispatcher may name another, Admin may too', async () => {
      const { org, customer, admin } = await fx.newOrg();
      const named = await fx.addUser(org, `named${++sequence}`, 'TECHNICIAN');
      await seedBuiltInRole(org, 'SALES');
      await seedBuiltInRole(org, 'DISPATCHER');
      const sales = await fx.addUser(org, `sales${++sequence}`, 'SALES');
      const dispatcher = await fx.addUser(org, `disp${++sequence}`, 'DISPATCHER');
      const body = { customer_id: customer, service_request: 'Fix the door', assigned_to: named.id };

      const bySales = await (await fx.signedInAs(sales)).post('/api/leads', body);
      expect(bySales.status).toBe(201);
      expect((await ownerOf(bySales.body.lead.id)).owner).toBe(sales.id);

      const byDispatcher = await (await fx.signedInAs(dispatcher)).post('/api/leads', body);
      expect((await ownerOf(byDispatcher.body.lead.id)).owner).toBe(named.id);

      const byAdmin = await (await fx.signedInAs(admin)).post('/api/leads', body);
      expect((await ownerOf(byAdmin.body.lead.id)).owner).toBe(named.id);
    });
  });

  describe('Change lead status by hand', () => {
    it('refuses a status change without the switch and lets it in with the switch, for a custom role', async () => {
      const { org, customer } = await fx.newOrg();
      const without = await personWith(org, { change_lead_status_by_hand: false });
      const withIt = await personWith(org, { change_lead_status_by_hand: true });

      const refusedLead = await fx.addLead(org, customer);
      const refused = await (await without.api()).patch(`/api/leads/${refusedLead.id}`, { status: 'CONTACTED' });
      expect(refused.status).toBe(403);
      expect((await db.lead.findUniqueOrThrow({ where: { id: refusedLead.id } })).status).toBe('NEW');

      const allowedLead = await fx.addLead(org, customer);
      const allowed = await (await withIt.api()).patch(`/api/leads/${allowedLead.id}`, { status: 'CONTACTED' });
      expect(allowed.status).toBe(200);
      expect((await db.lead.findUniqueOrThrow({ where: { id: allowedLead.id } })).status).toBe('CONTACTED');
    });

    it('leaves every other edit alone without the switch, including a save that echoes the status unchanged', async () => {
      const { org, customer } = await fx.newOrg();
      const without = await personWith(org, { change_lead_status_by_hand: false });
      const lead = await fx.addLead(org, customer);
      const res = await (await without.api()).patch(`/api/leads/${lead.id}`, { service_request: 'Fix the other door', status: 'NEW' });
      expect(res.status).toBe(200);
      const stored = await db.lead.findUniqueOrThrow({ where: { id: lead.id } });
      expect(stored.service_request).toBe('Fix the other door');
      expect(stored.status).toBe('NEW');
    });

    it('still refuses a status the lead\'s data contradicts, with the menu\'s own reason, for a holder', async () => {
      const { org, customer } = await fx.newOrg();
      const holder = await personWith(org, { change_lead_status_by_hand: true });
      const api = await holder.api();
      const lead = await fx.addLead(org, customer);

      const detail = await api.get(`/api/leads/${lead.id}`);
      const locked = (detail.body.lead.status_options as { status: string; available: boolean; reason: string | null }[])
        .find((o) => o.status === 'WALKTHROUGH_SCHEDULED')!;
      expect(locked.available).toBe(false);

      const res = await api.patch(`/api/leads/${lead.id}`, { status: 'WALKTHROUGH_SCHEDULED' });
      expect(res.status).toBe(409);
      expect(res.body.error).toBe(locked.reason);
      expect((await db.lead.findUniqueOrThrow({ where: { id: lead.id } })).status).toBe('NEW');
    });

    it('still moves the lead when a walkthrough is booked and finished, for a custom role with the switch off', async () => {
      const { org, customer } = await fx.newOrg();
      const crew = await personWith(org, {
        change_lead_status_by_hand: false, book_walkthroughs: true, perform_walkthroughs: true, can_be_on_crew: true,
      });
      const api = await crew.api();

      const toBook = await fx.addLead(org, customer);
      const booked = await api.post(`/api/leads/${toBook.id}/walkthrough/schedule`, {
        walkthrough_scheduled_at: new Date(Date.now() + 2 * 86_400_000).toISOString(),
        performer_ids: [crew.id],
        send_email: false,
      });
      expect(booked.status).toBe(200);
      expect((await db.lead.findUniqueOrThrow({ where: { id: toBook.id } })).status).toBe('WALKTHROUGH_SCHEDULED');

      const toFinish = await fx.addLead(org, customer, { walkthroughCrew: [crew.id] });
      await db.lead.update({ where: { id: toFinish.id }, data: { status: 'WALKTHROUGH_SCHEDULED' } });
      const finished = await api.post(`/api/leads/${toFinish.id}/walkthrough/complete`, {});
      expect(finished.status).toBe(200);
      expect((await db.lead.findUniqueOrThrow({ where: { id: toFinish.id } })).status).toBe('WALKTHROUGH_COMPLETED');
    });

    it('treats a built-in role without a stored set by its preset: Sales is refused, Dispatcher is let in', async () => {
      const { org, customer } = await fx.newOrg();
      await seedBuiltInRole(org, 'SALES');
      await seedBuiltInRole(org, 'DISPATCHER');
      const sales = await fx.addUser(org, `sales${++sequence}`, 'SALES');
      const dispatcher = await fx.addUser(org, `disp${++sequence}`, 'DISPATCHER');
      // Sales reaches only the leads it is on.
      const own = await fx.addLead(org, customer, { owner: sales.id, assignees: [sales.id] });
      const refused = await (await fx.signedInAs(sales)).patch(`/api/leads/${own.id}`, { status: 'CONTACTED' });
      expect(refused.status).toBe(403);
      const other = await fx.addLead(org, customer);
      const allowed = await (await fx.signedInAs(dispatcher)).patch(`/api/leads/${other.id}`, { status: 'CONTACTED' });
      expect(allowed.status).toBe(200);
    });
  });

  describe('Cancel leads is retired', () => {
    it('answers not found to the lead cancel endpoint for every person, a custom role with every switch on included', async () => {
      const { org, customer, admin } = await fx.newOrg();
      const everything = Object.fromEntries(
        SWITCH_CATALOG.filter((s) => s.kind === 'toggle').map((s) => [s.key, true] as const),
      );
      const all = await personWith(org, everything);
      const lead = await fx.addLead(org, customer);
      for (const who of [await fx.signedInAs(admin), await all.api()]) {
        const res = await who.post(`/api/leads/${lead.id}/cancel`, { cancelled_reason: 'Not needed' });
        expect(res.status).toBe(404);
      }
      expect((await db.lead.findUniqueOrThrow({ where: { id: lead.id } })).status).toBe('NEW');
    });

    it('lets a walkthrough cancel in with Book walkthroughs and refuses it without, for a custom role', async () => {
      const { org, customer } = await fx.newOrg();
      // The role keeps its base's stored lead-cancel grant; only Book walkthroughs may decide.
      const without = await personWith(org, { book_walkthroughs: false });
      const withIt = await personWith(org, { book_walkthroughs: true });

      const refusedLead = await fx.addLead(org, customer, { walkthroughCrew: [] });
      const refused = await (await without.api()).post(`/api/leads/${refusedLead.id}/walkthrough/cancel`, { cancelled_reason: 'Customer moved' });
      expect(refused.status).toBe(403);

      const allowedLead = await fx.addLead(org, customer, { walkthroughCrew: [] });
      const allowed = await (await withIt.api()).post(`/api/leads/${allowedLead.id}/walkthrough/cancel`, { cancelled_reason: 'Customer moved' });
      expect(allowed.status).toBe(200);
    });
  });
});
