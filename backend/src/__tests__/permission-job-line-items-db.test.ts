/* =============================================================================
   Roles & Permissions, PRD 4, slice S04.14 - a job's line items follow Edit job line items alone, and a job's discount
   follows Apply discounts.

   The job answer carries `actions`, what THIS person may do on THIS job. The Items tab draws line editing from the
   `edit_line_items` entry, so a person who created and sold a job but holds no Edit job line items does not see it, and
   a holder who neither created nor sold the job does. A discount on the job needs Apply discounts as well as the line
   items switch, so the Technician preset (lines on, discounts off) prices a job but never discounts it.

   Everything goes through the public interface: the job routes, called as people on custom roles (never a built-in
   role name) holding exactly the switch values under test. Real migrated database (TEST_DATABASE_URL); the suite
   skips when it is unset. Every org it creates is removed again.
   ========================================================================== */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
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
import { SWITCH_CATALOG, presetSwitchSet, type SwitchValue } from '../lib/permissions/switches/catalog';

const suite = realClient ? describe : describe.skip;

/** Every switch in the catalog off (a choice at its first option, a list empty), so a case turns on exactly the ones it is about. */
const ALL_OFF: Record<string, SwitchValue> = Object.fromEntries(
  SWITCH_CATALOG.map((s) => [s.key, s.kind === 'choice' ? s.choices![0]! : s.kind === 'list' ? [] : false]),
);

/** What opening a job takes, with no action switch on. */
const OPENING = { view_jobs: true, jobs_scope: 'all' };

