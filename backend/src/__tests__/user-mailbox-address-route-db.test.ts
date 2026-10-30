/* =============================================================================
   Roles & Permissions, PRD 10, slice S10.25 - PUT /api/users/:id/mailbox-address: a holder of Edit users sets or
   changes the name part of a user's mailbox address (never the sign-in email).

   Through the route the Users page calls, as people on custom roles holding exactly the switch values under test
   (never a built-in role name), against a real migrated database (TEST_DATABASE_URL); the suite skips when it is
   unset. Expected addresses and messages are written out by hand. Every org it creates is removed again.
   ========================================================================== */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { PrismaClient } from '@prisma/client';

const clientPromise = vi.hoisted(async () => {
  const { oneConnectionClient } = await import('./one-connection-client.js');
  return oneConnectionClient(process.env.TEST_DATABASE_URL);
});
vi.mock('../lib/prisma', async () => ({ prisma: await clientPromise }));

import { switchFixture, type Person } from './permission-switches-fixture';
import { setRoleSwitchValues } from '../lib/permissions/switches/store';
import { SWITCH_CATALOG } from '../lib/permissions/switches/catalog';
import { clearPermissionCache } from '../lib/permissions/permissionCache';

const suite = process.env.TEST_DATABASE_URL ? describe : describe.skip;
const DOMAIN = 'staging.mail.test.com';
const TAKEN = 'This address is already in use. Choose a different one.';

