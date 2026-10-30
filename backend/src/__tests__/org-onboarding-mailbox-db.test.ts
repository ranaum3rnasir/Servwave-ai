/* =============================================================================
   Roles & Permissions, PRD 10, slice S10.1 - a company provisioned by the onboarding SQL (the batch the
   org-creation skill applies by hand) gets a frozen, unique company part and its main mailbox, exactly
   as one created through the register does.

   Runs buildCreateOrgSql's output against a real migrated database (TEST_DATABASE_URL); the suite skips
   when it is unset. Every org it creates is removed again.
   ========================================================================== */

import { describe, it, expect, afterAll } from 'vitest';
import { randomUUID } from 'crypto';
import { PrismaClient } from '@prisma/client';
import { buildCreateOrgSql } from '../lib/entitlements/ops-sql';

const url = process.env.TEST_DATABASE_URL;
const suite = url ? describe : describe.skip;

const tag = () =>
  randomUUID().replace(/-/g, '').replace(/[0-9]/g, (d) => 'abcdefghij'[Number(d)]!).slice(0, 10);

/** One statement per call - Prisma prepares what it sends, so a multi-statement string fails. */
async function run(prisma: Pick<PrismaClient, '$executeRawUnsafe'>, sql: string) {
  for (const stmt of sql.split(/;\s*\n\s*\n/).map((s) => s.trim()).filter(Boolean)) {
    await prisma.$executeRawUnsafe(stmt);
  }
}

suite('onboarding SQL issues the main mailbox (real database)', () => {
  const prisma = new PrismaClient({ datasources: { db: { url: url ?? '' } } });
  const created: string[] = [];

  const provision = async (name: string) => {
    const orgId = randomUUID();
    created.push(orgId);
    const sql = buildCreateOrgSql({
      orgId, name, email: `${orgId.slice(0, 8)}@example.test`, state: 'MA',
      addressLine1: '1 Test Way', city: 'Testville', postalCode: '02108', plan: 'STARTER', trialEndsAtISO: null,
    });
    await run(prisma, sql);
    return { orgId, sql };
  };

  const mainOf = async (orgId: string) => {
    const org = await prisma.organization.findUniqueOrThrow({ where: { id: orgId }, select: { email_sender_local_part: true } });
    const rows = await prisma.mailboxAddress.findMany({
      where: { is_primary: true, mailbox: { organization_id: orgId, kind: 'main' } },
      select: { local_part: true },
    });
    return { frozen: org.email_sender_local_part, primary: rows.map((r) => r.local_part) };
  };

  afterAll(async () => {
    await prisma.organization.deleteMany({ where: { id: { in: created } } }).catch(() => undefined);
    await prisma.$disconnect();
  });

  it('freezes the name’s part and issues one main mailbox, and applying the SQL again changes nothing', async () => {
    const t = tag();
    const { orgId, sql } = await provision(`O'Brien ${t} Plumbing`);

    expect(await mainOf(orgId)).toEqual({ frozen: `obrien${t}plumbing`, primary: [`obrien${t}plumbing`] });
    await run(prisma, sql);
    expect(await mainOf(orgId)).toEqual({ frozen: `obrien${t}plumbing`, primary: [`obrien${t}plumbing`] });
    expect(await prisma.mailbox.count({ where: { organization_id: orgId } })).toBe(1);
  });

  it('gives the next free variant to a second company with the same name', async () => {
    const t = tag();
    const first = await provision(`Twin ${t}`);
    const second = await provision(`TWIN ${t}!`);

    expect((await mainOf(first.orgId)).frozen).toBe(`twin${t}`);
    expect(await mainOf(second.orgId)).toEqual({ frozen: `twin${t}2`, primary: [`twin${t}2`] });
  });

  it('gives a reserved or unusable name a generated neutral part', async () => {
    for (const name of ['Postmaster', '!!! ---']) {
      const { orgId } = await provision(name);
      const { frozen, primary } = await mainOf(orgId);
      expect(frozen, name).toMatch(/^company\d+$/);
      expect(primary, name).toEqual([frozen]);
    }
  });
});
