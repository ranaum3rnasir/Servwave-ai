# Defect A — the `?overdue=true` facet and the OVERDUE chip use different clocks

Branch: `staging` (`origin/staging` @ `a66ab84d5`). Also present on `origin/main`.

## 1. Root cause

`?overdue=true` and the Overdue KPI tile ask Postgres "is `due_date` before **this instant**". The chip that
renders on those same rows asks "is `due_date`'s **org calendar day** before today's org calendar day".
Those are different questions for every invoice due earlier today.

Three sites, all verified current:

| # | file:line (`origin/staging`) | code |
|---|---|---|
| 1 | `backend/src/controllers/invoice.controller.ts:955` | `where.due_date = { ...((where.due_date as Record<string, unknown> \| undefined) ?? {}), lt: new Date() };` |
| 2 | `backend/src/controllers/invoice.controller.ts:1019` | `where: { ...scopeWhere, status: { in: ['SENT','PARTIAL'] }, due_date: { lt: now } }` |
| 3 | `backend/src/controllers/dashboard.controller.ts:248` | `where: { ...orgWhere, status: { in: ['SENT','PARTIAL'] }, due_date: { lt: now } }` (`origin/main:240`) |

Against `frontend/src/pages/v2/invoices/invoicesColumns.tsx:50-53`:

```ts
export function isOverdue(invoice: InvoiceListItem, timeZone: string): boolean {
  if (!invoice.due_date) return false;
  if (invoice.status !== 'SENT' && invoice.status !== 'PARTIAL') return false;
  return orgDayDiff(invoice.due_date, timeZone) < 0;
}
```

and `frontend/src/lib/schedule-tz.ts:187-191`:

```ts
export function orgDayDiff(iso: string, tz: string, nowIso?: string): number {
  const target = isoToOrgDay(iso, tz);
  const today  = isoToOrgDay(nowIso ?? new Date().toISOString(), tz);
  return Math.round((Date.parse(`${target}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / 86_400_000);
}
```

**Concrete repro.** Org = ServWave Test (`America/New_York`). Invoice `SENT`,
`due_date = 2026-08-25T14:00:00.000Z`. Server clock = `2026-08-25T18:00:00.000Z`.

- Backend site 1: `14:00Z < 18:00Z` -> **row returned by `?overdue=true`**.
- Frontend chip: `isoToOrgDay(due) = 2026-08-25`, `isoToOrgDay(now) = 2026-08-25`, diff `0`, `0 < 0` false
  -> **plain SENT chip**.

A row in the Overdue list that does not say Overdue. Site 2 counts it in the KPI tile, so the tile number
and the number of visible OVERDUE chips disagree. Site 3 is worse: it selects the row, then
`dashboard.controller.ts:759` computes `orgDayDiff(inv.due_date!, now, timeZone)` = `0` and renders
**"0 days past due"** with badge **"0d"** — the mismatch is visible inside a single response.

`origin/main` and `origin/staging` are byte-identical for `invoice.controller.ts`, so sites 1 and 2 ship in
production. Site 3 exists on both branches too. PR #1804 moved the readers to the org clock and left the
writers on instants, so it converted a latent inconsistency into a visible one.

## 2. The canonical rule

> An invoice is **overdue** iff its status is `SENT` or `PARTIAL`, its `due_date` is non-NULL, and
> `due_date` falls strictly **before the instant the org's current calendar day began**.

Boundary, stated explicitly: **an invoice whose `due_date` falls anywhere on today's org calendar day —
including 00:00:00 org-local and including 23:59 org-local — is NOT overdue.** It becomes overdue the moment
the org's clock ticks into the next calendar day. This is the exact Prisma expression of
`orgDayDiff(due_date, tz) < 0`: `orgDayDiff` reduces both sides to a `YYYY-MM-DD` string first, so any two
instants sharing an org calendar day are equal at diff `0`.

### As a Prisma `where`

```ts
due_date: { lt: orgDayStart(orgDayOf(new Date(), timeZone), timeZone) }
```

Both helpers already exist and are exported from `backend/src/lib/orgDayRange.ts`:

- `orgDayOf(at: Date, timeZone: string): string` — the org calendar day an instant falls on.
- `orgDayStart(day: string, timeZone: string): Date` — the instant that org day begins, via `date-fns-tz`'s
  `fromZonedTime` (the same primitive the frontend's `orgDayStart` uses, and correct in zones where a
  calendar day does not begin at 00:00 local).

**Add one helper** to `backend/src/lib/orgDayRange.ts` rather than repeating the composition at three call
sites — it is the twin of the frontend's `orgToday` + `orgDayStart`:

```ts
/**
 * The instant the org's CURRENT calendar day began — the OVERDUE boundary.
 * `due_date: { lt: orgTodayStart(tz) }` is the Prisma expression of the frontend's
 * `orgDayDiff(due_date, tz) < 0` (invoicesColumns.tsx / invoiceMoney.ts). An invoice due
 * anywhere on today's org day is NOT yet overdue, at either edge of the day.
 */
