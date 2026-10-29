# Starter Basic Reports - the 10-report set

**Date:** 2026-07-28
**Issue:** #1021 (Advanced Reports declared but never gated)
**Depends on:** PR #1034 (flips `advanced_reports` to `built: false`)
**Status:** built on `staging` base, branch `fix/starter-basic-reports-set`, awaiting PR review

## Decision

Ship a small, honest, DB-backed report set at STARTER so a starter user can see how
reports are built. No new reports. No lead-source, no technician board, no average
ticket - those stay for a later tier or a later plan.

Owner's rule, verbatim: nothing in the Starter set may depend on an entity or module
that a Starter plan does not have.

## Starting point: what is actually live today

Reports are **already ungated by plan**. `backend/src/routes/report.routes.ts` carries no
`requireFeature` on any route - every report gates on the CASL `read Report` capability
(Admin + Dispatcher only). There is no report paywall to dismantle; #1021 was a false
claim in the entitlements catalog, not a missing gate.

Visibility is already handled by `canShowReport()` in
`frontend/src/pages/reports/report-catalog.ts`, and enforced on both the landing grid and
the direct `/reports/:slug` route (`ReportRoute.tsx`):

    demo org  -> show all catalog cards, dispatch any slug to its page (mock-first, for sales)
    real org  -> show only cards flagged `live: true`; a non-live slug 404s to the "coming soon" stub

That gate has **no plan-tier awareness** - it is a single global switch per report, not
per-org. This matters below.

So the Starter list is not something to invent - it is the `live` set on `staging`,
currently **12**:

| # | Slug | Label | Group |
|---|------|-------|-------|
| 1 | `jobs` | Jobs | Operations |
| 2 | `leads` | Leads | Sales |
| 3 | `estimates` | Estimates | Sales |
| 4 | `estimate-conversion` | Estimate / Quote Conversion (S1) | Sales |
| 5 | `revenue` | Revenue - completed vs invoiced vs collected (F2) | Finance |
| 6 | `ar-aging` | AR Aging & Collections (F4) | Finance |
| 7 | `invoices` | Invoices | Finance |
| 8 | `payments` | Payments Collected & Method Mix (F5) | Finance |
| 9 | `payments-list` | Payments | Finance |
| 10 | `timesheets` | Timesheets | Operations |
| 11 | `activity` | Activity | Operations |
| 12 | `inventory-usage` | Inventory Usage | Operations |

**Build note 1 (base drift):** the first pass of this change was built in a worktree cut
from `origin/main` per the standard bug-fix flow. `main` and `staging` have diverged on
every file this change touches, and opening a PR from that main-based branch into
`staging` produced a 300+-file diff GitHub couldn't render and a `CONFLICTING` mergeable
state. Fix: reset the branch to `origin/staging` and re-derive against the real code
there, per the project's own recorded incident history for this failure mode.

**Build note 2 (inventory-usage cannot come out this way):** the first re-derived pass
removed `live: true` from `inventory-usage` too, landing on 9. CI's full frontend suite
(not just the `reports/` subfolder, which is all that was run locally the first time)
caught the real problem: `src/__tests__/inventory-usage-report.test.tsx` proves
`inventory-usage` is a fully-built, tested report - KPIs, job/invoice drill-through
chips, and cost-suppression logic for users without `read Invoice`. It is not a stub. And
because `live`/`canShowReport` gates `ReportRoute.tsx` globally with no plan-tier check,
flipping it off doesn't hide a card from Starter - it 404s the report for **every** real
org, including SCALE customers who pay for the Inventory module and use this today. That
would have shipped a functional regression to a paying tier to satisfy a Starter-only
concern. Reverted; see "What actually comes out" below.

## What actually comes out, and why

**Two removals, not three.** The set lands on **10**, not the 9 first discussed with the
owner - see the note above for why `inventory-usage` has to stay.

### 1. `leads` - depends on a PRO module
`leads` is `minPlan: 'PRO'`, and `backend/src/routes/lead.routes.ts:14` puts the whole
router behind `requireFeature('leads')`. A Starter org cannot create a lead, so the Leads
report is structurally empty for them. Unlike `inventory-usage`, there is no dedicated
route-dispatch test locked to `leads` being live, and the full frontend suite is clean
with this flag removed.

### 2. `payments-list` - an exact duplicate
`frontend/src/pages/reports/reports-registry.ts` maps **both** `payments` and
`payments-list` to the same `PaymentsReport` component. Two cards, two slugs, one page.
Keep `payments` (F5, the better label - "Payments Collected & Method Mix"); retire
`payments-list`. No test depends on the `payments-list` slug specifically.

### `inventory-usage` stays live - flagged as a follow-up, not fixed here
It still shows an empty/zero report to a Starter (or PRO) org that has no Inventory
module - the same class of cross-module leak as #984, just for reports instead of a job
detail page. Fixing it properly needs **per-plan** gating (e.g. the `useModuleAccess`
hook PR #1005 built for jobs/customers/schedule/tasks/estimates/phone, extended to
reports), which is a real, scoped follow-up - not something a global catalog boolean can
express, and out of scope for a "catalog metadata only" change.

## The resulting Starter set (10)

