/**
 * Defect A — the `?overdue=true` facet, the Overdue KPI tile and the OVERDUE chip must all
 * read one clock.
 *
 * The backend asked Postgres "is `due_date` before THIS INSTANT". The chip rendered on those
 * same rows asks "is `due_date`'s ORG CALENDAR DAY before today's org calendar day"
 * (`invoicesColumns.tsx` -> `orgDayDiff(due, tz) < 0`). For every invoice due earlier today
 * those are different questions, so the Overdue list contained rows that did not say Overdue
 * and the KPI counted them.
 *
 * WHY THE ASSERTIONS ARE EXACT ISO STRINGS. At the frozen instant below, four plausible
 * clocks give four distinct answers:
 *
 *     server instant   2026-08-25T18:00:00.000Z
 *     UTC day start    2026-08-25T00:00:00.000Z
 *     Eastern day      2026-08-25T04:00:00.000Z
 *     Mountain day     2026-08-25T06:00:00.000Z
 *
 * `expect.any(Date)` (what invoices.test.ts:1287 asserts) is satisfied by all four and proves
 * nothing. The America/Denver cases are the discriminators: a fix that hardcodes Eastern, or
 * reads a server-level TZ, passes the New_York cases and fails those.
 *
 * WHAT THESE TESTS PROVE — SHAPE ONLY. setup.ts replaces the whole Prisma client with vi.fn()s,
 * so every case here is supertest -> real Express -> real controller -> mocked Prisma. They
 * prove the controller COMPUTED and PASSED a specific instant as `where.due_date.lt`. That is
 * precisely the bug. They do not touch Postgres and do not prove a row was returned; `lt` on a
 * timestamp column is primitive behaviour and is trusted.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { Mock } from 'vitest';
import request from 'supertest';
import app from '../app';
import { prisma } from '../lib/prisma';
import { mockAuthAs, authHeader } from './helpers';
import { clearTokenCache } from '../middleware/authenticate';

const NY = 'America/New_York';
const DENVER = 'America/Denver'; // staging: Riverbend Septic, LLC

const NOW = '2026-08-25T18:00:00.000Z';
const NY_DAY_START = '2026-08-25T04:00:00.000Z';
const DENVER_DAY_START = '2026-08-25T06:00:00.000Z';

/** Everything `list()` awaits. `exportAll` needs only `invoice.findMany`. */
function stubInvoiceListQueries() {
  (prisma.invoice.findMany as Mock).mockResolvedValue([]);
  (prisma.invoice.count as Mock).mockResolvedValue(0);
  (prisma.invoice.aggregate as Mock).mockResolvedValue({ _sum: { amount_due: 0 }, _count: 0 });
  (prisma.payment.aggregate as Mock).mockResolvedValue({ _sum: { amount: 0 }, _count: 0 });
  (prisma.job.count as Mock).mockResolvedValue(0);
  (prisma.tagAssignment.findMany as Mock).mockResolvedValue([]);
}

/** Point the org's configured zone. getRequestOrgTimezone memoizes on `req`, so there is no
 *  cross-test cache to clear — each request resolves this afresh. */
function orgTimezone(tz: string) {
  (prisma.organization.findUnique as Mock).mockResolvedValue({ timezone: tz });
}

const listWhere = () => (prisma.invoice.findMany as Mock).mock.calls[0][0].where;
/** `list()` issues invoice.aggregate twice, in array order: [0] due, [1] overdue. */
const overdueAggregateWhere = () => (prisma.invoice.aggregate as Mock).mock.calls[1][0].where;

