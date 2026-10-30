/* =============================================================================
   Roles & Permissions, PRD 10, slice S10.3 - a user's mailbox and first.last.company address, issued by the
   register against a real database.

   Through the register's own interface (issueUserMailbox), on a real migrated Postgres (TEST_DATABASE_URL) and
   on a client holding ONE connection, as the hosted pool does: every query the register makes inside a
   transaction must go through the transaction's client or this hangs and fails. The suite skips when
   TEST_DATABASE_URL is unset. Expected addresses are written out by hand. Every company it creates is removed
   again (the register's address rows stay, by design).
   ========================================================================== */

import { randomUUID } from 'node:crypto';
import { describe, it, expect, afterAll, vi } from 'vitest';
import type { PrismaClient } from '@prisma/client';

vi.mock('../config/env', () => ({
  env: {
    MAILBOX_DOMAIN: 'staging.mail.test.com',
    EMAIL_FROM_BUSINESS: 'no-reply@mail.test.com',
    MAILBOX_ADDRESS_HASH_KEY: 'test-mailbox-hash-key-0123456789abcdef',
  },
}));

const url = process.env.TEST_DATABASE_URL;
const suite = url ? describe : describe.skip;

const load = () => import('../lib/mailbox/register.js');

/** Letters only: 8 random a-z, so a company part made from it is a legal one. */
const tag = () => randomUUID().replace(/-/g, '').replace(/[0-9]/g, (d) => 'abcdefghij'[Number(d)]!).slice(0, 8);

