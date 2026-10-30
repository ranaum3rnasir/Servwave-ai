/* =============================================================================
   Roles & Permissions, pre-PR review fixes (security review SR-5): a sign-in left behind never opens a later account.

   Sign-in falls back to the confirmed email address when the provider's account id is not a person's id (an invited person),
   so a login left at the identity provider for an address nobody holds any more would open the next account invited with
   that address, on the old password. Two doors close it:
    - a permanent delete removes the login first, and a failure deletes nothing and says so (the row keeps the address, so a
      retry finds the login again);
    - an invite removes any login the provider still has for an address no one holds before it makes the person, and a
      failure makes nothing and says so.
   The identity provider and the mail edge are replaced; everything else is the real routes on a real migrated database
   (TEST_DATABASE_URL). The suite skips when it is unset.
   ========================================================================== */

import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import { randomUUID } from 'crypto';

const { realClient } = vi.hoisted(() => {
  const dbUrl = process.env.TEST_DATABASE_URL;
  if (!dbUrl) return { realClient: undefined };
  const { PrismaClient } = require('@prisma/client') as typeof import('@prisma/client');
  return { realClient: new PrismaClient({ datasources: { db: { url: dbUrl } } }) };
});

vi.mock('../lib/prisma', () => ({ prisma: realClient }));
const { sendUserInviteEmail } = vi.hoisted(() => ({ sendUserInviteEmail: vi.fn() }));
vi.mock('../lib/email', async (importOriginal) => ({ ...(await importOriginal<Record<string, unknown>>()), sendUserInviteEmail }));

import { switchFixture, type Person } from './permission-switches-fixture';
import { supabaseAdmin } from '../lib/supabase';

const suite = realClient ? describe : describe.skip;

suite('a sign-in left behind never opens a later account (real database, provider replaced)', () => {
  const db = realClient as PrismaClient;
  const fx = switchFixture(db, async () => (await import('../app.js')).default as never);
  beforeAll(async () => {
    const { env } = await import('../config/env.js');
    Object.assign(env, { MAILBOX_DOMAIN: 'staging.mail.test.com', MAILBOX_ADDRESS_HASH_KEY: 'test-mailbox-hash-key-0123456789abcdef' });
    await import('../app.js');
  }, 120_000);
  afterAll(() => fx.cleanup());

  const auth = supabaseAdmin.auth.admin as unknown as Record<'listUsers' | 'deleteUser', ReturnType<typeof vi.fn>>;
  /** The provider's accounts, by id, as the replaced provider holds them. */
  let accounts: Map<string, string>;
  let providerDown: boolean;
  beforeEach(() => {
    accounts = new Map();
    providerDown = false;
    auth.listUsers.mockReset().mockImplementation(async () => (providerDown
      ? { data: { users: [] }, error: { message: 'provider down', status: 503 } }
      : { data: { users: [...accounts].map(([id, email]) => ({ id, email })), nextPage: null }, error: null }));
    auth.deleteUser.mockReset().mockImplementation(async (id: string) => {
      accounts.delete(id);
      return { data: null, error: null };
    });
    sendUserInviteEmail.mockReset().mockResolvedValue(true);
  });

  let org = '';
  let owner: Person;
  beforeAll(async () => {
    const o = await fx.newOrg();
    org = o.org;
    owner = o.admin;
  }, 120_000);

  /** A deactivated person with no history, whose login (under another provider id, as for an invited person) the provider holds. */
  async function leaver() {
    const p = await fx.addUser(org, 'leaver', 'TECHNICIAN');
    await db.user.update({ where: { id: p.id }, data: { is_active: false, has_login: false } });
    const login = randomUUID();
    accounts.set(login, p.email);
    return { p, login };
  }

  it('a delete whose sign-in removal fails deletes nothing and says so; the retry removes the login and deletes', async () => {
    const { p, login } = await leaver();
    providerDown = true;
    const refused = await (await fx.signedInAs(owner)).delete(`/api/users/${p.id}/permanent`);
    expect(refused.status).toBe(502);
    expect(refused.body).toEqual({ error: "Could not remove this person's sign-in, so nothing was deleted. Please try again." });
    // Nothing was deleted, and the row still holds the address the login is found by.
    expect(await db.user.findUnique({ where: { id: p.id }, select: { email: true } })).toEqual({ email: p.email });
    expect(accounts.has(login)).toBe(true);

    providerDown = false;
    const done = await (await fx.signedInAs(owner)).delete(`/api/users/${p.id}/permanent`);
    expect(done.status).toBe(200);
    expect(await db.user.findUnique({ where: { id: p.id } })).toBeNull();
    expect(accounts.has(login)).toBe(false);
  });

  it('an invite to an address nobody holds removes a login left behind for it before making the person', async () => {
    const email = `left-${randomUUID().slice(0, 8)}@example.test`;
    const stale = randomUUID();
    accounts.set(stale, email);
    let rowWhenRemoved: unknown = 'not removed';
    auth.deleteUser.mockImplementation(async (id: string) => {
      rowWhenRemoved = await db.user.findFirst({ where: { email }, select: { id: true } });
      accounts.delete(id);
      return { data: null, error: null };
    });
    const res = await (await fx.signedInAs(owner)).post('/api/users/invite', { email, first_name: 'New', last_name: 'Person', role: 'TECHNICIAN' });
    expect(res.status).toBe(201);
    expect(accounts.has(stale)).toBe(false);
    // Removed before the person was made: no moment where the leftover and the new person share the address.
    expect(rowWhenRemoved).toBeNull();
    expect(sendUserInviteEmail).toHaveBeenCalledTimes(1);
  });

  it('an invite that cannot clear a login left behind makes nothing, sends nothing and says so', async () => {
    const email = `left-${randomUUID().slice(0, 8)}@example.test`;
    accounts.set(randomUUID(), email);
    providerDown = true;
    const res = await (await fx.signedInAs(owner)).post('/api/users/invite', { email, first_name: 'New', last_name: 'Person', role: 'TECHNICIAN' });
    expect(res.status).toBe(502);
    expect(res.body).toEqual({ error: 'Could not finish setting up this invite. Nothing was sent. Please try again.' });
    expect(await db.user.findFirst({ where: { email } })).toBeNull();
    expect(sendUserInviteEmail).not.toHaveBeenCalled();
  });

  it('the whole story: delete with the provider down, then invite the same address; the old login never reaches the new person', async () => {
    const { p, login } = await leaver();
    providerDown = true;
    expect((await (await fx.signedInAs(owner)).delete(`/api/users/${p.id}/permanent`)).status).toBe(502);
    providerDown = false;
    // The address is still held by the leaver, so it can't be invited onto yet.
    expect((await (await fx.signedInAs(owner)).post('/api/users/invite', { email: p.email, first_name: 'New', last_name: 'Person', role: 'TECHNICIAN' })).status).toBe(409);
    expect((await (await fx.signedInAs(owner)).delete(`/api/users/${p.id}/permanent`)).status).toBe(200);
    const invited = await (await fx.signedInAs(owner)).post('/api/users/invite', { email: p.email, first_name: 'New', last_name: 'Person', role: 'TECHNICIAN' });
    expect(invited.status).toBe(201);
    expect(accounts.has(login)).toBe(false);
    expect([...accounts.values()]).not.toContain(p.email);
  });
});
