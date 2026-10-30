/* =============================================================================
   Roles & Permissions, PRD 5, slice S05.11 - the job lock on a job's own contact entries.

   PRD 4's lock applies to every write to a job's own phones, emails, name and company (add, change, correct, remove):
   a Completed job, one in any later close-out status (Office review, Ready to close, Done) and a Cancelled one refuse
   them without Change locked jobs, and a holder still needs the ordinary switch for the write. Finishing a visit, even
   the last, never locks. The customer's own record never locks.

   Everything goes through the job routes, called as people on custom roles (never a built-in role name) holding the
   switch values under test. Real migrated database (TEST_DATABASE_URL); the suite skips when it is unset. Every org it
   creates is removed again.
   ========================================================================== */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
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

import { switchFixture, type Person } from './permission-switches-fixture';
import { setRoleSwitchValues } from '../lib/permissions/switches/store';
import { SWITCH_CATALOG, type SwitchValue } from '../lib/permissions/switches/catalog';

const suite = realClient ? describe : describe.skip;

/** Every switch in the catalog off (a choice at its first option, a list empty), so a case turns on exactly the ones it is about. */
const ALL_OFF: Record<string, SwitchValue> = Object.fromEntries(
  SWITCH_CATALOG.map((s) => [s.key, s.kind === 'choice' ? s.choices![0]! : s.kind === 'list' ? [] : false]),
);

/** The wording the slice gives the refusal (the PRD's own text, not read from the code). */
const LOCK_MESSAGE = 'This job is locked. Only someone who can change locked jobs can change it.';

/** What opening the job takes, with no action switch on. */
const OPENING = { view_jobs: true, jobs_scope: 'all' };

/** The ordinary switches of every write: phones and emails by either, names by Edit jobs. */
const ORDINARY = { edit_job_and_lead_contact_details: true, edit_jobs: true };

/** Edit customers, to change the customer's own phone and email on the customer record. */
const EDITS_CUSTOMERS = { view_customers: true, edit_customers: true };

