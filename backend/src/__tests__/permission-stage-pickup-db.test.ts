/* =============================================================================
   Roles & Permissions, PRD 7, slices S07.6 and S07.7 - "Taken by me" on a stage, saved on the server, and
   "Taken by..." recording a pickup for someone else.

   Everything goes through the staging routes, called as people on custom roles (never a built-in role name)
   holding exactly the switch values under test. Real migrated database (TEST_DATABASE_URL); the suite skips
   when it is unset. Every org it creates is removed again.
   ========================================================================== */

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
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

// The real emitters, watched: a pickup must raise no alert of its own and must not repeat "ready for pickup".
const alerts = vi.hoisted(() => ({ ready: vi.fn(), noArea: vi.fn() }));
vi.mock('../services/notifications/inventoryEmit', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../services/notifications/inventoryEmit')>();
  return {
    ...actual,
    emitStagingReady: (...args: Parameters<typeof actual.emitStagingReady>) => {
      alerts.ready(...args);
      return actual.emitStagingReady(...args);
    },
    emitStagingNoAreaIfNeeded: (...args: Parameters<typeof actual.emitStagingNoAreaIfNeeded>) => {
      alerts.noArea(...args);
      return actual.emitStagingNoAreaIfNeeded(...args);
    },
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

suite('Stage pickups follow their switches and the stage\'s reach (real database)', () => {
  const db = realClient as PrismaClient;
  const fx = switchFixture(db, async () => (await import('../app.js')).default as never);
  // Loading the whole app is slow on a loaded machine.
  beforeAll(async () => {
    await import('../app.js');
  }, 120_000);
  beforeEach(() => {
    alerts.ready.mockClear();
    alerts.noArea.mockClear();
  });

  const orgs: string[] = [];
  afterAll(async () => {
    const quietly = (p: Promise<unknown>) => p.catch(() => undefined);
    for (const org of orgs) {
      for (const table of ['stage_audit_entries', 'job_stage_attachments', 'job_stage_lines', 'job_stages']) {
        await quietly(db.$executeRawUnsafe(`DELETE FROM ${table} WHERE organization_id = '${org}'`));
      }
    }
    await fx.cleanup();
  });

  type Api = Awaited<ReturnType<typeof fx.signedInAs>>;
  let sequence = 0;

  async function newOrg() {
    const made = await fx.newOrg();
    orgs.push(made.org);
    return made;
  }

  /** A person on a fresh custom role holding exactly these switch values over everything else off. */
  async function personWith(
    org: string,
    values: Record<string, boolean | string>,
    base: Role = 'TECHNICIAN',
  ): Promise<Person & { api: () => Promise<Api> }> {
    const key = `stage-pickup-role-${++sequence}`;
    const role = await fx.addCustomRole(org, key, base);
    await setRoleSwitchValues({ organizationId: org, roleKey: key, values: { ...ALL_OFF, ...values }, actorId: null, reason: 'manual' });
    const person = await fx.addUser(org, `p${sequence}`, base, { customRoleId: role.id });
    return Object.assign(person, { api: () => fx.signedInAs(person) });
  }

  async function addStage(org: string, opts: { jobId?: string | null; assignedTo?: string; status?: string } = {}) {
    const id = randomUUID();
    await db.jobStage.create({
      data: {
        id, organization_id: org, job_id: opts.jobId ?? null, job_number: `J-${id.slice(0, 6)}`, customer: 'Pat Payer',
        site: '1 Test Way', trade: 'locksmith', status: opts.status ?? 'ready_for_pickup', assigned_tech_id: opts.assignedTo ?? null,
      },
    });
    return id;
  }

  const takenByMe = (api: Api, id: string) => api.post(`/api/inventory/job-stages/${id}/taken-by-me`);

  describe('who may take', () => {
    it('lets a person with Pick up staged items on and Edit stock off take a stage on a job they are attached to', async () => {
      const { org, customer } = await newOrg();
      const me = await personWith(org, { pick_up_staged_items: true, edit_stock: false });
      const job = await fx.addJob(org, customer, { crew: [me.id] });
      const stage = await addStage(org, { jobId: job.id });

      const res = await takenByMe(await me.api(), stage);

      expect(res.status).toBe(200);
      expect(res.body.jobStage.id).toBe(stage);
    });

    it('refuses a person with Pick up staged items off and Edit stock on, and leaves the stage untouched', async () => {
      const { org, customer } = await newOrg();
      const me = await personWith(org, { pick_up_staged_items: false, view_stock: true, edit_stock: true });
      const job = await fx.addJob(org, customer, { crew: [me.id] });
      const stage = await addStage(org, { jobId: job.id });

      const res = await takenByMe(await me.api(), stage);

      expect(res.status).toBe(403);
      const row = await db.jobStage.findUniqueOrThrow({ where: { id: stage } });
      expect(row.status).toBe('ready_for_pickup');
      expect(row.taken_at).toBeNull();
    });

    it('refuses a stage outside the person\'s reach, with the switch on', async () => {
      const { org, customer } = await newOrg();
      const me = await personWith(org, { pick_up_staged_items: true });
      const colleague = await fx.addUser(org, `colleague${++sequence}`, 'TECHNICIAN');
      const theirs = await fx.addJob(org, customer, { crew: [colleague.id] });
      const outside = await addStage(org, { jobId: theirs.id });

      const res = await takenByMe(await me.api(), outside);

      expect(res.status).toBe(404);
      expect((await db.jobStage.findUniqueOrThrow({ where: { id: outside } })).taken_at).toBeNull();
    });

    it('reaches a stage assigned to the person when they hold View stock', async () => {
      const { org } = await newOrg();
      const me = await personWith(org, { pick_up_staged_items: true, view_stock: true });
      const stage = await addStage(org, { assignedTo: me.id });

      expect((await takenByMe(await me.api(), stage)).status).toBe(200);
    });
  });

  describe('what the action saves', () => {
    it('shows Delivered to tech with the taker and the time after a reload, and the stage\'s history logs the pickup', async () => {
      const { org, customer } = await newOrg();
      const me = await personWith(org, { pick_up_staged_items: true });
      const job = await fx.addJob(org, customer, { crew: [me.id] });
      const stage = await addStage(org, { jobId: job.id });
      const api = await me.api();
      const before = Date.now();

      expect((await takenByMe(api, stage)).status).toBe(200);

      const reloaded = (await api.get(`/api/inventory/job-stages/${stage}`)).body.jobStage;
      expect(reloaded.status).toBe('delivered');
      expect(reloaded.takenById).toBe(me.id);
      expect(reloaded.takenByName).toBe(`p${sequence} Tester`);
      expect(reloaded.recordedById).toBe(me.id);
      expect(reloaded.recordedByName).toBe(reloaded.takenByName);
      const takenAt = new Date(reloaded.takenAt).getTime();
      expect(takenAt).toBeGreaterThanOrEqual(before - 1000);
      expect(takenAt).toBeLessThanOrEqual(Date.now() + 1000);

      const pickup = (reloaded.auditLog as { field: string; oldValue?: string; newValue: string; actorName: string; comment?: string }[])
        .find((e) => e.field === 'status');
      expect(pickup).toMatchObject({ oldValue: 'ready_for_pickup', newValue: 'delivered', actorName: reloaded.takenByName });
      expect(pickup?.comment).toBe(`Taken by ${reloaded.takenByName}`);
    });

    it('raises no alert: no repeat "ready for pickup" to the technician and none of its own', async () => {
      const { org, customer } = await newOrg();
      const me = await personWith(org, { pick_up_staged_items: true });
      const job = await fx.addJob(org, customer, { crew: [me.id] });
      const stage = await addStage(org, { jobId: job.id, assignedTo: me.id });
      const api = await me.api();

      expect((await takenByMe(api, stage)).status).toBe(200);

      expect(alerts.ready).not.toHaveBeenCalled();
      expect(alerts.noArea).not.toHaveBeenCalled();
    });

    it('does not let a second person overwrite a stage already taken', async () => {
      const { org, customer } = await newOrg();
      const first = await personWith(org, { pick_up_staged_items: true });
      const second = await personWith(org, { pick_up_staged_items: true });
      const job = await fx.addJob(org, customer, { crew: [first.id, second.id] });
      const stage = await addStage(org, { jobId: job.id });

      expect((await takenByMe(await first.api(), stage)).status).toBe(200);
      const again = await takenByMe(await second.api(), stage);

      expect(again.status).toBe(409);
      expect((await db.jobStage.findUniqueOrThrow({ where: { id: stage } })).taken_by_id).toBe(first.id);
    });

    it('leaves the alert path as it was: "Notify tech" still raises the ready alert (the watch can fail)', async () => {
      const { org, customer } = await newOrg();
      const me = await personWith(org, { edit_stock: true, view_stock: true });
      const job = await fx.addJob(org, customer, { crew: [me.id] });
      const stage = await addStage(org, { jobId: job.id, status: 'complete' });

      expect((await (await me.api()).post('/api/inventory/job-stages/notify', { stageId: stage })).status).toBe(200);

      expect(alerts.ready).toHaveBeenCalledTimes(1);
    });
  });

  describe('"Taken by..." (S07.7)', () => {
    const takenBy = (api: Api, id: string, takenById: string) => api.post(`/api/inventory/job-stages/${id}/taken-by`, { takenById });
    const peopleFor = (api: Api, id: string) => api.get(`/api/inventory/job-stages/${id}/pickup-people`);
    const nameOf = async (id: string) => {
      const u = await db.user.findUniqueOrThrow({ where: { id }, select: { first_name: true, last_name: true } });
      return `${u.first_name} ${u.last_name}`;
    };

    it('lets a person with Record pickup for someone else on, and Pick up staged items and Edit stock off, record a colleague\'s pickup', async () => {
      const { org, customer } = await newOrg();
      const recorder = await personWith(org, { record_pickup_for_someone_else: true, pick_up_staged_items: false, edit_stock: false });
      const colleague = await fx.addUser(org, `colleague${++sequence}`, 'TECHNICIAN');
      const job = await fx.addJob(org, customer, { crew: [recorder.id] });
      const stage = await addStage(org, { jobId: job.id });

      const res = await takenBy(await recorder.api(), stage, colleague.id);

      expect(res.status).toBe(200);
      expect(res.body.jobStage.status).toBe('delivered');
    });

    it('refuses a person with only Pick up staged items, and leaves the stage untouched', async () => {
      const { org, customer } = await newOrg();
      const me = await personWith(org, { pick_up_staged_items: true, record_pickup_for_someone_else: false, edit_stock: true, view_stock: true });
      const colleague = await fx.addUser(org, `colleague${++sequence}`, 'TECHNICIAN');
      const job = await fx.addJob(org, customer, { crew: [me.id] });
      const stage = await addStage(org, { jobId: job.id });
      const api = await me.api();

      expect((await takenBy(api, stage, colleague.id)).status).toBe(403);
      expect((await peopleFor(api, stage)).status).toBe(403);

      const row = await db.jobStage.findUniqueOrThrow({ where: { id: stage } });
      expect(row.status).toBe('ready_for_pickup');
      expect(row.taken_at).toBeNull();
    });

    it('refuses a stage outside the person\'s reach with the switch on, for the record and for the picker', async () => {
      const { org, customer } = await newOrg();
      const me = await personWith(org, { record_pickup_for_someone_else: true });
      const colleague = await fx.addUser(org, `colleague${++sequence}`, 'TECHNICIAN');
      const theirs = await fx.addJob(org, customer, { crew: [colleague.id] });
      const outside = await addStage(org, { jobId: theirs.id });
      const api = await me.api();

      expect((await takenBy(api, outside, colleague.id)).status).toBe(404);
      expect((await peopleFor(api, outside)).status).toBe(404);
      expect((await db.jobStage.findUniqueOrThrow({ where: { id: outside } })).taken_at).toBeNull();
    });

    it('saves the chosen person as the taker and the recorder as the person recording, and the history logs both', async () => {
      const { org, customer } = await newOrg();
      const recorder = await personWith(org, { record_pickup_for_someone_else: true });
      const taker = await fx.addUser(org, `taker${++sequence}`, 'TECHNICIAN');
      const job = await fx.addJob(org, customer, { crew: [recorder.id] });
      const stage = await addStage(org, { jobId: job.id });
      const api = await recorder.api();

      expect((await takenBy(api, stage, taker.id)).status).toBe(200);

      const reloaded = (await api.get(`/api/inventory/job-stages/${stage}`)).body.jobStage;
      expect(reloaded.status).toBe('delivered');
      expect(reloaded.takenById).toBe(taker.id);
      expect(reloaded.takenByName).toBe(await nameOf(taker.id));
      expect(reloaded.recordedById).toBe(recorder.id);
      expect(reloaded.recordedByName).toBe(await nameOf(recorder.id));
      expect(reloaded.takenByName).not.toBe(reloaded.recordedByName);
      expect(reloaded.takenAt).toBeTruthy();
      const pickup = (reloaded.auditLog as { field: string; actorName: string; comment?: string }[]).find((e) => e.field === 'status');
      expect(pickup?.actorName).toBe(reloaded.recordedByName);
      expect(pickup?.comment).toBe(`Taken by ${reloaded.takenByName}, recorded by ${reloaded.recordedByName}`);
    });

    it('records the person themself as the taker with no "recorded by" difference', async () => {
      const { org, customer } = await newOrg();
      const me = await personWith(org, { record_pickup_for_someone_else: true });
      const job = await fx.addJob(org, customer, { crew: [me.id] });
      const stage = await addStage(org, { jobId: job.id });
      const api = await me.api();

      expect((await takenBy(api, stage, me.id)).status).toBe(200);

      const row = await db.jobStage.findUniqueOrThrow({ where: { id: stage } });
      expect(row.taken_by_id).toBe(me.id);
      expect(row.recorded_by_id).toBe(me.id);
      const entry = await db.stageAuditEntry.findFirstOrThrow({ where: { job_stage_id: stage, field: 'status' } });
      expect(entry.comment).toBe(`Taken by ${row.taken_by_name}`);
    });

    it('raises no alert, and refuses a person who is inactive, in another company, or not a person at all', async () => {
      const { org, customer } = await newOrg();
      const other = await newOrg();
      const recorder = await personWith(org, { record_pickup_for_someone_else: true });
      const gone = await fx.addUser(org, `gone${++sequence}`, 'TECHNICIAN');
      await db.user.update({ where: { id: gone.id }, data: { is_active: false } });
      const stranger = await fx.addUser(other.org, `stranger${++sequence}`, 'TECHNICIAN');
      const job = await fx.addJob(org, customer, { crew: [recorder.id] });
      const stage = await addStage(org, { jobId: job.id });
      const api = await recorder.api();

      for (const takenById of [gone.id, stranger.id, randomUUID()]) {
        expect((await takenBy(api, stage, takenById)).status, takenById).toBe(400);
      }
      expect((await api.post(`/api/inventory/job-stages/${stage}/taken-by`, {})).status).toBe(400);
      expect((await db.jobStage.findUniqueOrThrow({ where: { id: stage } })).taken_at).toBeNull();

      const taker = await fx.addUser(org, `taker${++sequence}`, 'TECHNICIAN');
      expect((await takenBy(api, stage, taker.id)).status).toBe(200);
      expect(alerts.ready).not.toHaveBeenCalled();
      expect(alerts.noArea).not.toHaveBeenCalled();
    });

    it('does not overwrite a stage already taken', async () => {
      const { org, customer } = await newOrg();
      const recorder = await personWith(org, { record_pickup_for_someone_else: true });
      const first = await fx.addUser(org, `first${++sequence}`, 'TECHNICIAN');
      const second = await fx.addUser(org, `second${++sequence}`, 'TECHNICIAN');
      const job = await fx.addJob(org, customer, { crew: [recorder.id] });
      const stage = await addStage(org, { jobId: job.id });
      const api = await recorder.api();

      expect((await takenBy(api, stage, first.id)).status).toBe(200);
      expect((await takenBy(api, stage, second.id)).status).toBe(409);
      expect((await db.jobStage.findUniqueOrThrow({ where: { id: stage } })).taken_by_id).toBe(first.id);
    });

    it('lists only the company\'s active people for the picker, the stage\'s assigned person first', async () => {
      const { org, customer } = await newOrg();
      const other = await newOrg();
      const recorder = await personWith(org, { record_pickup_for_someone_else: true });
      const assigned = await fx.addUser(org, `zed${++sequence}`, 'TECHNICIAN');
      const retired = await fx.addUser(org, `retired${++sequence}`, 'TECHNICIAN');
      await db.user.update({ where: { id: retired.id }, data: { is_active: false } });
      const outsider = await fx.addUser(other.org, `outsider${++sequence}`, 'TECHNICIAN');
      const job = await fx.addJob(org, customer, { crew: [recorder.id] });
      const stage = await addStage(org, { jobId: job.id, assignedTo: assigned.id });

      const res = await peopleFor(await recorder.api(), stage);

      expect(res.status).toBe(200);
      const people = res.body.people as { id: string; name: string; assigned?: boolean }[];
      const ids = people.map((p) => p.id);
      expect(ids[0]).toBe(assigned.id);
      expect(people[0]!.assigned).toBe(true);
      expect(ids).toContain(recorder.id);
      expect(ids).not.toContain(retired.id);
      expect(ids).not.toContain(outsider.id);
      const everyone = await db.user.findMany({ where: { organization_id: org, is_active: true }, select: { id: true } });
      expect([...ids].sort()).toEqual(everyone.map((u) => u.id).sort());
      expect(Object.keys(people[0]!).sort()).toEqual(['assigned', 'id', 'name']);
    });

    it('lists the picker with no assigned person first when the stage has none, by name', async () => {
      const { org, customer } = await newOrg();
      const recorder = await personWith(org, { record_pickup_for_someone_else: true });
      const job = await fx.addJob(org, customer, { crew: [recorder.id] });
      const stage = await addStage(org, { jobId: job.id });

      const people = (await peopleFor(await recorder.api(), stage)).body.people as { name: string; assigned?: boolean }[];

      expect(people.some((p) => p.assigned)).toBe(false);
      const names = people.map((p) => p.name);
      expect(names).toEqual([...names].sort((a, b) => a.localeCompare(b)));
    });
  });
});
