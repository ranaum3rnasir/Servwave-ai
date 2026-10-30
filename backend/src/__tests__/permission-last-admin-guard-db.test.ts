/* =============================================================================
   Roles & Permissions, PRD 1 - the last-admin guard counts the Admin box only. A person on a custom role copied from
   Admin has the base role Admin but no full access, so they are not an admin that keeps the company reachable. The
   guard refuses to deactivate, demote, move off the Admin box (to a built-in role or to any custom role, one based on
   Admin included) or revoke the login of the last person in the Admin box. Only an Admin may manage people at all (AL-18), so
   a copy of Admin that tries is refused at the route, and the guard is what is left when an Admin is the one acting.

   Everything goes through the public interface: the user routes, called as the company's Admin. Real migrated database
   (TEST_DATABASE_URL); the suite skips when it is unset. Every org it creates is removed again.
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

import { switchFixture } from './permission-switches-fixture';
import { ADMIN_ONLY_MESSAGE } from '../middleware/canGuard';

const suite = realClient ? describe : describe.skip;

suite('the last-admin guard counts the Admin box only (real database)', () => {
  const db = realClient as PrismaClient;
  const fx = switchFixture(db, async () => (await import('../app.js')).default as never);
  // Loading the whole app is slow on a loaded machine.
  beforeAll(async () => {
    await import('../app.js');
  }, 120_000);
  afterAll(() => fx.cleanup());

  let sequence = 0;
  // A copy of Admin is not an Admin: the route refuses them before any handler runs (AL-18).
  const REFUSED = new RegExp(`^${ADMIN_ONLY_MESSAGE.replace(/\./g, '\\.')}$`);

  /**
   * A company with one person in the Admin box (the target) and one on a custom role copied from Admin, who does the
   * acting: the old count saw two admins here, the real number is one.
   */
  async function company() {
    const { org, admin } = await fx.newOrg();
    // A company with no Owner (as migration M11 leaves one with no candidate): the target is protected only by the last-admin
    // guard under test here, not by being the Owner (AL-16).
    await db.organization.update({ where: { id: org }, data: { owner_user_id: null } });
    await db.user.update({ where: { id: admin.id }, data: { has_login: true } });
    const copy = await fx.addCustomRole(org, `admin-copy-${++sequence}`, 'ADMIN', { copyGrants: false });
    const actor = await fx.addUser(org, `copy${++sequence}`, 'ADMIN', { customRoleId: copy.id, basedOnRoleKey: copy.key });
    return { org, boxed: admin, copy, actor, api: () => fx.signedInAs(actor) };
  }

  const stateOf = (id: string) =>
    db.user.findUniqueOrThrow({ where: { id }, select: { role: true, custom_role_id: true, is_active: true, has_login: true } });

  it('refuses to deactivate the only Admin-box person, by either route, when a copy of Admin is active', async () => {
    const { boxed, api } = await company();
    const a = await api();
    const patched = await a.patch(`/api/users/${boxed.id}`, { is_active: false });
    expect(patched.status).toBe(403);
    expect(patched.body.error).toMatch(REFUSED);
    const deleted = await a.delete(`/api/users/${boxed.id}`);
    expect(deleted.status).toBe(403);
    expect(deleted.body.error).toMatch(REFUSED);
    expect(await stateOf(boxed.id)).toMatchObject({ is_active: true });
  });

  it('refuses to demote the only Admin-box person to a built-in role', async () => {
    const { boxed, api } = await company();
    const res = await (await api()).patch(`/api/users/${boxed.id}`, { role: 'SALES' });
    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(REFUSED);
    expect(await stateOf(boxed.id)).toMatchObject({ role: 'ADMIN', custom_role_id: null });
  });

  it('refuses to move the only Admin-box person onto a custom role, one based on Admin included', async () => {
    const { org, boxed, copy, api } = await company();
    const a = await api();
    const toCopy = await a.patch(`/api/users/${boxed.id}`, { role: 'ADMIN', custom_role_id: copy.id });
    expect(toCopy.status).toBe(403);
    expect(toCopy.body.error).toMatch(REFUSED);

    const team = await fx.addCustomRole(org, `team-${++sequence}`, 'DISPATCHER', { copyGrants: false });
    const toTeam = await a.patch(`/api/users/${boxed.id}`, { role: 'DISPATCHER', custom_role_id: team.id });
    expect(toTeam.status).toBe(403);
    expect(await stateOf(boxed.id)).toMatchObject({ role: 'ADMIN', custom_role_id: null });
  });

  it('refuses to revoke the login of the only Admin-box person', async () => {
    const { boxed, api } = await company();
    const res = await (await api()).post(`/api/users/${boxed.id}/revoke-login`);
    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(REFUSED);
    expect(await stateOf(boxed.id)).toMatchObject({ has_login: true });
  });

  it('allows the same changes while another Admin-box person is active', async () => {
    const { org, boxed, copy } = await company();
    const second = await fx.addUser(org, `second${++sequence}`, 'ADMIN');
    // Changing an Admin is the Owner's alone (ticket 26): the second Admin-box person is the company's Owner here.
    await db.organization.update({ where: { id: org }, data: { owner_user_id: second.id } });
    const a = await fx.signedInAs(second);
    expect((await a.patch(`/api/users/${boxed.id}`, { role: 'ADMIN', custom_role_id: copy.id })).status).toBe(200);
    expect(await stateOf(boxed.id)).toMatchObject({ role: 'ADMIN', custom_role_id: copy.id });
    expect((await a.patch(`/api/users/${boxed.id}`, { role: 'ADMIN', custom_role_id: null })).status).toBe(200);
    expect((await a.delete(`/api/users/${boxed.id}`)).status).toBe(200);
    expect(await stateOf(boxed.id)).toMatchObject({ is_active: false });
  });

  it('lets a copy of Admin be deactivated or moved while an Admin-box person remains', async () => {
    const { org, actor } = await company();
    const other = await fx.addUser(org, `other${++sequence}`, 'ADMIN');
    const res = await (await fx.signedInAs(other)).delete(`/api/users/${actor.id}`);
    expect(res.status).toBe(200);
    expect(await stateOf(actor.id)).toMatchObject({ is_active: false });
  });
});
