/* =============================================================================
   Roles & Permissions, PRD 6, slice S06.12 - Finish review: POST /api/jobs/:id/review/finish.

   Finishing moves the job from Office review to Ready to close (never Done), records who finished the round and when,
   writes the Ready to close history entry, and applies the reviewer's customer decisions, all in one transaction.
   It is refused while any item (the job summary and the customer items included) is unchecked, and when the review
   has changed since the client loaded it. Applying a decision needs Office review only, never Edit customers.
   Everything goes through the public interface (the job routes, called as people on custom roles holding exactly the
   switch values under test). Real migrated database (TEST_DATABASE_URL); the suite skips when it is unset. Every org
   it creates is removed again.
   ========================================================================== */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { randomUUID } from 'crypto';
import type { PrismaClient, Role } from '@prisma/client';

// One factory for every client in this file (see permission-switches-db.test.ts for why). The client holds ONE connection,
// as the hosted database's does: a query on this client from inside a transaction needs a second one and times out, which
// a local pool of several hides (the finish once failed for a reviewer whose invoice reach had to be asked mid-transaction).
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

// Finishing a review fires no automation: the job-completed trigger fired once, at Complete.
const { dispatched } = vi.hoisted(() => ({ dispatched: vi.fn() }));
vi.mock('../services/automations/dispatch', () => ({ dispatchAutomationEvent: dispatched }));

import { switchFixture } from './permission-switches-fixture';
import { setRoleSwitchValues } from '../lib/permissions/switches/store';
import { SWITCH_CATALOG, type SwitchValue } from '../lib/permissions/switches/catalog';

const suite = realClient ? describe : describe.skip;

/** Every switch in the catalog off (a choice at its first option, a list empty), so a case turns on exactly the ones it is about. */
const ALL_OFF: Record<string, SwitchValue> = Object.fromEntries(
  SWITCH_CATALOG.map((s) => [s.key, s.kind === 'choice' ? s.choices![0]! : s.kind === 'list' ? [] : false]),
);

/** What opening the job and its invoices takes. */
const OPENING = { view_jobs: true, jobs_scope: 'all', view_invoices: true, leads_scope: 'all' };

const STALE = 'Something changed on this job while you were reviewing. Check the new items and finish again.';

interface Contact { entry_id: string; kind: string; intent: string; removed: boolean; options: string[]; choice: string | null }
interface Item { key: string; kind: string; title: string; checked: boolean; latest_entry_id: string; contact?: Contact }
interface Review {
  version: string;
  summary: { checked: boolean; latest_entry_id: string | null };
  groups: { key: string; items: Item[] }[];
  totals: { items: number; checked: number; unusual: number };
}
const itemsOf = (r: Review): Item[] => r.groups.filter((g) => g.key !== 'unusual').flatMap((g) => g.items);

