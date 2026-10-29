/**
 * Real-DB contract test for the inline new_customer create path.
 *
 * leads.test.ts and customers.test.ts mock Prisma, so `tx.customer.create`
 * silently accepts `data` that omits NOT-NULL, no-default columns
 * (customer_number / kind / segment). That blind spot is exactly how the inline
 * new_customer path shipped a 500. This test hits the REAL database to prove a
 * customer (+ primary location) + lead, built like lead.controller's inline
 * path, is actually accepted by the schema.
 *
 * Skipped by default. To run (DATABASE_URL must point at a non-prod Postgres
 * with migrations applied — the local .env staging DB qualifies):
 *   RUN_INTEGRATION_TESTS=1 npx vitest run src/__tests__/customer-create.integration.test.ts
 *
 * Everything runs inside a transaction that is rolled back via a sentinel throw,
 * so the test leaves NO rows behind (the sequence counters roll back too — see
 * numbering.integration.test.ts "counter rolls back when the wrapping
 * transaction throws").
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import dotenv from 'dotenv';

// Vitest doesn't auto-load .env; load it so the skipIf gate can read DATABASE_URL.
dotenv.config();

const enabled =
  process.env.RUN_INTEGRATION_TESTS === '1' &&
  typeof process.env.DATABASE_URL === 'string' &&
  !process.env.DATABASE_URL.includes('test:test@localhost');

describe.skipIf(!enabled)('inline new_customer create — real-DB contract', () => {
  // Dynamic imports + a fresh PrismaClient so this file does NOT use the mocked
  // '../lib/prisma' or the no-op allocateNumber stub from setup.ts.
  let prisma: any;
  let allocateNumber: any;

  beforeAll(async () => {
    const prismaPkg = await import('@prisma/client');
    const numberingMod = await vi.importActual<typeof import('../lib/numbering')>('../lib/numbering');
    prisma = new prismaPkg.PrismaClient();
    allocateNumber = numberingMod.allocateNumber;
  });

  afterAll(async () => {
    if (prisma) await prisma.$disconnect();
  });

  it('accepts a customer (+primary location) + lead built like the inline path, persisting nothing', async () => {
    const org = await prisma.organization.findFirst({ select: { id: true } });
    expect(org, 'target DB needs at least one organization').toBeTruthy();

    let createdCustomer: any;
    let createdLead: any;
    const SENTINEL = 'ROLLBACK_SENTINEL_NO_PERSIST';

    await expect(
      prisma.$transaction(async (tx: any) => {
        // Field set mirrors withRequiredCustomerFields + lead.controller's inline path.
        const customer_number = await allocateNumber(tx, 'customer', org.id);
        createdCustomer = await tx.customer.create({
          data: {
            organization_id: org.id,
            customer_number,
            kind: 'PERSON',
            segment: 'RESIDENTIAL',
            first_name: 'Integration',
            last_name: 'Probe',
            email: 'integration.probe@example.invalid',
            phone: '5550000000',
            service_locations: {
              create: { address_line1: '1 Probe Way', city: 'Austin', state: 'TX', zip: '78701', is_primary: true },
            },
          },
          select: {
            id: true,
            customer_number: true,
            kind: true,
            segment: true,
            service_locations: { where: { is_primary: true }, take: 1, select: { id: true } },
          },
        });

        const lead_number = await allocateNumber(tx, 'lead', org.id);
        createdLead = await tx.lead.create({
          data: {
            lead_number,
            customer_id: createdCustomer.id,
            service_request: 'Integration probe — never persisted',
            organization_id: org.id,
            service_location_id: createdCustomer.service_locations[0]?.id ?? null,
          },
          select: { id: true, lead_number: true },
        });

        // Force rollback so the probe rows never persist on the shared DB.
        throw new Error(SENTINEL);
      }),
    ).rejects.toThrow(SENTINEL);

    // Had the schema rejected the inserts, the transaction would have rejected
    // with a Prisma constraint error (not our sentinel) and these would be unset.
    expect(createdCustomer?.customer_number).toBeTruthy();
    expect(createdCustomer?.kind).toBe('PERSON');
    expect(createdCustomer?.segment).toBe('RESIDENTIAL');
    expect(createdLead?.id).toBeTruthy();
    expect(createdLead?.lead_number).toBeTruthy();
  });
});
