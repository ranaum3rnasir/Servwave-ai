/* =============================================================================
   Roles & Permissions AL-16 (ticket 24, H5): migration M11 (20261028110000_organization_owner) gives every existing company
   its first Owner.

   The pick is the oldest (by created_at) of the company's people who are an Admin, active, not erased, still able to sign in,
   and have really signed in. "Really signed in" is proof of a completed sign-in, never the has_login flag (which an invite
   sets): the sign-in provider's own record of a last sign-in, or the app's own record of one (a login.succeeded,
   mfa.verified or oauth.google_finalized row). A company with no such person is listed and left without an Owner, never
   guessed. A company that already has an Owner keeps it. Every company the migration settles leaves a record: who was made
   Owner, or that no one could be.

   The migration runs here exactly as the deploy runs it, inside a transaction that is rolled back at the end, so the
   companies it builds (and the sign-in provider's table, which a plain Postgres does not have) never outlive the test.
   Real migrated database (TEST_DATABASE_URL); the suite skips when it is unset.
   ========================================================================== */

import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { randomUUID } from 'crypto';
import type { Prisma, PrismaClient } from '@prisma/client';

const { realClient } = vi.hoisted(() => {
  const dbUrl = process.env.TEST_DATABASE_URL;
  if (!dbUrl) return { realClient: undefined };
  const { PrismaClient } = require('@prisma/client') as typeof import('@prisma/client');
  return { realClient: new PrismaClient({ datasources: { db: { url: dbUrl } } }) };
});

vi.mock('../lib/prisma', () => ({ prisma: realClient }));

const suite = realClient ? describe : describe.skip;
const MIGRATION = '20261028110000_organization_owner';
const MIGRATION_SQL = join(__dirname, '..', '..', 'prisma', 'migrations', MIGRATION, 'migration.sql');

class RolledBack extends Error {}

