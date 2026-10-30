/* =============================================================================
   Roles & Permissions, PRD 10, slice S10.25 - setting or changing the NAME PART of a user's mailbox address, through
   the register's own interface (setUserNamePart), against a real migrated Postgres (TEST_DATABASE_URL) on a client
   holding ONE connection, as the hosted pool does. The suite skips when TEST_DATABASE_URL is unset. Expected
   addresses are written out by hand. Every company it creates is removed again (address rows stay, by design).
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
const tag = () => randomUUID().replace(/-/g, '').replace(/[0-9]/g, (d) => 'abcdefghij'[Number(d)]!).slice(0, 8);

suite('setUserNamePart (real database, one connection)', () => {
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

  /** A person with a mailbox issued the way a user create does. */
  async function person(orgId: string, first: string, last: string) {
    const db = await clientPromise;
    const { issueUserMailbox } = await load();
    const id = randomUUID();
    await db.user.create({
      data: { id, organization_id: orgId, email: `${id}@example.test`, first_name: first, last_name: last, role: 'DISPATCHER' },
    });
    const mailbox = await db.$transaction((tx) => issueUserMailbox(tx, { id, organization_id: orgId, first_name: first, last_name: last }));
    return { id, mailboxId: mailbox.mailboxId, status: mailbox.status };
  }

  const set = async (orgId: string, userId: string, namePart: string) => {
    const { setUserNamePart } = await load();
    return setUserNamePart(await clientPromise, { organizationId: orgId, userId, namePart });
  };

  it('sets a free name part on an "address needed" mailbox, which becomes active with that address as primary', async () => {
    const db = await clientPromise;
    const co = await company();
    await person(co.id, 'Jane', 'Smith');
    const second = await person(co.id, 'Jane', 'Smith');
    expect(second.status).toBe('address_needed');

    const result = await set(co.id, second.id, 'jane.smith2');

    expect(result).toEqual({
      ok: true,
      mailboxId: second.mailboxId,
      address: `jane.smith2.${co.part}@staging.mail.test.com`,
      previousAddress: null,
      activated: true,
    });
    expect(await db.mailbox.findUniqueOrThrow({ where: { id: second.mailboxId } })).toMatchObject({ status: 'active' });
    const { ownMailboxOf } = await load();
    expect(await ownMailboxOf(db, second.id)).toEqual({
      mailboxId: second.mailboxId, status: 'active', address: `jane.smith2.${co.part}@staging.mail.test.com`,
    });
  });

  it('changes an active mailbox to a new primary address, and the old address keeps resolving to the same mailbox', async () => {
    const db = await clientPromise;
    const co = await company();
    const jane = await person(co.id, 'Jane', 'Smith');
    const { lookupAddress, listMailboxAddresses } = await load();

    const result = await set(co.id, jane.id, 'jsmith');

    expect(result).toEqual({
      ok: true,
      mailboxId: jane.mailboxId,
      address: `jsmith.${co.part}@staging.mail.test.com`,
      previousAddress: `jane.smith.${co.part}@staging.mail.test.com`,
      activated: false,
    });
    // the register never deletes: both addresses are still there, still on the one mailbox
    expect(await listMailboxAddresses(db, jane.mailboxId)).toEqual([
      `jane.smith.${co.part}@staging.mail.test.com`,
      `jsmith.${co.part}@staging.mail.test.com`,
    ]);
    expect(await lookupAddress(db, `jane.smith.${co.part}@staging.mail.test.com`)).toMatchObject({
      mailboxId: jane.mailboxId, organizationId: co.id, isPrimary: false,
    });
    expect(await lookupAddress(db, `jsmith.${co.part}@staging.mail.test.com`)).toMatchObject({
      mailboxId: jane.mailboxId, isPrimary: true,
    });
    expect(await db.mailboxAddress.count({ where: { mailbox_id: jane.mailboxId, is_primary: true } })).toBe(1);
  });

  it('refuses a name part anyone in the company holds, a leaver included, and writes nothing', async () => {
    const db = await clientPromise;
    const co = await company();
    const jane = await person(co.id, 'Jane', 'Smith');
    const leaver = await person(co.id, 'Bob', 'Lee');
    await db.user.update({ where: { id: leaver.id }, data: { is_active: false } });

    expect(await set(co.id, jane.id, 'bob.lee')).toEqual({ ok: false, reason: 'taken' });
    // the person's own current name part is taken too: nothing to change to
    expect(await set(co.id, jane.id, 'jane.smith')).toEqual({ ok: false, reason: 'taken' });
    // even once the leaver's record is gone, the address row keeps the name part taken
    await db.user.delete({ where: { id: leaver.id } });
    expect(await set(co.id, jane.id, 'bob.lee')).toEqual({ ok: false, reason: 'taken' });
    expect(await db.mailboxAddress.count({ where: { mailbox_id: jane.mailboxId } })).toBe(1);
  });

  it('counts a name part that an older address of someone else holds as taken, and ignores the case typed', async () => {
    const co = await company();
    const jane = await person(co.id, 'Jane', 'Smith');
    const ann = await person(co.id, 'Ann', 'Lee');
    expect((await set(co.id, ann.id, 'anny')).ok).toBe(true); // ann.lee is now an old address of Ann's mailbox
    expect(await set(co.id, jane.id, 'Ann.Lee')).toEqual({ ok: false, reason: 'taken' });
  });

  it('lets two companies use the same name part (their addresses end in different company parts)', async () => {
    const a = await company();
    const b = await company();
    const ja = await person(a.id, 'Jane', 'Smith');
    const jb = await person(b.id, 'Ann', 'Lee');
    expect((await set(a.id, ja.id, 'sales')).ok).toBe(true);
    expect(await set(b.id, jb.id, 'sales')).toMatchObject({ ok: true, address: `sales.${b.part}@staging.mail.test.com` });
  });

  it('refuses a malformed or reserved name part, and writes nothing', async () => {
    const db = await clientPromise;
    const co = await company();
    const jane = await person(co.id, 'Jane', 'Smith');
    for (const bad of ['', 'jane smith', 'jane@x', 'jane\r\nbcc:x', 'a'.repeat(80)]) {
      expect(await set(co.id, jane.id, bad), JSON.stringify(bad)).toEqual({ ok: false, reason: 'invalid' });
    }
    expect(await set(co.id, jane.id, 'postmaster')).toEqual({ ok: false, reason: 'reserved' });
    expect(await db.mailboxAddress.count({ where: { mailbox_id: jane.mailboxId } })).toBe(1);
  });

  it('answers a user who is not in the company as not found, and one with no live mailbox as having none', async () => {
    const db = await clientPromise;
    const a = await company();
    const b = await company();
    const stranger = await person(b.id, 'Ann', 'Lee');
    expect(await set(a.id, stranger.id, 'ann')).toEqual({ ok: false, reason: 'user_not_found' });
    expect(await set(a.id, randomUUID(), 'ann')).toEqual({ ok: false, reason: 'user_not_found' });

    const id = randomUUID();
    await db.user.create({ data: { id, organization_id: a.id, email: `${id}@example.test`, first_name: 'No', last_name: 'Box', role: 'DISPATCHER' } });
    expect(await set(a.id, id, 'nobox')).toEqual({ ok: false, reason: 'no_mailbox' });

    const merged = await person(a.id, 'Mer', 'Ged');
    await db.mailbox.update({ where: { id: merged.mailboxId }, data: { status: 'merged' } });
    expect(await set(a.id, merged.id, 'merged')).toEqual({ ok: false, reason: 'no_mailbox' });
  });

  it('refuses when the company has no frozen company part', async () => {
    const db = await clientPromise;
    const co = await company();
    const jane = await person(co.id, 'Jane', 'Smith');
    await db.organization.update({ where: { id: co.id }, data: { email_sender_local_part: null } });
    expect(await set(co.id, jane.id, 'jane')).toEqual({ ok: false, reason: 'no_company_part' });
  });

  it('serialises two admins claiming one name part at the same moment: one wins, the other is told it is taken', async () => {
    const db = await clientPromise;
    const co = await company();
    const a = await person(co.id, 'Al', 'One');
    const b = await person(co.id, 'Bo', 'Two');

    const results = await Promise.allSettled([set(co.id, a.id, 'shared'), set(co.id, b.id, 'shared')]);

    expect(results.map((r) => r.status)).toEqual(['fulfilled', 'fulfilled']);
    const values = results.map((r) => (r as PromiseFulfilledResult<Awaited<ReturnType<typeof set>>>).value);
    expect(values.filter((v) => v.ok)).toHaveLength(1);
    expect(values.filter((v) => !v.ok)).toEqual([{ ok: false, reason: 'taken' }]);
    expect(await db.mailboxAddress.count({ where: { local_part: `shared.${co.part}` } })).toBe(1);
  });

  it('never leaves a half-change: a failure after the write rolls both the old demotion and the new address back', async () => {
    const db = await clientPromise;
    const co = await company();
    const jane = await person(co.id, 'Jane', 'Smith');
    const { setUserNamePartInTransaction } = await load();

    await expect(
      db.$transaction(async (tx) => {
        const r = await setUserNamePartInTransaction(tx, { organizationId: co.id, userId: jane.id, namePart: 'jsmith' });
        expect(r.ok).toBe(true);
        throw new Error('the audit write failed');
      }),
    ).rejects.toThrow('audit write failed');

    expect(await db.mailboxAddress.findMany({ where: { mailbox_id: jane.mailboxId } })).toEqual([
      expect.objectContaining({ local_part: `jane.smith.${co.part}`, is_primary: true }),
    ]);
  });
});