| # | Slug | Label | Group |
|---|------|-------|-------|
| 1 | `jobs` | Jobs | Operations |
| 2 | `estimates` | Estimates | Sales |
| 3 | `estimate-conversion` | Estimate / Quote Conversion | Sales |
| 4 | `revenue` | Revenue - completed vs invoiced vs collected | Finance |
| 5 | `ar-aging` | AR Aging & Collections | Finance |
| 6 | `invoices` | Invoices | Finance |
| 7 | `payments` | Payments Collected & Method Mix | Finance |
| 8 | `timesheets` | Timesheets | Operations |
| 9 | `activity` | Activity | Operations |
| 10 | `inventory-usage` | Inventory Usage | Operations |

Against the competitive research (Workiz / Housecall Pro / Jobber, plus broad industry
research), this covers the spine every vendor ships at their entry tier - revenue over
time, a filterable jobs list, estimate conversion, AR aging, payments - plus one known,
flagged gap (`inventory-usage`) and omits three deliberate deferrals: revenue by
technician, revenue by lead source, average ticket (see "Known gaps").

## Changes

All changes are frontend catalog metadata plus one stale comment. No backend change, no
schema change, no migration, no new report.

### `frontend/src/pages/reports/report-catalog.ts`
1. `leads` - remove `live: true`. Stays `mainOnly: true` and stays in `mainReports` (see
   point 3) so demo orgs keep seeing it on the Main tab.
2. `payments-list` - remove the entry entirely.
3. `mainReports` - re-point the `payments-list` entry (label `Payments`) to slug
   `payments`. **`leads` stays in `mainReports`** - do not drop it: `canShowReport`
   already hides it from real orgs per-org via the `live` flag, and removing it from
   `mainReports` while `mainOnly: true` stays set would hide it from demo orgs too,
   which breaks the "demo sees everything" invariant. Verified against
   `ReportsPage.tsx`: `mainOnly` cards render ONLY through `mainCards` (built from
   `mainReports`), never through the category-tab `activeReports` list - so a
   `mainOnly` card missing from `mainReports` is invisible to every org, demo included.
4. `inventory-usage` - **unchanged**, stays `live: true`.

### `frontend/src/pages/reports/reports-registry.ts`
5. Remove the `'payments-list'` key. `payments` keeps the same component.

### `frontend/src/pages/reports/PaymentsReport.tsx`
6. Fix a comment referencing the retired `payments-list` slug (was: "Main tab -> Payments
   -> payments-list"; now both Main and Finance tabs point at `payments`).

### `frontend/src/pages/reports/report-catalog.test.ts`
7. Test-first. Add a case asserting the live set is exactly the 10 slugs above, so any
   future `live: true` flip has to be deliberate.
8. Add a narrower guard: `leads` must never be live. (An earlier, broader version of this
   guard also asserted no `live` report has subject `'Inventory'` - dropped once CI proved
   that premise false for `inventory-usage`.)
9. Add a case asserting `payments-list` no longer resolves via `findReport`.

## Verification

- `npx tsc --noEmit` in `frontend/` (against `origin/staging` base, deps reinstalled,
  Prisma client regenerated) - **clean**.
- `npm test --workspace=backend` - **6343 passed, 44 skipped, 0 failed**.
- Frontend - **full suite** (`npx vitest run`, not just the `reports/` subfolder - the
  gap that let the `inventory-usage` regression through the first time) - clean after the
  revert; `report-catalog.test.ts` 10/10, `inventory-usage-report.test.tsx` back to
  passing.
- Live check on staging org **Stripe Test Plumbing** (PRO, `de4b1bfe-...`) - logged in
  and viewed the Reports page; this reflects `staging`'s current (pre-merge) code, so it
  shows the *old* 12-report set as expected - Leads Report and a bare "Payments" card both
  present. Re-check after merge to confirm exactly 10 cards, no Leads, one Payments.
- A demo org must still see every card, including `leads` and `payments` (via the
  re-pointed Main tab entry) - confirmed by code inspection of `canShowReport` and
  `ReportsPage.tsx`'s `mainOnly` handling; not yet checked in a running browser.

## Known gaps (deliberate, not oversights)

- **`inventory-usage` shows empty/zero data on Starter (and PRO).** Flagged above as a
  real follow-up, not fixed here - needs per-plan gating, not a global catalog flag.
- **Estimate Conversion's "rep" column degrades on Starter.** `repId` reads
  `lead.commission_owner_id`; a lead-less estimate has no lead, so the rep shows
  "Unassigned". The report itself works - SERV10X-61 added the direct
  `estimate.customer` fallback so the customer name still resolves. Acceptable; worth a
  note in the UI later.
- **No revenue-by-technician** (S3 `tech-performance` exists in the catalog, not live).
- **No revenue-by-lead-source.** `lead_source` is already carried on the estimate row in
  `report.controller.ts`, so this is close to a group-by away - but lead source is a
  PRO concern and is excluded by the owner's rule.
- **No average ticket** (F7, not live).
- **No tax report** (`tax`, not live). Jobber ships taxation at base tier and it is a US
  compliance obligation; candidate for the next wave.

## Out of scope

- Any new report.
- Any change to `requireFeature` or the entitlements catalog (PR #1034 covers #1021).
- Per-plan gating for `inventory-usage` (flagged above as a follow-up).
- Any change to the demo-org experience.
- CSV export, scheduled delivery, dashboards.
