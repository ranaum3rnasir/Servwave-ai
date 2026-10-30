/* =============================================================================
   Roles & Permissions, PRD 6, slice S06.4 - the lock holds through Office review, Ready to close and Done.

   PRD 4's completed-job lock reads the completed-or-later set, so a job in any close-out status is locked for
   everyone without Change locked jobs: job details, the job's files and its invoices' files, note deletes and the
   customer details on the job all answer the one lock refusal. Adding a note or a file still works. A NEW visit is
   refused for everyone, a Change locked jobs holder included, with a reason that depends on where the job stands:
   "Move this job back out of review first" in Office review and Ready to close, "Reopen this job first" on a
   Done, Completed or Cancelled job. A backward move or a Reopen lifts the lock and lets a new visit in.

   The finer refusals (crew change, visit steps, lines, scopes, discount, people) are proved over every locked
   status by permission-job-lock-db.test.ts; the files, notes and contact entries by their own suites. This one
   proves the criteria of the slice end to end with the one custom role the criteria describe.

   Everything goes through the public interface: the job, attachment and note routes, called as people on custom
   roles (never a built-in role name) holding exactly the switch values under test. Real migrated database
   (TEST_DATABASE_URL); the suite skips when it is unset. Every org it creates is removed again.
   ========================================================================== */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { randomUUID } from 'crypto';
import type { JobStatus, PrismaClient, Role } from '@prisma/client';

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

import { switchFixture } from './permission-switches-fixture';
import { setRoleSwitchValues } from '../lib/permissions/switches/store';
import { SWITCH_CATALOG, type SwitchValue } from '../lib/permissions/switches/catalog';

const suite = realClient ? describe : describe.skip;

/** Every switch in the catalog off (a choice at its first option, a list empty), so a case turns on exactly the ones it is about. */
const ALL_OFF: Record<string, SwitchValue> = Object.fromEntries(
  SWITCH_CATALOG.map((s) => [s.key, s.kind === 'choice' ? s.choices![0]! : s.kind === 'list' ? [] : false]),
);

/** The PRD's own wording (not read from the code). */
const LOCK_MESSAGE = 'This job is locked. Only someone who can change locked jobs can change it.';
const BACK_OUT_FIRST = 'Move this job back out of review first';
const REOPEN_FIRST = 'Reopen this job first';

/** What opening the job, its invoices and its files takes, with no action switch on. */
const OPENING = {
  view_jobs: true, jobs_scope: 'all', create_jobs: true, view_attachments: true,
  view_invoices: true, invoices_scope: 'all', view_customers: true,
};

/** The role of criterion 1: the four ordinary switches of the five changes, and neither key to the lock. */
const WITHOUT_THE_KEY = { ...OPENING, delete_attachments: true, edit_jobs: true, edit_job_and_lead_contact_details: true, delete_others_notes: true };

const SCHEDULING = { schedule_visits: true, assign_people_to_jobs: true, assign_work_to_others: true, edit_jobs: true };

const body = { scheduled_start: '2030-01-01T10:00:00.000Z', scheduled_end: '2030-01-01T11:00:00.000Z', is_all_day: false, assignee_ids: [] };

/** The close-out statuses the slice is about, with where a new visit is pointed. */
const CLOSE_OUT = ['OFFICE_REVIEW', 'READY_TO_CLOSE', 'DONE'] as const;
const NEW_VISIT_REASON: Record<JobStatus, string | null> = {
  UNSCHEDULED: null, SCHEDULED: null, IN_PROGRESS: null,
  COMPLETED: REOPEN_FIRST, OFFICE_REVIEW: BACK_OUT_FIRST, READY_TO_CLOSE: BACK_OUT_FIRST, DONE: REOPEN_FIRST, CANCELLED: REOPEN_FIRST,
};

