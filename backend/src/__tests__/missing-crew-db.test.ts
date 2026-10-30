/* =============================================================================
   Roles & Permissions, PRD 3, slice S03.6 - the Missing crew predicate.

   Booked job visits and booked walkthroughs (a time is set, not cancelled, not finished) that start in
   the next 7 days with nobody on their crew, on a job that is not Cancelled and not Completed or later,
   or on an open lead; counted only over the jobs and leads the viewer can open. The module is the
   public interface (PRD 9's tile, Needs Attention item and Schedule filter all read it), so the
   tests call it as a viewer and look at what it counts.

   Real migrated database (TEST_DATABASE_URL); the suite skips when it is unset. Every org it creates is
   removed again.
   ========================================================================== */

import { randomUUID } from 'crypto';
import { describe, it, expect, afterAll, vi } from 'vitest';
import type { JobStatus, LeadStatus, PrismaClient } from '@prisma/client';

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
import { countMissingCrew, findMissingCrew } from '../lib/missingCrew';
import { JOB_STATUS_ORDER } from '../lib/job-status-order';
import { LEAD_STATUS_ORDER } from '../services/lead-status-options';

const suite = realClient ? describe : describe.skip;

suite('Missing crew predicate (real database)', () => {
  const db = realClient as PrismaClient;
  // The predicate never goes through the app, so the fixture is only used to build rows.
  const fx = switchFixture(db, async () => (await import('../app.js')).default as never);
  afterAll(() => fx.cleanup());

  let sequence = 0;

  /** The person as the request layer hands them to the permission code. */
  const asViewer = async (person: Person): Promise<PermissionUser> =>
    (await db.user.findUniqueOrThrow({
      where: { id: person.id },
      select: { id: true, role: true, organization_id: true, custom_role_id: true, custom_role: { select: { key: true } }, department_id: true, location_id: true },
    })) as PermissionUser;

  /** A person on a fresh custom role holding exactly these switch values (on top of the Dispatcher base). */
  async function personWith(org: string, values: Record<string, boolean | string>): Promise<Person> {
    const key = `crew-role-${++sequence}`;
    const role = await fx.addCustomRole(org, key, 'DISPATCHER');
    await setRoleSwitchValues({ organizationId: org, roleKey: key, values, actorId: null, reason: 'manual' });
    return fx.addUser(org, `p${sequence}`, 'DISPATCHER', { customRoleId: role.id });
  }

  /** A job with no visits yet, so a test decides exactly which visit it has. */
  async function jobWithStatus(org: string, customer: string, status: JobStatus, opts: { soldBy?: string; dispatcher?: string } = {}) {
    const job = await fx.addJob(org, customer, { soldBy: opts.soldBy, dispatcher: opts.dispatcher });
    if (status !== 'SCHEDULED') await db.job.update({ where: { id: job.id }, data: { status } });
    return job;
  }

  async function leadWithStatus(org: string, customer: string, status: LeadStatus, opts: { owner?: string } = {}) {
    const lead = await fx.addLead(org, customer, { owner: opts.owner });
    if (status !== 'NEW') await db.lead.update({ where: { id: lead.id }, data: { status } });
    return lead;
  }

  /**
   * A booked visit on a job or a lead, starting `daysFromNow` days from now (a negative number is
   * in the past), with this crew. Written directly because the fixture numbers every visit 1.
   */
  async function addVisit(
    org: string,
    opts: { jobId?: string; leadId?: string; crew?: string[]; daysFromNow?: number; at?: Date },
  ): Promise<string> {
    const id = randomUUID();
    const start = opts.at ?? new Date(Date.now() + (opts.daysFromNow ?? 1) * 86_400_000);
    const siblings = await db.visit.count({ where: opts.jobId ? { job_id: opts.jobId } : { lead_id: opts.leadId } });
    await db.visit.create({
      data: {
        id, organization_id: org, job_id: opts.jobId ?? null, lead_id: opts.leadId ?? null,
        purpose: opts.jobId ? 'WORK' : 'WALKTHROUGH', visit_seq: siblings + 1, status: 'SCHEDULED',
        scheduled_at: start, scheduled_end: new Date(start.getTime() + 3_600_000),
      },
    });
    for (const user of opts.crew ?? []) await db.visitAssignee.create({ data: { visit_id: id, user_id: user, organization_id: org } });
    return id;
  }
  const walkthrough = (org: string, leadId: string, opts: { crew?: string[]; daysFromNow?: number; at?: Date } = {}) =>
    addVisit(org, { leadId, ...opts });
  const jobVisit = (org: string, jobId: string, opts: { crew?: string[]; daysFromNow?: number; at?: Date } = {}) =>
    addVisit(org, { jobId, ...opts });

  /** Switch values that turn a View switch off together with every switch that needs it, read from the catalog. */
  // The View switch off, and everything that needs it, directly or through another switch that does.
  const viewOff = (view: 'view_jobs' | 'view_leads'): Record<string, boolean> => {
    const off: string[] = [view];
    for (let i = 0; i < off.length; i += 1) {
      for (const s of SWITCH_CATALOG) if (s.kind === 'toggle' && s.requires.includes(off[i]!) && !off.includes(s.key)) off.push(s.key);
    }
    return Object.fromEntries(off.map((key) => [key, false]));
  };

  const missing = async (viewer: PermissionUser) => (await findMissingCrew(viewer)).map((v) => v.id).sort();

  describe('what is counted', () => {
    it('counts a job visit and a walkthrough with nobody on them starting in 6 days', async () => {
      const { org, customer, admin } = await fx.newOrg();
      const job = await jobWithStatus(org, customer, 'SCHEDULED');
      const lead = await leadWithStatus(org, customer, 'WALKTHROUGH_SCHEDULED');
      const visit = await jobVisit(org, job.id, { daysFromNow: 6 });
      const walk = await walkthrough(org, lead.id, { daysFromNow: 6 });

      const viewer = await asViewer(admin);
      expect(await missing(viewer)).toEqual([visit, walk].sort());
      expect(await countMissingCrew(viewer)).toBe(2);
    });

    it('does not count a visit starting in 8 days, nor one with someone on it', async () => {
      const { org, customer, admin } = await fx.newOrg();
      const tech = await fx.addUser(org, 'tech', 'TECHNICIAN');
      const job = await jobWithStatus(org, customer, 'SCHEDULED');
      const lead = await leadWithStatus(org, customer, 'NEW');
      await jobVisit(org, job.id, { daysFromNow: 8 });
      await walkthrough(org, lead.id, { daysFromNow: 8 });
      await jobVisit(org, job.id, { daysFromNow: 3, crew: [tech.id] });
      await walkthrough(org, lead.id, { daysFromNow: 3, crew: [tech.id] });

      expect(await countMissingCrew(await asViewer(admin))).toBe(0);
    });

    it('ends the window with the 7th calendar day on the company\'s clock, not 168 hours from now', async () => {
      const { org, customer, admin } = await fx.newOrg();
      await db.organization.update({ where: { id: org }, data: { timezone: 'America/New_York' } });
      const job = await jobWithStatus(org, customer, 'SCHEDULED');
      // 8:00 AM on Oct 12 in New York. The 7th day is Oct 18; 168 hours from now would reach 8:00 AM on Oct 19.
      const now = new Date('2026-10-12T12:00:00.000Z');
      const lateOnDay7 = await jobVisit(org, job.id, { at: new Date('2026-10-19T03:30:00.000Z') }); // 11:30 PM Oct 18
      await jobVisit(org, job.id, { at: new Date('2026-10-19T04:30:00.000Z') }); // 12:30 AM Oct 19: the 8th day
      await jobVisit(org, job.id, { at: new Date('2026-10-19T11:00:00.000Z') }); // inside 168 hours, still the 8th day

      const viewer = await asViewer(admin);
      expect((await findMissingCrew(viewer, { now })).map((v) => v.id)).toEqual([lateOnDay7]);
      expect(await countMissingCrew(viewer, { now })).toBe(1);
    });

    it('does not count a visit that already started, because it is not starting in the next 7 days', async () => {
      const { org, customer, admin } = await fx.newOrg();
      const job = await jobWithStatus(org, customer, 'SCHEDULED');
      const started = await jobVisit(org, job.id, { daysFromNow: -0.5 });
      await db.visit.update({ where: { id: started }, data: { status: 'IN_PROGRESS' } });

      expect(await countMissingCrew(await asViewer(admin))).toBe(0);
    });
  });

  describe('what is not counted', () => {
    it('leaves out a cancelled visit and a finished visit, on a job and on a lead', async () => {
      const { org, customer, admin } = await fx.newOrg();
      const job = await jobWithStatus(org, customer, 'SCHEDULED');
      const lead = await leadWithStatus(org, customer, 'WALKTHROUGH_SCHEDULED');
      const visits = [await jobVisit(org, job.id), await walkthrough(org, lead.id)];
      const other = [await jobVisit(org, job.id, { daysFromNow: 2 }), await walkthrough(org, lead.id, { daysFromNow: 2 })];

      await db.visit.updateMany({ where: { id: { in: visits } }, data: { status: 'CANCELLED', cancelled_at: new Date() } });
      await db.visit.updateMany({ where: { id: { in: other } }, data: { status: 'COMPLETED' } });

      expect(await countMissingCrew(await asViewer(admin))).toBe(0);
    });

    it('counts a visit that is under way (en route, on site, in progress) the same as a booked one', async () => {
      const { org, customer, admin } = await fx.newOrg();
      const job = await jobWithStatus(org, customer, 'SCHEDULED');
      const underWay: string[] = [];
      for (const [i, status] of (['EN_ROUTE', 'ON_SITE', 'IN_PROGRESS'] as const).entries()) {
        const id = await jobVisit(org, job.id, { daysFromNow: 1 + i });
        await db.visit.update({ where: { id }, data: { status } });
        underWay.push(id);
      }

      expect(await missing(await asViewer(admin))).toEqual(underWay.sort());
    });

    // The cut-off comes from the status order, not from a list of names (job-status-order.test.ts fails
    // when a status is added without being placed), so a status PRD 6 adds after Completed stays out.
    it('leaves out a visit on a Cancelled job, and on every job status at or past Completed', async () => {
      const { org, customer, admin } = await fx.newOrg();
      const completedAt = JOB_STATUS_ORDER.indexOf('COMPLETED');
      const live = JOB_STATUS_ORDER.slice(0, completedAt);
      const done = JOB_STATUS_ORDER.slice(completedAt);
      expect(done).toContain('CANCELLED');

      const counted: string[] = [];
      for (const status of live) {
        const job = await jobWithStatus(org, customer, status);
        counted.push(await jobVisit(org, job.id));
      }
      for (const status of done) {
        const job = await jobWithStatus(org, customer, status);
        await jobVisit(org, job.id);
      }

      expect(await missing(await asViewer(admin))).toEqual(counted.sort());
    });

    it('leaves out a walkthrough on a Won or Lost lead, and counts one on every open lead', async () => {
      const { org, customer, admin } = await fx.newOrg();
      const wonAt = LEAD_STATUS_ORDER.indexOf('WON');
      const counted: string[] = [];
      for (const status of LEAD_STATUS_ORDER.slice(0, wonAt)) {
        const lead = await leadWithStatus(org, customer, status);
        counted.push(await walkthrough(org, lead.id));
      }
      for (const status of ['WON', 'LOST'] as const) {
        const lead = await leadWithStatus(org, customer, status);
        await walkthrough(org, lead.id);
      }

      expect(await missing(await asViewer(admin))).toEqual(counted.sort());
    });

    it('leaves out a walkthrough that has people and no time', async () => {
      const { org, customer, admin } = await fx.newOrg();
      const tech = await fx.addUser(org, 'tech', 'TECHNICIAN');
      const lead = await leadWithStatus(org, customer, 'NEW');
      const toBeScheduled = await walkthrough(org, lead.id, { crew: [tech.id] });
      await db.visit.update({ where: { id: toBeScheduled }, data: { scheduled_at: null, scheduled_end: null } });

      expect(await countMissingCrew(await asViewer(admin))).toBe(0);
    });

    it('leaves out a visit with no time at all, crew or not', async () => {
      const { org, customer, admin } = await fx.newOrg();
      const lead = await leadWithStatus(org, customer, 'NEW');
      const unbooked = await walkthrough(org, lead.id);
      await db.visit.update({ where: { id: unbooked }, data: { scheduled_at: null, scheduled_end: null } });

      expect(await countMissingCrew(await asViewer(admin))).toBe(0);
    });
  });

  describe('who is crew', () => {
    it('counts a job that has a Sold By and a Dispatcher but an empty visit crew', async () => {
      const { org, customer, admin } = await fx.newOrg();
      const seller = await fx.addUser(org, 'sam', 'SALES');
      const dispatcher = await fx.addUser(org, 'dee', 'DISPATCHER');
      const job = await jobWithStatus(org, customer, 'SCHEDULED', { soldBy: seller.id, dispatcher: dispatcher.id });
      const visit = await jobVisit(org, job.id);

      expect(await missing(await asViewer(admin))).toEqual([visit]);
    });

    it('counts a walkthrough on a lead that has an Owner and an assignee but nobody on the walkthrough', async () => {
      const { org, customer, admin } = await fx.newOrg();
      const owner = await fx.addUser(org, 'olive', 'SALES');
      const lead = await fx.addLead(org, customer, { owner: owner.id, assignees: [owner.id] });
      const visit = await walkthrough(org, lead.id);

      expect(await missing(await asViewer(admin))).toEqual([visit]);
    });
  });

  describe('whose records are counted', () => {
    it('counts only the jobs and leads the viewer can open', async () => {
      const { org, customer } = await fx.newOrg();
      const me = await personWith(org, { jobs_scope: 'attached', leads_scope: 'attached', view_jobs: true, view_leads: true });
      const someoneElse = await fx.addUser(org, 'other', 'SALES');

      const mineJob = await jobWithStatus(org, customer, 'SCHEDULED', { soldBy: me.id });
      const theirJob = await jobWithStatus(org, customer, 'SCHEDULED', { soldBy: someoneElse.id });
      const mineLead = await leadWithStatus(org, customer, 'NEW', { owner: me.id });
      const theirLead = await leadWithStatus(org, customer, 'NEW', { owner: someoneElse.id });
      const visible = [await jobVisit(org, mineJob.id), await walkthrough(org, mineLead.id)];
      await jobVisit(org, theirJob.id);
      await walkthrough(org, theirLead.id);

      const viewer = await asViewer(me);
      expect(await missing(viewer)).toEqual(visible.sort());
      expect(await countMissingCrew(viewer)).toBe(2);
    });

    it('counts a crewless visit for a viewer who is attached to the job another way, though not through this visit', async () => {
      const { org, customer } = await fx.newOrg();
      const me = await personWith(org, { jobs_scope: 'attached', view_jobs: true });
      const job = await jobWithStatus(org, customer, 'SCHEDULED', { dispatcher: me.id });
      const visit = await jobVisit(org, job.id);

      expect(await missing(await asViewer(me))).toEqual([visit]);
    });

    it('counts nothing on jobs for a viewer without View jobs, and nothing on leads without View leads', async () => {
      const { org, customer } = await fx.newOrg();
      const noJobs = await personWith(org, { ...viewOff('view_jobs'), view_leads: true, leads_scope: 'all' });
      const noLeads = await personWith(org, { ...viewOff('view_leads'), view_jobs: true, jobs_scope: 'all' });
      const job = await jobWithStatus(org, customer, 'SCHEDULED');
      const lead = await leadWithStatus(org, customer, 'NEW');
      const jobsVisit = await jobVisit(org, job.id);
      const leadsVisit = await walkthrough(org, lead.id);

      expect(await missing(await asViewer(noJobs))).toEqual([leadsVisit]);
      expect(await missing(await asViewer(noLeads))).toEqual([jobsVisit]);
    });

    it('does not count another company\'s crewless visits, even for an admin', async () => {
      const mine = await fx.newOrg();
      const theirs = await fx.newOrg();
      const theirJob = await jobWithStatus(theirs.org, theirs.customer, 'SCHEDULED');
      await jobVisit(theirs.org, theirJob.id);

      expect(await countMissingCrew(await asViewer(mine.admin))).toBe(0);
    });
  });

  describe('the list the tile reads', () => {
    it('returns the soonest first and honours a limit, while the count stays the whole number', async () => {
      const { org, customer, admin } = await fx.newOrg();
      const job = await jobWithStatus(org, customer, 'SCHEDULED');
      const later = await jobVisit(org, job.id, { daysFromNow: 5 });
      const soonest = await jobVisit(org, job.id, { daysFromNow: 1 });
      const middle = await jobVisit(org, job.id, { daysFromNow: 3 });

      const viewer = await asViewer(admin);
      expect((await findMissingCrew(viewer)).map((v) => v.id)).toEqual([soonest, middle, later]);
      expect((await findMissingCrew(viewer, { take: 1 })).map((v) => v.id)).toEqual([soonest]);
      expect(await countMissingCrew(viewer)).toBe(3);
    });
  });
});
