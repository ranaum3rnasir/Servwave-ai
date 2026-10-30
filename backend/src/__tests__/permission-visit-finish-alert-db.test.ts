/* =============================================================================
   Roles & Permissions, PRD 4, slice S04.16 - the visit-finish alert through M6's two-lane chain.

   After a visit is finished one bell alert goes out. Lane 1 is the job's people (Sold By, crew, Dispatcher); lane 2 is
   who must act (the job's Dispatcher, else the Complete jobs holders, else the company's Admins, stopping at the first step
   that finds someone; an Admin holds every switch, so since AL-18 an Admin is found among the Complete jobs holders); holders of Alert me about every job get a copy. "Someone" is active,
   can open the job and is not the person who tapped. Nobody comes from a role list.

   Everything goes through the public interface: the finish route, called as people on custom roles holding exactly the
   switch values under test (every other toggle off), and the notification rows it leaves behind. Real migrated database
   (TEST_DATABASE_URL); the suite skips when it is unset. Every org it creates is removed again.
   ========================================================================== */

import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
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
import { SWITCH_CATALOG } from '../lib/permissions/switches/catalog';
import { logger } from '../lib/logger';

const suite = realClient ? describe : describe.skip;

suite('the visit-finish alert (real database)', () => {
  const db = realClient as PrismaClient;
  const fx = switchFixture(db, async () => (await import('../app.js')).default as never);
  // Loading the whole app is slow on a loaded machine.
  beforeAll(async () => {
    await import('../app.js');
  }, 120_000);
  afterAll(() => fx.cleanup());
  afterEach(() => vi.restoreAllMocks());

  let sequence = 0;

  /** A person on a fresh custom role holding exactly these switch values (every other toggle off). */
  async function personWith(org: string, values: Record<string, boolean | string>, base: Role = 'DISPATCHER'): Promise<Person> {
    const key = `visit-alert-role-${++sequence}`;
    // `is_admin: true` makes the person an Admin (the flag, AL-18): it is not a switch, so it never reaches the role.
    const { is_admin: asAdmin, ...switchValues } = values;
    const role = await fx.addCustomRole(org, key, base);
    const allOff = Object.fromEntries(SWITCH_CATALOG.filter((s) => s.kind === 'toggle').map((s) => [s.key, false]));
    await setRoleSwitchValues({ organizationId: org, roleKey: key, values: { ...allOff, ...switchValues }, actorId: null, reason: 'manual' });
    return fx.addUser(org, `p${sequence}`, base, { customRoleId: role.id, isAdmin: asAdmin === true });
  }

  const opensJobs = { view_jobs: true, jobs_scope: 'all' };
  /** The finisher: on a crew, may start and finish visits. */
  const finisherValues = { ...opensJobs, start_and_finish_visits: true };

  /** A job with two started visits, the finisher on the first; the second is still open. */
  async function jobWithTwoOpenVisits(org: string, customer: string, opts: { crew: string[]; soldBy?: string; dispatcher?: string; secondCrew?: string[] }) {
    const job = await fx.addJob(org, customer, { crew: opts.crew, status: 'IN_PROGRESS', soldBy: opts.soldBy, dispatcher: opts.dispatcher });
    const second = await fx.addVisit(org, { jobId: job.id, crew: opts.secondCrew ?? [], daysFromNow: 5, seq: 2 });
    await db.visit.updateMany({ where: { id: { in: [job.visitId!, second] } }, data: { status: 'IN_PROGRESS', started_at: new Date() } });
    return { id: job.id, first: job.visitId!, second };
  }

  async function finish(who: Person, jobId: string, visitId: string) {
    const api = await fx.signedInAs(who);
    const res = await api.post(`/api/jobs/${jobId}/visits/${visitId}/complete`);
    expect(res.status).toBe(200);
  }

  /** The alerts the job got for its finished visits: who each went to. */
  async function alertsFor(jobId: string) {
    const rows = await db.notification.findMany({
      where: { object_id: jobId, verb: 'job.visit_finished' },
      include: { recipients: true },
      orderBy: { created_at: 'asc' },
    });
    return rows;
  }
  const recipientsOf = (rows: Awaited<ReturnType<typeof alertsFor>>) =>
    rows.flatMap((n) => n.recipients.map((r) => r.recipient_id)).sort();

  it('lane 1 gives Sold By, the rest of the crew and the Dispatcher, never the finisher and never a bystander by role', async () => {
    const { org, customer, admin } = await fx.newOrg();
    await db.user.update({ where: { id: admin.id }, data: { is_active: false } });
    const me = await personWith(org, finisherValues);
    const mate = await personWith(org, opensJobs);
    const onOtherVisit = await personWith(org, opensJobs);
    const soldBy = await personWith(org, opensJobs);
    const dispatcher = await personWith(org, opensJobs);
    // On the built-in Dispatcher role, off the job, with nothing but the right to open every job.
    const bystander = await personWith(org, opensJobs, 'DISPATCHER');
    const job = await jobWithTwoOpenVisits(org, customer, {
      crew: [me.id, mate.id], soldBy: soldBy.id, dispatcher: dispatcher.id, secondCrew: [onOtherVisit.id],
    });

    await finish(me, job.id, job.first);

    const alerts = await alertsFor(job.id);
    expect(alerts).toHaveLength(1);
    expect(recipientsOf(alerts)).toEqual([mate.id, onOtherVisit.id, soldBy.id, dispatcher.id].sort());
    expect(recipientsOf(alerts)).not.toContain(bystander.id);
    expect(recipientsOf(alerts)).not.toContain(me.id);
    expect(alerts[0]!.actor_id).toBe(me.id);
  });

  it('reads "Visit 2 finished on <job>, by <name>", opens the job, and is a bell alert only', async () => {
    const { org, customer } = await fx.newOrg();
    const me = await personWith(org, finisherValues);
    const dispatcher = await personWith(org, opensJobs);
    const job = await jobWithTwoOpenVisits(org, customer, { crew: [], dispatcher: dispatcher.id, secondCrew: [me.id] });
    const row = await db.job.findUniqueOrThrow({ where: { id: job.id }, select: { job_number: true } });

    await finish(me, job.id, job.second);

    const [alert] = await alertsFor(job.id);
    const tapper = await db.user.findUniqueOrThrow({ where: { id: me.id }, select: { first_name: true } });
    expect(alert!.title).toBe(`Visit 2 finished on ${row.job_number}, by ${tapper.first_name}`);
    expect(alert!.needs_action).toBe(false);
    // Clicking it opens the job: the deep link is built from the object, which is the job itself.
    expect(alert!.object_type).toBe('JOB');
    expect(alert!.object_id).toBe(job.id);
    // Bell only: nothing but a notification row is written (no outbound message of any kind).
    expect(alert!.recipients.map((r) => r.recipient_id)).toContain(dispatcher.id);
  });

  it('with no Dispatcher, lane 2 gives every active Complete jobs holder by switch, an Admin included, and says why', async () => {
    const { org, customer, admin } = await fx.newOrg();
    await db.user.update({ where: { id: admin.id }, data: { is_active: false } });
    const me = await personWith(org, finisherValues);
    const completer = await personWith(org, { ...opensJobs, complete_jobs: true });
    const secondCompleter = await personWith(org, { ...opensJobs, complete_jobs: true }, 'TECHNICIAN');
    const gone = await personWith(org, { ...opensJobs, complete_jobs: true });
    await db.user.update({ where: { id: gone.id }, data: { is_active: false } });
    const cannotOpen = await personWith(org, { view_jobs: true, jobs_scope: 'attached', complete_jobs: true });
    const noSwitch = await personWith(org, opensJobs);
    const manager = await personWith(org, { ...opensJobs, is_admin: true, view_users: true });
    const job = await jobWithTwoOpenVisits(org, customer, { crew: [me.id] });

    await finish(me, job.id, job.first);

    const alerts = await alertsFor(job.id);
    // An Admin (the flag) holds every switch, Complete jobs included.
    expect(recipientsOf(alerts)).toEqual([completer.id, secondCompleter.id, manager.id].sort());
    for (const who of [gone, cannotOpen, noSwitch]) expect(recipientsOf(alerts)).not.toContain(who.id);
    expect(alerts[0]!.body).toBe('This job has no Dispatcher.');
  });

  it('with no Dispatcher and no Complete jobs holder on a custom role, lane 2 reaches the Admins, who hold the switch', async () => {
    const { org, customer, admin } = await fx.newOrg();
    await db.user.update({ where: { id: admin.id }, data: { is_active: false } });
    const me = await personWith(org, finisherValues);
    const manager = await personWith(org, { ...opensJobs, is_admin: true, view_users: true });
    const noSwitch = await personWith(org, opensJobs);
    const job = await jobWithTwoOpenVisits(org, customer, { crew: [me.id] });

    await finish(me, job.id, job.first);

    const alerts = await alertsFor(job.id);
    expect(recipientsOf(alerts)).toEqual([manager.id]);
    expect(recipientsOf(alerts)).not.toContain(noSwitch.id);
    // Found at the step, so the why line is the step's.
    expect(alerts[0]!.body).toBe('This job has no Dispatcher.');
  });

  it('with a Dispatcher, lane 2 stops there: Complete jobs holders off the job are not alerted', async () => {
    const { org, customer, admin } = await fx.newOrg();
    await db.user.update({ where: { id: admin.id }, data: { is_active: false } });
    const me = await personWith(org, finisherValues);
    const dispatcher = await personWith(org, opensJobs);
    const completer = await personWith(org, { ...opensJobs, complete_jobs: true });
    const job = await jobWithTwoOpenVisits(org, customer, { crew: [me.id], dispatcher: dispatcher.id });

    await finish(me, job.id, job.first);

    const alerts = await alertsFor(job.id);
    expect(recipientsOf(alerts)).toEqual([dispatcher.id]);
    expect(recipientsOf(alerts)).not.toContain(completer.id);
    // A job with a Dispatcher does not say "no Dispatcher".
    expect(alerts[0]!.body).toBeNull();
  });

  it('a holder of Alert me about every job gets a copy; a person found twice gets one; one who cannot open the job gets none', async () => {
    const { org, customer, admin } = await fx.newOrg();
    await db.user.update({ where: { id: admin.id }, data: { is_active: false } });
    const me = await personWith(org, finisherValues);
    const follower = await personWith(org, { ...opensJobs, alert_every_job: true });
    // Sold By and a follower at once: found by lane 1 and by the copy, alerted once.
    const soldByFollower = await personWith(org, { ...opensJobs, alert_every_job: true });
    const followerWhoCannotOpen = await personWith(org, { view_jobs: true, jobs_scope: 'attached', alert_every_job: true });
    const job = await jobWithTwoOpenVisits(org, customer, { crew: [me.id], soldBy: soldByFollower.id, dispatcher: undefined });
    // No Dispatcher: the fallback also finds the Complete jobs holder, who is also a follower: still one alert.
    const completerFollower = await personWith(org, { ...opensJobs, complete_jobs: true, alert_every_job: true });

    await finish(me, job.id, job.first);

    const alerts = await alertsFor(job.id);
    const got = recipientsOf(alerts);
    expect(got).toEqual([follower.id, soldByFollower.id, completerFollower.id].sort());
    expect(new Set(got).size).toBe(got.length);
    expect(got).not.toContain(followerWhoCannotOpen.id);
  });

  it('never alerts the person who tapped, even when they are the job\'s Dispatcher', async () => {
    const { org, customer, admin } = await fx.newOrg();
    await db.user.update({ where: { id: admin.id }, data: { is_active: false } });
    const me = await personWith(org, { ...finisherValues, alert_every_job: true });
    const mate = await personWith(org, opensJobs);
    const job = await jobWithTwoOpenVisits(org, customer, { crew: [me.id, mate.id], dispatcher: me.id });

    await finish(me, job.id, job.first);

    const alerts = await alertsFor(job.id);
    expect(recipientsOf(alerts)).not.toContain(me.id);
    expect(recipientsOf(alerts)).toContain(mate.id);
  });

  it('skips a deactivated Dispatcher and falls to the Complete jobs holders', async () => {
    const { org, customer, admin } = await fx.newOrg();
    await db.user.update({ where: { id: admin.id }, data: { is_active: false } });
    const me = await personWith(org, finisherValues);
    const dispatcher = await personWith(org, opensJobs);
    await db.user.update({ where: { id: dispatcher.id }, data: { is_active: false } });
    const completer = await personWith(org, { ...opensJobs, complete_jobs: true });
    const job = await jobWithTwoOpenVisits(org, customer, { crew: [me.id], dispatcher: dispatcher.id });

    await finish(me, job.id, job.first);

    const alerts = await alertsFor(job.id);
    expect(recipientsOf(alerts)).toEqual([completer.id]);
  });

  it('logs a chain that finds nobody instead of dropping it silently', async () => {
    const { org, customer, admin } = await fx.newOrg();
    await db.user.update({ where: { id: admin.id }, data: { is_active: false } });
    const me = await personWith(org, finisherValues);
    const job = await jobWithTwoOpenVisits(org, customer, { crew: [me.id] });
    const warn = vi.spyOn(logger, 'warn');

    await finish(me, job.id, job.first);

    expect(await alertsFor(job.id)).toEqual([]);
    expect(warn.mock.calls.some((call) => { const [message, meta] = call as unknown[]; return /visit finish alert/i.test(String(message)) && JSON.stringify(meta).includes(job.id); })).toBe(true);
  });

  it('the last open visit reads "All visits finished: ready to complete", needs action, and counts a cancelled visit as nothing', async () => {
    const { org, customer } = await fx.newOrg();
    const me = await personWith(org, finisherValues);
    const dispatcher = await personWith(org, opensJobs);
    const mate = await personWith(org, opensJobs);
    const job = await jobWithTwoOpenVisits(org, customer, { crew: [me.id, mate.id], dispatcher: dispatcher.id });
    // The second visit is called off, so the first one is the last live visit.
    await db.visit.update({ where: { id: job.second }, data: { status: 'CANCELLED', cancelled_at: new Date() } });

    await finish(me, job.id, job.first);

    const [alert] = await alertsFor(job.id);
    expect(alert!.title).toBe('All visits finished: ready to complete');
    expect(alert!.needs_action).toBe(true);
    const byPerson = new Map(alert!.recipients.map((r) => [r.recipient_id, r]));
    // The person who must act is asked to; a crew mate is only told.
    expect(byPerson.get(dispatcher.id)!.needs_action).toBe(true);
    expect(byPerson.get(mate.id)!.needs_action).toBe(false);
  });

  it('finishing the same visit twice alerts once', async () => {
    const { org, customer } = await fx.newOrg();
    const me = await personWith(org, finisherValues);
    const dispatcher = await personWith(org, opensJobs);
    const job = await jobWithTwoOpenVisits(org, customer, { crew: [me.id], dispatcher: dispatcher.id });

    await finish(me, job.id, job.first);
    await finish(me, job.id, job.first);

    expect(await alertsFor(job.id)).toHaveLength(1);
  });
});