suite('the lock through Office review, Ready to close and Done (real database)', () => {
  const db = realClient as PrismaClient;
  const fx = switchFixture(db, async () => (await import('../app.js')).default as never);
  // Loading the whole app is slow on a loaded machine.
  beforeAll(async () => {
    await import('../app.js');
  }, 120_000);

  const orgs: string[] = [];
  afterAll(async () => {
    const quietly = (p: Promise<unknown>) => p.catch(() => undefined);
    for (const org of orgs) {
      for (const table of ['attachments', 'notes', 'record_contact_entries', 'timeline_events']) {
        await quietly(db.$executeRawUnsafe(`DELETE FROM ${table} WHERE organization_id = '${org}'`));
      }
    }
    await fx.cleanup();
  });

  let sequence = 0;

  /** A person on a fresh custom role holding exactly these switch values over everything else off. */
  async function personWith(org: string, values: Record<string, SwitchValue>, base: Role = 'DISPATCHER') {
    const key = `close-out-lock-role-${++sequence}`;
    const role = await fx.addCustomRole(org, key, base);
    await setRoleSwitchValues({ organizationId: org, roleKey: key, values: { ...ALL_OFF, ...values }, actorId: null, reason: 'manual' });
    const person = await fx.addUser(org, `p${sequence}`, base, { customRoleId: role.id });
    return Object.assign(person, { api: () => fx.signedInAs(person) });
  }

  /** A job at `status` with a file, an invoice with a file, a note by someone else and a customer phone to change. */
  async function setup(status: JobStatus) {
    const { org, customer, admin } = await fx.newOrg();
    orgs.push(org);
    await db.customer.update({ where: { id: customer }, data: { phone: '6175550101', email: 'pat@example.test' } });
    const job = await fx.addJob(org, customer, { status });
    const invoice = await fx.addInvoice(org, customer, { jobId: job.id });
    const addFile = async (type: 'JOB' | 'INVOICE', id: string) => {
      const file = randomUUID();
      await db.attachment.create({
        data: {
          id: file, organization_id: org, entity_type: type, entity_id: id, file_name: `${file}.pdf`,
          file_url: `https://files.example.test/${file}.pdf`, storage_path: `org/${file}.pdf`, file_type: 'application/pdf',
          file_size: 10, display_name: `File ${file.slice(0, 4)}`, uploaded_by: admin.id,
        },
      });
      return file;
    };
    const jobFile = await addFile('JOB', job.id);
    const invoiceFile = await addFile('INVOICE', invoice.id);
    const note = (await db.note.create({
      data: { organization_id: org, entity_type: 'JOB', entity_id: job.id, content: 'left by the office', created_by: admin.id },
      select: { id: true },
    })).id;
    return { org, customer, job, invoice, jobFile, invoiceFile, note };
  }

  type Setup = Awaited<ReturnType<typeof setup>>;
  type Api = Awaited<ReturnType<typeof fx.signedInAs>>;

  /** The five changes of criterion 1, as the call a control makes. */
  const FIVE_CHANGES: Record<string, (api: Api, s: Setup) => Promise<{ status: number; body: Record<string, unknown> }>> = {
    'a job file delete': (api, s) => api.delete(`/api/attachments/job/${s.job.id}/${s.jobFile}`),
    'an invoice file delete': (api, s) => api.delete(`/api/attachments/invoice/${s.invoice.id}/${s.invoiceFile}`),
    'a note delete': (api, s) => api.delete(`/api/jobs/${s.job.id}/notes/${s.note}`),
    'a job detail edit': (api, s) => api.patch(`/api/jobs/${s.job.id}`, { scope_notes: 'changed' }),
    'a job customer detail change': (api, s) =>
      api.post(`/api/jobs/${s.job.id}/contact-entries/change`, { kind: 'PHONE', replaces: '6175550101', value: '6175550188' }),
  };

  const leftAfterRefusal = async (s: Setup) => ({
    jobFile: await db.attachment.count({ where: { id: s.jobFile } }),
    invoiceFile: await db.attachment.count({ where: { id: s.invoiceFile } }),
    note: await db.note.count({ where: { id: s.note } }),
    scope_notes: (await db.job.findUniqueOrThrow({ where: { id: s.job.id }, select: { scope_notes: true } })).scope_notes,
    entries: await db.recordContactEntry.count({ where: { job_id: s.job.id } }),
  });

  for (const status of CLOSE_OUT) {
    describe(`a job in ${status}`, () => {
      it('refuses a job file delete, an invoice file delete, a note delete, a job detail edit and a customer detail change without Change locked jobs or Office review', async () => {
        const s = await setup(status);
        const me = await personWith(s.org, WITHOUT_THE_KEY);
        const api = await me.api();
        const before = await leftAfterRefusal(s);
        for (const [name, call] of Object.entries(FIVE_CHANGES)) {
          const res = await call(api, s);
          expect(res.status, name).toBe(403);
          expect(res.body.error, name).toBe(LOCK_MESSAGE);
        }
        expect(await leftAfterRefusal(s)).toEqual(before);
      });

      it('lets the same role in once it also holds Change locked jobs', async () => {
        const s = await setup(status);
        const me = await personWith(s.org, { ...WITHOUT_THE_KEY, change_locked_jobs: true });
        const api = await me.api();
        for (const [name, call] of Object.entries(FIVE_CHANGES)) {
          const res = await call(api, s);
          expect(res.status, name).toBeLessThan(300);
        }
        const after = await leftAfterRefusal(s);
        expect(after).toMatchObject({ jobFile: 0, invoiceFile: 0, note: 0, scope_notes: 'changed' });
        expect(after.entries).toBeGreaterThan(0);
      });

      it('takes a note and a file from a person with Add notes and Upload attachments', async () => {
        const s = await setup(status);
        const me = await personWith(s.org, { ...OPENING, add_notes: true, upload_attachments: true });
        const api = await me.api();
        const note = await api.post(`/api/jobs/${s.job.id}/notes`, { content: 'seen on the closed-out job' });
        expect(note.status).toBe(201);
        // No file is sent, so the route stops at "no file" once every guard has let the person in; the lock would answer 403 first.
        const file = await api.post(`/api/attachments/job/${s.job.id}`, {});
        expect(file.status).not.toBe(403);
        expect(file.body.error).not.toBe(LOCK_MESSAGE);
      });
    });
  }

  for (const status of [...CLOSE_OUT, 'COMPLETED', 'CANCELLED'] as const) {
    describe(`adding a visit to a ${status} job`, () => {
      const reason = NEW_VISIT_REASON[status]!;
      const visits = (jobId: string) => db.visit.count({ where: { job_id: jobId } });

      it(`is refused with "${reason}" to a person who may schedule visits, and to a Change locked jobs holder too`, async () => {
        const s = await setup(status);
        const plain = await personWith(s.org, { ...OPENING, ...SCHEDULING });
        const holder = await personWith(s.org, { ...OPENING, ...SCHEDULING, change_locked_jobs: true });
        for (const person of [plain, holder]) {
          const res = await (await person.api()).post(`/api/jobs/${s.job.id}/visits`, body);
          expect(res.status).toBe(403);
          expect(res.body.error).toBe(reason);
        }
        expect(await visits(s.job.id)).toBe(0);
      });

      it('is refused by the other doors that would mint a trip (the job edit and Assign), with the same words', async () => {
        const s = await setup(status);
        const holder = await personWith(s.org, { ...OPENING, ...SCHEDULING, change_locked_jobs: true });
        const api = await holder.api();
        const window = { scheduled_start: body.scheduled_start, scheduled_end: body.scheduled_end };
        const edit = await api.patch(`/api/jobs/${s.job.id}`, window);
        expect(edit.status).toBe(403);
        expect(edit.body.error).toBe(reason);
        const assign = await api.post(`/api/jobs/${s.job.id}/assign`, { ...window, is_all_day: false, assignee_ids: [] });
        // S06.17: on a Done or Cancelled job Assign's moving window and the status door are refused by the close-out state
        // machine before the new-visit rule is asked: the same words, a 409.
        // S06.18: in Office review and Ready to close the same two doors are a backward move, which this holder cannot make without
        // Complete jobs: the close-out state machine refuses them first, in the PRD's words (a Change locked jobs key does not open it).
        const refusedByCloseOut = status === 'DONE' || status === 'CANCELLED';
        const refusedAsBackwardMove = status === 'OFFICE_REVIEW' || status === 'READY_TO_CLOSE';
        const doorReason = refusedAsBackwardMove ? 'Only someone who can complete jobs can move this job out of office review.' : reason;
        expect(assign.status).toBe(refusedByCloseOut || refusedAsBackwardMove ? 409 : 403);
        expect(assign.body.error).toBe(doorReason);
        const status_door = await api.post(`/api/jobs/${s.job.id}/status`, { status: 'SCHEDULED', ...window });
        expect(status_door.status).toBe(refusedByCloseOut || refusedAsBackwardMove ? 409 : 403);
        expect(status_door.body.error).toBe(doorReason);
        expect(await visits(s.job.id)).toBe(0);
        expect((await db.job.findUniqueOrThrow({ where: { id: s.job.id }, select: { status: true } })).status).toBe(status);
      });

      it('says the reason in the per-record answer, to a holder and to everyone else, for the control to draw', async () => {
        const s = await setup(status);
        const plain = await personWith(s.org, { ...OPENING, ...SCHEDULING });
        const holder = await personWith(s.org, { ...OPENING, ...SCHEDULING, change_locked_jobs: true });
        for (const person of [plain, holder]) {
          const answer = (await (await person.api()).get(`/api/jobs/${s.job.id}`)).body.job;
          expect(answer.new_visit_closed).toBe(true);
          expect(answer.new_visit_closed_reason).toBe(reason);
        }
      });
    });
  }

  it('leaves the reason off the answer of a job that is still open', async () => {
    const { org, customer } = await fx.newOrg();
    orgs.push(org);
    const me = await personWith(org, { ...OPENING, ...SCHEDULING });
    const job = await fx.addJob(org, customer, { status: 'IN_PROGRESS' });
    const answer = (await (await me.api()).get(`/api/jobs/${job.id}`)).body.job;
    expect(answer.new_visit_closed).toBe(false);
    expect(answer.new_visit_closed_reason).toBeNull();
  });

  describe('lifting', () => {
    it('lets a new visit and the five changes in again after Reopen, from Done and from Cancelled', async () => {
      for (const status of ['DONE', 'CANCELLED'] as const) {
        const s = await setup(status);
        const me = await personWith(s.org, { ...WITHOUT_THE_KEY, ...SCHEDULING, reopen_done_jobs: true });
        const api = await me.api();
        expect((await api.post(`/api/jobs/${s.job.id}/visits`, body)).status, `${status} before`).toBe(403);
        expect((await api.post(`/api/jobs/${s.job.id}/reopen`)).status, status).toBe(200);
        expect((await api.post(`/api/jobs/${s.job.id}/visits`, body)).status, `${status} after`).toBe(201);
        for (const [name, call] of Object.entries(FIVE_CHANGES)) {
          const res = await call(api, s);
          expect(res.status, `${status} ${name}`).toBeLessThan(300);
        }
        const answer = (await api.get(`/api/jobs/${s.job.id}`)).body.job;
        expect(answer.new_visit_closed).toBe(false);
        expect(answer.new_visit_closed_reason).toBeNull();
        expect(answer.locked).toBe(false);
      }
    });

    it('lets a new visit in again after the status menu moves an Office review or Ready to close job back', async () => {
      for (const status of ['OFFICE_REVIEW', 'READY_TO_CLOSE'] as const) {
        const s = await setup(status);
        const me = await personWith(s.org, { ...OPENING, ...SCHEDULING, change_locked_jobs: true, complete_jobs: true, mark_on_my_way: true, mark_arrived: true, start_and_finish_visits: true, update_any_visit_status: true });
        const api = await me.api();
        expect((await api.post(`/api/jobs/${s.job.id}/visits`, body)).body.error, `${status} before`).toBe(BACK_OUT_FIRST);
        const moved = await api.post(`/api/jobs/${s.job.id}/status`, { status: 'IN_PROGRESS' });
        expect([moved.status, moved.body.error], status).toEqual([200, undefined]);
        const res = await api.post(`/api/jobs/${s.job.id}/visits`, body);
        expect(res.status, `${status} after`).toBe(201);
        expect((await api.get(`/api/jobs/${s.job.id}`)).body.job.new_visit_closed_reason).toBeNull();
      }
    });
  });
});
