/* =============================================================================
   Roles & Permissions, PRD 6, slice S06.27 - the scheduling and parts alerts on M6's two-lane chain: Job created, Job assigned
   to you, Job rescheduled and Parts staged and ready.

   Each used to go to "every Admin and every Dispatcher" by role (and the crew). Now each goes through the chain: lane 1 is the
   job's people (its stored Sold By, crew and Dispatcher); lane 2 is who must act (the job's Dispatcher, else the holders of
   Assign people to jobs who can open the job, else the company's Admins, stopping at the first step that finds someone; an Admin
   holds every switch, so since AL-18 an Admin who can be told is found at the step already); holders of Alert me about every job get a copy. "Someone" is active, can open the job and is not the person
   who did the action. Nobody comes from a role name.

   One table drives all four verbs, so a row of the chain is checked the same way for each. Everything goes through the public
   interface: the create, assign, assignees and stage routes, called as people on custom roles holding exactly the switch values
   under test (every other toggle off), and the notification rows they leave behind. The alert is sent after the response, so each
   case waits for it. Job assigned is the one verb with two wordings: "J1 assigned to you" for the named person and "Dana was
   assigned to J1" for everyone else the chain reaches. "Unassigned from you" is personal and never walks the chain.

   Real migrated database (TEST_DATABASE_URL); the suite skips when it is unset. The client holds ONE connection, as the hosted
   database does. Every org it creates is removed again.
   ========================================================================== */

import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import { randomUUID } from 'crypto';
import type { PrismaClient, Role } from '@prisma/client';

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

/** What a person needs to be named on a job at all: to be allowed on a crew, as Sold By and as Dispatcher. */
const slots = { can_be_on_crew: true, can_own_leads: true, can_be_dispatcher: true };
const opensJobs = { view_jobs: true, jobs_scope: 'all', ...slots };
// An Admin (the flag, AL-18): the chain's last fallback, who also holds every switch (the step and Alert me about every job).
const managerValues = { ...opensJobs, is_admin: true, view_users: true };
const STEP = 'assign_people_to_jobs';
const stepValues = { ...opensJobs, [STEP]: true };

type Api = Awaited<ReturnType<ReturnType<typeof switchFixture>['signedInAs']>>;
type Priority = 'FEED' | 'INTERRUPT';

/** The people a case puts on the job before the action. */
interface Cast {
  org: string;
  customer: string;
  me: Person;
  crew: Person[];
  soldBy?: Person;
  dispatcher?: Person;
  /** A lead the job came from (an estimate on it), which carries a commission owner. */
  fromLead?: string;
  /** True when the action is expected to be refused: the row then checks the refusal instead of success. */
  refused?: boolean;
}

/** What the action left behind: the record the alert is about, and who is on the job now. */
interface Placed {
  jobId: string;
  /** The id the alert is filed under (the job, or the stage for parts staged). */
  objectId: string;
  jobNumber: string;
  /** The crew the job really has after the action (a new job can only hold its creator). */
  crew: Person[];
  /** The people the action named (assigned to the job just now). */
  named: Person[];
}

/** One row of the table: a verb, and the route that raises it. */
interface Verb {
  verb: string;
  objectType: 'JOB' | 'JOB_STAGE';
  /** What the bell says to one person about the job (the "you" form for the named person). */
  title: (placed: Placed, person: Person) => string;
  /** How many alerts one action sends when it needs no why line (Job assigned says it two ways). */
  wordings: number;
  /** What the actor holds to take the action. */
  actorValues: Record<string, SwitchValue>;
  /** The priority the job's crew got, which is what the verb always gave them. */
  crewPriority: Priority;
  /** The priority the Dispatcher, who must act, got. */
  dispatcherPriority: Priority;
  /** The priority of the people who must act when the Dispatcher cannot (the step holders). */
  holderPriority: Priority;
  /** False when the route refuses to name a deactivated person (a new job). */
  namesInactiveDispatcher: boolean;
  act: (api: Api, cast: Cast) => Promise<Placed>;
}

/** The answer a case expects: a success (200 or 201), or any refusal. */
function expectAnswer(res: { status: number; body: unknown }, cast: Cast) {
  if (cast.refused) expect(res.status, JSON.stringify(res.body)).toBeGreaterThanOrEqual(400);
  else expect(res.status, JSON.stringify(res.body)).toBeLessThan(300);
}

/** The name an alert gives a person: the fixture makes everyone "<name> Tester". */
const nameOf = (p: Person) => `${p.email.slice(0, p.email.lastIndexOf('-'))} Tester`;

