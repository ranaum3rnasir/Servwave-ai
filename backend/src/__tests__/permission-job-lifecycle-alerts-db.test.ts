/* =============================================================================
   Roles & Permissions, PRD 6, slice S06.25 - the Job started, Job cancelled and Job reopened alerts on M6's two-lane chain.

   Each of the three used to go to "every Dispatcher" by role (and the Sold By and crew). Now each goes through the chain:
   lane 1 is the job's people (its stored Sold By, crew and Dispatcher); lane 2 is who must act (the job's Dispatcher, else
   the holders of the verb's step switch who can open the job, else the company's Admins, stopping at the first step that
   finds someone; an Admin holds every switch, so an Admin who can be told is found at the step already, AL-18); holders of Alert me about every job get a copy. The step switch is Assign people to
   jobs for started and Office review for cancelled and reopened (the M6 table). "Someone" is active, can open the job and
   is not the person who did the action. Nobody comes from a role name. Priorities and "needs action" are what each verb
   always had: started and reopened are plain feed alerts, cancelled interrupts the job's crew; none asks anyone to act.

   One table drives all three verbs, so a row of the chain is checked the same way for each. Everything goes through the
   public interface: the start, cancel and reopen routes, called as people on custom roles holding exactly the switch values
   under test (every other toggle off), and the notification rows they leave behind. The alert is sent after the response,
   so each case waits for it. Real migrated database (TEST_DATABASE_URL); the suite skips when it is unset. The client holds
   ONE connection, as the hosted database does. Every org it creates is removed again.
   ========================================================================== */

import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import type { JobStatus, PrismaClient, Role } from '@prisma/client';

// One client holding ONE connection, as the hosted database's does: a query on the global client from inside a
// transaction waits for a second connection that never comes, which a local pool of several hides.
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

// The suite-wide setup hands every record the same number; these cases create several jobs in one company.
vi.mock('../lib/numbering', () => {
  let issued = 0;
  return {
    allocateNumber: vi.fn(async (_tx: unknown, entity: string) => `${entity[0]!.toUpperCase()}T${Date.now()}${++issued}`),
  };
});

import { switchFixture, type Person } from './permission-switches-fixture';
import { setRoleSwitchValues } from '../lib/permissions/switches/store';
import { SWITCH_CATALOG, type SwitchValue } from '../lib/permissions/switches/catalog';
import { logger } from '../lib/logger';
import { reviewAttentionSettled } from '../services/notifications/reviewAttentionQueue';

const suite = realClient ? describe : describe.skip;

/** Every switch in the catalog off (a choice at its first option, a list empty), so a case turns on exactly the ones it is about. */
const ALL_OFF: Record<string, SwitchValue> = Object.fromEntries(
  SWITCH_CATALOG.map((s) => [s.key, s.kind === 'choice' ? s.choices![0]! : s.kind === 'list' ? [] : false]),
);

const opensJobs = { view_jobs: true, jobs_scope: 'all' };
// An Admin (the flag, AL-18): holds every switch, the step and the copy switches included, and opens every record.
const adminValues = { ...opensJobs, is_admin: true, view_users: true };

type Api = Awaited<ReturnType<ReturnType<typeof switchFixture>['signedInAs']>>;

/** One row of the table: a verb, the switch that is its lane 2 step, and the route that raises it. */
interface Verb {
  verb: string;
  /** What the bell says about job number N, as it always has. */
  title: (jobNumber: string) => string;
  /** The status the job is in when the action is taken. */
  status: JobStatus;
  /** The switch whose holders must act when the job has no Dispatcher. */
  stepSwitch: string;
  /** How the why line names the step when nobody holding it could take the alert. */
  stepWords: string;
  /** What the actor holds to take the action. */
  actorValues: Record<string, SwitchValue>;
  /** The priority the job's crew got, which is what the verb always gave them. */
  crewPriority: 'FEED' | 'INTERRUPT';
  act: (api: Api, jobId: string) => Promise<{ status: number; body: unknown }>;
}

