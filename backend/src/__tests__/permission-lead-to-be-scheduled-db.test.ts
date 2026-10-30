/* =============================================================================
   Roles & Permissions, PRD 3, slice S03.19 - "To be scheduled" walkthroughs (performers without a time).

   Performers can be saved on the new-lead form with no time. The lead then gets a real walkthrough visit with
   those performers and no time (it reads "To be scheduled"); the performer arranges the time with the customer.
   It sends no schedule notification and no customer reminder until it has a time, and it never counts as Missing
   crew. History records it with its performers and "no time yet". Setting the time afterwards is a booking: it
   needs Book walkthroughs, and only then sends the schedule notices.

   Every case uses people on custom roles whose base role and switches disagree, so no role-name or base-role
   check can pass. Everything goes through the lead routes. Real migrated database (TEST_DATABASE_URL); the
   suite skips when it is unset. Every org it creates is removed again.
   ========================================================================== */

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
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
import { setRoleSwitchValues } from '../lib/permissions/switches/store';
import { dispatchAutomationEvent } from '../services/automations/dispatch';

const suite = realClient ? describe : describe.skip;

const SELF_ONLY = 'You can only put yourself on a walkthrough.';
const NOT_CREW = "This person can't be on a crew.";
const INACTIVE = 'This person is inactive.';

const HOUR = 3_600_000;
const startAt = (days: number) => new Date(Date.now() + days * 24 * HOUR - (Date.now() % HOUR)).toISOString();

