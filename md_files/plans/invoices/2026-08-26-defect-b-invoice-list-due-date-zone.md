# Defect B — the invoices-list Due Date column formats in the browser's timezone

Date: 2026-08-26
Branch: `staging` (verified against `origin/staging` @ `a66ab84d5`)
Related: PR #1804 (invoice due-date org-zone fix)

## 0. PREREQUISITE — work from `origin/staging`

The main checkout at `/Users/ranroffe/ALPHA_CRM/alpha_crm` is **895 commits behind `origin/staging`,
0 ahead**, with ~100 unrelated modified files in flight. Every file named in this plan exists on
`origin/staging` and **none of them exist on disk** at that stale commit — `frontend/src/pages/v2/`
is entirely absent.

Do not "fix" this by discarding the working tree. Work in the dedicated worktree cut from
`origin/staging` (`../alpha_crm-worktrees/invoice-org-clock`).

If `frontend/src/pages/v2/invoices/invoicesColumns.tsx` is not on disk, STOP — you are on the stale
commit. Do not conclude the file doesn't exist. Verify with:

    git show origin/staging:frontend/src/pages/v2/invoices/invoicesColumns.tsx | head

## 1. Which file the app actually routes to (the v1/v2 fork)

Confirmed by following the route table, not by filename guessing:

1. `frontend/src/App.tsx:10` imports `v2Routes` from `@/pages/v2/V2Routes` — and `App.tsx` contains
   **no other invoice route**.
2. `frontend/src/pages/v2/routes/invoices.routes.tsx:8`
   `const InvoicesPage = lazy(() => import('../invoices/InvoicesPage'))` and `:34`
   `<Route path="/invoices" element={<InvoicesPage />} />`.
3. `frontend/src/pages/v2/invoices/InvoicesPage.tsx:51-52` imports
   `buildInvoiceColumns, isOverdue, DEFAULT_COLUMN_VISIBILITY` from `./invoicesColumns`.

=> The routed columns file is **`frontend/src/pages/v2/invoices/invoicesColumns.tsx`**.

`frontend/src/components/invoices/invoicesColumns.tsx` does not exist (that directory holds dialogs
only).

### The v1 equivalent — dead in production, alive in tests

`frontend/src/pages/InvoicesPage.tsx` still exists, declares its own inline `columns` array, and
carries the *same* defect at `:292` and `:550`. It is **not routed** — nothing imports it except six
test files (`date-only-rendering.test.tsx`, `invoices-jobless-render.test.tsx`,
`invoices-page.test.tsx`, `list-sort-lockstep.test.ts`, `list-status-defaults.test.tsx`,
`to-be-invoiced.test.tsx`).

**Do not touch the legacy page.** `pages/v2/invoices/__tests__/invoiceDetailHeading.test.tsx:17-18`
records the standing rule: *"The legacy suites in `src/__tests__` are the behavioural contract for
the legacy page and stay pointed at it."* Editing it will break those six suites for zero
user-facing benefit. Its removal is a separate dead-code ticket.

## 2. Root cause

`new Date(iso).toLocaleDateString()` with no `timeZone` option resolves the instant against the
**viewer's browser zone**. `due_date` is stored as a true instant (e.g. `2026-07-11T02:35:09.368Z`),
so for any viewer east of the org the instant has already rolled into the next calendar day and the
column prints tomorrow. PR #1804 moved the invoice *detail* page onto the org clock but left the
*list* behind, so the same invoice now renders two different days on two screens of the same app.
QA's repro, invoice `I00118` (ServWave Test, `America/New_York`): the list says `7/11`, the detail
page says `7/10`.

Secondary, same root cause: the format string is also **locale-dependent** — bare
`toLocaleDateString()` takes the runtime's default locale, so the same cell can render `11/07/2026`
on a non-US runner. `formatInstant` pins `en-US`, which removes that too.

### Full inventory of defective date renders

**In `frontend/src/pages/v2/invoices/invoicesColumns.tsx`:**

| Line | Column id | Current code | Defect |
|------|-----------|--------------|--------|
| 322 | `due_date` | `{new Date(due_date).toLocaleDateString()}` | viewer zone + viewer locale |
| 345 | `created_at` | `{new Date(row.original.created_at).toLocaleDateString()}` | viewer zone + viewer locale |

That is the complete set — all 350 lines read. `sent_at` and `paid_at` appear on the
`InvoiceListItem` interface (`:25`, `:26`) but **have no column**, so there is nothing to fix for
them. There is no service-date column on this list.

