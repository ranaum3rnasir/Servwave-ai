/* =============================================================================
   Roles & Permissions, PRD 4, slice S04.19 - walkthrough steps follow the crew of the walkthrough acted on.

   On any lead the person can open, noting and finishing a walkthrough needs Perform walkthroughs AND either a
   place on THAT walkthrough's crew or Update any visit's status. The finish and notes routes are lead-level and
   carry no walkthrough id, so the check is made against the walkthrough the route is about to change: the
   earliest still-coming one for finish, the current one for notes. Being crewed on another walkthrough of the same
   lead does not count. Booking, moving, unbooking, re-crewing and cancelling a walkthrough ride Book walkthroughs
   alone; no switch named Cancel leads grants them. The lead detail response carries the per-record action list the
   lead page reads, and the routes ask the very same function.

   Every person here holds a custom role copied from a preset (never a built-in role name) with exactly the switch
   values under test. Everything goes through the lead routes. Real migrated database (TEST_DATABASE_URL); the suite
   skips when it is unset. Every org it creates is removed again.
   ========================================================================== */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import type { PrismaClient, Role } from '@prisma/client';
import { randomUUID } from 'crypto';

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
// ...and so is the numbering allocator (the setup's stub hands every record the same number).
vi.unmock('../lib/numbering');

import { switchFixture, type Person } from './permission-switches-fixture';
import { setRoleSwitchValues } from '../lib/permissions/switches/store';

const suite = realClient ? describe : describe.skip;