suite('issueUserMailbox (real database, one connection)', () => {
  const clientPromise = (async () => {
    const { oneConnectionClient } = await import('./one-connection-client.js');
    return (await oneConnectionClient(url)) as PrismaClient;
  })();
  const orgs: string[] = [];

  afterAll(async () => {
    const db = await clientPromise;
    await db.user.deleteMany({ where: { organization_id: { in: orgs } } });
    await db.organization.deleteMany({ where: { id: { in: orgs } } });
    await db.$disconnect();
  });

  /** A company that has been through the register, so it has a frozen company part. */
  async function company(name = `Acme ${tag()}`) {
    const db = await clientPromise;
    const { createCompanyWithMainMailbox } = await load();
    const id = randomUUID();
    const org = await createCompanyWithMainMailbox(db, {
      id, name, email: `${id.slice(0, 8)}@example.test`,
      address_line1: '1 Test Way', city: 'Testville', state: 'MA', postal_code: '02108',
      estimate_terms: '', estimate_notes: '', estimate_payment_terms: '',
    });
    orgs.push(org.id);
    return { id: org.id, part: org.email_sender_local_part! };
  }

  async function person(orgId: string, first: string, last: string, extra: { is_active?: boolean } = {}) {
    const db = await clientPromise;
    const id = randomUUID();
    await db.user.create({
      data: { id, organization_id: orgId, email: `${id}@example.test`, first_name: first, last_name: last, role: 'DISPATCHER', ...extra },
    });
    return { id, organization_id: orgId, first_name: first, last_name: last };
  }

  /** Issue in a transaction of its own, the way a user create does. */
  async function issue(user: { id: string; organization_id: string; first_name: string; last_name: string }) {
    const db = await clientPromise;
    const { issueUserMailbox } = await load();
    return db.$transaction((tx) => issueUserMailbox(tx, user));
  }

  const addressesOf = async (mailboxId: string) =>
    (await (await clientPromise).mailboxAddress.findMany({ where: { mailbox_id: mailboxId } })).map((a) => a.local_part);

  it('issues first.last.company as the primary address of a new user mailbox held by the user', async () => {
    const db = await clientPromise;
    const co = await company();
    const jane = await person(co.id, 'Jane', 'Smith');

    const issued = await issue(jane);

    expect(issued).toMatchObject({ status: 'active', localPart: `jane.smith.${co.part}`, created: true });
    expect(await db.mailbox.findUniqueOrThrow({ where: { id: issued.mailboxId } })).toMatchObject({
      organization_id: co.id, kind: 'user', user_id: jane.id, holder_user_id: jane.id, status: 'active',
    });
    expect(await db.mailboxAddress.findMany({ where: { mailbox_id: issued.mailboxId } })).toEqual([
      expect.objectContaining({ local_part: `jane.smith.${co.part}`, kind: 'issued', organization_id: co.id, is_primary: true }),
    ]);
  });

  it('applies the name rules: accents drop out, one name gives that name alone', async () => {
    const co = await company();
    expect((await issue(await person(co.id, "Mary-Ann", "O'Neil"))).localPart).toBe(`maryann.oneil.${co.part}`);
    expect((await issue(await person(co.id, 'Cher', ''))).localPart).toBe(`cher.${co.part}`);
    expect((await issue(await person(co.id, '', 'Prince'))).localPart).toBe(`prince.${co.part}`);
  });

  it('puts a second Jane Smith in "address needed" with no address, and never adds a number or an initial', async () => {
    const db = await clientPromise;
    const co = await company();
    const first = await issue(await person(co.id, 'Jane', 'Smith'));
    const second = await issue(await person(co.id, 'jane', 'SMITH'));

    expect(first.status).toBe('active');
    expect(second).toMatchObject({ status: 'address_needed', localPart: null, created: true });
    expect(await addressesOf(second.mailboxId)).toEqual([]);
    expect(await db.mailbox.findUniqueOrThrow({ where: { id: second.mailboxId } })).toMatchObject({ kind: 'user', status: 'address_needed' });
    // nothing like jane.smith2.<part> or j.smith.<part> was issued to anybody
    const all = await db.mailboxAddress.findMany({ where: { organization_id: co.id }, select: { local_part: true } });
    expect(all.map((a) => a.local_part).sort()).toEqual([co.part, `jane.smith.${co.part}`].sort());
  });

  it('treats a name part held by a leaver as taken: a hire named like a leaver gets no address', async () => {
    const db = await clientPromise;
    const co = await company();
    const leaver = await person(co.id, 'Jane', 'Smith');
    await issue(leaver);
    await db.user.update({ where: { id: leaver.id }, data: { is_active: false } });
    const hire = await issue(await person(co.id, 'Jane', 'Smith'));
    expect(hire.status).toBe('address_needed');

    // and still when the leaver's record is gone for good: the mailbox keeps the address row
    await db.user.delete({ where: { id: leaver.id } });
    const another = await issue(await person(co.id, 'Jane', 'Smith'));
    expect(another.status).toBe('address_needed');
    expect(await db.mailboxAddress.findUnique({ where: { local_part: `jane.smith.${co.part}` } })).not.toBeNull();
  });

  it('counts a name part issued under the company part it had BEFORE the company renamed it as taken', async () => {
    const db = await clientPromise;
    const co = await company();
    await issue(await person(co.id, 'Jane', 'Smith'));
    await db.organization.update({ where: { id: co.id }, data: { email_sender_local_part: `${co.part}new` } });

    const hire = await issue(await person(co.id, 'Jane', 'Smith'));
    expect(hire.status).toBe('address_needed');
    const other = await issue(await person(co.id, 'Ann', 'Lee'));
    expect(other.localPart).toBe(`ann.lee.${co.part}new`);
  });

  it('gives the same name in another company its own address', async () => {
    const a = await company();
    const b = await company();
    expect((await issue(await person(a.id, 'Jane', 'Smith'))).localPart).toBe(`jane.smith.${a.part}`);
    expect((await issue(await person(b.id, 'Jane', 'Smith'))).localPart).toBe(`jane.smith.${b.part}`);
  });

  it('puts a user with no usable name in "address needed"', async () => {
    const co = await company();
    for (const [first, last] of [['山田', '太郎'], ['😀', ''], ['', '']] as const) {
      expect((await issue(await person(co.id, first, last))).status, `${first}${last}`).toBe('address_needed');
    }
  });

  it('puts everyone in "address needed" when the company has no frozen part', async () => {
    const db = await clientPromise;
    const co = await company();
    await db.organization.update({ where: { id: co.id }, data: { email_sender_local_part: null } });
    const issued = await issue(await person(co.id, 'Jane', 'Smith'));
    expect(issued).toMatchObject({ status: 'address_needed', localPart: null });
  });

  it('caps the local part at 64 characters for a very long name', async () => {
    const co = await company();
    const issued = await issue(await person(co.id, 'a'.repeat(200), 'b'.repeat(200)));
    expect(issued.status).toBe('active');
    expect(issued.localPart!.length).toBeLessThanOrEqual(64);
    expect(issued.localPart!.endsWith(`.${co.part}`)).toBe(true);
  });

  it('treats an address a purged company held (kept by hash) as taken', async () => {
    const db = await clientPromise;
    const co = await company();
    const { hashLocalPart } = await import('../lib/mailbox/address-core.js');
    await db.mailboxAddress.create({
      data: { local_part: hashLocalPart(`jane.smith.${co.part}`, 'test-mailbox-hash-key-0123456789abcdef'), kind: 'purged' },
    });
    expect((await issue(await person(co.id, 'Jane', 'Smith'))).status).toBe('address_needed');
    expect((await issue(await person(co.id, 'Ann', 'Lee'))).status).toBe('active');
  });

  it('issues once: asking again for the same user returns the mailbox it has and writes nothing', async () => {
    const db = await clientPromise;
    const co = await company();
    const jane = await person(co.id, 'Jane', 'Smith');
    const first = await issue(jane);
    const again = await issue(jane);
    expect(again).toMatchObject({ mailboxId: first.mailboxId, status: 'active', localPart: `jane.smith.${co.part}`, created: false });
    expect(await db.mailbox.count({ where: { user_id: jane.id } })).toBe(1);
    expect(await db.mailboxAddress.count({ where: { mailbox_id: first.mailboxId } })).toBe(1);
  });

  it('lets two namesakes be created at the same moment: one wins, the other lands in "address needed", neither errors', async () => {
    const co = await company();
    const people = await Promise.all([person(co.id, 'Sam', 'Jones'), person(co.id, 'Sam', 'Jones'), person(co.id, 'Sam', 'Jones')]);

    const results = await Promise.allSettled(people.map((p) => issue(p)));

    expect(results.map((r) => r.status)).toEqual(['fulfilled', 'fulfilled', 'fulfilled']);
    const issued = results.map((r) => (r as PromiseFulfilledResult<Awaited<ReturnType<typeof issue>>>).value);
    expect(issued.filter((i) => i.status === 'active')).toHaveLength(1);
    expect(issued.filter((i) => i.status === 'address_needed')).toHaveLength(2);
    expect(await (await clientPromise).mailboxAddress.count({ where: { local_part: `sam.jones.${co.part}` } })).toBe(1);
  });

  it('rolls the mailbox and the address back with the transaction that issued them', async () => {
    const db = await clientPromise;
    const co = await company();
    const jane = await person(co.id, 'Jane', 'Smith');
    const { issueUserMailbox } = await load();

    await expect(
      db.$transaction(async (tx) => {
        await issueUserMailbox(tx, jane);
        throw new Error('the user create failed afterwards');
      }),
    ).rejects.toThrow('failed afterwards');

    expect(await db.mailbox.count({ where: { user_id: jane.id } })).toBe(0);
    expect(await db.mailboxAddress.count({ where: { local_part: `jane.smith.${co.part}` } })).toBe(0);
    // and the name is still free for whoever asks next
    expect((await issue(jane)).status).toBe('active');
  });

  it('is backed by the database: no second live mailbox for one user, and no second owner of an address', async () => {
    const db = await clientPromise;
    const co = await company();
    const jane = await person(co.id, 'Jane', 'Smith');
    await issue(jane);

    await expect(
      db.mailbox.create({ data: { organization_id: co.id, kind: 'user', user_id: jane.id, holder_user_id: jane.id, status: 'address_needed' } }),
    ).rejects.toMatchObject({ code: 'P2002' });
    // a merged mailbox does not count: a reactivated user gets a fresh one beside it (S10.23)
    await expect(
      db.mailbox.create({ data: { organization_id: co.id, kind: 'user', user_id: jane.id, holder_user_id: null, status: 'merged' } }),
    ).resolves.toBeTruthy();
    await expect(
      db.mailboxAddress.create({ data: { local_part: `jane.smith.${co.part}`, kind: 'issued', organization_id: co.id } }),
    ).rejects.toMatchObject({ code: 'P2002' });
  });
});
