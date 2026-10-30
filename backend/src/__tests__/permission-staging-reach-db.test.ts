/* =============================================================================
   Roles & Permissions, PRD 7, slice S07.3 - staging reach in the access resolver, with unit cost and vendor
   left out of stage lines.

   Everything goes through the staging routes, called as people on custom roles (never a built-in role name)
   holding exactly the switch values under test. Real migrated database (TEST_DATABASE_URL); the suite skips
   when it is unset. Every org it creates is removed again.
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

import { switchFixture, type Person } from './permission-switches-fixture';
import { setRoleSwitchValues } from '../lib/permissions/switches/store';
import { SWITCH_CATALOG, type SwitchValue } from '../lib/permissions/switches/catalog';

const suite = realClient ? describe : describe.skip;

/** Every switch in the catalog off (a choice at its first option, a list empty), so a case turns on exactly the ones it is about. */
const ALL_OFF: Record<string, SwitchValue> = Object.fromEntries(
  SWITCH_CATALOG.map((s) => [s.key, s.kind === 'choice' ? s.choices![0]! : s.kind === 'list' ? [] : false]),
);

const STAGE_BODY = {
  jobNumber: 'J-1', customer: 'Pat Payer', site: '1 Test Way', trade: 'locksmith', status: 'awaiting_parts',
};

