/* =============================================================================
   Roles & Permissions, PRD 3, slice S03.13 - converting a lead copies its Owner to the job's Sold By and its
   Dispatcher to the job's Dispatcher.

   Converting one or several estimates of a lead writes the new job's people as copies taken at that moment:
   Sold By is the lead's Owner when that person is active and may be Sold By; Dispatcher is the lead's
   Dispatcher when active and may be a dispatcher. When a person cannot be carried over, the converter takes
   the Dispatcher slot when they can fill it, and the Sold By slot when they hold no Assign people to jobs and
   can be Sold By (a converter who holds it gets an empty Sold By to choose). The crew is never copied.

   Every case uses people on custom roles whose base role and slot switch disagree (a Technician base with the
   switch on, a Dispatcher base with it off), so no role-name or base-role check can pass. Everything goes
   through the job and lead routes. Real migrated database (TEST_DATABASE_URL); the suite skips when it is
   unset. Every org it creates is removed again.
   ========================================================================== */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
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

// The suite-wide setup hands every record the same number; these cases create several jobs in one company.
vi.mock('../lib/numbering', () => {
  let issued = 0;
  return {
    allocateNumber: vi.fn(async (_tx: unknown, entity: string) => `${entity[0]!.toUpperCase()}T${Date.now()}${++issued}`),
  };
});

import { switchFixture, type Person } from './permission-switches-fixture';
import { setRoleSwitchValues } from '../lib/permissions/switches/store';

const suite = realClient ? describe : describe.skip;

