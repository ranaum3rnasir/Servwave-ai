# The job owns its tax rate and discount (Workiz parity)

**Date:** 2026-08-04
**Supersedes:** D1/D2 of [2026-08-03-job-items-estimate-parity.md](2026-08-03-job-items-estimate-parity.md)
**Cards:** SERV10X-60 follow-up; Workiz Parity program
**Branch target:** `staging` - **separate PR**, not #1187
**Status:** PLAN ONLY. Needs Ran's approval before any code. Contains a migration.

---

## 1. Why this reverses a decision we just made

D1 was decided on 2026-08-03 with this rationale, in Ran's words:

> "When it comes to tax, it should follow because we're talking about the same job. The tax inside
> the estimate and inside the items has to be the same, **just like it happens in Workiz**."

The first clause is a product choice. The second is a factual claim about Workiz, and it is wrong.

**Measured live 2026-08-03** on `app.workiz.com/root/job/0MA1SR/items` (Alpha Doors & Security,
job #698869), reading the accessibility tree rather than a screenshot:

| Field | Element |
|---|---|
| Discount | `textbox` - editable |
| Tax rate% | `textbox` (typeahead, renders `NEW JERSEY`) - editable |
| Tax | `textbox` - editable |

Workiz does **not** derive a job's tax from an estimate. The job owns its rate, defaulted from the
**service area**, editable in place. Ran's instruction on 2026-08-04: *"If Workiz allows us to do
something that we decided not to, then the verdict should go towards Workiz."*

## 2. What is actually broken today

Three things compound into a dead end:

1. **A job-anchored estimate's tax is already immutable.** `estimate.controller.ts:1179` (create)
   and `:1646` (update) both 400 on an inbound `tax_rate` when `job_id` is set;
   `EstimateReceiptCard.tsx:160-163` renders the control read-only with "Set by the job's service
   location".
2. **D1 pointed the job at that estimate** - also read-only ("Follows the job's estimate").
3. **⇒ the rate is editable from nowhere.** Once a job has any anchored estimate, nothing in the UI
   can change what that job charges.

A fourth, now fixed in #1187 (`9b220fc1a`): `createFromJobItems` seeded `0` whenever the job had no
tax-source estimate, and that 0 was then permanent. Reproduced on staging - J00228 is a Hoboken NJ
job that would have billed $0 tax forever.

**The dead end itself is NOT fixed by that commit.** It is what this plan removes.

## 3. Decisions

**E1. `Job` owns `tax_rate`.** New column, defaulted at create from the job's service-location state
(`taxRateForState`), editable on the Items tab. Replaces D1's "job follows its estimate".

**E2. `Job` owns `discount_type` / `discount_value` / `discount_amount`.** Same shape Estimate and
Invoice already carry. Replaces D2.

**E3. Estimates become independent again.** Drop the job-anchored tax lock (both 400s + the FE
`taxLocked`). A job-anchored estimate is a quote; the job is the work. They may legitimately differ,
and Workiz allows exactly that.

**E4. The invoice inherits the job's rate, and the user can override it.** Today both doors read
`taxSourceEstimate(job)`. They must read `job.tax_rate` instead - the job is the billing truth
(SRVW-85 already made its ITEMS the billing truth; this makes its RATE match).

The invoice then owns its own editable rate, defaulted from the job. Today the invoice has no
tax-rate control at all - it only derives - so this adds one, matching the jurisdiction select the
Estimate and Job cards already carry. Editing it re-runs `recomputeInvoiceTotals`; it does not
travel back to the job.

Ran, 2026-08-04: *"if we have a job and that job has a certain tax rate because of the service
location or whatever was decided by the salesperson, then when we create an invoice, it should come
straight from the job. Of course, we want to allow the user to change the tax on the invoice if they
need to."*

Two doors, so two sets of tests - a job whose rate differs from its estimate bills the JOB's rate,
and an invoice whose rate was overridden keeps the override.

**E5. `taxSourceEstimate` survives for deposits only.** `depositEstimateIds` is untouched - deposit
credit still draws from the estimate union. Only the tax/discount role retires.

## 4. Work

Backend is TDD: failing test first.

1. **Migration** - `jobs.tax_rate Decimal(6,5) @default(0)`, `discount_type DiscountType?`,
   `discount_value Decimal(12,2)?`, `discount_amount Decimal(12,2) @default(0)`. Portable +
   idempotent. **Never `prisma migrate` from a worktree** → `writing-migrations` skill.
2. **Backfill** - `taxSourceEstimate(job)`'s rate where the job HAS an estimate; the
   service-location state rate otherwise. See §4.1 - this **does** move existing numbers, and that
   is the decision, not an oversight.
3. **`job.controller.create()`** - stamp `tax_rate` from the service location on every new job.
4. **`job-lines.controller.billingFor()`** - read `job.tax_rate` / `job.discount_*` instead of
   `taxSourceEstimate(job)`. Drops `linked_estimates` from `jobGuardSelect` again.
5. **Both invoice doors** (E4) - same swap, plus tests that a job whose rate differs from its
   estimate bills the JOB's rate.
5b. **Invoice tax override** (E4) - `PATCH /api/invoices/:id` accepts `tax_rate`; recompute on
   change; wire the jurisdiction select on `<ReceiptCard variant="invoice">` for editable invoices.
   Gate on the same permission that already guards invoice money edits.
6. **`PATCH /api/jobs/:id`** - accept `tax_rate` / `discount_type` / `discount_value`. Gate on
   `update Job` + `canSeePricing` (money edit, mirrors the cost-field gate at `:1551`).
7. **Retire the estimate tax lock** - the two 400s + `taxLocked`. Re-enable the jurisdiction select
   on a job-anchored estimate.
8. **`createFromJobItems`** - seed the new estimate from `job.tax_rate` (not the resolver).
9. **Frontend** - wire `onTaxRateChange` / `onDiscountChange` on `<ReceiptCard variant="job">`.
   The card already renders both as editable when the handlers are present; today the Job variant
   deliberately passes neither. Retire the "Follows the job's estimate" helper text.

## 4.1 The backfill moves existing numbers - measured, then decided

The first draft of step 2 said the backfill would leave every live job's number untouched **and**
give estimate-less jobs the service-location rate. **Those two cannot both be true**, and the
contradiction survived Ran's approval because neither of us had run it against real rows.

Measured on staging (`knriiqdqxgfoecsfarlx`), read-only, 2026-08-04:

| | |
|---|---|
| Jobs total | 9,490 |
| Have an estimate (rate copies, nothing moves) | 88 |
| No estimate - today show **0% tax** | 9,236 |
| No estimate AND no state rate row (stay 0) | 166 |
| **Open, taxable line items, would gain tax** | **98** |
| Work affected | **$200,641.74** |
| New tax introduced | **$10,330.98** |

**Ran's call (2026-08-04): give them the location rate.** A job in a taxable state showing 0% tax is
wrong, and the fix is not to preserve the wrong number. The condition attached to that call:

> "there should also always be the possibility to change the tax, and the tax is consistent across
> the entity... I should still allow the users, even if they made a mistake, or if the customer
> called and said they now need a different tax rate. The user is able to do that without creating a
> new job from scratch."

So the backfill is only safe **because** E1 (editable rate on the job), E3 (estimate lock dropped)
and 5b (editable rate on the invoice) ship with it. A backfill that moves numbers without an in-place
way to correct them would be the worst of both worlds. **These are not separable - do not ship the
migration ahead of the edit surfaces.**

## 4.2 Tax consistency rules (Workiz sync research, 2026-08-04)

Ran asked how Workiz keeps tax consistent between a document and its line items, and how documents
at different lifecycle stages affect each other. Measured read-only on the live account.

**W1. The rate lives on the DOCUMENT; the line carries only `taxable: boolean`.** The items table is
`Item | Quantity | Price | Cost | Amount | Taxable` - no per-line rate column - and the summary has
exactly one `Tax rate% :` select. A mixed-rate document is not representable. Consistency across
line items is true *by construction*: there is nothing to reconcile and no recalculate button.

**ServWave already matches this** - `Estimate.tax_rate` + per-line `is_taxable`, and E1 gives `Job`
the same shape. No change needed.

**W2. Nothing locks, at any stage.** MEASURED enabled on: Unsent, Pending (sent), Won
(client-signed 7/28/2026 with a succeeded $3,714.17 charge against it), Archived, and a Done job
that already has an invoice. Workiz treats correctness of the record as worth more than immutability
of the sent artifact. There is an opt-in org setting to restrict edits on *Approved* estimates; it is
off by default and this org has 0 estimates in that status, so its exact effect is unknown.

**This is the direct answer to Ran's requirement** - "the user is able to do that without creating a
new job from scratch." E3 (drop the estimate tax lock) is therefore not just a dead-end fix, it is
the competitor's default posture. Our invoice edit-lock (`PAID`/`VOIDED`/`REFUNDED`/`DISPUTED`)
stays as-is; it is narrower than Workiz's and defensible for a settled invoice.

**W3. The rate is picked from the org's NAMED rates, never typed.** The control is a `react-select`
bound to the org's tax records - the "textbox" an accessibility tree reports next to it is
react-select's internal *search* filter, not a percent entry. (Flagging that because a tree-only
reading would misreport it, and an earlier pass of mine nearly did.) A document can never hold a
rate the org's tax report does not recognise. We already have this: `StateTaxRate` + `OrgTaxRate`
merged behind one select.