suite('staging reach follows the record\'s people and the stock switches (real database)', () => {
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
    const key = `staging-reach-role-${++sequence}`;
    const role = await fx.addCustomRole(org, key, base);
    await setRoleSwitchValues({ organizationId: org, roleKey: key, values: { ...ALL_OFF, ...values }, actorId: null, reason: 'manual' });
    const person = await fx.addUser(org, `p${sequence}`, base, { customRoleId: role.id });
    // A send by hand goes out from the sender's own mailbox (PRD 10, S10.12).
    await fx.addUserMailbox(org, person);
    return Object.assign(person, { api: () => fx.signedInAs(person) });
  }

  async function addStage(
    org: string,
    opts: { jobId?: string | null; assignedTo?: string; unitCost?: number; vendor?: string; status?: string } = {},
  ) {
    const id = randomUUID();
    const lineId = randomUUID();
    await db.jobStage.create({
      data: {
        id, organization_id: org, job_id: opts.jobId ?? null, job_number: `J-${id.slice(0, 6)}`, customer: 'Pat Payer',
        site: '1 Test Way', trade: 'locksmith', status: opts.status ?? 'awaiting_parts', assigned_tech_id: opts.assignedTo ?? null,
        items: {
          create: [{
            id: lineId, organization_id: org, item_sku: 'LOCK-1', item_name: 'Deadbolt', uom: 'EA', qty_ordered: 2, qty_received: 0,
            unit_cost: opts.unitCost ?? 22.5, vendor: opts.vendor ?? 'Acme Supply',
          }],
        },
      },
    });
    return { id, lineId };
  }

  /** An org with two jobs: the person is on the crew of `mine`, `theirs` belongs to someone else. */
  async function orgWithJobs(values: Record<string, boolean | string>) {
    const { org, customer } = await newOrg();
    const me = await personWith(org, values);
    const colleague = await fx.addUser(org, `colleague${++sequence}`, 'TECHNICIAN');
    const mine = await fx.addJob(org, customer, { crew: [me.id] });
    const theirs = await fx.addJob(org, customer, { crew: [colleague.id] });
    return { org, customer, me, colleague, mine, theirs };
  }

  const idsOf = (body: { jobStages: { id: string }[] }) => body.jobStages.map((s) => s.id).sort();

  describe('an attached person with View stock off', () => {
    it('reads the stages of their own job, and gets nothing from the company-wide staging list', async () => {
      const { org, me, mine, theirs } = await orgWithJobs({});
      const onMine = await addStage(org, { jobId: mine.id });
      const onTheirs = await addStage(org, { jobId: theirs.id });
      const api = await me.api();

      const forJob = await api.get(`/api/inventory/job-stages?job_id=${mine.id}`);
      expect(forJob.status).toBe(200);
      expect(idsOf(forJob.body)).toEqual([onMine.id]);

      const company = await api.get('/api/inventory/job-stages');
      expect(company.status).toBe(403);
      expect(company.body.jobStages).toBeUndefined();

      expect((await api.get(`/api/inventory/job-stages/${onMine.id}`)).status).toBe(200);
      expect((await api.get(`/api/inventory/job-stages/${onTheirs.id}`)).status).toBe(404);
      const otherJob = await api.get(`/api/inventory/job-stages?job_id=${theirs.id}`);
      expect(otherJob.status).toBe(200);
      expect(otherJob.body.jobStages).toEqual([]);
    });

    it('reaches a stage through any people field of the job: Sold By, Dispatcher or the crew of a past visit', async () => {
      const { org, customer } = await newOrg();
      const soldBy = await personWith(org, {});
      const dispatcher = await personWith(org, {});
      const pastCrew = await personWith(org, {});
      const job = await fx.addJob(org, customer, { soldBy: soldBy.id, dispatcher: dispatcher.id, crew: [pastCrew.id], pastVisit: true });
      const stage = await addStage(org, { jobId: job.id });
      for (const person of [soldBy, dispatcher, pastCrew]) {
        const res = await (await person.api()).get(`/api/inventory/job-stages?job_id=${job.id}`);
        expect(res.status).toBe(200);
        expect(idsOf(res.body)).toEqual([stage.id]);
      }
    });
  });

  describe('a person with View stock on', () => {
    it('sees a stage on a job they can open, not one on another job, and one assigned to them', async () => {
      // Jobs scope Attached opens `mine` (on the crew) and not `theirs`.
      const openable = await orgWithJobs({ view_stock: true, view_jobs: true, jobs_scope: 'attached' });
      const onOpenable = await addStage(openable.org, { jobId: openable.mine.id });
      const onOther = await addStage(openable.org, { jobId: openable.theirs.id });
      const assigned = await addStage(openable.org, { jobId: openable.theirs.id, assignedTo: openable.me.id });
      const list = await (await openable.me.api()).get('/api/inventory/job-stages');
      expect(list.status).toBe(200);
      expect(idsOf(list.body)).toEqual([onOpenable.id, assigned.id].sort());
      expect(idsOf(list.body)).not.toContain(onOther.id);
    });

    it('reaches every job\'s stages, and a stage with no job, only with View jobs and Jobs scope All', async () => {
      const { org, me, mine, theirs } = await orgWithJobs({ view_stock: true, view_jobs: true, jobs_scope: 'all' });
      const a = await addStage(org, { jobId: mine.id });
      const b = await addStage(org, { jobId: theirs.id });
      const none = await addStage(org, { jobId: null });
      const list = await (await me.api()).get('/api/inventory/job-stages');
      expect(idsOf(list.body)).toEqual([a.id, b.id, none.id].sort());
    });

    it('does not reach a stage with no job on Jobs scope Attached or with View jobs off', async () => {
      for (const values of [
        { view_stock: true, view_jobs: true, jobs_scope: 'attached' },
        { view_stock: true, view_jobs: false, jobs_scope: 'all' },
      ]) {
        const { org, me, theirs } = await orgWithJobs(values);
        const none = await addStage(org, { jobId: null });
        const onTheirs = await addStage(org, { jobId: theirs.id });
        const api = await me.api();
        const list = await api.get('/api/inventory/job-stages');
        expect(idsOf(list.body), JSON.stringify(values)).toEqual([]);
        expect((await api.get(`/api/inventory/job-stages/${none.id}`)).status).toBe(404);
        expect((await api.get(`/api/inventory/job-stages/${onTheirs.id}`)).status).toBe(404);
      }
    });

    it('sees a stage assigned to them even on a job they cannot open', async () => {
      const { org, me, theirs } = await orgWithJobs({ view_stock: true, view_jobs: false });
      const assigned = await addStage(org, { jobId: theirs.id, assignedTo: me.id });
      const api = await me.api();
      expect(idsOf((await api.get('/api/inventory/job-stages')).body)).toEqual([assigned.id]);
      expect((await api.get(`/api/inventory/job-stages/${assigned.id}`)).status).toBe(200);
    });
  });

  describe('a person assigned a stage with View stock off', () => {
    it('sees it only on a job they are attached to', async () => {
      const { org, me, mine, theirs } = await orgWithJobs({});
      const onMine = await addStage(org, { jobId: mine.id, assignedTo: me.id });
      const onTheirs = await addStage(org, { jobId: theirs.id, assignedTo: me.id });
      const api = await me.api();
      expect((await api.get(`/api/inventory/job-stages/${onMine.id}`)).status).toBe(200);
      expect((await api.get(`/api/inventory/job-stages/${onTheirs.id}`)).status).toBe(404);
      expect((await api.get(`/api/inventory/job-stages?job_id=${theirs.id}`)).body.jobStages).toEqual([]);
    });
  });

  it('drops a stage on the next request once the person is taken off the job, unless their switches still reach it', async () => {
    for (const [values, stillReached] of [
      [{}, false],
      [{ view_stock: true, view_jobs: true, jobs_scope: 'attached' }, false],
      [{ view_stock: true, view_jobs: true, jobs_scope: 'all' }, true],
    ] as const) {
      const { org, customer } = await newOrg();
      const me = await personWith(org, values);
      const job = await fx.addJob(org, customer, { crew: [me.id] });
      const stage = await addStage(org, { jobId: job.id });
      const api = await me.api();
      expect((await api.get(`/api/inventory/job-stages/${stage.id}`)).status, JSON.stringify(values)).toBe(200);

      await fx.removeCrew(job.visitId!, me.id);
      const after = await api.get(`/api/inventory/job-stages/${stage.id}`);
      expect(after.status === 200, JSON.stringify(values)).toBe(stillReached);
      if (values.view_stock) expect(idsOf((await api.get('/api/inventory/job-stages')).body).includes(stage.id)).toBe(stillReached);
    }
  });

  describe('stage lines', () => {
    it('carry unit cost only with See financial data, and the vendor name only with View vendors', async () => {
      const cases: { values: Record<string, boolean>; cost: boolean; vendor: boolean }[] = [
        { values: {}, cost: false, vendor: false },
        { values: { see_financial_data: true }, cost: true, vendor: false },
        { values: { view_vendors: true }, cost: false, vendor: true },
        { values: { see_financial_data: true, view_vendors: true }, cost: true, vendor: true },
      ];
      for (const c of cases) {
        const { org, me, mine } = await orgWithJobs({ view_stock: true, view_jobs: true, ...c.values });
        const stage = await addStage(org, { jobId: mine.id, unitCost: 22.5, vendor: 'Acme Supply' });
        const api = await me.api();
        for (const path of [`/api/inventory/job-stages?job_id=${mine.id}`, '/api/inventory/job-stages']) {
          const body = (await api.get(path)).body;
          const line = body.jobStages.find((s: { id: string }) => s.id === stage.id).items[0];
          expect('unitCost' in line, `${path} ${JSON.stringify(c.values)} cost`).toBe(c.cost);
          expect('vendor' in line, `${path} ${JSON.stringify(c.values)} vendor`).toBe(c.vendor);
          if (c.cost) expect(line.unitCost).toBe(22.5);
          if (c.vendor) expect(line.vendor).toBe('Acme Supply');
        }
        const one = (await api.get(`/api/inventory/job-stages/${stage.id}`)).body.jobStage.items[0];
        expect('unitCost' in one).toBe(c.cost);
        expect('vendor' in one).toBe(c.vendor);
      }
    });

    it('are stripped for an attached person with View stock off as well', async () => {
      const { org, me, mine } = await orgWithJobs({});
      const stage = await addStage(org, { jobId: mine.id });
      const line = (await (await me.api()).get(`/api/inventory/job-stages/${stage.id}`)).body.jobStage.items[0];
      expect('unitCost' in line).toBe(false);
      expect('vendor' in line).toBe(false);
    });
  });

  describe('stage writes', () => {
    it('create a stage only with Create stock, and only on a job the person reaches', async () => {
      const { org, me, mine, theirs } = await orgWithJobs({ view_stock: true, view_jobs: true, create_stock: true });
      const api = await me.api();

      const own = await api.post('/api/inventory/job-stages', { ...STAGE_BODY, jobId: mine.id });
      expect(own.status).toBe(201);
      const other = await api.post('/api/inventory/job-stages', { ...STAGE_BODY, jobId: theirs.id });
      expect(other.status).toBe(403);
      const noJob = await api.post('/api/inventory/job-stages', { ...STAGE_BODY });
      expect(noJob.status).toBe(403);
      expect(await db.jobStage.count({ where: { organization_id: org } })).toBe(1);

      const without = await personWith(org, { view_stock: true, view_jobs: true });
      const refused = await (await without.api()).post('/api/inventory/job-stages', { ...STAGE_BODY, jobId: mine.id });
      expect(refused.status).toBe(403);
    });

    it('create a stage on any job and with no job for Jobs scope All', async () => {
      const { org, me, theirs } = await orgWithJobs({ view_stock: true, view_jobs: true, jobs_scope: 'all', create_stock: true });
      const api = await me.api();
      expect((await api.post('/api/inventory/job-stages', { ...STAGE_BODY, jobId: theirs.id })).status).toBe(201);
      expect((await api.post('/api/inventory/job-stages', { ...STAGE_BODY })).status).toBe(201);
      expect(await db.jobStage.count({ where: { organization_id: org } })).toBe(2);
    });

    it('edit, receive, notify, email and attachments need Edit stock, and are refused on a stage outside reach even with it', async () => {
      const editor = await orgWithJobs({ view_stock: true, view_jobs: true, jobs_scope: 'attached', edit_stock: true });
      const viewer = await personWith(editor.org, { view_stock: true, view_jobs: true, jobs_scope: 'attached' });
      // The viewer is on the crew of `mine` too, so the only thing separating the two is Edit stock.
      await db.visitAssignee.create({ data: { visit_id: editor.mine.visitId!, user_id: viewer.id, organization_id: editor.org } });
      const inside = await addStage(editor.org, { jobId: editor.mine.id });
      const outside = await addStage(editor.org, { jobId: editor.theirs.id });

      const calls = (stage: { id: string; lineId: string }) => [
        (api: Api) => api.patch(`/api/inventory/job-stages/${stage.id}`, { notes: 'changed' }),
        (api: Api) => api.post('/api/inventory/job-stages/receive', { stageId: stage.id, itemId: stage.lineId }),
        (api: Api) => api.post('/api/inventory/job-stages/notify', { stageId: stage.id }),
        (api: Api) => api.post('/api/inventory/job-stages/email', { stageId: stage.id, to: ['delivered@resend.dev'], subject: 'Pickup' }),
        (api: Api) => api.post(`/api/inventory/job-stages/${stage.id}/attachments`),
      ];

      // Signing in swaps the one mocked identity, so each person signs in again right before their calls.
      const viewerApi = await viewer.api();
      for (const call of calls(inside)) {
        // Without Edit stock the switch refuses first.
        expect((await call(viewerApi)).status).toBe(403);
      }
      const editorApi = await editor.me.api();
      for (const call of calls(outside)) {
        // With Edit stock, a stage outside reach is not there for the person.
        expect((await call(editorApi)).status).toBe(404);
      }
      expect((await db.jobStage.findUnique({ where: { id: outside.id } }))!.notes).toBeNull();
      expect((await db.jobStage.findUnique({ where: { id: outside.id } }))!.status).toBe('awaiting_parts');
      for (const call of calls(inside)) {
        // Inside reach the call gets past the reach check (whatever else it then needs).
        expect([403, 404], 'inside reach').not.toContain((await call(editorApi)).status);
      }
      expect((await db.jobStage.findUnique({ where: { id: inside.id } }))!.notes).toBe('changed');
    });

    it('delete a stage attachment only on a stage inside reach', async () => {
      const { org, me, mine, theirs } = await orgWithJobs({ view_stock: true, view_jobs: true, edit_stock: true });
      const attach = async (stageId: string) => (await db.jobStageAttachment.create({
        data: { job_stage_id: stageId, organization_id: org, kind: 'image', data_url: 'data:image/png;base64,AA==', uploaded_at: new Date(), uploaded_by: 'Test' },
      })).id;
      const inside = await addStage(org, { jobId: mine.id });
      const outside = await addStage(org, { jobId: theirs.id });
      const insideAttachment = await attach(inside.id);
      const outsideAttachment = await attach(outside.id);
      const api = await me.api();
      expect((await api.delete(`/api/inventory/job-stages/${outside.id}/attachments/${outsideAttachment}`)).status).toBe(404);
      expect(await db.jobStageAttachment.count({ where: { id: outsideAttachment } })).toBe(1);
      expect((await api.delete(`/api/inventory/job-stages/${inside.id}/attachments/${insideAttachment}`)).status).toBe(200);
    });

    it('refuses moving a stage onto a job outside reach, and takes it onto a job inside reach', async () => {
      const { org, me, mine, theirs } = await orgWithJobs({ view_stock: true, view_jobs: true, edit_stock: true });
      const stage = await addStage(org, { jobId: mine.id });
      const api = await me.api();
      expect((await api.patch(`/api/inventory/job-stages/${stage.id}`, { jobId: theirs.id })).status).toBe(403);
      expect((await db.jobStage.findUnique({ where: { id: stage.id } }))!.job_id).toBe(mine.id);
      const another = await fx.addJob(org, (await db.job.findUniqueOrThrow({ where: { id: mine.id } })).customer_id!, { crew: [me.id] });
      expect((await api.patch(`/api/inventory/job-stages/${stage.id}`, { jobId: another.id })).status).toBe(200);
    });
  });
});