suite('converting a lead copies its Owner and Dispatcher to the job (real database)', () => {
  const db = realClient as PrismaClient;
  const fx = switchFixture(db, async () => (await import('../app.js')).default as never);
  // Loading the whole app is slow on a loaded machine.
  beforeAll(async () => {
    await import('../app.js');
  }, 120_000);
  afterAll(() => fx.cleanup());

  type Api = Awaited<ReturnType<typeof fx.signedInAs>>;
  let sequence = 0;

  /** A person on a fresh custom role of this base holding exactly these switch values, with Jobs scope All. */
  async function personWith(
    org: string,
    values: Record<string, boolean | string>,
    base: Role,
    opts: { active?: boolean; name?: string } = {},
  ): Promise<Person & { api: () => Promise<Api> }> {
    const key = `conversion-role-${++sequence}`;
    const role = await fx.addCustomRole(org, key, base);
    await setRoleSwitchValues({
      organizationId: org, roleKey: key, values: { leads_scope: 'all', jobs_scope: 'all', view_jobs: true, ...values }, actorId: null, reason: 'manual',
    });
    const person = await fx.addUser(org, opts.name ?? `p${sequence}`, base, { customRoleId: role.id });
    if (opts.active === false) await db.user.update({ where: { id: person.id }, data: { is_active: false } });
    return Object.assign(person, { api: () => fx.signedInAs(person) });
  }

  // The hard pairs: base Technician with the switch on (accepted), base Dispatcher with it off (refused).
  const canOwn = (org: string, opts: { name?: string } = {}) => personWith(org, { can_own_leads: true }, 'TECHNICIAN', opts);
  const cannotOwn = (org: string) => personWith(org, { can_own_leads: false }, 'DISPATCHER');
  const canDispatch = (org: string, opts: { name?: string } = {}) => personWith(org, { can_be_dispatcher: true }, 'TECHNICIAN', opts);
  const cannotDispatch = (org: string) => personWith(org, { can_be_dispatcher: false }, 'DISPATCHER');

  /** Someone who converts: may create jobs, and holds Assign people to jobs or not, with the two slot switches given. */
  const converter = (
    org: string,
    opts: { assign: boolean; canOwn?: boolean; canDispatch?: boolean },
  ) =>
    personWith(
      org,
      {
        create_jobs: true,
        edit_jobs: true,
        view_estimates: true,
        assign_people_to_jobs: opts.assign,
        can_own_leads: opts.canOwn ?? false,
        can_be_dispatcher: opts.canDispatch ?? false,
      },
      opts.assign ? 'TECHNICIAN' : 'DISPATCHER',
    );

  /** A lead with its people, and `estimates` WON estimates on it, ready to convert. */
  async function leadToConvert(
    org: string,
    customer: string,
    adminId: string,
    people: { owner?: string; dispatcher?: string; walkthroughCrew?: string[] },
    estimates = 1,
  ) {
    const location = randomUUID();
    await db.serviceLocation.create({
      data: { id: location, customer_id: customer, address_line1: '1 Test Way', city: 'Testville', state: 'MA', zip: '02108' },
    });
    const lead = await fx.addLead(org, customer, {
      owner: people.owner, assignees: people.owner ? [people.owner] : [], dispatcher: people.dispatcher, walkthroughCrew: people.walkthroughCrew,
    });
    const estimateIds: string[] = [];
    for (let i = 0; i < estimates; i++) {
      const estimate = await fx.addEstimate(org, customer, adminId, { leadId: lead.id });
      await db.estimate.update({ where: { id: estimate.id }, data: { status: 'WON' } });
      estimateIds.push(estimate.id);
    }
    return { lead: lead.id, estimateIds, location };
  }

  type Conversion = Awaited<ReturnType<typeof leadToConvert>>;

  /** Convert the lead's estimates the way the Convert dialog does: one id for one estimate, a list for several. */
  async function convert(api: Api, c: Conversion) {
    const body = c.estimateIds.length === 1
      ? { estimate_id: c.estimateIds[0], service_location_id: c.location }
      : { estimate_ids: c.estimateIds, service_location_id: c.location };
    const res = await api.post('/api/jobs', body);
    expect(res.status, JSON.stringify(res.body)).toBeLessThan(300);
    const id = (res.body as { job: { id: string } }).job.id;
    const job = await db.job.findUniqueOrThrow({ where: { id }, select: { id: true, salesperson_id: true, dispatcher_id: true } });
    return { ...job, response: res.body as { job: Record<string, unknown> } };
  }

  /** The people events on the job's history, as a reader sees them. */
  async function peopleEvents(jobId: string) {
    const rows = await db.timelineEvent.findMany({
      where: { entity_type: 'JOB', entity_id: jobId, event_type: { in: ['SOLD_BY_CHANGED', 'DISPATCHER_CHANGED'] } },
      select: { event_type: true, description: true, metadata: true },
    });
    return {
      soldBy: rows.filter((r) => r.event_type === 'SOLD_BY_CHANGED'),
      dispatcher: rows.filter((r) => r.event_type === 'DISPATCHER_CHANGED'),
    };
  }

  const sources = [
    ['a single estimate', 1],
    ['several estimates', 2],
  ] as const;

  describe.each(sources)('converting %s', (_label, estimates) => {
    it('copies an active, eligible Owner to Sold By and an active, eligible Dispatcher to Dispatcher', async () => {
      const { org, admin, customer } = await fx.newOrg();
      const owner = await canOwn(org);
      const dispatcher = await canDispatch(org);
      // The converter is neither, and could not be either, so the copy cannot be the converter falling back.
      const me = await converter(org, { assign: true });
      const c = await leadToConvert(org, customer, admin.id, { owner: owner.id, dispatcher: dispatcher.id }, estimates);

      const job = await convert(await me.api(), c);

      expect(job.salesperson_id).toBe(owner.id);
      expect(job.dispatcher_id).toBe(dispatcher.id);
    });

    it('copies nobody the converter is not: a lead with an Owner who has been switched off leaves Sold By to the converter by the converter\'s own rules', async () => {
      const { org, admin, customer } = await fx.newOrg();
      const owner = await cannotOwn(org);
      const me = await converter(org, { assign: false, canOwn: true });
      const c = await leadToConvert(org, customer, admin.id, { owner: owner.id }, estimates);

      const job = await convert(await me.api(), c);

      expect(job.salesperson_id).toBe(me.id);
    });
  });

  describe('Sold By when the lead\'s Owner cannot be carried over', () => {
    type OwnerCase = { name: string; make: (org: string) => Promise<Person> };
    const ownerCases: OwnerCase[] = [
      { name: 'Can own leads / be Sold By is off', make: cannotOwn },
      { name: 'is inactive', make: (org) => personWith(org, { can_own_leads: true }, 'TECHNICIAN', { active: false }) },
    ];

    it.each(ownerCases.map((o) => [o.name, o] as const))('a converter with Assign people to jobs gets an empty Sold By when the Owner %s', async (_name, ownerCase) => {
      const { org, admin, customer } = await fx.newOrg();
      const owner = await ownerCase.make(org);
      // Even a converter who could be Sold By is not credited: they choose it on the Team card.
      const me = await converter(org, { assign: true, canOwn: true });
      const c = await leadToConvert(org, customer, admin.id, { owner: owner.id });

      const job = await convert(await me.api(), c);

      expect(job.salesperson_id).toBeNull();
    });

    it.each(ownerCases.map((o) => [o.name, o] as const))('a converter without Assign people to jobs is the Sold By when they can be, when the Owner %s', async (_name, ownerCase) => {
      const { org, admin, customer } = await fx.newOrg();
      const owner = await ownerCase.make(org);
      const me = await converter(org, { assign: false, canOwn: true });
      const c = await leadToConvert(org, customer, admin.id, { owner: owner.id });

      const job = await convert(await me.api(), c);

      expect(job.salesperson_id).toBe(me.id);
    });

    it.each(ownerCases.map((o) => [o.name, o] as const))('a converter without Assign people to jobs who cannot be Sold By leaves it empty, when the Owner %s', async (_name, ownerCase) => {
      const { org, admin, customer } = await fx.newOrg();
      const owner = await ownerCase.make(org);
      const me = await converter(org, { assign: false, canOwn: false });
      const c = await leadToConvert(org, customer, admin.id, { owner: owner.id });

      const job = await convert(await me.api(), c);

      expect(job.salesperson_id).toBeNull();
    });

    it('a lead with no Owner gives an empty Sold By and the converter is not credited, whatever the converter can do', async () => {
      const { org, admin, customer } = await fx.newOrg();
      for (const assign of [true, false]) {
        const me = await converter(org, { assign, canOwn: true });
        const c = await leadToConvert(org, customer, admin.id, {});

        const job = await convert(await me.api(), c);

        expect(job.salesperson_id, `assign ${assign}`).toBeNull();
      }
    });
  });

  describe('Dispatcher when the lead\'s Dispatcher cannot be carried over', () => {
    type DispatcherCase = { name: string; make: (org: string) => Promise<Person | null> };
    const dispatcherCases: DispatcherCase[] = [
      { name: 'Can be a dispatcher is off', make: cannotDispatch },
      { name: 'is inactive', make: (org) => personWith(org, { can_be_dispatcher: true }, 'TECHNICIAN', { active: false }) },
      { name: 'the lead has none', make: async () => null },
    ];

    it.each(dispatcherCases.map((d) => [d.name, d] as const))('the converter is the Dispatcher when they can be one, when %s', async (_name, dispatcherCase) => {
      const { org, admin, customer } = await fx.newOrg();
      const dispatcher = await dispatcherCase.make(org);
      const me = await converter(org, { assign: false, canDispatch: true });
      const c = await leadToConvert(org, customer, admin.id, { dispatcher: dispatcher?.id });

      const job = await convert(await me.api(), c);

      expect(job.dispatcher_id).toBe(me.id);
    });

    it.each(dispatcherCases.map((d) => [d.name, d] as const))('the Dispatcher is empty when the converter cannot be one, when %s', async (_name, dispatcherCase) => {
      const { org, admin, customer } = await fx.newOrg();
      const dispatcher = await dispatcherCase.make(org);
      const me = await converter(org, { assign: true, canDispatch: false });
      const c = await leadToConvert(org, customer, admin.id, { dispatcher: dispatcher?.id });

      const job = await convert(await me.api(), c);

      expect(job.dispatcher_id).toBeNull();
    });
  });

  describe('crew', () => {
    it('the new job has no crew on any visit and the walkthrough performers are not on it', async () => {
      const { org, admin, customer } = await fx.newOrg();
      const performer = await personWith(org, { can_be_on_crew: true }, 'TECHNICIAN');
      const owner = await canOwn(org);
      const me = await converter(org, { assign: true });
      const c = await leadToConvert(org, customer, admin.id, { owner: owner.id, walkthroughCrew: [performer.id] });

      const job = await convert(await me.api(), c);

      const onTheJob = await db.visitAssignee.findMany({ where: { visit: { job_id: job.id } }, select: { user_id: true } });
      expect(onTheJob).toEqual([]);
      // The walkthrough keeps its own crew: the lead's visit is untouched.
      const onTheLead = await db.visitAssignee.findMany({ where: { visit: { lead_id: c.lead } }, select: { user_id: true } });
      expect(onTheLead.map((a) => a.user_id)).toEqual([performer.id]);
    });

    it('a person attached only to the lead, a walkthrough performer, cannot open the converted job', async () => {
      const { org, admin, customer } = await fx.newOrg();
      const performer = await personWith(org, { can_be_on_crew: true, jobs_scope: 'attached', leads_scope: 'attached' }, 'TECHNICIAN');
      const me = await converter(org, { assign: true });
      const c = await leadToConvert(org, customer, admin.id, { walkthroughCrew: [performer.id] });

      const job = await convert(await me.api(), c);

      const asPerformer = await performer.api();
      expect((await asPerformer.get(`/api/jobs/${job.id}`)).status).toBeGreaterThanOrEqual(403);
      // Holding a slot on the job is what lets them in.
      await db.job.update({ where: { id: job.id }, data: { dispatcher_id: performer.id } });
      expect((await asPerformer.get(`/api/jobs/${job.id}`)).status).toBe(200);
    });
  });

  describe('copies, not links', () => {
    it('a later change of the lead\'s Owner or Dispatcher leaves the job\'s Sold By and Dispatcher unchanged', async () => {
      const { org, admin, customer } = await fx.newOrg();
      const owner = await canOwn(org, { name: 'owner-first' });
      const dispatcher = await canDispatch(org, { name: 'dispatcher-first' });
      const nextOwner = await canOwn(org, { name: 'owner-next' });
      const nextDispatcher = await canDispatch(org, { name: 'dispatcher-next' });
      const me = await converter(org, { assign: true });
      const c = await leadToConvert(org, customer, admin.id, { owner: owner.id, dispatcher: dispatcher.id });
      const job = await convert(await me.api(), c);

      const asAdmin = await fx.signedInAs(admin);
      expect((await asAdmin.post(`/api/leads/${c.lead}/assign`, { assigned_to: nextOwner.id })).status).toBe(200);
      expect((await asAdmin.post(`/api/leads/${c.lead}/dispatcher`, { dispatcher_id: nextDispatcher.id })).status).toBe(200);

      const after = await db.job.findUniqueOrThrow({ where: { id: job.id }, select: { salesperson_id: true, dispatcher_id: true } });
      expect(after.salesperson_id).toBe(owner.id);
      expect(after.dispatcher_id).toBe(dispatcher.id);
    });
  });

  describe('history on the new job', () => {
    it('records a copied value as copied from the lead', async () => {
      const { org, admin, customer } = await fx.newOrg();
      const owner = await canOwn(org, { name: 'Olive' });
      const dispatcher = await canDispatch(org, { name: 'Dana' });
      const me = await converter(org, { assign: true });
      const c = await leadToConvert(org, customer, admin.id, { owner: owner.id, dispatcher: dispatcher.id });

      const job = await convert(await me.api(), c);

      const events = await peopleEvents(job.id);
      expect(events.soldBy).toHaveLength(1);
      expect(events.soldBy[0]!.description).toContain('Olive');
      expect(events.soldBy[0]!.description).toContain('copied from the lead');
      expect(events.soldBy[0]!.metadata).toMatchObject({ from: null, to: owner.id, source: 'lead' });
      expect(events.dispatcher).toHaveLength(1);
      expect(events.dispatcher[0]!.description).toContain('Dana');
      expect(events.dispatcher[0]!.description).toContain('copied from the lead');
      expect(events.dispatcher[0]!.metadata).toMatchObject({ from: null, to: dispatcher.id, source: 'lead' });
    });

    it('records a converter fallback as set to the person converting', async () => {
      const { org, admin, customer } = await fx.newOrg();
      const owner = await cannotOwn(org);
      const dispatcher = await cannotDispatch(org);
      const me = await converter(org, { assign: false, canOwn: true, canDispatch: true });
      const c = await leadToConvert(org, customer, admin.id, { owner: owner.id, dispatcher: dispatcher.id });

      const job = await convert(await me.api(), c);

      const events = await peopleEvents(job.id);
      expect(events.soldBy).toHaveLength(1);
      expect(events.soldBy[0]!.description).toContain('set to the person converting');
      expect(events.soldBy[0]!.metadata).toMatchObject({ to: me.id, source: 'converter' });
      expect(events.dispatcher).toHaveLength(1);
      expect(events.dispatcher[0]!.description).toContain('set to the person converting');
      expect(events.dispatcher[0]!.metadata).toMatchObject({ to: me.id, source: 'converter' });
    });

    it('records a Sold By left for the converter to choose as left empty to choose', async () => {
      const { org, admin, customer } = await fx.newOrg();
      const owner = await cannotOwn(org);
      const me = await converter(org, { assign: true, canOwn: true });
      const c = await leadToConvert(org, customer, admin.id, { owner: owner.id });

      const job = await convert(await me.api(), c);

      const events = await peopleEvents(job.id);
      expect(events.soldBy).toHaveLength(1);
      expect(events.soldBy[0]!.description).toContain('left empty to choose');
      expect(events.soldBy[0]!.metadata).toMatchObject({ to: null, source: 'left_empty' });
    });

    it('writes nothing about a slot that was never set', async () => {
      const { org, admin, customer } = await fx.newOrg();
      const me = await converter(org, { assign: false });
      const c = await leadToConvert(org, customer, admin.id, {});

      const job = await convert(await me.api(), c);

      const events = await peopleEvents(job.id);
      expect(events.soldBy).toEqual([]);
      expect(events.dispatcher).toEqual([]);
    });
  });
});
