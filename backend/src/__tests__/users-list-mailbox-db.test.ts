/* =============================================================================
   Roles & Permissions, PRD 10, slice S10.25 - GET /api/users carries each user's mailbox (the Email column) and
   whether their own switches close the Email page ("Can't read: Email page is off for this person").

   Through the route the Users page calls, as a person on a custom role, against a real migrated database
   (TEST_DATABASE_URL); the suite skips when it is unset. Expected values are written out by hand, and the
   built-in presets are read from the catalog. Every org it creates is removed again.
   ========================================================================== */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { PrismaClient } from '@prisma/client';

// A client on one connection (as hosted) that also counts the queries it runs.
const { clientPromise, queries } = vi.hoisted(() => {
  const queries: string[] = [];
  const clientPromise = (async () => {
    const url = process.env.TEST_DATABASE_URL;
    if (!url) return undefined;
    const { PrismaClient } = await import('@prisma/client');
    const pooled = new URL(url);
    pooled.searchParams.set('connection_limit', '1');
    pooled.searchParams.set('pool_timeout', '4');
    const client = new PrismaClient({ datasources: { db: { url: pooled.toString() } }, log: [{ emit: 'event', level: 'query' }] });
    (client as unknown as { $on: (e: string, cb: (q: { query: string }) => void) => void }).$on('query', (q) => queries.push(q.query));
    return client;
  })();
  return { clientPromise, queries };
});
vi.mock('../lib/prisma', async () => ({ prisma: await clientPromise }));

import { switchFixture, type Person } from './permission-switches-fixture';
import { setPersonSwitchValues, setRoleSwitchValues } from '../lib/permissions/switches/store';
import { BUILT_IN_ROLES, SWITCH_CATALOG } from '../lib/permissions/switches/catalog';
import { clearPermissionCache } from '../lib/permissions/permissionCache';

const suite = process.env.TEST_DATABASE_URL ? describe : describe.skip;
const DOMAIN = 'staging.mail.test.com';

