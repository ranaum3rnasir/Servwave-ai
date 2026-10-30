/* =============================================================================
   Roles & Permissions alignment, AL-13a (P19, E13): deactivating a person changes no data.

   Every assignee, watcher, Owner, crew, Sold By and Dispatcher field keeps their name; the Admin sees what the person
   still has open and may move it to someone else, as a separate step; a person with history is never deleted.

   Everything goes through the real routes, called as the company's Admin (and as a non-Admin holding View users, who is not
   an Admin). Only the auth provider is replaced. Real migrated database (TEST_DATABASE_URL); the suite skips when it is
   unset. Every org it creates is removed again.
   ========================================================================== */

import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import { randomUUID } from 'crypto';
import type { PrismaClient } from '@prisma/client';

const { realClient } = vi.hoisted(() => {
  const dbUrl = process.env.TEST_DATABASE_URL;
  if (!dbUrl) return { realClient: undefined };
  const { PrismaClient } = require('@prisma/client') as typeof import('@prisma/client');
  return { realClient: new PrismaClient({ datasources: { db: { url: dbUrl } } }) };
});

vi.mock('../lib/prisma', () => ({ prisma: realClient }));

import { switchFixture, type Person } from './permission-switches-fixture';
import { supabaseAdmin } from '../lib/supabase';
import { setRoleSwitchValues } from '../lib/permissions/switches/store';

const suite = realClient ? describe : describe.skip;

