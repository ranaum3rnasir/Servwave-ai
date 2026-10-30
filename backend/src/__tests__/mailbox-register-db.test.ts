/* =============================================================================
   Roles & Permissions, PRD 10, slice S10.1 - the mailbox address register against a real database.

   Through the register's own interface (create a company with its main mailbox, change the company
   part, look an address up, list a mailbox's addresses), on a real migrated Postgres
   (TEST_DATABASE_URL); the suite skips when it is unset. Expected addresses are written out by hand.
   Every company it creates is removed again (the register's address rows stay, by design: an address
   once issued is never issued again).
   ========================================================================== */

import { randomUUID } from 'node:crypto';
import { describe, it, expect, afterAll, vi } from 'vitest';
import { PrismaClient } from '@prisma/client';

// This environment's mailbox domain, chosen by the setting the register reads.
vi.mock('../config/env', () => ({
  env: { MAILBOX_DOMAIN: 'staging.mail.test.com', EMAIL_FROM_BUSINESS: 'no-reply@mail.test.com' },
}));

const url = process.env.TEST_DATABASE_URL;
const suite = url ? describe : describe.skip;

const load = () => import('../lib/mailbox/register.js');

/** Letters only (a company name's digits are legal but make a poor unique tag): 10 random a-z. */
const tag = () =>
  randomUUID().replace(/-/g, '').replace(/[0-9]/g, (d) => 'abcdefghij'[Number(d)]!).slice(0, 10);

