/* =============================================================================
   Roles & Permissions: the main transactional routes on the hosted database's pool (one connection).

   The deployed database URL goes through a pooler holding ONE connection; local and CI URLs carry five, which hides
   this: a query on the app's global client made while an interactive transaction is open (directly, or by a helper the
   transaction calls) needs a second connection, waits out the pool timeout and takes the transaction down. Scenario
   pass 2 found Finish review and the person's switch save answering 500 on staging because of it.

   Every route below is called the way the app calls it, as a person on a custom role holding every switch (so the
   scope and permission helpers run for real, not the Admin box's shortcut), against a client with ONE connection and a
   short pool timeout (one-connection-client.ts). A regression fails the case that caused it within seconds.

   Covered here: mark a Processed logistic order as taken, complete a job, finish a review, mark Done, move a job back out of review (drag, Start, unschedule), reopen a Done job and a cancelled job, cancel a job (single, again, and in bulk), convert a lead, mark a lead Lost, reopen a lead, save a
   role's switches, reset a role, create a role, save a person's switches, reset a person's switches (named and all),
   Save as role, each of the saves again with the connection kept busy from the commit on, delete a job file, delete a note, send a Ready to close job back to Office review (a line cut, a file deleted, a phone changed, an invoice line cut), save the
   dashboard layout, send an email by hand (a new one, and a reply that takes an unassigned main-mailbox conversation), invite a user and create one directly (the user and their mailbox in one transaction, then the address needed alert), set a user's address and change it (the register's lock, the demotion and the new address in one transaction), change the company part (every address of the company moves in one transaction). NOT covered here (each is read by the static scan in tx-pool-static-scan.test.ts instead):
   every other transaction of the backend; and the outside work a route starts after it answers.
   Real migrated database (TEST_DATABASE_URL); the suite skips when it is unset. Every org it creates is removed.
   ========================================================================== */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { randomUUID } from 'crypto';
import type { JobStatus, PrismaClient, Role } from '@prisma/client';

// The suite-wide setup mocks the app's client; here it is the real one, on the hosted pool.
const clientPromise = vi.hoisted(async () => {
  const { oneConnectionClient } = await import('./one-connection-client.js');
  return oneConnectionClient(process.env.TEST_DATABASE_URL);
});
vi.mock('../lib/prisma', async () => ({ prisma: await clientPromise }));
// No email leaves the machine: the invite's set-password email is a stub that reports it was sent.
vi.mock('../lib/email', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/email')>()),
  sendUserInviteEmail: vi.fn().mockResolvedValue(true),
  // ... and so is a hand-written email (S10.11): the route's own queries are what this file watches, not the provider.
  sendComposedEmail: vi.fn().mockImplementation(async () => ({ status: 'sent', providerMessageId: `re_pool_${Math.random()}`, fromAddress: 'jane@staging.mail.test.com', fromName: null })),
}));

import { switchFixture, type Person } from './permission-switches-fixture';
import { setRoleSwitchValues } from '../lib/permissions/switches/store';
import { supabaseAdmin } from '../lib/supabase';
import { SWITCH_CATALOG, type SwitchValue } from '../lib/permissions/switches/catalog';
import { reviewAttentionSettled } from '../services/notifications/reviewAttentionQueue';

const suite = process.env.TEST_DATABASE_URL ? describe : describe.skip;

/** The advisory lock that keeps the pool's one connection busy (advisory locks belong to one database, this suite's own). */
const BUSY_LOCK_KEY = 3246001;

/** Every switch in the catalog on (a choice at its widest option, a list empty). */
const ALL_ON: Record<string, SwitchValue> = Object.fromEntries(
  SWITCH_CATALOG.map((s) => [
    s.key,
    s.kind === 'choice' ? (s.choices!.includes('all') ? 'all' : s.choices![s.choices!.length - 1]!) : s.kind === 'list' ? [] : true,
  ]),
);

/** Two toggles a built-in role has off and that need nothing else, so a save can flip them. */
const flippable = (role: 'DISPATCHER' | 'SALES') =>
  SWITCH_CATALOG.filter((s) => s.kind === 'toggle' && s.requires.length === 0 && s.presets[role] === false).slice(0, 2);