export function orgTodayStart(timeZone: string, at: Date = new Date()): Date {
  return orgDayStart(orgDayOf(at, timeZone), timeZone);
}
```

Note `due_date: { lt: X }` in Postgres already excludes `NULL` rows, matching `isOverdue`'s
`if (!invoice.due_date) return false`. No `NOT: { due_date: null }` needed.

### Where the controller obtains the org timezone

`backend/src/lib/timezone.ts` exports **`getRequestOrgTimezone(req)`** — reads `req.user.organization_id`,
resolves `Organization.timezone` (falling back to `DEFAULT_TIMEZONE = 'America/New_York'`), and
**memoizes on the request object under `Symbol.for('alpha.orgTimezone')`**. It never throws and does no DB
lookup when there is no authenticated org.

This is already the accepted precedent in both files:

- `backend/src/lib/query/filterEngine.ts:190-206` — `applyFilters`'s `timezoneFor()` calls it lazily, only
  when a bound is actually a bare org day. `applyFilters` already runs on this exact `where` at
  `invoice.controller.ts:945`, so on a request with a `due_after` chip the memo is already primed and the
  overdue fix costs **zero** extra queries.
- `dashboard.controller.ts:68` — `const timeZonePromise = getRequestOrgTimezone(req);` started early,
  awaited at `:639`.

`buildInvoiceListWhere(req: Request)` (`invoice.controller.ts:929`) receives the full `req`, so it can call
`getRequestOrgTimezone(req)` directly. Note the file already imports `getOrgTimezone` from `../lib/timezone`
at line 44 — extend that import, do **not** use `getOrgTimezone` here (it is unmemoized and would add a
lookup per call site).

Follow filterEngine's lazy discipline: resolve the timezone **inside** the `if (overdue)` block, not
unconditionally.

## 3. Every call site that must change

### IN SCOPE

**A. `backend/src/controllers/invoice.controller.ts:954-957`** — the `?overdue=true` facet.

```ts
if (overdue) {
  // The org clock, resolved only on this branch (filterEngine's discipline): a request
  // without ?overdue=true must not pay for a lookup it cannot use. Memoized per request,
  // so it is free when a `due` chip already resolved it in applyFilters above.
  const timeZone = await getRequestOrgTimezone(req);
  where.due_date = {
    ...((where.due_date as Record<string, unknown> | undefined) ?? {}),
    lt: orgTodayStart(timeZone),
  };
  where.status = { in: ['SENT', 'PARTIAL'] };
}
```

The existing merge-onto-`due_after` and status-overwrite semantics documented at lines 947-953 are
unchanged — only the value of `lt` moves. `exportAll` (`:1024`+) calls `buildInvoiceListWhere` and is fixed
transitively; no separate edit.

**B. `backend/src/controllers/invoice.controller.ts:1017-1022`** — the Overdue KPI tile.

Resolve once in `list()` and use it for the aggregate. Place it beside `const now = new Date();` (`:1000`);
the memo means at most one lookup for the whole request, shared with A.

```ts
const timeZone = await getRequestOrgTimezone(req);
const overdueBefore = orgTodayStart(timeZone, now);
// ...
prisma.invoice.aggregate({
  where: { ...scopeWhere, status: { in: ['SENT', 'PARTIAL'] }, due_date: { lt: overdueBefore } },
  _sum: { amount_due: true },
  _count: true,
}),
```

Pass `now` explicitly so the KPI and the list rows in the same response cannot straddle a midnight tick.

**C. `backend/src/controllers/dashboard.controller.ts:247-262`** — the Needs Attention overdue-invoice query.

This one is in scope because it is the *same* bug and it is self-contradicting within one response: the
query selects on the server instant, then `:759` labels the row with `orgDayDiff(...)`. Leaving it produces
"Invoice INV-123 overdue · 0 days past due". The file already has `timeZone` available — but at `:639`,
*after* the batch. Awaiting `timeZonePromise` before the `Promise.all` serialises one small lookup ahead of
~30 queries, which the comment at `:60-65` deliberately avoided. Two acceptable options; the fixer picks one
and says why in the PR:

- **C1 (preferred)** — hoist to `const timeZone = await getRequestOrgTimezone(req);` immediately after
  `const now = new Date();` (`:62`), drop `timeZonePromise` and the `await` at `:639`. Cost is one memoized
  ~1ms lookup on the critical path; correctness beats it.
- **C2** — keep the promise, and move only the overdue sub-query out of the `Promise.all` into a small
  awaited-tz block. More code, uglier, preserves the parallelism.

Also update the `daysPastDue <= 0` / `daysPast` comment block to note that the query boundary and the label
now share one rule.

**D. `backend/src/lib/orgDayRange.ts`** — add `orgTodayStart` (section 2).

### OUT OF SCOPE — confirmed, do not touch

The fixer must not wander into these. Each is a real inconsistency; each needs its own defect.

- **`backend/src/controllers/customer.controller.ts:603` and `:607`** — raw SQL in `$queryRaw`:
  `AND i2.status IN ('SENT','PARTIAL') AND i2.due_date < NOW()` (past-due balance) and
  `AND (i2.due_date IS NULL OR i2.due_date >= NOW())` (due balance). **Out of scope.** Fixing means threading
  an org-day-start parameter into a raw SQL template and re-verifying both balances sum to the same total —
  a separate change with its own test surface.
- **`backend/src/services/invoices-report.ts:72`** —
  `if (dueDate && dueDate.getTime() < now.getTime()) return 'Overdue';` inside
  `displayStatusFor(status, amountDue, now, dueDate)`. **Out of scope.** It is a pure function with no
  `timeZone` parameter; correcting it changes a public signature and ripples through `buildInvoicesReport`
  (`:83`) and `backend/src/__tests__/invoices-report.test.ts`.
- **`backend/src/controllers/dashboard.controller.ts:216-219` + `:690-700` (AR Aging)** —
  `prisma.invoice.findMany({ where: { ...orgWhere, ...arOutstandingWhere } })`, then bucketed in JS with
  `orgDayDiff(inv.due_date, now, timeZone)`. **Already correct.** `arOutstandingWhere`
  (`backend/src/lib/ar.ts`) carries no date predicate at all, so there is no instant/org-day split to fix.
- **Everything else matching `due_date` in `invoice.controller.ts`** (`:136`, `:302`, `:536`, `:736`, `:884`,
  `:1146`, `:1163-1199`, `:1500`, `:1543`, `:1662`, `:1788`, `:1797`, `:2374`) — writes, selects and
  PDF/email payloads. No comparison. Untouched.

`git grep -n "due_date: { lt" origin/staging -- 'backend/src/**/*.ts'` (excluding tests) returns **exactly**
`dashboard.controller.ts:248` and `invoice.controller.ts:1019`. Site 1 (`invoice.controller.ts:955`) is the
only other Prisma instant comparison and is written inline. That is the complete set.

## 4. Failing tests to write first (strict TDD)

New file, following the `backend/src/__tests__/` layout that `invoices.test.ts` and `dashboard-*.test.ts`
use (`backend/vitest.config.ts` includes `src/__tests__/**/*.test.ts`).

### `backend/src/__tests__/invoice-overdue-org-clock.test.ts`

**Shared harness.**

```ts
// MANDATORY: toFake:['Date'] only. Faking all timers deadlocks supertest's real HTTP IO.
// Precedent: backend/src/__tests__/dashboard-visit-window-repoint.test.ts:72.
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'], now: new Date('2026-08-25T18:00:00.000Z') });
  vi.clearAllMocks();
  // setup.ts leaves organization.findUnique a bare vi.fn() -> undefined -> DEFAULT_TIMEZONE.
  // Set it AFTER clearAllMocks. getRequestOrgTimezone memoizes on `req`, not globally,
  // so there is no cross-test cache to clear.
  (prisma.organization.findUnique as Mock).mockResolvedValue({ timezone: 'America/New_York' });
  stubInvoiceListQueries(); // findMany [], count 0/0, aggregate x2, payment.aggregate, job.count 0
});
afterEach(() => { vi.useRealTimers(); });
```

Auth via `mockAuthAs('admin')` / `authHeader('admin')` from `backend/src/__tests__/helpers.ts`
(org `ALPHA_ORG_ID`).

**Boundary instants** (computed and verified with `Intl` for 2026-08-25; both zones are in DST — EDT -04:00,
MDT -06:00):

| frozen now | zone | org day | `orgTodayStart` |
|---|---|---|---|
| `2026-08-25T18:00:00Z` | America/New_York | 2026-08-25 | **`2026-08-25T04:00:00.000Z`** |
| `2026-08-25T18:00:00Z` | America/Denver | 2026-08-25 | **`2026-08-25T06:00:00.000Z`** |
| `2026-08-25T18:00:00Z` | UTC | 2026-08-25 | `2026-08-25T00:00:00.000Z` |
| `2026-08-25T02:30:00Z` | America/New_York | 2026-08-24 | **`2026-08-24T04:00:00.000Z`** |
| `2026-08-25T02:30:00Z` | UTC | 2026-08-25 | `2026-08-25T00:00:00.000Z` |

Four candidate clocks — server instant, UTC day, Eastern day, Mountain day — produce four distinct instants.
**Assert the exact ISO string.** An `expect.any(Date)` assertion (which is what the current
`invoices.test.ts:1290` does) passes under every one of them and proves nothing.

**Tests:**

1. **`'?overdue=true cuts at the org day start, not the server instant (America/New_York)'`**
   `GET /api/invoices?overdue=true`. Assert `findMany.mock.calls[0][0].where.due_date.lt.toISOString()`
   `=== '2026-08-25T04:00:00.000Z'`. Also assert it is **not** `'2026-08-25T18:00:00.000Z'`.
   **Fails today** (today's value is the frozen `now`).

2. **`'DISCRIMINATOR: an America/Denver org cuts at 06:00Z, not 04:00Z — the boundary tracks the ORG zone'`**
   `organization.findUnique -> { timezone: 'America/Denver' }`. Same frozen instant, same request. Assert
   `=== '2026-08-25T06:00:00.000Z'`. **This is the test that earns its keep.** Tests 1 and 2 differ only in
   the org row, so a fix that hardcodes Eastern (or reads a server-level `TZ`) passes 1 and fails 2. Both
   orgs exist in staging: ServWave Test and Alpha Doors are `America/New_York`, Talon Septic is
   `America/Denver`.

3. **`'DISCRIMINATOR: the boundary is the ORG day start, not UTC midnight'`**
   Re-freeze to `2026-08-25T02:30:00.000Z` (22:30 EDT on Aug 24). Org `America/New_York`. Assert
   `=== '2026-08-24T04:00:00.000Z'`. A UTC-day implementation yields `2026-08-25T00:00:00.000Z` and fails;
   a server-instant implementation yields `02:30Z` and fails.

4. **`'an invoice due EARLIER TODAY on the org calendar is NOT selected by the facet'`**
   The reported symptom, asserted as a predicate over the boundary rather than over canned mock rows:

   ```ts
   const lt = findMany.mock.calls[0][0].where.due_date.lt;
   const dueEarlierToday = new Date('2026-08-25T14:00:00.000Z'); // 10:00 EDT, today
   expect(dueEarlierToday < lt).toBe(false);          // excluded — agrees with the chip
   const dueYesterday = new Date('2026-08-24T14:00:00.000Z');
   expect(dueYesterday < lt).toBe(true);              // included — still overdue
   ```

   **Fails today** on the first assertion.

5. **`'the boundary is INCLUSIVE of the whole org day at both edges'`**
   Same request. `new Date('2026-08-25T04:00:00.000Z') < lt` -> `false` (00:00:00 org-local today, not
   overdue). `new Date('2026-08-26T03:59:59.999Z') < lt` -> `false` (23:59:59 org-local today, not overdue).
   Pins the boundary against an off-by-one-day fix.

6. **`'the Overdue KPI tile uses the same boundary as the list rows in the same response'`**
   One `GET /api/invoices?overdue=true`. `list()` issues `invoice.aggregate` twice in the `Promise.all` at
   `:1002` — `[0]` is due, `[1]` is overdue. Assert

   ```ts
   expect(aggregate.mock.calls[1][0].where.due_date.lt.getTime())
     .toBe(findMany.mock.calls[0][0].where.due_date.lt.getTime());
   ```

   This is the KPI-vs-chip disagreement expressed directly. **Fails today** — site 1 builds a fresh
   `new Date()` and site 2 uses the hoisted `now`; even after a partial fix they can differ.

7. **`'the Overdue KPI tile cuts at the org day start on an unfiltered request (America/Denver)'`**
   Denver org, plain `GET /api/invoices` (no `overdue` param — the KPI always computes). Assert
   `aggregate.mock.calls[1][0].where.due_date.lt.toISOString() === '2026-08-25T06:00:00.000Z'`. Catches a
   fix applied only to site 1.

8. **`'the export applies the same org-day boundary as the list'`**
   `GET /api/invoices/export?overdue=true`, Denver org. Assert `'2026-08-25T06:00:00.000Z'`. Guards the
   `buildInvoiceListWhere` sharing that `invoices.test.ts:7277` already relies on.

9. **`'overdue + due_after still merges into one due_date range'`** (regression guard, passes before and after)
   `GET /api/invoices?overdue=true&due_after=2026-06-01T00:00:00.000Z`. Assert `where.due_date.gte` is a Date
   **and** `where.due_date.lt.toISOString() === '2026-08-25T04:00:00.000Z'`. Protects the merge semantics
   documented at `invoice.controller.ts:947-953` (a naive `where.due_date = { lt: ... }` rewrite would
   silently drop `gte`). Strengthens the weaker existing `invoices.test.ts:1429`.

### `backend/src/__tests__/dashboard-overdue-org-clock.test.ts`

10. **`'the Needs Attention overdue-invoice query cuts at the org day start (America/Denver)'`**
    Frozen `2026-08-25T18:00:00.000Z`, Denver org, `GET /api/dashboard`. Find the `invoice.findMany` call
    whose `where.status` is `{ in: ['SENT','PARTIAL'] }` (distinguishes it from the AR call at `:216`, whose
    `where` carries `arOutstandingWhere` and no `due_date`). Assert
    `where.due_date.lt.toISOString() === '2026-08-25T06:00:00.000Z'`. Stub via the existing
    `stubEveryDashboardQuery()` pattern in `dashboard-visit-window-repoint.test.ts`.

11. **`'a Needs Attention item can never read 0 days past due'`**
    Return one invoice with `due_date = 2026-08-25T14:00:00.000Z` from that `findMany`. Assert no `attention`
    item in the response body has `badge === '0d'`. This asserts the *invariant* the two clocks jointly
    violate, and it is the one dashboard test that would still catch the bug if someone reverted the query
    fix but kept the label fix.

### `backend/src/__tests__/orgDayRange.test.ts` (extend the existing file)

12. **`'orgTodayStart: names the instant the ORG day began, not UTC midnight'`** —
    `orgTodayStart('America/New_York', new Date('2026-08-25T02:30:00Z'))` -> `2026-08-24T04:00:00.000Z`.
13. **`'orgTodayStart: differs between two US zones on the same instant'`** — NY `04:00Z` vs Denver `06:00Z`
    for `2026-08-25T18:00:00Z`.
14. **`'orgTodayStart: tracks the DST offset rather than assuming a fixed one'`** — same calendar date in
    January vs August for `America/Denver` (`-07:00` vs `-06:00`). Mirrors the existing `orgDayStart` DST
    test at `orgDayRange.test.ts:57`.

**Existing test that must be updated, not deleted:** `backend/src/__tests__/invoices.test.ts:1287-1294`
asserts `due_date: expect.objectContaining({ lt: expect.any(Date) })`. It still passes after the fix.
Tighten it to the exact boundary (or leave it and let the new file carry the load) — but do **not** let its
green state be read as evidence the fix landed. Same for `invoices.test.ts:7284`.

## 5. The mocked-Prisma hazard

`backend/src/__tests__/setup.ts` replaces the entire `prisma` client with `vi.fn()`s
(`organization.findUnique` at `:813-814`). Every test above is a **supertest -> real Express -> real
controller -> mocked Prisma** round trip.

**What they prove — SHAPE only.** Tests 1-11 prove the controller *computed and passed* a specific instant
as `where.due_date.lt`. That is exactly the bug (the controller computes the wrong instant), so shape is the
right assertion target here — but be honest about the limit: **no test above touches Postgres, and none
proves a single row was or was not returned.** The mocked `findMany` returns whatever the test canned it to
return regardless of the `where`.

**What they do not prove:**

- That Postgres's `timestamptz < $1` selects the rows we expect. Prisma/Postgres primitive behaviour with no
  project-specific risk. Not worth an integration test.
- That `due_date IS NULL` rows are excluded by `lt`. Standard three-valued SQL logic; also trusted.
- That `Organization.timezone` actually holds `America/Denver` for Talon Septic. Verify with a read-only
  `SELECT id, name, timezone FROM "Organization"` on staging ref `knriiqdqxgfoecsfarlx` before writing
  test 2 — **never** production `fvcjinnllchzqcupmrah`.

**Integration test: not needed.** The repo has an opt-in real-DB pattern
(`backend/src/lib/query/__tests__/filterEngine.count.integration.test.ts`, gated on
`RUN_INTEGRATION_TESTS=1`), and it exists because `groupBy`+`having` generates SQL nobody could predict.
`lt` on a timestamp column is not in that category. **Do not add one.**

**The one thing shape tests cannot cover** is the end-to-end claim "the row set and the chip set are
identical". Verify that once, by hand, after the fix: on staging as Talon Septic (`America/Denver`), find an
invoice whose `due_date` is earlier today MDT, load `/invoices?overdue=true`, and confirm the row is
**absent** and the KPI count excludes it. That is a manual QA step for the PR description, not a test.

## 6. Risks and regressions

**The `?overdue=true` facet narrows.** Invoices due earlier today drop out of the list and out of the KPI.
That is the fix, but it is a user-visible count change on day one, and the Overdue KPI number will tick down
for every org that has an invoice due today. Say so in the PR body.

**Consumers of the facet:**

- `frontend/src/pages/v2/invoices/InvoicesPage.tsx` — the Overdue KPI tile is a clickable filter;
  `overdueKpiActive` (`:333`) highlights the tile when the facet is on and no other facet is set. Tile count
  and row count now come from the same boundary. Net improvement, no code change.
- `frontend/src/lib/filters/registries/invoices.ts:158-160` — `overdue` is a 1-option `multi` facet encoding
  `?overdue=true`. Wire contract unchanged.
- `exportAll` — the CSV row set narrows identically. Intended: the export is documented
  (`invoice.controller.ts:1024-1027`) as column- and row-identical to the list.
- `backend/src/__tests__/invoices.test.ts:1287`, `:1429`, `:7277` — all three still pass
  (`expect.any(Date)` / `toBeInstanceOf(Date)`), so **CI going green is not evidence the fix landed.** The
  new file is the evidence.

**Timezone lookup cost.** `getRequestOrgTimezone` memoizes per request, so the invoice list pays at most one
extra `organization.findUnique` and often zero (already primed by `applyFilters` when a date chip is set).
The dashboard under option C1 pays one memoized lookup on the critical path ahead of ~30 parallel queries.
Both negligible; both worth calling out because `dashboard.controller.ts:60-65` explicitly reasons about not
serialising this.

**Org with no `timezone` set.** `getOrgTimezone` falls back to `DEFAULT_TIMEZONE = 'America/New_York'`, and
the frontend's `DEFAULT_SCHEDULE_TIMEZONE` (`schedule-tz.ts:31`) is the same string, so the fallback keeps
the two sides in agreement. Confirm no org in staging has a NULL/empty `timezone` before shipping.

**Residual known inconsistencies after this fix.** The Invoices *report* (`invoices-report.ts:72`) and the
customer detail page's past-due/due balance split (`customer.controller.ts:603/607`) still use raw instants,
so a customer whose invoice is due earlier today will read "Overdue" in the report and carry a past-due
balance on their detail page while the invoices list says otherwise. **This fix narrows the inconsistency,
it does not close it.** File follow-up defects; do not fix them here.

**Do not "fix" `dashboard.controller.ts:695`** (`daysPastDue <= 0 -> arCurrent`). AR Aging classifies in JS
on the org clock and has no query-side date predicate. It is already correct.