**W4. The leak to NOT copy: Workiz's `tax_amount` is independently writable** (`disabled: false` on
every document inspected), sitting next to a derived `sub_total` and `taxable_amount`. So a document
can display 6.625% while holding tax dollars matching nothing. **ServWave must keep tax derived and
unwritable.** If an override is ever needed, model it as a visible `tax_adjustment` line, not a
silently-edited total. We are currently clean here - do not regress it.

**W5. Rate as stored number, not a live FK.** We store `tax_rate` as a Decimal snapshot, so an org
correcting 6.625% to 7% cannot retroactively re-price a signed estimate. Workiz leaves this
ambiguous and it is the one place its model is under-specified. **We are already stricter. Keep it.**

**W6. Cross-document divergence: Workiz neither propagates nor warns.** Job 698869 totals $5,357.71
while its Won estimate totals $5,252.13, and the Estimates tab (`Estimate | Created | Status |
Total`) shows no rate, no badge, no mismatch indicator. Fixing a wrong rate on a job with three
estimates is four separate click-paths; the bulk bar offers only Change status / Send reminder /
Delete. **Open for Ran** - we can do better cheaply by showing the rate in the job's Estimates tab
so a divergence is at least visible. Not proposed as blocking.

**Not answerable read-only** (each needed a write to a live business account): whether the rate
travels on `Sync to job` and which side wins; whether changing the select auto-rewrites `tax_amount`;
whether editing a tax record's percentage re-prices existing documents; what the approved-estimate
restriction actually disables.

