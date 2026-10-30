/* =============================================================================
   Roles & Permissions, PRD 3, slice S03.18 - the new-lead form books a real walkthrough, with a Performers
   picker.

   The new-lead form's "Schedule walkthrough" time books a real walkthrough visit, the same as booking from the
   lead page (until now it only stored a time on the lead). The people on it are named in the create request:
   a time with performers books the walkthrough with them, a time with nobody books it with nobody on it, and
   neither a time nor performers books nothing. Booking at creation needs only Create leads (not Book
   walkthroughs); naming someone other than oneself needs Assign work to other people; every performer must
   be able to be on a crew. The booking goes through today's booking code, so the same conflict check and the
   same schedule notices run.

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

suite('the new-lead form books a real walkthrough (real database)', () => {
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
    const key = `wt-create-role-${++sequence}`;
    const role = await fx.addCustomRole(org, key, base);
    await setRoleSwitchValues({
      organizationId: org, roleKey: key, values: { leads_scope: 'all', jobs_scope: 'all', ...values }, actorId: null, reason: 'manual',
    });
    const person = await fx.addUser(org, `w${sequence}`, base, { customRoleId: role.id });
    if (opts.active === false) await db.user.update({ where: { id: person.id }, data: { is_active: false } });
    return Object.assign(person, { api: () => fx.signedInAs(person) });
  }

  /** The visits of a lead as stored, with their crew. */
  const visitsOf = async (leadId: string) =>
    (await db.visit.findMany({
      where: { lead_id: leadId },
      select: { purpose: true, status: true, scheduled_at: true, scheduled_end: true, duration_minutes: true, visit_seq: true, assignees: { select: { user_id: true } } },
    })).map((v) => ({ ...v, crew: v.assignees.map((a) => a.user_id).sort() }));

  const newLead = (customer: string, extra: object = {}) => ({ customer_id: customer, service_request: 'Fix the door', ...extra });
  const leadCount = (customer: string) => db.lead.count({ where: { customer_id: customer } });

  /** A creator who may create leads and be on a crew, with the walkthrough-related switches given. */
  const creatorWith = (org: string, values: Record<string, boolean> = {}, base: Role = 'TECHNICIAN') =>
    personWith(org, { view_leads: true, create_leads: true, can_be_on_crew: true, ...values }, base);

  describe('a time with performers', () => {
    it('books a walkthrough visit at that time with those performers on it, whoever the creator is', async () => {
      const { org, customer } = await fx.newOrg();
      const first = await personWith(org, { can_be_on_crew: true }, 'SALES');
      const second = await personWith(org, { can_be_on_crew: true }, 'DISPATCHER');
      // Base roles and switches disagree: a Technician base who may name others, a Dispatcher base who may not book.
      for (const [base, values] of [['TECHNICIAN', { assign_work_to_others: true }], ['DISPATCHER', { assign_work_to_others: true, book_walkthroughs: false }]] as const) {
        const creator = await creatorWith(org, values, base);
        const when = startAt(3 + sequence);
        const res = await (await creator.api()).post('/api/leads', newLead(customer, {
          scheduled_start: when, walkthrough_performer_ids: [first.id, second.id],
        }));
        expect(res.status, base).toBe(201);
        const visits = await visitsOf(res.body.lead.id);
        expect(visits, base).toHaveLength(1);
        expect(visits[0], base).toMatchObject({ purpose: 'WALKTHROUGH', status: 'SCHEDULED', visit_seq: 1, crew: [first.id, second.id].sort() });
        expect(visits[0]!.scheduled_at!.toISOString(), base).toBe(when);
        // The response carries the booking as the lead page reads it.
        expect(new Date(res.body.lead.walkthrough_scheduled_at).toISOString(), base).toBe(when);
        expect(res.body.lead.walkthrough_performers.map((p: { user: { id: string } }) => p.user.id).sort(), base).toEqual([first.id, second.id].sort());
      }
    });

    it('takes the length of the walkthrough from the end time, else an hour', async () => {
      const { org, customer } = await fx.newOrg();
      const creator = await creatorWith(org, { assign_work_to_others: true });
      const api = await creator.api();
      const when = startAt(4);
      const withEnd = await api.post('/api/leads', newLead(customer, {
        scheduled_start: when, scheduled_end: new Date(new Date(when).getTime() + 90 * 60_000).toISOString(),
      }));
      expect((await visitsOf(withEnd.body.lead.id))[0]).toMatchObject({ duration_minutes: 90 });
      const withoutEnd = await api.post('/api/leads', newLead(customer, { scheduled_start: when }));
      expect((await visitsOf(withoutEnd.body.lead.id))[0]).toMatchObject({ duration_minutes: 60 });
    });

    it('moves the lead to Walkthrough Scheduled, as booking from the lead page does', async () => {
      const { org, customer } = await fx.newOrg();
      const creator = await creatorWith(org, { assign_work_to_others: true });
      const res = await (await creator.api()).post('/api/leads', newLead(customer, { scheduled_start: startAt(3), walkthrough_performer_ids: [creator.id] }));
      expect(res.status).toBe(201);
      const lead = await db.lead.findUniqueOrThrow({ where: { id: res.body.lead.id }, select: { status: true, walkthrough_first_booked_at: true } });
      expect(lead.status).toBe('WALKTHROUGH_SCHEDULED');
      expect(lead.walkthrough_first_booked_at).not.toBeNull();
    });

    it('records the walkthrough with its performers in the lead history', async () => {
      const { org, customer } = await fx.newOrg();
      const performer = await personWith(org, { can_be_on_crew: true }, 'SALES');
      const creator = await creatorWith(org, { assign_work_to_others: true });
      const api = await creator.api();
      const res = await api.post('/api/leads', newLead(customer, { scheduled_start: startAt(3), walkthrough_performer_ids: [performer.id] }));
      const events = (await api.get(`/api/leads/${res.body.lead.id}/timeline`)).body.events as Array<{ event_type: string; metadata: Record<string, unknown> | null }>;
      const booked = events.filter((e) => e.event_type === 'WALKTHROUGH_SCHEDULED');
      expect(booked).toHaveLength(1);
      expect(booked[0]!.metadata).toMatchObject({ performer_ids: [performer.id] });
    });
  });

  describe('a time without performers', () => {
    it('books the walkthrough with nobody on it', async () => {
      const { org, customer } = await fx.newOrg();
      const creator = await creatorWith(org);
      const when = startAt(3);
      for (const body of [{ scheduled_start: when }, { scheduled_start: when, walkthrough_performer_ids: [] }]) {
        const res = await (await creator.api()).post('/api/leads', newLead(customer, body));
        expect(res.status).toBe(201);
        const visits = await visitsOf(res.body.lead.id);
        expect(visits).toHaveLength(1);
        expect(visits[0]).toMatchObject({ purpose: 'WALKTHROUGH', status: 'SCHEDULED', crew: [] });
      }
    });
  });

  describe('neither a time nor performers', () => {
    // Performers named without a time make a "To be scheduled" walkthrough: permission-lead-to-be-scheduled-db.test.ts.
    it('books no walkthrough visit', async () => {
      const { org, customer } = await fx.newOrg();
      const creator = await creatorWith(org);
      const res = await (await creator.api()).post('/api/leads', newLead(customer));
      expect(res.status).toBe(201);
      expect(await visitsOf(res.body.lead.id)).toEqual([]);
      expect(res.body.lead.walkthrough_scheduled_at).toBeNull();
    });

  });

  describe('who may be named', () => {
    it('lets a person without Book walkthroughs book at creation and put only themselves on it', async () => {
      const { org, customer } = await fx.newOrg();
      // Create leads on; Book walkthroughs and Assign work to other people off. A Dispatcher base, so no base-role check can pass.
      const creator = await creatorWith(org, { book_walkthroughs: false, assign_work_to_others: false }, 'DISPATCHER');
      const res = await (await creator.api()).post('/api/leads', newLead(customer, { scheduled_start: startAt(3), walkthrough_performer_ids: [creator.id] }));
      expect(res.status).toBe(201);
      expect((await visitsOf(res.body.lead.id))[0]).toMatchObject({ crew: [creator.id] });
    });

    it('refuses naming someone else without Assign work to other people, and creates no lead', async () => {
      const { org, customer } = await fx.newOrg();
      const other = await personWith(org, { can_be_on_crew: true }, 'SALES');
      // Book walkthroughs on does not widen the pool: only Assign work to other people does.
      const creator = await creatorWith(org, { book_walkthroughs: true, assign_work_to_others: false }, 'TECHNICIAN');
      const before = await leadCount(customer);
      const res = await (await creator.api()).post('/api/leads', newLead(customer, { scheduled_start: startAt(3), walkthrough_performer_ids: [creator.id, other.id] }));
      expect(res.status).toBe(403);
      expect(res.body.error).toBe(SELF_ONLY);
      expect(await leadCount(customer)).toBe(before);
    });

    it('refuses a performer who cannot be on a crew, or is inactive, in plain words, and creates no lead', async () => {
      const { org, customer } = await fx.newOrg();
      // A Technician base with Can be on a crew off, and a Sales base with it on: the switch decides, not the role.
      const cannot = await personWith(org, { can_be_on_crew: false }, 'TECHNICIAN');
      const inactive = await personWith(org, { can_be_on_crew: true }, 'SALES', { active: false });
      const creator = await creatorWith(org, { assign_work_to_others: true });
      const before = await leadCount(customer);
      for (const [label, id, message] of [['switch off', cannot.id, NOT_CREW], ['inactive', inactive.id, INACTIVE]] as const) {
        const res = await (await creator.api()).post('/api/leads', newLead(customer, { scheduled_start: startAt(3), walkthrough_performer_ids: [id] }));
        expect(res.status, label).toBe(400);
        expect(res.body.error, label).toBe(message);
      }
      expect(await leadCount(customer)).toBe(before);
    });

    it('says a performer outside the company is not found', async () => {
      const { org, customer } = await fx.newOrg();
      const other = await fx.newOrg();
      const creator = await creatorWith(org, { assign_work_to_others: true });
      const res = await (await creator.api()).post('/api/leads', newLead(customer, { scheduled_start: startAt(3), walkthrough_performer_ids: [other.admin.id] }));
      expect(res.status).toBe(400);
      expect(res.body.error).toBe('Performer not found');
    });

    it('lets a creator who cannot be on a crew still book a walkthrough with nobody on it, but not put themselves on it', async () => {
      const { org, customer } = await fx.newOrg();
      const creator = await creatorWith(org, { can_be_on_crew: false }, 'TECHNICIAN');
      const res = await (await creator.api()).post('/api/leads', newLead(customer, { scheduled_start: startAt(3) }));
      expect(res.status).toBe(201);
      expect((await visitsOf(res.body.lead.id))[0]).toMatchObject({ crew: [] });
      const self = await (await creator.api()).post('/api/leads', newLead(customer, { scheduled_start: startAt(3), walkthrough_performer_ids: [creator.id] }));
      expect(self.status).toBe(400);
      expect(self.body.error).toBe(NOT_CREW);
    });
  });

  describe('the booking goes through today\'s booking code', () => {
    it('runs the conflict check for the performers, refuses with the same 409 and creates no lead, unless forced', async () => {
      const { org, customer } = await fx.newOrg();
      const performer = await personWith(org, { can_be_on_crew: true }, 'SALES');
      const creator = await creatorWith(org, { assign_work_to_others: true });
      const api = await creator.api();
      const when = startAt(5);
      const first = await api.post('/api/leads', newLead(customer, { scheduled_start: when, walkthrough_performer_ids: [performer.id] }));
      expect(first.status).toBe(201);

      const before = await leadCount(customer);
      const clash = await api.post('/api/leads', newLead(customer, { scheduled_start: when, walkthrough_performer_ids: [performer.id] }));
      expect(clash.status).toBe(409);
      expect(clash.body.error).toBe('Schedule conflict detected');
      expect(clash.body.conflicts).toEqual([expect.objectContaining({ type: 'walkthrough', id: first.body.lead.id, number: first.body.lead.lead_number })]);
      expect(await leadCount(customer)).toBe(before);

      const forced = await api.post('/api/leads', newLead(customer, { scheduled_start: when, walkthrough_performer_ids: [performer.id], walkthrough_force: true }));
      expect(forced.status).toBe(201);
      expect((await visitsOf(forced.body.lead.id))[0]).toMatchObject({ crew: [performer.id] });
    });

    it('sends the schedule notices the lead page sends: the customer notice and one for each performer', async () => {
      const { org, customer } = await fx.newOrg();
      const first = await personWith(org, { can_be_on_crew: true }, 'SALES');
      const second = await personWith(org, { can_be_on_crew: true }, 'SALES');
      const creator = await creatorWith(org, { assign_work_to_others: true });
      const when = startAt(6);
      const res = await (await creator.api()).post('/api/leads', newLead(customer, { scheduled_start: when, walkthrough_performer_ids: [first.id, second.id] }));
      expect(res.status).toBe(201);
      const leadId = res.body.lead.id as string;
      const events = vi.mocked(dispatchAutomationEvent).mock.calls.map(([e]) => e).filter((e) => e.entity.id === leadId);
      expect(events.filter((e) => e.type === 'WALKTHROUGH_SCHEDULED')).toEqual([
        expect.objectContaining({ organizationId: org, occurrenceKey: when }),
      ]);
      expect(events.filter((e) => e.type === 'WALKTHROUGH_PERFORMER_ASSIGNED').map((e) => e.occurrenceKey).sort()).toEqual([first.id, second.id].sort());
    });

    it('sends no customer notice for a walkthrough with nobody on it, as the lead page does', async () => {
      const { org, customer } = await fx.newOrg();
      const creator = await creatorWith(org);
      const res = await (await creator.api()).post('/api/leads', newLead(customer, { scheduled_start: startAt(6) }));
      expect(res.status).toBe(201);
      const types = vi.mocked(dispatchAutomationEvent).mock.calls.map(([e]) => e).filter((e) => e.entity.id === res.body.lead.id).map((e) => e.type);
      expect(types).not.toContain('WALKTHROUGH_SCHEDULED');
      expect(types).not.toContain('WALKTHROUGH_PERFORMER_ASSIGNED');
    });
  });

  describe('the form asks whether the creator can be on a crew', () => {
    it('is answered from the creator\'s own switch, whatever the role is based on', async () => {
      const { org } = await fx.newOrg();
      // Base roles and the switch disagree both ways.
      for (const [base, on] of [['TECHNICIAN', false], ['SALES', true], ['DISPATCHER', false], ['TECHNICIAN', true]] as const) {
        const creator = await creatorWith(org, { can_be_on_crew: on }, base);
        const res = await (await creator.api()).get('/api/leads/creator-prefill');
        expect(res.status, `${base} ${on}`).toBe(200);
        expect(res.body.can_be_on_crew, `${base} ${on}`).toBe(on);
      }
    });
  });

  describe('the lead page booking is unchanged', () => {
    it('still reschedules the same visit and puts the performers on it', async () => {
      const { org, customer } = await fx.newOrg();
      const performer = await personWith(org, { can_be_on_crew: true }, 'SALES');
      const creator = await creatorWith(org, { assign_work_to_others: true, book_walkthroughs: true });
      const api = await creator.api();
      const created = await api.post('/api/leads', newLead(customer, { scheduled_start: startAt(3), walkthrough_performer_ids: [creator.id] }));
      const next = startAt(8);
      const res = await api.post(`/api/leads/${created.body.lead.id}/walkthrough/schedule`, { walkthrough_scheduled_at: next, performer_ids: [performer.id] });
      expect(res.status).toBe(200);
      const visits = await visitsOf(created.body.lead.id);
      expect(visits).toHaveLength(1);
      expect(visits[0]).toMatchObject({ crew: [performer.id] });
      expect(visits[0]!.scheduled_at!.toISOString()).toBe(next);
    });
  });
});
