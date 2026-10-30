/* =============================================================================
   Roles & Permissions, PRD 9, slice S09.12 - the Schedule's "No crew" filter.

   The Schedule board reads the jobs list (a window of full instants) and the leads list (a walkthrough window).
   Asked for `missing_crew=true`, each answers with only what the shared Missing crew test counts: booked, timed,
   live job visits and walkthroughs that start in the next 7 days with nobody on them, on a job that is not Cancelled
   and not completed-or-later, or on an open lead, over the jobs and leads the person can open. The narrowing is the
   server's: a job or lead row carries only its crewless visits, so a card the person did not ask for never reaches
   the browser.

   Everything goes through the public interface: the routes, called as people on custom roles built from switches
   (never a built-in role name) holding exactly the switch values under test. Real migrated database
   (TEST_DATABASE_URL); the suite skips when it is unset. Every org it creates is removed again.
   ========================================================================== */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
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
import { presetSwitchSet, SWITCH_CATALOG } from '../lib/permissions/switches/catalog';
import { setRoleSwitchValues } from '../lib/permissions/switches/store';
import { COMPLETED_OR_LATER_JOB_STATUSES, JOB_STATUS_ORDER } from '../lib/job-status-order';
import { LEAD_STATUS_ORDER, OPEN_LEAD_STATUSES } from '../services/lead-status-options';

const suite = realClient ? describe : describe.skip;

