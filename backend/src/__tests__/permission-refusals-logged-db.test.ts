/* =============================================================================
   Roles & Permissions, P18 - every refusal is logged.

   When the server refuses an action, or hides a record the person may not reach, it writes one audit row saying who, what, when
   and which switch would have allowed it. An allowed action writes none, and a request for a record that is not there writes none.

   Everything goes through the public interface: the job and estimate routes, called as people on custom roles. Real migrated
   database (TEST_DATABASE_URL); the suite skips when it is unset. Every org it creates is removed again.
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
// The suite-wide setup also mocks the audit writer; the rows are the thing under test here.
vi.unmock('../lib/audit');

import { switchFixture, type Person } from './permission-switches-fixture';
import { setRoleSwitchValues } from '../lib/permissions/switches/store';
import { SWITCH_CATALOG, type SwitchValue } from '../lib/permissions/switches/catalog';

const suite = realClient ? describe : describe.skip;

/** Every switch in the catalog off (a choice at its first option, a list empty), so a case turns on exactly the ones it is about. */
const ALL_OFF: Record<string, SwitchValue> = Object.fromEntries(
  SWITCH_CATALOG.map((s) => [s.key, s.kind === 'choice' ? s.choices![0]! : s.kind === 'list' ? [] : false]),
);

suite('every refusal is logged (real database)', () => {
  const db = realClient as PrismaClient;
  const fx = switchFixture(db, async () => (await import('../app.js')).default as never);
  // Loading the whole app is slow on a loaded machine.
  beforeAll(async () => {
    await import('../app.js');
  }, 120_000);
  afterAll(async () => {
    await fx.cleanup();
  });

  type Api = Awaited<ReturnType<typeof fx.signedInAs>>;
  let sequence = 0;

  /** A person on a fresh custom role holding exactly these switch values over everything else off. */
  async function personWith(org: string, values: Record<string, SwitchValue>): Promise<Person & { api: () => Promise<Api> }> {
    const key = `refusal-role-${++sequence}`;
    const role = await fx.addCustomRole(org, key, 'TECHNICIAN');
    await setRoleSwitchValues({ organizationId: org, roleKey: key, values: { ...ALL_OFF, see_prices: true, ...values }, actorId: null, reason: 'manual' });
    const person = await fx.addUser(org, `refused${sequence}`, 'TECHNICIAN', { customRoleId: role.id });
    return Object.assign(person, { api: () => fx.signedInAs(person) });
  }

  /** The rows the audit log holds for this person, once the response's own write has landed (it is written after the response). */
  async function rowsFor(person: Person, wanted: number, action?: string) {
    for (let i = 0; i < 40; i++) {
      const rows = await db.auditLog.findMany({
        where: { actor_id: person.id, ...(action ? { action } : { action: { in: ['access.denied', 'access.hidden'] } }) },
        orderBy: { created_at: 'asc' },
      });
      if (rows.length >= wanted) {
        // A short wait for a second row that should not be there, so "exactly one" is a real check.
        await new Promise((r) => setTimeout(r, 150));
        return db.auditLog.findMany({
          where: { actor_id: person.id, ...(action ? { action } : { action: { in: ['access.denied', 'access.hidden'] } }) },
          orderBy: { created_at: 'asc' },
        });
      }
      await new Promise((r) => setTimeout(r, 50));
    }
    return [];
  }

  const metaOf = (row: { metadata: unknown }) => row.metadata as { method: string; path: string; needs?: string[]; switches?: string[] };

  it('writes exactly one row for a refused action, naming who, what and the switch that would have allowed it', async () => {
    const { org, customer } = await fx.newOrg();
    const me = await personWith(org, { view_jobs: true, jobs_scope: 'all' });
    const job = await fx.addJob(org, customer, { crew: [me.id] });

    const res = await (await me.api()).delete(`/api/jobs/${job.id}`);
    expect(res.status).toBe(403);

    const rows = await rowsFor(me, 1);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.action).toBe('access.denied');
    expect(rows[0]!.org_id).toBe(org);
    expect(rows[0]!.actor_id).toBe(me.id);
    expect(rows[0]!.created_at).toBeInstanceOf(Date);
    expect(metaOf(rows[0]!)).toMatchObject({ method: 'DELETE', path: `/api/jobs/${job.id}`, needs: ['delete:Job'], switches: ['delete_jobs'] });
  });

  it('writes exactly one row for a record that exists but is out of reach, naming the scope switch', async () => {
    const { org, customer, admin } = await fx.newOrg();
    const me = await personWith(org, { view_estimates: true, view_jobs: true, jobs_scope: 'attached', leads_scope: 'attached' });
    const strangerJob = await fx.addJob(org, customer, { crew: [(await fx.addUser(org, `mate${++sequence}`, 'TECHNICIAN')).id] });
    const estimate = await fx.addEstimate(org, customer, admin.id, { jobId: strangerJob.id });

    const res = await (await me.api()).get(`/api/estimates/${estimate.id}`);
    expect(res.status).toBe(404);

    const rows = await rowsFor(me, 1);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.action).toBe('access.hidden');
    expect(rows[0]!.resource_type).toBe('Estimate');
    expect(rows[0]!.resource_id).toBe(estimate.id);
    expect(metaOf(rows[0]!).switches).toEqual(['jobs_scope', 'leads_scope']);
  });

  it('writes no row for an allowed action', async () => {
    const { org, customer } = await fx.newOrg();
    const me = await personWith(org, { view_jobs: true, jobs_scope: 'all', edit_jobs: true });
    const job = await fx.addJob(org, customer, { crew: [me.id] });

    const res = await (await me.api()).patch(`/api/jobs/${job.id}`, { description: 'changed' });
    expect(res.status).toBe(200);
    await new Promise((r) => setTimeout(r, 300));

    expect(await db.auditLog.count({ where: { actor_id: me.id, action: { in: ['access.denied', 'access.hidden'] } } })).toBe(0);
  });

  it('writes no row for a record that is not there', async () => {
    const { org } = await fx.newOrg();
    const me = await personWith(org, { view_estimates: true, jobs_scope: 'attached', leads_scope: 'attached' });

    const res = await (await me.api()).get('/api/estimates/00000000-0000-0000-0000-000000000000');
    expect(res.status).toBe(404);
    await new Promise((r) => setTimeout(r, 300));

    expect(await db.auditLog.count({ where: { actor_id: me.id, action: { in: ['access.denied', 'access.hidden'] } } })).toBe(0);
  });

  it('writes no row when a button probe says no inside a request that succeeds', async () => {
    const { org, customer } = await fx.newOrg();
    // Holds View jobs but not Delete jobs, so the job page's action list asks the delete question and answers no.
    const me = await personWith(org, { view_jobs: true, jobs_scope: 'all' });
    const job = await fx.addJob(org, customer, { crew: [me.id] });

    const res = await (await me.api()).get(`/api/jobs/${job.id}`);
    expect(res.status).toBe(200);
    expect(res.body.job.actions).not.toContain('delete');
    await new Promise((r) => setTimeout(r, 300));

    expect(await db.auditLog.count({ where: { actor_id: me.id, action: { in: ['access.denied', 'access.hidden'] } } })).toBe(0);
  });
});
