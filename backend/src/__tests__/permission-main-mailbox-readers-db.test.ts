/* =============================================================================
   Roles & Permissions, PRD 10, slice S10.8 - the people who read the main mailbox: linking and unlinking them on the
   Sender Address page.

   An Admin links active people to the company's main mailbox and unlinks them again; nobody else
   can. The list starts empty, a deactivated person drops off it, and the picker pages and searches on the server so a
   company with hundreds of people never loads them all. Every link and unlink is audited.

   Through the routes the page calls, as people on custom roles holding exactly the switch values under test (never a
   built-in role name), on a client holding ONE connection as the hosted pool does, against a real migrated database
   (TEST_DATABASE_URL); the suite skips when it is unset. Every org it creates is removed again.
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
const READERS = '/api/organization/email-sender/readers';

suite('linking people to the main mailbox (real database)', () => {
  let db: PrismaClient;
  let fx: ReturnType<typeof switchFixture>;
  const orgs: string[] = [];

  beforeAll(async () => {
    db = (await clientPromise) as PrismaClient;
    fx = switchFixture(db, async () => (await import('../app.js')).default as never);
    await import('../app.js');
  }, 120_000);
  afterAll(async () => {
    const quietly = (p: Promise<unknown>) => p.catch(() => undefined);
    for (const org of orgs) {
      await quietly(db.$executeRawUnsafe(`DELETE FROM mailbox_readers WHERE organization_id = '${org}'`));
      await quietly(db.$executeRawUnsafe(`DELETE FROM audit_logs WHERE org_id = '${org}'`));
      await quietly(db.$executeRawUnsafe(`DELETE FROM mailboxes WHERE organization_id = '${org}'`));
    }
    await fx.cleanup();
  });

  /** A company with its main mailbox. */
  async function world() {
    const w = await fx.newOrg();
    orgs.push(w.org);
    const main = await db.mailbox.create({ data: { organization_id: w.org, kind: 'main', status: 'active' }, select: { id: true } });
    return { ...w, main: main.id };
  }

  /** A person on a fresh custom role holding exactly these switches on (everything else off). */
  async function personWith(org: string, on: string[], name = 'holder') {
    const key = `mbr-${randomUUID().slice(0, 8)}`;
    const role = await fx.addCustomRole(org, key, 'DISPATCHER');
    const allOff = Object.fromEntries(SWITCH_CATALOG.filter((x) => x.kind === 'toggle').map((x) => [x.key, false]));
    await setRoleSwitchValues({
      organizationId: org, roleKey: key, values: { ...allOff, ...Object.fromEntries(on.map((k) => [k, true])) },
      actorId: null, reason: 'manual',
    });
    clearPermissionCache(org);
    return fx.addUser(org, name, 'DISPATCHER', { customRoleId: role.id });
  }

  const names = (body: { items: { name: string }[] }) => body.items.map((i) => i.name);
  const linkedIds = async (main: string) =>
    (await db.mailboxReader.findMany({ where: { mailbox_id: main }, select: { user_id: true } })).map((r) => r.user_id);

  it('starts empty: no one is linked at release', async () => {
    const w = await world();
    const holder = w.admin; // reading and changing who reads the main mailbox is an Admin's alone (36b, M17)
    const res = await (await fx.signedInAs(holder)).get(READERS);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toMatchObject({ items: [], total: 0 });
  });

  it('lets an Admin link a person, lists them, and unlinks them again', async () => {
    const w = await world();
    const holder = w.admin; // adding and removing a reader is an Admin's alone (M8, D3)
    const jane = await fx.addUser(w.org, 'Jane', 'DISPATCHER');
    const api = await fx.signedInAs(holder);

    const linked = await api.put(`${READERS}/${jane.id}`);
    expect(linked.status, JSON.stringify(linked.body)).toBe(200);
    expect(await linkedIds(w.main)).toEqual([jane.id]);
    const list = await api.get(READERS);
    expect(list.body.total).toBe(1);
    expect(list.body.items[0]).toMatchObject({ id: jane.id, name: 'Jane Tester' });

    // linking twice is one link
    expect((await api.put(`${READERS}/${jane.id}`)).status).toBe(200);
    expect(await linkedIds(w.main)).toEqual([jane.id]);

    const unlinked = await api.delete(`${READERS}/${jane.id}`);
    expect(unlinked.status, JSON.stringify(unlinked.body)).toBe(200);
    expect(await linkedIds(w.main)).toEqual([]);
    expect((await api.get(READERS)).body.total).toBe(0);
    // unlinking someone who is not linked is not an error
    expect((await api.delete(`${READERS}/${jane.id}`)).status).toBe(200);
  });

  it('refuses every readers route to a non-Admin, whatever else the person holds, and links nobody', async () => {
    const w = await world();
    const everythingElse = SWITCH_CATALOG.filter((s) => s.kind === 'toggle' && true).map((s) => s.key);
    const person = await personWith(w.org, everythingElse, 'noteverything');
    const jane = await fx.addUser(w.org, 'Jane', 'DISPATCHER');
    const api = await fx.signedInAs(person);

    expect((await api.get(READERS)).status).toBe(403);
    expect((await api.get(`${READERS}/candidates`)).status).toBe(403);
    expect((await api.put(`${READERS}/${jane.id}`)).status).toBe(403);
    expect((await api.delete(`${READERS}/${jane.id}`)).status).toBe(403);
    expect(await linkedIds(w.main)).toEqual([]);
  });

  it('refuses to unlink to a non-Admin and leaves the link in place', async () => {
    const w = await world();
    const holder = w.admin; // adding and removing a reader is an Admin's alone (M8, D3)
    const other = await personWith(w.org, ['access_communication'], 'other');
    const jane = await fx.addUser(w.org, 'Jane', 'DISPATCHER');
    expect((await (await fx.signedInAs(holder)).put(`${READERS}/${jane.id}`)).status).toBe(200);
    expect((await (await fx.signedInAs(other)).delete(`${READERS}/${jane.id}`)).status).toBe(403);
    expect(await linkedIds(w.main)).toEqual([jane.id]);
  });

  it('drops a deactivated person off the list, and refuses to link one', async () => {
    const w = await world();
    const holder = w.admin; // adding and removing a reader is an Admin's alone (M8, D3)
    const jane = await fx.addUser(w.org, 'Jane', 'DISPATCHER');
    const leaver = await fx.addUser(w.org, 'Leaver', 'DISPATCHER');
    const api = await fx.signedInAs(holder);
    expect((await api.put(`${READERS}/${jane.id}`)).status).toBe(200);
    expect((await api.put(`${READERS}/${leaver.id}`)).status).toBe(200);
    await db.user.update({ where: { id: leaver.id }, data: { is_active: false } });

    const list = await api.get(READERS);
    expect(names(list.body)).toEqual(['Jane Tester']);
    expect(list.body.total).toBe(1);

    const gone = await fx.addUser(w.org, 'Gone', 'DISPATCHER');
    await db.user.update({ where: { id: gone.id }, data: { is_active: false } });
    const refused = await api.put(`${READERS}/${gone.id}`);
    expect(refused.status).toBe(400);
    expect(refused.body.error).toBe('Only active people can read the main mailbox.');
  });

  it('never links, lists or unlinks a person of another company', async () => {
    const w = await world();
    const other = await world();
    const holder = w.admin; // adding and removing a reader is an Admin's alone (M8, D3)
    const stranger = await fx.addUser(other.org, 'Stranger', 'DISPATCHER');
    const api = await fx.signedInAs(holder);

    expect((await api.put(`${READERS}/${stranger.id}`)).status).toBe(404);
    expect(await linkedIds(w.main)).toEqual([]);
    expect(await linkedIds(other.main)).toEqual([]);
    expect((await api.put(`${READERS}/not-a-uuid`)).status).toBe(404);
    // the other company's link is out of reach of an unlink from here
    await db.mailboxReader.create({ data: { organization_id: other.org, mailbox_id: other.main, user_id: stranger.id } });
    expect((await api.delete(`${READERS}/${stranger.id}`)).status).toBe(200);
    expect(await linkedIds(other.main)).toEqual([stranger.id]);
    expect(names((await api.get(READERS)).body)).toEqual([]);
  });

  it('audits each link and each unlink with who did it and whom, and never a name', async () => {
    const w = await world();
    const holder = w.admin; // adding and removing a reader is an Admin's alone (M8, D3)
    const jane = await fx.addUser(w.org, 'Jane', 'DISPATCHER');
    const api = await fx.signedInAs(holder);
    await api.put(`${READERS}/${jane.id}`);
    await api.delete(`${READERS}/${jane.id}`);

    const rows = await db.auditLog.findMany({ where: { org_id: w.org, action: { startsWith: 'mailbox.reader' } }, orderBy: { created_at: 'asc' } });
    expect(rows.map((r) => r.action)).toEqual(['mailbox.reader_linked', 'mailbox.reader_unlinked']);
    expect(rows[0]).toMatchObject({ actor_id: holder.id, resource_type: 'Mailbox', resource_id: w.main });
    expect(rows[0]!.metadata).toEqual({ user_id: jane.id });
    // a repeated link or unlink changes nothing, so it audits nothing more
    await api.delete(`${READERS}/${jane.id}`);
    expect(await db.auditLog.count({ where: { org_id: w.org, action: { startsWith: 'mailbox.reader' } } })).toBe(2);
  });

  describe('the picker, with a company of 300 people', () => {
    it('pages and searches active people not yet linked, on the server', async () => {
      const w = await world();
      const holder = w.admin; // adding and removing a reader is an Admin's alone (M8, D3)
      const people = Array.from({ length: 300 }, (_, n) => ({
        id: randomUUID(), organization_id: w.org, email: `p${n}-${w.org.slice(0, 8)}@example.test`,
        first_name: `Zoe${String(n).padStart(3, '0')}`, last_name: 'Picker', role: 'DISPATCHER' as const,
      }));
      await db.user.createMany({ data: people });
      await db.user.update({ where: { id: people[299]!.id }, data: { is_active: false } });
      const api = await fx.signedInAs(holder);
      await api.put(`${READERS}/${people[0]!.id}`);

      const first = await api.get(`${READERS}/candidates`);
      expect(first.status, JSON.stringify(first.body)).toBe(200);
      // 300 people and the company's admin (who is the one asking), less the inactive one and the linked one
      expect(first.body.total).toBe(299);
      expect(first.body.items.length).toBe(first.body.limit);
      expect(first.body.limit).toBeLessThanOrEqual(100);
      const second = await api.get(`${READERS}/candidates?offset=${first.body.limit}`);
      expect(second.body.items[0].id).not.toBe(first.body.items[0].id);

      const found = await api.get(`${READERS}/candidates?search=zoe123`);
      expect(found.body.total).toBe(1);
      expect(found.body.items[0]).toMatchObject({ id: people[123]!.id, name: 'Zoe123 Picker' });
      expect((await api.get(`${READERS}/candidates?search=zoe000`)).body.total).toBe(0);
      expect((await api.get(`${READERS}/candidates?search=zoe299`)).body.total).toBe(0);
      // every word must match, in the first or the last name
      expect((await api.get(`${READERS}/candidates?search=zoe12%20picker`)).body.total).toBe(10);
    }, 120_000);

    it('pages the linked list too', async () => {
      const w = await world();
      const holder = w.admin; // adding and removing a reader is an Admin's alone (M8, D3)
      const people = Array.from({ length: 120 }, (_, n) => ({
        id: randomUUID(), organization_id: w.org, email: `q${n}-${w.org.slice(0, 8)}@example.test`,
        first_name: `Amy${String(n).padStart(3, '0')}`, last_name: 'Linked', role: 'DISPATCHER' as const,
      }));
      await db.user.createMany({ data: people });
      await db.mailboxReader.createMany({ data: people.map((p) => ({ organization_id: w.org, mailbox_id: w.main, user_id: p.id })) });
      const api = await fx.signedInAs(holder);

      const first = await api.get(READERS);
      expect(first.body.total).toBe(120);
      expect(first.body.items.length).toBe(first.body.limit);
      expect(names(first.body)[0]).toBe('Amy000 Linked');
      const last = await api.get(`${READERS}?offset=100`);
      expect(last.body.items.length).toBe(20);
    }, 120_000);
  });

  it('does not list a person as a candidate who is already linked, and lists them again after an unlink', async () => {
    const w = await world();
    const holder = w.admin; // adding and removing a reader is an Admin's alone (M8, D3)
    const jane = await fx.addUser(w.org, 'Jane', 'DISPATCHER');
    const api = await fx.signedInAs(holder);
    const ids = async () => ((await api.get(`${READERS}/candidates?search=jane`)).body.items as { id: string }[]).map((i) => i.id);
    expect(await ids()).toEqual([jane.id]);
    await api.put(`${READERS}/${jane.id}`);
    expect(await ids()).toEqual([]);
    await api.delete(`${READERS}/${jane.id}`);
    expect(await ids()).toEqual([jane.id]);
  });

  it('lists nobody, and does not fail, for a company that has no main mailbox', async () => {
    const w = await fx.newOrg();
    orgs.push(w.org);
    const holder: Person = w.admin;
    const res = await (await fx.signedInAs(holder)).get(READERS);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ items: [], total: 0 });
  });
});
