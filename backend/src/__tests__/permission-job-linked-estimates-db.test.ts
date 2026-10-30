/* =============================================================================
   Roles & Permissions, PRD 4, slice S04.26 (scenario pass 2) - the job answer lists only the estimates the person
   can open.

   A person who cannot open an estimate (View estimates off, or the estimate outside their Estimates scope) is not
   told that it exists on the job: the job's attached-estimates list leaves it out, number, id and status together.
   Everything goes through the public interface: the job route, called as people on custom roles made from blank and
   holding exactly the switch values under test. Real migrated database (TEST_DATABASE_URL); the suite skips when it is
   unset.
   ========================================================================== */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import type { PrismaClient } from '@prisma/client';

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

import { switchFixture } from './permission-switches-fixture';
import { setRoleSwitchValues } from '../lib/permissions/switches/store';

const suite = realClient ? describe : describe.skip;

suite("a job's attached estimates are the ones the person can open (real database)", () => {
  const db = realClient as PrismaClient;
  const fx = switchFixture(db, async () => (await import('../app.js')).default as never);
  beforeAll(async () => {
    await import('../app.js');
  }, 120_000);
  afterAll(() => fx.cleanup());

  let sequence = 0;

  /** A job the person is crewed on, with two estimates attached to it: one made by the office, one by the person. */
  async function world(values: Record<string, boolean | string>) {
    const made = await fx.newOrg();
    const key = `linked-${++sequence}`;
    const role = await fx.addCustomRole(made.org, key, 'TECHNICIAN', { madeFromBlank: true, copyGrants: false });
    await setRoleSwitchValues({
      organizationId: made.org, roleKey: key, values: { view_jobs: true, jobs_scope: 'all', ...values } as Record<string, boolean | string>,
      actorId: null, reason: 'manual',
    });
    const person = await fx.addUser(made.org, `lk${sequence}`, 'TECHNICIAN', { customRoleId: role.id });
    const job = await fx.addJob(made.org, made.customer, { crew: [person.id] });
    const office = await fx.addEstimate(made.org, made.customer, made.admin.id, { jobId: job.id });
    return { ...made, person, job: job.id, office: office.id, api: await fx.signedInAs(person) };
  }

  const attachedIds = (body: { job: { linked_estimates?: Array<{ id: string }> } }) => (body.job.linked_estimates ?? []).map((e) => e.id);

  it('names no estimate to a person with View estimates off: no id, number or status', async () => {
    const w = await world({ view_estimates: false });
    const res = await w.api.get(`/api/jobs/${w.job}`);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(attachedIds(res.body)).toEqual([]);
    expect(JSON.stringify(res.body)).not.toContain(w.office);
  });

  it('lists the estimate to a person who can open it', async () => {
    const w = await world({ view_estimates: true, estimates_scope: 'all' });
    const res = await w.api.get(`/api/jobs/${w.job}`);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(attachedIds(res.body)).toEqual([w.office]);
  });

  it('lists the estimates on a job the person is attached to under Attached scope, and not one beyond their reach', async () => {
    const w = await world({ view_estimates: true, estimates_scope: 'attached' });
    // A second job nobody on this person's side is crewed on, with its own estimate attached.
    const other = await fx.addJob(w.org, w.customer, { crew: [w.admin.id] });
    const beyond = await fx.addEstimate(w.org, w.customer, w.admin.id, { jobId: other.id });
    const mine = await w.api.get(`/api/jobs/${w.job}`);
    expect(attachedIds(mine.body)).toEqual([w.office]);
    // A job the person reaches (Jobs scope All) but is not crewed on: its estimate is outside Attached.
    const there = await w.api.get(`/api/jobs/${other.id}`);
    expect(there.status, JSON.stringify(there.body)).toBe(200);
    expect(attachedIds(there.body)).not.toContain(beyond.id);
  });
});
