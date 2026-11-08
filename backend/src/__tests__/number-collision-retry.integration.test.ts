/**
 * Real-DB proof that a hand-typed number claiming the allocator's candidate mid-transaction
 * degrades to a retry instead of a 500.
 *
 * This is the race `allocateNumber` cannot close on its own: it probes that a candidate is
 * free, then the row carrying that number is inserted milliseconds later. A rename (or a create
 * with a manual id) writes the number WITHOUT taking the organizations row lock that serialises
 * allocations, so it can land in that window. The unique index then rejects the insert.
 *
 * The race here is genuine, not simulated: the interloper is written from a SEPARATE connection
 * (the global client, outside the transaction) after `allocateNumber` has already returned its
 * candidate and before the insert. Staging it that way is the only way to make the window
 * deterministic; nothing about the collision itself is faked.
 *
 * FIXTURE NUMBERS ARE SIX DIGITS ON PURPOSE. `number_padding` is 5, and the pre-existing
 * custom-number cases used numbers that FIT the padding (`C00007`) — which is exactly why they
 * stayed green through the production outage in PR #1873. A regression test for this class of
 * bug has to use numbers wider than the padding.
 *
 * Skipped by default. To run:
 *   RUN_INTEGRATION_TESTS=1 npx vitest run src/__tests__/number-collision-retry.integration.test.ts
 * with DATABASE_URL pointing at STAGING (never production).
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import dotenv from 'dotenv';

dotenv.config();

const enabled =
  process.env.RUN_INTEGRATION_TESTS === '1' &&
  typeof process.env.DATABASE_URL === 'string' &&
  !process.env.DATABASE_URL.includes('test:test@localhost');

describe.skipIf(process.env.RUN_INTEGRATION_TESTS !== '1')('integration opt-in', () => {
  it('has a real DATABASE_URL to run against', () => {
    expect(enabled).toBe(true);
  });
});

describe.skipIf(!enabled)('withNumberCollisionRetry — real-DB hand-typed collision', () => {
  let prisma: any;
  let allocateNumber: any;
  let withNumberCollisionRetry: any;

  // Deterministic UUID so a killed run can still clean up on the next one.
  const ORG = '00000000-0000-0000-0000-0000000000c7';
  // Six digits: WIDER than the default number_padding of 5 (see the file header).
  const FIRST = 700010;

  async function createCustomer(tx: any, number: string, custom: boolean) {
    return tx.customer.create({
      data: {
        organization_id: ORG,
        customer_number: number,
        number_is_custom: custom,
        kind: 'PERSON',
        segment: 'RESIDENTIAL',
        first_name: 'Race',
        last_name: number,
      },
      select: { id: true, customer_number: true },
    });
  }

  beforeAll(async () => {
    const prismaPkg = await import('@prisma/client');
    const numberingMod = await vi.importActual<typeof import('../lib/numbering')>('../lib/numbering');
    const retryMod = await vi.importActual<typeof import('../lib/number-collision-retry')>(
      '../lib/number-collision-retry',
    );
    prisma = new prismaPkg.PrismaClient();
    allocateNumber = numberingMod.allocateNumber;
    withNumberCollisionRetry = retryMod.withNumberCollisionRetry;

    await prisma.customer.deleteMany({ where: { organization_id: ORG } });
    await prisma.organization.deleteMany({ where: { id: ORG } });
    await prisma.organization.create({
      data: {
        id: ORG,
        plan: 'SCALE',
        name: 'Number Collision Org',
        address_line1: '1 Race St',
        city: 'Testville',
        state: 'NY',
        postal_code: '00001',
        email: 'collision@test.invalid',
        estimate_terms: '',
        estimate_notes: '',
        estimate_payment_terms: '',
        customer_prefix: '',
        // The series has outgrown the padding — the Northwind Services shape.
        number_padding: 5,
        customer_next_number: FIRST,
      },
    });
  });

  beforeEach(async () => {
    await prisma.customer.deleteMany({ where: { organization_id: ORG } });
    await prisma.organization.update({
      where: { id: ORG },
      data: { customer_next_number: FIRST },
    });
  });

  afterAll(async () => {
    if (!prisma) return;
    await prisma.customer.deleteMany({ where: { organization_id: ORG } });
    await prisma.organization.deleteMany({ where: { id: ORG } });
    await prisma.$disconnect();
  });

  it('a hand-typed number that lands mid-transaction is stepped over, and the create succeeds', async () => {
    let attempts = 0;

    const created = await withNumberCollisionRetry(
      () =>
        prisma.$transaction(async (tx: any) => {
          attempts += 1;
          const number = await allocateNumber(tx, 'customer', ORG);

          // THE RACE. On the first attempt only, a hand-typed number claims the candidate the
          // allocator has just handed back — committed from a different connection, so it is
          // visible to the unique index but was not visible to the probe a moment ago.
          if (attempts === 1) {
            expect(number).toBe(String(FIRST));
            await createCustomer(prisma, number, true);
          }

          return createCustomer(tx, number, false);
        }),
      { label: 'integration.customer.create' },
    );

    // Two attempts: the first died on the unique index, the second stepped over the squatter.
    expect(attempts).toBe(2);
    expect(created.customer_number).toBe(String(FIRST + 1));

    // Product rule 3 holds end to end: the record exists, and it is not the taken number.
    const rows = await prisma.customer.findMany({
      where: { organization_id: ORG },
      select: { customer_number: true, number_is_custom: true },
      orderBy: { customer_number: 'asc' },
    });
    expect(rows.map((r: any) => r.customer_number)).toEqual([String(FIRST), String(FIRST + 1)]);
  });

  it('survives a collision on every attempt but the last', async () => {
    let attempts = 0;

    const created = await withNumberCollisionRetry(() =>
      prisma.$transaction(async (tx: any) => {
        attempts += 1;
        const number = await allocateNumber(tx, 'customer', ORG);
        if (attempts < 3) await createCustomer(prisma, number, true);
        return createCustomer(tx, number, false);
      }),
    );

    expect(attempts).toBe(3);
    expect(created.customer_number).toBe(String(FIRST + 2));
  });

  it('gives up after the bound and rethrows the collision rather than spinning', async () => {
    let attempts = 0;

    await expect(
      withNumberCollisionRetry(() =>
        prisma.$transaction(async (tx: any) => {
          attempts += 1;
          const number = await allocateNumber(tx, 'customer', ORG);
          // Every attempt loses — a permanently hostile writer, not contention.
          await createCustomer(prisma, number, true);
          return createCustomer(tx, number, false);
        }),
      ),
    ).rejects.toMatchObject({ code: 'P2002' });

    expect(attempts).toBe(3);
  });
});
