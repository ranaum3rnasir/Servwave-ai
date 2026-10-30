/* =============================================================================
   Roles & Permissions, PRD 6, slice S06.24 - the "Ready to close" alert on M6's two-lane chain.

   Finishing a review moves the job to Ready to close and one bell alert goes out: "J00123 is ready to close". Lane 1 is
   the job's people (its stored Sold By, crew and Dispatcher); lane 2 is EVERY Close jobs holder who can open the job,
   whether or not the job has a Dispatcher (closing is their step), else the Manage roles and permissions holders; holders
   of Alert me about every job get a copy. "Someone" is active, can open the job and is not the person who finished the
   review. Nobody comes from a role name. Its link opens the job itself (no panel), where the banner offers Mark Done. A
   job that goes back and is finished again alerts again; Mark Done raises no alert.

   Everything goes through the public interface: the finish route, called as people on custom roles holding exactly the
   switch values under test (every other toggle off), and the notification rows it leaves behind. Real migrated database
   (TEST_DATABASE_URL); the suite skips when it is unset. Every org it creates is removed again.
   ========================================================================== */

import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import type { PrismaClient, Role } from '@prisma/client';

// One client holding ONE connection, as the hosted database's does: a query on the global client from inside a
// transaction waits for a second connection that never comes, which a local pool of several hides.
const { realClient } = vi.hoisted(() => {
  const clientAt = (url: string) => {
    const { PrismaClient } = require('@prisma/client') as typeof import('@prisma/client');
    const pooled = new URL(url);
    pooled.searchParams.set('connection_limit', '1');
    pooled.searchParams.set('pool_timeout', '5');
    return new PrismaClient({ datasources: { db: { url: pooled.toString() } } });
  };
  const dbUrl = process.env.TEST_DATABASE_URL;
  return { realClient: dbUrl ? clientAt(dbUrl) : undefined };
});

// The suite-wide setup mocks the app's client; here it is the real one.
vi.mock('../lib/prisma', () => ({ prisma: realClient }));

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

const opensJobs = { view_jobs: true, jobs_scope: 'all', view_invoices: true, invoices_scope: 'all' };
/** The finisher: holds Office review (the only switch Finish review asks) and Close jobs, to prove the actor is never told. */
const finisherValues = { ...opensJobs, office_review: true, close_jobs: true };
const closerValues = { ...opensJobs, close_jobs: true };
const managerValues = { ...opensJobs, manage_roles_and_permissions: true, view_users: true };

type Api = Awaited<ReturnType<ReturnType<typeof switchFixture>['signedInAs']>>;

