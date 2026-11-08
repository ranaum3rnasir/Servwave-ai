/**
 * Real-DB concurrent allocator integration test.
 *
 * The 11 unit tests in `numbering.test.ts` mock `$queryRaw` — they verify the
 * controller logic but cannot prove that Postgres actually serializes
 * concurrent UPDATEs against the same org row. This file fills that gap.
 *
 * Skipped by default. To run:
 *   1. Point DATABASE_URL at a non-production Postgres with the migrations applied
 *   2. `RUN_INTEGRATION_TESTS=1 npx vitest run src/__tests__/numbering.integration.test.ts`
 *
 * The test seeds two throw-away orgs, runs 50 concurrent allocations against
 * each, and asserts every returned number is unique and contiguous (1..50).
 * Cleanup is in afterAll; if the run is killed mid-flight, the orgs are left
 * behind for inspection — re-running the test cleans them.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import dotenv from 'dotenv';

// Vitest doesn't auto-load .env (unlike Prisma's CLI). Load it here so the
// skipIf gate below can read DATABASE_URL.
dotenv.config();

// Skip unless explicitly opted-in. Setting RUN_INTEGRATION_TESTS=1 + a real
// DATABASE_URL (env, not the mocked test one) is required.
const enabled =
  process.env.RUN_INTEGRATION_TESTS === '1' &&
  typeof process.env.DATABASE_URL === 'string' &&
  !process.env.DATABASE_URL.includes('test:test@localhost');

// A silently skipped guard is worse than no guard. When a run explicitly asks for the
// integration tests (CI does), refuse to skip quietly - fail and name the reason.
describe.skipIf(process.env.RUN_INTEGRATION_TESTS !== '1')('integration opt-in', () => {
  it('has a real DATABASE_URL to run against', () => {
    expect(enabled).toBe(true);
  });
});

describe.skipIf(!enabled)('allocateNumber — real-DB concurrent atomicity', () => {
  // Dynamic imports so this file does NOT pull in PrismaClient when skipped
  // (avoids generated-client side effects in normal unit-test runs).
  let prisma: any;
  let allocateNumber: any;
  // Deterministic UUIDs so a killed run can still clean up leftover rows on re-run.
  const ORG_A = '00000000-0000-0000-0000-0000000000a1';
  const ORG_B = '00000000-0000-0000-0000-0000000000b1';

  beforeAll(async () => {
    const prismaPkg = await import('@prisma/client');
    // vi.importActual bypasses the global mock at setup.ts so we hit the real allocator,
    // not the no-op test stub. Without this, the integration test would silently pass
    // by executing the mocked function instead of the real Postgres allocator.
    const numberingMod = await vi.importActual<typeof import('../lib/numbering')>('../lib/numbering');
    prisma = new prismaPkg.PrismaClient();
    allocateNumber = numberingMod.allocateNumber;

    // Pre-clean in case a prior run aborted before afterAll. Customers first: a test that
    // dies mid-flight leaves its rows behind, and organization.deleteMany then trips the
    // customers_organization_id_fkey instead of cleaning up.
    await prisma.customer.deleteMany({ where: { organization_id: { in: [ORG_A, ORG_B] } } });
    await prisma.organization.deleteMany({ where: { id: { in: [ORG_A, ORG_B] } } });

    // Seed two throw-away orgs. Use minimal fields; rely on Prisma defaults.
    await prisma.organization.createMany({
      data: [
        {
          id: ORG_A,
          plan: 'SCALE',
          name: 'Integration Org A',
          address_line1: '1 Test St',
          city: 'Testville',
          state: 'NY',
          postal_code: '00001',
          email: 'a@test.invalid',
          estimate_terms: '',
          estimate_notes: '',
          estimate_payment_terms: '',
        },
        {
          id: ORG_B,
          plan: 'SCALE',
          name: 'Integration Org B',
          address_line1: '2 Test St',
          city: 'Testville',
          state: 'NY',
          postal_code: '00001',
          email: 'b@test.invalid',
          estimate_terms: '',
          estimate_notes: '',
          estimate_payment_terms: '',
        },
      ],
    });
  });

  afterAll(async () => {
    if (!prisma) return;
    await prisma.customer.deleteMany({ where: { organization_id: { in: [ORG_A, ORG_B] } } });
    await prisma.organization.deleteMany({ where: { id: { in: [ORG_A, ORG_B] } } });
    await prisma.$disconnect();
  });

  it('50 parallel allocations against the same org produce 50 unique sequential numbers', async () => {
    const promises = Array.from({ length: 50 }, () =>
      allocateNumber(prisma, 'lead', ORG_A),
    );
    const results = await Promise.all(promises);

    expect(new Set(results).size).toBe(50);

    // Parse trailing digits, sort, assert contiguous starting from the lowest.
    const numbers = results.map((s: string) => Number(s.replace(/^[A-Za-z-]+/, ''))).sort((a, b) => a - b);
    for (let i = 1; i < numbers.length; i++) {
      expect(numbers[i]).toBe(numbers[i - 1] + 1);
    }
  });

  it('25 + 25 parallel across two orgs produce independent sequential counters', async () => {
    const promises = [
      ...Array.from({ length: 25 }, () => allocateNumber(prisma, 'estimate', ORG_A)),
      ...Array.from({ length: 25 }, () => allocateNumber(prisma, 'estimate', ORG_B)),
    ];
    const results = await Promise.all(promises);

    // Each org's set is internally unique and contiguous.
    const orgA = results.slice(0, 25).map((s: string) => Number(s.replace(/^[A-Za-z-]+/, '')));
    const orgB = results.slice(25).map((s: string) => Number(s.replace(/^[A-Za-z-]+/, '')));

    expect(new Set(orgA).size).toBe(25);
    expect(new Set(orgB).size).toBe(25);

    orgA.sort((a: number, b: number) => a - b);
    orgB.sort((a: number, b: number) => a - b);
    for (let i = 1; i < 25; i++) {
      expect(orgA[i]).toBe(orgA[i - 1] + 1);
      expect(orgB[i]).toBe(orgB[i - 1] + 1);
    }
  });

  it('counter rolls back when the wrapping transaction throws', async () => {
    const before = await prisma.organization.findUnique({
      where: { id: ORG_A },
      select: { job_next_number: true },
    });

    await expect(
      prisma.$transaction(async (tx: any) => {
        await allocateNumber(tx, 'job', ORG_A);
        throw new Error('simulated entity-insert failure');
      }),
    ).rejects.toThrow(/simulated/);

    const after = await prisma.organization.findUnique({
      where: { id: ORG_A },
      select: { job_next_number: true },
    });

    // Counter must NOT have advanced.
    expect(after.job_next_number).toBe(before.job_next_number);
  });

  it('self-heals a counter that has drifted behind reality (no duplicate number)', async () => {
    // Simulate the shared-staging-DB drift that caused the schedule-visit 500: a row already
    // exists at suffix 5, but the org's customer counter has fallen behind it (rows inserted by
    // another branch without bumping it). The old allocator would re-issue 1..5 → unique-violation
    // 500 on insert. The self-heal must instead advance to max(existing)+1.
    await prisma.customer.create({
      data: {
        organization_id: ORG_A,
        customer_number: 'C00005',
        kind: 'PERSON',
        segment: 'RESIDENTIAL',
        email: 'drift@test.invalid',
        phone: '+15555550005',
      },
    });
    await prisma.organization.update({
      where: { id: ORG_A },
      data: { customer_next_number: 1 }, // stale — behind the existing C00005
    });

    const next = await allocateNumber(prisma, 'customer', ORG_A);
    expect(Number(next.replace(/^[A-Za-z-]+/, ''))).toBe(6); // max(5)+1, not the stale 1

    await prisma.customer.deleteMany({ where: { organization_id: ORG_A } });
  });

  // ---------------------------------------------------------------------------
  // Custom numbers (the editable-record-ids allocator work). Both cases below
  // execute the tier-1 skip statement, which a mocked $queryRaw never plans — the
  // `lpad(text, bigint, ...)` 42883 that broke every create in the org was
  // invisible to the unit suite and visible here on the first run.
  // ---------------------------------------------------------------------------

  it('steps over a hand-typed number sitting exactly where the counter lands', async () => {
    // C00007 is taken by hand; the counter is about to hand out 7. Colliding here is the
    // unique-violation 500 this path exists to prevent.
    await prisma.customer.create({
      data: {
        organization_id: ORG_A,
        customer_number: 'C00007',
        number_is_custom: true,
        kind: 'PERSON',
        segment: 'RESIDENTIAL',
        email: 'taken@test.invalid',
        phone: '+15555550007',
      },
    });
    await prisma.organization.update({
      where: { id: ORG_A },
      data: { customer_next_number: 7 },
    });

    const next = await allocateNumber(prisma, 'customer', ORG_A);
    expect(next).toBe('C00008');

    await prisma.customer.deleteMany({ where: { organization_id: ORG_A } });
  });

  it('does not drag the series up to a hand-typed number far above the counter', async () => {
    // The Workiz-import shape: one hand-typed id in the 500s must not catapult the whole
    // org's automatic series into that range.
    await prisma.customer.create({
      data: {
        organization_id: ORG_A,
        customer_number: 'C00500',
        number_is_custom: true,
        kind: 'PERSON',
        segment: 'RESIDENTIAL',
        email: 'workiz@test.invalid',
        phone: '+15555550500',
      },
    });
    await prisma.organization.update({
      where: { id: ORG_A },
      data: { customer_next_number: 3 },
    });

    const next = await allocateNumber(prisma, 'customer', ORG_A);
    expect(next).toBe('C00003');

    const org = await prisma.organization.findUnique({
      where: { id: ORG_A },
      select: { customer_next_number: true },
    });
    // The counter self-healed off non-custom rows only — it never saw the 500.
    expect(org.customer_next_number).toBe(4);

    await prisma.customer.deleteMany({ where: { organization_id: ORG_A } });
  });

  it('steps over a hand-typed number WIDER than number_padding (the Workiz/Northwind Services shape)', async () => {
    // The regression that broke every job create in Northwind Services in prod.
    //
    // Their series outgrew number_padding: prefix '', padding 5, six-digit imported ids. The
    // skip check used to render its candidates a SECOND time in SQL with
    // `lpad(n::text, padding, '0')`, and Postgres lpad TRUNCATES a string longer than the
    // target width — lpad('698854', 5, '0') = '69885'. So the probe compared a string that
    // could never match any real row, reported "free" for a number that was taken, and the
    // insert died on the unique constraint. The counter increment rolls back with the failed
    // transaction, so it re-issued the SAME number on every retry, forever.
    //
    // Every case above uses numbers that FIT the padding, where lpad and padStart agree —
    // which is exactly why they all passed while production was hard-down. Keep this one
    // wider than the padding.
    await prisma.organization.update({
      where: { id: ORG_A },
      data: { customer_prefix: '', number_padding: 5, customer_next_number: 698854 },
    });
    await prisma.customer.create({
      data: {
        organization_id: ORG_A,
        customer_number: '698854',
        number_is_custom: true,
        kind: 'PERSON',
        segment: 'RESIDENTIAL',
        email: 'wide@test.invalid',
        phone: '+15556988540',
      },
    });

    const next = await allocateNumber(prisma, 'customer', ORG_A);
    expect(next).toBe('698855');
    // The number handed out must be free — this is the assertion the unique index makes.
    const collision = await prisma.customer.findFirst({
      where: { organization_id: ORG_A, customer_number: next },
      select: { id: true },
    });
    expect(collision).toBeNull();

    await prisma.customer.deleteMany({ where: { organization_id: ORG_A } });
    await prisma.organization.update({
      where: { id: ORG_A },
      data: { customer_prefix: 'C', customer_next_number: 1 },
    });
  });

  it('skips a RUN of taken wide numbers, exercising the window query', async () => {
    // Tier 2: the counter-derived candidate AND the next few are all hand-typed. A mocked
    // $queryRaw cannot plan the `= ANY($1::text[])` binding this tier depends on; only a real
    // planner can, which is the same reason the tier-1 statement is exercised here.
    await prisma.organization.update({
      where: { id: ORG_A },
      data: { customer_prefix: '', number_padding: 5, customer_next_number: 700000 },
    });
    await prisma.customer.createMany({
      data: [0, 1, 2, 3].map((i) => ({
        organization_id: ORG_A,
        customer_number: String(700000 + i),
        number_is_custom: true,
        kind: 'PERSON' as const,
        segment: 'RESIDENTIAL' as const,
        email: `run${i}@test.invalid`,
        phone: `+1555700000${i}`,
      })),
    });

    const next = await allocateNumber(prisma, 'customer', ORG_A);
    expect(next).toBe('700004');

    await prisma.customer.deleteMany({ where: { organization_id: ORG_A } });
    await prisma.organization.update({
      where: { id: ORG_A },
      data: { customer_prefix: 'C', customer_next_number: 1 },
    });
  });
});

describe.skipIf(!enabled)('maxNumberForTx — mixed-format orgs do not crash the collision guard', () => {
  // Regression for the Workiz-import "can't save numbering" 500: an org whose rows MIX
  // bare-numeric (imported) and prefixed (native, e.g. L00005) numbers used to crash the
  // settings collision guard's CAST(SUBSTRING(<col> FROM <prefixLen+1>) AS INTEGER) with
  // Postgres 22P02 ("invalid input syntax for type integer: L00005"), aborting the whole
  // save as an opaque 500. The trailing-digit regex must instead return the true max across
  // BOTH formats without throwing. (See organization.controller.ts maxNumberForTx.)
  let prisma: any;
  let maxNumberForTx: any;
  const ORG_MIX = '00000000-0000-0000-0000-0000000000c1';

  beforeAll(async () => {
    const prismaPkg = await import('@prisma/client');
    prisma = new prismaPkg.PrismaClient();
    // importActual bypasses any global controller mock so we exercise the real SQL helper.
    const orgMod = await vi.importActual<typeof import('../controllers/organization.controller')>(
      '../controllers/organization.controller',
    );
    maxNumberForTx = orgMod.maxNumberForTx;

    // Pre-clean (child rows before parents for FKs), then reseed.
    await prisma.lead.deleteMany({ where: { organization_id: ORG_MIX } });
    await prisma.customer.deleteMany({ where: { organization_id: ORG_MIX } });
    await prisma.organization.deleteMany({ where: { id: ORG_MIX } });

    await prisma.organization.create({
      data: {
        id: ORG_MIX,
        plan: 'SCALE',
        name: 'Mixed-format Import Org',
        address_line1: '3 Test St', city: 'Testville', state: 'NY', postal_code: '00001',
        email: 'mix@test.invalid',
        estimate_terms: '', estimate_notes: '', estimate_payment_terms: '',
        lead_prefix: '', // blanked after a Workiz import that continues bare-numeric IDs
      },
    });
    const cust = await prisma.customer.create({
      data: {
        organization_id: ORG_MIX, customer_number: 'C00001', kind: 'PERSON',
        segment: 'RESIDENTIAL', email: 'mixcust@test.invalid', phone: '+15555559001',
      },
    });
    // Native prefixed row + bare-numeric imported row in the SAME table.
    await prisma.lead.create({ data: { organization_id: ORG_MIX, customer_id: cust.id, service_request: 'x', lead_number: 'L00005' } });
    await prisma.lead.create({ data: { organization_id: ORG_MIX, customer_id: cust.id, service_request: 'x', lead_number: '900' } });
  });

  afterAll(async () => {
    if (!prisma) return;
    await prisma.lead.deleteMany({ where: { organization_id: ORG_MIX } });
    await prisma.customer.deleteMany({ where: { organization_id: ORG_MIX } });
    await prisma.organization.deleteMany({ where: { id: ORG_MIX } });
    await prisma.$disconnect();
  });

  it('returns the true max across bare-numeric and prefixed rows without throwing', async () => {
    const max = await maxNumberForTx(prisma, 'leads', 'lead_number', ORG_MIX);
    expect(max).toBe(900); // max(trailing digits: 'L00005'→5, '900'→900)
  });

  it('returns 0 for an entity with no rows', async () => {
    const max = await maxNumberForTx(prisma, 'jobs', 'job_number', ORG_MIX);
    expect(max).toBe(0);
  });
});

describe.skipIf(!enabled)('allocateContainerEstimateNumber — real-DB skip / self-heal', () => {
  // Follow-up 2a. The container allocator used to return its counter's value verbatim, arguing a
  // collision was impossible because legacy estimates all use the flat `E…` series. That argument
  // died when estimate numbers became hand-typeable: `01287-3` sits squarely in this series'
  // domain. Reproduced against a real DB before the fix — a lead at estimate_seq = 2 whose
  // container already held `699063-3` returned `699063-3`, the insert died with P2002, and because
  // the seq bump rolls back with the failed transaction, every retry minted the identical number.
  //
  // The fixtures below use SIX-digit container numbers (the Workiz/Northwind Services shape, wider than
  // number_padding 5) on purpose: a fixture that fits the padding is exactly what stayed green
  // through the #1873 production outage.
  let prisma: any;
  let allocateContainerEstimateNumber: any;
  const ORG_C = '00000000-0000-0000-0000-0000000000d1';
  const USER_C = '00000000-0000-0000-0000-0000000000d2';
  const LEAD_C = '00000000-0000-0000-0000-0000000000d3';

  const cleanup = async () => {
    await prisma.estimate.deleteMany({ where: { organization_id: ORG_C } });
    await prisma.job.deleteMany({ where: { organization_id: ORG_C } });
    await prisma.lead.deleteMany({ where: { organization_id: ORG_C } });
    await prisma.serviceLocation.deleteMany({ where: { customer: { organization_id: ORG_C } } });
    await prisma.customer.deleteMany({ where: { organization_id: ORG_C } });
    await prisma.user.deleteMany({ where: { organization_id: ORG_C } });
    await prisma.organization.deleteMany({ where: { id: ORG_C } });
  };

  let customerId: string;

  beforeAll(async () => {
    const prismaPkg = await import('@prisma/client');
    const numberingMod = await vi.importActual<typeof import('../lib/numbering')>('../lib/numbering');
    prisma = new prismaPkg.PrismaClient();
    allocateContainerEstimateNumber = numberingMod.allocateContainerEstimateNumber;

    await cleanup();
    await prisma.organization.create({
      data: {
        id: ORG_C, plan: 'SCALE', name: 'Container Alloc Org',
        address_line1: '4 Test St', city: 'Testville', state: 'NY', postal_code: '00001',
        email: 'container@test.invalid',
        estimate_terms: '', estimate_notes: '', estimate_payment_terms: '',
        // The Workiz-import shape the whole bug class lives in: no prefix, padding 5, six-digit ids.
        lead_prefix: '', number_padding: 5,
      },
    });
    await prisma.user.create({
      data: {
        id: USER_C, organization_id: ORG_C, email: 'container-user@test.invalid',
        first_name: 'Con', last_name: 'Tainer', role: 'ADMIN',
      },
    });
    const customer = await prisma.customer.create({
      data: {
        organization_id: ORG_C, customer_number: 'C00001', kind: 'PERSON',
        segment: 'RESIDENTIAL', email: 'containercust@test.invalid', phone: '+15555559101',
      },
    });
    customerId = customer.id;
    await prisma.lead.create({
      data: {
        id: LEAD_C, organization_id: ORG_C, customer_id: customerId,
        service_request: 'x', lead_number: '699063', estimate_seq: 2,
      },
    });
  });

  afterAll(async () => {
    if (!prisma) return;
    await cleanup();
    await prisma.$disconnect();
  });

  const seedEstimate = (estimateNumber: string, numberIsCustom: boolean) =>
    prisma.estimate.create({
      data: {
        organization_id: ORG_C, customer_id: customerId, lead_id: LEAD_C,
        estimate_number: estimateNumber, number_is_custom: numberIsCustom,
        container_kind: numberIsCustom ? null : 'LEAD',
        container_seq: numberIsCustom ? null : Number(estimateNumber.split('-')[1]),
        subtotal: 0, tax_amount: 0, total_amount: 0, created_by: USER_C,
      },
    });

  const resetContainer = async (seq: number) => {
    await prisma.estimate.deleteMany({ where: { organization_id: ORG_C } });
    await prisma.lead.update({ where: { id: LEAD_C }, data: { estimate_seq: seq } });
  };

  it('steps over a hand-typed estimate sitting exactly where the counter lands', async () => {
    await resetContainer(2);
    await seedEstimate('699063-3', true); // hand-typed, occupying the counter's next slot

    const allocated = await allocateContainerEstimateNumber(prisma, 'lead', LEAD_C, ORG_C);
    expect(allocated.estimate_number).toBe('699063-4');
    expect(allocated.container_kind).toBe('LEAD');
    expect(allocated.container_seq).toBe(4);

    // The number handed out must actually be insertable — this is the assertion the unique index
    // makes, and the one the old allocator failed with P2002.
    const created = await seedEstimate(allocated.estimate_number, false);
    expect(created.estimate_number).toBe('699063-4');
  });

  it('does not pin: the next allocation moves past the number it just issued', async () => {
    // The old allocator's failure mode was permanence — the rolled-back seq bump re-minted the
    // same string for ever. Continues from the previous case's state (-3 custom, -4 issued).
    const allocated = await allocateContainerEstimateNumber(prisma, 'lead', LEAD_C, ORG_C);
    expect(allocated.estimate_number).toBe('699063-5');
  });

  it('self-heals a counter that has drifted BEHIND its own issued estimates', async () => {
    await resetContainer(1);
    await seedEstimate('699063-2', false);
    await seedEstimate('699063-3', false);

    const allocated = await allocateContainerEstimateNumber(prisma, 'lead', LEAD_C, ORG_C);
    expect(allocated.estimate_number).toBe('699063-4');
  });

  it('does not re-base the series onto a far-off hand-typed number', async () => {
    // Product rule: renaming ONE record to a far-off id does not move the sequence. The counter
    // is at 2, so the next container estimate is -3 even though -900 exists.
    await resetContainer(2);
    await seedEstimate('699063-900', true);

    const allocated = await allocateContainerEstimateNumber(prisma, 'lead', LEAD_C, ORG_C);
    expect(allocated.estimate_number).toBe('699063-3');

    // …and the container counter was NOT written up to 900.
    const lead = await prisma.lead.findUnique({ where: { id: LEAD_C }, select: { estimate_seq: true } });
    expect(lead.estimate_seq).toBe(3);
  });

  it('parallel IN-TRANSACTION allocations over a taken number all insert without colliding', async () => {
    // Deliberately in-transaction and over a seeded row. Calling the allocator with the bare
    // client autocommits each statement, which releases both locks before the taken-set read and
    // before the caller's insert - so a bare-client race proves only that the counter is atomic,
    // and nothing about the skip. This is the shape the create paths actually use: allocate and
    // insert inside ONE transaction, with the unique index as the judge.
    await resetContainer(0);
    await seedEstimate('699063-1', true); // hand-typed; every racer must step over it

    const results = await Promise.all(
      Array.from({ length: 8 }, () =>
        prisma.$transaction(async (tx: any) => {
          const allocated = await allocateContainerEstimateNumber(tx, 'lead', LEAD_C, ORG_C);
          await tx.estimate.create({
            data: {
              organization_id: ORG_C, customer_id: customerId, lead_id: LEAD_C,
              ...allocated, subtotal: 0, tax_amount: 0, total_amount: 0, created_by: USER_C,
            },
          });
          return allocated;
        }),
      ),
    );

    const seqs = results.map((r: any) => r.container_seq).sort((a: number, b: number) => a - b);
    // 1 was taken by hand, so the eight allocator-issued rows are 2..9 with no repeats.
    expect(seqs).toEqual([2, 3, 4, 5, 6, 7, 8, 9]);
    expect(new Set(results.map((r: any) => r.estimate_number)).size).toBe(8);
  });

  it('two DIFFERENT containers sharing a human number do not both mint -1', async () => {
    // The cross-container race. The UPDATE takes a lock on the CONTAINER ROW, but uniqueness is
    // keyed on `(organization_id, estimate_number)` - so a lead `555555` and a job `555555` take
    // different row locks and, before the advisory lock, both derived `555555-1` from an empty
    // taken set. The second insert then died P2002: rule 3 broken by the function whose job is to
    // guarantee it. Concurrency here is real - both transactions are in flight at once.
    await resetContainer(0);
    const location = await prisma.serviceLocation.create({
      data: {
        customer_id: customerId, address_line1: '5 Test St', city: 'Testville',
        state: 'NY', zip: '00001',
      },
    });
    const lead = await prisma.lead.create({
      data: {
        organization_id: ORG_C, customer_id: customerId,
        service_request: 'x', lead_number: '555555', estimate_seq: 0,
      },
    });
    const job = await prisma.job.create({
      data: {
        organization_id: ORG_C, customer_id: customerId, service_location_id: location.id,
        job_number: '555555', estimate_seq: 0,
      },
    });

    // The window has to be held open deliberately. Both derivations are sub-millisecond, so two
    // bare Promise.all transactions usually miss each other even without the lock. The lead
    // transaction therefore allocates, inserts, and then STAYS OPEN for HOLD_MS before
    // committing, while the job transaction starts 120ms in - squarely inside that window.
    //
    // Without the advisory lock the job transaction reads a taken set that cannot yet contain the
    // lead's uncommitted `555555-1`, derives `555555-1` itself, and dies P2002 on insert.
    // With it, the job transaction blocks inside the allocator until the lead COMMITS, then sees
    // the row and derives `555555-2`. There is no deadlock: the lead never waits on the job.
    const HOLD_MS = 600;
    const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

    // Warm several pool connections FIRST. The elapsed-time assertion at the end must measure
    // blocking, and a cold connection's TLS handshake to a hosted Postgres costs ~1s - enough to
    // masquerade as a wait and hand back a false green from the other direction.
    await Promise.all(Array.from({ length: 4 }, () => prisma.$queryRaw`SELECT 1`));
    const race = (
      container: 'lead' | 'job',
      id: string,
      extra: Record<string, unknown>,
      holdMs: number,
    ) =>
      prisma.$transaction(async (tx: any) => {
        const allocated = await allocateContainerEstimateNumber(tx, container, id, ORG_C);
        await tx.estimate.create({
          data: {
            organization_id: ORG_C, customer_id: customerId, ...extra,
            ...allocated, subtotal: 0, tax_amount: 0, total_amount: 0, created_by: USER_C,
          },
        });
        if (holdMs) await sleep(holdMs);
        return allocated;
      }, { timeout: 15000 });

    let jobWaitedMs = 0;
    const [fromLead, fromJob] = await Promise.all([
      race('lead', lead.id, { lead_id: lead.id }, HOLD_MS),
      sleep(120).then(async () => {
        const startedAt = Date.now();
        const result = await race('job', job.id, { job_id: job.id }, 0);
        jobWaitedMs = Date.now() - startedAt;
        return result;
      }),
    ]);

    // Both creates SUCCEEDED (rule 3), and the two numbers differ.
    expect(new Set([fromLead.estimate_number, fromJob.estimate_number]).size).toBe(2);
    expect(fromLead.estimate_number).toBe('555555-1');
    expect(fromJob.estimate_number).toBe('555555-2');

    // The outcome assertions above are necessary but NOT sufficient: on a cold pool the job
    // transaction's connection handshake can push its derivation past the hold, so it reads an
    // already-committed `555555-1` and derives `-2` for the wrong reason - the unlocked code then
    // passes this test, roughly one run in four. Assert the thing that actually distinguishes the
    // two worlds: that the job transaction BLOCKED. Half the hold is the threshold; unlocked, the
    // job transaction returns in single-digit ms.
    expect(jobWaitedMs).toBeGreaterThan(HOLD_MS / 2);

    await prisma.estimate.deleteMany({ where: { organization_id: ORG_C } });
    await prisma.job.deleteMany({ where: { organization_id: ORG_C } });
    await prisma.lead.deleteMany({ where: { organization_id: ORG_C, id: { not: LEAD_C } } });
    await prisma.serviceLocation.deleteMany({ where: { customer_id: customerId } });
  });
});
