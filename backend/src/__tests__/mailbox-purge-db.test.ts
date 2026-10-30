/* =============================================================================
   Roles & Permissions, PRD 10, slice S10.2 - a purged company's addresses stay reserved as keyed hashes.

   Through the real company purge (purgeOrganization) and the register's own interface, on a real migrated
   Postgres (TEST_DATABASE_URL); the suite skips when it is unset. Each case builds a company with its main
   mailbox and a user mailbox, purges it, and asks the register what it still holds and what it will issue.
   ========================================================================== */

import { randomUUID } from 'node:crypto';
import { describe, it, expect, afterAll, vi } from 'vitest';
import { PrismaClient } from '@prisma/client';

const KEY = 'purge-test-key-0123456789abcdef0123456789';

// This environment's mailbox domain and the hash key, both read from configuration. A plain object so a
// case can take the key away.
const mockEnv = vi.hoisted(() => ({
  MAILBOX_DOMAIN: 'staging.mail.test.com' as string | undefined,
  EMAIL_FROM_BUSINESS: 'no-reply@mail.test.com',
  MAILBOX_ADDRESS_HASH_KEY: undefined as string | undefined,
}));
vi.mock('../config/env', () => ({ env: mockEnv }));
// purge.ts imports the app's shared client; the purge runs on the transaction handed to it.
vi.mock('../lib/prisma', () => ({ prisma: {} }));

const url = process.env.TEST_DATABASE_URL;
const suite = url ? describe : describe.skip;

const loadRegister = () => import('../lib/mailbox/register.js');
const loadPurge = () => import('../lib/purge.js');

/** Letters only: 10 random a-z, so a company name and the addresses built on it are unique per case. */
const tag = () =>
  randomUUID().replace(/-/g, '').replace(/[0-9]/g, (d) => 'abcdefghij'[Number(d)]!).slice(0, 10);

