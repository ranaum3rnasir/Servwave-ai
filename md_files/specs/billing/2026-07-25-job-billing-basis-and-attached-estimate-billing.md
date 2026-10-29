# Job billing basis + attached-estimate billing path

**Date:** 2026-07-25
**Status:** recommendation, not yet implemented
**Origin:** two items flagged during the SERV10X-61 live QA pass on staging (PR #980) and deferred
pending a decision. Both were recorded at the time as needing a product call. **Both turned out not
to.** Each is a bug with one defensible fix, and this doc records the evidence.

---

## 1. A job's `remaining` mixes pre-tax and tax-inclusive money

### What was originally suspected

That `computeJobBilling` is pre-tax while `invoiced` sums tax-inclusive `total_amount`, so
"remaining" understates by the tax already invoiced, and that choosing between a "charged" and a
"scope-billed" semantic was a product decision.

### What is actually true

The semantic decision was already made, deliberately, and is documented in the code
(`job.controller.ts:3615`):

> Task 10b: stays PRE-TAX on purpose. This drives the over-bill basis + the percent-draw basis; tax
> is added once to the invoice totals below.

That reasoning is correct and should stand: a percent draw must be a percent of the pre-tax job
value, with tax layered on the resulting invoice. Both call sites pass `taxRate: 0` accordingly
(`job.controller.ts:3615`, `job-lines.controller.ts:211`).

The bug is that `invoiced` never followed that decision. It sums `Invoice.total_amount`, which is
tax-inclusive (`invoice-totals.ts`: `total_amount = subtotal - discount + tax + tip`). So
`remaining = total - invoiced` subtracts a tax-inclusive number from a pre-tax one.

**This is a unit mismatch, not a semantic choice.** There is no reading of "remaining" under which
subtracting mismatched units is right.

### Executed proof

Run against the real `computeJobBilling` and `recomputeInvoiceTotals`, with the arguments the real
call sites pass. $1,000 pre-tax job, 6.25% (Austin TX):

| Case | total | invoiced | remaining | over_billed |
|---|---|---|---|---|
| A. Billed once, in full and correctly | 1000 | 1062.50 | 0 | **62.50** |
| B. 50% progress draw taken | 1000 | 531.25 | **468.75** | 0 |
| C. Same, with `invoiced` on a pre-tax basis | 1000 | 500 | 500 | 0 |

Two distinct user-visible defects, and A is worse than the one originally flagged:

- **A is a false over-bill alarm.** `JobBillingSummary` renders an extra rose `AlertTriangle`
  "Over-billed $62.50" tile whenever `over_billed > 0`. Every taxable job that is fully and
  correctly invoiced displays it. The tile exists precisely because "Remaining clamps at zero
  either way" (Spec B1 B-5), so the one signal meant to catch real over-billing cries wolf on
  normal jobs.
- **B understates remaining** by exactly the tax already invoiced ($31.25), so a job looks closer
  to fully billed than it is.

### Recommendation - confident

Keep `total` pre-tax. Put `invoiced` on the same pre-tax basis:

```ts
const invoiced = input.invoices
  .filter((i) => i.voided_at == null)
  .reduce((sum, i) => sum + (Number(i.subtotal) - Number(i.discount_amount)), 0);
```

`subtotal - discount_amount` is the invoice's pre-tax, pre-tip, post-all-discount amount - it equals
`discountedSubtotal` in `recomputeInvoiceTotals`, and equally `total_amount - tax_amount - tip`.
Using the persisted `subtotal`/`discount_amount` pair is preferable to back-deriving, because it
does not depend on `tip` remaining on the Invoice model.

Three things this gets right that the current code does not:

- **Tax excluded on both sides.** Sales tax is a pass-through the contractor collects for the state,
  not job value. It has no place in "how much of this job is left to bill", and the pre-tax basis is
  also what a Schedule-of-Values style "balance to finish" tracks.
- **Tips excluded.** A tip is not job scope, so it must not consume remaining scope. Under the
  current code a $200 tip silently eats $200 of `remaining` and can manufacture an over-bill.
- **Discounts still counted.** A discounted invoice bills less of the job, and
  `subtotal - discount_amount` reflects that.

`deposit_credit` needs no handling: it reduces `amount_due`, not `total_amount`, so it never entered
this calculation.

**Optional polish, not required:** the strip's three tiles would then all be pre-tax scope figures.
A caption such as "excludes tax" on the strip would remove any ambiguity for a user comparing the
"Invoiced" tile against an invoice PDF total. Cash owed correctly stays on the invoice
(`amount_due`), which is a different question from scope billed.

**Scope:** `backend/src/lib/jobBilling.ts` (the reduce), plus `select` additions for `subtotal` and
`discount_amount` on the two `invoices` selects that feed it (`jobInvoiceGuardSelect`,
`jobGuardSelect`). TDD: `computeJobBilling` is pure, so cases A/B/C above are the failing tests.

---

## 2. A job-anchored estimate can be copied into its own invoice

### The gap

`copyToInvoice` blocks estimates that already have a job:

```ts
if (estimate.job) { 409 }   // estimate.controller.ts:3505
```

`estimate.job` is the **provenance** relation (`JobPrimaryEstimate`, reverse of `Job.estimate_id`) -
"this estimate became a job". It is not `estimate.job_id`, the **attachment** relation
(`EstimateJobLink`) that R6/SERV10X-61 added. A job-anchored estimate has `job_id` set and `job`
null, so it passes the guard.

The frontend has the identical gap: `EstimateWorkspacePage.tsx:611` disables the button on
`!!estimate.job` only. So this is reachable by a normal user clicking a normal button, not just
through the API.

This is the same drift class as the SALES read-Estimate scope and the lying `lead` type: R6
introduced a second way for an estimate to relate to a job, and code written for the one-way world
was not updated.

### Why it is a real double-bill, and an invisible one

`copyToInvoice` hardcodes `job_id: null` on the invoice it creates. So the resulting invoice:

- does not appear in `job.invoices`, therefore
- does not count toward `computeJobBilling.invoiced`, therefore
- the job's billing summary still reports the work as unbilled.

The user is then actively led to bill it again through the job. The duplicate is not merely possible;
the UI invites it.

### Why blocking does not strand anything that currently works

An attached estimate's **line items are never billed through the job**. `linked_estimates` feeds only
two things: the invoice's tax-rate fallback (`job.controller.ts:3698`) and deposit-credit sourcing
(`:3723`). No code path copies an attached estimate's lines onto `job_line_items`.

So today the only way to bill an attached estimate is copy-to-invoice, and that way produces an
orphan invoice plus a job that misreports itself. There is no correct path to preserve - only a
broken one to close.

### Recommendation - confident

Extend both guards to reject either kind of job relation:

```ts
if (estimate.job || estimate.job_id) { 409 }
```

with `job_id: true` added to the select, and the message widened to name attachment as well as
provenance. Mirror it on the frontend `disabled` condition.

This restores the guard's original stated intent - "copy-to-invoice is only available for estimates
that never became a job" - rather than inventing new policy. It is a drift fix.

Fail-safe is the right default here: a wrong invoice sent to a customer is not reversible in the way
a temporarily unavailable button is.

**What this defers, deliberately:** attached estimates then have no billing path at all until the
conversion session builds one. That is honest - they effectively have none now. The real fix is a
product decision that belongs with Task 14 (job-page attached-estimates panel), and it is a genuine
fork:

- **(a) Push the estimate's lines onto the job** on approval or on an explicit "add to job" action.
  The job's `total` grows, the job bills it normally, one invoice. Cleanest, and consistent with
  `job_line_items` being the billable truth.
- **(b) Link the copied invoice to the job** (`job_id: estimate.job_id`) so it counts as invoiced.
  Cheaper, but `invoiced` would then exceed a `total` that never grew, which re-triggers the very
  `over_billed` tile item 1 fixes. Needs the job's total to account for attached scope.

(a) is the better shape. Either way it needs the decision recorded before implementation, which is
why it is not folded into the guard fix.

---

## Sequencing

Both fixes are small, independent, and backend-only apart from one frontend `disabled` condition.
Item 1 should land before or with item 2, so that any future work on (b) above is reasoning about a
correct `over_billed`. Neither is a hotfix: item 1 is display-only and item 2 requires a user to
choose an unusual path, so both fit the normal staging flow.