suite('walkthrough steps follow the crew of the walkthrough acted on (real database)', () => {
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

  /** A person on a fresh custom role holding exactly these switch values, with Leads scope Attached. */
  async function personWith(org: string, values: Record<string, boolean | string>, base: Role = 'TECHNICIAN'): Promise<Who> {
    const key = `walkthrough-steps-role-${++sequence}`;
    const role = await fx.addCustomRole(org, key, base);
    await setRoleSwitchValues({
      organizationId: org, roleKey: key, values: { leads_scope: 'attached', view_leads: true, ...values }, actorId: null, reason: 'manual',
    });
    const person = await fx.addUser(org, `p${sequence}`, base, { customRoleId: role.id });
    return Object.assign(person, { api: () => fx.signedInAs(person) });
  }

  const performs = { perform_walkthroughs: true, update_any_visit_status: false };
  const colleague = (org: string) => fx.addUser(org, `crew${++sequence}`, 'TECHNICIAN');
  const leadRow = (id: string) => db.lead.findUniqueOrThrow({ where: { id } });
  const visitRow = (id: string) => db.visit.findUniqueOrThrow({ where: { id } });

  /** A lead sitting at Walkthrough Scheduled, as booking a walkthrough leaves it. */
  async function scheduledLead(org: string, customer: string, opts: Parameters<typeof fx.addLead>[2]) {
    const lead = await fx.addLead(org, customer, opts);
    await db.lead.update({ where: { id: lead.id }, data: { status: 'WALKTHROUGH_SCHEDULED' } });
    return lead;
  }

  /** The walkthrough steps the lead detail response offers this person. */
  async function offered(api: Api, leadId: string): Promise<string[]> {
    const res = await api.get(`/api/leads/${leadId}`);
    expect(res.status).toBe(200);
    return (res.body.lead.actions as string[]).filter((a) => a.startsWith('walkthrough_'));
  }

  describe('finishing a walkthrough', () => {
    it('refuses an Owner who is not on the walkthrough crew and lets the crew member in', async () => {
      const { org, customer } = await fx.newOrg();
      const owner = await personWith(org, performs);
      const crew = await personWith(org, performs);
      const lead = await scheduledLead(org, customer, { owner: owner.id, walkthroughCrew: [crew.id] });

      const refused = await (await owner.api()).post(`/api/leads/${lead.id}/walkthrough/complete`);
      expect(refused.status).toBe(403);
      expect((await visitRow(lead.walkthroughId!)).status).toBe('SCHEDULED');
      expect((await leadRow(lead.id)).status).toBe('WALKTHROUGH_SCHEDULED');

      const allowed = await (await crew.api()).post(`/api/leads/${lead.id}/walkthrough/complete`);
      expect(allowed.status).toBe(200);
      expect((await visitRow(lead.walkthroughId!)).status).toBe('COMPLETED');
    });

    it("lets a person without a place on the crew in with Update any visit's status, and never without Perform walkthroughs", async () => {
      const { org, customer } = await fx.newOrg();
      const crew = await colleague(org);
      const lead = await scheduledLead(org, customer, { walkthroughCrew: [crew.id] });
      const dispatcher = await personWith(org, { ...performs, update_any_visit_status: true, leads_scope: 'all' });
      const noPerform = await personWith(org, { perform_walkthroughs: false, update_any_visit_status: true, leads_scope: 'all' });

      expect((await (await noPerform.api()).post(`/api/leads/${lead.id}/walkthrough/complete`)).status).toBe(403);
      expect((await visitRow(lead.walkthroughId!)).status).toBe('SCHEDULED');
      expect((await (await dispatcher.api()).post(`/api/leads/${lead.id}/walkthrough/complete`)).status).toBe(200);
      expect((await visitRow(lead.walkthroughId!)).status).toBe('COMPLETED');
    });

    it('makes the check against the scheduled walkthrough, not any walkthrough the person is crewed on', async () => {
      const { org, customer } = await fx.newOrg();
      const me = await personWith(org, performs);
      const other = await colleague(org);
      const lead = await scheduledLead(org, customer, { assignees: [me.id] });
      // An earlier walkthrough that is finished, and one more that is booked with no time yet: me on both.
      await fx.addVisit(org, { leadId: lead.id, purpose: 'WALKTHROUGH', crew: [me.id], daysFromNow: -3, seq: 1 });
      const untimed = randomUUID();
      await db.visit.create({
        data: { id: untimed, organization_id: org, lead_id: lead.id, purpose: 'WALKTHROUGH', visit_seq: 2, status: 'SCHEDULED' },
      });
      await db.visitAssignee.create({ data: { visit_id: untimed, user_id: me.id, organization_id: org } });
      // The scheduled one is a colleague's.
      const scheduled = await fx.addVisit(org, { leadId: lead.id, purpose: 'WALKTHROUGH', crew: [other.id], daysFromNow: 2, seq: 3 });

      const api = await me.api();
      expect((await api.post(`/api/leads/${lead.id}/walkthrough/complete`)).status).toBe(403);
      expect((await visitRow(scheduled)).status).toBe('SCHEDULED');
      expect((await visitRow(untimed)).status).toBe('SCHEDULED');

      // Crewed on the scheduled one as well: let in.
      await db.visitAssignee.create({ data: { visit_id: scheduled, user_id: me.id, organization_id: org } });
      expect((await api.post(`/api/leads/${lead.id}/walkthrough/complete`)).status).toBe(200);
      expect((await visitRow(scheduled)).status).toBe('COMPLETED');
    });

    it('moves the lead to Walkthrough Completed for a crew member with Change lead status by hand off', async () => {
      const { org, customer } = await fx.newOrg();
      const me = await personWith(org, { ...performs, change_lead_status_by_hand: false });
      const lead = await scheduledLead(org, customer, { walkthroughCrew: [me.id] });
      const api = await me.api();

      // The hand status change really is refused for this person.
      expect((await api.patch(`/api/leads/${lead.id}`, { status: 'CONTACTED' })).status).toBe(403);

      expect((await api.post(`/api/leads/${lead.id}/walkthrough/complete`)).status).toBe(200);
      expect((await leadRow(lead.id)).status).toBe('WALKTHROUGH_COMPLETED');
    });
  });

  describe('noting a walkthrough', () => {
    const notesOf = (api: Api, leadId: string, text: string) => api.post(`/api/leads/${leadId}/walkthrough`, { walkthrough_notes: text });

    it('refuses an Owner who is not on the crew and writes nothing; the crew member is let in', async () => {
      const { org, customer } = await fx.newOrg();
      const owner = await personWith(org, performs);
      const crew = await personWith(org, performs);
      const lead = await scheduledLead(org, customer, { owner: owner.id, walkthroughCrew: [crew.id] });

      expect((await notesOf(await owner.api(), lead.id, 'Not mine')).status).toBe(403);
      expect((await visitRow(lead.walkthroughId!)).notes).toBeNull();

      expect((await notesOf(await crew.api(), lead.id, 'Measured the frame')).status).toBe(200);
      expect((await visitRow(lead.walkthroughId!)).notes).toBe('Measured the frame');
    });

    it("targets the current walkthrough: crewed only on a finished or untimed one, notes are refused; crewed on the current one, let in", async () => {
      const { org, customer } = await fx.newOrg();
      const me = await personWith(org, performs);
      const other = await colleague(org);
      const lead = await scheduledLead(org, customer, { assignees: [me.id] });
      await fx.addVisit(org, { leadId: lead.id, purpose: 'WALKTHROUGH', crew: [me.id], daysFromNow: -3, seq: 1 });
      const current = await fx.addVisit(org, { leadId: lead.id, purpose: 'WALKTHROUGH', crew: [other.id], daysFromNow: 2, seq: 2 });

      const api = await me.api();
      expect((await notesOf(api, lead.id, 'Sneaking in')).status).toBe(403);
      expect((await visitRow(current)).notes).toBeNull();

      await db.visitAssignee.create({ data: { visit_id: current, user_id: me.id, organization_id: org } });
      expect((await notesOf(api, lead.id, 'Now on the crew')).status).toBe(200);
      expect((await visitRow(current)).notes).toBe('Now on the crew');
    });

    it("lets Update any visit's status in without a place on the crew", async () => {
      const { org, customer } = await fx.newOrg();
      const crew = await colleague(org);
      const lead = await scheduledLead(org, customer, { walkthroughCrew: [crew.id] });
      const dispatcher = await personWith(org, { ...performs, update_any_visit_status: true, leads_scope: 'all' });
      expect((await notesOf(await dispatcher.api(), lead.id, 'Office note')).status).toBe(200);
      expect((await visitRow(lead.walkthroughId!)).notes).toBe('Office note');
    });
  });

  describe('the per-record action list on the lead', () => {
    it('offers notes and finish only on the walkthrough the person is crewed on, and drops them when taken off', async () => {
      const { org, customer } = await fx.newOrg();
      const me = await personWith(org, performs);
      const other = await colleague(org);
      const mine = await scheduledLead(org, customer, { walkthroughCrew: [me.id] });
      const theirs = await scheduledLead(org, customer, { owner: me.id, walkthroughCrew: [other.id] });
      const api = await me.api();

      expect(await offered(api, mine.id)).toEqual(['walkthrough_notes', 'walkthrough_finish']);
      expect(await offered(api, theirs.id)).toEqual([]);

      await db.visitAssignee.deleteMany({ where: { visit_id: mine.walkthroughId!, user_id: me.id } });
      await db.lead.update({ where: { id: mine.id }, data: { commission_owner_id: me.id } });
      expect(await offered(api, mine.id)).toEqual([]);
    });

    it('offers neither when the person is crewed only on a finished walkthrough of the lead', async () => {
      const { org, customer } = await fx.newOrg();
      const me = await personWith(org, performs);
      const other = await colleague(org);
      const lead = await scheduledLead(org, customer, { owner: me.id });
      await fx.addVisit(org, { leadId: lead.id, purpose: 'WALKTHROUGH', crew: [me.id], daysFromNow: -3, seq: 1 });
      await fx.addVisit(org, { leadId: lead.id, purpose: 'WALKTHROUGH', crew: [other.id], daysFromNow: 2, seq: 2 });
      expect(await offered(await me.api(), lead.id)).toEqual([]);
    });

    it("offers both to a holder of Update any visit's status, and neither without Perform walkthroughs", async () => {
      const { org, customer } = await fx.newOrg();
      const crew = await colleague(org);
      const lead = await scheduledLead(org, customer, { walkthroughCrew: [crew.id] });
      const dispatcher = await personWith(org, { ...performs, update_any_visit_status: true, leads_scope: 'all' });
      const noPerform = await personWith(org, { perform_walkthroughs: false, update_any_visit_status: true, leads_scope: 'all' });
      expect(await offered(await dispatcher.api(), lead.id)).toEqual(['walkthrough_notes', 'walkthrough_finish']);
      expect(await offered(await noPerform.api(), lead.id)).toEqual([]);
    });

    it('offers neither once the walkthrough is finished: there is nothing left to finish, and the notes stay with the crew', async () => {
      const { org, customer } = await fx.newOrg();
      const me = await personWith(org, performs);
      const lead = await scheduledLead(org, customer, { walkthroughCrew: [me.id] });
      const api = await me.api();
      expect((await api.post(`/api/leads/${lead.id}/walkthrough/complete`)).status).toBe(200);
      const steps = await offered(api, lead.id);
      expect(steps).not.toContain('walkthrough_finish');
      expect(steps).toContain('walkthrough_notes');
    });
  });

  describe('a lead someone else assigned, with Edit leads off', () => {
    it('lets the person note the walkthrough, add a photo and build an estimate, and refuses a plain edit', async () => {
      const { org, customer } = await fx.newOrg();
      const me = await personWith(org, { ...performs, edit_leads: false, create_leads: false, edit_estimates: true, create_estimates: true });
      const lead = await scheduledLead(org, customer, { assignees: [me.id], walkthroughCrew: [me.id] });
      const api = await me.api();

      expect((await api.patch(`/api/leads/${lead.id}`, { service_request: 'Changed' })).status).toBe(403);
      expect((await api.post(`/api/leads/${lead.id}/walkthrough`, { walkthrough_notes: 'Bay window, 3 panes' })).status).toBe(200);
      expect((await visitRow(lead.walkthroughId!)).notes).toBe('Bay window, 3 panes');
      // A photo is the lead's own data (P10): it takes the lead's Edit, which this person does not hold, so the door refuses.
      expect((await api.post(`/api/attachments/LEAD/${lead.id}`)).status).toBe(403);
      const estimate = await api.post('/api/estimates', { lead_id: lead.id });
      expect(estimate.status).toBe(201);
    });
  });

  describe('booking, moving, unbooking, re-crewing and cancelling', () => {
    const cancelBody = { cancelled_reason: 'Customer moved the date' };

    it('lets a person with Book walkthroughs cancel the walkthrough and refuses one without it, with no switch named Cancel leads', async () => {
      const { org, customer } = await fx.newOrg();
      const crew = await colleague(org);
      const booker = await personWith(org, { ...performs, book_walkthroughs: true, edit_leads: false, create_leads: false });
      const nonBooker = await personWith(org, { ...performs, update_any_visit_status: true, book_walkthroughs: false, edit_leads: true });
      const lead = await scheduledLead(org, customer, { owner: booker.id, assignees: [nonBooker.id], walkthroughCrew: [crew.id] });

      expect((await (await nonBooker.api()).post(`/api/leads/${lead.id}/walkthrough/cancel`, cancelBody)).status).toBe(403);
      expect((await visitRow(lead.walkthroughId!)).status).toBe('SCHEDULED');
      expect((await (await booker.api()).post(`/api/leads/${lead.id}/walkthrough/cancel`, cancelBody)).status).toBe(200);
      expect((await visitRow(lead.walkthroughId!)).status).toBe('CANCELLED');

      const { SWITCH_CATALOG } = await import('../lib/permissions/switches/catalog.js');
      expect(SWITCH_CATALOG.some((s) => /cancel leads/i.test(s.label))).toBe(false);
      expect(SWITCH_CATALOG.some((s) => s.grants?.some((g) => g.action === 'cancel' && g.subject === 'Lead'))).toBe(false);
    });

    it('puts every booking, moving, unbooking and re-crewing door on Book walkthroughs alone', async () => {
      const { org, customer } = await fx.newOrg();
      const crew = await colleague(org);
      const lead = await scheduledLead(org, customer, { owner: undefined, walkthroughCrew: [crew.id] });
      const without = await personWith(org, { ...performs, update_any_visit_status: true, edit_leads: true, book_walkthroughs: false, leads_scope: 'all' });
      const api = await without.api();
      const when = new Date(Date.now() + 3 * 86_400_000).toISOString();
      const visit = lead.walkthroughId!;
      const doors: Array<[string, () => Promise<{ status: number }>]> = [
        ['book', () => api.post(`/api/leads/${lead.id}/visits`, { scheduled_at: when, duration_minutes: 60, assignee_ids: [crew.id] })],
        ['move', () => api.post(`/api/leads/${lead.id}/walkthrough/schedule`, { scheduled_at: when, duration_minutes: 60, performer_ids: [crew.id] })],
        ['move a named visit', () => api.patch(`/api/leads/${lead.id}/visits/${visit}`, { scheduled_at: when, duration_minutes: 60, performer_ids: [crew.id] })],
        ['re-crew', () => api.post(`/api/leads/${lead.id}/walkthrough/performers`, { performer_ids: [crew.id] })],
        ['unbook', () => api.post(`/api/leads/${lead.id}/walkthrough/unschedule`)],
        ['unbook a named visit', () => api.post(`/api/leads/${lead.id}/visits/${visit}/unschedule`)],
      ];
      for (const [name, run] of doors) expect((await run()).status, name).toBe(403);
      expect((await visitRow(visit)).status).toBe('SCHEDULED');
    });
  });
});
