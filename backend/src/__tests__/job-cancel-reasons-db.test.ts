/* =============================================================================
   Roles & Permissions, PRD 6, slice S06.14 - the job cancel-reasons list and its settings routes.

   Everything goes through the public interface: the routes, called as people on custom roles (never a built-in
   role name) holding exactly the switch values under test, plus the module's exported "what does this org offer"
   functions that the cancel move (S06.15) reads. Real migrated database (TEST_DATABASE_URL); the suite skips when
   it is unset. Every org it creates is removed again.

   The expected built-in wording is the PRD's own list, written out here as literals: the test must not copy the
   module's constant.
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

import { switchFixture, type Person } from './permission-switches-fixture';
import { setRoleSwitchValues } from '../lib/permissions/switches/store';
import { SWITCH_CATALOG } from '../lib/permissions/switches/catalog';

const suite = realClient ? describe : describe.skip;

/** The PRD's six built-ins, in the order they are offered. */
const PRD_BUILT_INS = [
  'Customer backed out',
  'Went with a competitor',
  'Price',
  'Could not do the work',
  'Duplicate job',
  'Other',
];

suite('Job cancel reasons: list, edits, tenancy, and independence from the estimate decline reasons (real database)', () => {
  const db = realClient as PrismaClient;
  const fx = switchFixture(db, async () => (await import('../app.js')).default as never);
  beforeAll(async () => {
    await import('../app.js');
  }, 120_000);
  afterAll(async () => {
    await fx.cleanup();
  });

  type Api = Awaited<ReturnType<typeof fx.signedInAs>>;
  let sequence = 0;

  /** A person on a fresh custom role made from blank, holding exactly these switch values. */
  async function personWith(org: string, values: Record<string, boolean | string>): Promise<Person & { api: () => Promise<Api> }> {
    const key = `cancel-reasons-role-${++sequence}`;
    const role = await fx.addCustomRole(org, key, 'TECHNICIAN', { madeFromBlank: true, copyGrants: false });
    const allOff = Object.fromEntries(SWITCH_CATALOG.filter((s) => s.kind === 'toggle').map((s) => [s.key, false]));
    await setRoleSwitchValues({ organizationId: org, roleKey: key, values: { ...allOff, ...values }, actorId: null, reason: 'manual' });
    const person = await fx.addUser(org, `p${sequence}`, 'TECHNICIAN', { customRoleId: role.id });
    return Object.assign(person, { api: () => fx.signedInAs(person) });
  }

  /** A person who may edit the company's settings: its Admin (setting up the company is the Admin flag's alone, 36b). */
  async function editor(org: string): Promise<Api> {
    const admin = await db.user.findFirstOrThrow({ where: { organization_id: org, is_admin: true }, select: { id: true, email: true } });
    return fx.signedInAs(admin);
  }

  const labels = (body: { job_cancel_reasons: { label: string }[] }) => body.job_cancel_reasons.map((r) => r.label);

  describe('an org that never edited the list', () => {
    it('gets the six built-ins, in order, for every signed-in person', async () => {
      const { org } = await fx.newOrg();
      const nobody = await (await personWith(org, {})).api();
      const res = await nobody.get('/api/job-cancel-reasons');
      expect(res.status).toBe(200);
      expect(labels(res.body)).toEqual(PRD_BUILT_INS);
      expect(res.body.job_cancel_reasons.every((r: { is_active: boolean }) => r.is_active)).toBe(true);
    });

    it('writes nothing just by being read', async () => {
      const { org } = await fx.newOrg();
      await (await (await personWith(org, {})).api()).get('/api/job-cancel-reasons');
      expect(await db.jobCancelReasonOption.count({ where: { organization_id: org } })).toBe(0);
    });

    it('is refused to a person who is not signed in', async () => {
      const server = (await import('../app.js')).default as never;
      const request = (await import('supertest')).default;
      expect((await request(server).get('/api/job-cancel-reasons')).status).toBe(401);
    });
  });

  describe('editing the list', () => {
    it('renames a built-in; the first edit writes the org\'s own copy of all six and keeps the code', async () => {
      const { org } = await fx.newOrg();
      const api = await editor(org);
      const before = (await api.get('/api/job-cancel-reasons')).body.job_cancel_reasons as { code: string; label: string }[];
      const price = before.find((r) => r.label === 'Price')!;

      const renamed = await api.patch(`/api/job-cancel-reasons/${price.code}`, { label: 'Too expensive' });
      expect(renamed.status).toBe(200);
      expect(renamed.body.job_cancel_reason).toMatchObject({ code: price.code, label: 'Too expensive' });

      const after = await api.get('/api/job-cancel-reasons');
      expect(labels(after.body)).toEqual(PRD_BUILT_INS.map((l) => (l === 'Price' ? 'Too expensive' : l)));
      expect(await db.jobCancelReasonOption.count({ where: { organization_id: org } })).toBe(6);
    });

    it('adds a reason of its own at the end, under a code derived from its words', async () => {
      const { org } = await fx.newOrg();
      const api = await editor(org);
      const added = await api.post('/api/job-cancel-reasons', { label: 'Permit refused' });
      expect(added.status).toBe(201);
      expect(added.body.job_cancel_reason).toMatchObject({ code: 'PERMIT_REFUSED', label: 'Permit refused', is_active: true });
      const list = await api.get('/api/job-cancel-reasons');
      expect(labels(list.body)).toEqual([...PRD_BUILT_INS, 'Permit refused']);
      // The same words again are one reason, not two.
      expect((await api.post('/api/job-cancel-reasons', { label: 'permit refused' })).status).toBe(409);
    });

    it('reorders the whole list', async () => {
      const { org } = await fx.newOrg();
      const api = await editor(org);
      const codes = ((await api.get('/api/job-cancel-reasons')).body.job_cancel_reasons as { code: string }[]).map((r) => r.code);
      const reversed = [...codes].reverse();
      expect((await api.post('/api/job-cancel-reasons/reorder', { ordered_codes: reversed })).status).toBe(204);
      const list = await api.get('/api/job-cancel-reasons');
      expect(list.body.job_cancel_reasons.map((r: { code: string }) => r.code)).toEqual(reversed);
      // A partial list is refused whole.
      expect((await api.post('/api/job-cancel-reasons/reorder', { ordered_codes: reversed.slice(1) })).status).toBe(400);
    });

    it('turns a reason off and back on', async () => {
      const { org } = await fx.newOrg();
      const api = await editor(org);
      const dup = ((await api.get('/api/job-cancel-reasons')).body.job_cancel_reasons as { code: string; label: string }[]).find(
        (r) => r.label === 'Duplicate job',
      )!;
      const off = await api.patch(`/api/job-cancel-reasons/${dup.code}`, { is_active: false });
      expect(off.status).toBe(200);
      expect(off.body.job_cancel_reason.is_active).toBe(false);
      // The management view still lists it, so it can be turned back on.
      const list = await api.get('/api/job-cancel-reasons');
      expect(list.body.job_cancel_reasons.find((r: { code: string }) => r.code === dup.code).is_active).toBe(false);
      const on = await api.patch(`/api/job-cancel-reasons/${dup.code}`, { is_active: true });
      expect(on.body.job_cancel_reason.is_active).toBe(true);
    });

    it('refuses turning Other off, and leaves an org that had not edited untouched', async () => {
      const { org } = await fx.newOrg();
      const api = await editor(org);
      const other = ((await api.get('/api/job-cancel-reasons')).body.job_cancel_reasons as { code: string; label: string }[]).find(
        (r) => r.label === 'Other',
      )!;
      const res = await api.patch(`/api/job-cancel-reasons/${other.code}`, { is_active: false });
      expect(res.status).toBe(400);
      expect(await db.jobCancelReasonOption.count({ where: { organization_id: org } })).toBe(0);
      // Renaming Other is fine.
      expect((await api.patch(`/api/job-cancel-reasons/${other.code}`, { label: 'Something else' })).status).toBe(200);
    });
  });

  describe('who may edit', () => {
    it('lets the Admin in and refuses a custom role holding every other switch', async () => {
      const { org } = await fx.newOrg();
      // Signing in swaps who the auth layer sees, so each call signs in fresh.
      const everything = Object.fromEntries(SWITCH_CATALOG.filter((s) => s.kind === 'toggle').map((s) => [s.key, true]));
      const off = await personWith(org, everything);

      const code = 'PRICE';
      const calls: [string, (api: Api) => ReturnType<Api['get']>][] = [
        ['add', (api) => api.post('/api/job-cancel-reasons', { label: 'Weather' })],
        ['rename', (api) => api.patch(`/api/job-cancel-reasons/${code}`, { label: 'Cost' })],
        ['reorder', (api) => api.post('/api/job-cancel-reasons/reorder', { ordered_codes: ['PRICE'] })],
      ];
      for (const [name, call] of calls) {
        expect((await call(await off.api())).status, `${name} as a non-Admin`).toBe(403);
      }
      // Nothing the refused calls did reached the list.
      expect(await db.jobCancelReasonOption.count({ where: { organization_id: org } })).toBe(0);
      for (const [name, call] of calls.slice(0, 2)) {
        const status = (await call(await editor(org))).status;
        expect(status, `${name} as the Admin`).toBeLessThan(300);
      }
    });
  });

  describe('the estimate decline reasons are a separate list', () => {
    it('editing the job list leaves the estimate decline reasons unchanged', async () => {
      const { org } = await fx.newOrg();
      const api = await editor(org);
      const declineBefore = (await api.get('/api/lost-reason-options')).body;
      expect((await api.patch('/api/job-cancel-reasons/PRICE', { label: 'Job price' })).status).toBe(200);
      expect((await api.post('/api/job-cancel-reasons', { label: 'Weather' })).status).toBe(201);
      expect((await api.get('/api/lost-reason-options')).body).toEqual(declineBefore);
      expect(await db.lostReasonOption.count({ where: { organization_id: org } })).toBe(0);
    });

    it('editing the estimate decline reasons leaves the job list unchanged', async () => {
      const { org } = await fx.newOrg();
      const api = await editor(org);
      const jobBefore = (await api.get('/api/job-cancel-reasons')).body;
      expect((await api.patch('/api/lost-reason-options/PRICE', { label: 'Estimate price' })).status).toBe(200);
      expect((await api.post('/api/lost-reason-options', { label: 'Designer' })).status).toBe(201);
      expect((await api.get('/api/job-cancel-reasons')).body).toEqual(jobBefore);
      expect(await db.jobCancelReasonOption.count({ where: { organization_id: org } })).toBe(0);
    });
  });

  describe('one org\'s reasons never reach another org', () => {
    it('does not offer a reason added in org A to org B', async () => {
      const a = await fx.newOrg();
      const b = await fx.newOrg();
      const apiA = await editor(a.org);
      expect((await apiA.post('/api/job-cancel-reasons', { label: 'Permit refused' })).status).toBe(201);
      expect((await apiA.patch('/api/job-cancel-reasons/PRICE', { label: 'Too dear' })).status).toBe(200);

      const apiB = await editor(b.org);
      expect(labels((await apiB.get('/api/job-cancel-reasons')).body)).toEqual(PRD_BUILT_INS);
    });

    it('does not accept org A\'s code from org B: rename and reorder find nothing, and the cancel move\'s check says no', async () => {
      const a = await fx.newOrg();
      const b = await fx.newOrg();
      const apiA = await editor(a.org);
      expect((await apiA.post('/api/job-cancel-reasons', { label: 'Permit refused' })).status).toBe(201);

      const apiB = await editor(b.org);
      expect((await apiB.patch('/api/job-cancel-reasons/PERMIT_REFUSED', { label: 'Mine now' })).status).toBe(404);
      const codesB = ((await apiB.get('/api/job-cancel-reasons')).body.job_cancel_reasons as { code: string }[]).map((r) => r.code);
      const smuggled = [...codesB.slice(1), 'PERMIT_REFUSED'];
      expect((await apiB.post('/api/job-cancel-reasons/reorder', { ordered_codes: smuggled })).status).toBe(400);
      expect(await db.jobCancelReasonOption.count({ where: { organization_id: b.org } })).toBe(0);

      const { isOfferedJobCancelReason, resolveOfferedJobCancelReasons } = await import('../lib/jobCancelReasons.js');
      expect(await isOfferedJobCancelReason(a.org, 'PERMIT_REFUSED')).toBe(true);
      expect(await isOfferedJobCancelReason(b.org, 'PERMIT_REFUSED')).toBe(false);
      expect((await resolveOfferedJobCancelReasons(b.org)).map((r) => r.label)).toEqual(PRD_BUILT_INS);
    });

    it('offers only active reasons to the cancel move, and still answers for an org that never edited', async () => {
      const { org } = await fx.newOrg();
      const { isOfferedJobCancelReason, resolveOfferedJobCancelReasons } = await import('../lib/jobCancelReasons.js');
      expect((await resolveOfferedJobCancelReasons(org)).map((r) => r.label)).toEqual(PRD_BUILT_INS);

      const api = await editor(org);
      const dup = ((await api.get('/api/job-cancel-reasons')).body.job_cancel_reasons as { code: string; label: string }[]).find(
        (r) => r.label === 'Duplicate job',
      )!;
      expect(await isOfferedJobCancelReason(org, dup.code)).toBe(true);
      await api.patch(`/api/job-cancel-reasons/${dup.code}`, { is_active: false });
      expect(await isOfferedJobCancelReason(org, dup.code)).toBe(false);
      expect((await resolveOfferedJobCancelReasons(org)).map((r) => r.label)).toEqual(PRD_BUILT_INS.filter((l) => l !== 'Duplicate job'));
    });
  });
});