suite('GET /api/users: the Email column and the "Can\'t read" mark (real database)', () => {
  let db: PrismaClient;
  let fx: ReturnType<typeof switchFixture>;
  const orgs: string[] = [];

  beforeAll(async () => {
    const { env } = await import('../config/env.js');
    Object.assign(env, { MAILBOX_DOMAIN: DOMAIN });
    db = (await clientPromise) as PrismaClient;
    fx = switchFixture(db, async () => (await import('../app.js')).default as never);
    await import('../app.js');
  }, 120_000);
  afterAll(async () => {
    await db.mailboxAddress.deleteMany({ where: { organization_id: { in: orgs } } }).catch(() => undefined);
    await fx.cleanup();
  });

  async function world() {
    const w = await fx.newOrg();
    orgs.push(w.org);
    return w;
  }

  async function personWith(org: string, on: string[], name = 'p', extraOff: string[] = []) {
    const key = `ulm-${randomUUID().slice(0, 8)}`;
    const role = await fx.addCustomRole(org, key, 'DISPATCHER');
    const allOff = Object.fromEntries(SWITCH_CATALOG.filter((x) => x.kind === 'toggle').map((x) => [x.key, false]));
    await setRoleSwitchValues({
      organizationId: org, roleKey: key, actorId: null, reason: 'manual',
      values: { ...allOff, ...Object.fromEntries(on.filter((k) => !extraOff.includes(k)).map((k) => [k, true])) },
    });
    clearPermissionCache(org);
    return fx.addUser(org, name, 'DISPATCHER', { customRoleId: role.id });
  }

  async function withMailbox(org: string, person: Person, localPart: string | null, status = localPart ? 'active' : 'address_needed') {
    const box = await db.mailbox.create({
      data: { organization_id: org, kind: 'user', user_id: person.id, holder_user_id: person.id, status },
    });
    if (localPart) await db.mailboxAddress.create({ data: { local_part: localPart, organization_id: org, mailbox_id: box.id, is_primary: true } });
    return box;
  }

  const READER = ['view_users', 'access_communication', 'show_email'];
  type Row = { id: string; mailbox: { status: string; address: string | null; address_suffix: string | null } | null; email_page_closed: boolean };
  const rowsOf = (body: { users: Row[] }) => new Map(body.users.map((u) => [u.id, u]));

  it('gives each user\'s primary address in full, "address needed" with no address, and null for a user with no live mailbox', async () => {
    const w = await world();
    // The company's frozen part: the dialogs show it, fixed, beside the name part an admin types.
    const part = `acme${randomUUID().slice(0, 6).replace(/[0-9]/g, 'x')}`;
    await db.organization.update({ where: { id: w.org }, data: { email_sender_local_part: part } });
    const reader = await personWith(w.org, READER, 'reader');
    const a = await fx.addUser(w.org, 'withaddr', 'DISPATCHER');
    const b = await fx.addUser(w.org, 'needs', 'DISPATCHER');
    const c = await fx.addUser(w.org, 'nobox', 'DISPATCHER');
    const d = await fx.addUser(w.org, 'merged', 'DISPATCHER');
    const boxA = await withMailbox(w.org, a, `jane.smith.${randomUUID().slice(0, 6).replace(/[0-9]/g, 'x')}`);
    await db.mailboxAddress.create({ data: { local_part: `old.${randomUUID().slice(0, 6).replace(/[0-9]/g, 'x')}`, organization_id: w.org, mailbox_id: boxA.id, is_primary: false } });
    await withMailbox(w.org, b, null);
    await withMailbox(w.org, d, `gone.${randomUUID().slice(0, 6).replace(/[0-9]/g, 'x')}`, 'merged');
    const primary = (await db.mailboxAddress.findFirstOrThrow({ where: { mailbox_id: boxA.id, is_primary: true } })).local_part;
    const api = await fx.signedInAs(reader);

    const res = await api.get('/api/users');

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const rows = rowsOf(res.body);
    const suffix = `.${part}@${DOMAIN}`;
    expect(rows.get(a.id)!.mailbox).toEqual({ status: 'active', address: `${primary}@${DOMAIN}`, address_suffix: suffix });
    expect(rows.get(b.id)!.mailbox).toEqual({ status: 'address_needed', address: null, address_suffix: suffix });
    expect(rows.get(c.id)!.mailbox).toBeNull();
    expect(rows.get(d.id)!.mailbox).toBeNull();
  });

  it('marks a user whose OWN switches turn Show Email or Access Communication off, and not a user on any built-in preset', async () => {
    const w = await world();
    const reader = await personWith(w.org, READER, 'reader');
    const bothOn = await personWith(w.org, ['access_communication', 'show_email'], 'bothon');
    const showOff = await personWith(w.org, ['access_communication'], 'showoff');
    // Show Email needs Access Communication, so turning Access Communication off turns Show Email off with it.
    const accessOff = await personWith(w.org, [], 'accessoff');
    const presets = await Promise.all(BUILT_IN_ROLES.map((role) => fx.addUser(w.org, `preset-${role.toLowerCase()}`, role)));
    const api = await fx.signedInAs(reader);

    const rows = rowsOf((await api.get('/api/users')).body);

    expect(rows.get(bothOn.id)!.email_page_closed).toBe(false);
    expect(rows.get(showOff.id)!.email_page_closed).toBe(true);
    expect(rows.get(accessOff.id)!.email_page_closed).toBe(true);
    for (const p of presets) expect(rows.get(p.id)!.email_page_closed, p.email).toBe(false);
  });

  it('follows a per-person change, and the mark goes when both switches are on again', async () => {
    const w = await world();
    const reader = await personWith(w.org, READER, 'reader');
    const person = await personWith(w.org, ['access_communication', 'show_email'], 'flip');
    const api = await fx.signedInAs(reader);

    await setPersonSwitchValues({ organizationId: w.org, userId: person.id, values: { show_email: false }, actorId: null });
    expect(rowsOf((await api.get('/api/users')).body).get(person.id)!.email_page_closed).toBe(true);

    await setPersonSwitchValues({ organizationId: w.org, userId: person.id, values: { show_email: true }, actorId: null });
    expect(rowsOf((await api.get('/api/users')).body).get(person.id)!.email_page_closed).toBe(false);
  });

  it('reads the addresses and the switches in a constant number of queries however many users the page holds', async () => {
    const w = await world();
    const reader = await personWith(w.org, READER, 'reader');
    // The reader has an address too, so the address read has rows (and its second statement) in both measurements.
    await withMailbox(w.org, reader, `rd.${randomUUID().slice(0, 6).replace(/[0-9]/g, 'x')}`);
    const api = await fx.signedInAs(reader);
    // The fewest statements of three calls: a sign-in cache refresh or other background work on a busy machine can
    // add some to one call, and never takes any away.
    const countOnce = async () => {
      queries.length = 0;
      expect((await api.get('/api/users')).status).toBe(200);
      return queries.filter((q) => !/BEGIN|COMMIT/.test(q)).length;
    };
    const countFor = async () => Math.min(await countOnce(), await countOnce(), await countOnce());
    await countFor(); // the first request also warms the sign-in cache
    const few = await countFor();
    const people = await Promise.all(Array.from({ length: 40 }, (_, i) => fx.addUser(w.org, `bulk${i}`, 'DISPATCHER')));
    for (const p of people.slice(0, 20)) await withMailbox(w.org, p, `b${p.id.slice(0, 6).replace(/[0-9]/g, 'x')}.${randomUUID().slice(0, 5).replace(/[0-9]/g, 'x')}`);
    const many = await countFor();

    expect(many).toBe(few);
    // the address read is one query for the whole page: exactly one statement touches the mailbox tables
    queries.length = 0;
    await api.get('/api/users');
    expect(queries.filter((q) => /FROM "public"."mailboxes"/.test(q))).toHaveLength(1);
  });

  it('shows no mailbox and no mark in a company without the Email plan feature', async () => {
    const w = await world();
    await db.organization.update({ where: { id: w.org }, data: { feature_overrides: { email: false } } });
    const reader = await personWith(w.org, ['view_users']);
    const person = await personWith(w.org, [], 'closed');
    await withMailbox(w.org, person, `c.${randomUUID().slice(0, 6).replace(/[0-9]/g, 'x')}`);
    const api = await fx.signedInAs(reader);

    const row = rowsOf((await api.get('/api/users')).body).get(person.id)!;

    expect(row.mailbox).toBeNull();
    expect(row.email_page_closed).toBe(false);
  });
});