const VERBS: Verb[] = [
  {
    verb: 'job.started',
    title: (n) => `${n} started`,
    status: 'SCHEDULED',
    stepSwitch: 'assign_people_to_jobs',
    stepWords: 'assign people to jobs',
    actorValues: { ...opensJobs, start_and_finish_visits: true, update_any_visit_status: true },
    crewPriority: 'FEED',
    act: (api, id) => api.post(`/api/jobs/${id}/start`),
  },
  {
    verb: 'job.cancelled',
    title: (n) => `${n} cancelled`,
    status: 'IN_PROGRESS',
    stepSwitch: 'office_review',
    stepWords: 'review jobs',
    actorValues: { ...opensJobs, cancel_jobs: true },
    crewPriority: 'INTERRUPT',
    act: (api, id) => api.post(`/api/jobs/${id}/cancel`, { cancel_reason_code: 'PRICE' }),
  },
  {
    verb: 'job.reopened',
    title: (n) => `${n} reopened`,
    status: 'DONE',
    stepSwitch: 'office_review',
    stepWords: 'review jobs',
    actorValues: { ...opensJobs, reopen_done_jobs: true },
    crewPriority: 'FEED',
    act: (api, id) => api.post(`/api/jobs/${id}/reopen`),
  },
];

suite('the job started, cancelled and reopened alerts (real database)', () => {
  const db = realClient as PrismaClient;
  const fx = switchFixture(db, async () => (await import('../app.js')).default as never);
  // Loading the whole app is slow on a loaded machine.
  beforeAll(async () => {
    await import('../app.js');
  }, 120_000);
  afterAll(() => fx.cleanup());
  afterEach(() => vi.restoreAllMocks());

  let sequence = 0;

  /** A person on a fresh custom role holding exactly these switch values (every other switch off). */
  async function personWith(org: string, values: Record<string, SwitchValue>, base: Role = 'DISPATCHER'): Promise<Person> {
    const key = `job-lifecycle-role-${++sequence}`;
    // `is_admin: true` makes the person an Admin (the flag, AL-18): it is not a switch, so it never reaches the role.
    const { is_admin: asAdmin, ...switchValues } = values;
    const role = await fx.addCustomRole(org, key, base);
    await setRoleSwitchValues({ organizationId: org, roleKey: key, values: { ...ALL_OFF, ...switchValues }, actorId: null, reason: 'manual' });
    return fx.addUser(org, `p${sequence}`, base, { customRoleId: role.id, isAdmin: asAdmin === true });
  }

  /** A company with nobody but built people, so only they can be alerted. */
  async function quietOrg() {
    const world = await fx.newOrg();
    await db.user.update({ where: { id: world.admin.id }, data: { is_active: false } });
    return world;
  }

  /** Take the action as this person; the alert goes out once the response has. */
  async function take(row: Verb, who: Person, jobId: string) {
    const api = await fx.signedInAs(who);
    const res = await row.act(api, jobId);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    await reviewAttentionSettled();
  }

  const alertsFor = (verb: string, jobId: string) =>
    db.notification.findMany({ where: { object_id: jobId, verb }, include: { recipients: true }, orderBy: { created_at: 'asc' } });
  type Alerts = Awaited<ReturnType<typeof alertsFor>>;
  const recipientsOf = (rows: Alerts) => rows.flatMap((n) => n.recipients.map((r) => r.recipient_id)).sort();
  const ids = (...people: Person[]) => people.map((p) => p.id).sort();
  /** The why line one person's alert carries (null when it carries none). */
  const whyFor = (rows: Alerts, person: Person) => rows.find((n) => n.recipients.some((r) => r.recipient_id === person.id))?.body ?? null;
  const rowFor = (rows: Alerts, person: Person) => rows.flatMap((n) => n.recipients).find((r) => r.recipient_id === person.id);

  describe.each(VERBS)('$verb', (row) => {
    const stepValues = { ...opensJobs, [row.stepSwitch]: true };
    const job = (org: string, customer: string, opts: { crew?: string[]; soldBy?: string; dispatcher?: string; fromLead?: string }) =>
      fx.addJob(org, customer, { status: row.status, crew: opts.crew ?? [], soldBy: opts.soldBy, dispatcher: opts.dispatcher, fromLead: opts.fromLead });

    it('says what it always said, as a bell alert that asks nobody to act, and the crew has the priority it always had', async () => {
      const { org, customer } = await quietOrg();
      const me = await personWith(org, row.actorValues);
      const crew = await personWith(org, opensJobs);
      const soldBy = await personWith(org, opensJobs);
      const dispatcher = await personWith(org, opensJobs);
      const j = await job(org, customer, { crew: [crew.id], soldBy: soldBy.id, dispatcher: dispatcher.id });
      const number = (await db.job.findUniqueOrThrow({ where: { id: j.id }, select: { job_number: true } })).job_number;

      await take(row, me, j.id);

      const alerts = await alertsFor(row.verb, j.id);
      expect(alerts).toHaveLength(1);
      expect(alerts[0]!.title).toBe(row.title(number));
      // "Cancelled", never "Lost": a job is only ever cancelled.
      expect(alerts[0]!.title).not.toMatch(/lost/i);
      expect(alerts[0]).toMatchObject({ object_type: 'JOB', object_id: j.id, category: 'JOB', needs_action: false });
      expect(rowFor(alerts, crew)).toMatchObject({ priority: row.crewPriority, needs_action: false });
      expect(rowFor(alerts, soldBy)).toMatchObject({ priority: 'FEED', needs_action: false });
      expect(rowFor(alerts, dispatcher)).toMatchObject({ priority: 'FEED', needs_action: false });
      // Only the bell is written, and it opens the job itself.
      expect((alerts[0]!.data as Record<string, unknown>).panel).toBeUndefined();
    });

    it('with a Dispatcher: lane 1 and the Dispatcher are alerted, and no step holder; no role list reaches anyone', async () => {
      const { org, customer } = await quietOrg();
      const me = await personWith(org, row.actorValues);
      const soldBy = await personWith(org, opensJobs);
      const crew = await personWith(org, opensJobs);
      const dispatcher = await personWith(org, opensJobs);
      const holder = await personWith(org, stepValues);
      // A Dispatcher-role person and an Admin-role person holding nothing: a role name tells nobody anything now.
      const dispatcherRole = await personWith(org, opensJobs, 'DISPATCHER');
      const adminRole = await personWith(org, opensJobs, 'ADMIN');
      const j = await job(org, customer, { crew: [crew.id], soldBy: soldBy.id, dispatcher: dispatcher.id });

      await take(row, me, j.id);

      const got = recipientsOf(await alertsFor(row.verb, j.id));
      expect(got).toEqual(ids(soldBy, crew, dispatcher));
      for (const who of [holder, dispatcherRole, adminRole, me]) expect(got).not.toContain(who.id);
    });

    it('without a Dispatcher: lane 1 plus every step switch holder on a custom role who can open the job; an Admin-role person with the switch off is not one', async () => {
      const { org, customer } = await quietOrg();
      const me = await personWith(org, row.actorValues);
      const soldBy = await personWith(org, opensJobs);
      const holder = await personWith(org, stepValues);
      const secondHolder = await personWith(org, stepValues, 'TECHNICIAN');
      // Based on the Admin role with the step switch off: a role name holds nothing, the switch does.
      const adminSwitchOff = await personWith(org, opensJobs, 'ADMIN');
      const cannotOpen = await personWith(org, { view_jobs: true, jobs_scope: 'attached', [row.stepSwitch]: true });
      const gone = await personWith(org, stepValues);
      await db.user.update({ where: { id: gone.id }, data: { is_active: false } });
      // An Admin holds the step switch too (every switch), so they are one of the holders.
      const admin = await personWith(org, adminValues);
      const j = await job(org, customer, { soldBy: soldBy.id });

      await take(row, me, j.id);

      const got = recipientsOf(await alertsFor(row.verb, j.id));
      expect(got).toEqual(ids(soldBy, holder, secondHolder, admin));
      for (const who of [adminSwitchOff, cannotOpen, gone]) expect(got).not.toContain(who.id);
    });

    it('without a Dispatcher and with no other step holder who can open the job: the Admins, told as holders of the step', async () => {
      const { org, customer } = await quietOrg();
      const me = await personWith(org, row.actorValues);
      const admin = await personWith(org, adminValues);
      const cannotOpen = await personWith(org, { view_jobs: true, jobs_scope: 'attached', [row.stepSwitch]: true });
      const noSwitch = await personWith(org, opensJobs);
      const j = await job(org, customer, {});

      await take(row, me, j.id);

      const alerts = await alertsFor(row.verb, j.id);
      expect(recipientsOf(alerts)).toEqual(ids(admin));
      expect(recipientsOf(alerts)).not.toContain(cannotOpen.id);
      expect(recipientsOf(alerts)).not.toContain(noSwitch.id);
      // An Admin holds the step, and the "Alert me about every ..." switch too: told once, without the why line (a covering
      // person who also has a copy is told without it), never twice.
      expect(whyFor(alerts, admin)).toBeNull();
      expect(alerts.filter((n) => n.recipients.some((r) => r.recipient_id === admin.id))).toHaveLength(1);
    });

    it('a job with Sold By and crew but no Dispatcher still alerts the step holders', async () => {
      const { org, customer } = await quietOrg();
      const me = await personWith(org, row.actorValues);
      const soldBy = await personWith(org, opensJobs);
      const crew = await personWith(org, opensJobs);
      const holder = await personWith(org, stepValues);
      const j = await job(org, customer, { crew: [crew.id], soldBy: soldBy.id });

      await take(row, me, j.id);

      expect(recipientsOf(await alertsFor(row.verb, j.id))).toEqual(ids(soldBy, crew, holder));
    });

    describe('a Dispatcher who cannot take the alert sends the chain to step 2 with the matching why line', () => {
      const cases: Array<[string, string, (org: string, dispatcher: Person, me: Person) => Promise<Person>]> = [
        ['is deactivated', "This job's Dispatcher is not available.", async (_org, dispatcher) => {
          await db.user.update({ where: { id: dispatcher.id }, data: { is_active: false } });
          return dispatcher;
        }],
        ['did the action', "This job's Dispatcher made this change.", async (_org, _dispatcher, me) => me],
        // Being the job's Dispatcher attaches them to it, so only a role that cannot see jobs at all cannot open it.
        ['cannot open the job', "This job's Dispatcher is not available.", async (org) => personWith(org, {})],
      ];
      it.each(cases)('a Dispatcher who %s', async (_label, line, makeDispatcher) => {
        const { org, customer } = await quietOrg();
        const me = await personWith(org, row.actorValues);
        const holder = await personWith(org, stepValues);
        const dispatcher = await makeDispatcher(org, await personWith(org, opensJobs), me);
        const j = await job(org, customer, { dispatcher: dispatcher.id });

        await take(row, me, j.id);

        const alerts = await alertsFor(row.verb, j.id);
        expect(recipientsOf(alerts)).toContain(holder.id);
        expect(whyFor(alerts, holder)).toBe(line);
        // The actor is never alerted, even as the job's own Dispatcher.
        expect(recipientsOf(alerts)).not.toContain(me.id);
      });
    });

    it('a person found twice gets one alert', async () => {
      const { org, customer } = await quietOrg();
      const me = await personWith(org, row.actorValues);
      // Sold By, step holder and follower at once.
      const everywhere = await personWith(org, { ...stepValues, alert_every_job: true });
      const j = await job(org, customer, { soldBy: everywhere.id, crew: [everywhere.id] });

      await take(row, me, j.id);

      const alerts = await alertsFor(row.verb, j.id);
      expect(recipientsOf(alerts)).toEqual(ids(everywhere));
      // ...and a crew member found in every lane keeps the verb's crew priority.
      expect(rowFor(alerts, everywhere)).toMatchObject({ priority: row.crewPriority });
    });

    it('copies reach "Alert me about every job" holders on jobs they can open, also when there is a Dispatcher, never on jobs they cannot open; a copy never stops the chain', async () => {
      const { org, customer } = await quietOrg();
      const me = await personWith(org, row.actorValues);
      const dispatcher = await personWith(org, opensJobs);
      const follower = await personWith(org, { ...opensJobs, alert_every_job: true });
      const blindFollower = await personWith(org, { view_jobs: true, jobs_scope: 'attached', alert_every_job: true });
      const withDispatcher = await job(org, customer, { dispatcher: dispatcher.id });

      await take(row, me, withDispatcher.id);

      const first = await alertsFor(row.verb, withDispatcher.id);
      expect(recipientsOf(first)).toEqual(ids(dispatcher, follower));
      expect(recipientsOf(first)).not.toContain(blindFollower.id);
      expect(rowFor(first, follower)).toMatchObject({ priority: 'FEED', needs_action: false });

      // No Dispatcher and no other step holder: the follower is told as a copy and the chain still goes on, to the Admin.
      const admin = await personWith(org, adminValues);
      const bare = await job(org, customer, {});
      await take(row, me, bare.id);
      expect(recipientsOf(await alertsFor(row.verb, bare.id))).toEqual(ids(follower, admin));
    });

    it('the why line is on step 2 and step 3 and not on lane 1, step 1 or copies', async () => {
      const { org, customer } = await quietOrg();
      const me = await personWith(org, row.actorValues);
      const soldBy = await personWith(org, opensJobs);
      const follower = await personWith(org, { ...opensJobs, alert_every_job: true });
      const holder = await personWith(org, stepValues);
      const dispatcher = await personWith(org, opensJobs);

      // Step 2: no Dispatcher, so the step holder is covering.
      const noDispatcher = await job(org, customer, { soldBy: soldBy.id });
      await take(row, me, noDispatcher.id);
      const step2 = await alertsFor(row.verb, noDispatcher.id);
      expect(whyFor(step2, holder)).toBe('This job has no Dispatcher.');
      expect(whyFor(step2, soldBy)).toBeNull();
      expect(whyFor(step2, follower)).toBeNull();

      // Step 1: the Dispatcher took it; nobody is covering, so no line anywhere.
      const withDispatcher = await job(org, customer, { soldBy: soldBy.id, dispatcher: dispatcher.id });
      await take(row, me, withDispatcher.id);
      const step1 = await alertsFor(row.verb, withDispatcher.id);
      expect(step1.every((n) => n.body === null)).toBe(true);
      expect(recipientsOf(step1)).toEqual(ids(soldBy, dispatcher, follower));
    });

    it('a chain that finds nobody writes one log entry with the alert kind, record id and org id and no customer content; one that finds someone writes none', async () => {
      const { org, customer } = await quietOrg();
      const me = await personWith(org, row.actorValues);
      const warn = vi.spyOn(logger, 'warn');
      const kind = row.verb.replace('job.', 'job ');
      const gaps = () => (warn.mock.calls as unknown[][]).filter((call) => String(call[0]).includes(`${kind} alert: nobody to tell`));

      const lonely = await job(org, customer, {});
      await take(row, me, lonely.id);

      expect(await alertsFor(row.verb, lonely.id)).toEqual([]);
      expect(gaps()).toHaveLength(1);
      expect(gaps()[0]![1]).toMatchObject({ organizationId: org, recordId: lonely.id });
      // The customer on this job is called Pat Payer: nothing of the customer reaches the log.
      expect(JSON.stringify(gaps()[0])).not.toMatch(/Pat|Payer/);

      warn.mockClear();
      const holder = await personWith(org, stepValues);
      const covered = await job(org, customer, {});
      await take(row, me, covered.id);
      expect(recipientsOf(await alertsFor(row.verb, covered.id))).toEqual(ids(holder));
      expect(gaps()).toHaveLength(0);
    });

    it('a lane 1 person alone is somebody: no log, even when nobody can act', async () => {
      const { org, customer } = await quietOrg();
      const me = await personWith(org, row.actorValues);
      const soldBy = await personWith(org, opensJobs);
      const warn = vi.spyOn(logger, 'warn');
      const j = await job(org, customer, { soldBy: soldBy.id });

      await take(row, me, j.id);

      expect(recipientsOf(await alertsFor(row.verb, j.id))).toEqual(ids(soldBy));
      expect((warn.mock.calls as unknown[][]).filter((call) => String(call[0]).includes('nobody to tell'))).toHaveLength(0);
    });

    it('the crew is kept, and Sold By is the stored field: an empty one sends no Sold By alert even when the estimate\'s lead has a commission owner', async () => {
      const { org, customer } = await quietOrg();
      const me = await personWith(org, row.actorValues);
      const crew = await personWith(org, opensJobs);
      const leadOwner = await personWith(org, opensJobs);
      const holder = await personWith(org, stepValues);
      const lead = await fx.addLead(org, customer, { owner: leadOwner.id });
      const j = await job(org, customer, { crew: [crew.id], fromLead: lead.id });

      await take(row, me, j.id);

      const got = recipientsOf(await alertsFor(row.verb, j.id));
      expect(got).toEqual(ids(crew, holder));
      expect(got).not.toContain(leadOwner.id);
    });

    it('raises no alert when the action itself is refused', async () => {
      const { org, customer } = await quietOrg();
      const refused = await personWith(org, opensJobs);
      // Somebody who would have been told, so a missing alert is the refusal's doing.
      await personWith(org, stepValues);
      const j = await job(org, customer, {});

      const res = await row.act(await fx.signedInAs(refused), j.id);
      await reviewAttentionSettled();

      expect(res.status).toBeGreaterThanOrEqual(400);
      expect(await alertsFor(row.verb, j.id)).toEqual([]);
    });
  });

  describe('a bulk action', () => {
    const bulk = (api: Api, ids: string[], action: 'start' | 'cancel') =>
      api.post('/api/jobs/bulk-status', { ids, action, ...(action === 'cancel' ? { cancel_reason_code: 'PRICE' } : {}) });

    it.each([
      ['start', 'job.started', 'SCHEDULED', { ...opensJobs, start_and_finish_visits: true, update_any_visit_status: true }, 'assign_people_to_jobs'],
      ['cancel', 'job.cancelled', 'IN_PROGRESS', { ...opensJobs, cancel_jobs: true }, 'office_review'],
    ] as const)('%s sends one alert per job, each to that job\'s own people and step holders', async (action, verb, status, actorValues, step) => {
      const { org, customer } = await quietOrg();
      const me = await personWith(org, actorValues);
      const holder = await personWith(org, { ...opensJobs, [step]: true });
      const sellerA = await personWith(org, opensJobs);
      const sellerB = await personWith(org, opensJobs);
      const jobA = await fx.addJob(org, customer, { status, crew: [], soldBy: sellerA.id });
      const jobB = await fx.addJob(org, customer, { status, crew: [], soldBy: sellerB.id });

      const api = await fx.signedInAs(me);
      const res = await bulk(api, [jobA.id, jobB.id], action);
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect(res.body.updated).toHaveLength(2);
      await reviewAttentionSettled();

      const a = await alertsFor(verb, jobA.id);
      const b = await alertsFor(verb, jobB.id);
      expect(a).toHaveLength(2); // one without the line (its seller), one with it (the covering holder)
      expect(recipientsOf(a)).toEqual(ids(sellerA, holder));
      expect(recipientsOf(b)).toEqual(ids(sellerB, holder));
    });

    it('a job in the batch that fails sends no alert, the others do', async () => {
      const { org, customer } = await quietOrg();
      const me = await personWith(org, { ...opensJobs, cancel_jobs: true });
      const holder = await personWith(org, { ...opensJobs, office_review: true });
      const ok = await fx.addJob(org, customer, { status: 'IN_PROGRESS', crew: [] });
      // A Done job cannot be cancelled until it is reopened.
      const done = await fx.addJob(org, customer, { status: 'DONE', crew: [] });

      const res = await bulk(await fx.signedInAs(me), [ok.id, done.id], 'cancel');
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect(res.body.failed).toHaveLength(1);
      await reviewAttentionSettled();

      expect(recipientsOf(await alertsFor('job.cancelled', ok.id))).toEqual(ids(holder));
      expect(await alertsFor('job.cancelled', done.id)).toEqual([]);
    });
  });

  it('a backward move through Start (out of Office review) raises no Job started alert', async () => {
    const { org, customer } = await quietOrg();
    const me = await personWith(org, { ...opensJobs, start_and_finish_visits: true, update_any_visit_status: true, complete_jobs: true });
    // Somebody who would have been told, so a missing alert is the backward move's doing.
    await personWith(org, { ...opensJobs, assign_people_to_jobs: true, office_review: true });
    const j = await fx.addJob(org, customer, { status: 'OFFICE_REVIEW', crew: [] });

    const res = await (await fx.signedInAs(me)).post(`/api/jobs/${j.id}/start`);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    await reviewAttentionSettled();

    expect(await alertsFor('job.started', j.id)).toEqual([]);
  });
});
