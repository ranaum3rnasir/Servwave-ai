/* =============================================================================
   Roles & Permissions, PRD 10, slice S10.26 - PATCH /api/organization/email-sender: an Admin changes
   the company part of the company's addresses (the Sender Address page).

   Through the route the page calls, as people on custom roles holding exactly the switch values under test (never a
   built-in role name), on a client holding ONE connection as the hosted pool does, against a real migrated database
   (TEST_DATABASE_URL); the suite skips when it is unset. Expected addresses and messages are written out by hand.
   Every org it creates is removed again (address rows stay, by design).
   ========================================================================== */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { PrismaClient } from '@prisma/client';

const clientPromise = vi.hoisted(async () => {
  const { oneConnectionClient } = await import('./one-connection-client.js');
  return oneConnectionClient(process.env.TEST_DATABASE_URL);
});
vi.mock('../lib/prisma', async () => ({ prisma: await clientPromise }));
// The suite-wide setup stubs the mail module; this suite reads the real resolver of the company's addresses.
vi.mock('../lib/email', async (importOriginal) => await importOriginal<typeof import('../lib/email')>());

import { switchFixture, type Person } from './permission-switches-fixture';
import { setRoleSwitchValues } from '../lib/permissions/switches/store';
import { SWITCH_CATALOG } from '../lib/permissions/switches/catalog';
import { clearPermissionCache } from '../lib/permissions/permissionCache';

const suite = process.env.TEST_DATABASE_URL ? describe : describe.skip;
const DOMAIN = 'staging.mail.test.com';
const TAKEN = 'This email address is already in use. Choose a different one.';
const tag = () => randomUUID().replace(/-/g, '').replace(/[0-9]/g, (d) => 'abcdefghij'[Number(d)]!).slice(0, 8);