suite('the Schedule "No crew" filter (real database)', () => {
  const db = realClient as PrismaClient;
  const fx = switchFixture(db, async () => (await import('../app.js')).default as never);
  // Loading the whole app is slow on a loaded machine.
  beforeAll(async () => {
    await import('../app.js');
  }, 120_000);
  afterAll(() => fx.cleanup());

  type Api = Awaited<ReturnType<typeof fx.signedInAs>>;
  let sequence = 0;

  /** The switches that need this View switch, directly or through another one that does, read from the catalog. */
  const viewOff = (view: 'view_jobs' | 'view_leads'): Record<string, boolean> => {
    const off: string[] = [view];
    for (let i = 0; i < off.length; i += 1) {
      for (const s of SWITCH_CATALOG) if (s.kind === 'toggle' && s.requires.includes(off[i]!) && !off.includes(s.key)) off.push(s.key);
    }
    return Object.fromEntries(off.map((key) => [key, false]));
  };

  /** A person on a fresh custom role holding the Dispatcher preset's values with these changed. */
  async function personWith(org: string, values: Record<string, boolean | string>): Promise<Person & { api: () => Promise<Api> }> {
    const key = `nocrew-role-${++sequence}`;
    const role = await fx.addCustomRole(org, key, 'DISPATCHER');
    await setRoleSwitchValues({
      organizationId: org, roleKey: key, values: { ...presetSwitchSet('DISPATCHER'), view_jobs: true, view_leads: true, ...values }, actorId: null, reason: 'manual',
    });
    const person = await fx.addUser(org, `n${sequence}`, 'DISPATCHER', { customRoleId: role.id });
    return Object.assign(person, { api: () => fx.signedInAs(person) });
  }

  /** The window the board asks for: full instants around the visits the tests book (a few days ahead). */
  const window = () => {
    const after = new Date(Date.now() - 86_400_000).toISOString();
    const before = new Date(Date.now() + 10 * 86_400_000).toISOString();
    return { after: encodeURIComponent(after), before: encodeURIComponent(before) };
  };

  /** Every status the board could ask for, so the filter, not the request, is what leaves a job out. */
  const ALL_JOB_STATUSES = JOB_STATUS_ORDER.map((s) => `status=${s}`).join('&');

  /** The jobs feed with the filter on: each job in it with the visit ids it carries. */
  async function jobFeed(api: Api, filter = 'missing_crew=true') {
    const { after, before } = window();
    const res = await api.get(`/api/jobs?${ALL_JOB_STATUSES}&scheduled_after=${after}&scheduled_before=${before}&${filter}&limit=500`);
    expect(res.status).toBe(200);
    return new Map<string, string[]>(
      res.body.jobs.map((j: { id: string; visits: { id: string }[] }) => [j.id, j.visits.map((v) => v.id).sort()]),
    );
  }

  /** The leads feed with the filter on: each lead in it with the walkthrough visit ids it carries. */
  async function leadFeed(api: Api, filter = 'missing_crew=true') {
    const { after, before } = window();
    const res = await api.get(`/api/leads?walkthrough_after=${after}&walkthrough_before=${before}&${filter}&limit=500`);
    expect(res.status).toBe(200);
    return new Map<string, string[]>(
      res.body.leads.map((l: { id: string; walkthrough_visits: { id: string }[] }) => [l.id, l.walkthrough_visits.map((v) => v.id).sort()]),
    );
  }

  /** A job in this status with no visits yet, so a test decides exactly which it has. */
  async function jobIn(org: string, customer: string, status: JobStatus, opts: { soldBy?: string; dispatcher?: string } = {}) {
    return fx.addJob(org, customer, { status, ...opts });
  }

  async function leadIn(org: string, customer: string, status: LeadStatus, opts: { owner?: string; dispatcher?: string } = {}) {
    const lead = await fx.addLead(org, customer, opts);
    if (status !== 'NEW') await db.lead.update({ where: { id: lead.id }, data: { status } });
    return lead;
  }

  describe('job visits', () => {
    it('shows a booked job visit with nobody on it, and carries only the crewless visits of its job', async () => {
      const { org, customer, admin } = await fx.newOrg();
      const me = await personWith(org, { jobs_scope: 'all' });
      const job = await jobIn(org, customer, 'SCHEDULED');
      const crewed = await fx.addVisit(org, { jobId: job.id, crew: [admin.id], daysFromNow: 1, seq: 1 });
      const crewless = await fx.addVisit(org, { jobId: job.id, crew: [], daysFromNow: 3, seq: 2 });

      const api = await me.api();
      const filtered = await jobFeed(api);
      expect(filtered.get(job.id)).toEqual([crewless]);

      // Without the filter the same request still carries both visits: the narrowing is the filter's, not the feed's.
      const plain = await jobFeed(api, 'x=1');
      expect(plain.get(job.id)).toEqual([crewed, crewless].sort());
    });

    it('leaves out a job whose visits all have crew', async () => {
      const { org, customer, admin } = await fx.newOrg();
      const me = await personWith(org, { jobs_scope: 'all' });
      const job = await jobIn(org, customer, 'SCHEDULED');
      await fx.addVisit(org, { jobId: job.id, crew: [admin.id], daysFromNow: 2 });
      expect((await jobFeed(await me.api())).has(job.id)).toBe(false);
    });

    it('leaves out a cancelled visit, a visit in the past and a visit more than 7 days ahead', async () => {
      const { org, customer } = await fx.newOrg();
      const me = await personWith(org, { jobs_scope: 'all' });
      const cancelled = await jobIn(org, customer, 'SCHEDULED');
      const cancelledVisit = await fx.addVisit(org, { jobId: cancelled.id, crew: [], daysFromNow: 2 });
      await db.visit.update({ where: { id: cancelledVisit }, data: { status: 'CANCELLED' } });
      const past = await jobIn(org, customer, 'SCHEDULED');
      await fx.addVisit(org, { jobId: past.id, crew: [], daysFromNow: -0.5 });
      const far = await jobIn(org, customer, 'SCHEDULED');
      await fx.addVisit(org, { jobId: far.id, crew: [], daysFromNow: 8 });

      const seen = await jobFeed(await me.api());
      for (const job of [cancelled, past, far]) expect(seen.has(job.id)).toBe(false);
    });

    it('leaves out a visit on a Cancelled job and on a job in every completed-or-later status, and shows one on each live status', async () => {
      const { org, customer } = await fx.newOrg();
      const me = await personWith(org, { jobs_scope: 'all' });
      const closed: Array<{ status: JobStatus; id: string }> = [];
      const live: Array<{ status: JobStatus; id: string; visit: string }> = [];
      for (const status of JOB_STATUS_ORDER) {
        const job = await jobIn(org, customer, status);
        const visit = await fx.addVisit(org, { jobId: job.id, crew: [], daysFromNow: 2 });
        const stillLive = status !== 'CANCELLED' && !(COMPLETED_OR_LATER_JOB_STATUSES as readonly string[]).includes(status);
        if (stillLive) live.push({ status, id: job.id, visit });
        else closed.push({ status, id: job.id });
      }
      expect(closed.map((c) => c.status)).toContain('CANCELLED');
      expect(closed.map((c) => c.status)).toEqual(expect.arrayContaining([...COMPLETED_OR_LATER_JOB_STATUSES]));

      const seen = await jobFeed(await me.api());
      for (const job of closed) expect(seen.has(job.id), `${job.status} job on the board`).toBe(false);
      for (const job of live) expect(seen.get(job.id), `${job.status} job on the board`).toEqual([job.visit]);
    });

    it('does not count a job\'s Sold By or Dispatcher as crew', async () => {
      const { org, customer, admin } = await fx.newOrg();
      const me = await personWith(org, { jobs_scope: 'all' });
      const job = await jobIn(org, customer, 'SCHEDULED', { soldBy: admin.id, dispatcher: admin.id });
      const visit = await fx.addVisit(org, { jobId: job.id, crew: [], daysFromNow: 2 });
      expect((await jobFeed(await me.api())).get(job.id)).toEqual([visit]);
    });

    it('stays inside the window the board asks for', async () => {
      const { org, customer } = await fx.newOrg();
      const me = await personWith(org, { jobs_scope: 'all' });
      const job = await jobIn(org, customer, 'SCHEDULED');
      await fx.addVisit(org, { jobId: job.id, crew: [], daysFromNow: 5 });
      const day = (n: number) => encodeURIComponent(new Date(Date.now() + n * 86_400_000).toISOString());
      const res = await (await me.api()).get(`/api/jobs?scheduled_after=${day(1)}&scheduled_before=${day(2)}&missing_crew=true&limit=500`);
      expect(res.status).toBe(200);
      expect(res.body.jobs.map((j: { id: string }) => j.id)).not.toContain(job.id);
    });
  });

  describe('walkthroughs', () => {
    it('shows a booked walkthrough with nobody on it on an open lead, and not one with crew', async () => {
      const { org, customer, admin } = await fx.newOrg();
      const me = await personWith(org, { leads_scope: 'all' });
      const lead = await leadIn(org, customer, 'WALKTHROUGH_SCHEDULED');
      const visit = await fx.addVisit(org, { leadId: lead.id, purpose: 'WALKTHROUGH', crew: [], daysFromNow: 2 });
      const crewedLead = await leadIn(org, customer, 'WALKTHROUGH_SCHEDULED');
      await fx.addVisit(org, { leadId: crewedLead.id, purpose: 'WALKTHROUGH', crew: [admin.id], daysFromNow: 2 });

      const seen = await leadFeed(await me.api());
      expect(seen.get(lead.id)).toEqual([visit]);
      expect(seen.has(crewedLead.id)).toBe(false);
    });

    it('leaves out a walkthrough with performers but no time, and a lead that is no longer open', async () => {
      const { org, customer, admin } = await fx.newOrg();
      const me = await personWith(org, { leads_scope: 'all' });
      const untimed = await leadIn(org, customer, 'CONTACTED');
      await db.visit.create({
        data: {
          organization_id: org, lead_id: untimed.id, purpose: 'WALKTHROUGH', visit_seq: 1, status: 'SCHEDULED', scheduled_at: null,
          assignees: { create: [{ user_id: admin.id, organization_id: org }] },
        },
      });
      const closedIds: string[] = [];
      for (const status of LEAD_STATUS_ORDER.filter((s) => !(OPEN_LEAD_STATUSES as readonly string[]).includes(s))) {
        const lead = await leadIn(org, customer, status);
        await fx.addVisit(org, { leadId: lead.id, purpose: 'WALKTHROUGH', crew: [], daysFromNow: 2 });
        closedIds.push(lead.id);
      }
      expect(closedIds.length).toBeGreaterThan(0);

      const seen = await leadFeed(await me.api());
      expect(seen.has(untimed.id)).toBe(false);
      for (const id of closedIds) expect(seen.has(id)).toBe(false);
    });

    it('leaves out a cancelled walkthrough and one more than 7 days ahead', async () => {
      const { org, customer } = await fx.newOrg();
      const me = await personWith(org, { leads_scope: 'all' });
      const cancelled = await leadIn(org, customer, 'WALKTHROUGH_SCHEDULED');
      const cancelledVisit = await fx.addVisit(org, { leadId: cancelled.id, purpose: 'WALKTHROUGH', crew: [], daysFromNow: 2 });
      await db.visit.update({ where: { id: cancelledVisit }, data: { status: 'CANCELLED' } });
      const far = await leadIn(org, customer, 'WALKTHROUGH_SCHEDULED');
      await fx.addVisit(org, { leadId: far.id, purpose: 'WALKTHROUGH', crew: [], daysFromNow: 8 });

      const seen = await leadFeed(await me.api());
      expect(seen.has(cancelled.id)).toBe(false);
      expect(seen.has(far.id)).toBe(false);
    });

    it('carries only the crewless walkthroughs of a lead that has two', async () => {
      const { org, customer, admin } = await fx.newOrg();
      const me = await personWith(org, { leads_scope: 'all' });
      const lead = await leadIn(org, customer, 'WALKTHROUGH_SCHEDULED');
      await fx.addVisit(org, { leadId: lead.id, purpose: 'WALKTHROUGH', crew: [admin.id], daysFromNow: 1, seq: 1 });
      const crewless = await fx.addVisit(org, { leadId: lead.id, purpose: 'WALKTHROUGH', crew: [], daysFromNow: 3, seq: 2 });
      expect((await leadFeed(await me.api())).get(lead.id)).toEqual([crewless]);
    });

    it('does not count a lead\'s Owner or Dispatcher as crew', async () => {
      const { org, customer, admin } = await fx.newOrg();
      const me = await personWith(org, { leads_scope: 'all' });
      const lead = await leadIn(org, customer, 'WALKTHROUGH_SCHEDULED', { owner: admin.id, dispatcher: admin.id });
      const visit = await fx.addVisit(org, { leadId: lead.id, purpose: 'WALKTHROUGH', crew: [], daysFromNow: 2 });
      expect((await leadFeed(await me.api())).get(lead.id)).toEqual([visit]);
    });
  });

  describe('the person\'s scope', () => {
    it('under Jobs scope Attached, shows a crewless visit on a job the person is Dispatcher of or Sold By, and not one on a job they are not on', async () => {
      const { org, customer, admin } = await fx.newOrg();
      const me = await personWith(org, { jobs_scope: 'attached' });
      const dispatching = await jobIn(org, customer, 'SCHEDULED', { dispatcher: me.id });
      const dispatchingVisit = await fx.addVisit(org, { jobId: dispatching.id, crew: [], daysFromNow: 2 });
      const sold = await jobIn(org, customer, 'SCHEDULED', { soldBy: me.id });
      const soldVisit = await fx.addVisit(org, { jobId: sold.id, crew: [], daysFromNow: 2 });
      const strangers = await jobIn(org, customer, 'SCHEDULED', { dispatcher: admin.id });
      await fx.addVisit(org, { jobId: strangers.id, crew: [], daysFromNow: 2 });

      const api = await me.api();
      const seen = await jobFeed(api);
      expect(seen.get(dispatching.id)).toEqual([dispatchingVisit]);
      expect(seen.get(sold.id)).toEqual([soldVisit]);
      expect(seen.has(strangers.id)).toBe(false);

      // The ordinary Attached board still carries only the visits the person is crewed on: the filter is what adds these.
      const board = await jobFeed(api, 'x=1');
      expect(board.has(dispatching.id)).toBe(false);
    });

    it('under Leads scope Attached, shows a crewless walkthrough on a lead the person owns, and not one on a lead that is not theirs', async () => {
      const { org, customer, admin } = await fx.newOrg();
      const me = await personWith(org, { leads_scope: 'attached' });
      const owned = await leadIn(org, customer, 'WALKTHROUGH_SCHEDULED', { owner: me.id });
      const ownedVisit = await fx.addVisit(org, { leadId: owned.id, purpose: 'WALKTHROUGH', crew: [], daysFromNow: 2 });
      const strangers = await leadIn(org, customer, 'WALKTHROUGH_SCHEDULED', { owner: admin.id });
      await fx.addVisit(org, { leadId: strangers.id, purpose: 'WALKTHROUGH', crew: [], daysFromNow: 2 });

      const seen = await leadFeed(await me.api());
      expect(seen.get(owned.id)).toEqual([ownedVisit]);
      expect(seen.has(strangers.id)).toBe(false);
    });

    it('gives a person with View leads off no walkthroughs and still gives them the job visits', async () => {
      const { org, customer } = await fx.newOrg();
      const me = await personWith(org, { jobs_scope: 'all', ...viewOff('view_leads') });
      const job = await jobIn(org, customer, 'SCHEDULED');
      const jobVisit = await fx.addVisit(org, { jobId: job.id, crew: [], daysFromNow: 2 });
      const lead = await leadIn(org, customer, 'WALKTHROUGH_SCHEDULED');
      await fx.addVisit(org, { leadId: lead.id, purpose: 'WALKTHROUGH', crew: [], daysFromNow: 2 });

      const api = await me.api();
      expect((await jobFeed(api)).get(job.id)).toEqual([jobVisit]);
      const { after, before } = window();
      const res = await api.get(`/api/leads?walkthrough_after=${after}&walkthrough_before=${before}&missing_crew=true&limit=500`);
      const leads: Array<{ id: string }> = res.status === 200 ? res.body.leads : [];
      expect(leads.map((l) => l.id)).not.toContain(lead.id);
    });

    it('gives a person with View jobs off no job visits and still gives them the walkthroughs', async () => {
      const { org, customer } = await fx.newOrg();
      const me = await personWith(org, { leads_scope: 'all', ...viewOff('view_jobs') });
      const job = await jobIn(org, customer, 'SCHEDULED');
      await fx.addVisit(org, { jobId: job.id, crew: [], daysFromNow: 2 });
      const lead = await leadIn(org, customer, 'WALKTHROUGH_SCHEDULED');
      const walkthrough = await fx.addVisit(org, { leadId: lead.id, purpose: 'WALKTHROUGH', crew: [], daysFromNow: 2 });

      const api = await me.api();
      expect((await leadFeed(api)).get(lead.id)).toEqual([walkthrough]);
      const { after, before } = window();
      const res = await api.get(`/api/jobs?scheduled_after=${after}&scheduled_before=${before}&missing_crew=true&limit=500`);
      const jobs: Array<{ id: string }> = res.status === 200 ? res.body.jobs : [];
      expect(jobs.map((j) => j.id)).not.toContain(job.id);
    });

    it('never crosses companies', async () => {
      const mine = await fx.newOrg();
      const theirs = await fx.newOrg();
      const me = await personWith(mine.org, { jobs_scope: 'all', leads_scope: 'all' });
      const job = await jobIn(theirs.org, theirs.customer, 'SCHEDULED');
      await fx.addVisit(theirs.org, { jobId: job.id, crew: [], daysFromNow: 2 });
      const lead = await leadIn(theirs.org, theirs.customer, 'WALKTHROUGH_SCHEDULED');
      await fx.addVisit(theirs.org, { leadId: lead.id, purpose: 'WALKTHROUGH', crew: [], daysFromNow: 2 });
      const api = await me.api();
      expect((await jobFeed(api)).has(job.id)).toBe(false);
      expect((await leadFeed(api)).has(lead.id)).toBe(false);
    });
  });

  describe('the shared Missing crew test', () => {
    it('shows exactly the visits the Missing crew count counts', async () => {
      const { org, customer, admin } = await fx.newOrg();
      const me = await personWith(org, { jobs_scope: 'all', leads_scope: 'all' });
      const a = await jobIn(org, customer, 'SCHEDULED');
      const aVisit = await fx.addVisit(org, { jobId: a.id, crew: [], daysFromNow: 1 });
      const b = await jobIn(org, customer, 'IN_PROGRESS');
      const bVisit = await fx.addVisit(org, { jobId: b.id, crew: [], daysFromNow: 6 });
      const c = await jobIn(org, customer, 'SCHEDULED');
      await fx.addVisit(org, { jobId: c.id, crew: [admin.id], daysFromNow: 2 });
      const lead = await leadIn(org, customer, 'WALKTHROUGH_SCHEDULED');
      const walkthrough = await fx.addVisit(org, { leadId: lead.id, purpose: 'WALKTHROUGH', crew: [], daysFromNow: 3 });

      const api = await me.api();
      const shown = [...(await jobFeed(api)).values(), ...(await leadFeed(api)).values()].flat().sort();
      expect(shown).toEqual([aVisit, bVisit, walkthrough].sort());

      const { findMissingCrew } = await import('../lib/missingCrew.js');
      const viewer = await db.user.findUniqueOrThrow({
        where: { id: me.id },
        select: { id: true, role: true, organization_id: true, custom_role_id: true, custom_role: { select: { key: true } }, department_id: true, location_id: true },
      });
      const counted = (await findMissingCrew(viewer as never)).map((v) => v.id).sort();
      expect(shown).toEqual(counted);
    });

    it('ends the board\'s 7 days and the count at the same moment: a visit just inside shows and counts, one just outside does neither', async () => {
      const { org, customer } = await fx.newOrg();
      await db.organization.update({ where: { id: org }, data: { timezone: 'America/New_York' } });
      const me = await personWith(org, { jobs_scope: 'all', leads_scope: 'all' });
      const { missingCrewWindowEnd, findMissingCrew } = await import('../lib/missingCrew.js');
      const { orgDayOf, orgDayStart } = await import('../lib/orgDayRange.js');
      const now = new Date();
      const end = missingCrewWindowEnd(now, 'America/New_York');
      const at = (offsetMinutes: number) => new Date(end.getTime() + offsetMinutes * 60_000);
      const book = async (jobId: string, when: Date, seq: number) => {
        const id = (await fx.addVisit(org, { jobId, crew: [], daysFromNow: 1, seq }));
        await db.visit.update({ where: { id }, data: { scheduled_at: when, scheduled_end: new Date(when.getTime() + 3_600_000) } });
        return id;
      };
      const job = await jobIn(org, customer, 'SCHEDULED');
      const inside = await book(job.id, at(-30), 1);
      await book(job.id, at(30), 2);

      // The board's own window: the start of today to the end of the 7th day, as full instants.
      const boardAfter = encodeURIComponent(orgDayStart(orgDayOf(now, 'America/New_York'), 'America/New_York').toISOString());
      const boardBefore = encodeURIComponent(new Date(end.getTime() - 1).toISOString());
      const api = await me.api();
      const res = await api.get(`/api/jobs?${ALL_JOB_STATUSES}&scheduled_after=${boardAfter}&scheduled_before=${boardBefore}&missing_crew=true&limit=500`);
      expect(res.status).toBe(200);
      const shown = res.body.jobs.flatMap((j: { visits: { id: string }[] }) => j.visits.map((v) => v.id));
      expect(shown).toEqual([inside]);

      // And without the board's own bound, the filter alone still stops at the same moment.
      expect([...(await jobFeed(api)).get(job.id) ?? []]).toEqual([inside]);

      const viewer = await db.user.findUniqueOrThrow({
        where: { id: me.id },
        select: { id: true, role: true, organization_id: true, custom_role_id: true, custom_role: { select: { key: true } }, department_id: true, location_id: true },
      });
      expect((await findMissingCrew(viewer as never, { now })).map((v) => v.id)).toEqual([inside]);
    });
  });
});