suite('the Ready to close alert (real database)', () => {
  const db = realClient as PrismaClient;
  const fx = switchFixture(db, async () => (await import('../app.js')).default as never);
  beforeAll(async () => {
    await import('../app.js');
  }, 120_000);
  afterAll(() => fx.cleanup());
  afterEach(() => vi.restoreAllMocks());

  let sequence = 0;

  /** A person on a fresh custom role holding exactly these switch values over everything else off. */
  async function personWith(org: string, values: Record<string, SwitchValue>, base: Role = 'DISPATCHER'): Promise<Person> {
    const key = `ready-alert-role-${++sequence}`;
    const role = await fx.addCustomRole(org, key, base);
    await setRoleSwitchValues({ organizationId: org, roleKey: key, values: { ...ALL_OFF, ...values }, actorId: null, reason: 'manual' });
    return fx.addUser(org, `p${sequence}`, base, { customRoleId: role.id });
  }

  /** A company with nobody but built people, so only they can be alerted. */
  async function quietOrg() {
    const world = await fx.newOrg();
    await db.user.update({ where: { id: world.admin.id }, data: { is_active: false } });
    return world;
  }

  /** A job in Office review with its open round and nothing to check but the job summary. */
  async function reviewJob(org: string, customer: string, opts: { crew?: string[]; soldBy?: string; dispatcher?: string }) {
    const job = await fx.addJob(org, customer, { status: 'OFFICE_REVIEW', pastVisit: true, crew: opts.crew ?? [], soldBy: opts.soldBy, dispatcher: opts.dispatcher });
    await db.job.update({ where: { id: job.id }, data: { completed_at: new Date() } });
    await db.jobReview.create({ data: { organization_id: org, job_id: job.id, window_start: new Date(Date.now() - 3_600_000) } });
    await db.timelineEvent.create({
      data: { organization_id: org, entity_type: 'JOB', entity_id: job.id, event_type: 'OFFICE_REVIEW_STARTED', description: 'Office review started', created_at: new Date(Date.now() + 5) },
    });
    return job;
  }

  /** Check the job summary the way a person would, then finish. */
  async function finish(api: Api, jobId: string) {
    const review = (await api.get(`/api/jobs/${jobId}/review`)).body.review;
    if (!review.summary.checked && review.summary.latest_entry_id) {
      const checked = await api.post(`/api/jobs/${jobId}/review/checks/all`, { items: [{ item_key: 'summary', entry_id: review.summary.latest_entry_id }] });
      expect(checked.status).toBe(200);
    }
    const version = (await api.get(`/api/jobs/${jobId}/review`)).body.review.version;
    const res = await api.post(`/api/jobs/${jobId}/review/finish`, { version });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    // The alert is sent once the response has gone out.
    await reviewAttentionSettled();
  }

  const alertsFor = (jobId: string) =>
    db.notification.findMany({ where: { object_id: jobId, verb: 'job.ready_to_close' }, include: { recipients: true }, orderBy: { created_at: 'asc' } });
  type Alerts = Awaited<ReturnType<typeof alertsFor>>;
  const recipientsOf = (rows: Alerts) => rows.flatMap((n) => n.recipients.map((r) => r.recipient_id)).sort();
  const ids = (...people: Person[]) => people.map((p) => p.id).sort();
  const whyFor = (rows: Alerts, person: Person) => rows.find((n) => n.recipients.some((r) => r.recipient_id === person.id))?.body ?? null;
  const rowFor = (rows: Alerts, person: Person) => rows.flatMap((n) => n.recipients).find((r) => r.recipient_id === person.id);

  it('reads "<job number> is ready to close", is a bell alert, and opens the job with no panel', async () => {
    const { org, customer } = await quietOrg();
    const me = await personWith(org, finisherValues);
    const closer = await personWith(org, closerValues);
    const job = await reviewJob(org, customer, {});
    const number = (await db.job.findUniqueOrThrow({ where: { id: job.id }, select: { job_number: true } })).job_number;

    await finish(await fx.signedInAs(me), job.id);

    const [alert] = await alertsFor(job.id);
    expect(alert!.title).toBe(`${number} is ready to close`);
    expect(alert).toMatchObject({ priority: 'FEED', object_type: 'JOB', object_id: job.id, category: 'JOB' });
    // The link is the job itself: the alert names no panel.
    expect((alert!.data as Record<string, unknown>).panel).toBeUndefined();
    // The people asked to close it are asked to act; the job's own people are only told.
    expect(rowFor([alert!], closer)).toMatchObject({ needs_action: true, priority: 'FEED' });
  });

  it('with a Dispatcher: lane 1, the Dispatcher AND every Close jobs holder who can open the job; no one else', async () => {
    const { org, customer } = await quietOrg();
    const me = await personWith(org, finisherValues);
    const soldBy = await personWith(org, opensJobs);
    const crew = await personWith(org, opensJobs);
    const dispatcher = await personWith(org, opensJobs);
    const closer = await personWith(org, closerValues);
    const secondCloser = await personWith(org, closerValues, 'TECHNICIAN');
    // A Dispatcher-role person without Close jobs who is not on the job gets nothing, and neither does one who can't open it.
    const bystander = await personWith(org, opensJobs);
    const cannotOpen = await personWith(org, { view_jobs: true, jobs_scope: 'attached', close_jobs: true });
    const job = await reviewJob(org, customer, { crew: [crew.id], soldBy: soldBy.id, dispatcher: dispatcher.id });

    await finish(await fx.signedInAs(me), job.id);

    const alerts = await alertsFor(job.id);
    expect(recipientsOf(alerts)).toEqual(ids(soldBy, crew, dispatcher, closer, secondCloser));
    for (const who of [bystander, cannotOpen, me]) expect(recipientsOf(alerts)).not.toContain(who.id);
    // Nobody is covering for a missing Dispatcher, so no why line anywhere.
    expect(alerts.every((n) => n.body === null)).toBe(true);
    const needing = alerts.flatMap((n) => n.recipients).filter((r) => r.needs_action).map((r) => r.recipient_id).sort();
    expect(needing).toEqual(ids(closer, secondCloser));
  });

  it('without a Dispatcher: the same people, with no why line (closing is the Close jobs holders\' own step)', async () => {
    const { org, customer } = await quietOrg();
    const me = await personWith(org, finisherValues);
    const soldBy = await personWith(org, opensJobs);
    const closer = await personWith(org, closerValues);
    // An Admin-role person with Close jobs off is not told: a role name holds nothing, the switch does.
    const adminCloseOff = await personWith(org, opensJobs, 'ADMIN');
    const gone = await personWith(org, closerValues);
    await db.user.update({ where: { id: gone.id }, data: { is_active: false } });
    const job = await reviewJob(org, customer, { soldBy: soldBy.id });

    await finish(await fx.signedInAs(me), job.id);

    const alerts = await alertsFor(job.id);
    expect(recipientsOf(alerts)).toEqual(ids(soldBy, closer));
    for (const who of [adminCloseOff, gone]) expect(recipientsOf(alerts)).not.toContain(who.id);
    expect(alerts.every((n) => n.body === null)).toBe(true);
  });

  it('with no Close jobs holder who can open the job: the Manage roles and permissions holders, with the why line', async () => {
    const { org, customer } = await quietOrg();
    const me = await personWith(org, finisherValues);
    const manager = await personWith(org, managerValues);
    const cannotOpen = await personWith(org, { view_jobs: true, jobs_scope: 'attached', close_jobs: true });
    const noSwitch = await personWith(org, opensJobs);
    const job = await reviewJob(org, customer, {});

    await finish(await fx.signedInAs(me), job.id);

    const alerts = await alertsFor(job.id);
    expect(recipientsOf(alerts)).toEqual(ids(manager));
    expect(recipientsOf(alerts)).not.toContain(cannotOpen.id);
    expect(recipientsOf(alerts)).not.toContain(noSwitch.id);
    expect(whyFor(alerts, manager)).toBe('Nobody who can close jobs can open this job.');
  });

  it('a Dispatcher who did the action is not told, and does not stop the Close jobs holders from being told', async () => {
    const { org, customer } = await quietOrg();
    const me = await personWith(org, finisherValues);
    const closer = await personWith(org, closerValues);
    const job = await reviewJob(org, customer, { dispatcher: me.id });

    await finish(await fx.signedInAs(me), job.id);

    expect(recipientsOf(await alertsFor(job.id))).toEqual(ids(closer));
  });

  it('a person found twice gets one alert, and a copy reaches "Alert me about every job" holders on jobs they can open only; a copy never stops the chain', async () => {
    const { org, customer } = await quietOrg();
    const me = await personWith(org, finisherValues);
    // Sold By, Close jobs holder and follower at once.
    const everywhere = await personWith(org, { ...closerValues, alert_every_job: true });
    const follower = await personWith(org, { ...opensJobs, alert_every_job: true });
    const blindFollower = await personWith(org, { view_jobs: true, jobs_scope: 'attached', alert_every_job: true });
    const job = await reviewJob(org, customer, { soldBy: everywhere.id });

    await finish(await fx.signedInAs(me), job.id);

    const alerts = await alertsFor(job.id);
    expect(recipientsOf(alerts)).toEqual(ids(everywhere, follower));
    expect(recipientsOf(alerts)).not.toContain(blindFollower.id);
  });

  it('a chain that finds nobody writes one log entry with the alert kind, record id and org id and no customer content; one that finds someone writes none', async () => {
    const { org, customer } = await quietOrg();
    const me = await personWith(org, finisherValues);
    const warn = vi.spyOn(logger, 'warn');
    const gaps = () => (warn.mock.calls as unknown[][]).filter((call) => /ready to close alert/i.test(String(call[0])));

    const lonely = await reviewJob(org, customer, {});
    await finish(await fx.signedInAs(me), lonely.id);
    expect(await alertsFor(lonely.id)).toEqual([]);
    expect(gaps()).toHaveLength(1);
    expect(gaps()[0]![1]).toMatchObject({ organizationId: org, recordId: lonely.id });
    expect(JSON.stringify(gaps()[0])).not.toMatch(/Pat|Payer/);

    warn.mockClear();
    const closer = await personWith(org, closerValues);
    const covered = await reviewJob(org, customer, {});
    await finish(await fx.signedInAs(me), covered.id);
    expect(recipientsOf(await alertsFor(covered.id))).toEqual(ids(closer));
    expect(gaps()).toHaveLength(0);
  });

  it('a job that goes back and is finished again alerts again; Mark Done raises no alert', async () => {
    const { org, customer } = await quietOrg();
    const me = await personWith(org, { ...finisherValues, complete_jobs: true, view_jobs: true });
    const closer = await personWith(org, { ...closerValues, close_jobs_with_money_owed: true });
    const job = await reviewJob(org, customer, {});
    const api = await fx.signedInAs(me);

    await finish(api, job.id);
    expect(await alertsFor(job.id)).toHaveLength(1);

    // Sent back to Office review (the round is opened again), then finished once more.
    await db.job.update({ where: { id: job.id }, data: { status: 'OFFICE_REVIEW' } });
    await db.jobReview.updateMany({ where: { job_id: job.id }, data: { state: 'OPEN', finished_at: null, finished_by_id: null } });
    await finish(api, job.id);
    const alerts = await alertsFor(job.id);
    expect(alerts).toHaveLength(2);
    expect(recipientsOf(alerts)).toEqual(ids(closer, closer));

    // Mark Done: none.
    const before = await db.notification.count({ where: { object_id: job.id } });
    const done = await (await fx.signedInAs(closer)).post(`/api/jobs/${job.id}/mark-done`, {});
    expect(done.status, JSON.stringify(done.body)).toBe(200);
    expect((await db.job.findUniqueOrThrow({ where: { id: job.id }, select: { status: true } })).status).toBe('DONE');
    expect(await db.notification.count({ where: { object_id: job.id } })).toBe(before);
  });
});
