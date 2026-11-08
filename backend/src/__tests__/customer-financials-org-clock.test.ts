/**
 * #1823 — `loadCustomerFinancials` split Past Due vs Due on raw SQL `NOW()`.
 *
 * The customer record's "Past Due / Due" pair asked Postgres "is `due_date` before THIS
 * INSTANT". The OVERDUE chip rendered on the invoice rows a few pixels below it asks "is
 * `due_date`'s ORG CALENDAR DAY before today's org calendar day" (`invoiceMoney.ts` ->
 * `isOverdue` -> `orgDayDiff(due, tz) < 0`). For every invoice due earlier TODAY those are
 * different questions, so one surface called the money past due and the other did not.
 * This is the surface the `20260825190000_invoice_due_date_backfill` migration header named
 * as its motivation and then missed.
 *
 * WHY THE ASSERTIONS ARE EXACT ISO STRINGS. At the frozen instant below, four plausible
 * clocks give four distinct answers:
 *
 *     server instant   2026-08-25T18:00:00.000Z
 *     UTC day start    2026-08-25T00:00:00.000Z
 *     Eastern day      2026-08-25T04:00:00.000Z
 *     Mountain day     2026-08-25T06:00:00.000Z
 *
 * `expect.any(String)` would be satisfied by all four and proves nothing. The America/Denver
 * cases are the discriminators: a fix that hardcodes Eastern, or reads a server-level TZ,
 * passes the New_York cases and fails those.
 *
 * WHAT THESE TESTS PROVE — SHAPE ONLY, AND WHAT THEY CANNOT PROVE.
 * `setup.ts` replaces the whole Prisma client with `vi.fn()`s, so every case here is
 * supertest -> real Express -> real controller -> MOCKED Prisma. Consequently:
 *
 *   - NO test in this file can verify Postgres semantics. The SQL never reaches a database.
 *     It cannot prove `i2.due_date < $1` selects the right rows, cannot prove the bound
 *     parameter is accepted as a `timestamptz`, and cannot prove the two buckets partition
 *     the open balance. Only a real-DB run can, and that is deliberately not attempted here.
 *   - What IS assertable is exactly the defect: the controller was asking Postgres the wrong
 *     QUESTION. Under this fix the boundary is a value the controller COMPUTED and PASSED, so
 *     these tests assert that value's exact ISO string, and that `NOW()` is gone from the SQL.
 *
 * The boundary is bound as an explicitly-cast ISO string (`${overdueBefore}::timestamptz`),
 * matching the `${id}::uuid` idiom already used six times in this same tagged template — so
 * the bound values read out of the mock are STRINGS, not `Date`s.
 *
 * For a `$queryRaw` tagged template the mock receives `calls[n] = [stringsArray, ...bounds]`.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { Mock } from 'vitest';
import request from 'supertest';
import app from '../app';
import { prisma } from '../lib/prisma';
import { mockAuthAs, authHeader, CUSTOMER_FIXTURE } from './helpers';
import { clearTokenCache } from '../middleware/authenticate';

const NY = 'America/New_York';
const DENVER = 'America/Denver'; // staging: Riverbend Septic, LLC

const NOW = '2026-08-25T18:00:00.000Z';
const NY_DAY_START = '2026-08-25T04:00:00.000Z';
const DENVER_DAY_START = '2026-08-25T06:00:00.000Z';
const UTC_DAY_START = '2026-08-25T00:00:00.000Z'; // a WRONG answer, named so a regression reads as one

const CUSTOMER_ID = CUSTOMER_FIXTURE.id;

const zeroFinancials = [{
  lifetime_revenue: '0', total_invoiced: '0', past_due_balance: '0',
  due_balance: '0', unpaid_invoice_count: '0', paid_invoice_count: '0',
}];
const zeroEstimates = [{ total: '0', pending: '0', approved: '0', total_value: '0' }];
const zeroDeposits = [{ deposits_collected: '0', deposits_pending: '0' }];

/**
 * Both `getById` and `getSummary` issue THREE `$queryRaw`s inside one `Promise.all`, and the
 * existing suites (`customers.test.ts:802-806`, `tag-read-hydration.test.ts:69-72`) stub them
 * BY CALL ORDER. Reproduce that order here — see the T6 tripwire at the bottom of this file.
 */
function stubFinancialsBatch() {
  (prisma.$queryRaw as Mock)
    .mockResolvedValueOnce(zeroFinancials)
    .mockResolvedValueOnce(zeroEstimates)
    .mockResolvedValueOnce(zeroDeposits);
}

/** Everything `getById` awaits beyond the batch. Modelled on tag-read-hydration.ts's mockCustomerDetail. */
function stubCustomerDetail() {
  (prisma.customer.findUnique as Mock).mockResolvedValue(CUSTOMER_FIXTURE);
  (prisma.note.findMany as Mock).mockResolvedValue([]);
  (prisma.invoice.findMany as Mock).mockResolvedValue([]);
  (prisma.lead.count as Mock).mockResolvedValue(0);
  (prisma.task.count as Mock).mockResolvedValue(0);
  (prisma.tagAssignment.findMany as Mock).mockResolvedValue([]);
}