**In `frontend/src/pages/v2/invoices/InvoicesPage.tsx` — the CSV export, same defect:**

| Line | Field | Current code |
|------|-------|--------------|
| 363 | `'Due Date'` | `inv.due_date ? new Date(inv.due_date).toLocaleDateString() : ''` |
| 364 | `'Created'` | `new Date(inv.created_at).toLocaleDateString()` |

This is an **independent second copy** of the bug, not a consequence of the first. Note line 356
directly above already does `isOverdue(inv, timeZone)` — so `timeZone` is in scope and the export is
*half* on the org clock already, which is worse than being wholly wrong: a CSV can say
`Status: OVERDUE` next to a due date that hasn't arrived. **In scope; fix in the same change.**

### Why `timeZone` is already available at every one of those four sites

- `buildInvoiceColumns(sorting, onToggleSort, onOpenJob, timeZone: string)` —
  `invoicesColumns.tsx:127-133`, documented `/** The ORG's zone ... */`. Both cell renderers close
  over it; `:321` and `:250` already use it via `isOverdue(row.original, timeZone)`.
- `InvoicesPage.tsx:279` `const timeZone = useScheduleTimezone();`, threaded into the builder at
  `:286`. `toExportRow` (`:351`) closes over the same binding.

## 3. The correct formatting call

### The existing convention — do not invent a new one

`frontend/src/lib/schedule-tz.ts:140-173` is the declared "RENDER boundary" and its header says
plainly that every user-facing time goes through `formatInstant`. Every #1804-era surface obeys it:

- `InvoiceDetailPage.tsx:585` — `formatInstant(invoice.due_date, timeZone, ORG_DAY_FORMAT)`
- `InvoiceDetailPage.tsx:722` — same call in the OVERDUE banner
- `leads/components/leadShared.ts:45-47` — `formatInstant(date, tz, { month:'short', ... })`
- `jobs/jobsColumns.tsx:94` — `formatInstant(visit.scheduled_at, tz)`

The shape the invoices surfaces use is pinned at `InvoiceDetailPage.tsx:62-63`:

```ts
/** `toLocaleDateString()`'s default numeric shape ("7/10/2026"), pinned to the org zone. */
const ORG_DAY_FORMAT: Intl.DateTimeFormatOptions = { year: 'numeric', month: 'numeric', day: 'numeric' };
```

`ORG_DAY_FORMAT` is **module-private** — `git grep ORG_DAY_FORMAT` returns only the three lines in
`InvoiceDetailPage.tsx`. It cannot be imported by the columns file as it stands.

### Required refactor: hoist `ORG_DAY_FORMAT` into `@/lib/schedule-tz`

The acceptance bar is literal string equality between two surfaces. Two independently-declared
options objects can silently drift apart — which is exactly how this defect was born. So export one,
from the module that already owns the render boundary and already keeps a private
`DEFAULT_INSTANT_FORMAT` const (`schedule-tz.ts:149-154`) as precedent.

In `frontend/src/lib/schedule-tz.ts`, beside `DEFAULT_INSTANT_FORMAT`:

```ts
/**
 * `toLocaleDateString()`'s default numeric shape ("7/10/2026"), pinned to the org zone.
 * Exported because the invoices LIST and the invoices DETAIL page must render byte-identical
 * days for one invoice; two private copies of this object is how they came to disagree.
 */
export const ORG_DAY_FORMAT: Intl.DateTimeFormatOptions = {
  year: 'numeric', month: 'numeric', day: 'numeric',
};
```

Then delete `InvoiceDetailPage.tsx:62-63` and import it instead (its `:11` import already pulls
`useScheduleTimezone, formatInstant` from `@/lib/schedule-tz`). This is a pure move — the detail
page's rendered output does not change.

*Alternative considered and rejected:* a new `formatOrgDay(iso, tz)` wrapper. It reads better at four
call sites, but it adds public API to `schedule-tz` where the existing `formatInstant(x, tz, opts)`
three-arg form is already the house idiom at every #1804 surface. Exporting the const is the smaller
diff and matches convention. Worth revisiting as a follow-up if a fifth call site appears.

### The exact edits

**`frontend/src/pages/v2/invoices/invoicesColumns.tsx`**

Line 6, extend the existing import:

```ts
import { orgDayDiff, formatInstant, ORG_DAY_FORMAT } from '@/lib/schedule-tz';
```