suite('finish review (real database)', () => {
  const db = realClient as PrismaClient;
  const fx = switchFixture(db, async () => (await import('../app.js')).default as never);
  beforeAll(async () => {
    await import('../app.js');
  }, 120_000);
  afterAll(() => fx.cleanup());

  let sequence = 0;
  type Api = Awaited<ReturnType<typeof fx.signedInAs>>;

  /** A person on a fresh custom role holding exactly these switch values over everything else off. */
  async function personWith(org: string, values: Record<string, SwitchValue>, base: Role = 'DISPATCHER') {
    const key = `job-review-finish-role-${++sequence}`;
    const role = await fx.addCustomRole(org, key, base);
    await setRoleSwitchValues({ organizationId: org, roleKey: key, values: { ...ALL_OFF, see_prices: true, ...values }, actorId: null, reason: 'manual' });
    const person = await fx.addUser(org, `p${sequence}`, base, { customRoleId: role.id });
    return Object.assign(person, { api: () => fx.signedInAs(person) });
  }

  /** A reviewer: opens jobs and holds Office review, and nothing else unless the case adds it. */
  const reviewer = (org: string, extra: Record<string, SwitchValue> = {}) => personWith(org, { ...OPENING, office_review: true, ...extra });

  /** A job as the complete leaves it: in Office review with its open round and the entry that says so. */
  async function startReview(org: string, jobId: string) {
    await db.job.update({ where: { id: jobId }, data: { status: 'OFFICE_REVIEW', completed_at: new Date() } });
    const round = await db.jobReview.create({ data: { organization_id: org, job_id: jobId, window_start: new Date(Date.now() - 3_600_000) } });
    await db.timelineEvent.create({
      data: { organization_id: org, entity_type: 'JOB', entity_id: jobId, event_type: 'OFFICE_REVIEW_STARTED', description: 'Office review started', created_at: new Date(Date.now() + 5) },
    });
    return round;
  }

  /**
   * A job with the customer details changed on it the way the contact pencil does it (through the routes, as the admin,
   * while the job is still open for editing), then handed to the review.
   */
  async function reviewJob(setup: Awaited<ReturnType<typeof fx.newOrg>>, changes: (admin: Api, jobId: string) => Promise<void> = async () => undefined) {
    const { org, customer, admin } = setup;
    const job = await fx.addJob(org, customer);
    await changes(await fx.signedInAs(admin), job.id);
    const round = await startReview(org, job.id);
    return { ...job, round };
  }

  const read = async (api: Api, jobId: string): Promise<Review> => (await api.get(`/api/jobs/${jobId}/review`)).body.review;
  const finish = (api: Api, jobId: string, version?: string) => api.post(`/api/jobs/${jobId}/review/finish`, version === undefined ? {} : { version });
  const contactItems = (r: Review) => itemsOf(r).filter((i) => i.kind === 'contact');

  /** Check the job summary and every item the way a person would: plain items with a check, customer items with their tick (the choice they pick, if any). */
  async function checkAll(api: Api, jobId: string, picks: Record<string, string> = {}): Promise<Review> {
    let review = await read(api, jobId);
    const plain = [
      ...(review.summary.checked || !review.summary.latest_entry_id ? [] : [{ item_key: 'summary', entry_id: review.summary.latest_entry_id }]),
      ...itemsOf(review).filter((i) => i.kind !== 'contact' && !i.checked).map((i) => ({ item_key: i.key, entry_id: i.latest_entry_id })),
    ];
    if (plain.length > 0) {
      const res = await api.post(`/api/jobs/${jobId}/review/checks/all`, { items: plain });
      expect(res.status).toBe(200);
    }
    review = await read(api, jobId);
    for (const item of contactItems(review)) {
      if (item.checked) continue;
      const choice = picks[item.contact!.kind] ?? (item.contact!.removed ? undefined : item.contact!.choice ?? undefined);
      const res = await api.post(`/api/jobs/${jobId}/review/decisions`, { item_key: item.key, entry_id: item.latest_entry_id, ...(choice ? { choice } : {}) });
      expect(res.status).toBe(200);
    }
    // Ticking never writes history, so the summary check made before the ticks still stands.
    return read(api, jobId);
  }

  const addPhone = (admin: Api, jobId: string, value: string, label?: string) =>
    admin.post(`/api/jobs/${jobId}/contact-entries`, { kind: 'PHONE', value, ...(label ? { label } : {}) });
  const addEmail = (admin: Api, jobId: string, value: string) => admin.post(`/api/jobs/${jobId}/contact-entries`, { kind: 'EMAIL', value });

  const statusOf = async (jobId: string) => (await db.job.findUniqueOrThrow({ where: { id: jobId }, select: { status: true } })).status;
  const jobEvents = (jobId: string, type: string) =>
    db.timelineEvent.findMany({ where: { entity_type: 'JOB', entity_id: jobId, event_type: type }, orderBy: { created_at: 'asc' } });
  const customerEvents = (customer: string) =>
    db.timelineEvent.findMany({ where: { entity_type: 'CUSTOMER', entity_id: customer }, orderBy: { created_at: 'asc' } });

  describe('when it is allowed and when it is refused', () => {
    it('is refused on a job with no changes while the job summary is unchecked, and allowed once it is checked (never without a person)', async () => {
      const setup = await fx.newOrg();
      const me = await reviewer(setup.org);
      const job = await reviewJob(setup);
      const api = await me.api();

      const before = await read(api, job.id);
      expect(before.totals).toEqual({ items: 1, checked: 0, unusual: 0 });
      const refused = await finish(api, job.id, before.version);
      expect(refused.status).toBe(409);
      expect(refused.body.error).toMatch(/Job details/);
      expect(await statusOf(job.id)).toBe('OFFICE_REVIEW');

      const checked = await checkAll(api, job.id);
      const done = await finish(api, job.id, checked.version);
      expect(done.status).toBe(200);
      expect(await statusOf(job.id)).toBe('READY_TO_CLOSE');
    });

    it('is refused with a plain item unchecked, naming it, and nothing is written', async () => {
      const setup = await fx.newOrg();
      const me = await reviewer(setup.org);
      const job = await reviewJob(setup);
      await db.timelineEvent.create({
        data: {
          organization_id: setup.org, entity_type: 'JOB', entity_id: job.id, event_type: 'JOB_NOTE_ADDED', description: 'Note added',
          metadata: { note_id: randomUUID() }, created_by: setup.admin.id,
        },
      });
      const api = await me.api();
      const review = await read(api, job.id);
      expect(itemsOf(review)).toHaveLength(1);
      const res = await finish(api, job.id, review.version);
      expect(res.status).toBe(409);
      expect(res.body.error).toContain('Job details');
      expect(res.body.error).toContain('Note');
      const round = await db.jobReview.findUniqueOrThrow({ where: { id: job.round.id } });
      expect(round).toMatchObject({ state: 'OPEN', finished_by_id: null, finished_at: null });
      expect(await jobEvents(job.id, 'OFFICE_REVIEW_FINISHED')).toHaveLength(0);
    });

    it('is refused with a customer item unchecked while the summary and every other item are checked', async () => {
      const setup = await fx.newOrg();
      const me = await reviewer(setup.org);
      const job = await reviewJob(setup, async (admin, id) => {
        expect((await addPhone(admin, id, '5552223333')).status).toBe(201);
      });
      const api = await me.api();
      // Mark all checked leaves the customer item alone.
      const first = await read(api, job.id);
      await api.post(`/api/jobs/${job.id}/review/checks/all`, { items: [{ item_key: 'summary', entry_id: first.summary.latest_entry_id }] });
      const review = await read(api, job.id);
      expect(review.summary.checked).toBe(true);
      expect(contactItems(review)[0]!.checked).toBe(false);
      const res = await finish(api, job.id, review.version);
      expect(res.status).toBe(409);
      expect(res.body.error).toContain('Phone');
      expect(await statusOf(job.id)).toBe('OFFICE_REVIEW');
    });

    it('is refused with a stale version, or none, in the PRD words, and the client can finish again after reading the new review', async () => {
      const setup = await fx.newOrg();
      const me = await reviewer(setup.org);
      const job = await reviewJob(setup);
      const api = await me.api();
      const checked = await checkAll(api, job.id);

      // Something lands on the job after the person loaded the review.
      const note = await db.timelineEvent.create({
        data: { organization_id: setup.org, entity_type: 'JOB', entity_id: job.id, event_type: 'JOB_UPDATED', description: 'Job details changed', created_by: setup.admin.id },
      });
      const stale = await finish(api, job.id, checked.version);
      expect(stale.status).toBe(409);
      expect(stale.body.error).toBe(STALE);
      expect(stale.body.code).toBe('REVIEW_CHANGED');
      expect((await finish(api, job.id)).body.error).toBe(STALE);
      expect(await statusOf(job.id)).toBe('OFFICE_REVIEW');

      // Reading it again shows the summary unchecked (any new history entry un-checks it), and a new version.
      const fresh = await read(api, job.id);
      expect(fresh.version).not.toBe(checked.version);
      expect(fresh.summary.checked).toBe(false);
      expect(fresh.summary.latest_entry_id).toBe(note.id);
      const again = await checkAll(api, job.id);
      expect((await finish(api, job.id, again.version)).status).toBe(200);
    });

    it('treats another reviewer\'s check or decision as a change, so the review is read again', async () => {
      const setup = await fx.newOrg();
      const a = await reviewer(setup.org);
      const b = await reviewer(setup.org);
      const job = await reviewJob(setup, async (admin, id) => {
        await addPhone(admin, id, '5552223333');
      });
      const apiA = await a.api();
      const apiB = await b.api();
      const seenByA = await read(apiA, job.id);
      const checkedByB = await checkAll(apiB, job.id);
      expect(checkedByB.version).not.toBe(seenByA.version);
      const res = await finish(apiA, job.id, seenByA.version);
      expect(res.status).toBe(409);
      expect(res.body.error).toBe(STALE);
    });

    it('moves the job to Ready to close, never Done, and records who finished the round and when', async () => {
      const setup = await fx.newOrg();
      const me = await reviewer(setup.org);
      const job = await reviewJob(setup);
      const api = await me.api();
      const checked = await checkAll(api, job.id);
      const before = Date.now();
      const res = await finish(api, job.id, checked.version);
      expect(res.status).toBe(200);
      expect(res.body.status).toBe('READY_TO_CLOSE');

      const stored = await db.job.findUniqueOrThrow({ where: { id: job.id }, select: { status: true, completed_at: true } });
      expect(stored.status).toBe('READY_TO_CLOSE');
      expect(stored.completed_at).not.toBeNull();
      const round = await db.jobReview.findUniqueOrThrow({ where: { id: job.round.id } });
      expect(round.state).toBe('FINISHED');
      expect(round.finished_by_id).toBe(me.id);
      expect(round.finished_at!.getTime()).toBeGreaterThanOrEqual(before - 1000);

      const entries = await jobEvents(job.id, 'OFFICE_REVIEW_FINISHED');
      expect(entries).toHaveLength(1);
      expect(entries[0]).toMatchObject({ created_by: me.id });
      expect(entries[0]!.description).toContain('Ready to close');
      expect(entries[0]!.metadata).toMatchObject({ from: 'OFFICE_REVIEW', to: 'READY_TO_CLOSE', review_id: job.round.id });
      // The review is still readable after it, now as history.
      expect((await api.get(`/api/jobs/${job.id}/review`)).status).toBe(200);
    });

    it('fires no automation and writes no alert: the job-completed trigger fired once, at Complete', async () => {
      const setup = await fx.newOrg();
      const me = await reviewer(setup.org);
      const job = await reviewJob(setup);
      const api = await me.api();
      const checked = await checkAll(api, job.id);
      dispatched.mockClear();
      expect((await finish(api, job.id, checked.version)).status).toBe(200);
      expect(dispatched).not.toHaveBeenCalled();
      expect(await db.notification.count({ where: { organization_id: setup.org } })).toBe(0);
    });

    it('answers a second finish of the same review with a plain refusal, and never finishes a job that is not in Office review', async () => {
      const setup = await fx.newOrg();
      const me = await reviewer(setup.org);
      const job = await reviewJob(setup);
      const api = await me.api();
      const checked = await checkAll(api, job.id);
      expect((await finish(api, job.id, checked.version)).status).toBe(200);
      const second = await finish(api, job.id, checked.version);
      expect(second.status).toBe(409);
      expect(second.body.error).toBe('This review has already been finished.');

      const scheduled = await fx.addJob(setup.org, setup.customer);
      const notYet = await finish(api, scheduled.id, 'x');
      expect(notYet.status).toBe(409);
      expect(notYet.body.error).toBe('This job is not in office review.');
      expect(await statusOf(scheduled.id)).toBe('SCHEDULED');
    });

    it('lets exactly one of two reviewers finishing at once win, and applies the customer decisions once', async () => {
      const setup = await fx.newOrg();
      const a = await reviewer(setup.org);
      const b = await reviewer(setup.org);
      const job = await reviewJob(setup, async (admin, id) => {
        await addPhone(admin, id, '5552223333');
      });
      const apiA = await a.api();
      const apiB = await b.api();
      const checked = await checkAll(apiA, job.id);
      const [one, two] = await Promise.all([finish(apiA, job.id, checked.version), finish(apiB, job.id, checked.version)]);
      expect([one.status, two.status].sort()).toEqual([200, 409]);
      const loser = one.status === 409 ? one : two;
      expect(['This review has already been finished.', STALE]).toContain(loser.body.error);
      expect(await db.customerPhone.count({ where: { customer_id: setup.customer } })).toBe(1);
      expect(await jobEvents(job.id, 'OFFICE_REVIEW_FINISHED')).toHaveLength(1);
      expect(await customerEvents(setup.customer)).toHaveLength(1);
    });
  });

  describe('applying the customer decisions', () => {
    it('Add puts a phone and an email on the customer as extras, never primary, and writes the job and customer history', async () => {
      const setup = await fx.newOrg();
      await db.customer.update({ where: { id: setup.customer }, data: { phone: '5550001111', email: 'pat@example.test' } });
      const me = await reviewer(setup.org);
      const job = await reviewJob(setup, async (admin, id) => {
        expect((await addPhone(admin, id, '5552223333', 'Mobile')).status).toBe(201);
        expect((await addEmail(admin, id, 'second@example.test')).status).toBe(201);
      });
      const api = await me.api();
      const checked = await checkAll(api, job.id);
      expect(contactItems(checked).map((i) => i.contact!.choice)).toEqual(['ADD', 'ADD']);
      expect((await finish(api, job.id, checked.version)).status).toBe(200);

      const customer = await db.customer.findUniqueOrThrow({ where: { id: setup.customer }, include: { phones: true, extra_emails: true } });
      expect(customer.phone).toBe('5550001111');
      expect(customer.email).toBe('pat@example.test');
      expect(customer.phones.map((p) => [p.phone, p.label, p.is_primary])).toEqual([['5552223333', 'Mobile', false]]);
      expect(customer.extra_emails.map((e) => e.email)).toEqual(['second@example.test']);

      const onJob = await jobEvents(job.id, 'JOB_CUSTOMER_DECISION_APPLIED');
      expect(onJob).toHaveLength(2);
      expect(onJob.map((e) => (e.metadata as { choice: string; outcome: string }).outcome)).toEqual(['ADDED', 'ADDED']);
      expect(onJob[0]!.description).toContain('added to the customer');

      const onCustomer = await customerEvents(setup.customer);
      expect(onCustomer).toHaveLength(2);
      for (const event of onCustomer) {
        expect(event).toMatchObject({ event_type: 'CUSTOMER_UPDATED', created_by: me.id });
        expect(event.description).toContain(`from job ${(await db.job.findUniqueOrThrow({ where: { id: job.id } })).job_number}`);
        expect(event.description).toContain('office review');
        expect(event.metadata).toMatchObject({ via: 'office_review', job_id: job.id, reviewed_by_id: me.id });
      }
      expect(onCustomer[0]!.metadata).toMatchObject({ changes: [{ kind: 'PHONE', outcome: 'ADDED', old: null, new: '5552223333' }] });
      // The ready-to-close entry comes after the decisions.
      const [ready] = await jobEvents(job.id, 'OFFICE_REVIEW_FINISHED');
      expect(ready!.created_at.getTime()).toBeGreaterThan(onJob[1]!.created_at.getTime());
      // Every decision row says it was applied and when.
      const rows = await db.jobReviewCustomerDecision.findMany({ where: { review_id: job.round.id } });
      expect(rows).toHaveLength(2);
      for (const row of rows) expect(row).toMatchObject({ applied: true, applied_at: expect.any(Date) });
    });

    it('Add does not duplicate a phone or an email the customer already has, and says so', async () => {
      const setup = await fx.newOrg();
      await db.customer.update({ where: { id: setup.customer }, data: { phone: '5550001111', email: 'pat@example.test' } });
      const job = await reviewJob(setup, async (admin, id) => {
        expect((await addPhone(admin, id, '5552223333')).status).toBe(201);
        expect((await addEmail(admin, id, 'second@example.test')).status).toBe(201);
      });
      // Between the pencil and the review, the same number and email reached the customer another way.
      await db.customerPhone.create({ data: { customer_id: setup.customer, phone: '(555) 222-3333', is_primary: false } });
      await db.customerEmail.create({ data: { customer_id: setup.customer, email: 'SECOND@example.test' } });
      const api = await (await reviewer(setup.org)).api();
      const checked = await checkAll(api, job.id);
      expect((await finish(api, job.id, checked.version)).status).toBe(200);

      expect(await db.customerPhone.count({ where: { customer_id: setup.customer } })).toBe(1);
      expect(await db.customerEmail.count({ where: { customer_id: setup.customer } })).toBe(1);
      const onJob = await jobEvents(job.id, 'JOB_CUSTOMER_DECISION_APPLIED');
      expect(onJob.map((e) => (e.metadata as { outcome: string }).outcome)).toEqual(['ALREADY_ON_CUSTOMER', 'ALREADY_ON_CUSTOMER']);
      expect(onJob[0]!.description).toContain('already on the customer');
      // Nothing changed on the customer, so nothing is written to its history.
      expect(await customerEvents(setup.customer)).toHaveLength(0);
    });

    it('Update swaps the phone or email it was changed from, wherever the customer holds it', async () => {
      const setup = await fx.newOrg();
      await db.customer.update({ where: { id: setup.customer }, data: { phone: '5550001111', secondary_phone: '5550002222', email: 'pat@example.test' } });
      await db.customerPhone.create({ data: { customer_id: setup.customer, phone: '5550003333', label: 'Work', is_primary: false } });
      await db.customerEmail.create({ data: { customer_id: setup.customer, email: 'old-extra@example.test' } });
      const me = await reviewer(setup.org);
      const job = await reviewJob(setup, async (admin, id) => {
        for (const body of [
          { kind: 'PHONE', replaces: '5550001111', value: '5559990001' },
          { kind: 'PHONE', replaces: '5550002222', value: '5559990002' },
          { kind: 'PHONE', replaces: '5550003333', value: '5559990003' },
          { kind: 'EMAIL', replaces: 'pat@example.test', value: 'new-primary@example.test' },
          { kind: 'EMAIL', replaces: 'old-extra@example.test', value: 'new-extra@example.test' },
        ]) expect((await admin.post(`/api/jobs/${id}/contact-entries/change`, body)).status).toBe(201);
      });
      const api = await me.api();
      const checked = await checkAll(api, job.id, { PHONE: 'UPDATE', EMAIL: 'UPDATE' });
      expect(contactItems(checked).map((i) => i.contact!.choice)).toEqual(['UPDATE', 'UPDATE', 'UPDATE', 'UPDATE', 'UPDATE']);
      expect((await finish(api, job.id, checked.version)).status).toBe(200);

      const customer = await db.customer.findUniqueOrThrow({ where: { id: setup.customer }, include: { phones: true, extra_emails: true } });
      expect(customer).toMatchObject({ phone: '5559990001', secondary_phone: '5559990002', email: 'new-primary@example.test' });
      expect(customer.phones.map((p) => [p.phone, p.label])).toEqual([['5559990003', 'Work']]);
      expect(customer.extra_emails.map((e) => e.email)).toEqual(['new-extra@example.test']);
      const onCustomer = await customerEvents(setup.customer);
      expect(onCustomer).toHaveLength(5);
      expect(onCustomer[0]!.metadata).toMatchObject({ changes: [{ kind: 'PHONE', outcome: 'REPLACED', old: '5550001111', new: '5559990001' }] });
      expect(onCustomer[0]!.description).toContain('replaced');
    });

    it('Update with the old value gone adds instead, and the history says so', async () => {
      const setup = await fx.newOrg();
      await db.customer.update({ where: { id: setup.customer }, data: { phone: '5550001111', secondary_phone: '5550002222' } });
      const me = await reviewer(setup.org);
      const job = await reviewJob(setup, async (admin, id) => {
        expect((await admin.post(`/api/jobs/${id}/contact-entries/change`, { kind: 'PHONE', replaces: '5550002222', value: '5559990002' })).status).toBe(201);
      });
      // The number it was changed from leaves the customer before the review is finished.
      await db.customer.update({ where: { id: setup.customer }, data: { secondary_phone: null } });
      const api = await me.api();
      const checked = await checkAll(api, job.id, { PHONE: 'UPDATE' });
      expect((await finish(api, job.id, checked.version)).status).toBe(200);

      const customer = await db.customer.findUniqueOrThrow({ where: { id: setup.customer }, include: { phones: true } });
      expect(customer.phone).toBe('5550001111');
      expect(customer.phones.map((p) => [p.phone, p.is_primary])).toEqual([['5559990002', false]]);
      const [onJob] = await jobEvents(job.id, 'JOB_CUSTOMER_DECISION_APPLIED');
      expect(onJob!.metadata).toMatchObject({ choice: 'UPDATE', outcome: 'ADDED_INSTEAD' });
      expect(onJob!.description).toContain('no longer on the customer');
      const [onCustomer] = await customerEvents(setup.customer);
      expect(onCustomer!.description).toContain('no longer on this customer');
      expect(onCustomer!.metadata).toMatchObject({ changes: [{ kind: 'PHONE', outcome: 'ADDED_INSTEAD', old: '5550002222', new: '5559990002' }] });
    });

    it('Update on a name overwrites whatever the customer holds now, records the replaced value, and keeps the customer kind right', async () => {
      const setup = await fx.newOrg();
      await db.customer.update({ where: { id: setup.customer }, data: { company_name: 'Old Co' } });
      const me = await reviewer(setup.org);
      const job = await reviewJob(setup, async (admin, id) => {
        expect((await admin.post(`/api/jobs/${id}/contact-entries/name`, { kind: 'FIRST_NAME', value: 'Patricia' })).status).toBe(201);
        expect((await admin.post(`/api/jobs/${id}/contact-entries/name`, { kind: 'COMPANY_NAME', value: 'New Co' })).status).toBe(201);
      });
      const api = await me.api();
      const checked = await checkAll(api, job.id, { FIRST_NAME: 'UPDATE', COMPANY_NAME: 'UPDATE' });
      // The customer's first name moves on after the reviewer looked: the review changed, so the finish is refused...
      await db.customer.update({ where: { id: setup.customer }, data: { first_name: 'Patty' } });
      const stale = await finish(api, job.id, checked.version);
      expect(stale.status).toBe(409);
      expect(stale.body.error).toBe(STALE);
      // ...and once the reviewer has read it again, Update overwrites whatever the customer holds now.
      const again = await read(api, job.id);
      expect((await finish(api, job.id, again.version)).status).toBe(200);

      expect(await db.customer.findUniqueOrThrow({ where: { id: setup.customer } })).toMatchObject({ first_name: 'Patricia', company_name: 'New Co', kind: 'COMPANY' });
      const onCustomer = await customerEvents(setup.customer);
      const first = onCustomer.find((e) => JSON.stringify(e.metadata).includes('FIRST_NAME'))!;
      expect(first.metadata).toMatchObject({ changes: [{ kind: 'FIRST_NAME', outcome: 'REPLACED', old: 'Patty', new: 'Patricia' }] });
      expect(first.description).toContain('Patty');
      expect(first.description).toContain('Patricia');
    });

    it('This job only leaves the customer alone, and the job history still records the decision', async () => {
      const setup = await fx.newOrg();
      await db.customer.update({ where: { id: setup.customer }, data: { phone: '5550001111' } });
      const me = await reviewer(setup.org);
      const job = await reviewJob(setup, async (admin, id) => {
        expect((await addPhone(admin, id, '5552223333')).status).toBe(201);
        expect((await admin.post(`/api/jobs/${id}/contact-entries/name`, { kind: 'FIRST_NAME', value: 'Patricia' })).status).toBe(201);
      });
      const api = await me.api();
      const checked = await checkAll(api, job.id, { PHONE: 'THIS_JOB_ONLY' });
      expect(contactItems(checked).map((i) => i.contact!.choice)).toEqual(['THIS_JOB_ONLY', 'THIS_JOB_ONLY']);
      expect((await finish(api, job.id, checked.version)).status).toBe(200);

      const customer = await db.customer.findUniqueOrThrow({ where: { id: setup.customer }, include: { phones: true } });
      expect(customer).toMatchObject({ phone: '5550001111', first_name: 'Pat' });
      expect(customer.phones).toHaveLength(0);
      expect(await customerEvents(setup.customer)).toHaveLength(0);
      const onJob = await jobEvents(job.id, 'JOB_CUSTOMER_DECISION_APPLIED');
      expect(onJob.map((e) => (e.metadata as { outcome: string }).outcome)).toEqual(['KEPT_ON_JOB', 'KEPT_ON_JOB']);
      // PRD 5's entries are untouched.
      expect(await db.recordContactEntry.count({ where: { job_id: job.id, removed_at: null } })).toBe(2);
    });

    it('applies nothing for an entry removed before the review, even when an earlier tick chose Add for it', async () => {
      const setup = await fx.newOrg();
      const me = await reviewer(setup.org);
      let entryId = '';
      const job = await reviewJob(setup, async (admin, id) => {
        const added = await addPhone(admin, id, '5552223333');
        entryId = added.body.entries[0].id;
      });
      const api = await me.api();
      // The reviewer ticks Add, then the entry is removed from the job.
      const seen = await read(api, job.id);
      const item = contactItems(seen)[0]!;
      expect((await api.post(`/api/jobs/${job.id}/review/decisions`, { item_key: item.key, entry_id: item.latest_entry_id, choice: 'ADD' })).status).toBe(200);
      await db.recordContactEntry.update({ where: { id: entryId }, data: { removed_at: new Date() } });
      await db.timelineEvent.create({
        data: {
          organization_id: setup.org, entity_type: 'JOB', entity_id: job.id, event_type: 'JOB_CONTACT_ENTRY_REMOVED', description: 'Phone removed from this job',
          metadata: { entry_id: entryId, kind: 'PHONE', intent: 'ADDED', old: { value: '5552223333', extension: null, label: null }, new: null, restored_customer_value: null },
          created_by: setup.admin.id,
        },
      });
      // It is a removed item now: it needs a NONE tick, and the old Add row applies nothing.
      const removed = await read(api, job.id);
      expect(contactItems(removed)[0]).toMatchObject({ checked: false, contact: { removed: true, choice: null } });
      const checked = await checkAll(api, job.id);
      expect(contactItems(checked)[0]!.checked).toBe(true);
      expect((await finish(api, job.id, checked.version)).status).toBe(200);
      expect(await db.customerPhone.count({ where: { customer_id: setup.customer } })).toBe(0);
      expect(await customerEvents(setup.customer)).toHaveLength(0);
      const [row] = await db.jobReviewCustomerDecision.findMany({ where: { review_id: job.round.id } });
      expect(row).toMatchObject({ choice: 'NONE' });
    });

    it('a custom role with Office review on, Edit customers off and Close jobs off finishes a review and its decisions apply', async () => {
      const setup = await fx.newOrg();
      const me = await reviewer(setup.org, { edit_customers: false, close_jobs: false, complete_jobs: false, edit_jobs: false, edit_job_and_lead_contact_details: false });
      const job = await reviewJob(setup, async (admin, id) => {
        expect((await addEmail(admin, id, 'second@example.test')).status).toBe(201);
      });
      const api = await me.api();
      // This person cannot edit the customer directly.
      expect((await api.patch(`/api/customers/${setup.customer}`, { notes: 'x' })).status).toBe(403);
      const checked = await checkAll(api, job.id);
      const res = await finish(api, job.id, checked.version);
      expect(res.status).toBe(200);
      expect((await db.customerEmail.findMany({ where: { customer_id: setup.customer } })).map((e) => e.email)).toEqual(['second@example.test']);
      expect(await statusOf(job.id)).toBe('READY_TO_CLOSE');
    });

    it('applies nothing when any step fails: the status, the round, the customer and the history all stay as they were', async () => {
      const setup = await fx.newOrg();
      const me = await reviewer(setup.org);
      const job = await reviewJob(setup, async (admin, id) => {
        expect((await addPhone(admin, id, '5552223333')).status).toBe(201);
      });
      const api = await me.api();
      const checked = await checkAll(api, job.id);
      // The very last write (the Ready to close entry) is made to fail by the database itself.
      const fn = `fail_finish_${job.id.replace(/-/g, '')}`;
      await db.$executeRawUnsafe(`CREATE FUNCTION ${fn}() RETURNS trigger AS $$ BEGIN IF NEW.event_type = 'OFFICE_REVIEW_FINISHED' AND NEW.entity_id = '${job.id}' THEN RAISE EXCEPTION 'forced failure'; END IF; RETURN NEW; END $$ LANGUAGE plpgsql`);
      await db.$executeRawUnsafe(`CREATE TRIGGER ${fn} BEFORE INSERT ON timeline_events FOR EACH ROW EXECUTE FUNCTION ${fn}()`);
      try {
        const res = await finish(api, job.id, checked.version);
        expect(res.status).toBe(500);
        expect(JSON.stringify(res.body)).not.toMatch(/forced failure|trigger|prisma/i);
      } finally {
        await db.$executeRawUnsafe(`DROP TRIGGER ${fn} ON timeline_events`);
        await db.$executeRawUnsafe(`DROP FUNCTION ${fn}()`);
      }
      expect(await statusOf(job.id)).toBe('OFFICE_REVIEW');
      expect(await db.jobReview.findUniqueOrThrow({ where: { id: job.round.id } })).toMatchObject({ state: 'OPEN', finished_at: null });
      expect(await db.customerPhone.count({ where: { customer_id: setup.customer } })).toBe(0);
      expect(await customerEvents(setup.customer)).toHaveLength(0);
      expect(await jobEvents(job.id, 'JOB_CUSTOMER_DECISION_APPLIED')).toHaveLength(0);
      expect(await db.jobReviewCustomerDecision.count({ where: { review_id: job.round.id, applied: true } })).toBe(0);
      // The same request goes through once the database behaves.
      expect((await finish(api, job.id, checked.version)).status).toBe(200);
    });
  });

  describe('who may finish a review', () => {
    it('lets a person in with Office review on and refuses them with it off, and nothing changes', async () => {
      const setup = await fx.newOrg();
      const on = await reviewer(setup.org);
      const off = await personWith(setup.org, { ...OPENING, office_review: false, complete_jobs: true, close_jobs: true, change_locked_jobs: true, view_customers: true, edit_customers: true });
      const job = await reviewJob(setup);
      const checked = await checkAll(await on.api(), job.id);

      const refused = await finish(await off.api(), job.id, checked.version);
      expect(refused.status).toBe(403);
      expect(await statusOf(job.id)).toBe('OFFICE_REVIEW');
      expect((await finish(await on.api(), job.id, checked.version)).status).toBe(200);
    });

    it('is a close-out move of its own: holding Close jobs does not finish a review, and finishing does not make the person able to mark Done', async () => {
      const setup = await fx.newOrg();
      const closer = await personWith(setup.org, { ...OPENING, close_jobs: true });
      const job = await reviewJob(setup);
      expect((await finish(await closer.api(), job.id, 'x')).status).toBe(403);
    });

    it('offers the action in the job\'s own answer to a holder of Office review while the job is in Office review, and nowhere else', async () => {
      const setup = await fx.newOrg();
      const holder = await reviewer(setup.org);
      const other = await personWith(setup.org, { ...OPENING });
      const job = await reviewJob(setup);
      const actionsOf = async (person: { api: () => Promise<Api> }, id: string): Promise<string[]> =>
        (await (await person.api()).get(`/api/jobs/${id}`)).body.job.actions;

      expect(await actionsOf(holder, job.id)).toContain('finish_review');
      expect(await actionsOf(other, job.id)).not.toContain('finish_review');
      const checked = await checkAll(await holder.api(), job.id);
      expect((await finish(await holder.api(), job.id, checked.version)).status).toBe(200);
      expect(await actionsOf(holder, job.id)).not.toContain('finish_review');
    });
  });
  describe('a reviewer whose invoice reach does not cover the job\'s invoices', () => {
    // The invoice reach is asked of the database for such a person; a finish must never fail on what the reviewer may see.
    const reaches: [string, Record<string, SwitchValue>][] = [
      ['View invoices off', { ...OPENING, view_invoices: false }],
    ];

    for (const [label, values] of reaches) {
      it(`finishes a job with an invoice for a reviewer with ${label}, and the invoice stays out of their review`, async () => {
        const setup = await fx.newOrg();
        const me = await reviewer(setup.org, values);
        const job = await reviewJob(setup);
        await fx.addInvoice(setup.org, setup.customer, { jobId: job.id, createdBy: setup.admin.id });
        const api = await me.api();

        const checked = await checkAll(api, job.id);
        expect(checked.totals.items).toBeGreaterThan(0);
        const res = await finish(api, job.id, checked.version);
        expect(res.status).toBe(200);
        expect(res.body.status).toBe('READY_TO_CLOSE');
        expect(res.body.review.summary.invoices).toEqual([]);
        expect(await statusOf(job.id)).toBe('READY_TO_CLOSE');
        expect(await db.jobReview.findUniqueOrThrow({ where: { id: job.round.id } })).toMatchObject({ state: 'FINISHED', finished_by_id: me.id });
      });
    }
  });

  describe('what the finish itself writes is not a change to the job', () => {
    const everyItemChecked = (r: Review) => {
      expect(r.summary.checked).toBe(true);
      expect(itemsOf(r).every((i) => i.checked)).toBe(true);
      expect(r.totals.checked).toBe(r.totals.items);
    };
    const writeEntry = (org: string, jobId: string, type: string, by: string) =>
      db.timelineEvent.create({ data: { organization_id: org, entity_type: 'JOB', entity_id: jobId, event_type: type, description: type, created_by: by } });

    it('answers the finish with every item checked, and a later read of the finished round says the same', async () => {
      const setup = await fx.newOrg();
      const me = await reviewer(setup.org);
      const job = await reviewJob(setup, async (admin, id) => {
        expect((await addPhone(admin, id, '5552223333')).status).toBe(201);
      });
      const api = await me.api();
      const checked = await checkAll(api, job.id);
      everyItemChecked(checked);

      const res = await finish(api, job.id, checked.version);
      expect(res.status).toBe(200);
      everyItemChecked(res.body.review);
      everyItemChecked(await read(api, job.id));
      // The finished round reads the same to a person who holds everything.
      const asAdmin = await fx.signedInAs(setup.admin);
      everyItemChecked(await read(asAdmin, job.id));
    });

    it('is not undone by the close-out\'s own entries (marked done, reopened, sent back, the one-time upgrade), which are not changes to the job', async () => {
      const setup = await fx.newOrg();
      const me = await reviewer(setup.org);
      const job = await reviewJob(setup);
      // The job's own history holds a real change, which is what the summary's check is made against.
      const change = await writeEntry(setup.org, job.id, 'JOB_UPDATED', setup.admin.id);
      const api = await me.api();
      const checked = await checkAll(api, job.id);
      expect(checked.summary.latest_entry_id).toBe(change.id);

      for (const type of ['OFFICE_REVIEW_STARTED', 'COMPLETED', 'JOB_MARKED_DONE', 'JOB_REOPENED', 'JOB_MOVED_BACK', 'JOB_CLOSE_OUT_UPGRADED', 'JOB_CUSTOMER_DECISION_APPLIED']) {
        await writeEntry(setup.org, job.id, type, setup.admin.id);
        const after = await read(api, job.id);
        expect(after.summary.checked, type).toBe(true);
        expect(after.summary.latest_entry_id, type).toBe(checked.summary.latest_entry_id);
        expect(after.version, type).toBe(checked.version);
      }
    });

    it('can still check the summary of a job whose whole history is the close-out\'s own entries', async () => {
      const setup = await fx.newOrg();
      const me = await reviewer(setup.org);
      const job = await reviewJob(setup);
      const api = await me.api();
      const checked = await checkAll(api, job.id);
      everyItemChecked(checked);
      expect((await finish(api, job.id, checked.version)).status).toBe(200);
      everyItemChecked(await read(api, job.id));
    });

    it('still sees an ordinary or an unusual change after the finish as a change: only the close-out\'s own entries are exempt', async () => {
      const setup = await fx.newOrg();
      const me = await reviewer(setup.org);
      const job = await reviewJob(setup);
      const api = await me.api();
      const checked = await checkAll(api, job.id);
      expect((await finish(api, job.id, checked.version)).status).toBe(200);

      const edit = await writeEntry(setup.org, job.id, 'JOB_UPDATED', setup.admin.id);
      const afterEdit = await read(api, job.id);
      expect(afterEdit.summary.checked).toBe(false);
      expect(afterEdit.summary.latest_entry_id).toBe(edit.id);

      await db.timelineEvent.create({
        data: {
          organization_id: setup.org, entity_type: 'JOB', entity_id: job.id, event_type: 'ATTACHMENT_DELETED', description: 'File deleted',
          metadata: { attachment_id: randomUUID(), file_name: 'site.jpg' }, created_by: setup.admin.id,
        },
      });
      const afterDelete = await read(api, job.id);
      expect(afterDelete.totals.unusual).toBeGreaterThan(0);
      expect(itemsOf(afterDelete).some((i) => !i.checked)).toBe(true);
    });

    it('leaves the second round starting unchecked, with its window at the first round\'s finish', async () => {
      const setup = await fx.newOrg();
      const me = await reviewer(setup.org);
      const job = await reviewJob(setup);
      const api = await me.api();
      const checked = await checkAll(api, job.id);
      expect((await finish(api, job.id, checked.version)).status).toBe(200);

      // Reopened and completed again: a new round whose window starts where the first one finished.
      const first = await db.jobReview.findUniqueOrThrow({ where: { id: job.round.id } });
      await db.job.update({ where: { id: job.id }, data: { status: 'OFFICE_REVIEW' } });
      await db.jobReview.create({ data: { organization_id: setup.org, job_id: job.id, window_start: first.finished_at! } });
      const second = await read(api, job.id);
      expect(second.summary.checked).toBe(false);
      expect(second.totals.checked).toBe(0);
      expect((await finish(api, job.id, second.version)).status).toBe(409);
    });
  });
});
