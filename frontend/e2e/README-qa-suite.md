# Entity-Redesign QA Suite — How to Run

A two-tier automated proof that the redesigned pipeline (customer → location → lead → walkthrough →
estimate → deposit → job → invoice → payment → refund/credit/void/dispute → statement) works
end-to-end as an admin, with **totals reconciling at every money step** and **no render crashes**.

## Prerequisites (staging `.env`, `backend/.env`)

The suite runs against the **staging** Supabase via boot-guarded test doors. Set:

```
E2E_TEST_DOORS=true
E2E_ALLOWED_DB_HOSTS=aws-1-us-east-1.pooler.supabase.com   # the staging pooler host
E2E_ALLOWED_DB_REF=knriiqdqxgfoecsfarlx                    # the staging project ref (hard guard)
```

`provisionTestOrg` refuses to run unless the DB host **and** project ref match the allowlist — the
Supabase pooler host is shared with prod, so the **ref** is the real guard. Teardown only ever
deletes the `e2e-qa-<runId>` org (name-guarded purge) and `@e2e-qa.invalid` Auth users (full-domain
sweep) — it can never touch the demo org or a real tenant.

> **NEVER** set `E2E_TEST_DOORS`/`E2E_ALLOWED_*` in production. The whole `/api/test/*` block is
> skipped when `NODE_ENV=production`, and `assertNoTestRoutesInProduction` refuses to boot otherwise.
> The real `/api/webhooks/stripe` signature path is unchanged; the test door is a separate route that
> replays Stripe-shaped events through the *post-signature* money code only.

## Run it

Both servers must be up from the **servwave** worktree (`npm run dev:backend`, `npm run dev:frontend`).

```bash
cd frontend
npm run test:qa:api    # Tier 🔧 backend-integration (~130 tests, HTTP via ApiClient, no browser)
npm run test:qa:ui     # Tier 🖥️ UI E2E (~16 tests, chromium + screenshots)
npm run test:qa        # both, in order
```

- The runner provisions a fresh throwaway org per run and tears it down afterward (global setup/teardown).
- `workers: 1` (serial) — the org is shared across the run, so tests assert **deltas / presence of their
  own seeded ids**, never absolute counts.
- Backend tier: `e2e/playwright.api.config.ts`. UI tier: `e2e/playwright.config.ts`.

## Where results land

- Backend HTML report: `frontend/playwright-report-api/` · UI HTML report: `frontend/playwright-report/`
- UI screenshots: `frontend/e2e/screenshots/walkthrough/`
- Results matrix (per-row status): `md_files/plans/entity-redesign/qa-matrix.md`
- Full run report (findings + manual-check list): `md_files/plans/entity-redesign/QA-RUN-REPORT.md`

## Reading the results

- ✅ **pass** — automated assertion of the real effect (status flip / ledger row / amount), green.
- ✅ **pass *(flag)*** — a `flagKnownBug(...)` row: it asserts the **current** (sometimes buggy/deferred)
  behavior so it's green, and prints a `⚠️ KNOWN-BUG …` line naming the *expected* behavior. Grep the run
  output for `KNOWN-BUG` to list them. When a bug is fixed, flip the row to the positive control.
- ✋ **manual** — cannot be automated (e.g. live Stripe card capture, PUB-04); a human signs it off.

The reconcile invariant enforced after every money mutation is:
`amount_due == max(0, total_amount − Σ non-voided payments − Σ applied credits)`, plus
`total_refunded == Σ refund rows` (refunds don't reopen the balance but must not vanish).
