/* =============================================================================
   Roles & Permissions, P7 - a creator's own lead: having made it opens nothing.

   The lead update route lets in a person with Edit leads, for the leads in their scope, and nobody else. A person
   who made a lead and has Edit leads off is refused on every edit, tags included; one who holds Edit leads
   edits every field, and loses the right on the next request after they are taken off the lead. The lead detail
   response carries the per-record action list the lead page reads.

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
import { setRoleSwitchValues } from '../lib/permissions/switches/store';

const suite = realClient ? describe : describe.skip;


suite("a creator's own lead: edit with field limits (real database)", () => {
  const db = realClient as PrismaClient;
  const fx = switchFixture(db, async () => (await import('../app.js')).default as never);
  // Loading the whole app is slow on a loaded machine.
  beforeAll(async () => {
    await import('../app.js');
  }, 120_000);
  afterAll(() => fx.cleanup());

  type Api = Awaited<ReturnType<typeof fx.signedInAs>>;
  type Who = Person & { api: () => Promise<Api>; lose?: () => Promise<void> };
  let sequence = 0;

  /** A person on a fresh custom role copied from a preset, nothing changed on it. */
  async function copyOf(org: string, base: Role): Promise<Who> {
    const role = await fx.addCustomRole(org, `creator-edit-role-${++sequence}`, base);
    const person = await fx.addUser(org, `p${sequence}`, base, { customRoleId: role.id });
    return Object.assign(person, { api: () => fx.signedInAs(person), roleKey: role.key });
  }

  /**
   * The creator: the Technician preset's values on a custom role, once `lose` has run. The preset holds Edit leads now (Create
   * leads requires it, AL-04), so the creator path is about a creator who does NOT hold Edit leads: `lose` takes Edit leads away,
   * and Create leads with it (Create requires Edit). `createdBy` calls it AFTER the lead is made, the way a creator's Edit can
   * be taken away after they made a lead; a case that makes no lead through the route calls it itself.
   */
  async function technician(org: string): Promise<Who> {
    const who = (await copyOf(org, 'TECHNICIAN')) as Who & { roleKey: string };
    who.lose = async () => {
      await setRoleSwitchValues({ organizationId: org, roleKey: who.roleKey, values: { edit_leads: false, create_leads: false }, actorId: null, reason: 'manual' });
    };
    return who;
  }

  const leadRow = (id: string) => db.lead.findUniqueOrThrow({ where: { id } });

  /** A lead the creator made through the new-lead route, so it carries whatever the pre-fill gives them. */
  async function createdBy(creator: Who, customer: string) {
    const res = await (await creator.api()).post('/api/leads', { customer_id: customer, service_request: 'Fix the door' });
    expect(res.status).toBe(201);
    await creator.lose?.();
    return res.body.lead.id as string;
  }

  /** Take the person off a lead the way the office does: Owner, assignee rows, Dispatcher and walkthrough crew. */
  async function takeOff(leadId: string, person: string) {
    await db.leadAssignee.deleteMany({ where: { lead_id: leadId, user_id: person } });
    await db.lead.updateMany({ where: { id: leadId, commission_owner_id: person }, data: { commission_owner_id: null } });
    await db.lead.updateMany({ where: { id: leadId, dispatcher_id: person }, data: { dispatcher_id: null } });
    await db.visitAssignee.deleteMany({ where: { user_id: person, visit: { lead_id: leadId } } });
  }

  it('is a person who really holds the Technician preset values, with Edit leads and Create leads taken off (the preset holds both now)', async () => {
    const { org } = await fx.newOrg();
    const creator = await technician(org);
    await creator.lose!();
    const { resolveSwitches } = await import('../lib/permissions/switches/store.js');
    const stored = await db.user.findUniqueOrThrow({ where: { id: creator.id }, include: { custom_role: true } });
    const values = await resolveSwitches({ is_admin: stored.is_admin, id: creator.id, organization_id: org, role: stored.role, custom_role: stored.custom_role });
    const preset = (key: string) => SWITCH_CATALOG.find((s) => s.key === key)!.presets.TECHNICIAN;
    // AL-04: the Technician preset has Edit leads on, and Create leads (which requires it) on; this person has had both taken off.
    expect(preset('edit_leads')).toBe(true);
    expect(preset('create_leads')).toBe(true);
    expect(values.edit_leads).toBe(false);
    expect(values.create_leads).toBe(false);
    // Everything else is the preset's.
    expect(values.view_leads).toBe(SWITCH_CATALOG.find((s) => s.key === 'view_leads')!.presets.TECHNICIAN);
    expect(values.add_notes).toBe(SWITCH_CATALOG.find((s) => s.key === 'add_notes')!.presets.TECHNICIAN);
  });

  describe('having made the lead opens nothing (P7)', () => {
    it('lists the lead the creator just made, and refuses every edit once they hold no Edit leads, however long they stay on the lead', async () => {
      const { org, customer } = await fx.newOrg();
      const creator = await technician(org);
      const id = await createdBy(creator, customer);
      const api = await creator.api();

      const list = await api.get('/api/leads?limit=100');
      expect(list.status).toBe(200);
      expect(list.body.leads.map((l: { id: string }) => l.id)).toContain(id);

      const before = await leadRow(id);
      const refused = await api.patch(`/api/leads/${id}`, { service_request: 'Fix the back door instead', job_type: 'Repair', notes: 'Gate code 1234' });
      expect(refused.status).toBe(403);
      expect(refused.body.error).toBe('Insufficient permissions');
      const stored = await leadRow(id);
      expect(stored.service_request).toBe(before.service_request);
      expect(stored.job_type).toBe(before.job_type);
      expect(stored.notes).toBe(before.notes);
    });

    it('refuses the creator without Edit leads a tag on the lead and a change to its address', async () => {
      const { org, customer } = await fx.newOrg();
      const creator = await technician(org);
      const id = await createdBy(creator, customer);
      const api = await creator.api();
      const tag = await db.tag.create({ data: { organization_id: org, name: `creator-tag-${++sequence}`, color: '#336699' } });

      expect((await api.post(`/api/leads/${id}/tags`, { tag_id: tag.id })).status).toBe(403);
      expect((await api.patch(`/api/leads/${id}`, { service_address_line1: '1 Elm St' })).status).toBe(403);
    });

    it('lets the creator who holds Edit leads change every field of a lead they are on, address included, and nothing once taken off it', async () => {
      const { org, customer } = await fx.newOrg();
      const creator = await technician(org);
      const res = await (await creator.api()).post('/api/leads', { customer_id: customer, service_request: 'Fix the door' });
      expect(res.status).toBe(201);
      const id = res.body.lead.id as string;
      const api = await creator.api();

      const edited = await api.patch(`/api/leads/${id}`, { service_request: 'Fix the back door instead', service_address_line1: '1 Elm St' });
      expect(edited.status).toBe(200);
      expect((await leadRow(id)).service_request).toBe('Fix the back door instead');

      await takeOff(id, creator.id);
      expect((await (await creator.api()).patch(`/api/leads/${id}`, { service_request: 'Again' })).status).toBe(404);
    });
  });

  describe('the lead detail action list', () => {
    it('offers the creator without Edit leads no edit at all', async () => {
      const { org, customer } = await fx.newOrg();
      const creator = await technician(org);
      const id = await createdBy(creator, customer);
      const res = await (await creator.api()).get(`/api/leads/${id}`);
      expect(res.status).toBe(200);
      expect(res.body.lead.actions).not.toContain('edit');
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
      expect(res.body.lead.actions).toEqual(['edit', 'edit_address', 'edit_source', 'edit_schedule', 'change_status', 'add_note', 'reopen']);
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
      expect(res.body.lead.actions).toEqual(['edit', 'edit_address', 'edit_source', 'edit_schedule', 'add_note', 'reopen']);
    });

    it('offers a person who can open the lead but does not edit it only Add note (they hold Add notes)', async () => {
      const { org, customer, admin } = await fx.newOrg();
      const crew = await technician(org);
      await crew.lose!();
      const lead = await fx.addLead(org, customer, { createdBy: admin.id, owner: crew.id, assignees: [crew.id] });
      const res = await (await crew.api()).get(`/api/leads/${lead.id}`);
      expect(res.status).toBe(200);
      // The Technician preset holds Add notes, which `lose` leaves alone: the lead is in reach, so the Notes tab offers a note.
      expect(SWITCH_CATALOG.find((s) => s.key === 'add_notes')!.presets.TECHNICIAN).toBe(true);
      expect(res.body.lead.actions).toEqual(['add_note']);
    });
  });
});