## 5. What does NOT change

- The shared totals spine across Estimate / Job / Invoice (#1187) - this only changes where the
  job's two numbers come FROM, not how they render.
- Deposit credit (E5), the `J00007-1` numbering container, attach/create-estimate doors.
- `recomputeInvoiceTotals`'s `discountType`/`discountValue` params (#1187) - the job just becomes
  the thing that supplies them.

## 6. Four-FSM research (2026-08-04)

Ran asked for outside evidence before committing. Four parallel research passes: Workiz (public docs
plus read-only observation of a live account), ServiceTitan, Housecall Pro, Jobber + FieldEdge.

### 6.1 Does the JOB own tax and discount?

| Product | Job owns tax/discount | Evidence |
|---|---|---|
| **Workiz** | **Yes** | MEASURED: job #698869 totals $5,357.71 while its Won estimate totals $5,252.13 over identical items and identical $4,808.00 subtotal. Job carries its own tax-rate FK, discount, tip, service fee. |
| **Housecall Pro** | **Yes** | DOCUMENTED (API): `Job` carries `invoice_number`, `subtotal`, `total_amount`, `outstanding_balance`. `Estimate` has no financial fields at all. Tax-rate dropdown sits under Subtotal on the job. |
| **ServiceTitan** | No | Job is a scheduling container; tax zone comes from the service location and lands on the INVOICE. |
| **Jobber** | No | DOCUMENTED (GraphQL): `type Job` has no tax field and no discount field. Help centre: "Jobs in Jobber don't include taxes, deposits, or discounts." |
| **FieldEdge** | No | Tax comes from a QuickBooks Sales Tax Group on the CUSTOMER record; the rate is not even editable inside FieldEdge. Invoice is billing truth: "Creating an invoice on a work order is what allows FieldEdge to calculate any costs." No work-order discount field or permission found. |

**2-3 - the job-owns-money model is the MINORITY position.** Recording that plainly because the
first version of this table said 2-2, before the FieldEdge evidence landed.

The split is by market segment, and the two that agree with us are the two that matter:
- **For it:** Workiz and Housecall Pro - both SMB contractor shops, ServWave's exact market.
- **Against it:** ServiceTitan (enterprise), Jobber (job is a deliberately money-free execution
  record), FieldEdge (tax is tethered to QuickBooks and cannot live on a document at all).

The deciding argument is not the tally, it is that **ServWave has already made this choice**:
SRVW-85 made job Items the billing truth, and the urgent workflow invoices a job with no estimate
anywhere in the picture. The Jobber/ServiceTitan/FieldEdge model is not available to us without
undoing that. **E1/E2 confirmed - on architecture already committed to, corroborated by the two
closest peers, not on a majority vote.**

### 6.2 Does attaching a document ever re-price already-entered work?

**Unanimous no, 4 of 4.** Nobody silently re-prices.

- **Workiz** - explicit user-pressed "Sync to job" that *overwrites* job items ("Syncing an estimate
  to a job will overwrite any existing job items"). A live derivation would need no button.
- **Housecall Pro** - approval only notifies; a human presses "Copy to this job", and approved items
  **append**. HCP refuses to auto-merge two approved options, forcing manual re-entry instead.
- **ServiceTitan** - additive; ships support articles for repairing estimate/invoice divergence
  rather than preventing it.
- **Jobber** - structurally impossible: no fields to re-price, and a quote cannot attach to an
  existing job at all.

So the behaviour that disappears under E1/E2 is behaviour **no competitor has**. Removing it is the
parity move, not a regression.

### 6.3 The percentage-discount hazard - found in OUR code

ServiceTitan documents this as expected behaviour and names it their top "why did the total change?"
support driver:

> "Percentage discounts and fees calculate against the items on the invoice they're attached to, not
> the estimate's item set." / "two percentage discounts can stack against the same subtotal and
> over-discount."

**#1187 introduced exactly this.** `recomputeInvoiceTotals` now takes `discountType`/`discountValue`
and resolves the percentage at compute time. On any document whose item set can still grow, the
discount silently re-resolves against the larger subtotal, moving tax and total.

How the two SMB peers avoid it - both by making the discount a **resolved row**, not a live rule:
- **Housecall Pro**: `JobLineItemCreate.kind` enum includes `fixed discount` and `percent discount`.
  The discount is a line item in the ledger, so it cannot drift.
- **Jobber**: discount exists only on Quote and Invoice, never on the Job.

**Fix, implemented (§8):** `discount_type`/`discount_value` are kept as the *input* the user typed;
`discount_amount` is resolved and persisted only at the moment it is set or re-edited (`PATCH
/api/jobs/:id`), never re-resolved implicitly when the item set changes. `billingFor()` and
invoice.controller.ts's whole-job door both read the frozen `discount_amount` directly. That
preserves the UI ("10% off") while making the money a snapshot. Cheaper than HCP's line-item model
and gets the same guarantee.

### 6.4 Correction to an earlier claim

I previously told Ran that Workiz supports attaching a standalone jobless estimate to an existing
job, and that Part C of #1187 mirrored it. **That was wrong.** Workiz linkage is created by
conversion only - the estimates on job #698869 are numbered `698869-1/-2/-3`, i.e. minted *under*
the job. Housecall Pro is the same shape ("Estimates on Jobs" creates them from the job). Neither
exposes an arbitrary attach.

Part C is therefore a **ServWave extension**, not parity. It may still be right - Ran asked for it
deliberately and the SERV10X-61 1:N schema supports it - but it should not be justified as parity.

**Evidence that it is worth keeping anyway.** FieldEdge has the opposite behaviour and it is a
documented, user-reported pain point: linkage exists only via the Schedule action, so "if a Work
Order is created separately from the Quote, they will not be linked" - and the failure is silent and
expensive, since "a down-payment has been made on the Quote with no way to apply the payment to the
new, unrelated Work Order." Part C's attach door dissolves that class of stranding by construction.

### 6.5 Open question that remains

Under E1/E2 a job and its estimate may hold **different tax rates with no warning**. Workiz allows
exactly this (measured: one document on NJ 6.625%, another on NY 8.875%, no reconciliation UI).
Accepting it is the cost of the job owning its number.

## 7. Verification

- `npm test --workspace=backend` + `npx tsc --noEmit`, reported honestly.
- Live on Stripe Test Plumbing: a job whose tax differs from its estimate bills the JOB's rate
  through both invoice doors; an existing job's total is unchanged by the migration (step 2).

## 8. Implementation record (2026-08-04)

Steps 3-9 shipped on `feat/job-owns-tax-discount`. Backend suite green (7,022 passed / 45 skipped,
same skip count as baseline), frontend suite green (4,448 passed / 7 skipped), `tsc` clean both
sides. No PR opened yet.

**Departures from the literal step list, and why:**

- **Job creation copies the estimate's numbers, not a fresh location lookup, for a single- or
  multi-estimate conversion.** Step 3 said "stamp tax_rate from the service location on every new
  job" - but the single-estimate branch already copies the estimate's cost basis
  (labor_hours/overhead_*) onto the new job, and the multi-estimate branch already validates every
  candidate estimate shares ONE tax_rate before creating the job. Recomputing from location instead
  would silently drop a rate the estimate had already been custom-edited to (now legal under E3).
  Standalone/duplicate jobs use the location lookup as literally specified - they have no estimate
  to inherit from. `duplicate()` does NOT copy the source job's tax_rate either, matching its
  existing "NOT copied: estimate_id, schedule, assignees, invoices" convention - fresh location
  lookup, no discount.
- **`Job.discount_amount` is frozen (never re-derived from a rate), but ONLY for the two whole-job
  readers - `billingFor()` (Items tab preview) and invoice.controller.ts's job-anchored `create()`
  (always bills the FULL job in one document).** `job.controller.ts`'s `createInvoiceFromJob`
  (draw/itemized-SUBSET door) instead carries `job.discount_type`/`discount_value` forward and
  resolves them as a RATE against whatever subset is actually being billed THIS time - freezing the
  whole-job amount there would let a small itemized subset go negative. Recorded as a per-door
  split, not a single rule.
- **Door 1 (invoice.controller.ts) defensively clamps the job's frozen `discount_amount` to that
  invoice's own subtotal** before applying it, in case items were removed after the discount was
  set (shrinking the subtotal below the frozen figure). This was NOT in the plan; found while fixing
  `invoice-doors-parity.test.ts`, which pinned the OLD rate-based clamp behavior. The shared
  `recomputeInvoiceTotals` helper's `invoiceDiscountAmount` path is deliberately left unclamped
  globally (invoice-lines.controller.ts's `/billing` endpoint already relies on that, unrelated to
  this card) - the clamp lives locally in invoice.controller.ts instead.
- **`taxSourceEstimate()` deleted from `lib/deposit-credit.ts`.** All four call sites (job-lines,
  both invoice doors, `createFromJobItems`) were retired by this same change; nothing was left
  calling it. `depositEstimateIds()` (the deposit-credit union) is untouched, per E5.
- **Invoice tax override (step 5b) needed no new code.** `PATCH /api/invoices/:id/billing` already
  accepts `tax_rate`, already recomputes, already has full test coverage, and the frontend already
  wires `onTaxRateChange`/`taxRates` on `<ReceiptCard variant="invoice">` - built before this plan,
  unrelated to it. Confirmed, not re-implemented.
- **The job's discount editor on the Items tab is amount-only (`FIXED_AMOUNT`), not a
  percentage/fixed toggle.** Estimate's card gets the toggle because `job.discount_type`/
  `discount_value` aren't in the job-detail response (only the resolved `discount_amount` is, via
  the line-items billing endpoint) - adding the toggle would mean widening that response. Left as a
  possible follow-up, not done here.