suite('migration M11: every existing company gets its first Owner (real database)', () => {
  const db = realClient as PrismaClient;

  /** Run `body` in a transaction that is always rolled back. A failure inside it is rethrown as it is. */
  async function inRolledBackTransaction(body: (tx: Prisma.TransactionClient) => Promise<void>) {
    try {
      await db.$transaction(async (tx) => {
        await body(tx);
        throw new RolledBack();
      }, { timeout: 120_000, maxWait: 30_000 });
    } catch (err) {
      if (err instanceof RolledBack) return;
      throw err;
    }
    throw new Error('the transaction was not rolled back');
  }

  it('picks the oldest active Admin who has really signed in, lists a company with no candidate, keeps an Owner already set, and is a no-op the second time', async () => {
    await inRolledBackTransaction(async (tx) => {
      await tx.$executeRawUnsafe(`SELECT set_config('app.bypass_rls', 'on', true)`);
      // Nothing an earlier run left in the database is touched by this case: a company that has no Owner yet and a
      // candidate would be settled too, so the case asserts only on its own companies.
      const day = (n: number) => new Date(Date.UTC(2025, 0, n));
      const orgIds: string[] = [];
      async function company() {
        const id = randomUUID();
        orgIds.push(id);
        await tx.organization.create({
          data: {
            id, name: `m11-${id.slice(0, 8)}`, email: `m11-${id.slice(0, 8)}@example.test`,
            address_line1: '1 Test Way', city: 'Testville', state: 'MA', postal_code: '02108',
            estimate_terms: '', estimate_notes: '', estimate_payment_terms: '',
          },
        });
        return id;
      }
      async function person(
        org: string,
        createdDay: number,
        opts: { admin?: boolean; active?: boolean; erased?: boolean; hasLogin?: boolean; signedIn?: string; email?: string } = {},
      ) {
        const id = randomUUID();
        const email = opts.email ?? `p-${id.slice(0, 8)}@example.test`;
        await tx.user.create({
          data: {
            id, organization_id: org, email, first_name: 'M11', last_name: id.slice(0, 4), role: opts.admin === false ? 'TECHNICIAN' : 'ADMIN',
            is_admin: opts.admin ?? true, is_active: opts.active ?? true, erased_at: opts.erased ? day(28) : null,
            has_login: opts.hasLogin ?? true, created_at: day(createdDay),
          },
        });
        if (opts.signedIn) {
          await tx.auditLog.create({ data: { org_id: org, actor_id: id, actor_email: email, action: opts.signedIn, resource_type: 'User', resource_id: id } });
        }
        return { id, email };
      }

      // Company A: the oldest Admins are each ruled out for one reason; the pick is the oldest one left.
      const a = await company();
      await person(a, 1); // invited (has_login set) but never signed in
      await person(a, 2, { admin: false, signedIn: 'login.succeeded' }); // signed in, not an Admin
      await person(a, 3, { active: false, signedIn: 'login.succeeded' }); // deactivated
      await person(a, 4, { active: false, erased: true, signedIn: 'login.succeeded' }); // erased
      await person(a, 5, { hasLogin: false, signedIn: 'login.succeeded' }); // sign-in revoked
      await person(a, 6, { signedIn: 'login.failed' }); // tried and failed: not a sign-in
      await person(a, 7, { signedIn: 'login.mfa_challenged' }); // half-way: the code was never entered
      const aPick = await person(a, 8, { signedIn: 'mfa.verified' });
      await person(a, 9, { signedIn: 'login.succeeded' }); // younger

      // Company B: Admins who were invited but never signed in. No candidate: listed, left without an Owner.
      const b = await company();
      await person(b, 1);
      await person(b, 2, { signedIn: 'login.mfa_challenged' });

      // Company C: already has an Owner, who is not the oldest signed-in Admin. It keeps them.
      const c = await company();
      await person(c, 1, { signedIn: 'oauth.google_finalized' });
      const cOwner = await person(c, 5);
      await tx.organization.update({ where: { id: c }, data: { owner_user_id: cOwner.id } });

      // Company D: the sign-in provider's own record. Linked the way sign-in links a login to a person: the same id, or the
      // same CONFIRMED email.
      const d = await company();
      await tx.$executeRawUnsafe(`CREATE SCHEMA IF NOT EXISTS auth`);
      await tx.$executeRawUnsafe(
        `CREATE TABLE IF NOT EXISTS auth.users (id uuid PRIMARY KEY, email text, email_confirmed_at timestamptz, last_sign_in_at timestamptz)`,
      );
      const provider = (id: string, email: string, confirmed: boolean, signedIn: boolean) => tx.$executeRawUnsafe(
        `INSERT INTO auth.users (id, email, email_confirmed_at, last_sign_in_at) VALUES ($1::uuid, $2, $3, $4)`,
        id, email, confirmed ? day(1) : null, signedIn ? day(20) : null,
      );
      const dNever = await person(d, 1);
      await provider(dNever.id, dNever.email, true, false); // a login exists, never used
      const dUnconfirmed = await person(d, 2);
      await provider(randomUUID(), dUnconfirmed.email.toUpperCase(), false, true); // an unconfirmed email links no one
      const dPick = await person(d, 3);
      await provider(randomUUID(), dPick.email.toUpperCase(), true, true); // a confirmed email, any case, signed in
      const dById = await person(d, 4);
      await provider(dById.id, `other-${dById.email}`, true, true); // younger

      // Company E: two people whose emails differ only in case. A login matched by email alone can't say which of them it
      // is, so it credits neither; the pick is the next Admin, who signed in on the app's own record.
      const e = await company();
      const twin = `twin-${randomUUID().slice(0, 8)}@example.test`;
      await person(e, 1, { email: twin.toUpperCase() });
      await person(e, 2, { email: twin });
      await provider(randomUUID(), twin, true, true);
      const ePick = await person(e, 3, { signedIn: 'login.succeeded' });

      // Company F: a login that sign-in links by id to one person is that person's, even when its email names another.
      // It credits the person it is linked to, never the email's owner.
      const f = await company();
      const fEmailOwner = await person(f, 1);
      const fById = await person(f, 2);
      await provider(fById.id, fEmailOwner.email, true, true);

      const sql = readFileSync(MIGRATION_SQL, 'utf8');
      await tx.$executeRawUnsafe(sql);

      const ownerOf = async (org: string) =>
        (await tx.organization.findUniqueOrThrow({ where: { id: org }, select: { owner_user_id: true } })).owner_user_id;
      expect(await ownerOf(a)).toBe(aPick.id);
      expect(await ownerOf(b)).toBeNull();
      expect(await ownerOf(c)).toBe(cOwner.id);
      expect(await ownerOf(d)).toBe(dPick.id);
      expect(await ownerOf(e)).toBe(ePick.id);
      expect(await ownerOf(f)).toBe(fById.id);

      // The record of what it settled: who became Owner, and the company where no one could.
      const settled = async () =>
        (await tx.auditLog.findMany({
          where: { org_id: { in: orgIds }, action: { in: ['owner.assigned', 'owner.no_candidate'] } },
          select: { org_id: true, action: true, resource_id: true, actor_id: true, metadata: true },
        }))
          .map((r) => `${r.org_id}:${r.action}:${r.resource_id ?? '-'}:${r.actor_id ?? 'system'}:${(r.metadata as { migration?: string }).migration}`)
          .sort();
      const expected = [
        `${a}:owner.assigned:${aPick.id}:system:${MIGRATION}`,
        `${b}:owner.no_candidate:-:system:${MIGRATION}`,
        `${d}:owner.assigned:${dPick.id}:system:${MIGRATION}`,
        `${e}:owner.assigned:${ePick.id}:system:${MIGRATION}`,
        `${f}:owner.assigned:${fById.id}:system:${MIGRATION}`,
      ].sort();
      expect(await settled()).toEqual(expected);

      // A second run changes nothing and records nothing new.
      await tx.$executeRawUnsafe(sql);
      expect(await ownerOf(a)).toBe(aPick.id);
      expect(await ownerOf(b)).toBeNull();
      expect(await ownerOf(c)).toBe(cOwner.id);
      expect(await ownerOf(d)).toBe(dPick.id);
      expect(await settled()).toEqual(expected);
    });
  }, 180_000);

  it("runs for a migrating role that may not look into the sign-in provider's schema, counting the app's own sign-in records", async () => {
    await inRolledBackTransaction(async (tx) => {
      await tx.$executeRawUnsafe(`SELECT set_config('app.bypass_rls', 'on', true)`);
      // The provider's schema and table exist, but this role has no USAGE on the schema (nor does anyone but its owner).
      await tx.$executeRawUnsafe(`CREATE SCHEMA IF NOT EXISTS auth`);
      await tx.$executeRawUnsafe(
        `CREATE TABLE IF NOT EXISTS auth.users (id uuid PRIMARY KEY, email text, email_confirmed_at timestamptz, last_sign_in_at timestamptz)`,
      );
      const role = `m11_no_auth_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
      await tx.$executeRawUnsafe(`CREATE ROLE ${role} NOLOGIN`);
      await tx.$executeRawUnsafe(`REVOKE ALL ON SCHEMA auth FROM PUBLIC`);
      await tx.$executeRawUnsafe(`REVOKE ALL ON SCHEMA auth FROM ${role}`);
      // Everything else the migration reads and writes.
      await tx.$executeRawUnsafe(`GRANT USAGE ON SCHEMA ${'"' + (await currentSchema(tx)) + '"'} TO ${role}`);
      await tx.$executeRawUnsafe(`GRANT SELECT, INSERT, UPDATE ON organizations, users, audit_logs TO ${role}`);
      await tx.$executeRawUnsafe(`DO $g$ BEGIN EXECUTE format('GRANT TEMPORARY ON DATABASE %I TO ${role}', current_database()); END $g$`);

      const org = randomUUID();
      await tx.organization.create({
        data: {
          id: org, name: `m11-${org.slice(0, 8)}`, email: `m11-${org.slice(0, 8)}@example.test`,
          address_line1: '1 Test Way', city: 'Testville', state: 'MA', postal_code: '02108',
          estimate_terms: '', estimate_notes: '', estimate_payment_terms: '',
        },
      });
      const admin = randomUUID();
      await tx.user.create({
        data: { id: admin, organization_id: org, email: `p-${admin.slice(0, 8)}@example.test`, first_name: 'M11', last_name: 'Admin', role: 'ADMIN', is_admin: true },
      });
      await tx.auditLog.create({ data: { org_id: org, actor_id: admin, action: 'login.succeeded', resource_type: 'User', resource_id: admin } });

      await tx.$executeRawUnsafe(`SET LOCAL ROLE ${role}`);
      expect(await tx.$queryRawUnsafe<Array<{ usage: boolean }>>(`SELECT has_schema_privilege('auth', 'USAGE') AS usage`)).toEqual([{ usage: false }]);
      await tx.$executeRawUnsafe(readFileSync(MIGRATION_SQL, 'utf8'));
      await tx.$executeRawUnsafe(`RESET ROLE`);

      const company = await tx.organization.findUniqueOrThrow({ where: { id: org }, select: { owner_user_id: true } });
      expect(company.owner_user_id).toBe(admin);
    });
  }, 180_000);
});

async function currentSchema(tx: Prisma.TransactionClient): Promise<string> {
  return (await tx.$queryRawUnsafe<Array<{ s: string }>>(`SELECT current_schema() AS s`))[0]!.s;
}