suite('mailbox address register (real database)', () => {
  const db = new PrismaClient({ datasources: { db: { url: url ?? '' } } });
  const orgs: string[] = [];

  const companyData = (name: string) => {
    const id = randomUUID();
    return {
      id, name, email: `${id.slice(0, 8)}@example.test`,
      address_line1: '1 Test Way', city: 'Testville', state: 'MA', postal_code: '02108',
      estimate_terms: '', estimate_notes: '', estimate_payment_terms: '',
    };
  };

  async function create(name: string) {
    const { createCompanyWithMainMailbox } = await load();
    const org = await createCompanyWithMainMailbox(db, companyData(name));
    orgs.push(org.id);
    return org;
  }

  /** A company that predates the register: no frozen part, no mailbox. */
  async function createLegacy(name: string, chosen?: string) {
    const data = { ...companyData(name), ...(chosen ? { email_sender_local_part: chosen } : {}) };
    const org = await db.organization.create({ data });
    orgs.push(org.id);
    return org;
  }

  afterAll(async () => {
    await db.organization.deleteMany({ where: { id: { in: orgs } } });
    await db.$disconnect();
  });

  it('freezes the part derived from the name and issues the main address on this environment’s domain', async () => {
    const { mainAddressOf } = await load();
    const t = tag();
    const org = await create(`Acme ${t} Doors & Security`);

    expect(org.email_sender_local_part).toBe(`acme${t}doorssecurity`);
    expect(await mainAddressOf(db, org.id)).toBe(`acme${t}doorssecurity@staging.mail.test.com`);
    const mailboxes = await db.mailbox.findMany({ where: { organization_id: org.id } });
    expect(mailboxes).toHaveLength(1);
    expect(mailboxes[0]).toMatchObject({ kind: 'main', status: 'active', user_id: null });
  });

  it('gives the next free variant when the derived part is taken, and freezes it then', async () => {
    const { mainAddressOf } = await load();
    const t = tag();
    const first = await create(`Acme ${t}`);
    const second = await create(`ACME ${t}!`);
    const third = await create(`acme-${t}`);

    expect(first.email_sender_local_part).toBe(`acme${t}`);
    expect(second.email_sender_local_part).toBe(`acme${t}2`);
    expect(third.email_sender_local_part).toBe(`acme${t}3`);
    expect(await mainAddressOf(db, second.id)).toBe(`acme${t}2@staging.mail.test.com`);
  });

  it('counts the derived part of a company that predates the register as taken', async () => {
    const t = tag();
    await createLegacy(`Legacy ${t} Co`);

    const fresh = await create(`Legacy ${t} Co`);

    expect(fresh.email_sender_local_part).toBe(`legacy${t}co2`);
  });

  it('counts the chosen part of a company that predates the register as taken', async () => {
    const t = tag();
    await createLegacy(`Different name ${t}`, `chosen${t}`);

    const fresh = await create(`Chosen ${t}`);

    expect(fresh.email_sender_local_part).toBe(`chosen${t}2`);
  });

  it('never issues a reserved part: a reserved or unusable name gets a generated neutral one', async () => {
    const { RESERVED_LOCAL_PARTS } = await import('../lib/mailbox/address-core.js');
    const names = [...RESERVED_LOCAL_PARTS.filter((p) => /^[a-z]+$/.test(p)), '!!! ---'];
    for (const name of names) {
      const org = await create(name);
      expect(org.email_sender_local_part, name).toMatch(/^company\d+$/);
    }
  });

  it('on two creations at once for one name, both succeed with different parts and exactly one keeps the plain part', async () => {
    const t = tag();
    const results = await Promise.allSettled(Array.from({ length: 6 }, () => create(`Race ${t}`)));

    expect(results.map((r) => r.status)).toEqual(Array(6).fill('fulfilled'));
    const parts = results.map((r) => (r as PromiseFulfilledResult<{ email_sender_local_part: string | null }>).value.email_sender_local_part);
    expect(new Set(parts).size).toBe(6);
    expect(parts.filter((p) => p === `race${t}`)).toHaveLength(1);
    expect([...parts].sort()).toEqual(
      [`race${t}`, `race${t}2`, `race${t}3`, `race${t}4`, `race${t}5`, `race${t}6`],
    );
    // and the register agrees: six distinct primary addresses, one per company
    const rows = await db.mailboxAddress.findMany({ where: { local_part: { in: parts as string[] } } });
    expect(rows).toHaveLength(6);
  });

  it('leaves nothing behind when the company itself cannot be created', async () => {
    const { createCompanyWithMainMailbox } = await load();
    const t = tag();
    const existing = await create(`Rollback ${t}`);
    // Same primary key: the organization insert fails after the part was claimed.
    await expect(
      createCompanyWithMainMailbox(db, { ...companyData(`Rollback other ${t}`), id: existing.id }),
    ).rejects.toThrow();

    expect(await db.mailboxAddress.count({ where: { local_part: { startsWith: `rollbackother${t}` } } })).toBe(0);
  });

  it('keeps the main address and the frozen part when the company is renamed', async () => {
    const { mainAddressOf } = await load();
    const t = tag();
    const org = await create(`Before ${t}`);

    await db.organization.update({ where: { id: org.id }, data: { name: `After ${t} Renamed` } });

    expect(await mainAddressOf(db, org.id)).toBe(`before${t}@staging.mail.test.com`);
    expect((await db.organization.findUniqueOrThrow({ where: { id: org.id } })).email_sender_local_part).toBe(`before${t}`);
  });

  describe('changeCompanyPart', () => {
    it('refuses a reserved part, and one any company holds (frozen, derived or issued), without naming anyone', async () => {
      const { changeCompanyPart } = await load();
      const t = tag();
      const mine = await create(`Mine ${t}`);
      await create(`Theirs ${t}`);
      await createLegacy(`Older ${t}`);
      await createLegacy(`Whatever ${t}`, `picked${t}`);

      expect(await changeCompanyPart(db, mine.id, 'noreply')).toEqual({ ok: false, reason: 'reserved' });
      expect(await changeCompanyPart(db, mine.id, 'postmaster')).toEqual({ ok: false, reason: 'reserved' });
      expect(await changeCompanyPart(db, mine.id, `theirs${t}`)).toEqual({ ok: false, reason: 'taken' });
      expect(await changeCompanyPart(db, mine.id, `older${t}`)).toEqual({ ok: false, reason: 'taken' });
      expect(await changeCompanyPart(db, mine.id, `picked${t}`)).toEqual({ ok: false, reason: 'taken' });
      expect(await changeCompanyPart(db, mine.id, 'two words')).toEqual({ ok: false, reason: 'invalid' });
    });

    it('moves the main address to the new part and keeps the old one in the register, never to be issued again', async () => {
      const { changeCompanyPart, mainAddressOf, lookupAddress, listMailboxAddresses } = await load();
      const t = tag();
      const org = await create(`Moving ${t}`);
      const mailbox = await db.mailbox.findFirstOrThrow({ where: { organization_id: org.id, kind: 'main' } });

      const result = await changeCompanyPart(db, org.id, `service${t}`);

      expect(result).toEqual({
        ok: true, part: `service${t}`, address: `service${t}@staging.mail.test.com`, derivedFromName: false,
        previousPart: `moving${t}`, changed: true, usersMoved: 0,
      });
      expect(await mainAddressOf(db, org.id)).toBe(`service${t}@staging.mail.test.com`);
      expect((await db.organization.findUniqueOrThrow({ where: { id: org.id } })).email_sender_local_part).toBe(`service${t}`);
      // the old address still resolves, to the same mailbox, and is not the primary any more
      expect(await lookupAddress(db, `moving${t}@staging.mail.test.com`)).toMatchObject({ mailboxId: mailbox.id, isPrimary: false });
      expect(await lookupAddress(db, `service${t}@staging.mail.test.com`)).toMatchObject({ mailboxId: mailbox.id, isPrimary: true });
      expect((await listMailboxAddresses(db, mailbox.id)).sort()).toEqual(
        [`moving${t}@staging.mail.test.com`, `service${t}@staging.mail.test.com`].sort(),
      );
      // another company cannot take the old part, and a new company deriving it gets a variant
      const other = await create(`Moving ${t}`);
      expect(other.email_sender_local_part).toBe(`moving${t}2`);
    });

    it('lets the company take back a part it issued before', async () => {
      const { changeCompanyPart, mainAddressOf } = await load();
      const t = tag();
      const org = await create(`Back ${t}`);
      await changeCompanyPart(db, org.id, `elsewhere${t}`);

      const result = await changeCompanyPart(db, org.id, `back${t}`);

      expect(result).toMatchObject({ ok: true, part: `back${t}` });
      expect(await mainAddressOf(db, org.id)).toBe(`back${t}@staging.mail.test.com`);
    });

    it('with no part asked for, goes back to the part the current name gives, or its next free variant', async () => {
      const { changeCompanyPart } = await load();
      const t = tag();
      const org = await create(`Name ${t}`);
      await changeCompanyPart(db, org.id, `custom${t}`);
      await db.organization.update({ where: { id: org.id }, data: { name: `Renamed ${t}` } });

      expect(await changeCompanyPart(db, org.id, null)).toMatchObject({ ok: true, part: `renamed${t}`, derivedFromName: true });
    });

    it('two companies claiming one part at once: exactly one wins, the other is told it is taken', async () => {
      const { changeCompanyPart } = await load();
      const t = tag();
      const a = await create(`Alpha ${t}`);
      const b = await create(`Beta ${t}`);

      const [ra, rb] = await Promise.all([
        changeCompanyPart(db, a.id, `wanted${t}`),
        changeCompanyPart(db, b.id, `wanted${t}`),
      ]);

      expect([ra.ok, rb.ok].sort()).toEqual([false, true]);
      expect([ra, rb].find((r) => !r.ok)).toEqual({ ok: false, reason: 'taken' });
      expect(await db.mailboxAddress.count({ where: { local_part: `wanted${t}` } })).toBe(1);
    });

    it('issues a main mailbox to a company that predates the register', async () => {
      const { changeCompanyPart, mainAddressOf } = await load();
      const t = tag();
      const legacy = await createLegacy(`Legacy change ${t}`);

      expect(await changeCompanyPart(db, legacy.id, `fresh${t}`)).toMatchObject({ ok: true });
      expect(await mainAddressOf(db, legacy.id)).toBe(`fresh${t}@staging.mail.test.com`);
    });
  });

  describe('lookupAddress', () => {
    it('resolves a reserved address to nobody, and refuses another environment’s domain', async () => {
      const { lookupAddress } = await load();
      const t = tag();
      const org = await create(`Domain ${t}`);

      expect(await lookupAddress(db, 'noreply@staging.mail.test.com')).toMatchObject({ kind: 'reserved', organizationId: null, mailboxId: null });
      expect(await lookupAddress(db, `domain${t}@mail.test.com`)).toBeNull();
      expect(await lookupAddress(db, `domain${t}@staging.mail.test.com`)).toMatchObject({ kind: 'issued', organizationId: org.id });
      expect(await lookupAddress(db, `nobody${t}@staging.mail.test.com`)).toBeNull();
    });
  });
});
