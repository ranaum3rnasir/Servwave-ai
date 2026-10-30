/* =============================================================================
   Roles & Permissions, PRD 6, slice S06.27 (scenario pass 3 fix) - the scheduling alerts through the VISIT doors.

   Job assigned to you, Job rescheduled and Unassigned from you were only ever raised by the older doors (the assign route and the
   two assignees routes). The doors the Schedule page and the visit dialog use, PATCH /api/jobs/:id/visits/:visitId (a move, a
   crew change) and POST /api/jobs/:id/visits (a new visit with its crew), booked, moved and re-crewed visits and told nobody. So did
   the job edit (PATCH /api/jobs/:id) when it moved the job's window. Every one of those now raises the same alerts the older doors
   do, through the same senders, with the same rules, which the cases below pin through the routes and the notification rows they
   leave behind, as people on custom roles holding exactly the switches under test:

   - a visit moved to another start: "Job rescheduled" to the job's people (the crew interrupted); a move that changes nothing
     raises nothing; a move that also names new crew says "assigned" and not "rescheduled" (the assign door's rule)
   - a person put on a visit: "assigned to you" in the named person's wording and "Dana was assigned to J1" for everyone else
   - a person taken off the last visit they were on: "Unassigned from you", personal, named only by the job number; taken off one
     trip while still on another: personal, naming the trip
   - restating the crew a visit already has raises nothing; the person who did it is never told
   - one change through two doors writes one alert, not two (the second door sees nobody newly added)

   Real migrated database (TEST_DATABASE_URL); the suite skips when it is unset. The client holds ONE connection, as the hosted
   database does, so a query that leaves the transaction's client would hang. Every org it creates is removed again.
   ========================================================================== */

import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import type { PrismaClient, Role } from '@prisma/client';

const { realClient } = vi.hoisted(() => {
  const clientAt = (url: string) => {
    const { PrismaClient } = require('@prisma/client') as typeof import('@prisma/client');
    const pooled = new URL(url);
    pooled.searchParams.set('connection_limit', '1');
    pooled.searchParams.set('pool_timeout', '10');
    return new PrismaClient({ datasources: { db: { url: pooled.toString() } } });
  };
  const dbUrl = process.env.TEST_DATABASE_URL;
  return { realClient: dbUrl ? clientAt(dbUrl) : undefined };
});

// The suite-wide setup mocks the app's client; here it is the real one.
vi.mock('../lib/prisma', () => ({ prisma: realClient }));

import { switchFixture, type Person } from './permission-switches-fixture';
import { setRoleSwitchValues } from '../lib/permissions/switches/store';
import { SWITCH_CATALOG, type SwitchValue } from '../lib/permissions/switches/catalog';
import { reviewAttentionSettled } from '../services/notifications/reviewAttentionQueue';

const suite = realClient ? describe : describe.skip;

/** Every switch in the catalog off (a choice at its first option, a list empty), so a case turns on exactly the ones it is about. */
const ALL_OFF: Record<string, SwitchValue> = Object.fromEntries(
  SWITCH_CATALOG.map((s) => [s.key, s.kind === 'choice' ? s.choices![0]! : s.kind === 'list' ? [] : false]),
);

const slots = { can_be_on_crew: true, can_own_leads: true, can_be_dispatcher: true };
const opensJobs = { view_jobs: true, jobs_scope: 'all', ...slots };
const stepValues = { ...opensJobs, assign_people_to_jobs: true };
/** Books, moves and re-crews visits: Schedule visits for the time, Assign people to jobs for the crew. */
const schedulerValues = { ...opensJobs, schedule_visits: true, assign_people_to_jobs: true, assign_work_to_others: true };

const ASSIGNED = 'dispatch.job_assigned';
const RESCHEDULED = 'dispatch.job_rescheduled';
const UNASSIGNED = 'dispatch.job_unassigned';

/** The name an alert gives a person: the fixture makes everyone "<name> Tester". */
const nameOf = (p: Person) => `${p.email.slice(0, p.email.lastIndexOf('-'))} Tester`;
const soon = (days: number) => new Date(Date.now() + days * 86_400_000).toISOString();

