/* =============================================================================
   Roles & Permissions, PRD 4, slice S04.22 - the completed-job lock on Completed and Cancelled jobs.

   A job is locked while it is Completed (or a later close-out status) and while it is Cancelled. Only a holder of
   Change locked jobs changes it, and that holder still needs the ordinary switch for each action. The lock covers
   details, people, existing visits, line items and discounts; collecting money, invoice sends and creates, the
   close-out moves and adding a note or a file stay open. A Reopen lifts it. Bulk actions on a locked job come back in
   the failed list. A job is never Lost.

   Everything goes through the public interface: the job routes, called as people on custom roles (never a built-in
   role name) holding exactly the switch values under test. Real migrated database (TEST_DATABASE_URL); the suite
   skips when it is unset. Every org it creates is removed again.
   ========================================================================== */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { randomUUID } from 'crypto';
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
import { SWITCH_CATALOG, type SwitchValue } from '../lib/permissions/switches/catalog';

const suite = realClient ? describe : describe.skip;

/** Every switch in the catalog off (a choice at its first option, a list empty), so a case turns on exactly the ones it is about. */
const ALL_OFF: Record<string, SwitchValue> = Object.fromEntries(
  SWITCH_CATALOG.map((s) => [s.key, s.kind === 'choice' ? s.choices![0]! : s.kind === 'list' ? [] : false]),
);

/** The wording the slice gives every refusal and every disabled control (the PRD's own text, not read from the code). */
const LOCK_MESSAGE = 'This job is locked. Only someone who can change locked jobs can change it.';

/** What opening the job takes, with no action switch on. */
const OPENING = {
  view_jobs: true, jobs_scope: 'all', create_jobs: true, view_attachments: true,
  view_invoices: true, invoices_scope: 'all', view_estimates: true, estimates_scope: 'all',
};

/** The ordinary switch of every change the lock covers, all on: the lock is the only thing left that can refuse. */
const ORDINARY = {
  edit_jobs: true, edit_job_line_items: true, apply_discounts: true, assign_people_to_jobs: true, assign_work_to_others: true,
  schedule_visits: true, mark_on_my_way: true, mark_arrived: true, start_and_finish_visits: true, edit_job_record_ids: true,
  delete_jobs: true, add_notes: true, upload_attachments: true, create_invoices: true,
};