suite('deactivating a person changes no record (real database, real routes)', () => {
  const db = realClient as PrismaClient;
  const fx = switchFixture(db, async () => (await import('../app.js')).default as never);
  beforeAll(async () => {
    await import('../app.js');
  }, 600_000);

  const orgs: string[] = [];
  afterAll(async () => {
    const quietly = (p: Promise<unknown>) => p.catch(() => undefined);
    for (const org of orgs) {
      await quietly(db.$executeRawUnsafe(`DELETE FROM tasks WHERE organization_id = '${org}'`));
      await quietly(db.$executeRawUnsafe(`DELETE FROM mailbox_addresses WHERE organization_id = '${org}'`));
      await quietly(db.$executeRawUnsafe(`DELETE FROM mailboxes WHERE organization_id = '${org}'`));
    }
    await fx.cleanup();
  });

  const authAdmin = supabaseAdmin.auth.admin as unknown as { listUsers: ReturnType<typeof vi.fn>; deleteUser: ReturnType<typeof vi.fn> };
  beforeEach(() => {
    authAdmin.listUsers.mockReset().mockResolvedValue({ data: { users: [], nextPage: null }, error: null });
    authAdmin.deleteUser.mockReset().mockResolvedValue({ data: null, error: null });
  });

  const addTask = (org: string, creator: string, over: { assignees?: string[]; watchers?: string[]; status?: 'TODO' | 'DONE' } = {}) =>
    db.task.create({
      data: {
        id: randomUUID(), organization_id: org, task_number: `T-${randomUUID().slice(0, 6)}`, title: 'Call back', created_by: creator,
        assignee_ids: over.assignees ?? [], watcher_ids: over.watchers ?? [], status: over.status ?? 'TODO',
      },
    });

  /** A company, its Admin, a leaver on every kind of record, and a colleague who could take over. */
  async function world() {
    const made = await fx.newOrg();
    orgs.push(made.org);
    const { org, customer, admin } = made;
    const leaver = await fx.addUser(org, `leaver${randomUUID().slice(0, 4)}`, 'DISPATCHER');
    // The colleague takes over every kind of slot: a copy of Admin holds every switch without being an Admin.
    const everything = await fx.addCustomRole(org, `heir-role-${randomUUID().slice(0, 4)}`, 'ADMIN', { copyGrants: false });
    const heir = await fx.addUser(org, `heir${randomUUID().slice(0, 4)}`, 'ADMIN', { customRoleId: everything.id, basedOnRoleKey: everything.key });
    const openLead = await fx.addLead(org, customer, { owner: leaver.id, assignees: [leaver.id], dispatcher: leaver.id });
    const wonLead = await fx.addLead(org, customer, { owner: leaver.id });
    await db.lead.update({ where: { id: wonLead.id }, data: { status: 'WON' } });
    const openJob = await fx.addJob(org, customer, { crew: [leaver.id], soldBy: leaver.id, dispatcher: leaver.id });
    const doneJob = await fx.addJob(org, customer, { crew: [leaver.id], soldBy: leaver.id, status: 'DONE', pastVisit: true });
    const openTask = await addTask(org, admin.id, { assignees: [leaver.id], watchers: [leaver.id] });
    const doneTask = await addTask(org, admin.id, { assignees: [leaver.id], status: 'DONE' });
    return { org, customer, admin, leaver, heir, openLead, wonLead, openJob, doneJob, openTask, doneTask };
  }

  const peopleOf = async (w: Awaited<ReturnType<typeof world>>) => ({
    openLead: await db.lead.findUniqueOrThrow({ where: { id: w.openLead.id }, select: { commission_owner_id: true, dispatcher_id: true, lead_assignees: { select: { user_id: true } } } }),
    openJob: await db.job.findUniqueOrThrow({ where: { id: w.openJob.id }, select: { salesperson_id: true, dispatcher_id: true } }),
    openCrew: (await db.visitAssignee.findMany({ where: { visit_id: w.openJob.visitId! } })).map((a) => a.user_id),
    openTask: await db.task.findUniqueOrThrow({ where: { id: w.openTask.id }, select: { assignee_ids: true, watcher_ids: true } }),
  });

  describe('deactivation', () => {
    for (const [name, call] of [
      ['the deactivate action', (api: Awaited<ReturnType<typeof fx.signedInAs>>, id: string) => api.delete(`/api/users/${id}`)],
      ['the user update', (api: Awaited<ReturnType<typeof fx.signedInAs>>, id: string) => api.patch(`/api/users/${id}`, { is_active: false })],
    ] as const) {
      it(`${name} leaves every assignee, watcher, Owner, crew, Sold By and Dispatcher field as it was, and reactivating changes nothing either`, async () => {
        const w = await world();
        const before = await peopleOf(w);
        const api = await fx.signedInAs(w.admin);

        expect((await call(api, w.leaver.id)).status).toBe(200);
        expect((await db.user.findUniqueOrThrow({ where: { id: w.leaver.id } })).is_active).toBe(false);
        expect(await peopleOf(w)).toEqual(before);
        expect(before.openTask.assignee_ids).toEqual([w.leaver.id]);
        expect(before.openCrew).toEqual([w.leaver.id]);

        expect((await api.patch(`/api/users/${w.leaver.id}`, { is_active: true })).status).toBe(200);
        expect(await peopleOf(w)).toEqual(before);
      });
    }

    it('keeps the mailbox address of a deactivated person reserved', async () => {
      const w = await world();
      const box = await fx.addUserMailbox(w.org, w.leaver);
      expect((await (await fx.signedInAs(w.admin)).delete(`/api/users/${w.leaver.id}`)).status).toBe(200);
      expect(await db.mailboxAddress.count({ where: { organization_id: w.org, mailbox_id: box } })).toBe(1);
    });
  });

  describe('the Deactivated marker', () => {
    it('marks a deactivated person on a task\'s assignees and on a job\'s and lead\'s people, and not an active one', async () => {
      const w = await world();
      const api = await fx.signedInAs(w.admin);
      await api.delete(`/api/users/${w.leaver.id}`);

      const task = (await api.get(`/api/tasks/${w.openTask.id}`)).body.task;
      expect(task.assignees).toEqual([{ id: w.leaver.id, name: expect.stringMatching(/\(Deactivated\)$/) }]);

      const job = (await api.get(`/api/jobs/${w.openJob.id}`)).body.job ?? (await api.get(`/api/jobs/${w.openJob.id}`)).body;
      expect(job.dispatcher).toMatchObject({ id: w.leaver.id, is_active: false });
      expect(job.salesperson).toMatchObject({ id: w.leaver.id, is_active: false });
      expect(job.assignees.map((a: { user: { id: string; is_active: boolean } }) => [a.user.id, a.user.is_active])).toEqual([[w.leaver.id, false]]);

      const lead = (await api.get(`/api/leads/${w.openLead.id}`)).body.lead;
      expect(lead.commission_owner).toMatchObject({ id: w.leaver.id, is_active: false });
      expect(lead.dispatcher).toMatchObject({ id: w.leaver.id, is_active: false });
      expect(lead.lead_assignees[0].user).toMatchObject({ id: w.leaver.id, is_active: false });
    });
  });

  describe('the summary of what is still open', () => {
    it('counts the open tasks, leads and jobs that name the person and leaves the closed ones out', async () => {
      const w = await world();
      const res = await (await fx.signedInAs(w.admin)).get(`/api/users/${w.leaver.id}/deactivation-summary`);
      expect(res.status).toBe(200);
      expect(res.body.person).toMatchObject({ id: w.leaver.id, is_active: true });
      expect(res.body.modules).toEqual([
        { key: 'tasks', label: 'Tasks', open: 1 },
        { key: 'leads', label: 'Leads', open: 1 },
        { key: 'jobs', label: 'Jobs', open: 1 },
      ]);
      expect(res.body.total).toBe(3);
    });

    it('is refused to someone who cannot edit users, and answers 404 for a person of another company', async () => {
      const w = await world();
      const other = await fx.newOrg();
      orgs.push(other.org);
      const nobody = await fx.addUser(w.org, 'nobody', 'TECHNICIAN');
      expect((await (await fx.signedInAs(nobody)).get(`/api/users/${w.leaver.id}/deactivation-summary`)).status).toBe(403);
      expect((await (await fx.signedInAs(other.admin)).get(`/api/users/${w.leaver.id}/deactivation-summary`)).status).toBe(404);
    });
  });

  describe('the optional reassign', () => {
    it('moves the open records of the chosen modules to the heir, and leaves the closed ones and the other modules alone', async () => {
      const w = await world();
      const api = await fx.signedInAs(w.admin);

      const res = await api.post(`/api/users/${w.leaver.id}/reassign`, { to_user_id: w.heir.id, modules: ['tasks', 'leads', 'jobs'] });
      expect(res.status).toBe(200);
      expect(res.body.moved).toEqual({ tasks: 1, leads: 1, jobs: 1 });

      const after = await peopleOf(w);
      expect(after.openTask).toEqual({ assignee_ids: [w.heir.id], watcher_ids: [w.heir.id] });
      expect(after.openLead).toMatchObject({ commission_owner_id: w.heir.id, dispatcher_id: w.heir.id });
      expect(after.openLead.lead_assignees.map((a) => a.user_id)).toEqual([w.heir.id]);
      expect(after.openJob).toEqual({ salesperson_id: w.heir.id, dispatcher_id: w.heir.id });
      expect(after.openCrew).toEqual([w.heir.id]);
      // History stays with the leaver.
      expect((await db.task.findUniqueOrThrow({ where: { id: w.doneTask.id } })).assignee_ids).toEqual([w.leaver.id]);
      expect((await db.lead.findUniqueOrThrow({ where: { id: w.wonLead.id } })).commission_owner_id).toBe(w.leaver.id);
      expect((await db.job.findUniqueOrThrow({ where: { id: w.doneJob.id } })).salesperson_id).toBe(w.leaver.id);
      expect(await db.visitAssignee.count({ where: { visit_id: w.doneJob.visitId!, user_id: w.leaver.id } })).toBe(1);
    });

    it('moves only the modules asked for', async () => {
      const w = await world();
      const api = await fx.signedInAs(w.admin);
      expect((await api.post(`/api/users/${w.leaver.id}/reassign`, { to_user_id: w.heir.id, modules: ['tasks'] })).status).toBe(200);
      const after = await peopleOf(w);
      expect(after.openTask.assignee_ids).toEqual([w.heir.id]);
      expect(after.openLead.commission_owner_id).toBe(w.leaver.id);
      expect(after.openJob.salesperson_id).toBe(w.leaver.id);
    });

    it('skips, and counts, the slots the heir cannot hold', async () => {
      const w = await world();
      const noCrew = await fx.addCustomRole(w.org, `no-crew-${randomUUID().slice(0, 4)}`, 'DISPATCHER', { copyGrants: false });
      await setRoleSwitchValues({ organizationId: w.org, roleKey: noCrew.key, values: { can_be_on_crew: false }, actorId: null, reason: 'manual' });
      const heir = await fx.addUser(w.org, 'nocrew', 'DISPATCHER', { customRoleId: noCrew.id, basedOnRoleKey: noCrew.key });

      const res = await (await fx.signedInAs(w.admin)).post(`/api/users/${w.leaver.id}/reassign`, { to_user_id: heir.id, modules: ['jobs'] });
      expect(res.status).toBe(200);
      expect(res.body.skipped.jobs).toBe(1);
      expect((await peopleOf(w)).openCrew).toEqual([w.leaver.id]);
    });

    it('is an Admin\'s step: a non-Admin holding View users is refused', async () => {
      const w = await world();
      const role = await fx.addCustomRole(w.org, `editor-${randomUUID().slice(0, 4)}`, 'DISPATCHER');
      await setRoleSwitchValues({ organizationId: w.org, roleKey: role.key, values: { view_users: true }, actorId: null, reason: 'manual' });
      const editor: Person = await fx.addUser(w.org, 'editor', 'DISPATCHER', { customRoleId: role.id });
      const res = await (await fx.signedInAs(editor)).post(`/api/users/${w.leaver.id}/reassign`, { to_user_id: w.heir.id, modules: ['tasks'] });
      expect(res.status).toBe(403);
      expect((await peopleOf(w)).openTask.assignee_ids).toEqual([w.leaver.id]);
    });

    it('refuses the same person, an inactive person and a body with no module', async () => {
      const w = await world();
      const api = await fx.signedInAs(w.admin);
      expect((await api.post(`/api/users/${w.leaver.id}/reassign`, { to_user_id: w.leaver.id, modules: ['tasks'] })).status).toBe(400);
      await db.user.update({ where: { id: w.heir.id }, data: { is_active: false } });
      expect((await api.post(`/api/users/${w.leaver.id}/reassign`, { to_user_id: w.heir.id, modules: ['tasks'] })).status).toBe(400);
      expect((await api.post(`/api/users/${w.leaver.id}/reassign`, { to_user_id: w.heir.id, modules: [] })).status).toBe(400);
    });
  });

  describe('deleting a person', () => {
    it('is refused for a person a record still names (crew, Dispatcher, Sold By, a task), and allowed for a person nothing names', async () => {
      const w = await world();
      const api = await fx.signedInAs(w.admin);
      await api.delete(`/api/users/${w.leaver.id}`);
      const refused = await api.delete(`/api/users/${w.leaver.id}/permanent`);
      expect(refused.status).toBe(409);
      expect(refused.body.error).toMatch(/history/i);

      const mistyped = await fx.addUser(w.org, `typo${randomUUID().slice(0, 4)}`, 'TECHNICIAN');
      await api.delete(`/api/users/${mistyped.id}`);
      expect((await api.delete(`/api/users/${mistyped.id}/permanent`)).status).toBe(200);
      expect(await db.user.count({ where: { id: mistyped.id } })).toBe(0);
    });

    it('is refused for a person only a task names', async () => {
      const w = await world();
      const watcher = await fx.addUser(w.org, `watch${randomUUID().slice(0, 4)}`, 'TECHNICIAN');
      await addTask(w.org, w.admin.id, { assignees: [w.admin.id], watchers: [watcher.id] });
      const api = await fx.signedInAs(w.admin);
      await api.delete(`/api/users/${watcher.id}`);
      const refused = await api.delete(`/api/users/${watcher.id}/permanent`);
      expect(refused.status).toBe(409);
      expect(refused.body.error).toMatch(/tasks/);
    });
  });
});