suite('the scheduling alerts through the visit doors (real database)', () => {
  const db = realClient as PrismaClient;
  const fx = switchFixture(db, async () => (await import('../app.js')).default as never);
  // Loading the whole app is slow on a loaded machine.
  beforeAll(async () => {
    await import('../app.js');
  }, 120_000);
  afterAll(async () => {
    await fx.cleanup();
  });
  afterEach(() => vi.restoreAllMocks());

  let sequence = 0;

  /** A person on a fresh custom role holding exactly these switch values (every other switch off). */
  async function personWith(org: string, values: Record<string, SwitchValue>, base: Role = 'DISPATCHER'): Promise<Person> {
    const key = `visit-door-role-${++sequence}`;
    const role = await fx.addCustomRole(org, key, base);
    await setRoleSwitchValues({ organizationId: org, roleKey: key, values: { ...ALL_OFF, ...values }, actorId: null, reason: 'manual' });
    return fx.addUser(org, `v${sequence}`, base, { customRoleId: role.id });
  }

  /** A technician who sees only the jobs they are on, so being taken off a job is what closes it to them. */
  const technician = (org: string) => personWith(org, { view_jobs: true, jobs_scope: 'attached', ...slots }, 'TECHNICIAN');

  /** A company with nobody but built people, so only they can be alerted. */
  async function quietOrg() {
    const world = await fx.newOrg();
    await db.user.update({ where: { id: world.admin.id }, data: { is_active: false } });
    return world;
  }

  const jobNumberOf = async (id: string) => (await db.job.findUniqueOrThrow({ where: { id }, select: { job_number: true } })).job_number;

  const alertsFor = (verb: string, objectId: string) =>
    db.notification.findMany({ where: { object_id: objectId, verb }, include: { recipients: true }, orderBy: { created_at: 'asc' } });
  type Alerts = Awaited<ReturnType<typeof alertsFor>>;
  const recipientsOf = (rows: Alerts) => rows.flatMap((n) => n.recipients.map((r) => r.recipient_id)).sort();
  const ids = (...people: Person[]) => people.map((p) => p.id).sort();
  const titleFor = (rows: Alerts, person: Person) => rows.find((n) => n.recipients.some((r) => r.recipient_id === person.id))?.title;
  const rowFor = (rows: Alerts, person: Person) => rows.flatMap((n) => n.recipients).find((r) => r.recipient_id === person.id);
  const allThree = async (jobId: string) => ({
    assigned: await alertsFor(ASSIGNED, jobId),
    rescheduled: await alertsFor(RESCHEDULED, jobId),
    unassigned: await alertsFor(UNASSIGNED, jobId),
  });

  /** A job with a crowd around it: the people the chain would reach, one visit holding `crew`. */
  async function crowdedJob(org: string, customer: string, crew: Person[]) {
    const soldBy = await personWith(org, opensJobs);
    const follower = await personWith(org, { ...opensJobs, alert_every_job: true });
    const holder = await personWith(org, stepValues);
    const job = await fx.addJob(org, customer, { status: 'SCHEDULED', crew: crew.map((p) => p.id), soldBy: soldBy.id });
    return { job, soldBy, follower, holder, number: await jobNumberOf(job.id) };
  }

  describe('PATCH /api/jobs/:id/visits/:visitId, a move', () => {
    it('tells the job\'s people it was rescheduled: the crew interrupted, the rest on the feed, never the person who moved it', async () => {
      const { org, customer } = await quietOrg();
      const me = await personWith(org, schedulerValues);
      const tech = await technician(org);
      const { job, soldBy, follower, holder, number } = await crowdedJob(org, customer, [tech]);

      const res = await (await fx.signedInAs(me)).patch(`/api/jobs/${job.id}/visits/${job.visitId}`, {
        scheduled_start: soon(6), scheduled_end: soon(6.1), force: true,
      });
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      await reviewAttentionSettled();

      const { assigned, rescheduled, unassigned } = await allThree(job.id);
      expect(recipientsOf(rescheduled)).toEqual(ids(tech, soldBy, follower, holder));
      for (const who of [tech, soldBy, follower, holder]) expect(titleFor(rescheduled, who)).toBe(`${number} rescheduled`);
      expect(rowFor(rescheduled, tech)).toMatchObject({ priority: 'INTERRUPT' });
      expect(rowFor(rescheduled, soldBy)).toMatchObject({ priority: 'FEED' });
      expect(recipientsOf(rescheduled)).not.toContain(me.id);
      expect(assigned).toEqual([]);
      expect(unassigned).toEqual([]);
    });

    it('a move that changes nothing (the same window sent again) raises nothing', async () => {
      const { org, customer } = await quietOrg();
      const me = await personWith(org, schedulerValues);
      const tech = await technician(org);
      const { job } = await crowdedJob(org, customer, [tech]);
      const visit = await db.visit.findUniqueOrThrow({ where: { id: job.visitId! } });

      const res = await (await fx.signedInAs(me)).patch(`/api/jobs/${job.id}/visits/${job.visitId}`, {
        scheduled_start: visit.scheduled_at!.toISOString(), scheduled_end: visit.scheduled_end!.toISOString(), force: true,
      });
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      await reviewAttentionSettled();

      expect(await allThree(job.id)).toEqual({ assigned: [], rescheduled: [], unassigned: [] });
    });

    it('a move that also puts a new person on the visit says "assigned" to everyone and does not also say "rescheduled"', async () => {
      const { org, customer } = await quietOrg();
      const me = await personWith(org, schedulerValues);
      const tech = await technician(org);
      const added = await technician(org);
      const { job, soldBy, number } = await crowdedJob(org, customer, [tech]);

      const res = await (await fx.signedInAs(me)).patch(`/api/jobs/${job.id}/visits/${job.visitId}`, {
        scheduled_start: soon(7), scheduled_end: soon(7.1), assignee_ids: [tech.id, added.id], force: true,
      });
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      await reviewAttentionSettled();

      const { assigned, rescheduled } = await allThree(job.id);
      expect(titleFor(assigned, added)).toBe(`${number} assigned to you`);
      expect(titleFor(assigned, soldBy)).toBe(`${nameOf(added)} was assigned to ${number}`);
      expect(rescheduled).toEqual([]);
    });
  });

  describe('PATCH /api/jobs/:id/visits/:visitId, a crew change', () => {
    it('a person put on the visit is told "assigned to you" and everyone else the chain reaches is told who was assigned', async () => {
      const { org, customer } = await quietOrg();
      const me = await personWith(org, schedulerValues);
      const tech = await technician(org);
      const added = await technician(org);
      const { job, soldBy, follower, holder, number } = await crowdedJob(org, customer, [tech]);

      const res = await (await fx.signedInAs(me)).patch(`/api/jobs/${job.id}/visits/${job.visitId}`, { assignee_ids: [tech.id, added.id] });
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      await reviewAttentionSettled();

      const { assigned, rescheduled, unassigned } = await allThree(job.id);
      expect(recipientsOf(assigned)).toEqual(ids(added, tech, soldBy, follower, holder));
      expect(titleFor(assigned, added)).toBe(`${number} assigned to you`);
      expect(rowFor(assigned, added)).toMatchObject({ priority: 'INTERRUPT', needs_action: false });
      for (const other of [tech, soldBy, follower, holder]) {
        expect(titleFor(assigned, other), other.email).toBe(`${nameOf(added)} was assigned to ${number}`);
      }
      expect(rescheduled).toEqual([]);
      expect(unassigned).toEqual([]);
    });

    it('a person taken off the last visit they were on is told "Unassigned from you", by the job number only, and nobody else is', async () => {
      const { org, customer } = await quietOrg();
      const me = await personWith(org, schedulerValues);
      const removed = await technician(org);
      const kept = await personWith(org, opensJobs);
      const { job, soldBy, follower, holder, number } = await crowdedJob(org, customer, [removed, kept]);

      const res = await (await fx.signedInAs(me)).patch(`/api/jobs/${job.id}/visits/${job.visitId}`, { assignee_ids: [kept.id] });
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      await reviewAttentionSettled();

      const { unassigned, assigned } = await allThree(job.id);
      expect(unassigned).toHaveLength(1);
      expect(recipientsOf(unassigned)).toEqual(ids(removed));
      expect(unassigned[0]!.title).toBe(`${number} unassigned from you`);
      expect(unassigned[0]!.body).toBeNull();
      expect(rowFor(unassigned, removed)).toMatchObject({ priority: 'INTERRUPT', needs_action: false });
      for (const who of [soldBy, follower, holder, kept]) expect(recipientsOf(unassigned)).not.toContain(who.id);
      expect(assigned).toEqual([]);
    });

    it('an empty crew takes everyone off: each person on it is told, and only they', async () => {
      const { org, customer } = await quietOrg();
      const me = await personWith(org, schedulerValues);
      const first = await technician(org);
      const second = await technician(org);
      const { job, holder } = await crowdedJob(org, customer, [first, second]);

      const res = await (await fx.signedInAs(me)).patch(`/api/jobs/${job.id}/visits/${job.visitId}`, { assignee_ids: [] });
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      await reviewAttentionSettled();

      const { unassigned } = await allThree(job.id);
      expect(recipientsOf(unassigned)).toEqual(ids(first, second));
      expect(recipientsOf(unassigned)).not.toContain(holder.id);
    });

    it('taken off ONE visit but still on another: the alert names the visit and is still personal', async () => {
      const { org, customer } = await quietOrg();
      const me = await personWith(org, schedulerValues);
      const removed = await personWith(org, opensJobs);
      const { job, follower } = await crowdedJob(org, customer, [removed]);
      await fx.addVisit(org, { jobId: job.id, crew: [removed.id], daysFromNow: 4, seq: 2 });

      const res = await (await fx.signedInAs(me)).patch(`/api/jobs/${job.id}/visits/${job.visitId}`, { assignee_ids: [] });
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      await reviewAttentionSettled();

      const { unassigned } = await allThree(job.id);
      expect(recipientsOf(unassigned)).toEqual(ids(removed));
      expect(unassigned[0]!.title).toMatch(/ Visit 1 .* — you were removed from this visit$/);
      expect(recipientsOf(unassigned)).not.toContain(follower.id);
    });

    it('restating the crew the visit already has raises nothing, and a person who takes themselves off is not told', async () => {
      const { org, customer } = await quietOrg();
      const me = await personWith(org, schedulerValues);
      const kept = await personWith(org, opensJobs);
      const { job } = await crowdedJob(org, customer, [me, kept]);
      const api = await fx.signedInAs(me);

      expect((await api.patch(`/api/jobs/${job.id}/visits/${job.visitId}`, { assignee_ids: [me.id, kept.id] })).status).toBe(200);
      expect((await api.patch(`/api/jobs/${job.id}/visits/${job.visitId}`, { assignee_ids: [kept.id] })).status).toBe(200);
      await reviewAttentionSettled();

      expect(await allThree(job.id)).toEqual({ assigned: [], rescheduled: [], unassigned: [] });
    });

    it('one change through two doors writes one alert: the second door sees nobody newly added', async () => {
      const { org, customer } = await quietOrg();
      const me = await personWith(org, schedulerValues);
      const tech = await technician(org);
      const added = await technician(org);
      const { job } = await crowdedJob(org, customer, [tech]);
      const api = await fx.signedInAs(me);

      expect((await api.patch(`/api/jobs/${job.id}/visits/${job.visitId}`, { assignee_ids: [tech.id, added.id] })).status).toBe(200);
      expect((await api.post(`/api/jobs/${job.id}/visits/${job.visitId}/assignees`, { assignee_ids: [tech.id, added.id] })).status).toBe(200);
      await reviewAttentionSettled();

      const { assigned } = await allThree(job.id);
      expect(assigned.flatMap((n) => n.recipients).filter((r) => r.recipient_id === added.id)).toHaveLength(1);
    });
  });

  describe('POST /api/jobs/:id/visits, a new visit', () => {
    it('a new visit with its crew tells the crew "assigned to you" and the others who was assigned', async () => {
      const { org, customer } = await quietOrg();
      const me = await personWith(org, schedulerValues);
      const tech = await technician(org);
      const named = await technician(org);
      const { job, soldBy, number } = await crowdedJob(org, customer, [tech]);

      const res = await (await fx.signedInAs(me)).post(`/api/jobs/${job.id}/visits`, {
        scheduled_start: soon(9), scheduled_end: soon(9.1), is_all_day: false, assignee_ids: [named.id], force: true,
      });
      expect(res.status, JSON.stringify(res.body)).toBe(201);
      await reviewAttentionSettled();

      const { assigned, rescheduled } = await allThree(job.id);
      expect(titleFor(assigned, named)).toBe(`${number} assigned to you`);
      expect(titleFor(assigned, soldBy)).toBe(`${nameOf(named)} was assigned to ${number}`);
      expect(rescheduled).toEqual([]);
    });

    it('a first booking with nobody on it is the job\'s "rescheduled" notice, as the assign door gives it', async () => {
      const { org, customer } = await quietOrg();
      const me = await personWith(org, schedulerValues);
      const holder = await personWith(org, stepValues);
      const job = await fx.addJob(org, customer, { status: 'UNSCHEDULED' });

      const res = await (await fx.signedInAs(me)).post(`/api/jobs/${job.id}/visits`, {
        scheduled_start: soon(5), scheduled_end: soon(5.1), is_all_day: false, assignee_ids: [],
      });
      expect(res.status, JSON.stringify(res.body)).toBe(201);
      await reviewAttentionSettled();

      const { assigned, rescheduled } = await allThree(job.id);
      expect(assigned).toEqual([]);
      expect(recipientsOf(rescheduled)).toEqual(ids(holder));
    });

    it('a later visit with nobody on it, beside one that already stands, moves nothing for the job and raises nothing', async () => {
      const { org, customer } = await quietOrg();
      const me = await personWith(org, schedulerValues);
      const tech = await technician(org);
      const { job } = await crowdedJob(org, customer, [tech]);

      const res = await (await fx.signedInAs(me)).post(`/api/jobs/${job.id}/visits`, {
        scheduled_start: soon(12), scheduled_end: soon(12.1), is_all_day: false, assignee_ids: [],
      });
      expect(res.status, JSON.stringify(res.body)).toBe(201);
      await reviewAttentionSettled();

      expect(await allThree(job.id)).toEqual({ assigned: [], rescheduled: [], unassigned: [] });
    });
  });

  describe('the job edit, PATCH /api/jobs/:id, moving the job\'s window', () => {
    it('tells the job\'s people it was rescheduled, and a save that moves nothing raises nothing', async () => {
      const { org, customer } = await quietOrg();
      const me = await personWith(org, { ...schedulerValues, edit_jobs: true });
      const tech = await technician(org);
      const { job, soldBy, number } = await crowdedJob(org, customer, [tech]);
      const visit = await db.visit.findUniqueOrThrow({ where: { id: job.visitId! } });
      const api = await fx.signedInAs(me);

      const same = await api.patch(`/api/jobs/${job.id}`, {
        scheduled_start: visit.scheduled_at!.toISOString(), scheduled_end: visit.scheduled_end!.toISOString(), force: true,
      });
      expect(same.status, JSON.stringify(same.body)).toBe(200);
      await reviewAttentionSettled();
      expect(await alertsFor(RESCHEDULED, job.id)).toEqual([]);

      const moved = await api.patch(`/api/jobs/${job.id}`, { scheduled_start: soon(8), scheduled_end: soon(8.1), force: true });
      expect(moved.status, JSON.stringify(moved.body)).toBe(200);
      await reviewAttentionSettled();

      const rescheduled = await alertsFor(RESCHEDULED, job.id);
      expect(titleFor(rescheduled, tech)).toBe(`${number} rescheduled`);
      expect(titleFor(rescheduled, soldBy)).toBe(`${number} rescheduled`);
      expect(recipientsOf(rescheduled)).not.toContain(me.id);
    });
  });

  describe('the older doors are unchanged', () => {
    it('the assign door still says "assigned to you" and the per-visit assignees door still names the trip on a removal', async () => {
      const { org, customer } = await quietOrg();
      const me = await personWith(org, schedulerValues);
      const named = await technician(org);
      const removed = await personWith(org, opensJobs);
      const { job, soldBy, number } = await crowdedJob(org, customer, [removed]);
      await fx.addVisit(org, { jobId: job.id, crew: [removed.id], daysFromNow: 4, seq: 2 });
      const api = await fx.signedInAs(me);

      const assign = await api.post(`/api/jobs/${job.id}/assign`, { assignee_ids: [removed.id, named.id], scheduled_start: soon(5), scheduled_end: soon(5.1) });
      expect(assign.status, JSON.stringify(assign.body)).toBe(200);
      // The alert reads the job after the response; let it go out before the person is taken off again.
      await reviewAttentionSettled();
      const off = await api.post(`/api/jobs/${job.id}/visits/${job.visitId}/assignees`, { assignee_ids: [] });
      expect(off.status, JSON.stringify(off.body)).toBe(200);
      await reviewAttentionSettled();

      const { assigned, unassigned } = await allThree(job.id);
      expect(titleFor(assigned, named)).toBe(`${number} assigned to you`);
      expect(titleFor(assigned, soldBy)).toBe(`${nameOf(named)} was assigned to ${number}`);
      expect(unassigned.map((n) => n.title).some((t) => / Visit \d+ .* — you were removed from this visit$/.test(t))).toBe(true);
    });
  });
});