suite('the scheduling and parts alerts (real database)', () => {
  const db = realClient as PrismaClient;
  const fx = switchFixture(db, async () => (await import('../app.js')).default as never);
  // Loading the whole app is slow on a loaded machine.
  beforeAll(async () => {
    await import('../app.js');
  }, 120_000);
  const stageIds: string[] = [];
  afterAll(async () => {
    for (const id of stageIds) {
      await db.$executeRawUnsafe(`DELETE FROM stage_audit_entries WHERE stage_id = '${id}'`).catch(() => undefined);
      await db.$executeRawUnsafe(`DELETE FROM job_stages WHERE id = '${id}'`).catch(() => undefined);
    }
    await fx.cleanup();
  });
  afterEach(() => vi.restoreAllMocks());

  let sequence = 0;

  /** A person on a fresh custom role holding exactly these switch values (every other switch off). */
  async function personWith(org: string, values: Record<string, SwitchValue>, base: Role = 'DISPATCHER'): Promise<Person> {
    const key = `job-scheduling-role-${++sequence}`;
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

  const jobNumberOf = async (id: string) => (await db.job.findUniqueOrThrow({ where: { id }, select: { job_number: true } })).job_number;
  const existingJob = (cast: Cast) =>
    fx.addJob(cast.org, cast.customer, {
      status: 'SCHEDULED', crew: cast.crew.map((p) => p.id), soldBy: cast.soldBy?.id, dispatcher: cast.dispatcher?.id, fromLead: cast.fromLead,
    });
  const soon = (days: number) => new Date(Date.now() + days * 86_400_000).toISOString();

  const table: Verb[] = [
    {
      verb: 'dispatch.job_created',
      objectType: 'JOB',
      title: (placed) => `Job created: ${placed.jobNumber}`,
      wordings: 1,
      actorValues: { ...opensJobs, edit_jobs: true, create_jobs: true, assign_people_to_jobs: true },
      crewPriority: 'INTERRUPT',
      dispatcherPriority: 'INTERRUPT',
      holderPriority: 'INTERRUPT',
      namesInactiveDispatcher: false,
      act: async (api, cast) => {
        const location = randomUUID();
        await db.serviceLocation.create({
          data: { id: location, customer_id: cast.customer, address_line1: '1 Test Way', city: 'Testville', state: 'MA', zip: '02108' },
        });
        const res = await api.post('/api/jobs', {
          customer_id: cast.customer, service_location_id: location,
          sold_by_id: cast.soldBy?.id ?? null, dispatcher_id: cast.dispatcher?.id ?? null,
        });
        expectAnswer(res, cast);
        const jobId = (res.body.job?.id ?? randomUUID()) as string;
        return { jobId, objectId: jobId, jobNumber: res.body.job?.job_number ?? '', crew: [], named: [] };
      },
    },
    {
      verb: 'dispatch.job_assigned',
      objectType: 'JOB',
      title: (placed, person) =>
        placed.named.some((p) => p.id === person.id)
          ? `${placed.jobNumber} assigned to you`
          : `${placed.named.map(nameOf).join(' and ')} ${placed.named.length > 1 ? 'were' : 'was'} assigned to ${placed.jobNumber}`,
      wordings: 2,
      actorValues: { ...opensJobs, assign_people_to_jobs: true, assign_work_to_others: true },
      crewPriority: 'FEED',
      dispatcherPriority: 'FEED',
      holderPriority: 'FEED',
      namesInactiveDispatcher: true,
      act: async (api, cast) => {
        const job = await existingJob(cast);
        // A technician who sees only the jobs they are on, so being put on this one is what lets them open it.
        const added = await personWith(cast.org, { view_jobs: true, jobs_scope: 'attached', ...slots }, 'TECHNICIAN');
        const res = await api.post(`/api/jobs/${job.id}/assignees`, { assignee_ids: [...cast.crew.map((p) => p.id), added.id] });
        expectAnswer(res, cast);
        return { jobId: job.id, objectId: job.id, jobNumber: await jobNumberOf(job.id), crew: [...cast.crew, added], named: [added] };
      },
    },
    {
      verb: 'dispatch.job_rescheduled',
      objectType: 'JOB',
      title: (placed) => `${placed.jobNumber} rescheduled`,
      wordings: 1,
      actorValues: { ...opensJobs, assign_people_to_jobs: true },
      crewPriority: 'INTERRUPT',
      dispatcherPriority: 'FEED',
      holderPriority: 'FEED',
      namesInactiveDispatcher: true,
      act: async (api, cast) => {
        const job = await existingJob(cast);
        const res = await api.post(`/api/jobs/${job.id}/assign`, {
          assignee_ids: cast.crew.map((p) => p.id), scheduled_start: soon(6), scheduled_end: soon(6.1),
        });
        expectAnswer(res, cast);
        return { jobId: job.id, objectId: job.id, jobNumber: await jobNumberOf(job.id), crew: cast.crew, named: [] };
      },
    },
    {
      verb: 'inventory.staging_ready',
      objectType: 'JOB_STAGE',
      title: (placed) => `Parts staged and ready for ${placed.jobNumber}`,
      wordings: 1,
      actorValues: { ...opensJobs, view_stock: true, edit_stock: true },
      crewPriority: 'INTERRUPT',
      dispatcherPriority: 'FEED',
      holderPriority: 'FEED',
      namesInactiveDispatcher: true,
      act: async (api, cast) => {
        const job = await existingJob(cast);
        const jobNumber = await jobNumberOf(job.id);
        const stageId = await addStage(cast.org, { jobId: job.id, jobNumber, assignedTo: cast.crew[0]?.id });
        const res = await api.post('/api/inventory/job-stages/notify', { stageId });
        expectAnswer(res, cast);
        return { jobId: job.id, objectId: stageId, jobNumber, crew: cast.crew, named: [] };
      },
    },
  ];

  async function addStage(org: string, opts: { jobId?: string | null; jobNumber: string; assignedTo?: string }) {
    const id = randomUUID();
    await db.jobStage.create({
      data: {
        id, organization_id: org, job_id: opts.jobId ?? null, job_number: opts.jobNumber, customer: 'Pat Payer', site: '1 Test Way',
        trade: 'locksmith', status: 'staged', assigned_tech_id: opts.assignedTo ?? null,
      },
    });
    stageIds.push(id);
    return id;
  }

  /** Take the action as this person; the alert goes out once the response has. */
  async function take(row: Verb, cast: Cast): Promise<Placed> {
    const api = await fx.signedInAs(cast.me);
    const placed = await row.act(api, cast);
    await reviewAttentionSettled();
    return placed;
  }

  const alertsFor = (verb: string, objectId: string) =>
    db.notification.findMany({ where: { object_id: objectId, verb }, include: { recipients: true }, orderBy: { created_at: 'asc' } });
  type Alerts = Awaited<ReturnType<typeof alertsFor>>;
  const recipientsOf = (rows: Alerts) => rows.flatMap((n) => n.recipients.map((r) => r.recipient_id)).sort();
  const ids = (...people: Person[]) => people.map((p) => p.id).sort();
  /** The why line one person's alert carries (null when it carries none). */
  const whyFor = (rows: Alerts, person: Person) => rows.find((n) => n.recipients.some((r) => r.recipient_id === person.id))?.body ?? null;
  const rowFor = (rows: Alerts, person: Person) => rows.flatMap((n) => n.recipients).find((r) => r.recipient_id === person.id);
  const titleFor = (rows: Alerts, person: Person) => rows.find((n) => n.recipients.some((r) => r.recipient_id === person.id))?.title;

  describe.each(table.map((row) => [row.verb, row] as const))('%s', (_name, row) => {
    const cast = (org: string, customer: string, me: Person, opts: Partial<Cast> = {}): Cast => ({ org, customer, me, crew: [], ...opts });
    const actor = (org: string) => personWith(org, { ...row.actorValues, ...slots });

    it('says what it always said, as a bell alert that asks nobody to act, with the priorities it always gave', async () => {
      const { org, customer } = await quietOrg();
      const me = await actor(org);
      const crew = await personWith(org, opensJobs);
      const soldBy = await personWith(org, opensJobs);
      const dispatcher = await personWith(org, opensJobs);

      const placed = await take(row, cast(org, customer, me, { crew: [crew], soldBy, dispatcher }));

      const alerts = await alertsFor(row.verb, placed.objectId);
      expect(alerts).toHaveLength(row.wordings);
      expect(alerts.every((n) => n.object_type === row.objectType && n.needs_action === false)).toBe(true);
      for (const person of [soldBy, dispatcher, ...placed.crew]) {
        expect(titleFor(alerts, person), person.email).toBe(row.title(placed, person));
      }
      if (placed.crew.length) {
        const existing = placed.crew.find((p) => !placed.named.some((n) => n.id === p.id)) ?? placed.crew[0]!;
        expect(rowFor(alerts, existing)).toMatchObject({ priority: row.crewPriority, needs_action: false });
      }
      expect(rowFor(alerts, soldBy)).toMatchObject({ priority: 'FEED', needs_action: false });
      expect(rowFor(alerts, dispatcher)).toMatchObject({ priority: row.dispatcherPriority, needs_action: false });
      // Only the bell is written, and it opens the job itself.
      expect(alerts.every((n) => (n.data as Record<string, unknown>).panel === undefined)).toBe(true);
    });

    it('with a Dispatcher: lane 1 and the Dispatcher are alerted, and no step holder; no role list reaches anyone', async () => {
      const { org, customer } = await quietOrg();
      const me = await actor(org);
      const soldBy = await personWith(org, opensJobs);
      const crew = await personWith(org, opensJobs);
      const dispatcher = await personWith(org, opensJobs);
      const holder = await personWith(org, stepValues);
      // A Dispatcher-role person and an Admin-role person holding nothing: a role name tells nobody anything now.
      const dispatcherRole = await personWith(org, opensJobs, 'DISPATCHER');
      const adminRole = await personWith(org, opensJobs, 'ADMIN');

      const placed = await take(row, cast(org, customer, me, { crew: [crew], soldBy, dispatcher }));

      const got = recipientsOf(await alertsFor(row.verb, placed.objectId));
      expect(got).toEqual(ids(soldBy, dispatcher, ...placed.crew));
      for (const who of [holder, dispatcherRole, adminRole, me]) expect(got).not.toContain(who.id);
    });

    it('without a Dispatcher: lane 1 plus every step switch holder who can open the job, an Admin included; an Admin-role person with the switch off is not one', async () => {
      const { org, customer } = await quietOrg();
      const me = await actor(org);
      const soldBy = await personWith(org, opensJobs);
      const holder = await personWith(org, stepValues);
      const secondHolder = await personWith(org, stepValues, 'TECHNICIAN');
      // Based on the Admin role with the step switch off: a role name holds nothing, the switch does.
      const adminSwitchOff = await personWith(org, opensJobs, 'ADMIN');
      const cannotOpen = await personWith(org, { view_jobs: true, jobs_scope: 'attached', [STEP]: true });
      const gone = await personWith(org, stepValues);
      await db.user.update({ where: { id: gone.id }, data: { is_active: false } });
      const manager = await personWith(org, managerValues);

      const placed = await take(row, cast(org, customer, me, { soldBy }));

      const got = recipientsOf(await alertsFor(row.verb, placed.objectId));
      // An Admin (the flag) holds every switch, so they are a step holder like the two on custom roles.
      expect(got).toEqual(ids(soldBy, holder, secondHolder, manager, ...placed.crew));
      for (const who of [adminSwitchOff, cannotOpen, gone]) expect(got).not.toContain(who.id);
    });

    it('without a Dispatcher and with no step holder on a custom role who can open the job: the Admins, as holders of the step, told once without a why line', async () => {
      const { org, customer } = await quietOrg();
      const me = await actor(org);
      const manager = await personWith(org, managerValues);
      const cannotOpen = await personWith(org, { view_jobs: true, jobs_scope: 'attached', [STEP]: true });
      const noSwitch = await personWith(org, opensJobs);

      const placed = await take(row, cast(org, customer, me));

      const alerts = await alertsFor(row.verb, placed.objectId);
      expect(recipientsOf(alerts)).toEqual(ids(manager, ...placed.crew));
      expect(recipientsOf(alerts)).not.toContain(cannotOpen.id);
      expect(recipientsOf(alerts)).not.toContain(noSwitch.id);
      // The Admin holds the step's switch, so the chain stops at the step and never says "nobody who can". They also hold Alert me
      // about every job, and a person who covers lane 2 and has a copy is told once, without the why line.
      expect(whyFor(alerts, manager)).toBeNull();
    });

    it('a job with Sold By and crew but no Dispatcher still alerts the step holders', async () => {
      const { org, customer } = await quietOrg();
      const me = await actor(org);
      const soldBy = await personWith(org, opensJobs);
      const crew = await personWith(org, opensJobs);
      const holder = await personWith(org, stepValues);

      const placed = await take(row, cast(org, customer, me, { crew: [crew], soldBy }));

      expect(recipientsOf(await alertsFor(row.verb, placed.objectId))).toEqual(ids(soldBy, holder, ...placed.crew));
    });

    describe('a Dispatcher who cannot take the alert sends the chain to step 2 with the matching why line', () => {
      const cases: Array<[string, string, boolean, (org: string, me: Person) => Promise<Person>]> = [
        ['is deactivated', "This job's Dispatcher is not available.", row.namesInactiveDispatcher, async (org) => {
          const dispatcher = await personWith(org, opensJobs);
          await db.user.update({ where: { id: dispatcher.id }, data: { is_active: false } });
          return dispatcher;
        }],
        ['did the action', "This job's Dispatcher made this change.", true, async (_org, me) => me],
        // Being the job's Dispatcher attaches them to it, so only a role that cannot see jobs at all cannot open it.
        ['cannot open the job', "This job's Dispatcher is not available.", true, async (org) => personWith(org, slots)],
      ];
      it.each(cases.filter((c) => c[2]))('a Dispatcher who %s', async (_label, line, _applies, makeDispatcher) => {
        const { org, customer } = await quietOrg();
        const me = await actor(org);
        const holder = await personWith(org, stepValues);
        const dispatcher = await makeDispatcher(org, me);

        const placed = await take(row, cast(org, customer, me, { dispatcher }));

        const alerts = await alertsFor(row.verb, placed.objectId);
        expect(recipientsOf(alerts)).toContain(holder.id);
        expect(whyFor(alerts, holder)).toBe(line);
        // The actor is never alerted, even as the job's own Dispatcher.
        expect(recipientsOf(alerts)).not.toContain(me.id);
      });
    });

    it('a person found twice gets one alert', async () => {
      const { org, customer } = await quietOrg();
      const me = await actor(org);
      // Sold By, crew, step holder and follower at once.
      const everywhere = await personWith(org, { ...stepValues, alert_every_job: true });

      const placed = await take(row, cast(org, customer, me, { soldBy: everywhere, crew: [everywhere] }));

      const alerts = await alertsFor(row.verb, placed.objectId);
      expect(recipientsOf(alerts).filter((id) => id === everywhere.id)).toHaveLength(1);
      // ...and a crew member found in every lane keeps the verb's crew priority.
      if (placed.crew.some((p) => p.id === everywhere.id) && !placed.named.some((p) => p.id === everywhere.id)) {
        expect(rowFor(alerts, everywhere)).toMatchObject({ priority: row.crewPriority });
      }
    });

    it('copies reach "Alert me about every job" holders on jobs they can open, also when there is a Dispatcher, never on jobs they cannot open; a copy never stops the chain', async () => {
      const { org, customer } = await quietOrg();
      const me = await actor(org);
      const dispatcher = await personWith(org, opensJobs);
      const follower = await personWith(org, { ...opensJobs, alert_every_job: true });
      const blindFollower = await personWith(org, { view_jobs: true, jobs_scope: 'attached', alert_every_job: true });

      const withDispatcher = await take(row, cast(org, customer, me, { dispatcher }));

      const first = await alertsFor(row.verb, withDispatcher.objectId);
      expect(recipientsOf(first)).toEqual(ids(dispatcher, follower, ...withDispatcher.crew));
      expect(recipientsOf(first)).not.toContain(blindFollower.id);
      expect(rowFor(first, follower)).toMatchObject({ priority: 'FEED', needs_action: false });

      // No Dispatcher and no step holder on a custom role: the follower is told as a copy, and the chain still reaches an Admin.
      const manager = await personWith(org, managerValues);
      const bare = await take(row, cast(org, customer, me));
      expect(recipientsOf(await alertsFor(row.verb, bare.objectId))).toEqual(ids(follower, manager, ...bare.crew));
    });

    it('the why line is on step 2 and step 3 and not on lane 1, step 1 or copies', async () => {
      const { org, customer } = await quietOrg();
      const me = await actor(org);
      const soldBy = await personWith(org, opensJobs);
      const follower = await personWith(org, { ...opensJobs, alert_every_job: true });
      const holder = await personWith(org, stepValues);
      const dispatcher = await personWith(org, opensJobs);

      // Step 2: no Dispatcher, so the step holder is covering.
      const noDispatcher = await take(row, cast(org, customer, me, { soldBy }));
      const step2 = await alertsFor(row.verb, noDispatcher.objectId);
      expect(whyFor(step2, holder)).toBe('This job has no Dispatcher.');
      expect(whyFor(step2, soldBy)).toBeNull();
      expect(whyFor(step2, follower)).toBeNull();

      // Step 1: the Dispatcher took it; nobody is covering, so no line anywhere.
      const withDispatcher = await take(row, cast(org, customer, me, { soldBy, dispatcher }));
      const step1 = await alertsFor(row.verb, withDispatcher.objectId);
      expect(step1.every((n) => n.body === null)).toBe(true);
      expect(recipientsOf(step1)).toEqual(ids(soldBy, dispatcher, follower, ...withDispatcher.crew));
    });

    it('a chain that finds nobody writes one log entry with the alert kind, record id and org id and no customer content; one that finds someone writes none', async () => {
      const { org, customer } = await quietOrg();
      const me = await actor(org);
      const warn = vi.spyOn(logger, 'warn');
      // An alert with no record (Staging has no area rides the same stage route) logs its own gap with no record id; it is not this one.
      const gaps = () => (warn.mock.calls as unknown[][]).filter((call) => String(call[0]).includes('alert: nobody to tell') && (call[1] as { recordId?: unknown } | undefined)?.recordId);

      // A bare job: nobody on it, nobody who must act, no copies. (Whoever the action itself named is somebody, so this
      // only holds for the verbs that name nobody.)
      const lonely = await take(row, cast(org, customer, me));
      if (lonely.crew.length === 0) {
        expect(await alertsFor(row.verb, lonely.objectId)).toEqual([]);
        expect(gaps()).toHaveLength(1);
        expect(gaps()[0]![1]).toMatchObject({ organizationId: org, recordId: lonely.jobId });
        // The customer on this job is called Pat Payer: nothing of the customer reaches the log.
        expect(JSON.stringify(gaps()[0])).not.toMatch(/Pat|Payer/);
      }

      warn.mockClear();
      const holder = await personWith(org, stepValues);
      const covered = await take(row, cast(org, customer, me));
      expect(recipientsOf(await alertsFor(row.verb, covered.objectId))).toEqual(ids(holder, ...covered.crew));
      expect(gaps()).toHaveLength(0);
    });

    it('a lane 1 person alone is somebody: no log, even when nobody can act', async () => {
      const { org, customer } = await quietOrg();
      const me = await actor(org);
      const soldBy = await personWith(org, opensJobs);
      const warn = vi.spyOn(logger, 'warn');

      const placed = await take(row, cast(org, customer, me, { soldBy }));

      expect(recipientsOf(await alertsFor(row.verb, placed.objectId))).toEqual(ids(soldBy, ...placed.crew));
      expect((warn.mock.calls as unknown[][]).filter((call) => String(call[0]).includes('nobody to tell') && (call[1] as { recordId?: unknown } | undefined)?.recordId)).toHaveLength(0);
    });

    it('Sold By is the stored field: an empty one sends no Sold By alert even when the lead has a commission owner', async () => {
      const { org, customer } = await quietOrg();
      const me = await actor(org);
      const leadOwner = await personWith(org, opensJobs);
      const holder = await personWith(org, stepValues);
      const lead = await fx.addLead(org, customer, { owner: leadOwner.id });

      const placed = await take(row, cast(org, customer, me, { fromLead: lead.id }));

      const got = recipientsOf(await alertsFor(row.verb, placed.objectId));
      expect(got).toContain(holder.id);
      expect(got).not.toContain(leadOwner.id);
    });

    it('raises no alert when the action itself is refused', async () => {
      const { org, customer } = await quietOrg();
      const refused = await personWith(org, opensJobs);
      // Somebody who would have been told, so a missing alert is the refusal's doing.
      await personWith(org, stepValues);
      const before = await db.notification.count({ where: { organization_id: org, verb: row.verb } });

      const api = await fx.signedInAs(refused);
      await row.act(api, cast(org, customer, refused, { refused: true }));
      await reviewAttentionSettled();

      expect(await db.notification.count({ where: { organization_id: org, verb: row.verb } })).toBe(before);
    });
  });

  // ─── Job assigned: one event, two wordings ────────────────────────────────────────────────────────────────────────────────

  describe('Job assigned to you: one event in two wordings, one alert per person', () => {
    const assignerValues = { ...opensJobs, assign_people_to_jobs: true, assign_work_to_others: true };
    /** A technician who sees only the jobs they are on, so being put on a job is what lets them open it. */
    const technician = (org: string, extra: Record<string, SwitchValue> = {}) =>
      personWith(org, { view_jobs: true, jobs_scope: 'attached', ...slots, ...extra }, 'TECHNICIAN');
    const ASSIGNED = 'dispatch.job_assigned';
    const everyone = (alerts: Alerts) => recipientsOf(alerts);

    it('several people assigned in one request: each is told "assigned to you", and everyone else gets ONE alert naming them all', async () => {
      const { org, customer } = await quietOrg();
      const me = await personWith(org, assignerValues);
      const soldBy = await personWith(org, opensJobs);
      const onCrew = await personWith(org, opensJobs);
      const follower = await personWith(org, { ...opensJobs, alert_every_job: true });
      const holder = await personWith(org, stepValues);
      const first = await technician(org);
      const second = await technician(org);
      const job = await fx.addJob(org, customer, { status: 'SCHEDULED', crew: [onCrew.id], soldBy: soldBy.id });
      const number = await jobNumberOf(job.id);

      const res = await (await fx.signedInAs(me)).post(`/api/jobs/${job.id}/assignees`, { assignee_ids: [onCrew.id, first.id, second.id] });
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      await reviewAttentionSettled();

      const alerts = await alertsFor(ASSIGNED, job.id);
      // Nobody is told twice.
      expect(new Set(everyone(alerts)).size).toBe(everyone(alerts).length);
      expect(everyone(alerts)).toEqual(ids(first, second, soldBy, onCrew, follower, holder));
      for (const named of [first, second]) {
        expect(titleFor(alerts, named)).toBe(`${number} assigned to you`);
        expect(rowFor(alerts, named)).toMatchObject({ priority: 'INTERRUPT', needs_action: false });
      }
      for (const other of [soldBy, onCrew, follower, holder]) {
        expect(titleFor(alerts, other), other.email).toBe(`${nameOf(first)} and ${nameOf(second)} were assigned to ${number}`);
        expect(rowFor(alerts, other)).toMatchObject({ priority: 'FEED', needs_action: false });
      }
      expect(whyFor(alerts, holder)).toBe('This job has no Dispatcher.');
      expect(whyFor(alerts, follower)).toBeNull();
    });

    it('a named person who is also on the chain (Sold By, a step holder, a follower) gets only the "you" form', async () => {
      const { org, customer } = await quietOrg();
      const me = await personWith(org, assignerValues);
      const everywhere = await technician(org, { ...stepValues, alert_every_job: true });
      const job = await fx.addJob(org, customer, { status: 'SCHEDULED', crew: [], soldBy: everywhere.id });
      const number = await jobNumberOf(job.id);

      const res = await (await fx.signedInAs(me)).post(`/api/jobs/${job.id}/assignees`, { assignee_ids: [everywhere.id] });
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      await reviewAttentionSettled();

      const alerts = await alertsFor(ASSIGNED, job.id);
      expect(everyone(alerts)).toEqual(ids(everywhere));
      expect(titleFor(alerts, everywhere)).toBe(`${number} assigned to you`);
      expect(whyFor(alerts, everywhere)).toBeNull();
    });

    it('a person who puts themselves on a job tells the others by name and is not told themselves', async () => {
      const { org, customer } = await quietOrg();
      const me = await personWith(org, { ...opensJobs, assign_people_to_jobs: true });
      const soldBy = await personWith(org, opensJobs);
      const job = await fx.addJob(org, customer, { status: 'SCHEDULED', crew: [], soldBy: soldBy.id });
      const number = await jobNumberOf(job.id);

      const res = await (await fx.signedInAs(me)).post(`/api/jobs/${job.id}/assignees`, { assignee_ids: [me.id] });
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      await reviewAttentionSettled();

      const alerts = await alertsFor(ASSIGNED, job.id);
      expect(everyone(alerts)).toEqual(ids(soldBy));
      expect(titleFor(alerts, soldBy)).toBe(`${nameOf(me)} was assigned to ${number}`);
    });

    it('the assign door (a window with the crew) says the same, and does not also call it a reschedule', async () => {
      const { org, customer } = await quietOrg();
      const me = await personWith(org, assignerValues);
      const soldBy = await personWith(org, opensJobs);
      const named = await technician(org);
      const job = await fx.addJob(org, customer, { status: 'SCHEDULED', crew: [], soldBy: soldBy.id });
      const number = await jobNumberOf(job.id);

      const res = await (await fx.signedInAs(me)).post(`/api/jobs/${job.id}/assign`, {
        assignee_ids: [named.id], scheduled_start: soon(5), scheduled_end: soon(5.1),
      });
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      await reviewAttentionSettled();

      const alerts = await alertsFor(ASSIGNED, job.id);
      expect(titleFor(alerts, named)).toBe(`${number} assigned to you`);
      expect(titleFor(alerts, soldBy)).toBe(`${nameOf(named)} was assigned to ${number}`);
      expect(await alertsFor('dispatch.job_rescheduled', job.id)).toEqual([]);
    });

    it('the per-visit door says the same for the person put on that trip', async () => {
      const { org, customer } = await quietOrg();
      const me = await personWith(org, assignerValues);
      const soldBy = await personWith(org, opensJobs);
      const named = await technician(org);
      const job = await fx.addJob(org, customer, { status: 'SCHEDULED', crew: [], soldBy: soldBy.id });
      const number = await jobNumberOf(job.id);

      const res = await (await fx.signedInAs(me)).post(`/api/jobs/${job.id}/visits/${job.visitId}/assignees`, { assignee_ids: [named.id] });
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      await reviewAttentionSettled();

      const alerts = await alertsFor(ASSIGNED, job.id);
      expect(titleFor(alerts, named)).toBe(`${number} assigned to you`);
      expect(titleFor(alerts, soldBy)).toBe(`${nameOf(named)} was assigned to ${number}`);
    });

    it('notify.in_app=false raises nothing, and restating the crew that is already on the job raises nothing', async () => {
      const { org, customer } = await quietOrg();
      const me = await personWith(org, assignerValues);
      const soldBy = await personWith(org, opensJobs);
      const onCrew = await technician(org);
      const added = await technician(org);
      const job = await fx.addJob(org, customer, { status: 'SCHEDULED', crew: [onCrew.id], soldBy: soldBy.id });
      const api = await fx.signedInAs(me);

      expect((await api.post(`/api/jobs/${job.id}/assignees`, { assignee_ids: [onCrew.id] })).status).toBe(200);
      expect((await api.post(`/api/jobs/${job.id}/assignees`, { assignee_ids: [onCrew.id, added.id], notify: { in_app: false } })).status).toBe(200);
      await reviewAttentionSettled();

      expect(await alertsFor(ASSIGNED, job.id)).toEqual([]);
    });

    it('a job booked with nobody on it raises no Job assigned alert (a first booking is today\'s "rescheduled" notice, kept as it was)', async () => {
      const { org, customer } = await quietOrg();
      const me = await personWith(org, assignerValues);
      const holder = await personWith(org, stepValues);
      const job = await fx.addJob(org, customer, { status: 'UNSCHEDULED' });

      const res = await (await fx.signedInAs(me)).post(`/api/jobs/${job.id}/assign`, {
        assignee_ids: [], scheduled_start: soon(5), scheduled_end: soon(5.1),
      });
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      await reviewAttentionSettled();

      expect(await alertsFor(ASSIGNED, job.id)).toEqual([]);
      expect(recipientsOf(await alertsFor('dispatch.job_rescheduled', job.id))).toEqual(ids(holder));
    });

    it('a bulk assign sends one alert per job, each to that job\'s own people, and the person put on every job is told once per job', async () => {
      const { org, customer } = await quietOrg();
      const me = await personWith(org, assignerValues);
      const sellerA = await personWith(org, opensJobs);
      const sellerB = await personWith(org, opensJobs);
      const named = await technician(org);
      const jobA = await fx.addJob(org, customer, { status: 'SCHEDULED', crew: [], soldBy: sellerA.id });
      const jobB = await fx.addJob(org, customer, { status: 'SCHEDULED', crew: [], soldBy: sellerB.id });

      const res = await (await fx.signedInAs(me)).post('/api/jobs/bulk-assign', { ids: [jobA.id, jobB.id], assignee_ids: [named.id] });
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect(res.body.updated).toHaveLength(2);
      await reviewAttentionSettled();

      const a = await alertsFor(ASSIGNED, jobA.id);
      const b = await alertsFor(ASSIGNED, jobB.id);
      expect(everyone(a)).toEqual(ids(named, sellerA));
      expect(everyone(b)).toEqual(ids(named, sellerB));
      expect(titleFor(a, sellerA)).toBe(`${nameOf(named)} was assigned to ${await jobNumberOf(jobA.id)}`);
      expect(titleFor(b, named)).toBe(`${await jobNumberOf(jobB.id)} assigned to you`);
    });
  });

  // ─── Unassigned from you: personal ────────────────────────────────────────────────────────────────────────────────────────

  describe('Unassigned from you is personal', () => {
    const UNASSIGNED = 'dispatch.job_unassigned';
    const assignerValues = { ...opensJobs, assign_people_to_jobs: true, assign_work_to_others: true };

    /** A job with a crowd around it: every kind of person the chain would normally reach. */
    async function crowdedJob(org: string, customer: string, removed: Person, kept: Person) {
      const dispatcher = await personWith(org, opensJobs);
      const soldBy = await personWith(org, opensJobs);
      const follower = await personWith(org, { ...opensJobs, alert_every_job: true });
      const holder = await personWith(org, stepValues);
      const manager = await personWith(org, managerValues);
      const dispatcherRole = await personWith(org, opensJobs, 'DISPATCHER');
      const adminRole = await personWith(org, opensJobs, 'ADMIN');
      const job = await fx.addJob(org, customer, { status: 'SCHEDULED', crew: [removed.id, kept.id], soldBy: soldBy.id, dispatcher: dispatcher.id });
      return { job, bystanders: [dispatcher, soldBy, follower, holder, manager, dispatcherRole, adminRole, kept] };
    }

    it('reaches only the removed crew member: never the Dispatcher, the step holders, the followers or the rest of the crew', async () => {
      const { org, customer } = await quietOrg();
      const me = await personWith(org, assignerValues);
      const removed = await personWith(org, opensJobs);
      const kept = await personWith(org, opensJobs);
      const { job, bystanders } = await crowdedJob(org, customer, removed, kept);
      const number = await jobNumberOf(job.id);

      const res = await (await fx.signedInAs(me)).post(`/api/jobs/${job.id}/assignees`, { assignee_ids: [kept.id] });
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      await reviewAttentionSettled();

      const alerts = await alertsFor(UNASSIGNED, job.id);
      expect(alerts).toHaveLength(1);
      expect(recipientsOf(alerts)).toEqual(ids(removed));
      expect(alerts[0]!.title).toBe(`${number} unassigned from you`);
      expect(alerts[0]!.body).toBeNull();
      expect(rowFor(alerts, removed)).toMatchObject({ priority: 'INTERRUPT', needs_action: false });
      for (const who of bystanders) expect(recipientsOf(alerts)).not.toContain(who.id);
    });

    it('the assign door removes and adds in one request: the removed person gets the personal alert, the added person the "you" alert', async () => {
      const { org, customer } = await quietOrg();
      const me = await personWith(org, assignerValues);
      const removed = await personWith(org, opensJobs);
      const kept = await personWith(org, opensJobs);
      const added = await personWith(org, { view_jobs: true, jobs_scope: 'attached', ...slots }, 'TECHNICIAN');
      const { job, bystanders } = await crowdedJob(org, customer, removed, kept);

      const res = await (await fx.signedInAs(me)).post(`/api/jobs/${job.id}/assign`, { assignee_ids: [kept.id, added.id] });
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      await reviewAttentionSettled();

      const gone = await alertsFor(UNASSIGNED, job.id);
      expect(recipientsOf(gone)).toEqual(ids(removed));
      for (const who of bystanders) expect(recipientsOf(gone)).not.toContain(who.id);
      expect(titleFor(await alertsFor('dispatch.job_assigned', job.id), added)).toBe(`${await jobNumberOf(job.id)} assigned to you`);
    });

    it('a person who takes themselves off the job is not told', async () => {
      const { org, customer } = await quietOrg();
      const me = await personWith(org, assignerValues);
      const kept = await personWith(org, opensJobs);
      const job = await fx.addJob(org, customer, { status: 'SCHEDULED', crew: [me.id, kept.id] });

      const res = await (await fx.signedInAs(me)).post(`/api/jobs/${job.id}/assignees`, { assignee_ids: [kept.id] });
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      await reviewAttentionSettled();

      expect(await alertsFor(UNASSIGNED, job.id)).toEqual([]);
    });

    it('a technician who sees only their own jobs is still told when they are taken off, though they can no longer open the job; the Dispatcher is not', async () => {
      const { org, customer } = await quietOrg();
      const me = await personWith(org, assignerValues);
      const removed = await personWith(org, { view_jobs: true, jobs_scope: 'attached', ...slots }, 'TECHNICIAN');
      const kept = await personWith(org, opensJobs);
      const dispatcher = await personWith(org, opensJobs);
      const job = await fx.addJob(org, customer, { status: 'SCHEDULED', crew: [removed.id, kept.id], dispatcher: dispatcher.id });

      const res = await (await fx.signedInAs(me)).post(`/api/jobs/${job.id}/assignees`, { assignee_ids: [kept.id] });
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      await reviewAttentionSettled();

      const alerts = await alertsFor(UNASSIGNED, job.id);
      expect(recipientsOf(alerts)).toEqual(ids(removed));
      expect(alerts[0]!.title).toBe(`${await jobNumberOf(job.id)} unassigned from you`);
    });

    it('taken off ONE trip but still on another: the alert names the trip, and is still personal', async () => {
      const { org, customer } = await quietOrg();
      const me = await personWith(org, assignerValues);
      const removed = await personWith(org, opensJobs);
      const dispatcher = await personWith(org, opensJobs);
      const follower = await personWith(org, { ...opensJobs, alert_every_job: true });
      const job = await fx.addJob(org, customer, { status: 'SCHEDULED', crew: [removed.id], dispatcher: dispatcher.id });
      await fx.addVisit(org, { jobId: job.id, crew: [removed.id], daysFromNow: 4, seq: 2 });

      const res = await (await fx.signedInAs(me)).post(`/api/jobs/${job.id}/visits/${job.visitId}/assignees`, { assignee_ids: [] });
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      await reviewAttentionSettled();

      const alerts = await alertsFor(UNASSIGNED, job.id);
      expect(recipientsOf(alerts)).toEqual(ids(removed));
      expect(alerts[0]!.title).toMatch(/ Visit 1 .* — you were removed from this visit$/);
      expect(recipientsOf(alerts)).not.toContain(dispatcher.id);
      expect(recipientsOf(alerts)).not.toContain(follower.id);
    });
  });

  // ─── Job rescheduled ──────────────────────────────────────────────────────────────────────────────────────────────────────

  describe('Job rescheduled', () => {
    it('a crew-only assign that moves no window raises none', async () => {
      const { org, customer } = await quietOrg();
      const me = await personWith(org, { ...opensJobs, assign_people_to_jobs: true });
      const crew = await personWith(org, opensJobs);
      const holder = await personWith(org, stepValues);
      const job = await fx.addJob(org, customer, { status: 'SCHEDULED', crew: [crew.id] });
      expect(holder.id).toBeTruthy();

      const res = await (await fx.signedInAs(me)).post(`/api/jobs/${job.id}/assign`, { assignee_ids: [crew.id] });
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      await reviewAttentionSettled();

      expect(await alertsFor('dispatch.job_rescheduled', job.id)).toEqual([]);
    });
  });

  // ─── Parts staged and ready ───────────────────────────────────────────────────────────────────────────────────────────────

  describe('Parts staged and ready', () => {
    const READY = 'inventory.staging_ready';
    const stager = (org: string) => personWith(org, { ...opensJobs, view_stock: true, edit_stock: true });

    it('is raised once for a stage: marking it ready a second time sends nothing more', async () => {
      const { org, customer } = await quietOrg();
      const me = await stager(org);
      const holder = await personWith(org, stepValues);
      const job = await fx.addJob(org, customer, { status: 'SCHEDULED' });
      const stageId = await addStage(org, { jobId: job.id, jobNumber: await jobNumberOf(job.id) });
      const api = await fx.signedInAs(me);

      expect((await api.post('/api/inventory/job-stages/notify', { stageId })).status).toBe(200);
      await reviewAttentionSettled();
      expect((await api.post('/api/inventory/job-stages/notify', { stageId })).status).toBe(200);
      await reviewAttentionSettled();

      const alerts = await alertsFor(READY, stageId);
      expect(alerts).toHaveLength(1);
      expect(recipientsOf(alerts)).toEqual(ids(holder));
    });

    it('the technician it is staged for is told (interrupted) even when they cannot open the job', async () => {
      const { org, customer } = await quietOrg();
      const me = await stager(org);
      const tech = await personWith(org, { view_jobs: true, jobs_scope: 'attached', view_stock: true }, 'TECHNICIAN');
      const holder = await personWith(org, stepValues);
      const job = await fx.addJob(org, customer, { status: 'SCHEDULED' });
      const stageId = await addStage(org, { jobId: job.id, jobNumber: await jobNumberOf(job.id), assignedTo: tech.id });

      expect((await (await fx.signedInAs(me)).post('/api/inventory/job-stages/notify', { stageId })).status).toBe(200);
      await reviewAttentionSettled();

      const alerts = await alertsFor(READY, stageId);
      expect(recipientsOf(alerts)).toEqual(ids(tech, holder));
      expect(rowFor(alerts, tech)).toMatchObject({ priority: 'INTERRUPT' });
      expect(rowFor(alerts, holder)).toMatchObject({ priority: 'FEED' });
      expect(whyFor(alerts, tech)).toBeNull();
      expect(whyFor(alerts, holder)).toBe('This job has no Dispatcher.');
    });

    it('a stage on no job has no people to chain on: only the technician it is staged for is told', async () => {
      const { org } = await quietOrg();
      const me = await stager(org);
      const tech = await personWith(org, { view_stock: true }, 'TECHNICIAN');
      const bystander = await personWith(org, { ...stepValues, alert_every_job: true });
      const manager = await personWith(org, managerValues);
      const stageId = await addStage(org, { jobId: null, jobNumber: 'J-LOOSE', assignedTo: tech.id });

      expect((await (await fx.signedInAs(me)).post('/api/inventory/job-stages/notify', { stageId })).status).toBe(200);
      await reviewAttentionSettled();

      const alerts = await alertsFor(READY, stageId);
      expect(recipientsOf(alerts)).toEqual(ids(tech));
      expect(alerts[0]!.title).toBe('Parts staged and ready for J-LOOSE');
      for (const who of [bystander, manager]) expect(recipientsOf(alerts)).not.toContain(who.id);
    });

    it('a stage on no job and with nobody on it logs the gap instead of dropping it silently', async () => {
      const { org } = await quietOrg();
      const me = await stager(org);
      const warn = vi.spyOn(logger, 'warn');
      const stageId = await addStage(org, { jobId: null, jobNumber: 'J-LOOSE' });

      expect((await (await fx.signedInAs(me)).post('/api/inventory/job-stages/notify', { stageId })).status).toBe(200);
      await reviewAttentionSettled();

      expect(await alertsFor(READY, stageId)).toEqual([]);
      const gaps = (warn.mock.calls as unknown[][]).filter((call) => String(call[0]).includes('parts staged alert: nobody to tell'));
      expect(gaps).toHaveLength(1);
      expect(gaps[0]![1]).toMatchObject({ organizationId: org, recordId: stageId });
    });
  });
});