/** Point the org's configured zone. getRequestOrgTimezone memoizes on `req`, so there is no
 *  cross-test cache to clear — each request resolves this afresh. */
function orgTimezone(tz: string) {
  (prisma.organization.findUnique as Mock).mockResolvedValue({ timezone: tz });
}

/** `$queryRaw` tagged template -> calls[0] = [stringsArray, ...boundValues]. */
const financialsCall = () => (prisma.$queryRaw as Mock).mock.calls[0];
const financialsSql = () => (financialsCall()[0] as string[]).join('');
/**
 * The ISO-8601 instants bound into the template. The `${id}` / `${orgId}` binds are uuids and
 * are not ISO-shaped, so this predicate isolates the day boundary. NOTE: it filters for
 * STRINGS, not `Date`s — the boundary is passed as `overdueBefore.toISOString()` and cast in
 * SQL, precisely so nothing depends on how the query engine types a `Date` parameter against
 * this repo's only raw-SQL-compared `@db.Timestamptz` column.
 */
const financialsBounds = (): string[] =>
  financialsCall()
    .slice(1)
    .filter((v: unknown): v is string => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(v));

// MANDATORY: toFake:['Date'] only. Faking all timers deadlocks supertest's real HTTP IO.
// Precedent: invoice-overdue-org-clock.test.ts:64, dashboard-visit-window-repoint.test.ts.
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'], now: new Date(NOW) });
  vi.clearAllMocks();
  clearTokenCache();
  mockAuthAs('admin');
  // setup.ts leaves organization.findUnique a bare vi.fn() -> undefined -> DEFAULT_TIMEZONE.
  // Set it AFTER clearAllMocks/mockAuthAs.
  orgTimezone(NY);
  stubCustomerDetail();
  stubFinancialsBatch();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('GET /api/customers/:id/summary — the Past Due / Due split cuts on the ORG clock', () => {
  // T1 — DISCRIMINATING. Under the old code the SQL literally contained `NOW()` and bound
  // ZERO ISO strings, so both halves of this fire.
  it('binds the org day start as the boundary and no longer asks SQL for NOW()', async () => {
    const res = await request(app)
      .get(`/api/customers/${CUSTOMER_ID}/summary`)
      .set(authHeader('admin'));
    expect(res.status).toBe(200);

    expect(financialsSql()).not.toContain('NOW()');

    const bounds = financialsBounds();
    expect(bounds).toHaveLength(2); // one per bucket arm
    expect(bounds[0]).toBe(NY_DAY_START);
    expect(bounds[1]).toBe(NY_DAY_START);
    // The pre-fix value, named explicitly so a regression reads as a regression.
    expect(bounds[0]).not.toBe(NOW);
  });

  // T2 — DISCRIMINATING. Also kills a "fix" that hardcodes Eastern or reads a server-level TZ:
  // identical instant, identical request, only the org row differs.
  it('DISCRIMINATOR: an America/Denver org cuts at 06:00Z, not 04:00Z', async () => {
    orgTimezone(DENVER);

    const res = await request(app)
      .get(`/api/customers/${CUSTOMER_ID}/summary`)
      .set(authHeader('admin'));
    expect(res.status).toBe(200);

    expect(financialsBounds()).toEqual([DENVER_DAY_START, DENVER_DAY_START]);
  });

  // T3 — DISCRIMINATING, and the strongest test in the file: it kills the UTC-day fix and the
  // raw instant at once.
  it('DISCRIMINATOR: the boundary is the ORG day start, not UTC midnight', async () => {
    // 02:30Z on Aug 25 is 22:30 EDT on Aug 24 — the org is still in YESTERDAY'S calendar day.
    vi.setSystemTime(new Date('2026-08-25T02:30:00.000Z'));

    const res = await request(app)
      .get(`/api/customers/${CUSTOMER_ID}/summary`)
      .set(authHeader('admin'));
    expect(res.status).toBe(200);

    const bounds = financialsBounds();
    expect(bounds).toEqual(['2026-08-24T04:00:00.000Z', '2026-08-24T04:00:00.000Z']);
    // A UTC-day implementation answers this; the raw instant answers 02:30Z.
    expect(bounds[0]).not.toBe(UTC_DAY_START);
    expect(bounds[0]).not.toBe('2026-08-25T02:30:00.000Z');
  });

  // T5 — DISCRIMINATING (weakly; T1's NOW() assertion overlaps). The `IS NULL` half is unique
  // to this test and is the part worth keeping: the two arms must stay a TOTAL and DISJOINT
  // partition of the open balance under three-valued logic. Dropping the NULL arm on the
  // strength of the backfill's `still_null = 0` would silently exclude a newly created NULL
  // row from BOTH tiles, so they would stop summing to the open balance.
  it('both bucket arms share ONE boundary value, and the due_date IS NULL arm survives', async () => {
    const res = await request(app)
      .get(`/api/customers/${CUSTOMER_ID}/summary`)
      .set(authHeader('admin'));
    expect(res.status).toBe(200);

    const bounds = financialsBounds();
    expect(bounds).toHaveLength(2);
    expect(bounds[0]).toBe(bounds[1]); // a partial fix leaves NOW() in the second arm
    expect(financialsSql()).toContain('i2.due_date IS NULL');
  });

  // T5b — DISCRIMINATING against a REGRESSION rather than against the old code, which is why
  // it is here at all: nothing else in this file pins the CAST. `due_date` is
  // @db.Timestamptz(6) (schema.prisma:1185) and the bound value is a Z-bearing ISO string, so
  // `::timestamptz` parses it as the absolute instant it names. `::timestamp` would DISCARD
  // the offset and reinterpret the same text as a local wall-clock time, silently shifting the
  // Past Due boundary by the session's UTC offset — on a UTC server that is a no-op, which is
  // exactly why it would survive review and CI and only misbehave somewhere else. Both arms
  // are checked: a half-applied change is the likelier accident.
  it('casts the boundary as timestamptz on BOTH arms, not bare timestamp', async () => {
    const res = await request(app)
      .get(`/api/customers/${CUSTOMER_ID}/summary`)
      .set(authHeader('admin'));
    expect(res.status).toBe(200);

    const sql = financialsSql();
    expect(sql.match(/::timestamptz/g) ?? []).toHaveLength(2);
    // `::timestamp` not followed by `tz` — the exact downgrade this test exists to catch.
    expect(sql).not.toMatch(/::timestamp(?!tz)/);
  });

  // T7 — PARTIALLY DISCRIMINATING, and honestly so. Because DEFAULT_TIMEZONE is
  // 'America/New_York' this cannot distinguish "fell back to the default" from "read the org
  // row". Its real job is the no-500 guarantee: the new pre-batch organization lookup must not
  // break a customer page for an org row that is missing. The boundary half DOES fail under
  // the old code (zero bounds bound).
  it('an absent organization row falls back to the default zone rather than 500ing', async () => {
    (prisma.organization.findUnique as Mock).mockResolvedValue(null);

    const res = await request(app)
      .get(`/api/customers/${CUSTOMER_ID}/summary`)
      .set(authHeader('admin'));
    expect(res.status).toBe(200);

    expect(financialsBounds()).toEqual([NY_DAY_START, NY_DAY_START]);
  });
});