suite('"To be scheduled" walkthroughs (real database)', () => {
  const db = realClient as PrismaClient;
  const fx = switchFixture(db, async () => (await import('../app.js')).default as never);
  // Loading the whole app is slow on a loaded machine.
  beforeAll(async () => {
    await import('../app.js');
  }, 120_000);
  afterAll(() => fx.cleanup());
  beforeEach(() => vi.mocked(dispatchAutomationEvent).mockClear());

  type Api = Awaited<ReturnType<typeof fx.signedInAs>>;
  let sequence = 0;

  /** A person on a fresh custom role of this base holding exactly these switch values. */
  async function personWith(
    org: string,
    values: Record<string, boolean | string>,
    base: Role,
    opts: { active?: boolean } = {},
  ): Promise<Person & { api: () => Promise<Api> }> {
    const key = `wt-tbs-role-${++sequence}`;
    const role = await fx.addCustomRole(org, key, base);
    await setRoleSwitchValues({
      organizationId: org, roleKey: key, values: { leads_scope: 'all', jobs_scope: 'all', ...values }, actorId: null, reason: 'manual',
    });
    const person = await fx.addUser(org, `t${sequence}`, base, { customRoleId: role.id });
    if (opts.active === false) await db.user.update({ where: { id: person.id }, data: { is_active: false } });
    return Object.assign(person, { api: () => fx.signedInAs(person) });
  }

  /** The visits of a lead as stored, with their crew. */
  const visitsOf = async (leadId: string) =>
    (await db.visit.findMany({
      where: { lead_id: leadId },
      select: { id: true, purpose: true, status: true, scheduled_at: true, scheduled_end: true, duration_minutes: true, visit_seq: true, assignees: { select: { user_id: true } } },
    })).map((v) => ({ ...v, crew: v.assignees.map((a) => a.user_id).sort() }));

  const newLead = (customer: string, extra: object = {}) => ({ customer_id: customer, service_request: 'Fix the door', ...extra });
  const leadCount = (customer: string) => db.lead.count({ where: { customer_id: customer } });
  const leadEvents = (leadId: string) => vi.mocked(dispatchAutomationEvent).mock.calls.map(([e]) => e).filter((e) => e.entity.id === leadId);

  /** A creator who may create leads and be on a crew, with the walkthrough-related switches given. */
  const creatorWith = (org: string, values: Record<string, boolean> = {}, base: Role = 'TECHNICIAN') =>
    personWith(org, { view_leads: true, create_leads: true, can_be_on_crew: true, ...values }, base);

  describe('performers with no time', () => {
    it('create a walkthrough visit with no time and those performers on it, whoever the creator is', async () => {
      const { org, customer } = await fx.newOrg();
      const first = await personWith(org, { can_be_on_crew: true }, 'SALES');
      const second = await personWith(org, { can_be_on_crew: true }, 'DISPATCHER');
      // Base roles and switches disagree: a Technician base who may name others, a Dispatcher base who may not book.
      for (const [base, values] of [['TECHNICIAN', { assign_work_to_others: true }], ['DISPATCHER', { assign_work_to_others: true, book_walkthroughs: false }]] as const) {
        const creator = await creatorWith(org, values, base);
        const res = await (await creator.api()).post('/api/leads', newLead(customer, { walkthrough_performer_ids: [first.id, second.id] }));
        expect(res.status, base).toBe(201);
        const visits = await visitsOf(res.body.lead.id);
        expect(visits, base).toHaveLength(1);
        expect(visits[0], base).toMatchObject({
          purpose: 'WALKTHROUGH', status: 'SCHEDULED', visit_seq: 1, scheduled_at: null, scheduled_end: null, crew: [first.id, second.id].sort(),
        });
        // The response carries it the way the lead page reads it: nobody has a time, and it says it is to be scheduled.
        expect(res.body.lead.walkthrough_scheduled_at, base).toBeNull();
        expect(res.body.lead.walkthrough_to_be_scheduled, base).toBe(true);
        expect(res.body.lead.walkthrough_performers.map((p: { user: { id: string } }) => p.user.id).sort(), base).toEqual([first.id, second.id].sort());
      }
    });

    it('do not stamp the "first walkthrough booked" clock: nothing has been booked with the customer', async () => {
      const { org, customer } = await fx.newOrg();
      const creator = await creatorWith(org);
      const res = await (await creator.api()).post('/api/leads', newLead(customer, { walkthrough_performer_ids: [creator.id] }));
      expect(res.status).toBe(201);
      const lead = await db.lead.findUniqueOrThrow({ where: { id: res.body.lead.id }, select: { walkthrough_first_booked_at: true } });
      expect(lead.walkthrough_first_booked_at).toBeNull();
    });

    it('a timed walkthrough still says it is not "to be scheduled"', async () => {
      const { org, customer } = await fx.newOrg();
      const creator = await creatorWith(org);
      const res = await (await creator.api()).post('/api/leads', newLead(customer, { scheduled_start: startAt(3), walkthrough_performer_ids: [creator.id] }));
      expect(res.status).toBe(201);
      expect(res.body.lead.walkthrough_to_be_scheduled).toBe(false);
    });

    it('send no schedule notification and no performer notice', async () => {
      const { org, customer } = await fx.newOrg();
      const first = await personWith(org, { can_be_on_crew: true }, 'SALES');
      const creator = await creatorWith(org, { assign_work_to_others: true });
      const res = await (await creator.api()).post('/api/leads', newLead(customer, { walkthrough_performer_ids: [first.id, creator.id] }));
      expect(res.status).toBe(201);
      const types = leadEvents(res.body.lead.id).map((e) => e.type);
      expect(types).not.toContain('WALKTHROUGH_SCHEDULED');
      expect(types).not.toContain('WALKTHROUGH_PERFORMER_ASSIGNED');
      expect(types).not.toContain('WALKTHROUGH_RESCHEDULED');
    });

    it('are recorded in the lead history with their performers and "no time yet"', async () => {
      const { org, customer } = await fx.newOrg();
      const performer = await personWith(org, { can_be_on_crew: true }, 'SALES');
      const creator = await creatorWith(org, { assign_work_to_others: true });
      const api = await creator.api();
      const res = await api.post('/api/leads', newLead(customer, { walkthrough_performer_ids: [performer.id] }));
      const events = (await api.get(`/api/leads/${res.body.lead.id}/timeline`)).body.events as Array<{ event_type: string; description: string; metadata: Record<string, unknown> | null }>;
      const booked = events.filter((e) => e.event_type === 'WALKTHROUGH_SCHEDULED');
      expect(booked).toHaveLength(1);
      expect(booked[0]!.description).toContain('no time yet');
      const person = await db.user.findUniqueOrThrow({ where: { id: performer.id }, select: { first_name: true, last_name: true } });
      expect(booked[0]!.description).toContain(`${person.first_name} ${person.last_name}`);
      expect(booked[0]!.metadata).toMatchObject({ performer_ids: [performer.id] });
    });

    it('are not Missing crew: a walkthrough with people and no time is never counted, a timed one with nobody is', async () => {
      const { org, customer, admin } = await fx.newOrg();
      const creator = await creatorWith(org, { assign_work_to_others: true });
      const api = await creator.api();
      const untimed = await api.post('/api/leads', newLead(customer, { walkthrough_performer_ids: [creator.id] }));
      const timedNobody = await api.post('/api/leads', newLead(customer, { scheduled_start: startAt(2) }));
      expect(untimed.status).toBe(201);
      expect(timedNobody.status).toBe(201);

      const { findMissingCrew } = await import('../lib/missingCrew.js');
      const viewer = await db.user.findUniqueOrThrow({
        where: { id: admin.id },
        select: { id: true, role: true, organization_id: true, custom_role_id: true, custom_role: { select: { key: true } }, department_id: true, location_id: true },
      });
      const counted = (await findMissingCrew(viewer as never)).map((v) => v.lead_id);
      expect(counted).toContain(timedNobody.body.lead.id);
      expect(counted).not.toContain(untimed.body.lead.id);
    });

    it('with no performers named, create no walkthrough visit (an empty list is the same as none)', async () => {
      const { org, customer } = await fx.newOrg();
      const creator = await creatorWith(org);
      for (const body of [{}, { walkthrough_performer_ids: [] }]) {
        const res = await (await creator.api()).post('/api/leads', newLead(customer, body));
        expect(res.status).toBe(201);
        expect(await visitsOf(res.body.lead.id)).toEqual([]);
        expect(res.body.lead.walkthrough_to_be_scheduled ?? false).toBe(false);
      }
    });

    it('let the creator who put only themselves on it, with Attached scope, open the lead', async () => {
      const { org, customer } = await fx.newOrg();
      // Attached scope, may name people on the lead (so the Owner and Dispatcher can be left empty), may be on a crew.
      const creator = await creatorWith(org, { leads_scope: 'attached', assign_people_to_leads: true } as never, 'SALES');
      const api = await creator.api();
      const res = await api.post('/api/leads', newLead(customer, { assigned_to: null, dispatcher_id: null, walkthrough_performer_ids: [creator.id] }));
      expect(res.status).toBe(201);
      const lead = await db.lead.findUniqueOrThrow({ where: { id: res.body.lead.id }, select: { commission_owner_id: true, dispatcher_id: true } });
      // The walkthrough is the ONLY thing attaching them.
      expect(lead).toEqual({ commission_owner_id: null, dispatcher_id: null });
      const opened = await api.get(`/api/leads/${res.body.lead.id}`);
      expect(opened.status).toBe(200);
      expect(opened.body.lead.id).toBe(res.body.lead.id);
    });
  });

  describe('who may be named without a time', () => {
    it('lets a person without Book walkthroughs put only themselves on it', async () => {
      const { org, customer } = await fx.newOrg();
      const creator = await creatorWith(org, { book_walkthroughs: false, assign_work_to_others: false }, 'DISPATCHER');
      const res = await (await creator.api()).post('/api/leads', newLead(customer, { walkthrough_performer_ids: [creator.id] }));
      expect(res.status).toBe(201);
      expect((await visitsOf(res.body.lead.id))[0]).toMatchObject({ scheduled_at: null, crew: [creator.id] });
    });

    it('refuses naming someone else without Assign work to other people, and creates no lead', async () => {
      const { org, customer } = await fx.newOrg();
      const other = await personWith(org, { can_be_on_crew: true }, 'SALES');
      const creator = await creatorWith(org, { book_walkthroughs: true, assign_work_to_others: false }, 'TECHNICIAN');
      const before = await leadCount(customer);
      const res = await (await creator.api()).post('/api/leads', newLead(customer, { walkthrough_performer_ids: [creator.id, other.id] }));
      expect(res.status).toBe(403);
      expect(res.body.error).toBe(SELF_ONLY);
      expect(await leadCount(customer)).toBe(before);
    });

    it('refuses a performer who cannot be on a crew, or is inactive, in plain words, and creates no lead', async () => {
      const { org, customer } = await fx.newOrg();
      const cannot = await personWith(org, { can_be_on_crew: false }, 'TECHNICIAN');
      const inactive = await personWith(org, { can_be_on_crew: true }, 'SALES', { active: false });
      const creator = await creatorWith(org, { assign_work_to_others: true });
      const before = await leadCount(customer);
      for (const [label, id, message] of [['switch off', cannot.id, NOT_CREW], ['inactive', inactive.id, INACTIVE]] as const) {
        const res = await (await creator.api()).post('/api/leads', newLead(customer, { walkthrough_performer_ids: [id] }));
        expect(res.status, label).toBe(400);
        expect(res.body.error, label).toBe(message);
      }
      expect(await leadCount(customer)).toBe(before);
    });
  });

  describe('setting the time afterwards', () => {
    /** A lead saved with `performer` on a walkthrough that has no time. */
    async function untimedLead(org: string, customer: string, performer: Person) {
      const maker = await creatorWith(org, { assign_work_to_others: true });
      const res = await (await maker.api()).post('/api/leads', newLead(customer, { walkthrough_performer_ids: [performer.id] }));
      expect(res.status).toBe(201);
      vi.mocked(dispatchAutomationEvent).mockClear();
      return res.body.lead.id as string;
    }

    it('is refused without Book walkthroughs, and the walkthrough stays without a time', async () => {
      const { org, customer } = await fx.newOrg();
      const performer = await creatorWith(org, { book_walkthroughs: false, assign_work_to_others: false }, 'DISPATCHER');
      const leadId = await untimedLead(org, customer, performer);
      const res = await (await performer.api()).post(`/api/leads/${leadId}/walkthrough/schedule`, { walkthrough_scheduled_at: startAt(4), performer_ids: [performer.id] });
      expect(res.status).toBe(403);
      expect((await visitsOf(leadId))[0]).toMatchObject({ scheduled_at: null });
      expect(leadEvents(leadId)).toEqual([]);
    });

    it('is accepted with Book walkthroughs: the same visit gets its time, and only then are the schedule notices sent', async () => {
      const { org, customer } = await fx.newOrg();
      const performer = await personWith(org, { can_be_on_crew: true }, 'SALES');
      const leadId = await untimedLead(org, customer, performer);
      // A Technician base holding Book walkthroughs and Assign work to other people.
      const booker = await creatorWith(org, { book_walkthroughs: true, assign_work_to_others: true }, 'TECHNICIAN');
      const when = startAt(5);
      const res = await (await booker.api()).post(`/api/leads/${leadId}/walkthrough/schedule`, { walkthrough_scheduled_at: when, performer_ids: [performer.id] });
      expect(res.status).toBe(200);

      const visits = await visitsOf(leadId);
      expect(visits).toHaveLength(1);
      expect(visits[0]!.scheduled_at!.toISOString()).toBe(when);
      expect(visits[0]).toMatchObject({ status: 'SCHEDULED', crew: [performer.id] });
      expect(res.body.lead.walkthrough_to_be_scheduled).toBe(false);

      // Its first booking, not a reschedule: the customer is told it is scheduled, and the performer hears of it.
      const events = leadEvents(leadId);
      expect(events.filter((e) => e.type === 'WALKTHROUGH_SCHEDULED')).toEqual([expect.objectContaining({ occurrenceKey: when })]);
      expect(events.filter((e) => e.type === 'WALKTHROUGH_RESCHEDULED')).toEqual([]);
      expect(events.filter((e) => e.type === 'WALKTHROUGH_PERFORMER_ASSIGNED').map((e) => e.occurrenceKey)).toEqual([performer.id]);

      const lead = await db.lead.findUniqueOrThrow({ where: { id: leadId }, select: { walkthrough_first_booked_at: true } });
      expect(lead.walkthrough_first_booked_at).not.toBeNull();
      const history = await db.timelineEvent.findMany({ where: { entity_id: leadId, event_type: { in: ['WALKTHROUGH_SCHEDULED', 'WALKTHROUGH_RESCHEDULED'] } }, select: { event_type: true } });
      expect(history.map((e) => e.event_type).sort()).toEqual(['WALKTHROUGH_SCHEDULED', 'WALKTHROUGH_SCHEDULED']);
    });
  });
});
