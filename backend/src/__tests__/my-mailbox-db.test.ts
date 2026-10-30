/* =============================================================================
   Roles & Permissions, PRD 10, slice S10.3 - GET /api/communication/my-mailbox: the person's own address.

   Through the route the Email page and the profile call, as a person on a custom role, against a real migrated
   database (TEST_DATABASE_URL); the suite skips when it is unset. Expected addresses are written out by hand. Every
   org it creates is removed again.
   ========================================================================== */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { PrismaClient } from '@prisma/client';

const clientPromise = vi.hoisted(async () => {
  const { oneConnectionClient } = await import('./one-connection-client.js');
  return oneConnectionClient(process.env.TEST_DATABASE_URL);
});
vi.mock('../lib/prisma', async () => ({ prisma: await clientPromise }));

import { switchFixture } from './permission-switches-fixture';
import { setRoleSwitchValues } from '../lib/permissions/switches/store';
import { SWITCH_CATALOG } from '../lib/permissions/switches/catalog';
import { clearPermissionCache } from '../lib/permissions/permissionCache';
import { clearSwitchCacheForUser } from '../lib/permissions/switches/cache';

const suite = process.env.TEST_DATABASE_URL ? describe : describe.skip;

suite('GET /api/communication/my-mailbox (real database)', () => {
  let db: PrismaClient;
  let fx: ReturnType<typeof switchFixture>;
  beforeAll(async () => {
    // This environment's mailbox domain, on the suite-wide stand-in for the settings.
    const { env } = await import('../config/env.js');
    Object.assign(env, { MAILBOX_DOMAIN: 'staging.mail.test.com' });
    db = (await clientPromise) as PrismaClient;
    fx = switchFixture(db, async () => (await import('../app.js')).default as never);
    await import('../app.js');
  }, 120_000);
  afterAll(() => fx.cleanup());

  /** A person on a fresh custom role holding NO switch at all, in a company with a mailbox for them. */
  async function world(mailbox: { status: string; localPart: string | null } | null, orgExtra: Record<string, unknown> = {}) {
    const w = await fx.newOrg();
    if (Object.keys(orgExtra).length) await db.organization.update({ where: { id: w.org }, data: orgExtra });
    const person = await fx.addUser(w.org, 'solo', 'TECHNICIAN');
    if (mailbox) {
      const box = await db.mailbox.create({
        data: { organization_id: w.org, kind: 'user', user_id: person.id, holder_user_id: person.id, status: mailbox.status },
      });
      if (mailbox.localPart) {
        await db.mailboxAddress.create({
          data: { local_part: `${mailbox.localPart}.${randomUUID().slice(0, 8).replace(/[0-9]/g, 'x')}`, organization_id: w.org, mailbox_id: box.id, is_primary: true },
        });
      }
    }
    return { ...w, person, api: await fx.signedInAs(person) };
  }

  it('gives the person their own address in full on this environment\'s mailbox domain', async () => {
    const w = await world({ status: 'active', localPart: 'jane.smith' });
    const own = await db.mailboxAddress.findFirstOrThrow({ where: { organization_id: w.org } });

    const res = await w.api.get('/api/communication/my-mailbox');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ mailbox: { status: 'active', address: `${own.local_part}@staging.mail.test.com` } });
  });

  it('says "address needed" with no address for a person whose address was taken', async () => {
    const w = await world({ status: 'address_needed', localPart: null });
    const res = await w.api.get('/api/communication/my-mailbox');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ mailbox: { status: 'address_needed', address: null } });
  });

  it('gives null to a person with no mailbox', async () => {
    const w = await world(null);
    const res = await w.api.get('/api/communication/my-mailbox');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ mailbox: null });
  });

  it('never gives someone else\'s mailbox, and not one that was merged away', async () => {
    const w = await world(null);
    const other = await fx.addUser(w.org, 'other', 'TECHNICIAN');
    await db.mailbox.create({ data: { organization_id: w.org, kind: 'user', user_id: other.id, holder_user_id: other.id, status: 'active' } });
    await db.mailbox.create({ data: { organization_id: w.org, kind: 'user', user_id: w.person.id, status: 'merged' } });
    const res = await w.api.get('/api/communication/my-mailbox');
    expect(res.body).toEqual({ mailbox: null });
  });

  it('answers 403 to a person on a custom role whose Access Communication is off, and 200 once it is on', async () => {
    const w = await fx.newOrg();
    const key = `mailbox-me-role-${randomUUID().slice(0, 8)}`;
    const role = await fx.addCustomRole(w.org, key, 'DISPATCHER');
    const allOff = Object.fromEntries(SWITCH_CATALOG.filter((x) => x.kind === 'toggle').map((x) => [x.key, false]));
    await setRoleSwitchValues({ organizationId: w.org, roleKey: key, values: { ...allOff, view_communication: true, access_communication: false }, actorId: null, reason: 'manual' });
    const person = await fx.addUser(w.org, 'nosection', 'DISPATCHER', { customRoleId: role.id });
    await db.mailbox.create({ data: { organization_id: w.org, kind: 'user', user_id: person.id, holder_user_id: person.id, status: 'address_needed' } });
    const api = await fx.signedInAs(person);

    expect((await api.get('/api/communication/my-mailbox')).status).toBe(403);

    await setRoleSwitchValues({ organizationId: w.org, roleKey: key, values: { access_communication: true }, actorId: null, reason: 'manual' });
    clearSwitchCacheForUser(person.id);
    clearPermissionCache(w.org);
    const after = await api.get('/api/communication/my-mailbox');
    expect(after.status, JSON.stringify(after.body)).toBe(200);
  });

  it('answers 402 to a company without the Email plan feature', async () => {
    const w = await world({ status: 'active', localPart: 'jane.smith' }, { feature_overrides: { email: false } });
    const res = await w.api.get('/api/communication/my-mailbox');
    expect(res.status).toBe(402);
    expect(res.body).toMatchObject({ error: 'FEATURE_NOT_IN_PLAN', feature: 'email' });
  });
});