describe('GET /api/customers/:id — getById reads the same clock as the summary', () => {
  // T4 — DISCRIMINATING. Guards the "fixed one entry point, missed the other" failure mode,
  // which is literally how #1823 came to exist (the invoice list was fixed; this was not).
  it('getById binds the org day start too, and drops NOW()', async () => {
    const res = await request(app)
      .get(`/api/customers/${CUSTOMER_ID}`)
      .set(authHeader('admin'));
    expect(res.status).toBe(200);

    expect(financialsSql()).not.toContain('NOW()');
    expect(financialsBounds()).toEqual([NY_DAY_START, NY_DAY_START]);
  });

  it('DISCRIMINATOR: getById tracks the ORG zone, not a hardcoded Eastern', async () => {
    orgTimezone(DENVER);

    const res = await request(app)
      .get(`/api/customers/${CUSTOMER_ID}`)
      .set(authHeader('admin'));
    expect(res.status).toBe(200);

    expect(financialsBounds()).toEqual([DENVER_DAY_START, DENVER_DAY_START]);
  });
});

describe('$queryRaw call ORDER inside the batch is unchanged', () => {
  // T6 — NON-DISCRIMINATING BY DESIGN. This passes identically before and after the fix and
  // proves NOTHING about the org clock. It exists solely as a tripwire: the timezone must be
  // resolved by the CALLER and threaded in as a parameter, never awaited INSIDE
  // loadCustomerFinancials. An internal await would push the financials query behind the other
  // two in the Promise.all, silently corrupting `customers.test.ts:1814-1815` (which indexes
  // `mock.calls[1]`/`[2]`) and every `mockResolvedValueOnce` chain in
  // `tag-read-hydration.test.ts:69-72` — a failure that would read as an unrelated flake.
  it('financials is still calls[0], estimate stats calls[1], deposit stats calls[2]', async () => {
    const res = await request(app)
      .get(`/api/customers/${CUSTOMER_ID}/summary`)
      .set(authHeader('admin'));
    expect(res.status).toBe(200);

    const calls = (prisma.$queryRaw as Mock).mock.calls;
    expect(calls).toHaveLength(3);
    const sqlAt = (n: number) => (calls[n][0] as string[]).join('');
    expect(sqlAt(0)).toContain('AS past_due_balance');
    expect(sqlAt(1)).toContain('FROM estimates e');
    expect(sqlAt(2)).toContain('JOIN estimates e');
  });
});
