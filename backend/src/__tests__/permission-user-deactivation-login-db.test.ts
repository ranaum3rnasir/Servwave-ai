/* =============================================================================
   Roles & Permissions, PRD 10 (S10.21) final-pass fix - the two ways to deactivate a person do the same thing.

   Deactivating through the user update (PATCH /api/users/:id with is_active false) once handed the mailbox over but left the
   sign-in in place, while the Users page's Deactivate (DELETE /api/users/:id) removed it. Both go through the REAL routes
   here, called by a person on a custom role holding Edit users and not Delete users; only the auth provider is replaced.

   Real migrated database (TEST_DATABASE_URL); the suite skips when it is unset. Every org it creates is removed.
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

// The suite-wide setup mocks the app's client; here it is the real one.
vi.mock('../lib/prisma', () => ({ prisma: realClient }));

import { switchFixture, type Person } from './permission-switches-fixture';
import { supabaseAdmin } from '../lib/supabase';
import { setRoleSwitchValues } from '../lib/permissions/switches/store';

const suite = realClient ? describe : describe.skip;

suite('both deactivation paths remove the login and hand the mailbox over (real database, real routes)', () => {
  const db = realClient as PrismaClient;
  const fx = switchFixture(db, async () => (await import('../app.js')).default as never);
  beforeAll(async () => {
    await import('../app.js');
  }, 120_000);

  const orgs: string[] = [];
  afterAll(async () => {
    const quietly = (p: Promise<unknown>) => p.catch(() => undefined);
    for (const org of orgs) {
      await quietly(db.$executeRawUnsafe(`DELETE FROM mailbox_addresses WHERE organization_id = '${org}'`));
      await quietly(db.$executeRawUnsafe(`DELETE FROM mailboxes WHERE organization_id = '${org}'`));
    }
    await fx.cleanup();
  });

  const authAdmin = supabaseAdmin.auth.admin as unknown as {
    listUsers: ReturnType<typeof vi.fn>;
    deleteUser: ReturnType<typeof vi.fn>;
  };
  beforeEach(() => {
    authAdmin.listUsers.mockReset();
    authAdmin.deleteUser.mockReset().mockResolvedValue({ data: null, error: null });
  });

  type Api = Awaited<ReturnType<typeof fx.signedInAs>>;
  const PATHS: { name: string; call: (api: Api, id: string) => Promise<{ status: number }> }[] = [
    { name: 'the deactivate action', call: (api, id) => api.delete(`/api/users/${id}`) },
    { name: 'the user update', call: (api, id) => api.patch(`/api/users/${id}`, { is_active: false }) },
  ];

  /** A company with its main mailbox, a person holding Edit users (not Delete users), and a leaver who has a login and a mailbox. */
  async function world() {
    const made = await fx.newOrg();
    orgs.push(made.org);
    const { org, tag } = made;

    const main = randomUUID();
    await db.mailbox.create({ data: { id: main, organization_id: org, kind: 'main', status: 'active' } });
    await db.mailboxAddress.create({ data: { local_part: `main-${tag}`, organization_id: org, mailbox_id: main, is_primary: true } });

    const key = `deactivation-role-${randomUUID().slice(0, 6)}`;
    const role = await fx.addCustomRole(org, key, 'DISPATCHER');
    await setRoleSwitchValues({
      organizationId: org, roleKey: key, values: { view_users: true, edit_users: true, delete_users: false }, actorId: null, reason: 'manual',
    });
    const editor: Person = await fx.addUser(org, 'editor', 'DISPATCHER', { customRoleId: role.id });

    const leaver = await fx.addUser(org, `leaver${randomUUID().slice(0, 4)}`, 'SALES');
    const leaverBox = await fx.addUserMailbox(org, leaver);
    // The auth provider knows the leaver under the same address.
    authAdmin.listUsers.mockResolvedValue({ data: { users: [{ id: `auth-${leaver.id}`, email: leaver.email }], nextPage: null }, error: null });
    return { org, main, editor, leaver, leaverBox };
  }

  for (const path of PATHS) {
    it(`${path.name}: the sign-in is removed, the person is inactive and their mailbox is handed to the main mailbox`, async () => {
      const w = await world();
      const before = await db.user.findUniqueOrThrow({ where: { id: w.leaver.id } });
      expect(before.has_login).toBe(true);

      const res = await path.call(await fx.signedInAs(w.editor), w.leaver.id);
      expect(res.status).toBe(200);

      const after = await db.user.findUniqueOrThrow({ where: { id: w.leaver.id } });
      expect(after).toMatchObject({ is_active: false, has_login: false, password_hash: '' });
      expect(authAdmin.deleteUser).toHaveBeenCalledTimes(1);
      expect(authAdmin.deleteUser).toHaveBeenCalledWith(`auth-${w.leaver.id}`);

      const box = await db.mailbox.findUniqueOrThrow({ where: { id: w.leaverBox } });
      expect(box.status).toBe('merged');
      expect(box.merged_into_mailbox_id).toBe(w.main);
    });
  }

  it('the user update leaves the login of a person it does not deactivate alone', async () => {
    const w = await world();
    const res = await (await fx.signedInAs(w.editor)).patch(`/api/users/${w.leaver.id}`, { first_name: 'Renamed' });
    expect(res.status).toBe(200);
    const after = await db.user.findUniqueOrThrow({ where: { id: w.leaver.id } });
    expect(after).toMatchObject({ is_active: true, has_login: true });
    expect(authAdmin.deleteUser).not.toHaveBeenCalled();
  });

  it('the user update refuses a handover target that is not an active person before the login is touched', async () => {
    const w = await world();
    const res = await (await fx.signedInAs(w.editor)).patch(`/api/users/${w.leaver.id}`, { is_active: false, handover_to: randomUUID() });
    expect(res.status).toBe(400);
    const after = await db.user.findUniqueOrThrow({ where: { id: w.leaver.id } });
    expect(after).toMatchObject({ is_active: true, has_login: true });
    expect(authAdmin.deleteUser).not.toHaveBeenCalled();
  });
});
