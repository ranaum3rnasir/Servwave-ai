/* =============================================================================
   Roles & Permissions, PRD 6, slice S06.23 - the "Job completed" alert on M6's two-lane chain.

   Complete lands the job in Office review and one bell alert goes out: "Job completed: J00123 is ready for office
   review". Lane 1 is the job's people (its stored Sold By, crew and Dispatcher); lane 2 is who must act (the job's
   Dispatcher, else the Office review holders who can open the job, else the company's Admins, stopping at the first step
   that finds someone; an Admin holds every switch, so an Admin who can be told is found at the step already, AL-18); holders of Alert me about every job get a copy. "Someone" is active,
   can open the job and is not the person who completed it. Nobody comes from a role name.

   This is the first PRD 6 row moved onto the chain (the chain itself is S04.16's), so the table below carries the
   chain's full checks, one row per sentence of the criteria.

   Everything goes through the public interface: the complete route, called as people on custom roles holding exactly
   the switch values under test (every other toggle off), and the notification rows it leaves behind. Real migrated
   database (TEST_DATABASE_URL); the suite skips when it is unset. Every org it creates is removed again.
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

suite('the job completed alert (real database)', () => {
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
    const key = `job-completed-role-${++sequence}`;
    // `is_admin: true` makes the person an Admin (the flag, AL-18): it is not a switch, so it never reaches the role.
    const { is_admin: asAdmin, ...switchValues } = values;
    const role = await fx.addCustomRole(org, key, base);
    const allOff = Object.fromEntries(SWITCH_CATALOG.filter((s) => s.kind === 'toggle').map((s) => [s.key, false]));
    await setRoleSwitchValues({ organizationId: org, roleKey: key, values: { ...allOff, ...switchValues }, actorId: null, reason: 'manual' });
    return fx.addUser(org, `p${sequence}`, base, { customRoleId: role.id, isAdmin: asAdmin === true });
  }

  const opensJobs = { view_jobs: true, jobs_scope: 'all' };
  /** The completer: may complete any job in their scope. */
  const completerValues = { ...opensJobs, complete_jobs: true };
  const reviewerValues = { ...opensJobs, office_review: true };
  // An Admin (the flag, AL-18): holds every switch, Office review and the copy switches included, and opens every record.
  const adminValues = { ...opensJobs, is_admin: true, view_users: true };

  /** A company with nobody but the completer's own role-less admin switched off, so only built people can be alerted. */
  async function quietOrg() {
    const world = await fx.newOrg();
    await db.user.update({ where: { id: world.admin.id }, data: { is_active: false } });
    return world;
  }

  /** A job in progress with nothing open: the crew is on one finished visit. */
  const liveJob = (org: string, customer: string, opts: { crew?: string[]; soldBy?: string; dispatcher?: string; fromLead?: string }) =>
    fx.addJob(org, customer, { status: 'IN_PROGRESS', pastVisit: true, crew: opts.crew ?? [], soldBy: opts.soldBy, dispatcher: opts.dispatcher, fromLead: opts.fromLead });

  async function complete(who: Person, jobId: string) {
    const api = await fx.signedInAs(who);
    const res = await api.post(`/api/jobs/${jobId}/complete`);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
  }

  /** The alerts the job got for its completion. */
  const alertsFor = (jobId: string) =>
    db.notification.findMany({ where: { object_id: jobId, verb: 'job.completed' }, include: { recipients: true }, orderBy: { created_at: 'asc' } });
  type Alerts = Awaited<ReturnType<typeof alertsFor>>;
  const recipientsOf = (rows: Alerts) => rows.flatMap((n) => n.recipients.map((r) => r.recipient_id)).sort();
  const ids = (...people: Person[]) => people.map((p) => p.id).sort();
  /** The why line one person's alert carries (null when it carries none). */
  const whyFor = (rows: Alerts, person: Person) => rows.find((n) => n.recipients.some((r) => r.recipient_id === person.id))?.body ?? null;

  it('reads "Job completed: <job number> is ready for office review", is a bell alert, and points at the review panel', async () => {
    const { org, customer } = await quietOrg();
    const me = await personWith(org, completerValues);
    const dispatcher = await personWith(org, opensJobs);
    const job = await liveJob(org, customer, { dispatcher: dispatcher.id });
    const row = await db.job.findUniqueOrThrow({ where: { id: job.id }, select: { job_number: true } });

    await complete(me, job.id);

    const [alert] = await alertsFor(job.id);
    expect(alert!.title).toBe(`Job completed: ${row.job_number} is ready for office review`);
    // Priority and "needs action" are what the verb always had, and only the bell is written.
    expect(alert).toMatchObject({ priority: 'FEED', needs_action: false, object_type: 'JOB', object_id: job.id, category: 'JOB' });
    expect(alert!.recipients.every((r) => r.priority === 'FEED' && r.needs_action === false)).toBe(true);
    // The row names the panel inside its record; the page decides whether this person may see it.
    expect((alert!.data as Record<string, unknown>).panel).toBe('review');
  });

  it('with a Dispatcher: lane 1 and the Dispatcher are alerted, and no Office review holder', async () => {
    const { org, customer } = await quietOrg();
    const me = await personWith(org, completerValues);
    const soldBy = await personWith(org, opensJobs);
    const crew = await personWith(org, opensJobs);
    const dispatcher = await personWith(org, opensJobs);
    const reviewer = await personWith(org, reviewerValues);
    const job = await liveJob(org, customer, { crew: [crew.id], soldBy: soldBy.id, dispatcher: dispatcher.id });

    await complete(me, job.id);

    const alerts = await alertsFor(job.id);
    expect(recipientsOf(alerts)).toEqual(ids(soldBy, crew, dispatcher));
    expect(recipientsOf(alerts)).not.toContain(reviewer.id);
    expect(recipientsOf(alerts)).not.toContain(me.id);
  });

  it('without a Dispatcher: lane 1 plus every Office review holder on a custom role who can open the job; an Admin-role person with Office review off is not one', async () => {
    const { org, customer } = await quietOrg();
    const me = await personWith(org, completerValues);
    const soldBy = await personWith(org, opensJobs);
    const reviewer = await personWith(org, reviewerValues);
    const secondReviewer = await personWith(org, reviewerValues, 'TECHNICIAN');
    // Based on the Admin role with Office review off: a role name holds nothing, the switch does.
    const adminReviewOff = await personWith(org, opensJobs, 'ADMIN');
    const cannotOpen = await personWith(org, { view_jobs: true, jobs_scope: 'attached', office_review: true });
    const gone = await personWith(org, reviewerValues);
    await db.user.update({ where: { id: gone.id }, data: { is_active: false } });
    // An Admin holds Office review too (every switch), so they are one of the reviewers.
    const admin = await personWith(org, adminValues);
    const job = await liveJob(org, customer, { soldBy: soldBy.id });

    await complete(me, job.id);

    const alerts = await alertsFor(job.id);
    expect(recipientsOf(alerts)).toEqual(ids(soldBy, reviewer, secondReviewer, admin));
    for (const who of [adminReviewOff, cannotOpen, gone]) expect(recipientsOf(alerts)).not.toContain(who.id);
  });

  it('without a Dispatcher and with no other Office review holder who can open it: the Admins, told as holders of the step', async () => {
    const { org, customer } = await quietOrg();
    const me = await personWith(org, completerValues);
    const admin = await personWith(org, adminValues);
    const cannotOpen = await personWith(org, { view_jobs: true, jobs_scope: 'attached', office_review: true });
    const noSwitch = await personWith(org, opensJobs);
    const job = await liveJob(org, customer, {});

    await complete(me, job.id);

    const alerts = await alertsFor(job.id);
    expect(recipientsOf(alerts)).toEqual(ids(admin));
    expect(recipientsOf(alerts)).not.toContain(cannotOpen.id);
    expect(recipientsOf(alerts)).not.toContain(noSwitch.id);
    // An Admin holds the step, and the "Alert me about every ..." switch too: told once, without the why line (a covering
    // person who also has a copy is told without it), never twice.
    expect(whyFor(alerts, admin)).toBeNull();
    expect(alerts.filter((n) => n.recipients.some((r) => r.recipient_id === admin.id))).toHaveLength(1);
  });

  it('a job with Sold By and crew but no Dispatcher still alerts the step 2 holders', async () => {
    const { org, customer } = await quietOrg();
    const me = await personWith(org, completerValues);
    const soldBy = await personWith(org, opensJobs);
    const crew = await personWith(org, opensJobs);
    const reviewer = await personWith(org, reviewerValues);
    const job = await liveJob(org, customer, { crew: [crew.id], soldBy: soldBy.id });

    await complete(me, job.id);

    expect(recipientsOf(await alertsFor(job.id))).toEqual(ids(soldBy, crew, reviewer));
  });

  describe('a Dispatcher who cannot take the alert sends the chain to step 2 with the matching why line', () => {
    const cases: Array<[string, string, (org: string, dispatcher: Person, me: Person) => Promise<Person>]> = [
      ['is deactivated', "This job's Dispatcher is not available.", async (_org, dispatcher) => {
        await db.user.update({ where: { id: dispatcher.id }, data: { is_active: false } });
        return dispatcher;
      }],
      ['did the action', "This job's Dispatcher made this change.", async (_org, _dispatcher, me) => me],
      ['cannot open the job', "This job's Dispatcher is not available.", // Being the job's Dispatcher attaches them to it, so only a role that cannot see jobs at all cannot open it.
      async (org) => personWith(org, {})],
    ];
    it.each(cases)('a Dispatcher who %s', async (_label, line, makeDispatcher) => {
      const { org, customer } = await quietOrg();
      const me = await personWith(org, completerValues);
      const reviewer = await personWith(org, reviewerValues);
      const dispatcher = await makeDispatcher(org, await personWith(org, opensJobs), me);
      const job = await liveJob(org, customer, { dispatcher: dispatcher.id });

      await complete(me, job.id);

      const alerts = await alertsFor(job.id);
      expect(recipientsOf(alerts)).toContain(reviewer.id);
      expect(whyFor(alerts, reviewer)).toBe(line);
      // The actor is never alerted, even as the job's own Dispatcher.
      expect(recipientsOf(alerts)).not.toContain(me.id);
    });
  });

  it('a person found twice gets one alert', async () => {
    const { org, customer } = await quietOrg();
    const me = await personWith(org, completerValues);
    // Sold By, Office review holder and follower at once.
    const everywhere = await personWith(org, { ...reviewerValues, alert_every_job: true });
    const job = await liveJob(org, customer, { soldBy: everywhere.id });

    await complete(me, job.id);

    const got = recipientsOf(await alertsFor(job.id));
    expect(got).toEqual(ids(everywhere));
  });

  it('copies reach "Alert me about every job" holders on jobs they can open, also when there is a Dispatcher, never on jobs they cannot open; a copy never stops the chain', async () => {
    const { org, customer } = await quietOrg();
    const me = await personWith(org, completerValues);
    const dispatcher = await personWith(org, opensJobs);
    const follower = await personWith(org, { ...opensJobs, alert_every_job: true });
    const blindFollower = await personWith(org, { view_jobs: true, jobs_scope: 'attached', alert_every_job: true });
    const withDispatcher = await liveJob(org, customer, { dispatcher: dispatcher.id });

    await complete(me, withDispatcher.id);

    const first = await alertsFor(withDispatcher.id);
    expect(recipientsOf(first)).toEqual(ids(dispatcher, follower));
    expect(recipientsOf(first)).not.toContain(blindFollower.id);

    // No Dispatcher and no other reviewer: the follower is told as a copy and the chain still goes on, to the Admin.
    const admin = await personWith(org, adminValues);
    const bare = await liveJob(org, customer, {});
    await complete(me, bare.id);
    const second = await alertsFor(bare.id);
    expect(recipientsOf(second)).toEqual(ids(follower, admin));
  });

  it('the why line is on step 2 and step 3 and not on lane 1, step 1 or copies', async () => {
    const { org, customer } = await quietOrg();
    const me = await personWith(org, completerValues);
    const soldBy = await personWith(org, opensJobs);
    const follower = await personWith(org, { ...opensJobs, alert_every_job: true });
    const reviewer = await personWith(org, reviewerValues);
    const dispatcher = await personWith(org, opensJobs);

    // Step 2: no Dispatcher, so the Office review holder is covering.
    const noDispatcher = await liveJob(org, customer, { soldBy: soldBy.id });
    await complete(me, noDispatcher.id);
    const step2 = await alertsFor(noDispatcher.id);
    expect(whyFor(step2, reviewer)).toBe('This job has no Dispatcher.');
    expect(whyFor(step2, soldBy)).toBeNull();
    expect(whyFor(step2, follower)).toBeNull();

    // Step 1: the Dispatcher took it; nobody is covering, so no line anywhere.
    const withDispatcher = await liveJob(org, customer, { soldBy: soldBy.id, dispatcher: dispatcher.id });
    await complete(me, withDispatcher.id);
    const step1 = await alertsFor(withDispatcher.id);
    expect(step1.every((n) => n.body === null)).toBe(true);
    expect(recipientsOf(step1)).toEqual(ids(soldBy, dispatcher, follower));
  });

  it('a chain that finds nobody writes one log entry with the alert kind, record id and org id and no customer content; one that finds someone writes none', async () => {
    const { org, customer } = await quietOrg();
    const me = await personWith(org, completerValues);
    const warn = vi.spyOn(logger, 'warn');
    const gaps = () => (warn.mock.calls as unknown[][]).filter((call) => /job completed alert/i.test(String(call[0])));

    const lonely = await liveJob(org, customer, {});
    await complete(me, lonely.id);

    expect(await alertsFor(lonely.id)).toEqual([]);
    expect(gaps()).toHaveLength(1);
    const meta = gaps()[0]![1] as Record<string, unknown>;
    expect(meta).toMatchObject({ organizationId: org, recordId: lonely.id });
    expect(String(gaps()[0]![0])).toMatch(/job completed alert/i);
    // The customer on this job is called Pat Payer: nothing of the customer reaches the log.
    expect(JSON.stringify(gaps()[0])).not.toMatch(/Pat|Payer/);

    warn.mockClear();
    const reviewer = await personWith(org, reviewerValues);
    const covered = await liveJob(org, customer, {});
    await complete(me, covered.id);
    expect(recipientsOf(await alertsFor(covered.id))).toEqual(ids(reviewer));
    expect(gaps()).toHaveLength(0);
  });

  it('a lane 1 person alone is somebody: no log, even when nobody can act', async () => {
    const { org, customer } = await quietOrg();
    const me = await personWith(org, completerValues);
    const soldBy = await personWith(org, opensJobs);
    const warn = vi.spyOn(logger, 'warn');
    const job = await liveJob(org, customer, { soldBy: soldBy.id });

    await complete(me, job.id);

    expect(recipientsOf(await alertsFor(job.id))).toEqual(ids(soldBy));
    expect((warn.mock.calls as unknown[][]).filter((call) => /job completed alert/i.test(String(call[0])))).toHaveLength(0);
  });

  it('the crew is kept, and Sold By is the stored field: an empty one sends no Sold By alert even when the estimate\'s lead has a commission owner', async () => {
    const { org, customer } = await quietOrg();
    const me = await personWith(org, completerValues);
    const crew = await personWith(org, opensJobs);
    const leadOwner = await personWith(org, opensJobs);
    const reviewer = await personWith(org, reviewerValues);
    const lead = await fx.addLead(org, customer, { owner: leadOwner.id });
    const job = await liveJob(org, customer, { crew: [crew.id], fromLead: lead.id });

    await complete(me, job.id);

    const got = recipientsOf(await alertsFor(job.id));
    expect(got).toEqual(ids(crew, reviewer));
    expect(got).not.toContain(leadOwner.id);
  });

  it('completing with open visits cancelled still alerts the crew of the cancelled visit', async () => {
    const { org, customer } = await quietOrg();
    const me = await personWith(org, completerValues);
    const crew = await personWith(org, opensJobs);
    const reviewer = await personWith(org, reviewerValues);
    const job = await fx.addJob(org, customer, { status: 'SCHEDULED', crew: [crew.id] });

    const api = await fx.signedInAs(me);
    const res = await api.post(`/api/jobs/${job.id}/complete`, { cancel_open_visits: true });
    expect(res.status, JSON.stringify(res.body)).toBe(200);

    expect(recipientsOf(await alertsFor(job.id))).toEqual(ids(crew, reviewer));
  });
});
