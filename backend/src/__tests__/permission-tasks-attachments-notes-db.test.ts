/* =============================================================================
   Roles & Permissions, PRD 1, slice S01.11 - tasks, attachments and notes follow switches, and "See all
   tasks" replaces the Admin role check on tasks.

   Everything goes through the public interface: the routes, called as people on custom roles (never a built-in
   role name) holding exactly the switch values under test. Real migrated database (TEST_DATABASE_URL); the
   suite skips when it is unset. Every org it creates is removed again.
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
import { SWITCH_CATALOG, findSwitch } from '../lib/permissions/switches/catalog';

const suite = realClient ? describe : describe.skip;

suite('tasks, attachments and notes follow switches (real database)', () => {
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
      for (const table of ['notes', 'attachments', 'tasks']) {
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

  /**
   * A person on a fresh custom role of this base holding exactly these switch values, with View jobs and View
   * leads on and Jobs and Leads scope All unless the case says otherwise. Whatever the base, no role name may
   * decide anything.
   */
  async function personWith(
    org: string,
    values: Record<string, boolean | string>,
    opts: { base?: Role; name?: string; extraGrants?: { action: string; subject: string }[] } = {},
  ): Promise<Person & { api: () => Promise<Api> }> {
    const key = `tan-role-${++sequence}`;
    const base = opts.base ?? 'DISPATCHER';
    const role = await fx.addCustomRole(org, key, base, { extraGrants: opts.extraGrants });
    await setRoleSwitchValues({
      organizationId: org, roleKey: key,
      values: { leads_scope: 'all', jobs_scope: 'all', view_jobs: true, view_leads: true, ...values },
      actorId: null, reason: 'manual',
    });
    const person = await fx.addUser(org, opts.name ?? `p${sequence}`, base, { customRoleId: role.id });
    return Object.assign(person, { api: () => fx.signedInAs(person) });
  }

  async function addTask(
    org: string,
    createdBy: string,
    opts: { assignees?: string[]; watchers?: string[]; linked?: { type: 'JOB' | 'LEAD'; id: string } } = {},
  ) {
    const id = randomUUID();
    await db.task.create({
      data: {
        id, organization_id: org, task_number: `T-${id.slice(0, 8)}`, title: `Task ${id.slice(0, 4)}`,
        created_by: createdBy, assignee_ids: opts.assignees ?? [createdBy], watcher_ids: opts.watchers ?? [],
        linked_entity_type: opts.linked?.type ?? null, linked_entity_id: opts.linked?.id ?? null,
      },
    });
    return id;
  }

  async function addFile(org: string, entity: { type: 'JOB' | 'LEAD' | 'TASK' | 'INVOICE' | 'CUSTOMER'; id: string }, uploadedBy: string) {
    const id = randomUUID();
    await db.attachment.create({
      data: {
        id, organization_id: org, entity_type: entity.type, entity_id: entity.id, file_name: `${id}.pdf`,
        file_url: `https://files.example.test/${id}.pdf`, storage_path: `org/${id}.pdf`, file_type: 'application/pdf',
        file_size: 10, display_name: `File ${id.slice(0, 4)}`, uploaded_by: uploadedBy,
      },
    });
    return id;
  }

  const filesLeft = (id: string) => db.attachment.count({ where: { id } });

  describe('Add notes', () => {
    it('adds a note to a job and to a lead the person can open with Edit jobs and Edit leads off, whatever the role is based on', async () => {
      const { org, customer } = await newOrg();
      const job = await fx.addJob(org, customer);
      const lead = await fx.addLead(org, customer);

      for (const base of ['TECHNICIAN', 'SALES', 'DISPATCHER', 'ADMIN'] as const) {
        const person = await personWith(org, { add_notes: true, edit_jobs: false, edit_leads: false, change_lead_status_by_hand: false }, { base });
        const api = await person.api();
        const onJob = await api.post(`/api/jobs/${job.id}/notes`, { content: `job note from ${base}` });
        expect(onJob.status, `${base} job note`).toBe(201);
        const onLead = await api.post(`/api/leads/${lead.id}/notes`, { content: `lead note from ${base}` });
        expect(onLead.status, `${base} lead note`).toBe(201);
        // The same person still cannot edit the job: Add notes is not Edit jobs.
        const edit = await api.patch(`/api/jobs/${job.id}`, { description: 'changed' });
        expect(edit.status, `${base} job edit`).toBe(403);
      }
    });

    it('refuses a note without Add notes even with Edit jobs and Edit leads on', async () => {
      const { org, customer } = await newOrg();
      const job = await fx.addJob(org, customer);
      const lead = await fx.addLead(org, customer);

      for (const base of ['TECHNICIAN', 'SALES', 'DISPATCHER', 'ADMIN'] as const) {
        const person = await personWith(org, { add_notes: false, edit_jobs: true, edit_leads: true }, { base });
        const api = await person.api();
        expect((await api.post(`/api/jobs/${job.id}/notes`, { content: 'nope' })).status, `${base} job note`).toBe(403);
        expect((await api.post(`/api/leads/${lead.id}/notes`, { content: 'nope' })).status, `${base} lead note`).toBe(403);
      }
      expect(await db.note.count({ where: { organization_id: org } })).toBe(0);
    });

    it('refuses a note on a job the person cannot open, with Add notes on', async () => {
      const { org, customer } = await newOrg();
      const elsewhere = await fx.addJob(org, customer);
      const person = await personWith(org, { add_notes: true, jobs_scope: 'attached', leads_scope: 'attached' });
      const api = await person.api();
      expect((await api.post(`/api/jobs/${elsewhere.id}/notes`, { content: 'nope' })).status).toBe(403);

      const crewJob = await fx.addJob(org, customer, { crew: [person.id] });
      expect((await api.post(`/api/jobs/${crewJob.id}/notes`, { content: 'on my job' })).status).toBe(201);
    });
  });

  describe('See all tasks', () => {
    it('lists and opens a task the person is neither assignee nor watcher on, and without it does not', async () => {
      const { org, admin } = await newOrg();
      const someoneElses = await addTask(org, admin.id);

      for (const base of ['DISPATCHER', 'ADMIN', 'SALES'] as const) {
        const without = await personWith(org, { see_all_tasks: false }, { base });
        const noApi = await without.api();
        const list = await noApi.get('/api/tasks');
        expect(list.status, `${base} list without`).toBe(200);
        expect(JSON.stringify(list.body), `${base} list without`).not.toContain(someoneElses);
        expect((await noApi.get(`/api/tasks/${someoneElses}`)).status, `${base} open without`).toBe(403);

        const withSwitch = await personWith(org, { see_all_tasks: true }, { base });
        const api = await withSwitch.api();
        const all = await api.get('/api/tasks');
        expect(all.status, `${base} list with`).toBe(200);
        expect(JSON.stringify(all.body), `${base} list with`).toContain(someoneElses);
        expect((await api.get(`/api/tasks/${someoneElses}`)).status, `${base} open with`).toBe(200);
      }
    });

    it('still shows a person the tasks they are assignee or watcher on without the switch', async () => {
      const { org, admin } = await newOrg();
      const person = await personWith(org, { see_all_tasks: false });
      const mine = await addTask(org, admin.id, { assignees: [person.id] });
      const watching = await addTask(org, admin.id, { assignees: [admin.id], watchers: [person.id] });
      const api = await person.api();
      const list = await api.get('/api/tasks');
      expect(JSON.stringify(list.body)).toContain(mine);
      expect(JSON.stringify(list.body)).toContain(watching);
    });

    it('answers the linked-record task list and summary for a record the person cannot open only with the switch', async () => {
      const { org, customer, admin } = await newOrg();
      const job = await fx.addJob(org, customer);
      const linked = await addTask(org, admin.id, { linked: { type: 'JOB', id: job.id } });
      const query = `linked_entity_type=JOB&linked_entity_id=${job.id}`;
      const closed = { jobs_scope: 'attached', leads_scope: 'attached' };

      for (const base of ['DISPATCHER', 'ADMIN'] as const) {
        const without = await personWith(org, { ...closed, see_all_tasks: false }, { base });
        const noApi = await without.api();
        expect((await noApi.get(`/api/tasks?${query}`)).status, `${base} list without`).toBe(403);
        expect((await noApi.get(`/api/tasks/summary?${query}`)).status, `${base} summary without`).toBe(403);

        const withSwitch = await personWith(org, { ...closed, see_all_tasks: true }, { base });
        const api = await withSwitch.api();
        const list = await api.get(`/api/tasks?${query}`);
        expect(list.status, `${base} list with`).toBe(200);
        expect(JSON.stringify(list.body), `${base} list with`).toContain(linked);
        const summary = await api.get(`/api/tasks/summary?${query}`);
        expect(summary.status, `${base} summary with`).toBe(200);
        expect(summary.body.open, `${base} summary with`).toBe(1);
      }
    });

    it('leaves a task\'s file events out of the activity feed for a person without the switch (PRD 9: the task rule)', async () => {
      const { org, admin } = await newOrg();
      const task = await addTask(org, admin.id);
      await db.timelineEvent.create({
        data: {
          organization_id: org, entity_type: 'TASK', entity_id: task, event_type: 'ATTACHMENT_UPLOADED',
          description: 'File uploaded: salary-review.pdf', created_by: admin.id,
        },
      });

      for (const base of ['DISPATCHER', 'ADMIN'] as const) {
        // An Admin-based custom role stores no grants of its own, so it is given the dashboard to open.
        const dashboard = base === 'ADMIN' ? { extraGrants: [{ action: 'read', subject: 'Dashboard' }] } : {};
        const without = await personWith(org, { see_all_tasks: false }, { base, ...dashboard });
        const hidden = await (await without.api()).get('/api/dashboard');
        expect(hidden.status, `${base} without`).toBe(200);
        // The person is not on the task and has no linked record to open it through: the event itself is not theirs to see.
        expect(JSON.stringify(hidden.body.data.recent_activity), `${base} without`).not.toContain('salary-review');
        expect(hidden.body.data.recent_activity, `${base} without`).toEqual([]);

        const withSwitch = await personWith(org, { see_all_tasks: true }, { base, ...dashboard });
        const shown = await (await withSwitch.api()).get('/api/dashboard');
        expect(shown.status, `${base} with`).toBe(200);
        expect(JSON.stringify(shown.body.data.recent_activity), `${base} with`).toContain('salary-review.pdf');
      }
    });
  });

  describe('Attachments', () => {
    it('lets a person without Delete attachments delete their own file on a record they can open, and refuses someone else\'s', async () => {
      const { org, customer, admin } = await newOrg();
      const job = await fx.addJob(org, customer);

      for (const base of ['TECHNICIAN', 'SALES', 'DISPATCHER'] as const) {
        const person = await personWith(org, { delete_attachments: false }, { base });
        const api = await person.api();
        const mine = await addFile(org, { type: 'JOB', id: job.id }, person.id);
        const theirs = await addFile(org, { type: 'JOB', id: job.id }, admin.id);

        expect((await api.delete(`/api/attachments/job/${job.id}/${theirs}`)).status, `${base} someone else's`).toBe(403);
        expect(await filesLeft(theirs), `${base} someone else's`).toBe(1);
        expect((await api.delete(`/api/attachments/job/${job.id}/${mine}`)).status, `${base} own`).toBe(200);
        expect(await filesLeft(mine), `${base} own`).toBe(0);
      }
    });

    it('lets a person with Delete attachments delete anyone\'s file on a record they can open', async () => {
      const { org, customer, admin } = await newOrg();
      const job = await fx.addJob(org, customer);
      for (const base of ['TECHNICIAN', 'SALES', 'DISPATCHER'] as const) {
        const person = await personWith(org, { delete_attachments: true }, { base });
        const theirs = await addFile(org, { type: 'JOB', id: job.id }, admin.id);
        expect((await (await person.api()).delete(`/api/attachments/job/${job.id}/${theirs}`)).status, base).toBe(200);
        expect(await filesLeft(theirs), base).toBe(0);
      }
    });

    it('refuses a delete, their own file included, on a record the person cannot open', async () => {
      const { org, customer } = await newOrg();
      const elsewhere = await fx.addJob(org, customer);
      const person = await personWith(org, { delete_attachments: true, jobs_scope: 'attached', leads_scope: 'attached' });
      const mine = await addFile(org, { type: 'JOB', id: elsewhere.id }, person.id);
      expect((await (await person.api()).delete(`/api/attachments/job/${elsewhere.id}/${mine}`)).status).toBe(403);
      expect(await filesLeft(mine)).toBe(1);
    });

    it('refuses a delete without View attachments even for their own file', async () => {
      const { org, customer } = await newOrg();
      const job = await fx.addJob(org, customer);
      const person = await personWith(org, { view_attachments: false, delete_attachments: false, upload_attachments: false, edit_attachments: false });
      const mine = await addFile(org, { type: 'JOB', id: job.id }, person.id);
      expect((await (await person.api()).delete(`/api/attachments/job/${job.id}/${mine}`)).status).toBe(403);
      expect(await filesLeft(mine)).toBe(1);
    });

    it('opens the files of a job, a lead and an invoice by what the person can open, never by role name', async () => {
      const { org, customer, admin } = await newOrg();
      const job = await fx.addJob(org, customer);
      const lead = await fx.addLead(org, customer);
      const invoice = await fx.addInvoice(org, customer, { jobId: job.id });
      const targets = [
        { path: 'job', id: job.id, type: 'JOB' as const },
        { path: 'lead', id: lead.id, type: 'LEAD' as const },
        { path: 'invoice', id: invoice.id, type: 'INVOICE' as const },
      ];
      for (const t of targets) await addFile(org, { type: t.type, id: t.id }, admin.id);

      // Reaches everything: a technician-based role sees all three, though the technician preset reaches few.
      for (const base of ['TECHNICIAN', 'SALES'] as const) {
        const wide = await personWith(org, { invoices_scope: 'all', view_invoices: true }, { base });
        const api = await wide.api();
        for (const t of targets) expect((await api.get(`/api/attachments/${t.path}/${t.id}`)).status, `${base} wide ${t.path}`).toBe(200);
      }
      // Reaches nothing: a dispatcher-based role sees none, though a dispatcher is let in everywhere today.
      for (const base of ['DISPATCHER', 'ADMIN'] as const) {
        const narrow = await personWith(org, { jobs_scope: 'attached', leads_scope: 'attached', invoices_scope: 'attached' }, { base });
        const api = await narrow.api();
        for (const t of targets) expect((await api.get(`/api/attachments/${t.path}/${t.id}`)).status, `${base} narrow ${t.path}`).toBe(403);
      }
    });

    it('opens a job\'s files for a person on its crew with the Technician preset\'s scope', async () => {
      const { org, customer, admin } = await newOrg();
      const mine = await fx.addJob(org, customer);
      const notMine = await fx.addJob(org, customer);
      const person = await personWith(org, { jobs_scope: 'attached', leads_scope: 'attached' }, { base: 'TECHNICIAN' });
      await fx.addVisit(org, { jobId: mine.id, crew: [person.id] });
      await addFile(org, { type: 'JOB', id: mine.id }, admin.id);
      await addFile(org, { type: 'JOB', id: notMine.id }, admin.id);
      const api = await person.api();
      expect((await api.get(`/api/attachments/job/${mine.id}`)).status).toBe(200);
      expect((await api.get(`/api/attachments/job/${notMine.id}`)).status).toBe(403);
    });
  });
  describe('the route-level enforcement table: tasks and calendar events', () => {
    // One request per server check, each against a record of its own. With the switch on the request is let in
    // (anything but a refusal); with it off it is refused with a 403. The row rule takes whatever needs the switch off
    // with it, so a dependant never props a switch up.
    type Ctx = { org: string; admin: Person; me: Person; other: Person };
    type Probe = {
      switchKey: string; check: string;
      /** Other switches the request needs, kept on for both the let-in and the refused request. */
      also?: Record<string, boolean>;
      run: (api: Api, ctx: Ctx) => Promise<{ status: number }>;
    };
    const day = 86_400_000;
    const probes: Probe[] = [
      { switchKey: 'view_tasks', check: 'task-list', run: (api) => api.get('/api/tasks') },
      { switchKey: 'view_tasks', check: 'task-detail', run: async (api, c) => api.get(`/api/tasks/${await addTask(c.org, c.me.id)}`) },
      { switchKey: 'create_tasks', check: 'task-create', run: (api) => api.post('/api/tasks', { title: 'Call the supplier' }) },
      { switchKey: 'edit_tasks', check: 'task-update', run: async (api, c) => api.patch(`/api/tasks/${await addTask(c.org, c.me.id)}`, { title: 'Renamed' }) },
      {
        switchKey: 'delete_tasks', check: 'task-delete',
        // A person's own to-do (made by them, theirs alone) goes without the switch; a task someone else made, that they
        // can open as one of its assignees, needs it.
        run: async (api, c) => api.delete(`/api/tasks/${await addTask(c.org, c.admin.id, { assignees: [c.me.id, c.admin.id] })}`),
      },
      {
        switchKey: 'assign_tasks_to_others', check: 'task-assign', also: { edit_tasks: true },
        run: async (api, c) => api.patch(`/api/tasks/${await addTask(c.org, c.me.id)}`, { assignee_ids: [c.me.id, c.other.id] }),
      },
      {
        switchKey: 'create_events', check: 'calendar-entry-create',
        run: (api) => api.post('/api/calendar-entries', {
          title: 'Supplier visit', start: new Date(Date.now() + day).toISOString(), end: new Date(Date.now() + day + 3_600_000).toISOString(),
        }),
      },
      {
        switchKey: 'edit_events', check: 'calendar-entry-update',
        run: async (api, c) => {
          const entry = await db.calendarEntry.create({
            data: { organization_id: c.org, title: 'Walk the site', start: new Date(Date.now() + day), end: new Date(Date.now() + day + 3_600_000), created_by: c.admin.id },
          });
          return api.patch(`/api/calendar-entries/${entry.id}`, { title: 'Walk the site, twice' });
        },
      },
      {
        switchKey: 'delete_events', check: 'calendar-entry-delete',
        run: async (api, c) => {
          const entry = await db.calendarEntry.create({
            data: { organization_id: c.org, title: 'Walk the site', start: new Date(Date.now() + day), end: new Date(Date.now() + day + 3_600_000), created_by: c.admin.id },
          });
          return api.delete(`/api/calendar-entries/${entry.id}`);
        },
      },
    ];

    it('has a row for every task and event server check the catalog lists, and no other', () => {
      const listed = SWITCH_CATALOG
        .filter((s) => ['Tasks', 'Events'].includes(s.module))
        .flatMap((s) => s.serverChecks.map((c) => `${s.key}:${c}`))
        // See all tasks changes what a list or a task shows rather than refusing a request: its rows are in 'See all tasks'.
        .filter((c) => !c.startsWith('see_all_tasks:'))
        // View events and See all calendar entries decide which entries a person is a participant of or sees, rather than
        // refusing a request on a switch alone: their rows are in permission-calendar-entries-db.test.ts.
        .filter((c) => !c.startsWith('view_events:') && !c.startsWith('see_all_calendar_entries:'));
      expect(probes.map((p) => `${p.switchKey}:${p.check}`).sort()).toEqual(listed.sort());
    });

    it('lets each check in with its switch on and refuses it with the switch off, for a custom role', async () => {
      const { org, admin } = await newOrg();
      const other = await fx.addUser(org, 'taskmate', 'TECHNICIAN');
      const me = await personWith(org, {});
      const roleKey = (await db.customRole.findFirstOrThrow({ where: { organization_id: org, key: { startsWith: 'tan-role-' }, users: { some: { id: me.id } } } })).key;
      const api = await me.api();
      const ctx: Ctx = { org, admin, me, other };
      const roleSwitches = (values: Record<string, boolean>) =>
        setRoleSwitchValues({ organizationId: org, roleKey, values, actorId: null, reason: 'manual' });

      for (const probe of probes) {
        expect(findSwitch(probe.switchKey)!.serverChecks, probe.check).toContain(probe.check);
        // Everything that needs this switch, directly or through another switch that does.
        const dependants = [probe.switchKey];
        for (let i = 0; i < dependants.length; i += 1) {
          for (const s of SWITCH_CATALOG) if (s.requires.includes(dependants[i]!) && !dependants.includes(s.key)) dependants.push(s.key);
        }
        dependants.shift();

        await roleSwitches({ ...Object.fromEntries(dependants.map((d) => [d, false])), ...probe.also, [probe.switchKey]: true });
        const letIn = await probe.run(api, ctx);
        expect(letIn.status, `${probe.check} with the switch on`).not.toBe(403);
        expect(letIn.status, `${probe.check} with the switch on`).not.toBe(401);

        await roleSwitches({ ...Object.fromEntries(dependants.map((d) => [d, false])), ...probe.also, [probe.switchKey]: false });
        const refused = await probe.run(api, ctx);
        expect(refused.status, `${probe.check} with the switch off`).toBe(403);

        // Back on for the next check, with what depended on it.
        await roleSwitches({ ...Object.fromEntries(dependants.map((d) => [d, true])), [probe.switchKey]: true });
      }
    });
  });
});
