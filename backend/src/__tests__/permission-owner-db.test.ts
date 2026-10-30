/* =============================================================================
   Roles & Permissions AL-16 (ticket 24, H5): every company has one Owner, and no one can remove them.

   No one, the Owner included, can delete, deactivate, demote (the Admin switch, or a move off the Administrator role), revoke
   the sign-in of, or erase the Owner: each answers 409 "The Owner can't be removed." and writes one access.denied row. The
   sign-in payload says who the Owner is. The Owner is read from the database on every check, never from the sign-in cache,
   and a company without an Owner has none: no one (not its oldest Admin) stands in.

   Everything goes through the real routes, called as people of the company. Only the auth provider is replaced. Real
   migrated database (TEST_DATABASE_URL); the suite skips when it is unset. Every org it creates is removed again.
   ========================================================================== */

import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import type { PrismaClient } from '@prisma/client';

const { realClient } = vi.hoisted(() => {
  const dbUrl = process.env.TEST_DATABASE_URL;
  if (!dbUrl) return { realClient: undefined };
  const { PrismaClient } = require('@prisma/client') as typeof import('@prisma/client');
  return { realClient: new PrismaClient({ datasources: { db: { url: dbUrl } } }) };
});

vi.mock('../lib/prisma', () => ({ prisma: realClient }));
// The suite-wide setup mocks the audit writer; the refusal rows are part of what is under test here.
vi.unmock('../lib/audit');

import { switchFixture, type Person } from './permission-switches-fixture';
import { supabaseAdmin } from '../lib/supabase';

const suite = realClient ? describe : describe.skip;
const OWNER_CANT_BE_REMOVED = "The Owner can't be removed.";

