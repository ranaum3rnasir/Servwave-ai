/* =============================================================================
   Roles & Permissions, PRD 4, slice S04.18 - a creator's own lead: edit it with field limits.

   The lead update route lets in a person with Edit leads, or the person who made the lead while M3 says they
   are still on it. On the creator path the server refuses the address, the source, the walkthrough times and
   the status, and lets the rest through (service request, job type, extra info, tags already in the company
   list). The right ends on the next request after the person is taken off the lead. The lead detail response
   carries the per-record action list the lead page reads.

   Every person here holds a custom role copied from a preset (Technician for the creator, Sales for an Edit
   leads holder), so a role-name check cannot pass. Everything goes through the lead routes. Real migrated
   database (TEST_DATABASE_URL); the suite skips when it is unset. Every org it creates is removed again.
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
// ...and so is the numbering allocator (the setup's stub hands every lead the same number).
vi.unmock('../lib/numbering');

import { switchFixture, type Person } from './permission-switches-fixture';
import { SWITCH_CATALOG } from '../lib/permissions/switches/catalog';

const suite = realClient ? describe : describe.skip;

const NO_ADDRESS = "You can't change this lead's address.";
const NO_SOURCE = "You can't change this lead's source.";
const NO_TIMES = "You can't change this lead's walkthrough times.";
const NO_STATUS = "You can't change this lead's status.";

suite("a creator's own lead: edit with field limits (real database)", () => {
  const db = realClient as PrismaClient;
  const fx = switchFixture(db, async () => (await import('../app.js')).default as never);
  // Loading the whole app is slow on a loaded machine.
  beforeAll(async () => {
    await import('../app.js');
  }, 120_000);
  afterAll(() => fx.cleanup());

  type Api = Awaited<ReturnType<typeof fx.signedInAs>>;
  type Who = Person & { api: () => Promise<Api> };
  let sequence = 0;

  /** A person on a fresh custom role copied from a preset, nothing changed on it. */
  async function copyOf(org: string, base: Role): Promise<Who> {
    const role = await fx.addCustomRole(org, `creator-edit-role-${++sequence}`, base);
    const person = await fx.addUser(org, `p${sequence}`, base, { customRoleId: role.id });
    return Object.assign(person, { api: () => fx.signedInAs(person) });
  }

  /** The creator: the Technician preset's values, on a custom role. */
  const technician = (org: string) => copyOf(org, 'TECHNICIAN');

  const leadRow = (id: string) => db.lead.findUniqueOrThrow({ where: { id } });

  /** A lead the creator made through the new-lead route, so it carries whatever the pre-fill gives them. */
  async function createdBy(creator: Who, customer: string) {
    const res = await (await creator.api()).post('/api/leads', { customer_id: customer, service_request: 'Fix the door' });
    expect(res.status).toBe(201);
    return res.body.lead.id as string;
  }

  /** Take the person off a lead the way the office does: Owner, assignee rows, Dispatcher and walkthrough crew. */
  async function takeOff(leadId: string, person: string) {
    await db.leadAssignee.deleteMany({ where: { lead_id: leadId, user_id: person } });
    await db.lead.updateMany({ where: { id: leadId, commission_owner_id: person }, data: { commission_owner_id: null } });
    await db.lead.updateMany({ where: { id: leadId, dispatcher_id: person }, data: { dispatcher_id: null } });
    await db.visitAssignee.deleteMany({ where: { user_id: person, visit: { lead_id: leadId } } });
  }

  it('is a person who really holds the Technician preset values: Edit leads off, Create leads on', async () => {
    const { org } = await fx.newOrg();
    const creator = await technician(org);
    const { resolveSwitches } = await import('../lib/permissions/switches/store.js');
    const stored = await db.user.findUniqueOrThrow({ where: { id: creator.id }, include: { custom_role: true } });
    const values = await resolveSwitches({ id: creator.id, organization_id: org, role: stored.role, custom_role: stored.custom_role });
    const preset = (key: string) => SWITCH_CATALOG.find((s) => s.key === key)!.presets.TECHNICIAN;
    expect(values.edit_leads).toBe(preset('edit_leads'));
    expect(values.edit_leads).toBe(false);
    expect(values.create_leads).toBe(preset('create_leads'));
    expect(values.create_leads).toBe(true);
  });

  describe('the creator path', () => {
    it('lists the lead the creator just made on their next request, and lets them change what the path allows', async () => {
      const { org, customer } = await fx.newOrg();
      const creator = await technician(org);
      const id = await createdBy(creator, customer);
      const api = await creator.api();

      const list = await api.get('/api/leads?limit=100');
      expect(list.status).toBe(200);
      expect(list.body.leads.map((l: { id: string }) => l.id)).toContain(id);

      const res = await api.patch(`/api/leads/${id}`, {
        service_request: 'Fix the back door instead', job_type: 'Repair', notes: 'Gate code 1234',
      });
      expect(res.status).toBe(200);
      const stored = await leadRow(id);
      expect(stored.service_request).toBe('Fix the back door instead');
      expect(stored.job_type).toBe('Repair');
      expect(stored.notes).toBe('Gate code 1234');
    });

    it('refuses the address, in every form it can be sent, with the named message, and writes nothing', async () => {
      const { org, customer } = await fx.newOrg();
      const creator = await technician(org);
      const id = await createdBy(creator, customer);
      const before = await leadRow(id);
      const api = await creator.api();
      const bodies: object[] = [
        { service_address_line1: '9 Other Street' },
        { service_zip: '02139' },
        { service_location_id: '00000000-0000-4000-8000-000000000000' },
        { new_location: { address_line1: '9 Other Street', city: 'Boston', state: 'MA', zip: '02139' } },
      ];
      for (const body of bodies) {
        const res = await api.patch(`/api/leads/${id}`, { service_request: 'Changed anyway', ...body });
        expect(res.status, JSON.stringify(body)).toBe(403);
        expect(res.body.error).toBe(NO_ADDRESS);
      }
      const after = await leadRow(id);
      expect(after.service_request).toBe(before.service_request);
      expect(after.service_location_id).toBe(before.service_location_id);
      expect(after.service_address_line1).toBe(before.service_address_line1);
    });

    it('refuses the source, the walkthrough times and the status with the named messages', async () => {
      const { org, customer } = await fx.newOrg();
      const creator = await technician(org);
      const id = await createdBy(creator, customer);
      const api = await creator.api();
      const before = await leadRow(id);

      const source = await api.patch(`/api/leads/${id}`, { ad_source: 'Referral' });
      expect(source.status).toBe(403);
      expect(source.body.error).toBe(NO_SOURCE);
      expect((await db.customer.findUniqueOrThrow({ where: { id: customer } })).ad_source).toBeNull();

      for (const body of [
        { scheduled_start: '2030-01-01T15:00:00.000Z' },
        { scheduled_end: '2030-01-01T16:00:00.000Z' },
        { scheduled_start: null, scheduled_end: null },
      ]) {
        const times = await api.patch(`/api/leads/${id}`, body);
        expect(times.status, JSON.stringify(body)).toBe(403);
        expect(times.body.error).toBe(NO_TIMES);
      }
      const afterTimes = await leadRow(id);
      expect(afterTimes.scheduled_start).toEqual(before.scheduled_start);
      expect(afterTimes.scheduled_end).toEqual(before.scheduled_end);

      const status = await api.patch(`/api/leads/${id}`, { status: 'CONTACTED' });
      expect(status.status).toBe(403);
      expect(status.body.error).toBe(NO_STATUS);
      expect((await leadRow(id)).status).toBe(before.status);
    });

    it('lets a save that sends the lead\'s own status back through, since that changes nothing', async () => {
      const { org, customer } = await fx.newOrg();
      const creator = await technician(org);
      const id = await createdBy(creator, customer);
      const res = await (await creator.api()).patch(`/api/leads/${id}`, { status: (await leadRow(id)).status, service_request: 'Same status' });
      expect(res.status).toBe(200);
    });

    it('ends the right on the next request after the creator is taken off the lead', async () => {
      const { org, customer } = await fx.newOrg();
      const creator = await technician(org);
      const id = await createdBy(creator, customer);
      const api = await creator.api();
      expect((await api.patch(`/api/leads/${id}`, { service_request: 'Still on it' })).status).toBe(200);

      await takeOff(id, creator.id);
      const refused = await api.patch(`/api/leads/${id}`, { service_request: 'Taken off' });
      expect(refused.status).toBe(403);
      expect((await leadRow(id)).service_request).toBe('Still on it');
    });

    it('refuses a person who is on the lead but did not make it', async () => {
      const { org, customer, admin } = await fx.newOrg();
      const crew = await technician(org);
      const lead = await fx.addLead(org, customer, { createdBy: admin.id, owner: crew.id, assignees: [crew.id] });
      const res = await (await crew.api()).patch(`/api/leads/${lead.id}`, { service_request: 'Not mine' });
      expect(res.status).toBe(403);
      expect((await leadRow(lead.id)).service_request).toBe('Fix the door');
    });

    it('lets the creator add and remove a tag that is already in the company list, and refuses a taken-off creator', async () => {
      const { org, customer } = await fx.newOrg();
      const creator = await technician(org);
      const id = await createdBy(creator, customer);
      const tag = await db.tag.create({ data: { organization_id: org, name: `existing-${sequence}`, color: '#336699' } });
      const api = await creator.api();

      const added = await api.post(`/api/leads/${id}/tags`, { tag_id: tag.id });
      expect(added.status).toBe(201);
      expect(await db.tagAssignment.count({ where: { tag_id: tag.id, entity_type: 'LEAD', entity_id: id } })).toBe(1);
      const removed = await api.delete(`/api/leads/${id}/tags/${tag.id}`);
      expect(removed.status).toBe(204);
      expect(await db.tagAssignment.count({ where: { tag_id: tag.id, entity_type: 'LEAD', entity_id: id } })).toBe(0);

      await takeOff(id, creator.id);
      expect((await api.post(`/api/leads/${id}/tags`, { tag_id: tag.id })).status).toBe(403);
    });

    it('refuses a brand-new tag name without Create tags', async () => {
      const { org, customer } = await fx.newOrg();
      const creator = await technician(org);
      const id = await createdBy(creator, customer);
      const name = `brand-new-${sequence}`;

      const res = await (await creator.api()).post(`/api/leads/${id}/tags`, { name });
      expect(res.status).toBe(403);
      expect(await db.tag.count({ where: { organization_id: org, name } })).toBe(0);
      expect(await db.tagAssignment.count({ where: { entity_type: 'LEAD', entity_id: id } })).toBe(0);
    });

    it('lets a person with Create tags mint a new tag name onto the lead', async () => {
      const { org, customer } = await fx.newOrg();
      const holder = await copyOf(org, 'SALES');
      const id = await createdBy(holder, customer);
      const name = `minted-${sequence}`;

      const res = await (await holder.api()).post(`/api/leads/${id}/tags`, { name });
      expect(res.status).toBe(201);
      expect(await db.tag.count({ where: { organization_id: org, name } })).toBe(1);
    });
  });

  describe('with Edit leads', () => {
    it('accepts every field, on a lead the person made and on one they did not', async () => {
      const { org, customer, admin } = await fx.newOrg();
      const holder = await copyOf(org, 'SALES');
      const mine = await createdBy(holder, customer);
      const theirs = (await fx.addLead(org, customer, { createdBy: admin.id, owner: holder.id, assignees: [holder.id] })).id;
      const api = await holder.api();
      for (const id of [mine, theirs]) {
        const res = await api.patch(`/api/leads/${id}`, {
          service_request: `Edited ${id.slice(0, 4)}`,
          ad_source: 'Referral',
          scheduled_start: '2030-01-01T15:00:00.000Z',
          scheduled_end: '2030-01-01T16:00:00.000Z',
          service_address_line1: '9 Other Street',
          service_city: 'Boston',
          service_state: 'MA',
          service_zip: '02139',
        });
        expect(res.status, id).toBe(200);
        const stored = await leadRow(id);
        expect(stored.service_request).toBe(`Edited ${id.slice(0, 4)}`);
        expect(stored.scheduled_start?.toISOString()).toBe('2030-01-01T15:00:00.000Z');
      }
    });
  });

  describe('the lead detail action list', () => {
    it('offers the creator the plain edit and none of the limited fields', async () => {
      const { org, customer } = await fx.newOrg();
      const creator = await technician(org);
      const id = await createdBy(creator, customer);
      const res = await (await creator.api()).get(`/api/leads/${id}`);
      expect(res.status).toBe(200);
      expect(res.body.lead.actions).toEqual(['edit']);
    });

    it('offers an Edit leads holder every field, and the status only with Change lead status by hand', async () => {
      const { org, customer, admin } = await fx.newOrg();
      const holder = await copyOf(org, 'DISPATCHER');
      const lead = await fx.addLead(org, customer, { createdBy: admin.id, dispatcher: holder.id });
      const res = await (await holder.api()).get(`/api/leads/${lead.id}`);
      expect(res.status).toBe(200);
      // The Dispatcher preset holds Edit leads and Change lead status by hand: read from the catalog, not assumed.
      const preset = (key: string) => SWITCH_CATALOG.find((s) => s.key === key)!.presets.DISPATCHER;
      expect(preset('edit_leads')).toBe(true);
      expect(preset('change_lead_status_by_hand')).toBe(true);
      // Reopen lead (S05.19) comes from its own switch, which the Dispatcher preset also holds.
      expect(preset('reopen_leads')).toBe(true);
      expect(res.body.lead.actions).toEqual(['edit', 'edit_address', 'edit_source', 'edit_schedule', 'change_status', 'reopen']);
    });

    it('drops the status when Change lead status by hand is off', async () => {
      const { org, customer, admin } = await fx.newOrg();
      const holder = await copyOf(org, 'DISPATCHER');
      const { setRoleSwitchValues } = await import('../lib/permissions/switches/store.js');
      const user = await db.user.findUniqueOrThrow({ where: { id: holder.id }, include: { custom_role: true } });
      await setRoleSwitchValues({
        organizationId: org, roleKey: user.custom_role!.key, values: { leads_scope: 'all', edit_leads: true, change_lead_status_by_hand: false },
        actorId: null, reason: 'manual',
      });
      const lead = await fx.addLead(org, customer, { createdBy: admin.id, dispatcher: holder.id });
      const res = await (await holder.api()).get(`/api/leads/${lead.id}`);
      expect(res.status).toBe(200);
      expect(res.body.lead.actions).toEqual(['edit', 'edit_address', 'edit_source', 'edit_schedule', 'reopen']);
    });

    it('offers a person who can open the lead but neither edits nor made it nothing', async () => {
      const { org, customer, admin } = await fx.newOrg();
      const crew = await technician(org);
      const lead = await fx.addLead(org, customer, { createdBy: admin.id, owner: crew.id, assignees: [crew.id] });
      const res = await (await crew.api()).get(`/api/leads/${lead.id}`);
      expect(res.status).toBe(200);
      expect(res.body.lead.actions).toEqual([]);
    });
  });
});