suite('a purged company keeps its addresses only as keyed hashes (real database)', () => {
  const db = new PrismaClient({ datasources: { db: { url: url ?? '' } } });
  const orgs: string[] = [];
  const purgedRowIds: string[] = [];

  /** A company with its main mailbox, a user mailbox and that user's address. */
  async function companyWithUserMailbox(t: string) {
    const { createCompanyWithMainMailbox } = await loadRegister();
    const id = randomUUID();
    const org = await createCompanyWithMainMailbox(db, {
      id, name: `Purge ${t} Doors`, email: `${id.slice(0, 8)}@example.test`,
      address_line1: '1 Test Way', city: 'Testville', state: 'MA', postal_code: '02108',
      estimate_terms: '', estimate_notes: '', estimate_payment_terms: '',
    });
    orgs.push(org.id);
    const userMailbox = await db.mailbox.create({
      data: { organization_id: org.id, kind: 'user', status: 'active' },
      select: { id: true },
    });
    await db.mailboxAddress.create({
      data: {
        local_part: `jane.smith.purge${t}doors`, kind: 'issued',
        organization_id: org.id, mailbox_id: userMailbox.id, is_primary: true,
      },
    });
    return org;
  }

  async function purge(orgId: string, name: string) {
    const { purgeOrganization } = await loadPurge();
    purgedRowIds.push(...(await addressRowIds(orgId)));
    await db.$transaction((tx) => purgeOrganization(tx, orgId, name));
  }

  /** The ids of the company's register rows, taken before its purge: the rows a purge must not leave readable. */
  async function addressRowIds(orgId: string): Promise<string[]> {
    const rows = await db.mailboxAddress.findMany({ where: { organization_id: orgId }, select: { id: true } });
    return rows.map((r) => r.id);
  }

  /** Those rows, whole and as text: what a person reading the table would see. */
  async function registerText(ids: string[]): Promise<string> {
    const rows = await db.$queryRaw<{ t: string }[]>`
      SELECT row_to_json(a)::text AS t FROM mailbox_addresses a WHERE a.id = ANY(${ids}::uuid[])`;
    return rows.map((r) => r.t).join('\n');
  }

  afterAll(async () => {
    // Rows are never deleted by the app; the test removes its own so the shared test database stays clean.
    await db.mailboxAddress.deleteMany({ where: { id: { in: purgedRowIds } } });
    await db.organization.deleteMany({ where: { id: { in: orgs } } });
    await db.$disconnect();
  });

  it('leaves no readable address, person name or company name for the company in the register', async () => {
    mockEnv.MAILBOX_ADDRESS_HASH_KEY = KEY;
    const t = tag();
    const org = await companyWithUserMailbox(t);
    const ids = await addressRowIds(org.id);
    expect(ids).toHaveLength(2);
    const before = await registerText(ids);
    expect(before).toContain(`purge${t}doors`); // the rows exist and are readable before
    expect(before).toContain('jane.smith');

    await purge(org.id, `Purge ${t}`);

    // Both of the company's addresses are still rows, as reservations belonging to nobody.
    const kept = await db.mailboxAddress.findMany({ where: { id: { in: ids } } });
    expect(kept).toHaveLength(2);
    const after = await registerText(ids);
    expect(after).not.toContain(`purge${t}doors`);
    expect(after).not.toContain('jane');
    expect(after).not.toContain('smith');
    expect(after).not.toContain(org.id);
    for (const row of kept) {
      expect(row.kind).toBe('purged');
      expect(row).toMatchObject({ organization_id: null, mailbox_id: null, is_primary: false });
      expect(row.local_part).toMatch(/^purged:[0-9a-f]{64}$/);
    }
    expect(await db.mailbox.count({ where: { organization_id: org.id } })).toBe(0);
  });

  it('still refuses each of the purged addresses: as a company part, as a Sender Address change and as a user address', async () => {
    mockEnv.MAILBOX_ADDRESS_HASH_KEY = KEY;
    const { createCompanyWithMainMailbox, changeCompanyPart, isAddressFree, mainAddressOf } = await loadRegister();
    const t = tag();
    const org = await companyWithUserMailbox(t);
    await purge(org.id, `Purge ${t}`);

    // A new company whose name derives the purged part gets the next free variant, never the purged part.
    const id = randomUUID();
    const again = await createCompanyWithMainMailbox(db, {
      id, name: `Purge ${t} Doors`, email: `${id.slice(0, 8)}@example.test`,
      address_line1: '1 Test Way', city: 'Testville', state: 'MA', postal_code: '02108',
      estimate_terms: '', estimate_notes: '', estimate_payment_terms: '',
    });
    orgs.push(again.id);
    expect(again.email_sender_local_part).toBe(`purge${t}doors2`);
    expect(await mainAddressOf(db, again.id)).toBe(`purge${t}doors2@staging.mail.test.com`);

    // A Sender Address change to the purged part is refused as taken.
    expect(await changeCompanyPart(db, again.id, `purge${t}doors`)).toEqual({ ok: false, reason: 'taken' });

    // A user address on the purged company is not free either, on any case, and an unrelated one is.
    expect(await isAddressFree(db, `jane.smith.purge${t}doors@staging.mail.test.com`)).toBe(false);
    expect(await isAddressFree(db, `Jane.Smith.Purge${t}Doors@staging.mail.test.com`)).toBe(false);
    expect(await isAddressFree(db, `purge${t}doors@staging.mail.test.com`)).toBe(false);
    expect(await isAddressFree(db, `john.smith.purge${t}doors@staging.mail.test.com`)).toBe(true);
  });

  it('fails the purge loudly with no key, storing nothing readable and deleting nothing', async () => {
    mockEnv.MAILBOX_ADDRESS_HASH_KEY = KEY;
    const t = tag();
    const org = await companyWithUserMailbox(t);
    const ids = await addressRowIds(org.id);

    mockEnv.MAILBOX_ADDRESS_HASH_KEY = undefined;
    await expect(purge(org.id, `Purge ${t}`)).rejects.toThrow(/hash key/i);

    // The purge rolled back: the company and both rows are exactly as they were, and nothing was
    // rewritten into a half-hashed state.
    expect(await db.organization.count({ where: { id: org.id } })).toBe(1);
    expect(await db.mailboxAddress.count({ where: { organization_id: org.id, kind: 'issued' } })).toBe(2);
    expect(await registerText(ids)).toContain(`jane.smith.purge${t}doors`);
  });

  it('keeps answering for plain addresses when the key is gone, without throwing', async () => {
    mockEnv.MAILBOX_ADDRESS_HASH_KEY = KEY;
    const { isAddressFree } = await loadRegister();
    const t = tag();
    const org = await companyWithUserMailbox(t);
    await purge(org.id, `Purge ${t}`);

    mockEnv.MAILBOX_ADDRESS_HASH_KEY = undefined;
    expect(await isAddressFree(db, `anyone.at.all${t}@staging.mail.test.com`)).toBe(true);
    expect(await isAddressFree(db, 'postmaster@staging.mail.test.com')).toBe(false);
  });

  it('keeps another company’s addresses readable and the email suppression list untouched', async () => {
    mockEnv.MAILBOX_ADDRESS_HASH_KEY = KEY;
    const t = tag();
    const doomed = await companyWithUserMailbox(t);
    const t2 = tag();
    const survivor = await companyWithUserMailbox(t2);
    const survivorIds = await addressRowIds(survivor.id);
    const suppressed = await db.emailSuppression.create({
      data: { address: `bounced.${t}@example.test`, kind: 'HARD_BOUNCE', organization_id: doomed.id },
    });

    await purge(doomed.id, `Purge ${t}`);

    expect(await registerText(survivorIds)).toContain(`jane.smith.purge${t2}doors`);
    expect(await db.mailboxAddress.count({ where: { organization_id: survivor.id } })).toBe(2);
    expect(await db.emailSuppression.findUnique({ where: { id: suppressed.id } })).toMatchObject({
      address: `bounced.${t}@example.test`,
    });
    await db.emailSuppression.delete({ where: { id: suppressed.id } });
  });
});