suite('PUT /api/users/:id/mailbox-address (real database)', () => {
  let db: PrismaClient;
  let fx: ReturnType<typeof switchFixture>;
  const orgs: string[] = [];

  beforeAll(async () => {
    const { env } = await import('../config/env.js');
    Object.assign(env, { MAILBOX_DOMAIN: DOMAIN, MAILBOX_ADDRESS_HASH_KEY: 'test-mailbox-hash-key-0123456789abcdef' });
    db = (await clientPromise) as PrismaClient;
    fx = switchFixture(db, async () => (await import('../app.js')).default as never);
    await import('../app.js');
  }, 120_000);
  afterAll(async () => {
    await db.mailboxAddress.deleteMany({ where: { organization_id: { in: orgs } } }).catch(() => undefined);
    await fx.cleanup();
  });

  /** A company that has been through the register (frozen company part, main mailbox) with an admin and a customer. */
  async function world() {
    const w = await fx.newOrg();
    orgs.push(w.org);
    const part = `acme${randomUUID().replace(/-/g, '').replace(/[0-9]/g, (d) => 'abcdefghij'[Number(d)]!).slice(0, 8)}`;
    await db.organization.update({ where: { id: w.org }, data: { email_sender_local_part: part } });
    return { ...w, part };
  }

  /** A person on a fresh custom role holding exactly these switches on (everything else off). */
  async function personWith(org: string, on: string[], name = 'holder') {
    const key = `mbx-${randomUUID().slice(0, 8)}`;
    const role = await fx.addCustomRole(org, key, 'DISPATCHER');
    const allOff = Object.fromEntries(SWITCH_CATALOG.filter((x) => x.kind === 'toggle').map((x) => [x.key, false]));
    await setRoleSwitchValues({
      organizationId: org, roleKey: key, values: { ...allOff, ...Object.fromEntries(on.map((k) => [k, true])) },
      actorId: null, reason: 'manual',
    });
    clearPermissionCache(org);
    return fx.addUser(org, name, 'DISPATCHER', { customRoleId: role.id });
  }

  /** A user with a mailbox: active with `localPart`, or in "address needed" when it is null. */
  async function withMailbox(org: string, person: Person, localPart: string | null) {
    const box = await db.mailbox.create({
      data: { organization_id: org, kind: 'user', user_id: person.id, holder_user_id: person.id, status: localPart ? 'active' : 'address_needed' },
    });
    if (localPart) {
      await db.mailboxAddress.create({ data: { local_part: localPart, organization_id: org, mailbox_id: box.id, is_primary: true } });
    }
    return box;
  }

  const EDITOR = ['view_users', 'edit_users', 'access_communication', 'show_email'];

  it('sets an address for a person marked "Address needed": the mailbox turns active and their own my-mailbox answers it', async () => {
    const w = await world();
    const editor = await personWith(w.org, EDITOR);
    const target = await fx.addUser(w.org, 'newhire', 'DISPATCHER');
    const box = await withMailbox(w.org, target, null);
    const api = await fx.signedInAs(editor);

    const res = await api.put(`/api/users/${target.id}/mailbox-address`, { name_part: 'new.hire' });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toEqual({
      mailbox: { status: 'active', address: `new.hire.${w.part}@${DOMAIN}` },
    });
    expect(await db.mailbox.findUniqueOrThrow({ where: { id: box.id } })).toMatchObject({ status: 'active' });
    // "they can send on the next request": the person's own read now answers the address
    const own = await (await fx.signedInAs(target)).get('/api/communication/my-mailbox');
    // (the target is on a built-in DISPATCHER role, whose preset has Access Communication on)
    expect(own.status).toBe(200);
    expect(own.body).toEqual({ mailbox: { status: 'active', address: `new.hire.${w.part}@${DOMAIN}` } });
  });

  it('changes an address: the new one is primary, the old one stays in the register on the same mailbox', async () => {
    const w = await world();
    const editor = await personWith(w.org, EDITOR);
    const target = await fx.addUser(w.org, 'jane', 'DISPATCHER');
    const box = await withMailbox(w.org, target, `jane.smith.${w.part}`);
    const api = await fx.signedInAs(editor);

    const res = await api.put(`/api/users/${target.id}/mailbox-address`, { name_part: 'jsmith' });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ mailbox: { status: 'active', address: `jsmith.${w.part}@${DOMAIN}` } });
    const { lookupAddress } = await import('../lib/mailbox/register.js');
    expect(await lookupAddress(db, `jane.smith.${w.part}@${DOMAIN}`)).toMatchObject({ mailboxId: box.id, isPrimary: false });
    expect(await lookupAddress(db, `jsmith.${w.part}@${DOMAIN}`)).toMatchObject({ mailboxId: box.id, isPrimary: true });
  });

  it('refuses a taken name part with the exact words and 409, and names nobody', async () => {
    const w = await world();
    const editor = await personWith(w.org, EDITOR);
    const holder = await fx.addUser(w.org, 'holder2', 'DISPATCHER');
    await withMailbox(w.org, holder, `bob.lee.${w.part}`);
    const target = await fx.addUser(w.org, 'target', 'DISPATCHER');
    await withMailbox(w.org, target, `t.${w.part}`);
    const api = await fx.signedInAs(editor);

    const res = await api.put(`/api/users/${target.id}/mailbox-address`, { name_part: 'bob.lee' });

    expect(res.status).toBe(409);
    expect(res.body).toEqual({ error: TAKEN });
  });

  it('refuses a malformed or reserved name part with 400 and plain words', async () => {
    const w = await world();
    const editor = await personWith(w.org, EDITOR);
    const target = await fx.addUser(w.org, 'target', 'DISPATCHER');
    await withMailbox(w.org, target, `t.${w.part}`);
    const api = await fx.signedInAs(editor);

    const bad = await api.put(`/api/users/${target.id}/mailbox-address`, { name_part: 'jane smith' });
    expect(bad.status).toBe(400);
    expect(bad.body.error).toBe('Use only letters, numbers and single dots between them. The whole address can be up to 64 characters before the @.');
    const reserved = await api.put(`/api/users/${target.id}/mailbox-address`, { name_part: 'postmaster' });
    expect(reserved.status).toBe(400);
    expect(reserved.body).toEqual({ error: 'This address is reserved.' });
    const missing = await api.put(`/api/users/${target.id}/mailbox-address`, {});
    expect(missing.status).toBe(400);
  });

  it('refuses a person without Edit users, the person themself included, and writes nothing', async () => {
    const w = await world();
    const nonHolder = await personWith(w.org, ['view_users', 'access_communication', 'show_email'], 'viewer');
    await withMailbox(w.org, nonHolder, `v.${w.part}`);
    const target = await fx.addUser(w.org, 'target', 'DISPATCHER');
    const box = await withMailbox(w.org, target, `t.${w.part}`);
    const api = await fx.signedInAs(nonHolder);

    expect((await api.put(`/api/users/${target.id}/mailbox-address`, { name_part: 'free.one' })).status).toBe(403);
    expect((await api.put(`/api/users/${nonHolder.id}/mailbox-address`, { name_part: 'my.own' })).status).toBe(403);
    expect(await db.mailboxAddress.count({ where: { mailbox_id: box.id } })).toBe(1);
  });

  it('lets a holder of Edit users change their own address, since the switch is the only gate', async () => {
    const w = await world();
    const editor = await personWith(w.org, EDITOR);
    await withMailbox(w.org, editor, `ed.${w.part}`);
    const api = await fx.signedInAs(editor);
    const res = await api.put(`/api/users/${editor.id}/mailbox-address`, { name_part: 'ed.itor' });
    expect(res.status).toBe(200);
  });

  it('answers 404 for a user of another company, and changes nothing there', async () => {
    const mine = await world();
    const theirs = await world();
    const editor = await personWith(mine.org, EDITOR);
    const stranger = await fx.addUser(theirs.org, 'stranger', 'DISPATCHER');
    const box = await withMailbox(theirs.org, stranger, `s.${theirs.part}`);
    const api = await fx.signedInAs(editor);

    const res = await api.put(`/api/users/${stranger.id}/mailbox-address`, { name_part: 'taken.over' });

    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'User not found' });
    expect(await db.mailboxAddress.count({ where: { mailbox_id: box.id } })).toBe(1);
  });

  it('answers 409 for a person with no mailbox, in words that name no vendor', async () => {
    const w = await world();
    const editor = await personWith(w.org, EDITOR);
    const target = await fx.addUser(w.org, 'nobox', 'DISPATCHER');
    const api = await fx.signedInAs(editor);
    const res = await api.put(`/api/users/${target.id}/mailbox-address`, { name_part: 'no.box' });
    expect(res.status).toBe(409);
    expect(res.body).toEqual({ error: "This person doesn't have a mailbox yet." });
  });

  it('answers 402 to a company without the Email plan feature, and writes nothing', async () => {
    const w = await world();
    await db.organization.update({ where: { id: w.org }, data: { feature_overrides: { email: false } } });
    const editor = await personWith(w.org, EDITOR);
    const target = await fx.addUser(w.org, 'target', 'DISPATCHER');
    const box = await withMailbox(w.org, target, `t.${w.part}`);
    const api = await fx.signedInAs(editor);
    const res = await api.put(`/api/users/${target.id}/mailbox-address`, { name_part: 'free.one' });
    expect(res.status).toBe(402);
    expect(res.body).toMatchObject({ error: 'FEATURE_NOT_IN_PLAN', feature: 'email' });
    expect(await db.mailboxAddress.count({ where: { mailbox_id: box.id } })).toBe(1);
  });

  it('writes an audit entry naming who changed whose address, from what, to what', async () => {
    const w = await world();
    const editor = await personWith(w.org, EDITOR);
    const target = await fx.addUser(w.org, 'audited', 'DISPATCHER');
    await withMailbox(w.org, target, `old.${w.part}`);
    const api = await fx.signedInAs(editor);

    const res = await api.put(`/api/users/${target.id}/mailbox-address`, { name_part: 'newer' });
    expect(res.status).toBe(200);

    await vi.waitFor(async () => {
      const rows = await db.auditLog.findMany({ where: { org_id: w.org, action: 'user.mailbox_address_changed' } });
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ actor_id: editor.id, resource_type: 'User', resource_id: target.id });
      expect(rows[0]!.metadata).toEqual({ from: `old.${w.part}@${DOMAIN}`, to: `newer.${w.part}@${DOMAIN}`, activated: false });
    });
  });
});
