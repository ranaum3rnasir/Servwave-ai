/**
 * Real-DB smoke test for the Org Settings schema (#115).
 *
 * Every other settings suite mocks Prisma, so the whole class of real-schema
 * failures — e.g. migration `20260603120000_org_settings` being committed but
 * UNAPPLIED — is invisible to CI (the mocked client never touches the new
 * columns/table). This test exercises the exact DB access the settings
 * controllers perform against a REAL database, so it fails loudly if a committed
 * migration has not been applied.
 *
 * Skipped by default. To run (CI runs this AFTER `prisma migrate deploy`):
 *   1. Point DATABASE_URL at a non-production Postgres with migrations applied
 *   2. `RUN_INTEGRATION_TESTS=1 npx vitest run src/__tests__/org-settings.integration.test.ts`
 *
 * Mirrors the gating + dynamic-import pattern of `numbering.integration.test.ts`
 * so the real PrismaClient is used (not the global test mock at setup.ts).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import dotenv from 'dotenv';

dotenv.config();

const enabled =
  process.env.RUN_INTEGRATION_TESTS === '1' &&
  typeof process.env.DATABASE_URL === 'string' &&
  !process.env.DATABASE_URL.includes('test:test@localhost');

describe.skipIf(!enabled)('Org Settings schema — real-DB smoke', () => {
  let prisma: any;
  const ORG_ID = '00000000-0000-0000-0000-0000000005e7';

  beforeAll(async () => {
    const prismaPkg = await import('@prisma/client');
    prisma = new prismaPkg.PrismaClient();
    await prisma.location.deleteMany({ where: { organization_id: ORG_ID } });
    await prisma.organization.deleteMany({ where: { id: ORG_ID } });
    await prisma.organization.create({
      data: { id: ORG_ID, plan: 'SCALE', name: 'Smoke Test Org', address_line1: '1 Test St', city: 'Testville', state: 'NY' },
    });
  });

  afterAll(async () => {
    if (!prisma) return;
    await prisma.location.deleteMany({ where: { organization_id: ORG_ID } });
    await prisma.organization.deleteMany({ where: { id: ORG_ID } });
    await prisma.$disconnect();
  });

  it('materializes the full organization row (no missing columns)', async () => {
    // getOrganization() has no `select`, so it reads every column. If a new
    // Org Settings column is missing from the DB, Prisma raises P2022 here.
    const org = await prisma.organization.findUnique({ where: { id: ORG_ID } });
    expect(org).not.toBeNull();
    // touch the columns added by the org_settings migration
    expect(org).toHaveProperty('display_name');
    expect(org).toHaveProperty('currency');
    expect(org).toHaveProperty('mfa_sms_enabled');
    expect(org).toHaveProperty('mailing_country');
  });

  it('persists a write to the new profile columns', async () => {
    const updated = await prisma.organization.update({
      where: { id: ORG_ID },
      data: { display_name: 'Smoke DBA', currency: 'USD', mfa_sms_enabled: true },
    });
    expect(updated.display_name).toBe('Smoke DBA');
    expect(updated.mfa_sms_enabled).toBe(true);
  });

  it('round-trips the new Location table', async () => {
    const loc = await prisma.location.create({
      data: { organization_id: ORG_ID, name: 'Branch A', code: 'BRANCH-A' },
    });
    expect(loc.id).toBeTruthy();
    const found = await prisma.location.findFirst({ where: { id: loc.id, organization_id: ORG_ID } });
    expect(found?.name).toBe('Branch A');
  });
});
