/* =============================================================================
   Roles & Permissions alignment, AL-13b (P19, A5): an Admin can erase a deactivated person's personal data.

   The name becomes "Former user", the email, phone and photo are removed, the credentials are deleted, the mailbox address
   stays reserved, the row and every link stay, and the erasure is logged. An erased person cannot sign in or be reactivated.

   Everything goes through the real routes, called as the company's Admin. Only the auth provider is replaced. Real migrated
   database (TEST_DATABASE_URL); the suite skips when it is unset. Every org it creates is removed again.
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
vi.mock('../lib/email', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  sendUserInviteEmail: vi.fn().mockResolvedValue(true),
}));

import { switchFixture } from './permission-switches-fixture';
import { supabaseAdmin } from '../lib/supabase';
import { setRoleSwitchValues } from '../lib/permissions/switches/store';

const suite = realClient ? describe : describe.skip;

suite('erasing a deactivated person\'s personal data (real database, real routes)', () => {
  const db = realClient as PrismaClient;
  const fx = switchFixture(db, async () => (await import('../app.js')).default as never);
  beforeAll(async () => {
    const { env } = await import('../config/env.js');
    Object.assign(env, { MAILBOX_DOMAIN: 'staging.mail.test.com' });
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

  /** A company, its Admin, and a leaver who is deactivated, with a phone, a photo, a mailbox and a place on records. */
  async function world(opts: { deactivate?: boolean } = {}) {
    const made = await fx.newOrg();
    orgs.push(made.org);
    const { org, customer, admin } = made;
    const leaver = await fx.addUser(org, `leaver${randomUUID().slice(0, 4)}`, 'DISPATCHER');
    await db.user.update({ where: { id: leaver.id }, data: { phone: '+16175550123', phone_ext: '12', avatar_path: `${org}/${leaver.id}.png` } });
    const box = await fx.addUserMailbox(org, leaver);
    const job = await fx.addJob(org, customer, { crew: [leaver.id], soldBy: leaver.id });
    const task = await db.task.create({
      data: { id: randomUUID(), organization_id: org, task_number: `T-${randomUUID().slice(0, 6)}`, title: 'Call back', created_by: admin.id, assignee_ids: [leaver.id], watcher_ids: [] },
    });
    authAdmin.listUsers.mockResolvedValue({ data: { users: [{ id: `auth-${leaver.id}`, email: leaver.email }], nextPage: null }, error: null });
    const api = await fx.signedInAs(admin);
    if (opts.deactivate !== false) expect((await api.delete(`/api/users/${leaver.id}`)).status).toBe(200);
    authAdmin.deleteUser.mockClear();
    return { org, customer, admin, leaver, box, job, task, api };
  }

  it('turns the name into "Former user", removes the email, phone and photo, deletes the credentials, and keeps the row, its role and every link', async () => {
    const w = await world();
    const before = await db.user.findUniqueOrThrow({ where: { id: w.leaver.id } });

    const res = await w.api.post(`/api/users/${w.leaver.id}/erase-personal-data`);
    expect(res.status).toBe(200);

    const after = await db.user.findUniqueOrThrow({ where: { id: w.leaver.id } });
    expect(after).toMatchObject({
      first_name: 'Former', last_name: 'user', phone: null, phone_ext: null, avatar_path: null,
      has_login: false, password_hash: '', mfa_email_enrolled: false, is_active: false,
      id: before.id, organization_id: before.organization_id, role: before.role,
    });
    expect(after.erased_at).toBeInstanceOf(Date);
    expect(after.email).not.toBe(before.email);
    expect(after.email.endsWith('@erased.invalid')).toBe(true);
    expect(JSON.stringify(after)).not.toContain(before.email);

    // Every record still points at the person, who now reads as Former user with the Deactivated marker.
    expect(await db.visitAssignee.count({ where: { visit_id: w.job.visitId!, user_id: w.leaver.id } })).toBe(1);
    expect((await db.job.findUniqueOrThrow({ where: { id: w.job.id } })).salesperson_id).toBe(w.leaver.id);
    const task = (await w.api.get(`/api/tasks/${w.task.id}`)).body.task;
    expect(task.assignees).toEqual([{ id: w.leaver.id, name: 'Former user (Deactivated)' }]);
    const jobBody = (await w.api.get(`/api/jobs/${w.job.id}`)).body;
    const salesperson = (jobBody.job ?? jobBody).salesperson;
    expect(salesperson).toMatchObject({ first_name: 'Former', last_name: 'user', is_active: false });

    // The mailbox address stays reserved; the erasure is logged.
    expect(await db.mailboxAddress.count({ where: { organization_id: w.org, mailbox_id: w.box } })).toBe(1);
    const log = await db.permissionChangeLog.findMany({ where: { organization_id: w.org, target_type: 'USER', target_id: w.leaver.id, reason: 'erased' } });
    expect(log).toHaveLength(1);
    expect(log[0]).toMatchObject({ switch_key: null, actor_id: w.admin.id });
    expect(await db.auditLog.count({ where: { org_id: w.org, action: 'user.personal_data_erased', resource_id: w.leaver.id } })).toBe(1);
  });

  // Pre-PR review CR-10: a status never claims success for a failure. When the sign-in account cannot be removed, the erase
  // answers an error and changes nothing, so the real address (the only way to find that account again) survives for a retry.
  it('answers an error and changes nothing when the sign-in account cannot be removed; a retry then erases', async () => {
    const w = await world();
    const { email } = await db.user.findUniqueOrThrow({ where: { id: w.leaver.id }, select: { email: true } });
    authAdmin.deleteUser.mockResolvedValue({ data: null, error: { status: 500, message: 'provider down' } });

    const failed = await w.api.post(`/api/users/${w.leaver.id}/erase-personal-data`);

    expect(failed.status).toBe(502);
    expect(failed.body.message).toBeUndefined();
    expect(failed.body.error).toMatch(/nothing was erased/i);
    expect(JSON.stringify(failed.body)).not.toMatch(/supabase|provider down/i);
    const kept = await db.user.findUniqueOrThrow({ where: { id: w.leaver.id }, select: { email: true, erased_at: true, first_name: true } });
    expect(kept.email).toBe(email);
    expect(kept.erased_at).toBeNull();
    expect(kept.first_name).not.toBe('Former');

    authAdmin.deleteUser.mockResolvedValue({ data: null, error: null });
    const retried = await w.api.post(`/api/users/${w.leaver.id}/erase-personal-data`);
    expect(retried.status).toBe(200);
    expect((await db.user.findUniqueOrThrow({ where: { id: w.leaver.id } })).erased_at).not.toBeNull();
  });

  it('frees the old email address for someone else', async () => {
    const w = await world();
    const { email } = await db.user.findUniqueOrThrow({ where: { id: w.leaver.id }, select: { email: true } });
    expect((await w.api.post(`/api/users/${w.leaver.id}/erase-personal-data`)).status).toBe(200);
    const invited = await w.api.post('/api/users/invite', { first_name: 'New', last_name: 'Hire', email, role: 'SALES' });
    expect(invited.status).toBe(201);
  });

  it('refuses an active person, a person already erased, and the Admin\'s own account', async () => {
    const w = await world({ deactivate: false });
    const active = await w.api.post(`/api/users/${w.leaver.id}/erase-personal-data`);
    expect(active.status).toBe(409);
    expect(active.body.error).toMatch(/deactivate/i);
    expect((await db.user.findUniqueOrThrow({ where: { id: w.leaver.id } })).first_name).not.toBe('Former');

    expect((await w.api.delete(`/api/users/${w.leaver.id}`)).status).toBe(200);
    expect((await w.api.post(`/api/users/${w.leaver.id}/erase-personal-data`)).status).toBe(200);
    const again = await w.api.post(`/api/users/${w.leaver.id}/erase-personal-data`);
    expect(again.status).toBe(409);
    expect(again.body.error).toMatch(/already erased/i);

    // An Admin's own account. The company's Owner is refused before that, with 409 (AL-16), so the Admin here is another one.
    const second = await fx.addUser(w.org, `second${randomUUID().slice(0, 4)}`, 'ADMIN');
    expect((await (await fx.signedInAs(second)).post(`/api/users/${second.id}/erase-personal-data`)).status).toBe(400);
  });

  it('is an Admin\'s step: a non-Admin holding View users is refused and nothing is erased', async () => {
    const w = await world();
    const role = await fx.addCustomRole(w.org, `editor-${randomUUID().slice(0, 4)}`, 'DISPATCHER');
    await setRoleSwitchValues({ organizationId: w.org, roleKey: role.key, values: { view_users: true }, actorId: null, reason: 'manual' });
    const editor = await fx.addUser(w.org, 'editor', 'DISPATCHER', { customRoleId: role.id });
    const res = await (await fx.signedInAs(editor)).post(`/api/users/${w.leaver.id}/erase-personal-data`);
    expect(res.status).toBe(403);
    expect((await db.user.findUniqueOrThrow({ where: { id: w.leaver.id } })).erased_at).toBeNull();
  });

  it('cannot be reactivated, edited or re-invited once erased', async () => {
    const w = await world();
    expect((await w.api.post(`/api/users/${w.leaver.id}/erase-personal-data`)).status).toBe(200);
    for (const attempt of [
      () => w.api.patch(`/api/users/${w.leaver.id}`, { is_active: true }),
      () => w.api.patch(`/api/users/${w.leaver.id}`, { first_name: 'Back' }),
      () => w.api.post(`/api/users/${w.leaver.id}/invite`),
    ]) {
      const res = await attempt();
      expect(res.status).toBe(409);
      expect(res.body.error).toMatch(/erased/i);
    }
    const after = await db.user.findUniqueOrThrow({ where: { id: w.leaver.id } });
    expect(after).toMatchObject({ is_active: false, has_login: false, first_name: 'Former' });
  });

  it('shows the erasure on the people list: the name, and the erased marker', async () => {
    const w = await world();
    expect((await w.api.post(`/api/users/${w.leaver.id}/erase-personal-data`)).status).toBe(200);
    const rows = (await w.api.get('/api/users')).body.users as Array<{ id: string; first_name: string; last_name: string; erased_at: string | null }>;
    const row = rows.find((r) => r.id === w.leaver.id)!;
    expect(`${row.first_name} ${row.last_name}`).toBe('Former user');
    expect(row.erased_at).not.toBeNull();
  });
});