suite('the Owner (real database, real routes)', () => {
  const db = realClient as PrismaClient;
  const fx = switchFixture(db, async () => (await import('../app.js')).default as never);
  beforeAll(async () => {
    await import('../app.js');
  }, 600_000);
  afterAll(() => fx.cleanup());

  const authAdmin = supabaseAdmin.auth.admin as unknown as { listUsers: ReturnType<typeof vi.fn>; deleteUser: ReturnType<typeof vi.fn> };
  beforeEach(() => {
    authAdmin.listUsers.mockReset().mockResolvedValue({ data: { users: [], nextPage: null }, error: null });
    authAdmin.deleteUser.mockReset().mockResolvedValue({ data: null, error: null });
  });

  /** The access.denied rows this person has against this target, once the response's own write has landed. */
  async function deniedRows(actor: Person, target: string, atLeast: number) {
    const read = () => db.auditLog.findMany({ where: { actor_id: actor.id, action: 'access.denied', resource_id: target } });
    for (let i = 0; i < 40; i++) {
      if ((await read()).length >= atLeast) break;
      await new Promise((r) => setTimeout(r, 50));
    }
    // A short wait for a row that should not be there, so "exactly one" is a real check.
    await new Promise((r) => setTimeout(r, 150));
    return read();
  }

  /** Every way to remove a person, as a request on them. */
  const REMOVALS: Array<[string, (api: Awaited<ReturnType<typeof fx.signedInAs>>, id: string) => Promise<{ status: number; body: { error?: string } }>]> = [
    ['take Admin away (the Admin switch)', (api, id) => api.patch(`/api/users/${id}`, { is_admin: false })],
    ['move off the Administrator role', (api, id) => api.patch(`/api/users/${id}`, { role: 'TECHNICIAN' })],
    ['set inactive', (api, id) => api.patch(`/api/users/${id}`, { is_active: false })],
    ['deactivate', (api, id) => api.delete(`/api/users/${id}`, {})],
    ['revoke sign-in', (api, id) => api.post(`/api/users/${id}/revoke-login`)],
    ['erase personal data', (api, id) => api.post(`/api/users/${id}/erase-personal-data`)],
    ['delete', (api, id) => api.delete(`/api/users/${id}/permanent`)],
  ];

  it('the sign-in payload says who the Owner is to an Admin, and to nobody else (re-audit N18)', async () => {
    const { org, admin } = await fx.newOrg();
    const tech = await fx.addUser(org, 'tina', 'TECHNICIAN');
    const otherAdmin = await fx.addUser(org, 'ada', 'ADMIN');

    const asOwner = await (await fx.signedInAs(admin)).get('/api/auth/me');
    expect(asOwner.status).toBe(200);
    expect(asOwner.body.user.org_owner_user_id).toBe(admin.id);

    const asAdmin = await (await fx.signedInAs(otherAdmin)).get('/api/auth/me');
    expect(asAdmin.body.user.org_owner_user_id).toBe(admin.id);

    const asTech = await (await fx.signedInAs(tech)).get('/api/auth/me');
    expect(asTech.status).toBe(200);
    expect(asTech.body.user).not.toHaveProperty('org_owner_user_id');
  });

  for (const [what, call] of REMOVALS) {
    it(`${what}: refused for the Owner, to another Admin and to the Owner themselves, with one access.denied row each`, async () => {
      const { org, admin: owner } = await fx.newOrg();
      const otherAdmin = await fx.addUser(org, 'ada', 'ADMIN');

      for (const caller of [otherAdmin, owner]) {
        const res = await call(await fx.signedInAs(caller), owner.id);
        expect(res.status, `${what} by ${caller === owner ? 'the Owner' : 'another Admin'}`).toBe(409);
        expect(res.body.error).toBe(OWNER_CANT_BE_REMOVED);
        expect(await deniedRows(caller, owner.id, 1)).toHaveLength(1);
      }

      const after = await db.user.findUniqueOrThrow({ where: { id: owner.id } });
      expect(after).toMatchObject({ is_admin: true, is_active: true, has_login: true, role: 'ADMIN', erased_at: null });
      expect(authAdmin.deleteUser).not.toHaveBeenCalled();
      const company = await db.organization.findUniqueOrThrow({ where: { id: org }, select: { owner_user_id: true } });
      expect(company.owner_user_id).toBe(owner.id);
    });
  }

  it('another Admin is still removed as before: only the Owner is protected', async () => {
    const { org, admin: owner } = await fx.newOrg();
    const otherAdmin = await fx.addUser(org, 'ada', 'ADMIN');

    const res = await (await fx.signedInAs(owner)).patch(`/api/users/${otherAdmin.id}`, { role: 'TECHNICIAN' });
    expect(res.status).toBe(200);
    expect((await db.user.findUniqueOrThrow({ where: { id: otherAdmin.id } })).is_admin).toBe(false);
  });

  it('a company without an Owner has none: its oldest Admin is not treated as one', async () => {
    const { org, admin: oldest } = await fx.newOrg();
    const younger = await fx.addUser(org, 'yuri', 'ADMIN');
    await db.organization.update({ where: { id: org }, data: { owner_user_id: null } });

    const me = await (await fx.signedInAs(oldest)).get('/api/auth/me');
    expect(me.body.user.org_owner_user_id).toBeNull();

    // Not protected as an Owner (no 409 "can't be removed"), and not acting as one either: changing an Admin is the Owner's
    // alone (ticket 26), and this company has none, so each Admin is refused on the other with 403.
    const demote = await (await fx.signedInAs(younger)).patch(`/api/users/${oldest.id}`, { role: 'TECHNICIAN' });
    expect(demote.status).toBe(403);
    expect(demote.body.error).toBe('Only the Owner can change Admins.');
    const byOldest = await (await fx.signedInAs(oldest)).delete(`/api/users/${younger.id}`, {});
    expect(byOldest.status).toBe(403);
    expect(byOldest.body.error).toBe('Only the Owner can change Admins.');
    expect(await db.user.findUniqueOrThrow({ where: { id: oldest.id } })).toMatchObject({ is_admin: true, is_active: true });
    expect(await db.user.findUniqueOrThrow({ where: { id: younger.id } })).toMatchObject({ is_admin: true, is_active: true });
  });

  it('the Owner is read from the database on every check, not from the sign-in cache', async () => {
    const { org, admin: first } = await fx.newOrg();
    const second = await fx.addUser(org, 'sam', 'ADMIN');
    await db.organization.update({ where: { id: org }, data: { owner_user_id: null } });

    // Both people sign in while the company has no Owner, so the sign-in cache holds them as they were.
    const asFirst = await fx.signedInAs(first);
    expect((await asFirst.get('/api/auth/me')).body.user.org_owner_user_id).toBeNull();
    const asSecond = await fx.signedInAs(second);
    expect((await asSecond.get('/api/auth/me')).status).toBe(200);

    // The company gets its Owner; the very next requests see it.
    await db.organization.update({ where: { id: org }, data: { owner_user_id: first.id } });
    expect((await (await fx.signedInAs(first)).get('/api/auth/me')).body.user.org_owner_user_id).toBe(first.id);
    const res = await (await fx.signedInAs(second)).post(`/api/users/${first.id}/revoke-login`);
    expect(res.status).toBe(409);
    expect(res.body.error).toBe(OWNER_CANT_BE_REMOVED);
  });
});