suite('PATCH /api/organization/email-sender (real database)', () => {
  let db: PrismaClient;
  let fx: ReturnType<typeof switchFixture>;
  const orgs: string[] = [];

  beforeAll(async () => {
    const { env } = await import('../config/env.js');
    Object.assign(env, { MAILBOX_DOMAIN: DOMAIN, EMAIL_FROM_BUSINESS: 'no-reply@mail.test.com', MAILBOX_ADDRESS_HASH_KEY: 'test-mailbox-hash-key-0123456789abcdef' });
    db = (await clientPromise) as PrismaClient;
    fx = switchFixture(db, async () => (await import('../app.js')).default as never);
    await import('../app.js');
  }, 120_000);
  afterAll(async () => {
    await db.mailboxAddress.deleteMany({ where: { organization_id: { in: orgs } } }).catch(() => undefined);
    await fx.cleanup();
  });

  /** A company that has been through the register: a frozen company part and a main mailbox. */
  async function world(name?: string) {
    const w = await fx.newOrg();
    orgs.push(w.org);
    if (name) await db.organization.update({ where: { id: w.org }, data: { name } });
    const { changeCompanyPart } = await import('../lib/mailbox/register.js');
    const part = `acme${tag()}`;
    expect(await changeCompanyPart(db, w.org, part)).toMatchObject({ ok: true });
    return { ...w, part };
  }

  /**
   * A person on a fresh custom role holding exactly these switches on (everything else off). '@admin' makes them an Admin (the
   * flag: setting up the company is the Admin flag's alone since 36b, M17); it is no switch.
   */
  async function personWith(org: string, on: string[], name = 'holder') {
    const key = `snd-${randomUUID().slice(0, 8)}`;
    const role = await fx.addCustomRole(org, key, 'DISPATCHER');
    const allOff = Object.fromEntries(SWITCH_CATALOG.filter((x) => x.kind === 'toggle').map((x) => [x.key, false]));
    await setRoleSwitchValues({
      organizationId: org, roleKey: key, values: { ...allOff, ...Object.fromEntries(on.filter((k) => k !== '@admin').map((k) => [k, true])) },
      actorId: null, reason: 'manual',
    });
    clearPermissionCache(org);
    return fx.addUser(org, name, 'DISPATCHER', { customRoleId: role.id, isAdmin: on.includes('@admin') });
  }

  /** A user with a mailbox issued the way a user create does. */
  async function withMailbox(org: string, person: Person, first: string, last: string) {
    const { issueUserMailbox } = await import('../lib/mailbox/register.js');
    return db.$transaction((tx) => issueUserMailbox(tx, { id: person.id, organization_id: org, first_name: first, last_name: last }));
  }

  const HOLDER = ['@admin'];

  it('lets an Admin change the company part: the main address and every user address move, the old ones keep resolving, and new automated sends use the new main address', async () => {
    const w = await world();
    const holder = await personWith(w.org, HOLDER);
    const jane = await fx.addUser(w.org, 'jane', 'DISPATCHER');
    const box = await withMailbox(w.org, jane, 'Jane', 'Smith');
    const main = await db.mailbox.findFirstOrThrow({ where: { organization_id: w.org, kind: 'main' } });
    const api = await fx.signedInAs(holder);
    const next = `service${tag()}`;

    const res = await api.patch('/api/organization/email-sender', { local_part: next });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toEqual({ local_part: next, local_part_is_custom: true, sender_domain: DOMAIN });
    const { lookupAddress, ownMailboxOf } = await import('../lib/mailbox/register.js');
    expect((await ownMailboxOf(db, jane.id))?.address).toBe(`jane.smith.${next}@${DOMAIN}`);
    expect(await lookupAddress(db, `${w.part}@${DOMAIN}`)).toMatchObject({ mailboxId: main.id, isPrimary: false });
    expect(await lookupAddress(db, `jane.smith.${w.part}@${DOMAIN}`)).toMatchObject({ mailboxId: box.mailboxId, isPrimary: false });
    // the resolver every automated send reads its From from, which the page reads too
    expect((await api.get('/api/organization/email-sender')).body).toMatchObject({ address: `${next}@${DOMAIN}`, local_part: next });
  });

  it('shows the main address and company part to an Admin whose role cannot read the Email page, and to nobody else', async () => {
    const w = await world();
    const holder = await personWith(w.org, HOLDER);
    const emailOnly = await personWith(w.org, ['access_communication', 'show_email'], 'emailonly');

    const seen = await (await fx.signedInAs(holder)).get('/api/organization/email-sender');
    expect(seen.status, JSON.stringify(seen.body)).toBe(200);
    expect(seen.body).toEqual({
      address: `${w.part}@${DOMAIN}`, local_part: w.part, local_part_is_custom: true, sender_domain: DOMAIN,
    });
    expect((await (await fx.signedInAs(emailOnly)).get('/api/organization/email-sender')).status).toBe(403);
  });

  it('refuses a person who is not an Admin with 403 and writes nothing, whatever else they hold', async () => {
    const w = await world();
    const everythingElse = SWITCH_CATALOG.filter((s) => s.kind === 'toggle' && true).map((s) => s.key);
    const person = await personWith(w.org, everythingElse, 'noteverything');
    const api = await fx.signedInAs(person);
    const before = await db.mailboxAddress.count({ where: { organization_id: w.org } });

    const res = await api.patch('/api/organization/email-sender', { local_part: `nope${tag()}` });

    expect(res.status).toBe(403);
    expect(await db.mailboxAddress.count({ where: { organization_id: w.org } })).toBe(before);
    expect((await db.organization.findUniqueOrThrow({ where: { id: w.org } })).email_sender_local_part).toBe(w.part);
  });

  it('answers 402 to a company without the Email plan feature, and writes nothing', async () => {
    const w = await world();
    await db.organization.update({ where: { id: w.org }, data: { feature_overrides: { email: false } } });
    const holder = await personWith(w.org, HOLDER);
    const api = await fx.signedInAs(holder);

    const res = await api.patch('/api/organization/email-sender', { local_part: `plan${tag()}` });

    expect(res.status).toBe(402);
    expect(res.body).toMatchObject({ error: 'FEATURE_NOT_IN_PLAN', feature: 'email' });
    expect((await db.organization.findUniqueOrThrow({ where: { id: w.org } })).email_sender_local_part).toBe(w.part);
  });

  it('answers a taken part the same way whether another company chose it, derives it, or was purged, and never names anyone', async () => {
    const t = tag();
    const mine = await world();
    const chooser = await world(`Chooser Co ${t}`);
    // a company that predates the register and never chose a part: it still owns the part its name gives
    const derived = await fx.newOrg();
    orgs.push(derived.org);
    await db.organization.update({ where: { id: derived.org }, data: { name: `Derived Co ${t}`, email_sender_local_part: null } });
    const gone = await world(`Gone Co ${t}`);
    const { reservePurgedAddresses } = await import('../lib/mailbox/register.js');
    await db.$transaction((tx) => reservePurgedAddresses(tx, gone.org));
    await db.organization.update({ where: { id: gone.org }, data: { email_sender_local_part: null, name: `Renamed ${t}` } });
    const holder = await personWith(mine.org, HOLDER);
    const api = await fx.signedInAs(holder);

    const answers = [] as { status: number; body: unknown }[];
    for (const part of [chooser.part, `derivedco${t}`, gone.part]) {
      const res = await api.patch('/api/organization/email-sender', { local_part: part });
      answers.push({ status: res.status, body: res.body });
    }

    for (const a of answers) expect(a).toEqual({ status: 409, body: { error: TAKEN, code: 'LOCAL_PART_TAKEN' } });
    const text = JSON.stringify(answers);
    for (const secret of [chooser.part, 'chooser', 'derived', 'gone', mine.part]) expect(text.toLowerCase()).not.toContain(secret);
  });

  it('refuses a reserved part, an unusable one and one too long for the people\'s addresses, each with its own plain words', async () => {
    const w = await world();
    const person = await fx.addUser(w.org, 'longname', 'DISPATCHER');
    await withMailbox(w.org, person, 'Maximiliano', 'Montgomeryworthington');
    const holder = await personWith(w.org, HOLDER);
    const api = await fx.signedInAs(holder);

    const reserved = await api.patch('/api/organization/email-sender', { local_part: 'postmaster' });
    expect(reserved.status).toBe(400);
    expect(JSON.stringify(reserved.body)).toContain('This address is reserved.');
    const bad = await api.patch('/api/organization/email-sender', { local_part: 'has space' });
    expect(bad.status).toBe(400);
    const tooLong = await api.patch('/api/organization/email-sender', { local_part: `${tag()}${'x'.repeat(32)}` });
    expect(tooLong.status).toBe(400);
    expect(tooLong.body).toEqual({ error: "That is too long for some people's addresses. Choose a shorter one." });
    expect((await db.organization.findUniqueOrThrow({ where: { id: w.org } })).email_sender_local_part).toBe(w.part);
  });

  it('answers a dry run with the same words as the real change and writes nothing, so the page can refuse a part before it warns', async () => {
    const t = tag();
    const w = await world();
    const chooser = await world(`Chooser Co ${t}`);
    const jane = await fx.addUser(w.org, 'jane', 'DISPATCHER');
    await withMailbox(w.org, jane, 'Maximiliano', 'Montgomeryworthington');
    const holder = await personWith(w.org, HOLDER);
    const api = await fx.signedInAs(holder);
    const fresh = `service${tag()}`;
    const addresses = () => db.mailboxAddress.count({ where: { organization_id: w.org } });
    const before = await addresses();
    const auditsBefore = await db.auditLog.count({ where: { org_id: w.org } });

    // A refusal is the real change's refusal, word for word.
    for (const part of ['postmaster', 'has space', `${tag()}${'x'.repeat(32)}`, chooser.part]) {
      const dry = await api.patch('/api/organization/email-sender', { local_part: part, dry_run: true });
      const real = await api.patch('/api/organization/email-sender', { local_part: part });
      expect({ status: dry.status, body: dry.body }, part).toEqual({ status: real.status, body: real.body });
      expect(dry.status).toBeGreaterThanOrEqual(400);
    }
    expect(JSON.stringify((await api.patch('/api/organization/email-sender', { local_part: 'postmaster', dry_run: true })).body)).toContain('This address is reserved.');

    // A part that would be accepted is accepted, and nothing moves: not the company's part, not a person's address.
    const ok = await api.patch('/api/organization/email-sender', { local_part: fresh, dry_run: true });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(ok.body).toEqual({ local_part: fresh, local_part_is_custom: true, sender_domain: DOMAIN });
    expect((await db.organization.findUniqueOrThrow({ where: { id: w.org } })).email_sender_local_part).toBe(w.part);
    expect(await addresses()).toBe(before);
    expect(await db.auditLog.count({ where: { org_id: w.org } })).toBe(auditsBefore);
    const { ownMailboxOf } = await import('../lib/mailbox/register.js');
    expect((await ownMailboxOf(db, jane.id))?.address).toBe(`maximiliano.montgomeryworthington.${w.part}@${DOMAIN}`);
    // ... and it is then free: the real change goes through.
    expect((await api.patch('/api/organization/email-sender', { local_part: fresh })).status).toBe(200);
  });

  it('refuses a dry run to a person who is not an Admin, like the change itself', async () => {
    const w = await world();
    const nobody = await personWith(w.org, []);
    const res = await (await fx.signedInAs(nobody)).patch('/api/organization/email-sender', { local_part: `service${tag()}`, dry_run: true });
    expect(res.status).toBe(403);
  });

  it('two companies claiming one part at the same moment: exactly one is saved, the other is told it is in use, never a server error', async () => {
    const a = await world();
    const b = await world();
    // The fixture signs in through one shared stub, so each person is signed in and resolved (one read) in turn before
    // the two requests are sent together.
    const signedInAndKnown = async (org: string) => {
      const api = await fx.signedInAs(await personWith(org, HOLDER));
      expect((await api.get('/api/organization')).status).toBe(200);
      return api;
    };
    const apiA = await signedInAndKnown(a.org);
    const apiB = await signedInAndKnown(b.org);
    const part = `race${tag()}`;

    const [ra, rb] = await Promise.all([
      apiA.patch('/api/organization/email-sender', { local_part: part }),
      apiB.patch('/api/organization/email-sender', { local_part: part }),
    ]);

    expect([ra.status, rb.status].sort()).toEqual([200, 409]);
    expect([ra, rb].find((r) => r.status === 409)!.body).toEqual({ error: TAKEN, code: 'LOCAL_PART_TAKEN' });
    expect(await db.organization.count({ where: { email_sender_local_part: part } })).toBe(1);
  });

  it('writes an audit entry naming who changed the company part, from what to what, and none when nothing changed', async () => {
    const w = await world();
    const holder = await personWith(w.org, HOLDER);
    const jane = await fx.addUser(w.org, 'audited', 'DISPATCHER');
    await withMailbox(w.org, jane, 'Aud', 'Ited');
    const api = await fx.signedInAs(holder);
    const next = `audited${tag()}`;

    expect((await api.patch('/api/organization/email-sender', { local_part: next })).status).toBe(200);
    expect((await api.patch('/api/organization/email-sender', { local_part: next })).status).toBe(200);

    await vi.waitFor(async () => {
      const rows = await db.auditLog.findMany({ where: { org_id: w.org, action: 'organization.company_part_changed' } });
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ actor_id: holder.id, resource_type: 'Organization', resource_id: w.org });
      expect(rows[0]!.metadata).toEqual({ from: w.part, to: next, people_moved: 1 });
    });
  });

  it('works for a company with no frozen part: choosing one freezes it and issues the main address', async () => {
    const w = await fx.newOrg();
    orgs.push(w.org);
    const holder = await personWith(w.org, HOLDER);
    const api = await fx.signedInAs(holder);
    const part = `fresh${tag()}`;

    const res = await api.patch('/api/organization/email-sender', { local_part: part });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const { mainAddressOf } = await import('../lib/mailbox/register.js');
    expect(await mainAddressOf(db, w.org)).toBe(`${part}@${DOMAIN}`);
  });
});