Line 322, in the `due_date` cell (`timeZone` from the builder param at `:132`):

```tsx
{formatInstant(due_date, timeZone, ORG_DAY_FORMAT)}
```

Line 345, in the `created_at` cell:

```tsx
{formatInstant(row.original.created_at, timeZone, ORG_DAY_FORMAT)}
```

**`frontend/src/pages/v2/invoices/InvoicesPage.tsx`**

Line 41 currently imports only `useScheduleTimezone`; extend it:

```ts
import { useScheduleTimezone, formatInstant, ORG_DAY_FORMAT } from '@/lib/schedule-tz';
```

Lines 363-364 (`timeZone` from `:279`):

```ts
'Due Date': formatInstant(inv.due_date, timeZone, ORG_DAY_FORMAT),
'Created':  formatInstant(inv.created_at, timeZone, ORG_DAY_FORMAT),
```

`formatInstant` returns `''` for `null`/`undefined`/`''` (`schedule-tz.ts:171`), so the
`inv.due_date ? ... : ''` ternary becomes redundant — dropping it is correct, not a behaviour
change. The cell at `:319` keeps its own `if (!due_date) return '-'` guard, since `'-'` is not `''`.

**`frontend/src/lib/schedule-tz.ts`** — add the exported const (above).

**`frontend/src/pages/v2/invoices/InvoiceDetailPage.tsx`** — delete the local const at `:62-63`,
import the shared one at `:11`. `:585` and `:722` are otherwise untouched.

## 4. Surfaces that must agree afterwards

For one invoice, one org, one viewer — all of these must print the identical day string:

1. Invoices list, **Due Date** column — `invoicesColumns.tsx:322`
2. Invoice detail, **"Due ..."** in the meta row — `InvoiceDetailPage.tsx:585`
3. Invoice detail, **OVERDUE banner** "(was due ...)" — `InvoiceDetailPage.tsx:722`
4. Invoices list **CSV export**, `Due Date` column — `InvoicesPage.tsx:363`

And consistently for the created timestamp:

5. Invoices list, **Created** column — `invoicesColumns.tsx:345`
6. Invoices list CSV export, `Created` — `InvoicesPage.tsx:364`