suite('the completed-job lock (real database)', () => {
  const db = realClient as PrismaClient;
  const fx = switchFixture(db, async () => (await import('../app.js')).default as never);
  // Loading the whole app is slow on a loaded machine.
  beforeAll(async () => {
    await import('../app.js');
  }, 120_000);
  afterAll(() => fx.cleanup());

  type Api = Awaited<ReturnType<typeof fx.signedInAs>>;
  type Fixture = Awaited<ReturnType<typeof fx.addJob>>;
  let sequence = 0;

  /** A person on a fresh custom role holding exactly these switch values over everything else off. */
  async function personWith(org: string, values: Record<string, SwitchValue>, base: Role = 'DISPATCHER') {
    const key = `job-lock-role-${++sequence}`;
    const role = await fx.addCustomRole(org, key, base);
    await setRoleSwitchValues({ organizationId: org, roleKey: key, values: { ...ALL_OFF, ...values }, actorId: null, reason: 'manual' });
    const person = await fx.addUser(org, `p${sequence}`, base, { customRoleId: role.id });
    return Object.assign(person, { api: () => fx.signedInAs(person) });
  }

  const when = { scheduled_start: '2030-01-01T10:00:00.000Z', scheduled_end: '2030-01-01T11:00:00.000Z' };

  /** Every change the lock covers, as the call a control makes. `me` is on the job's only visit. */
  const LOCKED_CALLS: Record<string, (api: Api, job: Fixture, me: Person) => Promise<{ status: number; body: Record<string, unknown> }>> = {
    'edit details': (api, job) => api.patch(`/api/jobs/${job.id}`, { description: 'changed' }),
    'edit a discount': (api, job) => api.patch(`/api/jobs/${job.id}`, { discount_type: 'FIXED', discount_value: 5 }),
    'set sub-status': (api, job) => api.post(`/api/jobs/${job.id}/sub-status`, { sub_status_id: null }),
    'add tag': (api, job) => api.post(`/api/jobs/${job.id}/tags`, { name: 'Priority' }),
    'remove tag': (api, job) => api.delete(`/api/jobs/${job.id}/tags/${randomUUID()}`),
    'renumber': (api, job) => api.patch(`/api/jobs/${job.id}/number`, { job_number: `JN-${randomUUID().slice(0, 8)}` }),
    'delete the job': (api, job) => api.delete(`/api/jobs/${job.id}`),
    'add a line': (api, job) => api.post(`/api/jobs/${job.id}/line-items`, { description: 'Hinge', quantity: 1, unit_price: 10 }),
    'edit a line': (api, job) => api.patch(`/api/jobs/${job.id}/line-items/${randomUUID()}`, { quantity: 2 }),
    'remove a line': (api, job) => api.delete(`/api/jobs/${job.id}/line-items/${randomUUID()}`),
    'reorder lines': (api, job) => api.patch(`/api/jobs/${job.id}/line-items/reorder`, { ids: [randomUUID()] }),
    'add a scope': (api, job) => api.post(`/api/jobs/${job.id}/scopes`, { title: 'Scope', flat_price: 10 }),
    'edit a scope': (api, job) => api.patch(`/api/jobs/${job.id}/scopes/0`, { title: 'Changed' }),
    'remove a scope': (api, job) => api.delete(`/api/jobs/${job.id}/scopes/0`),
    'change the crew': (api, job, me) => api.post(`/api/jobs/${job.id}/assignees`, { assignee_ids: [me.id] }),
    'change one visit\'s crew': (api, job, me) => api.post(`/api/jobs/${job.id}/visits/${job.visitId}/assignees`, { assignee_ids: [me.id] }),
    'assign': (api, job, me) => api.post(`/api/jobs/${job.id}/assign`, { assignee_ids: [me.id] }),
    'unassign': (api, job, me) => api.post(`/api/jobs/${job.id}/unassign`, { user_id: me.id }),
    'set the dispatcher': (api, job, me) => api.post(`/api/jobs/${job.id}/dispatcher`, { dispatcher_id: me.id }),
    'set sold by': (api, job, me) => api.post(`/api/jobs/${job.id}/sold-by`, { salesperson_id: me.id }),
    'reschedule a visit': (api, job) => api.patch(`/api/jobs/${job.id}/visits/${job.visitId}`, when),
    'cancel a visit': (api, job) => api.post(`/api/jobs/${job.id}/visits/${job.visitId}/cancel`, {}),
    'visit: on my way': (api, job) => api.post(`/api/jobs/${job.id}/visits/${job.visitId}/en-route`, {}),
    'visit: arrived': (api, job) => api.post(`/api/jobs/${job.id}/visits/${job.visitId}/arrive`, {}),
    'visit: start': (api, job) => api.post(`/api/jobs/${job.id}/visits/${job.visitId}/start`, {}),
    'visit: finish': (api, job) => api.post(`/api/jobs/${job.id}/visits/${job.visitId}/complete`, {}),
    'job-level on my way': (api, job) => api.post(`/api/jobs/${job.id}/en-route`, {}),
    'job-level arrived': (api, job) => api.post(`/api/jobs/${job.id}/arrive`, {}),
    'job-level start': (api, job) => api.post(`/api/jobs/${job.id}/start`, {}),
    'status door: In Progress': (api, job) => api.post(`/api/jobs/${job.id}/status`, { status: 'IN_PROGRESS' }),
    'status door: Unscheduled': (api, job) => api.post(`/api/jobs/${job.id}/status`, { status: 'UNSCHEDULED' }),
    'job-only phone or email': (api, job) => api.post(`/api/jobs/${job.id}/contact-entries`, { kind: 'EMAIL', value: 'probe@example.test' }),
    'replace a customer value for this job': (api, job) =>
      api.post(`/api/jobs/${job.id}/contact-entries/change`, { kind: 'EMAIL', replaces: 'old@example.test', value: 'new@example.test' }),
    'change the customer name for this job': (api, job) =>
      api.post(`/api/jobs/${job.id}/contact-entries/name`, { kind: 'FIRST_NAME', value: 'Probe' }),
    'correct an entry': (api, job) => api.patch(`/api/jobs/${job.id}/contact-entries/${randomUUID()}`, { label: 'Probe' }),
    'remove an entry': (api, job) => api.delete(`/api/jobs/${job.id}/contact-entries/${randomUUID()}`),
  };

  // The lock reads the job status order (S06.1): Completed, every close-out status after it, and Cancelled.
  const lockedStatuses = ['COMPLETED', 'OFFICE_REVIEW', 'READY_TO_CLOSE', 'DONE', 'CANCELLED'] as const;

  // S06.17: on a Done or Cancelled job the doors that set the status are refused by the close-out state machine, ahead of the
  // lock and for everyone: "Reopen this job first". Every other change still answers the lock.
  const REOPEN_FIRST = 'Reopen this job first';
  const STATUS_DOORS = ['unassign', 'job-level arrived', 'job-level start', 'status door: In Progress', 'status door: Unscheduled'];
  const reopensFirst = (status: string) => status === 'DONE' || status === 'CANCELLED';
  // S06.18: in Office review and Ready to close the same doors are a backward move (the step's switch AND Complete jobs, which this
  // role lacks) or job-level Arrived (never one), refused by the close-out state machine ahead of the lock, in the PRD's words.
  const NEEDS_COMPLETE = 'Only someone who can complete jobs can move this job out of office review.';
  const ARRIVED_IN_REVIEW = "Arrived can't move a job in office review. Use the status menu to send it back.";
  const inReview = (status: string) => status === 'OFFICE_REVIEW' || status === 'READY_TO_CLOSE';
  const doorRefusal = (status: string, door: string) =>
    reopensFirst(status) ? REOPEN_FIRST : door === 'job-level arrived' ? ARRIVED_IN_REVIEW : NEEDS_COMPLETE;

  // S06.19: the calls that change a job's lines, scopes or discount, which a Done job refuses for everyone in its own words.
  const PRICE_EDITS = /line|scope|discount/;
  const DONE_PRICES_MESSAGE = 'This job is Done. Reopen it to change its lines or prices.';

  for (const status of lockedStatuses) {
    describe(`a ${status} job`, () => {
      it('refuses every change the lock covers, with the lock message, to a person who holds the ordinary switches', async () => {
        const { org, customer } = await fx.newOrg();
        const me = await personWith(org, { ...OPENING, ...ORDINARY });
        const job = await fx.addJob(org, customer, { status, crew: [me.id] });
        const api = await me.api();
        for (const [name, call] of Object.entries(LOCKED_CALLS)) {
          const res = await call(api, job, me);
          // S06.17: the calendar drag of a visit to a new time is the Reopen rule's too (the visit's step buttons are not).
          if (reopensFirst(status) && name === 'reschedule a visit') {
            expect([name, res.status, res.body.error]).toEqual([name, 409, REOPEN_FIRST]);
            continue;
          }
          if ((reopensFirst(status) || inReview(status)) && STATUS_DOORS.includes(name)) {
            expect([name, res.status, res.body.error]).toEqual([name, 409, doorRefusal(status, name)]);
            continue;
          }
          expect(res.status, name).toBe(403);
          // S06.19: a Done job's lines, scopes and discount answer the Done sentence, which the lock's key does not open.
          expect(res.body.error, name).toBe(status === 'DONE' && PRICE_EDITS.test(name) ? DONE_PRICES_MESSAGE : LOCK_MESSAGE);
        }
      });

      it('lets the same changes past the lock for a person who also holds Change locked jobs', async () => {
        const { org, customer } = await fx.newOrg();
        const me = await personWith(org, { ...OPENING, ...ORDINARY, change_locked_jobs: true });
        const job = await fx.addJob(org, customer, { status, crew: [me.id] });
        const api = await me.api();
        for (const [name, call] of Object.entries(LOCKED_CALLS)) {
          if (name === 'delete the job') continue; // last, so the others still have a job to reach
          const res = await call(api, job, me);
          expect(res.body.error, name).not.toBe(LOCK_MESSAGE);
        }
        expect((await api.patch(`/api/jobs/${job.id}`, { description: 'changed by the holder' })).status).toBe(200);
        expect((await api.delete(`/api/jobs/${job.id}`)).body.error).not.toBe(LOCK_MESSAGE);
      });

      it('still asks the ordinary switch of a Change locked jobs holder', async () => {
        const { org, customer } = await fx.newOrg();
        const me = await personWith(org, { ...OPENING, change_locked_jobs: true });
        const job = await fx.addJob(org, customer, { status, crew: [me.id] });
        const res = await (await me.api()).patch(`/api/jobs/${job.id}`, { description: 'changed' });
        expect(res.status).toBe(403);
        expect(res.body.error).not.toBe(LOCK_MESSAGE);
      });

      it('takes a note and a file from a person with Add notes and Upload attachments', async () => {
        const { org, customer } = await fx.newOrg();
        const me = await personWith(org, { ...OPENING, add_notes: true, upload_attachments: true });
        const job = await fx.addJob(org, customer, { status, crew: [me.id] });
        const api = await me.api();
        const note = await api.post(`/api/jobs/${job.id}/notes`, { content: 'seen on the finished job' });
        expect(note.status).toBe(201);
        const file = await api.post(`/api/attachments/JOB/${job.id}`, {});
        expect(file.status).not.toBe(403);
        expect(file.body.error).not.toBe(LOCK_MESSAGE);
      });

      it('keeps money, invoices and the close-out moves open', async () => {
        const { org, customer } = await fx.newOrg();
        const me = await personWith(org, { ...OPENING, ...ORDINARY, create_estimates: true, duplicate_jobs: true, complete_jobs: true, cancel_jobs: true });
        const job = await fx.addJob(org, customer, { status, crew: [me.id] });
        const api = await me.api();
        const open: [string, Promise<{ status: number; body: Record<string, unknown> }>][] = [
          ['create invoice', api.post(`/api/jobs/${job.id}/invoices`, {})],
          ['duplicate', api.post(`/api/jobs/${job.id}/duplicate`, {})],
          ['complete', api.post(`/api/jobs/${job.id}/complete`, { cancel_open_visits: true })],
          ['cancel', api.post(`/api/jobs/${job.id}/cancel`, { cancel_reason_code: 'OTHER', void_invoices: false })],
        ];
        for (const [name, call] of open) expect((await call).body.error, name).not.toBe(LOCK_MESSAGE);
      });

      it('lists no change action in the per-record answer without Change locked jobs, and says what the lock withholds', async () => {
        const { org, customer } = await fx.newOrg();
        const me = await personWith(org, { ...OPENING, ...ORDINARY });
        const holder = await personWith(org, { ...OPENING, ...ORDINARY, change_locked_jobs: true });
        const job = await fx.addJob(org, customer, { status });
        const without = (await (await me.api()).get(`/api/jobs/${job.id}`)).body.job;
        expect(without.locked).toBe(true);
        for (const gone of ['edit', 'assign', 'schedule', 'delete', 'renumber', 'edit_line_items', 'apply_discount']) {
          expect(without.actions, gone).not.toContain(gone);
          expect(without.locked_actions, gone).toContain(gone);
        }
        // What is not a change to the finished job stays listed.
        for (const kept of ['add_note', 'upload_attachment', 'create_invoice']) expect(without.actions, kept).toContain(kept);
        const withIt = (await (await holder.api()).get(`/api/jobs/${job.id}`)).body.job;
        expect(withIt.locked).toBe(false);
        // A Done job closes the lines and the discount to the holder too (S06.19); every other change is theirs.
        const doneCloses = status === 'DONE' ? ['edit_line_items', 'apply_discount'] : [];
        expect(withIt.locked_actions).toEqual(doneCloses);
        for (const back of ['edit', 'assign', 'schedule', 'delete', 'renumber', 'edit_line_items', 'apply_discount']) {
          if (doneCloses.includes(back)) expect(withIt.actions, back).not.toContain(back);
          else expect(withIt.actions, back).toContain(back);
        }
      });

      it('offers no visit status step on any visit without Change locked jobs', async () => {
        const { org, customer } = await fx.newOrg();
        const me = await personWith(org, { ...OPENING, ...ORDINARY });
        const holder = await personWith(org, { ...OPENING, ...ORDINARY, change_locked_jobs: true });
        const job = await fx.addJob(org, customer, { status, crew: [me.id, holder.id] });
        const stepsOf = async (p: { api: () => Promise<Api> }) =>
          ((await (await p.api()).get(`/api/jobs/${job.id}/visits`)).body.visits as { status_steps: string[] }[])[0]!.status_steps;
        expect(await stepsOf(me)).toEqual([]);
        expect((await stepsOf(holder)).length).toBeGreaterThan(0);
      });

      it('fails a bulk step or bulk assign of the job in the failed list, and still completes or cancels it', async () => {
        const { org, customer } = await fx.newOrg();
        const me = await personWith(org, { ...OPENING, ...ORDINARY, complete_jobs: true, cancel_jobs: true });
        const job = await fx.addJob(org, customer, { status, crew: [me.id] });
        const api = await me.api();
        for (const action of ['arrive', 'start']) {
          // S06.18: this role holds Complete jobs, so bulk start on a job in review is the backward move (proved in
          // permission-job-back-out-db.test.ts), not a lock refusal; the job would no longer be locked for the cases below.
          if (action === 'start' && inReview(status)) continue;
          const res = await api.post('/api/jobs/bulk-status', { ids: [job.id], action });
          expect(res.status, action).toBe(200);
          expect(res.body.updated, action).toEqual([]);
          expect(res.body.failed, action).toEqual([
            expect.objectContaining({ id: job.id, error: reopensFirst(status) || inReview(status) ? doorRefusal(status, action === 'arrive' ? 'job-level arrived' : 'job-level start') : LOCK_MESSAGE }),
          ]);
        }
        const assign = await api.post('/api/jobs/bulk-assign', { ids: [job.id], assignee_ids: [me.id] });
        expect(assign.body.failed).toEqual([expect.objectContaining({ id: job.id, error: LOCK_MESSAGE })]);
        // The close-out moves are not changes to the finished job.
        const complete = await api.post('/api/jobs/bulk-status', { ids: [job.id], action: 'complete', cancel_open_visits: true });
        for (const failed of complete.body.failed as { error: string }[]) expect(failed.error).not.toBe(LOCK_MESSAGE);
        // A Done job is not a locked edit either: it is refused because it must be reopened, never because of the lock (S06.15).
        const cancel = await api.post('/api/jobs/bulk-status', { ids: [job.id], action: 'cancel', cancel_reason_code: 'OTHER', void_invoices: false });
        for (const failed of cancel.body.failed as { error: string }[]) expect(failed.error).not.toBe(LOCK_MESSAGE);
      });

      it('lifts the lock on Reopen (or the status menu out of review), and puts it back when the job is Completed again', async () => {
        const { org, customer, admin } = await fx.newOrg();
        const me = await personWith(org, { ...OPENING, ...ORDINARY, complete_jobs: true, reopen_done_jobs: true });
        const job = await fx.addJob(org, customer, { status });
        const api = await me.api();
        expect((await api.patch(`/api/jobs/${job.id}`, { description: 'before' })).body.error).toBe(LOCK_MESSAGE);
        // Reopen starts only from a closed job (S06.16); a job in review is sent back with the status menu, which the admin holds.
        const out = status === 'OFFICE_REVIEW' || status === 'READY_TO_CLOSE'
          ? (await fx.signedInAs(admin)).post(`/api/jobs/${job.id}/status`, { status: 'IN_PROGRESS' })
          : api.post(`/api/jobs/${job.id}/reopen`);
        expect((await out).status).toBe(200);
        expect((await api.patch(`/api/jobs/${job.id}`, { description: 'after' })).status).toBe(200);
        expect((await api.post(`/api/jobs/${job.id}/complete`, { cancel_open_visits: true })).status).toBe(200);
        expect((await api.patch(`/api/jobs/${job.id}`, { description: 'locked again' })).body.error).toBe(LOCK_MESSAGE);
      });
    });
  }

  it('does not lock a job that is still open, and says nothing locked about it', async () => {
    const { org, customer } = await fx.newOrg();
    const me = await personWith(org, { ...OPENING, ...ORDINARY });
    const job = await fx.addJob(org, customer, { status: 'IN_PROGRESS', crew: [me.id] });
    const api = await me.api();
    expect((await api.patch(`/api/jobs/${job.id}`, { description: 'changed' })).status).toBe(200);
    const body = (await api.get(`/api/jobs/${job.id}`)).body.job;
    expect(body.locked).toBe(false);
    expect(body.locked_actions).toEqual([]);
  });

  it('never tells anyone the lock of a job they cannot open', async () => {
    const { org, customer } = await fx.newOrg();
    const colleague = await fx.addUser(org, `crew${++sequence}`, 'TECHNICIAN');
    const me = await personWith(org, { ...OPENING, ...ORDINARY, jobs_scope: 'attached' });
    const job = await fx.addJob(org, customer, { status: 'COMPLETED', crew: [colleague.id] });
    const res = await (await me.api()).patch(`/api/jobs/${job.id}`, { description: 'changed' });
    expect(res.status).toBe(403);
    expect(res.body.error).not.toBe(LOCK_MESSAGE);
  });

  it('reads the status on every request: a job Completed behind the person\'s back is locked on the next call', async () => {
    const { org, customer } = await fx.newOrg();
    const me = await personWith(org, { ...OPENING, ...ORDINARY });
    const job = await fx.addJob(org, customer, { status: 'IN_PROGRESS', crew: [me.id] });
    const api = await me.api();
    expect((await api.patch(`/api/jobs/${job.id}`, { description: 'one' })).status).toBe(200);
    await db.job.update({ where: { id: job.id }, data: { status: 'COMPLETED' } });
    expect((await api.patch(`/api/jobs/${job.id}`, { description: 'two' })).body.error).toBe(LOCK_MESSAGE);
  });

  it('offers no way to mark a job lost', async () => {
    const { org, customer } = await fx.newOrg();
    const me = await personWith(org, { ...OPENING, ...ORDINARY, complete_jobs: true, cancel_jobs: true });
    const job = await fx.addJob(org, customer, { status: 'IN_PROGRESS' });
    const api = await me.api();
    expect((await api.post(`/api/jobs/${job.id}/status`, { status: 'LOST' })).status).toBe(400);
    expect((await api.post('/api/jobs/bulk-status', { ids: [job.id], action: 'lost' })).status).toBe(400);
    expect((await api.post(`/api/jobs/${job.id}/mark-lost`, { reason: 'x' })).status).toBe(404);
    expect((await api.get(`/api/jobs/${job.id}`)).body.job.actions).not.toContain('mark_lost');
  });
});
