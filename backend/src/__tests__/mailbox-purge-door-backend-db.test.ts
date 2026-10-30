/* =============================================================================
   Roles & Permissions, PRD 10, slice S10.2 (fix round 1) - a door backend can tear down its test companies.

   The end-to-end harness starts a backend with E2E_TEST_DOORS=true and tears each provisioned company down
   through purgeOrganization, and every provisioned company has a main mailbox with an address row. The
   purge needs MAILBOX_ADDRESS_HASH_KEY, so the harness supplies one when none is configured; any other
   process with no key still fails the purge loudly.

   These cases run the REAL config/env module (not the global stub) under a controlled process
   environment, and the real purge and register on a real migrated Postgres (TEST_DATABASE_URL); the suite
   skips when it is unset.
   ========================================================================== */

import { randomUUID } from 'node:crypto';
import { describe, it, expect, afterAll, afterEach, beforeEach, vi } from 'vitest';
import { PrismaClient } from '@prisma/client';

// purge.ts imports the app's shared client; the purge runs on the transaction handed to it.
vi.mock('../lib/prisma', () => ({ prisma: {} }));

const url = process.env.TEST_DATABASE_URL;
const suite = url ? describe : describe.skip;

const ENV_KEYS = ['E2E_TEST_DOORS', 'NODE_ENV', 'MAILBOX_ADDRESS_HASH_KEY', 'MAILBOX_DOMAIN', 'DATABASE_URL', 'SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY'] as const;

/** Letters only: 10 random a-z, so a company name and the addresses built on it are unique per case. */
const tag = () =>
  randomUUID().replace(/-/g, '').replace(/[0-9]/g, (d) => 'abcdefghij'[Number(d)]!).slice(0, 10);

suite('a door backend with no configured key tears down a provisioned company (real database)', () => {
  const db = new PrismaClient({ datasources: { db: { url: url ?? '' } } });
  const orgs: string[] = [];
  const purgedRowIds: string[] = [];
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const k of ENV_KEYS) saved[k] = process.env[k];
  });
  afterEach(() => {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    vi.doUnmock('../config/env');
    vi.resetModules();
  });
  afterAll(async () => {
    await db.mailboxAddress.deleteMany({ where: { id: { in: purgedRowIds } } });
    await db.organization.deleteMany({ where: { id: { in: orgs } } });
    await db.$disconnect();
  });

  /** Boot the backend's configuration the way a process with `processEnv` would, then load the register and the purge on it. */
  async function bootWith(processEnv: { E2E_TEST_DOORS?: string; NODE_ENV: string; key?: string }) {
    process.env.NODE_ENV = processEnv.NODE_ENV;
    // Set even when empty, for both: dotenv never overrides a variable that is already present, so a door flag or a
    // key in a developer's backend/.env cannot leak into the case (a deleted flag would be read back from the file).
    process.env.E2E_TEST_DOORS = processEnv.E2E_TEST_DOORS ?? '';
    process.env.MAILBOX_ADDRESS_HASH_KEY = processEnv.key ?? '';
    process.env.MAILBOX_DOMAIN = 'staging.mail.test.com';
    process.env.DATABASE_URL = url;
    process.env.SUPABASE_URL = 'https://test.example.test';
    process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-service-role-key';
    vi.resetModules();
    vi.doMock('../config/env', () => vi.importActual('../config/env'));
    const register = await import('../lib/mailbox/register.js');
    const purge = await import('../lib/purge.js');
    return { register, purge };
  }

  /** A provisioned test company: its main mailbox and address row, as the doors' provisioning leaves it. */
  async function provisionedCompany(register: typeof import('../lib/mailbox/register.js'), t: string) {
    const id = randomUUID();
    const org = await register.createCompanyWithMainMailbox(db, {
      id, name: `e2e-qa-${t}`, email: `${id.slice(0, 8)}@example.test`,
      address_line1: '1 Test Way', city: 'Testville', state: 'MA', postal_code: '02108',
      estimate_terms: '', estimate_notes: '', estimate_payment_terms: '',
    });
    orgs.push(org.id);
    return org;
  }

  it('purges the company: its address rows become purged hashes, none readable', async () => {
    const { register, purge } = await bootWith({ E2E_TEST_DOORS: 'true', NODE_ENV: 'development' });
    const t = tag();
    const org = await provisionedCompany(register, t);
    const ids = (await db.mailboxAddress.findMany({ where: { organization_id: org.id }, select: { id: true } })).map((r) => r.id);
    expect(ids.length).toBeGreaterThan(0);
    purgedRowIds.push(...ids);

    await db.$transaction((tx) => purge.purgeOrganization(tx, org.id, 'e2e-qa-'));

    expect(await db.organization.count({ where: { id: org.id } })).toBe(0);
    const kept = await db.mailboxAddress.findMany({ where: { id: { in: ids } } });
    expect(kept).toHaveLength(ids.length);
    for (const row of kept) {
      expect(row.kind).toBe('purged');
      expect(row.local_part).toMatch(/^purged:[0-9a-f]{64}$/);
      expect(row.local_part).not.toContain(t);
    }
  });

  it('lets a key the person configured win over the harness key', async () => {
    const own = 'my-own-key-0123456789abcdef0123456789';
    const t = tag();
    const first = await bootWith({ E2E_TEST_DOORS: 'true', NODE_ENV: 'development', key: own });
    const org = await provisionedCompany(first.register, t);
    const address = await first.register.mainAddressOf(db, org.id);
    purgedRowIds.push(...(await db.mailboxAddress.findMany({ where: { organization_id: org.id }, select: { id: true } })).map((r) => r.id));
    await db.$transaction((tx) => first.purge.purgeOrganization(tx, org.id, 'e2e-qa-'));

    // Hashed under the person's key: refused under it, and not recognised under the harness key.
    expect(await first.register.isAddressFree(db, address!)).toBe(false);
    const harness = await bootWith({ E2E_TEST_DOORS: 'true', NODE_ENV: 'development' });
    expect(await harness.register.isAddressFree(db, address!)).toBe(true);
  });

  it('still fails the purge loudly in a process that is not a door backend, storing nothing', async () => {
    const { register, purge } = await bootWith({ NODE_ENV: 'development' });
    const org = await provisionedCompany(register, tag());
    const ids = (await db.mailboxAddress.findMany({ where: { organization_id: org.id }, select: { id: true } })).map((r) => r.id);
    purgedRowIds.push(...ids);

    await expect(db.$transaction((tx) => purge.purgeOrganization(tx, org.id, 'e2e-qa-'))).rejects.toThrow(/hash key/i);

    expect(await db.organization.count({ where: { id: org.id } })).toBe(1);
    expect(await db.mailboxAddress.count({ where: { id: { in: ids }, kind: 'issued' } })).toBe(ids.length);
  });
});