suite('job line items follow Edit job line items alone, a job discount follows Apply discounts (real database)', () => {
  const db = realClient as PrismaClient;
  const fx = switchFixture(db, async () => (await import('../app.js')).default as never);
  // Loading the whole app is slow on a loaded machine.
  beforeAll(async () => {
    await import('../app.js');
  }, 120_000);
  afterAll(() => fx.cleanup());

  type Api = Awaited<ReturnType<typeof fx.signedInAs>>;
  let sequence = 0;

  /** A person on a fresh custom role of this base holding exactly these switch values over everything else off. */
  async function personWith(
    org: string,
    values: Record<string, SwitchValue>,
    base: Role = 'DISPATCHER',
  ): Promise<Person & { api: () => Promise<Api> }> {
    const key = `job-line-items-role-${++sequence}`;
    const role = await fx.addCustomRole(org, key, base);
    await setRoleSwitchValues({ organizationId: org, roleKey: key, values: { ...ALL_OFF, ...values }, actorId: null, reason: 'manual' });
    const person = await fx.addUser(org, `p${sequence}`, base, { customRoleId: role.id });
    return Object.assign(person, { api: () => fx.signedInAs(person) });
  }

  async function actionsOn(api: Api, jobId: string): Promise<string[]> {
    const res = await api.get(`/api/jobs/${jobId}`);
    expect(res.status).toBe(200);
    return res.body.job.actions;
  }

  const newLine = { description: 'Hinge', quantity: 1, unit_price: 10 };
  const linesOf = (jobId: string) => db.jobLineItem.count({ where: { job_id: jobId } });
  const discountOf = async (jobId: string) => {
    const job = await db.job.findUniqueOrThrow({ where: { id: jobId }, select: { discount_type: true, discount_value: true } });
    return { type: job.discount_type, value: job.discount_value == null ? null : Number(job.discount_value) };
  };

  describe('the Items tab answer (edit_line_items)', () => {
    it("is not listed for a job's creator who is its Sold By and holds no Edit job line items, and the line routes refuse them", async () => {
      const { org, customer } = await fx.newOrg();
      for (const base of ['TECHNICIAN', 'DISPATCHER'] as const) {
        const me = await personWith(org, OPENING, base);
        const api = await me.api();
        const job = await fx.addJob(org, customer, { createdBy: me.id, soldBy: me.id, crew: [me.id] });
        expect(await actionsOn(api, job.id), base).not.toContain('edit_line_items');
        expect((await api.post(`/api/jobs/${job.id}/line-items`, newLine)).status, base).toBe(403);
        expect(await linesOf(job.id), base).toBe(0);
      }
    });

    it('is listed for a holder on a job they can open but neither created nor sold, and the line routes let them in', async () => {
      const { org, customer, admin } = await fx.newOrg();
      for (const base of ['TECHNICIAN', 'SALES', 'DISPATCHER'] as const) {
        const me = await personWith(org, { ...OPENING, edit_job_line_items: true }, base);
        const api = await me.api();
        const job = await fx.addJob(org, customer, { createdBy: admin.id, soldBy: admin.id, crew: [me.id] });
        expect(await actionsOn(api, job.id), base).toEqual(['edit_line_items']);
        expect((await api.post(`/api/jobs/${job.id}/line-items`, newLine)).status, base).toBe(201);
      }
    });

    it('is not listed on a job outside the holder\'s Jobs scope', async () => {
      const { org, customer, admin } = await fx.newOrg();
      const me = await personWith(org, { view_jobs: true, jobs_scope: 'attached', edit_job_line_items: true }, 'TECHNICIAN');
      const mine = await fx.addJob(org, customer, { crew: [me.id] });
      const theirs = await fx.addJob(org, customer, { crew: [admin.id] });
      const api = await me.api();
      expect(await actionsOn(api, mine.id)).toEqual(['edit_line_items']);
      expect([403, 404]).toContain((await api.get(`/api/jobs/${theirs.id}`)).status);
    });

    it('is listed with the Technician preset values, which hold Edit job line items and not Apply discounts', async () => {
      const { org, customer } = await fx.newOrg();
      const me = await personWith(org, presetSwitchSet('TECHNICIAN'), 'TECHNICIAN');
      const job = await fx.addJob(org, customer, { crew: [me.id] });
      const actions = await actionsOn(await me.api(), job.id);
      expect(actions).toContain('edit_line_items');
      expect(actions).not.toContain('apply_discount');
    });

    it('lists neither line editing nor a discount with Edit job line items and Apply discounts both off', async () => {
      const { org, customer } = await fx.newOrg();
      const me = await personWith(org, OPENING, 'DISPATCHER');
      const job = await fx.addJob(org, customer, { createdBy: me.id, soldBy: me.id, crew: [me.id] });
      const actions = await actionsOn(await me.api(), job.id);
      expect(actions).not.toContain('edit_line_items');
      expect(actions).not.toContain('apply_discount');
    });

    it('lists a discount only for a person holding both Edit job line items and Apply discounts', async () => {
      const { org, customer } = await fx.newOrg();
      const job = await fx.addJob(org, customer, {});
      const both = await personWith(org, { ...OPENING, edit_job_line_items: true, apply_discounts: true });
      const discountsOnly = await personWith(org, { ...OPENING, apply_discounts: true });
      expect(await actionsOn(await both.api(), job.id)).toEqual(['edit_line_items', 'apply_discount']);
      expect(await actionsOn(await discountsOnly.api(), job.id)).toEqual([]);
    });
  });

  describe('a discount on the job (PATCH)', () => {
    // The job update route also needs Edit jobs; every person here holds it so the case is about the discount alone.
    const EDITING = { ...OPENING, edit_jobs: true };

    it('is refused with Edit job line items on and Apply discounts off, while a tax rate edit goes through', async () => {
      const { org, customer } = await fx.newOrg();
      const me = await personWith(org, { ...EDITING, edit_job_line_items: true, apply_discounts: false });
      const api = await me.api();
      const job = await fx.addJob(org, customer, { crew: [me.id] });
      const refused = await api.patch(`/api/jobs/${job.id}`, { discount_type: 'PERCENTAGE', discount_value: 10 });
      expect(refused.status).toBe(403);
      expect(refused.body.error).toBe('You do not have permission to apply discounts.');
      expect(await discountOf(job.id)).toEqual({ type: null, value: null });
      expect((await api.patch(`/api/jobs/${job.id}`, { tax_rate: 0.05 })).status).toBe(200);
    });

    it('goes through with both Edit job line items and Apply discounts on', async () => {
      const { org, customer } = await fx.newOrg();
      const me = await personWith(org, { ...EDITING, edit_job_line_items: true, apply_discounts: true });
      const api = await me.api();
      const job = await fx.addJob(org, customer, { crew: [me.id] });
      const res = await api.patch(`/api/jobs/${job.id}`, { discount_type: 'PERCENTAGE', discount_value: 10 });
      expect(res.status).toBe(200);
      expect(await discountOf(job.id)).toEqual({ type: 'PERCENTAGE', value: 10 });
    });

    it('lets a round trip that leaves the stored discount alone through without Apply discounts', async () => {
      const { org, customer } = await fx.newOrg();
      const holder = await personWith(org, { ...EDITING, edit_job_line_items: true, apply_discounts: true });
      const me = await personWith(org, { ...EDITING, edit_job_line_items: true, apply_discounts: false });
      const job = await fx.addJob(org, customer, { crew: [me.id] });
      await (await holder.api()).patch(`/api/jobs/${job.id}`, { discount_type: 'PERCENTAGE', discount_value: 10 });
      const echoed = await (await me.api()).patch(`/api/jobs/${job.id}`, { tax_rate: 0.05, discount_type: 'PERCENTAGE', discount_value: 10 });
      expect(echoed.status).toBe(200);
      const changed = await (await me.api()).patch(`/api/jobs/${job.id}`, { discount_value: 25 });
      expect(changed.status).toBe(403);
      expect(await discountOf(job.id)).toEqual({ type: 'PERCENTAGE', value: 10 });
    });
  });
});