// MANDATORY: toFake:['Date'] only. Faking all timers deadlocks supertest's real HTTP IO.
// Precedent: dashboard-visit-window-repoint.test.ts.
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'], now: new Date(NOW) });
  vi.clearAllMocks();
  clearTokenCache();
  mockAuthAs('admin');
  // setup.ts leaves organization.findUnique a bare vi.fn() -> undefined -> DEFAULT_TIMEZONE.
  // Set it AFTER clearAllMocks/mockAuthAs.
  orgTimezone(NY);
  stubInvoiceListQueries();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('GET /api/invoices?overdue=true — the facet cuts on the ORG clock', () => {
  it('?overdue=true cuts at the org day start, not the server instant (America/New_York)', async () => {
    const res = await request(app).get('/api/invoices?overdue=true').set(authHeader('admin'));
    expect(res.status).toBe(200);

    const lt: Date = listWhere().due_date.lt;
    expect(lt.toISOString()).toBe(NY_DAY_START);
    // The pre-fix value, named explicitly so a regression reads as a regression.
    expect(lt.toISOString()).not.toBe(NOW);
    expect(listWhere().status).toEqual({ in: ['SENT', 'PARTIAL'] });
  });

  it('DISCRIMINATOR: an America/Denver org cuts at 06:00Z, not 04:00Z — the boundary tracks the ORG zone', async () => {
    orgTimezone(DENVER);

    const res = await request(app).get('/api/invoices?overdue=true').set(authHeader('admin'));
    expect(res.status).toBe(200);

    // Identical instant, identical request — only the org row differs. A fix that hardcodes
    // Eastern passes the case above and fails here.
    expect(listWhere().due_date.lt.toISOString()).toBe(DENVER_DAY_START);
  });

  it('DISCRIMINATOR: the boundary is the ORG day start, not UTC midnight', async () => {
    // 02:30Z on Aug 25 is 22:30 EDT on Aug 24 — the org is still in YESTERDAY'S calendar day.
    vi.setSystemTime(new Date('2026-08-25T02:30:00.000Z'));

    const res = await request(app).get('/api/invoices?overdue=true').set(authHeader('admin'));
    expect(res.status).toBe(200);

    // A UTC-day implementation yields 2026-08-25T00:00:00.000Z; the server instant yields 02:30Z.
    expect(listWhere().due_date.lt.toISOString()).toBe('2026-08-24T04:00:00.000Z');
  });

  it('an invoice due EARLIER TODAY on the org calendar is NOT selected by the facet', async () => {
    const res = await request(app).get('/api/invoices?overdue=true').set(authHeader('admin'));
    expect(res.status).toBe(200);

    // The reported symptom, asserted as a predicate over the boundary the controller built
    // rather than over canned mock rows (a mocked findMany returns its canned rows whatever
    // the `where` says, so only the boundary itself can carry this).
    const lt: Date = listWhere().due_date.lt;
    const dueEarlierToday = new Date('2026-08-25T14:00:00.000Z'); // 10:00 EDT, today
    expect(dueEarlierToday < lt).toBe(false); // excluded — agrees with the chip
    const dueYesterday = new Date('2026-08-24T14:00:00.000Z');
    expect(dueYesterday < lt).toBe(true); // included — genuinely overdue
  });

  it('the boundary is INCLUSIVE of the whole org day at both edges', async () => {
    const res = await request(app).get('/api/invoices?overdue=true').set(authHeader('admin'));
    expect(res.status).toBe(200);

    const lt: Date = listWhere().due_date.lt;
    // 00:00:00 org-local today — the first instant of today, not overdue.
    expect(new Date('2026-08-25T04:00:00.000Z') < lt).toBe(false);
    // 23:59:59.999 org-local today — the last instant of today, still not overdue.
    expect(new Date('2026-08-26T03:59:59.999Z') < lt).toBe(false);
    // 23:59:59.999 org-local YESTERDAY — overdue. Pins against an off-by-one-day fix.
    expect(new Date('2026-08-25T03:59:59.999Z') < lt).toBe(true);
  });

  it('overdue + due_after still merges into one due_date range', async () => {
    const res = await request(app)
      .get('/api/invoices?overdue=true&due_after=2026-06-01T00:00:00.000Z')
      .set(authHeader('admin'));
    expect(res.status).toBe(200);

    // A naive `where.due_date = { lt: ... }` rewrite would silently drop the facet's `gte`.
    const dueDate = listWhere().due_date;
    expect(dueDate.gte).toBeInstanceOf(Date);
    expect(dueDate.gte.toISOString()).toBe('2026-06-01T00:00:00.000Z');
    expect(dueDate.lt.toISOString()).toBe(NY_DAY_START);
  });
});

describe('GET /api/invoices — the Overdue KPI tile shares the list boundary', () => {
  it('the Overdue KPI tile uses the same boundary as the list rows in the same response', async () => {
    const res = await request(app).get('/api/invoices?overdue=true').set(authHeader('admin'));
    expect(res.status).toBe(200);

    // The KPI-vs-chip disagreement expressed directly: one response, two queries, one instant.
    // Before the fix the facet built a FRESH `new Date()` while the tile used the hoisted `now`,
    // so even a partial fix can leave these two apart.
    expect(overdueAggregateWhere().due_date.lt.getTime())
      .toBe(listWhere().due_date.lt.getTime());
    expect(overdueAggregateWhere().due_date.lt.toISOString()).toBe(NY_DAY_START);
  });

  it('the Overdue KPI tile cuts at the org day start on an unfiltered request (America/Denver)', async () => {
    orgTimezone(DENVER);

    // No `overdue` param — the tile always computes. Catches a fix applied only to the facet.
    const res = await request(app).get('/api/invoices').set(authHeader('admin'));
    expect(res.status).toBe(200);

    expect(overdueAggregateWhere().due_date.lt.toISOString()).toBe(DENVER_DAY_START);
    // ...and the list itself carries no due_date predicate on an unfiltered request.
    expect(listWhere().due_date).toBeUndefined();
  });
});

describe('GET /api/invoices/export — shares buildInvoiceListWhere', () => {
  it('the export applies the same org-day boundary as the list', async () => {
    orgTimezone(DENVER);

    const res = await request(app).get('/api/invoices/export?overdue=true').set(authHeader('admin'));
    expect(res.status).toBe(200);

    expect(listWhere().due_date.lt.toISOString()).toBe(DENVER_DAY_START);
    expect(listWhere().status).toEqual({ in: ['SENT', 'PARTIAL'] });
  });
});
