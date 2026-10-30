/* =============================================================================
   Roles & Permissions, PRD 3, slice S03.11 - change or clear a job's Sold By on the Team card, with history.

   POST /api/jobs/:id/sold-by sets, changes or clears the Sold By stored on the job. Assign people to jobs
   decides who may write it (the same switch as the Dispatcher), slot eligibility decides who may be named
   (Can own leads / be Sold By, active), every change writes a timeline event and an audit entry, and a
   Dispatcher change on a job is mirrored onto the lead it came from by the job's own lead reference.

   Everything goes through the public interface: the job routes, called as people on custom roles (never a
   built-in role name) holding exactly the switch values under test. Real migrated database
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
import { setRoleSwitchValues } from '../lib/permissions/switches/store';

const suite = realClient ? describe : describe.skip;

suite('changing or clearing a job\'s Sold By (real database)', () => {
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
    opts: { base?: Role; name?: string; active?: boolean } = {},
  ): Promise<Person & { api: () => Promise<Api> }> {
    const key = `sold-by-role-${++sequence}`;
    const base = opts.base ?? 'DISPATCHER';
    const role = await fx.addCustomRole(org, key, base);
    await setRoleSwitchValues({
      organizationId: org, roleKey: key, values: { leads_scope: 'all', jobs_scope: 'all', view_jobs: true, ...values }, actorId: null, reason: 'manual',
    });
    const person = await fx.addUser(org, opts.name ?? `p${sequence}`, base, { customRoleId: role.id });
    if (opts.active === false) await db.user.update({ where: { id: person.id }, data: { is_active: false } });
    return Object.assign(person, { api: () => fx.signedInAs(person) });
  }

  const soldByOf = async (jobId: string) => (await db.job.findUniqueOrThrow({ where: { id: jobId }, select: { salesperson_id: true } })).salesperson_id;
  const soldByWrite = (api: Api, jobId: string, soldById: string | null) => api.post(`/api/jobs/${jobId}/sold-by`, { sold_by_id: soldById });
  /** The audit write is fire-and-forget after the response, so wait for it. */
  async function auditRows(org: string, jobId: string, action: string, expected: number) {
    let rows = await db.auditLog.findMany({ where: { org_id: org, action, resource_id: jobId } });
    for (let i = 0; i < 60 && rows.length < expected; i += 1) {
      await new Promise((r) => setTimeout(r, 50));
      rows = await db.auditLog.findMany({ where: { org_id: org, action, resource_id: jobId } });
    }
    return rows;
  }

  describe('Assign people to jobs decides who may write it', () => {
    it('lets a custom role with the switch set, change and clear Sold By, and refuses one without it, whatever the role is based on', async () => {
      const { org, customer } = await fx.newOrg();
      const first = await fx.addUser(org, `first${++sequence}`, 'SALES');
      const second = await personWith(org, { can_own_leads: true }, { base: 'TECHNICIAN' });
      for (const base of ['TECHNICIAN', 'SALES', 'DISPATCHER'] as const) {
        const holder = await personWith(org, { assign_people_to_jobs: true }, { base });
        const without = await personWith(org, { assign_people_to_jobs: false }, { base });
        const job = await fx.addJob(org, customer);

        const refused = await soldByWrite(await without.api(), job.id, first.id);
        expect(refused.status, `${base} without`).toBe(403);
        expect(await soldByOf(job.id), `${base} without`).toBeNull();

        const api = await holder.api();
        expect((await soldByWrite(api, job.id, first.id)).status, `${base} set`).toBe(200);
        expect(await soldByOf(job.id), `${base} set`).toBe(first.id);
        const changed = await soldByWrite(api, job.id, second.id);
        expect(changed.status, `${base} change`).toBe(200);
        expect(changed.body.job.salesperson.id, `${base} change`).toBe(second.id);
        expect(await soldByOf(job.id), `${base} change`).toBe(second.id);
        const cleared = await soldByWrite(api, job.id, null);
        expect(cleared.status, `${base} clear`).toBe(200);
        expect(cleared.body.job.salesperson, `${base} clear`).toBeNull();
        expect(await soldByOf(job.id), `${base} clear`).toBeNull();
      }
    });

    it("refuses a user on the Sales preset, including their own credit on a job from their own lead", async () => {
      const { org, customer } = await fx.newOrg();
      const seller = await fx.addUser(org, `seller${++sequence}`, 'SALES');
      const other = await fx.addUser(org, `other${++sequence}`, 'SALES');
      const lead = await fx.addLead(org, customer, { owner: seller.id });
      const job = await fx.addJob(org, customer, { fromLead: lead.id, soldBy: seller.id });
      const api = await fx.signedInAs(seller);

      expect((await soldByWrite(api, job.id, null)).status).toBe(403);
      expect((await soldByWrite(api, job.id, other.id)).status).toBe(403);
      expect(await soldByOf(job.id)).toBe(seller.id);
    });

    it("does not let the job's creator with the switch off write it", async () => {
      const { org, customer } = await fx.newOrg();
      const me = await personWith(org, { assign_people_to_jobs: false, can_own_leads: true }, { base: 'TECHNICIAN' });
      const job = await fx.addJob(org, customer, { createdBy: me.id, soldBy: me.id, crew: [me.id] });
      expect((await soldByWrite(await me.api(), job.id, null)).status).toBe(403);
      expect(await soldByOf(job.id)).toBe(me.id);
    });
  });

  describe('who may be named', () => {
    it('refuses a person whose Can own leads / be Sold By is off, even on the Dispatcher base, and accepts one with it on, even on the Technician base', async () => {
      const { org, customer } = await fx.newOrg();
      const holder = await personWith(org, { assign_people_to_jobs: true });
      const api = await holder.api();
      const off = await personWith(org, { can_own_leads: false, can_be_dispatcher: true }, { base: 'DISPATCHER' });
      const on = await personWith(org, { can_own_leads: true, can_be_dispatcher: false }, { base: 'TECHNICIAN' });
      const job = await fx.addJob(org, customer);

      const refused = await soldByWrite(api, job.id, off.id);
      expect(refused.status).toBe(400);
      expect(refused.body.error).toBe("This person can't own leads or be Sold By.");
      expect(await soldByOf(job.id)).toBeNull();

      expect((await soldByWrite(api, job.id, on.id)).status).toBe(200);
      expect(await soldByOf(job.id)).toBe(on.id);
    });

    it('refuses an inactive person with the plain message', async () => {
      const { org, customer } = await fx.newOrg();
      const holder = await personWith(org, { assign_people_to_jobs: true });
      const gone = await personWith(org, { can_own_leads: true }, { active: false });
      const job = await fx.addJob(org, customer);

      const refused = await soldByWrite(await holder.api(), job.id, gone.id);
      expect(refused.status).toBe(400);
      expect(refused.body.error).toBe('This person is inactive.');
      expect(await soldByOf(job.id)).toBeNull();
    });

    it("keeps the seller a job already has when the same person is named again, even after their switch went off", async () => {
      const { org, customer } = await fx.newOrg();
      const holder = await personWith(org, { assign_people_to_jobs: true });
      const seller = await personWith(org, { can_own_leads: false });
      const job = await fx.addJob(org, customer, { soldBy: seller.id });

      expect((await soldByWrite(await holder.api(), job.id, seller.id)).status).toBe(200);
      expect(await soldByOf(job.id)).toBe(seller.id);
    });

    it("answers 404 for a person from another company", async () => {
      const { org, customer } = await fx.newOrg();
      const stranger = await fx.newOrg();
      const holder = await personWith(org, { assign_people_to_jobs: true });
      const job = await fx.addJob(org, customer);

      expect((await soldByWrite(await holder.api(), job.id, stranger.admin.id)).status).toBe(404);
      expect(await soldByOf(job.id)).toBeNull();
    });
  });

  describe('clearing', () => {
    it('leaves the Sold By empty on the job page even though the lead it came from has an Owner, and nothing refills it', async () => {
      const setup = await fx.newOrg();
      const { org, customer } = setup;
      const leadOwner = await fx.addUser(org, `owner${++sequence}`, 'SALES');
      const lead = await fx.addLead(org, customer, { owner: leadOwner.id });
      const job = await fx.addJob(org, customer, { fromLead: lead.id, soldBy: leadOwner.id });
      const holder = await personWith(org, { assign_people_to_jobs: true });

      expect((await soldByWrite(await holder.api(), job.id, null)).status).toBe(200);

      const admin = await fx.signedInAs(setup.admin);
      // An unrelated write on the job (and a second read) must not bring the Owner back.
      expect((await admin.post(`/api/jobs/${job.id}/dispatcher`, { dispatcher_id: null })).status).toBe(200);
      const detail = await admin.get(`/api/jobs/${job.id}`);
      expect(detail.status).toBe(200);
      expect(detail.body.job.salesperson).toBeNull();
      expect(await soldByOf(job.id)).toBeNull();
    });
  });

  describe('history', () => {
    it('writes a job timeline event with who, from and to for a set, a change and a clear, and an audit entry each time', async () => {
      const { org, customer } = await fx.newOrg();
      const holder = await personWith(org, { assign_people_to_jobs: true }, { name: 'Hollis' });
      const first = await fx.addUser(org, 'Firstseller', 'SALES');
      const second = await fx.addUser(org, 'Secondseller', 'SALES');
      const job = await fx.addJob(org, customer);
      const api = await holder.api();

      await soldByWrite(api, job.id, first.id);
      await soldByWrite(api, job.id, second.id);
      await soldByWrite(api, job.id, null);

      const events = await db.timelineEvent.findMany({
        where: { organization_id: org, entity_type: 'JOB', entity_id: job.id, event_type: 'SOLD_BY_CHANGED' },
        orderBy: { created_at: 'asc' },
      });
      expect(events).toHaveLength(3);
      expect(events.every((e) => e.created_by === holder.id)).toBe(true);
      expect(events.every((e) => e.created_at instanceof Date)).toBe(true);
      expect(events[0]!.description).toContain('Firstseller Tester');
      expect(events[0]!.metadata).toEqual({ from: null, to: first.id });
      expect(events[1]!.description).toContain('Firstseller Tester');
      expect(events[1]!.description).toContain('Secondseller Tester');
      expect(events[1]!.metadata).toEqual({ from: first.id, to: second.id });
      expect(events[2]!.description).toContain('cleared');
      expect(events[2]!.description).toContain('Secondseller Tester');
      expect(events[2]!.metadata).toEqual({ from: second.id, to: null });

      const audits = await auditRows(org, job.id, 'job.sold_by_set', 3);
      expect(audits.map((a) => a.metadata)).toEqual(expect.arrayContaining([
        { from: null, to: first.id }, { from: first.id, to: second.id }, { from: second.id, to: null },
      ]));
      expect(audits.every((a) => a.actor_id === holder.id)).toBe(true);
    });

    it('writes nothing when the Sold By did not change', async () => {
      const { org, customer } = await fx.newOrg();
      const holder = await personWith(org, { assign_people_to_jobs: true });
      const seller = await fx.addUser(org, `seller${++sequence}`, 'SALES');
      const job = await fx.addJob(org, customer, { soldBy: seller.id });
      const api = await holder.api();

      expect((await soldByWrite(api, job.id, seller.id)).status).toBe(200);
      const none = await fx.addJob(org, customer);
      expect((await soldByWrite(api, none.id, null)).status).toBe(200);

      expect(await db.timelineEvent.count({ where: { organization_id: org, event_type: 'SOLD_BY_CHANGED' } })).toBe(0);
    });

    it("mirrors a Dispatcher change on a job built from several estimates onto the originating lead's history", async () => {
      const { org, customer } = await fx.newOrg();
      const holder = await personWith(org, { assign_people_to_jobs: true });
      const dispatcher = await personWith(org, { can_be_dispatcher: true });
      const lead = await fx.addLead(org, customer);
      // A multi-estimate job has no single estimate; only its own lead reference reaches the lead.
      const job = await fx.addJob(org, customer);
      await db.job.update({ where: { id: job.id }, data: { lead_id: lead.id } });
      expect((await db.job.findUniqueOrThrow({ where: { id: job.id } })).estimate_id).toBeNull();

      const res = await (await holder.api()).post(`/api/jobs/${job.id}/dispatcher`, { dispatcher_id: dispatcher.id });
      expect(res.status).toBe(200);

      const mirrored = await db.timelineEvent.findMany({
        where: { organization_id: org, entity_type: 'LEAD', entity_id: lead.id, event_type: 'DISPATCHER_CHANGED' },
      });
      expect(mirrored).toHaveLength(1);
      expect(mirrored[0]!.created_by).toBe(holder.id);
    });

    it('still mirrors for a job that only has its anchor estimate pointing at the lead', async () => {
      const { org, customer } = await fx.newOrg();
      const holder = await personWith(org, { assign_people_to_jobs: true });
      const dispatcher = await personWith(org, { can_be_dispatcher: true });
      const lead = await fx.addLead(org, customer);
      const job = await fx.addJob(org, customer, { fromLead: lead.id });
      await db.job.update({ where: { id: job.id }, data: { lead_id: null } });

      expect((await (await holder.api()).post(`/api/jobs/${job.id}/dispatcher`, { dispatcher_id: dispatcher.id })).status).toBe(200);

      expect(await db.timelineEvent.count({
        where: { organization_id: org, entity_type: 'LEAD', entity_id: lead.id, event_type: 'DISPATCHER_CHANGED' },
      })).toBe(1);
    });
  });
});