suite("the job lock on a job's own contact entries (real database)", () => {
  const db = realClient as PrismaClient;
  const fx = switchFixture(db, async () => (await import('../app.js')).default as never);
  beforeAll(async () => {
    await import('../app.js');
  }, 120_000);
  afterAll(() => fx.cleanup());

  type Api = Awaited<ReturnType<typeof fx.signedInAs>>;
  let sequence = 0;

  /** A person on a fresh custom role holding exactly these switch values over everything else off. */
  async function personWith(org: string, values: Record<string, SwitchValue>, base: Role = 'DISPATCHER'): Promise<Person> {
    const key = `job-entry-lock-role-${++sequence}`;
    const role = await fx.addCustomRole(org, key, base);
    await setRoleSwitchValues({ organizationId: org, roleKey: key, values: { ...ALL_OFF, ...values }, actorId: null, reason: 'manual' });
    return fx.addUser(org, `jel${sequence}`, base, { customRoleId: role.id });
  }

  /**
   * A job at `status` on a customer with a phone and an email, on the crew of the person asking, holding one live
   * phone entry (written straight to the table, so a person who holds no ordinary switch can be the one asking).
   */
  async function setup(status: JobStatus, values: Record<string, SwitchValue> = { ...OPENING, ...ORDINARY }) {
    const { org, customer, admin } = await fx.newOrg();
    await db.customer.update({
      where: { id: customer },
      data: { phone: '6175550101', email: 'pat@example.test', first_name: 'Pat', last_name: 'Jones', company_name: 'Jones Hardware' },
    });
    const me = await personWith(org, values);
    const job = await fx.addJob(org, customer, { crew: [me.id], status });
    const { id: entryId } = await db.recordContactEntry.create({
      data: { organization_id: org, job_id: job.id, kind: 'PHONE', intent: 'ADDED', value: '6175550199' },
      select: { id: true },
    });
    return { org, customer, me, job, api: await fx.signedInAs(me), entryId, admin };
  }

  const base = (jobId: string) => `/api/jobs/${jobId}/contact-entries`;

  /** Every write to a job's own entries, as the call a control makes. */
  const WRITES: Record<string, (api: Api, jobId: string, entryId: string) => Promise<{ status: number; body: Record<string, unknown> }>> = {
    'add a phone': (api, id) => api.post(base(id), { kind: 'PHONE', value: '6175550123' }),
    'add an email': (api, id) => api.post(base(id), { kind: 'EMAIL', value: 'wife@example.test' }),
    "change the customer's phone": (api, id) => api.post(`${base(id)}/change`, { kind: 'PHONE', replaces: '6175550101', value: '6175550188' }),
    "change the customer's name": (api, id) => api.post(`${base(id)}/name`, { kind: 'FIRST_NAME', value: 'Patrick' }),
    'correct an entry': (api, id, entryId) => api.patch(`${base(id)}/${entryId}`, { label: 'Wife' }),
    'remove an entry': (api, id, entryId) => api.delete(`${base(id)}/${entryId}`),
  };
  const ACCEPTED = {
    'add a phone': 201,
    'add an email': 201,
    "change the customer's phone": 201,
    "change the customer's name": 201,
    'correct an entry': 200,
    'remove an entry': 200,
  };

  const entryCount = (jobId: string) => db.recordContactEntry.count({ where: { job_id: jobId } });
  const liveCount = (jobId: string) => db.recordContactEntry.count({ where: { job_id: jobId, removed_at: null } });
  const run = async (api: Api, jobId: string, entryId: string) => {
    const results: Record<string, number> = {};
    for (const [name, write] of Object.entries(WRITES)) results[name] = (await write(api, jobId, entryId)).status;
    return results;
  };

  // Completed, every close-out status after it, and Cancelled: the statuses the lock helper treats as locked.
  const LOCKED_STATUSES = ['COMPLETED', 'OFFICE_REVIEW', 'READY_TO_CLOSE', 'DONE', 'CANCELLED'] as const;

  for (const status of LOCKED_STATUSES) {
    describe(`a ${status} job`, () => {
      for (const [name, write] of Object.entries(WRITES)) {
        it(`refuses "${name}" without Change locked jobs, to a person who holds the ordinary switches`, async () => {
          const { job, api, entryId } = await setup(status);

          const res = await write(api, job.id, entryId);

          expect(res.status).toBe(403);
          expect(res.body.error).toBe(LOCK_MESSAGE);
          expect(res.body.code).toBe('JOB_LOCKED');
        });
      }

      it('changes nothing and writes no history when a write is refused', async () => {
        const { job, api, entryId } = await setup(status);
        const timelineBefore = (await api.get(`/api/jobs/${job.id}/timeline`)).body.events.length;

        await run(api, job.id, entryId);

        expect(await entryCount(job.id)).toBe(1);
        expect(await liveCount(job.id)).toBe(1);
        expect((await api.get(`/api/jobs/${job.id}/timeline`)).body.events.length).toBe(timelineBefore);
      });

      it('accepts every write from a holder of Change locked jobs who also holds the ordinary switches', async () => {
        const { job, api, entryId } = await setup(status, { ...OPENING, ...ORDINARY, change_locked_jobs: true });

        expect(await run(api, job.id, entryId)).toEqual(ACCEPTED);
      });

      it('still asks the ordinary switch of a Change locked jobs holder: the name needs Edit jobs, a phone either switch', async () => {
        const { job, api, entryId } = await setup(status, { ...OPENING, edit_job_and_lead_contact_details: true, change_locked_jobs: true });
        const results = await run(api, job.id, entryId);
        expect(results).toEqual({ ...ACCEPTED, "change the customer's name": 403 });

        const none = await setup(status, { ...OPENING, change_locked_jobs: true });
        for (const [name, write] of Object.entries(WRITES)) {
          const res = await write(none.api, none.job.id, none.entryId);
          expect(res.status, name).toBe(403);
          expect(res.body.error, name).not.toBe(LOCK_MESSAGE);
        }
      });

      it('lifts the lock when the job is reopened, and puts it back when it is completed again', async () => {
        const { job, api, admin } = await setup(status, { ...OPENING, ...ORDINARY, reopen_done_jobs: true, complete_jobs: true });
        expect((await WRITES['add an email']!(api, job.id, '')).body.error).toBe(LOCK_MESSAGE);

        // Reopen starts only from a closed job (S06.16); a job in review is sent back with the status menu, which the admin holds.
        const out = status === 'OFFICE_REVIEW' || status === 'READY_TO_CLOSE'
          ? (await fx.signedInAs(admin)).post(`/api/jobs/${job.id}/status`, { status: 'IN_PROGRESS' })
          : api.post(`/api/jobs/${job.id}/reopen`);
        expect((await out).status).toBe(200);
        expect((await WRITES['add an email']!(api, job.id, '')).status).toBe(201);

        expect((await api.post(`/api/jobs/${job.id}/complete`, { cancel_open_visits: true })).status).toBe(200);
        expect((await WRITES['add a phone']!(api, job.id, '')).body.error).toBe(LOCK_MESSAGE);
      });

      it('still returns the job\'s entries on the job detail, and says the job is locked for this person only', async () => {
        const { org, job, api } = await setup(status);
        const holder = await personWith(org, { ...OPENING, ...ORDINARY, change_locked_jobs: true });

        const res = await api.get(`/api/jobs/${job.id}`);
        const held = await (await fx.signedInAs(holder)).get(`/api/jobs/${job.id}`);

        expect(res.status).toBe(200);
        expect(res.body.job.locked).toBe(true);
        expect((res.body.job.contact_entries as { value: string }[]).map((e) => e.value)).toEqual(['6175550199']);
        expect(held.body.job.locked).toBe(false);
      });
    });
  }

  for (const status of ['UNSCHEDULED', 'SCHEDULED', 'IN_PROGRESS'] as const) {
    it(`accepts every write on a ${status} job under the ordinary switches`, async () => {
      const { job, api, entryId } = await setup(status);

      expect(await run(api, job.id, entryId)).toEqual(ACCEPTED);
    });
  }

  it('keeps the ordinary refusal first: a person without the switch is told they lack permission, not that the job is locked', async () => {
    const { org, job } = await setup('DONE');
    const nobody = await personWith(org, { ...OPENING });

    const res = await WRITES['add a phone']!(await fx.signedInAs(nobody), job.id, '');

    expect(res.status).toBe(403);
    expect(res.body.error).not.toBe(LOCK_MESSAGE);
    expect(res.body.code).toBeUndefined();
  });

  it('never tells anyone the status of a job they cannot open: not found, the same as across companies', async () => {
    const { org, job } = await setup('DONE');
    const scoped = await personWith(org, { ...ORDINARY, view_jobs: true, jobs_scope: 'attached' });

    const off = await WRITES['add a phone']!(await fx.signedInAs(scoped), job.id, '');
    expect(off.status).toBe(404);
    expect(off.body.error).not.toBe(LOCK_MESSAGE);

    const other = await fx.newOrg();
    const foreign = await fx.addJob(other.org, other.customer, { status: 'DONE' });
    const across = await WRITES['add a phone']!(await fx.signedInAs(scoped), foreign.id, '');
    expect(across.status).toBe(404);
    expect(across.body.error).not.toBe(LOCK_MESSAGE);
  });

  describe('finishing visits', () => {
    it('leaves the job status unchanged and every write accepted, even when the last open visit is finished', async () => {
      const { job, me } = await setup('IN_PROGRESS', {
        ...OPENING, ...ORDINARY, start_and_finish_visits: true, mark_arrived: true, mark_on_my_way: true,
      });
      const api = await fx.signedInAs(me);
      const entryId = (await db.recordContactEntry.findFirstOrThrow({ where: { job_id: job.id } })).id;

      const finished = await api.post(`/api/jobs/${job.id}/visits/${job.visitId}/complete`);

      expect(finished.status, JSON.stringify(finished.body)).toBe(200);
      expect((await db.visit.findUniqueOrThrow({ where: { id: job.visitId! } })).status).toBe('COMPLETED');
      expect((await db.job.findUniqueOrThrow({ where: { id: job.id } })).status).toBe('IN_PROGRESS');
      expect((await api.get(`/api/jobs/${job.id}`)).body.job.locked).toBe(false);
      expect(await run(api, job.id, entryId)).toEqual(ACCEPTED);
    });
  });

  describe("the customer's own record", () => {
    for (const status of LOCKED_STATUSES) {
      it(`never locks on a ${status} job: a person with Edit customers still changes the customer's phone and email`, async () => {
        const { customer, api } = await setup(status, { ...OPENING, ...ORDINARY, ...EDITS_CUSTOMERS });
        const before = await db.customer.findUniqueOrThrow({ where: { id: customer } });

        const res = await api.patch(`/api/customers/${customer}`, { phone: '6175550177', email: 'new@example.test' });

        expect(res.status, JSON.stringify(res.body)).toBe(200);
        const after = await db.customer.findUniqueOrThrow({ where: { id: customer } });
        expect(before.phone).toBe('6175550101');
        expect(after.phone).toBe('6175550177');
        expect(after.email).toBe('new@example.test');
      });
    }
  });
});
