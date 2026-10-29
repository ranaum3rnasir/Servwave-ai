/**
 * Real-DB integration test for the `countRange` facet kind (Task 3).
 *
 * `groupBy` + `having` is genuinely new in this codebase (no prior precedent
 * combines both), and Prisma's `having` clause is validated by its generated
 * TypeScript types, not runtime behavior — the only way to be sure the
 * generated SQL does what we think is to run it against a real Postgres.
 *
 * Skipped by default. To run:
 *   1. Point DATABASE_URL at a non-production Postgres with migrations applied
 *   2. `RUN_INTEGRATION_TESTS=1 npx vitest run src/lib/query/__tests__/filterEngine.count.integration.test.ts`
 *
 * Mirrors the gating + dynamic-import pattern of
 * `src/__tests__/numbering.integration.test.ts` / `org-settings.integration.test.ts`
 * so the real PrismaClient is used (not the global mocked client from setup.ts).
 *
 * Seeds one org with three Leads owning 0, 2, and 5 Estimates respectively,
 * then asserts applyFilters' countRange branch narrows to the right bucket
 * for min+max, min-only, and the max=0 zero-inclusive edge case.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import dotenv from 'dotenv';
import { applyFilters, FacetDef } from '../filterEngine';

dotenv.config();

const enabled =
  process.env.RUN_INTEGRATION_TESTS === '1' &&
  typeof process.env.DATABASE_URL === 'string' &&
  !process.env.DATABASE_URL.includes('test:test@localhost');

describe.skipIf(!enabled)('filterEngine: countRange — real-DB seeded scenario', () => {
  let prisma: any;

  const ORG_ID = '00000000-0000-0000-0000-00000000c001';
  const USER_ID = '00000000-0000-0000-0000-00000000c002';

  let org: { id: string };
  let customerId: string;
  let zeroEstimateLead: { id: string };
  let twoEstimateLead: { id: string };
  let fiveEstimateLead: { id: string };

  const countFacet: FacetDef = {
    key: 'estimates',
    kind: 'countRange',
    minParam: 'min_estimates',
    maxParam: 'max_estimates',
    countOn: { model: 'estimate', groupField: 'lead_id' },
  };

  function reqWithOrg(o: { id: string }, query: Record<string, unknown>) {
    return { query, user: { organization_id: o.id } } as any;
  }

  async function makeEstimate(leadId: string, n: number) {
    return prisma.estimate.create({
      data: {
        lead_id: leadId,
        estimate_number: `CR-${leadId.slice(-4)}-${n}`,
        created_by: USER_ID,
        organization_id: ORG_ID,
        subtotal: 0,
        tax_amount: 0,
        total_amount: 0,
      },
    });
  }

  beforeAll(async () => {
    const prismaPkg = await import('@prisma/client');
    prisma = new prismaPkg.PrismaClient();

    // Pre-clean in case a prior run aborted before afterAll (child rows before parents for FKs).
    await prisma.estimate.deleteMany({ where: { organization_id: ORG_ID } });
    await prisma.lead.deleteMany({ where: { organization_id: ORG_ID } });
    await prisma.customer.deleteMany({ where: { organization_id: ORG_ID } });
    await prisma.user.deleteMany({ where: { id: USER_ID } });
    await prisma.organization.deleteMany({ where: { id: ORG_ID } });

    org = await prisma.organization.create({
      data: {
        id: ORG_ID,
        plan: 'SCALE',
        name: 'CountRange Test Org',
        address_line1: '1 Test St',
        city: 'Testville',
        state: 'NY',
        postal_code: '00001',
        email: 'countrange@test.invalid',
        estimate_terms: '',
        estimate_notes: '',
        estimate_payment_terms: '',
      },
    });

    await prisma.user.create({
      data: {
        id: USER_ID,
        email: 'countrange-user@test.invalid',
        first_name: 'Count',
        last_name: 'Range',
        role: 'ADMIN',
        organization_id: ORG_ID,
      },
    });

    const customer = await prisma.customer.create({
      data: {
        organization_id: ORG_ID,
        customer_number: 'CR-C00001',
        kind: 'PERSON',
        segment: 'RESIDENTIAL',
        email: 'countrange-customer@test.invalid',
        phone: '+15555550100',
      },
    });
    customerId = customer.id;

    zeroEstimateLead = await prisma.lead.create({
      data: { organization_id: ORG_ID, customer_id: customerId, service_request: 'zero estimates', lead_number: 'CR-L00001' },
    });
    twoEstimateLead = await prisma.lead.create({
      data: { organization_id: ORG_ID, customer_id: customerId, service_request: 'two estimates', lead_number: 'CR-L00002' },
    });
    fiveEstimateLead = await prisma.lead.create({
      data: { organization_id: ORG_ID, customer_id: customerId, service_request: 'five estimates', lead_number: 'CR-L00003' },
    });

    for (let i = 0; i < 2; i++) await makeEstimate(twoEstimateLead.id, i);
    for (let i = 0; i < 5; i++) await makeEstimate(fiveEstimateLead.id, i);
    // zeroEstimateLead intentionally gets none.
  });

  afterAll(async () => {
    if (!prisma) return;
    await prisma.estimate.deleteMany({ where: { organization_id: ORG_ID } });
    await prisma.lead.deleteMany({ where: { organization_id: ORG_ID } });
    await prisma.customer.deleteMany({ where: { organization_id: ORG_ID } });
    await prisma.user.deleteMany({ where: { id: USER_ID } });
    await prisma.organization.deleteMany({ where: { id: ORG_ID } });
    await prisma.$disconnect();
  });

  it('countRange: min+max narrows to the exact bucket', async () => {
    const where: any = { organization_id: org.id };
    await applyFilters(where, reqWithOrg(org, { min_estimates: '1', max_estimates: '3' }), [countFacet], prisma);
    const rows = await prisma.lead.findMany({ where });
    expect(rows.map((r: any) => r.id)).toEqual([twoEstimateLead.id]);
  });

  it('countRange: min-only (no max) includes every lead at or above the floor', async () => {
    const where: any = { organization_id: org.id };
    await applyFilters(where, reqWithOrg(org, { min_estimates: '1' }), [countFacet], prisma);
    const rows = await prisma.lead.findMany({ where });
    expect(rows.map((r: any) => r.id).sort()).toEqual([twoEstimateLead.id, fiveEstimateLead.id].sort());
  });

  it('countRange: max=0 keeps zero-count rows (zero-inclusive)', async () => {
    const where: any = { organization_id: org.id };
    await applyFilters(where, reqWithOrg(org, { max_estimates: '0' }), [countFacet], prisma);
    const rows = await prisma.lead.findMany({ where });
    expect(rows.map((r: any) => r.id)).toEqual([zeroEstimateLead.id]);
  });
});