suite('transactional routes on a one-connection pool (real database)', () => {
  let db: PrismaClient;
  let fx: ReturnType<typeof switchFixture>;
  beforeAll(async () => {
    // This environment's mailbox domain, on the suite-wide stand-in for the settings (setting an address builds one).
    const { env } = await import('../config/env.js');
    Object.assign(env, { MAILBOX_DOMAIN: 'staging.mail.test.com' });
    db = (await clientPromise) as PrismaClient;
    fx = switchFixture(db, async () => (await import('../app.js')).default as never);
    // Loading the whole app is slow on a loaded machine.
    await import('../app.js');
  }, 120_000);

  const orgs: string[] = [];
  afterAll(async () => {
    const quietly = (p: Promise<unknown>) => p.catch(() => undefined);
    for (const org of orgs) {
      for (const table of ['attachments', 'notes', 'job_reviews', 'record_contact_entries', 'visits']) {
        await quietly(db.$executeRawUnsafe(`DELETE FROM ${table} WHERE organization_id = '${org}'`));
      }
      await quietly(db.$executeRawUnsafe(`DELETE FROM user_dashboard_layouts WHERE user_id IN (SELECT id FROM users WHERE organization_id = '${org}')`));
    }
    await fx.cleanup();
  });

  let sequence = 0;
  type Api = Awaited<ReturnType<typeof fx.signedInAs>>;

  /**
   * A company with a person holding every switch (on a custom role, so nothing takes the Admin box's shortcut), and its Admin,
   * who makes the user and role writes: those are the Admin flag's alone (AL-18).
   */
  async function world() {
    const w = await fx.newOrg();
    orgs.push(w.org);
    const key = `pool-role-${++sequence}`;
    const role = await fx.addCustomRole(w.org, key, 'DISPATCHER');
    await setRoleSwitchValues({ organizationId: w.org, roleKey: key, values: ALL_ON, actorId: null, reason: 'manual' });
    const me: Person = await fx.addUser(w.org, `pool${sequence}`, 'DISPATCHER', { customRoleId: role.id });
    return { ...w, me, api: as(me), adminApi: as(w.admin), roleKey: key, roleId: role.id };
  }

  /**
   * Requests as one person. `signedInAs` sets one identity for the whole app, so each request signs in again: a world that
   * acts as two people (the switch holder, and the Admin for user and role management, AL-18) never sends one as the other.
   */
  function as(person: Person) {
    return {
      get: async (path: string) => (await fx.signedInAs(person)).get(path),
      post: async (path: string, body?: object) => (await fx.signedInAs(person)).post(path, body),
      put: async (path: string, body?: object) => (await fx.signedInAs(person)).put(path, body),
      patch: async (path: string, body?: object) => (await fx.signedInAs(person)).patch(path, body),
      delete: async (path: string, body?: object) => (await fx.signedInAs(person)).delete(path, body),
    };
  }
  type World = Awaited<ReturnType<typeof world>>;

  /** The answer must be a success: a pool timeout surfaces as the route's 500. */
  const ok = (res: { status: number; body: unknown }, what: string) => expect(res.status, `${what}: ${JSON.stringify(res.body)}`).toBeLessThan(300);

  describe('jobs', () => {
    it('complete a job', async () => {
      const w = await world();
      const job = await fx.addJob(w.org, w.customer, { status: 'IN_PROGRESS', pastVisit: true, crew: [w.me.id] });
      ok(await w.api.post(`/api/jobs/${job.id}/complete`), 'complete');
      expect((await db.job.findUniqueOrThrow({ where: { id: job.id } })).status).toBe('OFFICE_REVIEW');
    });

    it('finish a review', async () => {
      const w = await world();
      const job = await fx.addJob(w.org, w.customer, { status: 'IN_PROGRESS', pastVisit: true, crew: [w.me.id] });
      ok(await w.api.post(`/api/jobs/${job.id}/complete`), 'complete');
      const read = async () => (await w.api.get(`/api/jobs/${job.id}/review`)).body.review as {
        version: string; summary: { checked: boolean; latest_entry_id: string | null };
      };
      const before = await read();
      if (before.summary.latest_entry_id && !before.summary.checked) {
        ok(await w.api.post(`/api/jobs/${job.id}/review/checks/all`, { items: [{ item_key: 'summary', entry_id: before.summary.latest_entry_id }] }), 'check');
      }
      ok(await w.api.post(`/api/jobs/${job.id}/review/finish`, { version: (await read()).version }), 'finish');
      expect((await db.job.findUniqueOrThrow({ where: { id: job.id } })).status).toBe('READY_TO_CLOSE');
    });

    it('mark Done', async () => {
      const w = await world();
      const job = await fx.addJob(w.org, w.customer, { status: 'READY_TO_CLOSE' });
      ok(await w.api.post(`/api/jobs/${job.id}/mark-done`), 'mark done');
      expect((await db.job.findUniqueOrThrow({ where: { id: job.id } })).status).toBe('DONE');
    });

    it('move a job back out of Office review and Ready to close: the calendar drag, the status door, Start and unschedule', async () => {
      const w = await world();
      const when = { scheduled_start: '2030-01-01T10:00:00.000Z', scheduled_end: '2030-01-01T11:00:00.000Z', is_all_day: false, assignee_ids: [] };
      const doors: [string, JobStatus, (jobId: string) => Promise<{ status: number; body: unknown }>][] = [
        ['drag', 'SCHEDULED', (id) => w.api.post(`/api/jobs/${id}/assign`, when)],
        ['status door', 'IN_PROGRESS', (id) => w.api.post(`/api/jobs/${id}/status`, { status: 'IN_PROGRESS' })],
        ['start', 'IN_PROGRESS', (id) => w.api.post(`/api/jobs/${id}/start`)],
        ['unschedule', 'UNSCHEDULED', (id) => w.api.post(`/api/jobs/${id}/unassign`)],
      ];
      for (const status of ['OFFICE_REVIEW', 'READY_TO_CLOSE'] as const) {
        for (const [door, lands, call] of doors) {
          const job = await fx.addJob(w.org, w.customer, { status, crew: [w.me.id] });
          const finished = status === 'READY_TO_CLOSE';
          await db.job.update({ where: { id: job.id }, data: { completed_at: new Date() } });
          await db.jobReview.create({
            data: { organization_id: w.org, job_id: job.id, window_start: new Date(Date.now() - 3_600_000), ...(finished ? { state: 'FINISHED', finished_at: new Date() } : {}) },
          });
          ok(await call(job.id), `${door} from ${status}`);
          expect(await db.job.findUniqueOrThrow({ where: { id: job.id } })).toMatchObject({ status: lands, completed_at: null });
          expect(await db.jobReview.findMany({ where: { job_id: job.id } })).toEqual([expect.objectContaining({ state: 'OPEN', finished_at: null })]);
          expect(await db.timelineEvent.count({ where: { entity_id: job.id, event_type: 'JOB_MOVED_BACK' } })).toBe(1);
        }
      }
    });

    it('reopen a Done job, and reopen a cancelled job', async () => {
      const w = await world();
      const done = await fx.addJob(w.org, w.customer, { status: 'DONE' });
      await db.job.update({ where: { id: done.id }, data: { completed_at: new Date(), closed_at: new Date(), closed_by_id: w.me.id } });
      ok(await w.api.post(`/api/jobs/${done.id}/reopen`), 'reopen Done');
      expect(await db.job.findUniqueOrThrow({ where: { id: done.id } })).toMatchObject({ status: 'IN_PROGRESS', completed_at: null, closed_at: null });

      const cancelled = await fx.addJob(w.org, w.customer, { status: 'IN_PROGRESS', pastVisit: true, crew: [w.me.id] });
      ok(await w.api.post(`/api/jobs/${cancelled.id}/cancel`, { cancel_reason_code: 'PRICE' }), 'cancel');
      ok(await w.api.post(`/api/jobs/${cancelled.id}/reopen`), 'reopen Cancelled');
      expect(await db.job.findUniqueOrThrow({ where: { id: cancelled.id } })).toMatchObject({ status: 'IN_PROGRESS', cancelled_at: null, cancel_reason_code: null });
    });

    it('cancel a job, and cancel it again to change the reason', async () => {
      const w = await world();
      const job = await fx.addJob(w.org, w.customer, { status: 'IN_PROGRESS', pastVisit: true, crew: [w.me.id] });
      ok(await w.api.post(`/api/jobs/${job.id}/cancel`, { cancel_reason_code: 'PRICE' }), 'cancel');
      expect(await db.job.findUniqueOrThrow({ where: { id: job.id } })).toMatchObject({ status: 'CANCELLED', cancel_reason_code: 'PRICE' });
      ok(await w.api.post(`/api/jobs/${job.id}/cancel`, { cancel_reason_code: 'OTHER' }), 'cancel again');
      expect((await db.job.findUniqueOrThrow({ where: { id: job.id } })).cancel_reason_code).toBe('OTHER');
    });

    it('cancel jobs in bulk', async () => {
      const w = await world();
      const first = await fx.addJob(w.org, w.customer, { status: 'IN_PROGRESS', pastVisit: true, crew: [w.me.id] });
      const second = await fx.addJob(w.org, w.customer, { status: 'SCHEDULED' });
      const res = await w.api.post('/api/jobs/bulk-status', { ids: [first.id, second.id], action: 'cancel', cancel_reason_code: 'PRICE' });
      ok(res, 'bulk cancel');
      expect(res.body.failed).toEqual([]);
      expect(await db.job.count({ where: { id: { in: [first.id, second.id] }, status: 'CANCELLED' } })).toBe(2);
    });

    it('delete a note', async () => {
      const w = await world();
      const job = await fx.addJob(w.org, w.customer);
      const note = await db.note.create({
        data: { organization_id: w.org, entity_type: 'JOB', entity_id: job.id, content: 'Gate code 1234', created_by: w.me.id },
        select: { id: true },
      });
      ok(await w.api.delete(`/api/jobs/${job.id}/notes/${note.id}`), 'delete note');
      expect(await db.note.count({ where: { id: note.id } })).toBe(0);
    });

    it('delete a job file', async () => {
      const w = await world();
      const job = await fx.addJob(w.org, w.customer);
      const file = randomUUID();
      await db.attachment.create({
        data: {
          id: file, organization_id: w.org, entity_type: 'JOB', entity_id: job.id, file_name: `${file}.pdf`,
          file_url: `https://files.example.test/${file}.pdf`, storage_path: `org/${file}.pdf`, file_type: 'application/pdf',
          file_size: 10, display_name: 'Permit', uploaded_by: w.me.id,
        },
      });
      ok(await w.api.delete(`/api/attachments/job/${job.id}/${file}`), 'delete file');
      expect(await db.attachment.count({ where: { id: file } })).toBe(0);
    });

    it('an unusual change on a Ready to close job sends it back to Office review (a line cut, a file deleted, a phone changed, an invoice line cut)', async () => {
      const w = await world();
      await db.customer.update({ where: { id: w.customer }, data: { phone: '6175550101' } });
      async function readyJob() {
        const job = await fx.addJob(w.org, w.customer, { status: 'READY_TO_CLOSE' });
        const line = await db.jobLineItem.create({
          data: { job_id: job.id, organization_id: w.org, sequence: 1, description: 'Door', quantity: 1, unit_price: 100, line_total: 100 },
        });
        await db.jobReview.create({
          data: { organization_id: w.org, job_id: job.id, window_start: new Date(Date.now() - 7_200_000), state: 'FINISHED', finished_by_id: w.me.id, finished_at: new Date(Date.now() - 3_600_000) },
        });
        const file = randomUUID();
        await db.attachment.create({
          data: {
            id: file, organization_id: w.org, entity_type: 'JOB', entity_id: job.id, file_name: `${file}.pdf`,
            file_url: `https://files.example.test/${file}.pdf`, storage_path: `org/${file}.pdf`, file_type: 'application/pdf',
            file_size: 10, display_name: 'Permit', uploaded_by: w.me.id,
          },
        });
        const invoice = await fx.addInvoice(w.org, w.customer, { jobId: job.id, createdBy: w.me.id });
        return { job, line, file, invoice };
      }
      const doors: [string, (r: Awaited<ReturnType<typeof readyJob>>) => Promise<{ status: number; body: unknown }>][] = [
        ['a job line cut', (r) => w.api.patch(`/api/jobs/${r.job.id}/line-items/${r.line.id}`, { unit_price: 80 })],
        ['a job file deleted', (r) => w.api.delete(`/api/attachments/job/${r.job.id}/${r.file}`)],
        ['a phone changed for the job', (r) => w.api.post(`/api/jobs/${r.job.id}/contact-entries/change`, { kind: 'PHONE', replaces: '6175550101', value: '6175550188' })],
        ['an invoice line cut', (r) => w.api.patch(`/api/invoices/${r.invoice.id}/line-items/${r.invoice.lineId}`, { unit_price: 60 })],
      ];
      for (const [name, call] of doors) {
        const ready = await readyJob();
        ok(await call(ready), name);
        expect((await db.job.findUniqueOrThrow({ where: { id: ready.job.id } })).status, name).toBe('OFFICE_REVIEW');
        expect(await db.jobReview.findMany({ where: { job_id: ready.job.id } }), name).toEqual([expect.objectContaining({ state: 'OPEN', finished_at: null })]);
        expect(await db.timelineEvent.count({ where: { entity_id: ready.job.id, event_type: 'JOB_MOVED_BACK' } }), name).toBe(1);
      }
    });
  });

  describe('the Office review attention and Ready to close alerts (S06.24)', () => {
    it('are sent after the request that raised them: entering review, a new unusual item in Office review, a delete on a Done job, and finishing a review', async () => {
      const w = await world();
      // Somebody besides the person acting, who must act on a review and on a close.
      const other = await fx.addUser(w.org, `pool-other${++sequence}`, 'DISPATCHER', { customRoleId: w.roleId });
      const told = async (jobId: string, verb: string) => {
        await reviewAttentionSettled();
        return (await db.notificationRecipient.findMany({ where: { notification: { object_id: jobId, verb } }, select: { recipient_id: true } })).map((r) => r.recipient_id).sort();
      };
      // The company's admin and the other person are the people who must act; the person acting is never told.
      const them = [w.admin.id, other.id].sort();
      const addFile = async (jobId: string, name: string) => {
        const file = randomUUID();
        await db.attachment.create({
          data: {
            id: file, organization_id: w.org, entity_type: 'JOB', entity_id: jobId, file_name: `${file}.pdf`,
            file_url: `https://files.example.test/${file}.pdf`, storage_path: `org/${file}.pdf`, file_type: 'application/pdf',
            file_size: 10, display_name: name, uploaded_by: w.me.id,
          },
        });
        return file;
      };

      // Entering review with a deleted file already in the window.
      const entering = await fx.addJob(w.org, w.customer, { status: 'IN_PROGRESS', pastVisit: true, crew: [w.me.id] });
      const gone = randomUUID();
      await db.timelineEvent.create({
        data: { organization_id: w.org, entity_type: 'JOB', entity_id: entering.id, event_type: 'ATTACHMENT_DELETED', description: 'Attachment deleted', metadata: { attachment_id: gone, display_name: 'Old.pdf' } },
      });
      ok(await w.api.post(`/api/jobs/${entering.id}/complete`), 'complete');
      expect(await told(entering.id, 'job.review_attention')).toEqual(them);

      // A new unusual item in Office review: a file deleted.
      const file = await addFile(entering.id, 'Permit');
      ok(await w.api.delete(`/api/attachments/job/${entering.id}/${file}`), 'delete file in review');
      expect(await told(entering.id, 'job.review_attention')).toEqual([...them, ...them].sort());

      // A delete on a Done job.
      const done = await fx.addJob(w.org, w.customer, { status: 'DONE' });
      const doneFile = await addFile(done.id, 'Receipt');
      ok(await w.api.delete(`/api/attachments/job/${done.id}/${doneFile}`), 'delete file on a Done job');
      expect(await told(done.id, 'job.review_attention')).toEqual(them);

      // Finishing the review.
      const read = async () => (await w.api.get(`/api/jobs/${entering.id}/review`)).body.review as { version: string; summary: { checked: boolean; latest_entry_id: string | null }; groups: any[] };
      const before = await read();
      const items = [
        ...(before.summary.latest_entry_id ? [{ item_key: 'summary', entry_id: before.summary.latest_entry_id }] : []),
        ...before.groups.filter((g) => g.key !== 'unusual').flatMap((g) => g.items).filter((i: any) => !i.checked).map((i: any) => ({ item_key: i.key, entry_id: i.latest_entry_id })),
      ];
      ok(await w.api.post(`/api/jobs/${entering.id}/review/checks/all`, { items }), 'check');
      ok(await w.api.post(`/api/jobs/${entering.id}/review/finish`, { version: (await read()).version }), 'finish');
      expect(await told(entering.id, 'job.ready_to_close')).toEqual(them);
    });
  });

  describe('leads', () => {
    it('mark a lead Lost, then reopen it', async () => {
      const w = await world();
      const lead = await fx.addLead(w.org, w.customer, { owner: w.me.id });
      ok(await w.api.post(`/api/leads/${lead.id}/mark-lost`, { lost_reason: 'Went with another company' }), 'mark lost');
      expect((await db.lead.findUniqueOrThrow({ where: { id: lead.id } })).status).toBe('LOST');
      ok(await w.api.post(`/api/leads/${lead.id}/reopen`, { reason: 'The customer called back' }), 'reopen');
      expect((await db.lead.findUniqueOrThrow({ where: { id: lead.id } })).status).not.toBe('LOST');
    });

    it('convert a lead to a job', async () => {
      const w = await world();
      await db.customer.update({ where: { id: w.customer }, data: { phone: '6175550101', email: 'pat@example.test' } });
      const location = randomUUID();
      await db.serviceLocation.create({
        data: { id: location, customer_id: w.customer, address_line1: '1 Test Way', city: 'Testville', state: 'MA', zip: '02108' },
      });
      const lead = await fx.addLead(w.org, w.customer, { owner: w.me.id });
      const estimate = await fx.addEstimate(w.org, w.customer, w.admin.id, { leadId: lead.id });
      await db.estimate.update({ where: { id: estimate.id }, data: { status: 'WON' } });
      const res = await w.api.post('/api/jobs', { estimate_id: estimate.id, service_location_id: location });
      ok(res, 'convert');
      expect(await db.job.count({ where: { id: (res.body as { job: { id: string } }).job.id } })).toBe(1);
    });
  });

  describe('permissions and the dashboard', () => {
    it("save a role's switches", async () => {
      const w = await world();
      const key = `pool-saved-${++sequence}`;
      await fx.addCustomRole(w.org, key, 'DISPATCHER');
      const [a, b] = flippable('DISPATCHER');
      const res = await w.adminApi.put(`/api/roles/${key}/permissions`, { values: { [a!.key]: true, [b!.key]: true } });
      ok(res, "save a role's switches");
      expect(res.body.values[a!.key]).toBe(true);
    });

    /** A person on a built-in role, for the signed-in person to change. */
    const target = (w: World, role: Role) => fx.addUser(w.org, `target${++sequence}`, role);

    it("save a person's switches, and answer with what a read after it answers", async () => {
      const w = await world();
      const sales = await target(w, 'SALES');
      const [a, b] = flippable('SALES');
      const res = await w.adminApi.put(`/api/users/${sales.id}/permissions`, { values: { [a!.key]: true, [b!.key]: true } });
      ok(res, "save a person's switches");
      expect(res.body.difference_count).toBe(2);
      expect((await w.adminApi.get(`/api/users/${sales.id}/permissions`)).body).toEqual(res.body);
    });

    /**
     * Runs `act` with the pool's one connection kept busy from the moment a transaction commits, so a read made after
     * the write fails the way it does on the hosted database under load: it waits behind other work and times out.
     * Scenario pass 2 saw saves answer 500 although every value WAS stored.
     *
     * The connection is held by a lock the TEST owns (an advisory lock, which belongs to this suite's own database), taken on
     * a client of the test's own before the route runs and released the moment the route has answered. A route that reads after
     * its commit waits behind the lock and times out as before; a route that does not is answered at once and the line is
     * freed at once, instead of after a fixed five seconds.
     */
    async function busyAfterCommit<T>(act: () => Promise<T>): Promise<T> {
      const { PrismaClient } = await import('@prisma/client');
      const holder = new PrismaClient({ datasources: { db: { url: process.env.TEST_DATABASE_URL! } } });
      let release!: () => void;
      const released = new Promise<void>((resolve) => { release = resolve; });
      let held!: () => void;
      const lockTaken = new Promise<void>((resolve) => { held = resolve; });
      const holding = holder.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT 1 FROM pg_advisory_xact_lock(${BUSY_LOCK_KEY})`;
        held();
        await released;
      }, { timeout: 60_000, maxWait: 10_000 });
      // A holder that fails must fail the case: nothing held means nothing tested.
      let holderFailure: unknown;
      holding.catch((err) => { holderFailure = err ?? new Error('the lock holder failed'); held(); });
      await lockTaken;
      if (holderFailure) { await holder.$disconnect(); throw holderFailure; }

      const realTransaction = db.$transaction.bind(db) as (...args: unknown[]) => Promise<unknown>;
      let busy: Promise<unknown> = Promise.resolve();
      const spy = vi.spyOn(db, '$transaction').mockImplementation(((...args: unknown[]) =>
        realTransaction(...args).then((out) => {
          // A Prisma query only starts once it is awaited or chained, so it is chained here. It sits behind the lock the test holds.
          busy = db.$queryRaw`SELECT 1 FROM pg_advisory_xact_lock(${BUSY_LOCK_KEY})`.then(() => undefined);
          return out;
        })) as never);
      try {
        return await act();
      } finally {
        spy.mockRestore();
        release();
        await busy.catch(() => undefined);
        // Rethrows when the holder's transaction failed while the route ran.
        await holding.finally(() => holder.$disconnect());
      }
    }

    it("answers a person's save from what it holds, with nothing read after the write is committed", async () => {
      const w = await world();
      const sales = await target(w, 'SALES');
      const [a] = flippable('SALES');
      const res = await busyAfterCommit(() => w.adminApi.put(`/api/users/${sales.id}/permissions`, { values: { [a!.key]: true } }));
      ok(res, 'save with the connection busy after the commit');
      expect(res.body.values[a!.key]).toBe(true);
      expect((await w.adminApi.get(`/api/users/${sales.id}/permissions`)).body.values[a!.key]).toBe(true);
    });

    it("reset a person's switches", async () => {
      const w = await world();
      const sales = await target(w, 'SALES');
      const [a] = flippable('SALES');
      ok(await w.adminApi.put(`/api/users/${sales.id}/permissions`, { values: { [a!.key]: true } }), 'save');
      const res = await w.adminApi.post(`/api/users/${sales.id}/permissions/reset`, { switch_keys: [a!.key] });
      ok(res, 'reset');
      expect(res.body.difference_count).toBe(0);
      expect((await w.adminApi.get(`/api/users/${sales.id}/permissions`)).body).toEqual(res.body);
    });

    it("answers a person's reset of named switches from what it holds, with nothing read after the commit", async () => {
      const w = await world();
      const sales = await target(w, 'SALES');
      const [a, b] = flippable('SALES');
      ok(await w.adminApi.put(`/api/users/${sales.id}/permissions`, { values: { [a!.key]: true, [b!.key]: true } }), 'save');
      const res = await busyAfterCommit(() => w.adminApi.post(`/api/users/${sales.id}/permissions/reset`, { switch_keys: [a!.key] }));
      ok(res, 'reset with the connection busy after the commit');
      expect(res.body.values[a!.key]).toBe(false);
      expect(res.body.values[b!.key]).toBe(true);
      expect(res.body.difference_count).toBe(1);
      expect((await w.adminApi.get(`/api/users/${sales.id}/permissions`)).body).toEqual(res.body);
    });

    it("answers a person's reset of everything from what it holds, with nothing read after the commit", async () => {
      const w = await world();
      const sales = await target(w, 'SALES');
      const [a, b] = flippable('SALES');
      ok(await w.adminApi.put(`/api/users/${sales.id}/permissions`, { values: { [a!.key]: true, [b!.key]: true } }), 'save');
      const res = await busyAfterCommit(() => w.adminApi.post(`/api/users/${sales.id}/permissions/reset`, { all: true }));
      ok(res, 'reset all with the connection busy after the commit');
      expect(res.body.values[a!.key]).toBe(false);
      expect(res.body.difference_count).toBe(0);
      expect((await w.adminApi.get(`/api/users/${sales.id}/permissions`)).body).toEqual(res.body);
    });

    it("answers a person's Save as role from what it holds, with nothing read after the commit", async () => {
      const w = await world();
      const sales = await target(w, 'SALES');
      const [a] = flippable('SALES');
      ok(await w.adminApi.put(`/api/users/${sales.id}/permissions`, { values: { [a!.key]: true } }), 'save');
      const res = await busyAfterCommit(() => w.adminApi.post(`/api/users/${sales.id}/permissions/save-as-role`, { label: `Pool role ${++sequence}` }));
      ok(res, 'save as role with the connection busy after the commit');
      expect(res.body.values[a!.key]).toBe(true);
      expect(res.body.difference_count).toBe(0);
      const { role, ...set } = res.body;
      expect(set.based_on).toEqual({ key: role.role, label: role.label, type: 'custom' });
      expect((await w.adminApi.get(`/api/users/${sales.id}/permissions`)).body).toEqual(set);
    });

    it("answers a role's save from what it holds, with nothing read after the commit", async () => {
      const w = await world();
      const key = `pool-busy-${++sequence}`;
      await fx.addCustomRole(w.org, key, 'DISPATCHER');
      const [a, b] = flippable('DISPATCHER');
      const res = await busyAfterCommit(() => w.adminApi.put(`/api/roles/${key}/permissions`, { values: { [a!.key]: true, [b!.key]: true } }));
      ok(res, "save a role's switches with the connection busy after the commit");
      expect(res.body.values[a!.key]).toBe(true);
      expect((await w.adminApi.get(`/api/roles/${key}/permissions`)).body.values).toEqual(res.body.values);
    });

    it("answers a role's reset from what it holds, with nothing read after the commit", async () => {
      const w = await world();
      const key = `pool-busy-${++sequence}`;
      await fx.addCustomRole(w.org, key, 'DISPATCHER');
      const [a] = flippable('DISPATCHER');
      ok(await w.adminApi.put(`/api/roles/${key}/permissions`, { values: { [a!.key]: true } }), 'save');
      const res = await busyAfterCommit(() => w.adminApi.post(`/api/roles/${key}/reset`));
      ok(res, 'reset a role with the connection busy after the commit');
      expect(res.body.values[a!.key]).toBe(false);
      expect((await w.adminApi.get(`/api/roles/${key}/permissions`)).body.values).toEqual(res.body.values);
    });

    it('answers a new role made from another from what it holds, with nothing read after the commit', async () => {
      // The copied values are read before the write opens; the answer is built from them.
      const w = await world();
      const res = await busyAfterCommit(() => w.adminApi.post('/api/roles', { label: `Pool copy ${++sequence}`, clone_grants_from: w.roleKey }));
      ok(res, 'create a role with the connection busy after the commit');
      expect(res.body.role).toBeTruthy();
    });

    it('save the dashboard layout', async () => {
      const w = await world();
      const res = await w.api.put('/api/dashboard/layout', { layout: [{ id: 'kpi.open_leads', visible: true }] });
      ok(res, 'save layout');
      expect(res.body.layout[0].id).toBe('kpi.open_leads');
    });
  });
  describe('users', () => {
    it('invite and create a user: the user and their mailbox in one transaction, and the address needed alert after it', async () => {
      const w = await world();
      await db.organization.update({ where: { id: w.org }, data: { email_sender_local_part: `pool${w.tag.replace(/[^a-z]/g, 'x')}` } });
      const invite = () =>
        w.adminApi.post('/api/users/invite', { first_name: 'Jane', last_name: 'Smith', email: `inv-${randomUUID()}@example.test`, role: 'TECHNICIAN' });

      const first = await invite();
      ok(first, 'invite');
      // a namesake: a mailbox in "address needed", written on the same transaction, then the alert on the pool
      const second = await invite();
      ok(second, 'invite a namesake');

      const id = randomUUID();
      (supabaseAdmin.auth.admin.createUser as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ data: { user: { id } }, error: null });
      ok(
        await w.adminApi.post('/api/users', { first_name: 'Ann', last_name: 'Lee', email: `cr-${randomUUID()}@example.test`, password: 'a-long-password-1', role: 'TECHNICIAN' }),
        'create',
      );

      const boxes = await db.mailbox.findMany({ where: { organization_id: w.org, kind: 'user' }, orderBy: { created_at: 'asc' } });
      expect(boxes.map((b) => b.status)).toEqual(['active', 'address_needed', 'active']);
    });

    it('set an address for a user in "address needed", then change it: the register\'s lock and its writes on the one connection', async () => {
      const w = await world();
      await db.organization.update({ where: { id: w.org }, data: { email_sender_local_part: `pool${w.tag.replace(/[^a-z]/g, 'x')}` } });
      const invite = () =>
        w.adminApi.post('/api/users/invite', { first_name: 'Jane', last_name: 'Smith', email: `inv-${randomUUID()}@example.test`, role: 'TECHNICIAN' });
      ok(await invite(), 'invite');
      const namesake = await invite();
      ok(namesake, 'invite a namesake');

      const set = await w.adminApi.put(`/api/users/${namesake.body.user.id}/mailbox-address`, { name_part: 'jane.smith2' });
      ok(set, 'set an address');
      const change = await w.adminApi.put(`/api/users/${namesake.body.user.id}/mailbox-address`, { name_part: 'jsmith2' });
      ok(change, 'change an address');

      const addresses = await db.mailboxAddress.findMany({ where: { mailbox: { user_id: namesake.body.user.id } }, orderBy: { issued_at: 'asc' } });
      expect(addresses.map((a) => [a.local_part.split('.')[0], a.is_primary])).toEqual([['jane', false], ['jsmith2', true]]);
    });

    it('change the company part: the register\'s lock, the temporary move list and the set-based writes on the one connection, and again to take an earlier part back', async () => {
      const w = await world();
      const first = `pool${w.tag.replace(/[^a-z]/g, 'x')}`;
      await db.organization.update({ where: { id: w.org }, data: { email_sender_local_part: first } });
      const invite = (firstName: string) =>
        w.adminApi.post('/api/users/invite', { first_name: firstName, last_name: 'Smith', email: `inv-${randomUUID()}@example.test`, role: 'TECHNICIAN' });
      ok(await invite('Jane'), 'invite');
      ok(await invite('Omar'), 'invite another');

      const next = `${first}two`;
      ok(await w.adminApi.patch('/api/organization/email-sender', { local_part: next }), 'change the company part');
      ok(await w.adminApi.patch('/api/organization/email-sender', { local_part: first }), 'take the earlier part back');

      const primaries = await db.mailboxAddress.findMany({ where: { organization_id: w.org, is_primary: true } });
      expect(primaries.map((a) => a.local_part).sort()).toEqual([first, `jane.smith.${first}`, `omar.smith.${first}`].sort());
      expect(await db.mailboxAddress.count({ where: { organization_id: w.org } })).toBe(6);
    });
  });
  describe('logistic orders (S07.11)', () => {
    it('mark a Processed order as taken, for the caller and for a colleague: the order row and its history entry on the one connection', async () => {
      const w = await world();
      const colleague = await fx.addUser(w.org, `taker${++sequence}`, 'TECHNICIAN');
      const processed = async () => {
        const id = randomUUID();
        await db.logisticOrder.create({
          data: { id, organization_id: w.org, number: `LO-${id.slice(0, 8)}`, status: 'PROCESSED', created_by: w.me.id, processed_at: new Date(), processed_by: w.me.id },
        });
        return id;
      };
      try {
        const mine = await processed();
        ok(await w.api.post(`/api/logistic-orders/${mine}/taken-by-me`), 'taken by me');
        const theirs = await processed();
        ok(await w.api.post(`/api/logistic-orders/${theirs}/taken-by`, { takenById: colleague.id }), 'taken by a colleague');

        expect(await db.logisticOrder.findUniqueOrThrow({ where: { id: mine } })).toMatchObject({ taken_by_id: w.me.id, recorded_by_id: w.me.id });
        expect(await db.logisticOrder.findUniqueOrThrow({ where: { id: theirs } })).toMatchObject({ taken_by_id: colleague.id, recorded_by_id: w.me.id });
        expect(await db.auditLog.count({ where: { org_id: w.org, action: 'inventory.logistic_order_picked_up' } })).toBe(2);
      } finally {
        await db.$executeRawUnsafe(`DELETE FROM logistic_orders WHERE organization_id = '${w.org}'`).catch(() => undefined);
        await db.$executeRawUnsafe(`DELETE FROM audit_logs WHERE org_id = '${w.org}'`).catch(() => undefined);
      }
    });
  });
  describe('hand-written email (S10.11)', () => {
    it('send a new email, and reply in an unassigned main-mailbox conversation, which the replier takes: the sender lookup, the conversation write and the first-reply assignment on the one connection', async () => {
      const w = await world();
      const main = await db.mailbox.create({ data: { organization_id: w.org, kind: 'main', status: 'active' }, select: { id: true } });
      const own = await db.mailbox.create({ data: { organization_id: w.org, kind: 'user', user_id: w.me.id, holder_user_id: w.me.id, status: 'active' }, select: { id: true } });
      await db.mailboxAddress.create({ data: { local_part: `pool.${own.id}`, organization_id: w.org, mailbox_id: own.id, is_primary: true } });
      const thread = randomUUID();
      await db.emailThread.create({ data: { id: thread, organization_id: w.org, mailbox_id: main.id, origin: 'started' } });
      await db.email.create({
        data: {
          organization_id: w.org, thread_id: thread, customer_id: w.customer, account: 'user', direction: 'in', folder: 'inbox',
          from: { name: null, email: 'customer@example.com' }, to: 'office@example.com', subject: 'pool', snippet: 's', body: ['b'], at: '1:00 PM', ts: BigInt(Date.now()),
        },
        select: { id: true },
      });
      try {
        const fresh = await w.api.post('/api/communication/emails', { to: 'customer@example.com', subject: 'Hello', body: ['Hi'] });
        ok(fresh, 'new email');
        const reply = await w.api.post('/api/communication/emails', { to: 'customer@example.com', subject: 'Re', body: ['Hi'], thread_id: thread });
        ok(reply, 'reply');

        expect((await db.emailThread.findUniqueOrThrow({ where: { id: thread } })).assigned_to_user_id).toBe(w.me.id);
        const started = await db.email.findUniqueOrThrow({ where: { id: fresh.body.email.id } });
        expect((await db.emailThread.findUniqueOrThrow({ where: { id: started.thread_id! } })).mailbox_id).toBe(own.id);
      } finally {
        for (const table of ['email_read_states', 'emails', 'reply_tokens', 'email_threads', 'mailbox_addresses', 'mailboxes']) {
          await db.$executeRawUnsafe(`DELETE FROM ${table} WHERE organization_id = '${w.org}'`).catch(() => undefined);
        }
      }
    });
  });
});