Already on the org clock and must not regress (the derivations #1804 fixed):

7. `isOverdue(invoice, timeZone)` — the red text at `invoicesColumns.tsx:321` and the
   `StatusChip domain="invoice" status="OVERDUE"` at `:250`
8. `getDueDateLabel(invoice, timeZone)` — `InvoiceDetailPage.tsx:588`, `:721`

**Acceptance bar:** the list and the detail page render the same day for the same invoice
*regardless of the viewer's zone*. Corollary already covered by #1804 and worth re-checking by hand:
the chip must not say `OVERDUE` beside a due date that reads as today.

### Out of scope — FLAGGED, do not fix here

`InvoiceDetailPage.tsx` still has four **browser-zone** renders that #1804 missed. Same defect class,
different fields, and none has a list-column counterpart, so folding them in here would blur the
red/green signal:

- `:366` ledger event dates
- `:581` `Sent {new Date(invoice.sent_at).toLocaleDateString()}`
- `:593` `Paid {new Date(invoice.paid_at).toLocaleDateString()}`
- `:730` `{invoice.voided_at ? new Date(invoice.voided_at).toLocaleDateString() : 'unknown date'}`

File as a follow-up ("Defect B-2: invoice detail sent/paid/voided/ledger dates still render in the
viewer's zone"). The `ORG_DAY_FORMAT` export this plan adds is exactly what that ticket will need.

## 5. Failing tests to write FIRST

### 5.1 How to control the simulated browser timezone in this repo

Two distinct mechanisms — using the wrong one produces a vacuous test.

**The ORG zone** is a plain function argument. `buildInvoiceColumns(..., timeZone)` takes it
directly, so a columns test passes a literal and needs no mock. For a test that mounts a *page*, the
org zone arrives via `useScheduleTimezone()` -> `useOrganization()`, mocked module-level (precedent:
`components/filters/controls/DateFacet.test.tsx:29-39`):

```ts
vi.mock('@/lib/api/organization', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api/organization')>();
  return { ...actual, useOrganization: () => ({ data: { id: 'org-1', timezone: 'Asia/Manila' }, isLoading: false, isError: false }) };
});
```

**The VIEWER's browser zone** is the *process* zone — that is what bare `toLocaleDateString()` reads.
The house technique is mutating `process.env.TZ`; Node re-reads it on assignment (rationale at
`__tests__/record-estimate-payment-deposit.test.tsx:142-144`). Established form
(`components/filters/controls/DateFacet.test.tsx:99-107`, `lib/date-range.test.ts:124-127`):

```ts
let originalTz: string | undefined;
beforeEach(() => { originalTz = process.env.TZ; process.env.TZ = VIEWER_TZ; });
afterEach(()  => { process.env.TZ = originalTz; });
```

Always restore in `afterEach`/`afterAll` — `vitest.config.ts` has no per-file isolation guarantee
around env, and a leaked `TZ` will corrupt unrelated suites. There is **no global `TZ` setting** in
`frontend/vitest.config.ts` or `src/__tests__/setup.ts`, so an un-pinned test inherits the runner's
zone (UTC in CI), which is a coin flip.

> Note the #1804 tests in `frontend/src/lib/invoices/invoiceDueDate.test.ts` do **not** touch
> `process.env.TZ` — they don't need to, because every function under test takes `tz` as a
> parameter. Defect B is different: the *bug* is that the render reads the ambient process zone. You
> must pin `process.env.TZ` or the RED step will not go red.

### 5.2 THE CRITICAL RULE — viewer zone must OPPOSE org zone

**A test where viewer zone == org zone passes under both the old and the new code and proves
nothing.** It is the single most likely way to ship this fix with a green suite and the bug still
live.

Pick a `(viewer, org, instant)` triple where the instant lands on **different calendar days** in the
two zones. The house discriminator is `Asia/Manila` (UTC+8) against `America/New_York` (UTC-4 in
July) — the offsets point opposite ways, so a fixed-direction offset bug cannot satisfy both. This
rationale is already written down at `invoiceDueDate.test.ts:4-9` and `leadsColumns.test.tsx:50-54`.

Also include a **control** instant that lands on the same day in both zones, so a future reader can
see the discriminating case is genuinely discriminating (precedent: `DateFacet.test.tsx:91-97`).

### 5.3 File: `frontend/src/pages/v2/invoices/__tests__/invoiceListDueDateZone.test.tsx` (NEW)

Layout note: v2 tests are **colocated** under `pages/v2/<module>/__tests__/`, not in
`frontend/src/__tests__/`. `src/__tests__/` is reserved for the legacy-page contract suites
(`invoiceDetailHeading.test.tsx:17-18`). The near-exact template is
**`frontend/src/pages/v2/leads/__tests__/leadsColumns.test.tsx:56-74`**, which is the identical
defect already fixed for the leads list — copy its structure.

Cell-rendering technique (from `leadsColumns.test.tsx:29-34`):

```tsx
import { render, screen } from '@testing-library/react';
import type { CellContext } from '@tanstack/react-table';
import type { ReactElement } from 'react';
import { buildInvoiceColumns, type InvoiceListItem } from '../invoicesColumns';

const NY = 'America/New_York';       // ServWave Test, Alpha Doors
const DENVER = 'America/Denver';     // Talon Septic
const MANILA = 'Asia/Manila';        // VIEWER — the opposite-offset discriminator

function cellFor(id: string, orgTz: string) {
  const col = buildInvoiceColumns([], () => {}, () => {}, orgTz).find((c) => c.id === id)!;
  return col.cell as (ctx: CellContext<InvoiceListItem, unknown>) => ReactElement;
}
function ctx(inv: Partial<InvoiceListItem>) {
  return { row: { original: inv } } as unknown as CellContext<InvoiceListItem, unknown>;
}
```

Fixtures. `I00118` is QA's repro, already pinned as the canonical fixture at
`invoiceDueDate.test.ts:16-19`:

```ts
// Staging invoice I00118 (ServWave Test). 02:35 UTC on 7/11 == 22:35 on 7/10 in New York,
// 20:35 on 7/10 in Denver, and 10:35 on 7/11 in Manila. The org day is the 10th; only a
// viewer-zone render says the 11th.
const I00118_DUE = '2026-07-11T02:35:09.368Z';
// Control: 13:00 UTC is 09:00 7/10 in New York and 21:00 7/10 in Manila — same day in both.
const CONTROL_INSTANT = '2026-07-10T13:00:00.000Z';
```

Tests (all under `process.env.TZ = MANILA`):

| # | describe / it | org tz | fixture | expected | fails before fix as |
|---|---|---|---|---|---|
| 1 | `invoices Due Date column honours the org timezone` > **`renders the due date on the org calendar day, not the viewer's`** | `NY` | `{ status:'SENT', due_date: I00118_DUE }` | `getByText('7/10/2026')`, `queryByText('7/11/2026')` null | renders `7/11/2026` |
| 2 | " > **`agrees with the detail page for a Denver org too`** | `DENVER` | same | `'7/10/2026'` | `7/11/2026` |
| 3 | " > **`control: an instant that falls on one day in both zones is unaffected`** | `NY` | `due_date: CONTROL_INSTANT` | `'7/10/2026'` | passes before **and** after — it is the control, label it as such in a comment |
| 4 | " > **`still renders a dash when the invoice has no due date`** | `NY` | `due_date: null` | `'-'` | passes both ways (guard regression only) |
| 5 | `invoices Created column honours the org timezone` > **`renders the created day on the org calendar day, not the viewer's`** | `NY` | `{ created_at: I00118_DUE }` | `'7/10/2026'` | `7/11/2026` |
| 6 | `the invoices list and the invoice detail page cannot disagree` > **`renders the byte-identical day string the detail page renders`** | `NY` | `due_date: I00118_DUE` | list cell text `===` `formatInstant(I00118_DUE, NY, ORG_DAY_FORMAT)` | list `7/11/2026` vs detail `7/10/2026` |

Test 6 encodes the acceptance bar. Import `formatInstant, ORG_DAY_FORMAT` from `@/lib/schedule-tz`
and compare against the live detail-page expression rather than a literal, so the two surfaces stay
welded if the format is ever restyled.

> If tests 1, 2, 5 and 6 do not go **RED** on the unmodified code, the `process.env.TZ` pin is not
> taking effect. Do not proceed — assert it directly with
> `expect(Intl.DateTimeFormat().resolvedOptions().timeZone).toBe(MANILA)` inside `beforeEach` and
> debug from there. A green RED step here means the whole exercise is vacuous.

### 5.4 File: `frontend/src/pages/v2/invoices/__tests__/invoiceExportDueDateZone.test.ts` (NEW)

`toExportRow` is a closure inside the `InvoicesPage` component (`InvoicesPage.tsx:351`) and cannot be
imported. Two ways to get it under test:

**(a) Preferred — extract it.** Move `toExportRow` into `invoicesColumns.tsx` as
`export function toInvoiceExportRow(inv: InvoiceListItem, timeZone: string)`, and call it from
`InvoicesPage.tsx` as `(inv) => toInvoiceExportRow(inv, timeZone)` at `:370`. Well-motivated beyond
testability: the export row is a field-for-field mirror of the column set, so it belongs beside the
column definitions — that adjacency is what would have caught the drift in the first place.

| # | it | viewer | org | fixture | expected |
|---|---|---|---|---|---|
| 7 | **`exports the due date on the org calendar day, not the viewer's`** | `MANILA` | `NY` | `due_date: I00118_DUE` | `row['Due Date'] === '7/10/2026'` |
| 8 | **`exports the created day on the org calendar day`** | `MANILA` | `NY` | `created_at: I00118_DUE` | `row['Created'] === '7/10/2026'` |
| 9 | **`exports an empty cell, not "Invalid Date", for an invoice with no due date`** | `MANILA` | `NY` | `due_date: null` | `row['Due Date'] === ''` |
| 10 | **`never exports OVERDUE beside a due date that has not arrived`** | `MANILA` | `NY` | `due_date: I00118_DUE`, `status:'SENT'`, fake now = `2026-07-10T13:00:00Z` | `row['Status'] === 'SENT'` and `row['Due Date'] === '7/10/2026'` |

Test 10 is the reason the export matters: today it can emit `OVERDUE` next to a future-looking date.
Use `vi.setSystemTime` and restore with `vi.useRealTimers()` in `afterEach`.

**(b) Fallback if the extraction is rejected in review** — mount `InvoicesPage` with a mocked
`useOrganization`, spy on `@/lib/inventory/csv`'s `downloadCSV`, drive the Export menu, and assert on
the CSV string. Considerably heavier and tests the menu as much as the formatting. Prefer (a).

### 5.5 Regression tests that must stay green

- `frontend/src/lib/invoices/invoiceDueDate.test.ts` — the #1804 suite. Untouched, must stay green.
- `frontend/src/pages/v2/__tests__/listTableAdoption.test.tsx:305` — calls
  `buildInvoiceColumns([], () => {}, () => {}, 'America/New_York')`. **Do not change the builder's
  signature**; this call site (and four sibling builders beside it) would break.
- The six legacy `src/__tests__` suites that import `@/pages/InvoicesPage` — untouched.
- `frontend/src/__tests__/list-sort-lockstep.test.ts:27` imports `columns` from the *legacy*
  `pages/InvoicesPage`, not the v2 file. Unaffected.

## 6. Risks and regressions

**Sorting — no risk. Confirmed server-side.** `InvoicesPage.tsx:458` passes `manualSorting` to the
DataTable. `:137` derives `const sortBy = sorting[0]?.id`, `:157-158` send `sortBy`/`sortDir` as
query params, and `:163` puts them in the react-query key so a sort change refetches. The header
comment at `invoicesColumns.tsx:70-78` states it outright: *"Sorting is SERVER-side ... the table
renders the rows in the order the server returned them and never re-sorts them itself."*
**A `cell` renderer is display-only under `manualSorting`; changing it cannot reorder rows.**

**Filtering — no risk.** Facets flow through the filter registry into `listParams` and are sent to
the server. No client-side predicate reads the rendered cell text.

**CSV export — WAS a risk, now in scope.** The export builds its own strings at
`InvoicesPage.tsx:363-364` and would have been left in the viewer's zone, so the CSV would have
disagreed with the screen the moment the screen was fixed. Section 3 fixes it in the same change.
The "export all" path (`:376-377`) runs the same `toExportRow` mapper (`:370`), so both export paths
are covered by one fix.

**Visual regression — expected nil, but verify.** `ORG_DAY_FORMAT` is `{year,month,day:'numeric'}`
== `toLocaleDateString()`'s default numeric shape, so `7/10/2026` stays `7/10/2026`. Column widths
(`size: 120/110`) unchanged. Two Playwright baselines cover these surfaces:
`frontend/e2e/visual-baselines/invoices-list-chromium-darwin.png` and
`invoice-detail-chromium-darwin.png`. If the runner's zone equals the fixture org's zone they will
not move at all; if they do move, that movement **is the bug being fixed** — re-baseline with
`npm run test:visual:update` and eyeball the diff before accepting.

**Locale behaviour change — intentional, call it out in the PR.** Old code took the runtime's default
locale; `formatInstant` pins `en-US` (`schedule-tz.ts:168`). For a browser set to `en-GB` the column
changes from `11/07/2026` to `7/10/2026`. That is a fix (deterministic, and matches the detail page
and the CSV), but it is user-visible and worth a line in the PR description. Orthogonal to
`getOrgDateFormat()` in `lib/format-date.ts` (the per-org `MM/DD/YYYY` preference), which the v2
invoice surfaces do not currently consult — out of scope, do not wire it in here.

**`ORG_DAY_FORMAT` hoist — low risk.** Pure move of a frozen options object; `InvoiceDetailPage.tsx`
`:585` and `:722` produce byte-identical output before and after. Verify by running the existing
`invoiceDetailHeading.test.tsx` plus the visual baseline.

## 7. Implementation order (strict TDD)

1. Confirm `frontend/src/pages/v2/invoices/invoicesColumns.tsx` exists in the worktree (section 0).
2. Write `invoiceListDueDateZone.test.tsx` (tests 1-6). Run it. **Confirm 1, 2, 5, 6 fail with
   `7/11/2026`; confirm 3 and 4 pass.** If nothing fails, the `TZ` pin isn't working — stop and fix
   the harness before touching source.
3. Export `ORG_DAY_FORMAT` from `frontend/src/lib/schedule-tz.ts`; switch `InvoiceDetailPage.tsx` to
   import it and delete its local copy. Re-run the detail-page suite — green.
4. Fix `invoicesColumns.tsx:6`, `:322`, `:345`. Re-run step 2's file — all six green.
5. Extract `toInvoiceExportRow` into `invoicesColumns.tsx`; rewire `InvoicesPage.tsx:351,370`. Write
   `invoiceExportDueDateZone.test.ts` (tests 7-10). Confirm 7, 8, 10 fail.
6. Fix the two export fields. All green.
7. Full frontend suite. Pay attention to `listTableAdoption.test.tsx` and the six legacy invoice
   suites.
8. Manual check against staging with the browser zone forced to `Asia/Manila`: invoice `I00118` must
   read `7/10/2026` in the list, on the detail page, and in the CSV.
