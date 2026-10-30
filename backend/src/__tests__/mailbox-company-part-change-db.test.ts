/* =============================================================================
   Roles & Permissions, PRD 10, slice S10.26 - changing a company's part, through the register's own interface
   (changeCompanyPart), against a real migrated Postgres (TEST_DATABASE_URL) on a client holding ONE connection, as the
   hosted pool does. The suite skips when TEST_DATABASE_URL is unset. Expected addresses are written out by hand.
   Every company it creates is removed again (address rows stay, by design: an address once issued is never reissued).

   What a change must do: the main mailbox AND every user mailbox get a new primary address under the new part; every
   old address stays in the register on the same mailbox and keeps resolving; the work does not grow with the number
   of people; a part anyone holds (chosen, derived, issued, purged) or the reserved list is refused with one answer,
   and two companies claiming one part at the same moment never both win.
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
const DOMAIN = 'staging.mail.test.com';

suite('changeCompanyPart (real database, one connection)', () => {
  const statements: string[] = [];
  const clientPromise = (async () => {
    const { PrismaClient } = await import('@prisma/client');
    const pooled = new URL(url ?? 'postgresql://x@127.0.0.1/x');
    pooled.searchParams.set('connection_limit', '1');
    pooled.searchParams.set('pool_timeout', '4');
    const client = new PrismaClient({ datasources: { db: { url: pooled.toString() } }, log: [{ emit: 'event', level: 'query' }] });
    (client as unknown as { $on: (e: string, cb: (q: { query: string }) => void) => void }).$on('query', (q) => statements.push(q.query));
    return client as PrismaClient;
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

  /** A company that predates the register: no frozen part, no mailbox. */
  async function legacyCompany(name: string) {
    const db = await clientPromise;
    const id = randomUUID();
    await db.organization.create({
      data: {
        id, name, email: `${id.slice(0, 8)}@example.test`,
        address_line1: '1 Test Way', city: 'Testville', state: 'MA', postal_code: '02108',
        estimate_terms: '', estimate_notes: '', estimate_payment_terms: '',
      },
    });
    orgs.push(id);
    return { id };
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

  const change = async (orgId: string, wanted: string | null) => {
    const { changeCompanyPart } = await load();
    return changeCompanyPart(await clientPromise, orgId, wanted);
  };

  it('issues a new primary address for the main mailbox and every user mailbox, and every old address keeps resolving to the same mailbox', async () => {
    const db = await clientPromise;
    const { lookupAddress, mainAddressOf, ownMailboxOf } = await load();
    const co = await company();
    const main = await db.mailbox.findFirstOrThrow({ where: { organization_id: co.id, kind: 'main' } });
    const jane = await person(co.id, 'Jane', 'Smith');
    const omar = await person(co.id, 'Omar', 'Haddad');
    const t = tag();

    const result = await change(co.id, `service${t}`);

    expect(result).toMatchObject({ ok: true, part: `service${t}`, address: `service${t}@${DOMAIN}`, previousPart: co.part, changed: true, usersMoved: 2 });
    expect(await mainAddressOf(db, co.id)).toBe(`service${t}@${DOMAIN}`);
    expect((await ownMailboxOf(db, jane.id))?.address).toBe(`jane.smith.service${t}@${DOMAIN}`);
    expect((await ownMailboxOf(db, omar.id))?.address).toBe(`omar.haddad.service${t}@${DOMAIN}`);
    // every old address is still in the register, on the same mailbox, no longer primary
    expect(await lookupAddress(db, `${co.part}@${DOMAIN}`)).toMatchObject({ mailboxId: main.id, isPrimary: false, organizationId: co.id });
    expect(await lookupAddress(db, `jane.smith.${co.part}@${DOMAIN}`)).toMatchObject({ mailboxId: jane.mailboxId, isPrimary: false });
    expect(await lookupAddress(db, `omar.haddad.${co.part}@${DOMAIN}`)).toMatchObject({ mailboxId: omar.mailboxId, isPrimary: false });
    // the new ones resolve to the same mailboxes, as primary
    expect(await lookupAddress(db, `jane.smith.service${t}@${DOMAIN}`)).toMatchObject({ mailboxId: jane.mailboxId, isPrimary: true });
    expect(await lookupAddress(db, `service${t}@${DOMAIN}`)).toMatchObject({ mailboxId: main.id, isPrimary: true });
  });

  it('carries a changed name part across: the person keeps the name part they have now', async () => {
    const db = await clientPromise;
    const { setUserNamePart, ownMailboxOf } = await load();
    const co = await company();
    const jane = await person(co.id, 'Jane', 'Smith');
    await setUserNamePart(db, { organizationId: co.id, userId: jane.id, namePart: 'jsmith' });
    const t = tag();

    await change(co.id, `renamed${t}`);

    expect((await ownMailboxOf(db, jane.id))?.address).toBe(`jsmith.renamed${t}@${DOMAIN}`);
    const rows = await db.mailboxAddress.findMany({ where: { mailbox_id: jane.mailboxId } });
    expect(rows.map((r) => r.local_part).sort()).toEqual([`jane.smith.${co.part}`, `jsmith.${co.part}`, `jsmith.renamed${t}`].sort());
  });

  it('leaves a person in "address needed" without an address, and a namesake rule that survives the change', async () => {
    const db = await clientPromise;
    const { ownMailboxOf } = await load();
    const co = await company();
    await person(co.id, 'Jane', 'Smith');
    const second = await person(co.id, 'Jane', 'Smith');
    expect(second.status).toBe('address_needed');
    const t = tag();

    await change(co.id, `fresh${t}`);

    expect(await ownMailboxOf(db, second.id)).toMatchObject({ status: 'address_needed', address: null });
    expect(await db.mailboxAddress.count({ where: { mailbox_id: second.mailboxId } })).toBe(0);
    // a name part taken under the OLD company part is still taken under the new one
    const third = await person(co.id, 'Jane', 'Smith');
    expect(third.status).toBe('address_needed');
  });

  it('changing back to an earlier part makes the old addresses primary again instead of duplicating them', async () => {
    const db = await clientPromise;
    const { ownMailboxOf, mainAddressOf, listMailboxAddresses } = await load();
    const co = await company();
    const jane = await person(co.id, 'Jane', 'Smith');
    const t = tag();
    await change(co.id, `elsewhere${t}`);

    const back = await change(co.id, co.part);

    expect(back).toMatchObject({ ok: true, part: co.part, changed: true, usersMoved: 1 });
    expect((await ownMailboxOf(db, jane.id))?.address).toBe(`jane.smith.${co.part}@${DOMAIN}`);
    expect(await mainAddressOf(db, co.id)).toBe(`${co.part}@${DOMAIN}`);
    expect((await listMailboxAddresses(db, jane.mailboxId)).sort()).toEqual(
      [`jane.smith.${co.part}@${DOMAIN}`, `jane.smith.elsewhere${t}@${DOMAIN}`].sort(),
    );
    expect(await db.mailboxAddress.count({ where: { mailbox_id: jane.mailboxId, is_primary: true } })).toBe(1);
  });

  it('saving the part the company already has changes nothing and says so', async () => {
    const db = await clientPromise;
    const co = await company();
    await person(co.id, 'Jane', 'Smith');
    const before = await db.mailboxAddress.count({ where: { organization_id: co.id } });

    const result = await change(co.id, co.part);

    expect(result).toMatchObject({ ok: true, part: co.part, changed: false, usersMoved: 0 });
    expect(await db.mailboxAddress.count({ where: { organization_id: co.id } })).toBe(before);
  });

  it('the work does not grow with the number of people: the same statements for 2 people and for 40', async () => {
    const small = await company();
    await person(small.id, 'Ann', 'One');
    await person(small.id, 'Ben', 'Two');
    const large = await company();
    for (let i = 0; i < 40; i += 1) await person(large.id, `First${i}`, `Last${i}`);

    const countFor = async (orgId: string) => {
      const before = statements.length;
      expect(await change(orgId, `many${tag()}`)).toMatchObject({ ok: true });
      return statements.length - before;
    };
    const forSmall = await countFor(small.id);
    const forLarge = await countFor(large.id);

    expect(forLarge).toBe(forSmall);
    const db = await clientPromise;
    expect(await db.mailboxAddress.count({ where: { organization_id: large.id, is_primary: true } })).toBe(41);
  });

  it('a company with no frozen part can choose one: it is frozen and the main mailbox is issued; people in "address needed" stay so', async () => {
    const db = await clientPromise;
    const { mainAddressOf } = await load();
    const legacy = await legacyCompany(`Legacy ${tag()}`);
    const person1 = await person(legacy.id, 'Jane', 'Smith');
    expect(person1.status).toBe('address_needed');
    const t = tag();

    const result = await change(legacy.id, `chosen${t}`);

    expect(result).toMatchObject({ ok: true, part: `chosen${t}`, previousPart: null, changed: true, usersMoved: 0 });
    expect(await mainAddressOf(db, legacy.id)).toBe(`chosen${t}@${DOMAIN}`);
    expect((await db.organization.findUniqueOrThrow({ where: { id: legacy.id } })).email_sender_local_part).toBe(`chosen${t}`);
    expect(await db.mailbox.findUniqueOrThrow({ where: { id: person1.mailboxId } })).toMatchObject({ status: 'address_needed' });
  });

  it('refuses a part another company holds, chosen, derived, issued or purged, with the one answer, and a reserved one with its own', async () => {
    const db = await clientPromise;
    const { reservePurgedAddresses } = await load();
    const t = tag();
    const mine = await company(`Mine ${t}`);
    await company(`Chosen ${t}`);
    await legacyCompany(`Derived ${t}`);
    const gone = await company(`Gone ${t}`);
    await db.$transaction((tx) => reservePurgedAddresses(tx, gone.id));
    await db.organization.update({ where: { id: gone.id }, data: { email_sender_local_part: null, name: `Renamed after purge ${t}` } });
    const before = await db.mailboxAddress.count();

    const taken = { ok: false, reason: 'taken' };
    expect(await change(mine.id, `chosen${t}`)).toEqual(taken);
    expect(await change(mine.id, `derived${t}`)).toEqual(taken);
    expect(await change(mine.id, `gone${t}`)).toEqual(taken);
    expect(await change(mine.id, 'noreply')).toEqual({ ok: false, reason: 'reserved' });
    expect(await change(mine.id, 'no-reply')).toEqual({ ok: false, reason: 'reserved' });
    expect(await change(mine.id, 'postmaster')).toEqual({ ok: false, reason: 'reserved' });
    expect(await change(mine.id, 'has space')).toEqual({ ok: false, reason: 'invalid' });
    // a refusal writes nothing
    expect(await db.mailboxAddress.count()).toBe(before);
    expect((await db.organization.findUniqueOrThrow({ where: { id: mine.id } })).email_sender_local_part).toBe(mine.part);
  });

  it('refuses a part that would push a person\'s address past 64 characters, and changes nothing', async () => {
    const db = await clientPromise;
    const co = await company(`Long ${tag()}`);
    await person(co.id, 'Maximiliano', 'Montgomeryworthington');
    const before = await db.mailboxAddress.count({ where: { organization_id: co.id } });

    const result = await change(co.id, `${tag()}${'x'.repeat(32)}`);

    expect(result).toEqual({ ok: false, reason: 'too_long' });
    expect(await db.mailboxAddress.count({ where: { organization_id: co.id } })).toBe(before);
    expect((await db.organization.findUniqueOrThrow({ where: { id: co.id } })).email_sender_local_part).toBe(co.part);
  });

  it('two companies claiming one part at the same moment: exactly one wins, the other is told it is taken', async () => {
    const db = await clientPromise;
    const a = await company();
    const b = await company();
    const c = await company();
    const part = `race${tag()}`;
    const { changeCompanyPart } = await load();

    const results = await Promise.all([a, b, c].map((co) => changeCompanyPart(db, co.id, part)));

    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(results.filter((r) => !r.ok)).toEqual([{ ok: false, reason: 'taken' }, { ok: false, reason: 'taken' }]);
    expect(await db.mailboxAddress.count({ where: { local_part: part } })).toBe(1);
    expect(await db.organization.count({ where: { email_sender_local_part: part } })).toBe(1);
  });

  it('a writer that skipped the register\'s lock loses to the database: the same "taken", never an error', async () => {
    const db = await clientPromise;
    const mine = await company();
    const part = `sneak${tag()}`;
    // A second client, since the first holds one connection: it inserts the part and holds the transaction open.
    const { PrismaClient } = await import('@prisma/client');
    const rival = new PrismaClient({ datasources: { db: { url } } });
    try {
      let release!: () => void;
      const held = new Promise<void>((r) => { release = r; });
      let inserted!: () => void;
      const ready = new Promise<void>((r) => { inserted = r; });
      const rivalTx = rival.$transaction(async (tx) => {
        await tx.mailboxAddress.create({ data: { local_part: part, kind: 'issued' } });
        inserted();
        await held;
      });
      await ready;
      const { changeCompanyPart } = await load();
      const mineResult = changeCompanyPart(db, mine.id, part);
      // let the claim reach the unique index and wait on the rival's uncommitted row
      await new Promise((r) => setTimeout(r, 400));
      release();
      await rivalTx;
      expect(await mineResult).toEqual({ ok: false, reason: 'taken' });
    } finally {
      await rival.$disconnect();
    }
    expect((await db.organization.findUniqueOrThrow({ where: { id: mine.id } })).email_sender_local_part).toBe(mine.part);
  });
});
