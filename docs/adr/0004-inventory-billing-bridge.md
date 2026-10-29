# Billing lines never move stock; whether a processed Logistic Order generates a billing line is open

**Status:** accepted for the billing-to-stock direction, signed by Ran on 2026-07-20. The reverse
direction - a processed Logistic Order generating a billing line - is OPEN and has never been put to
him.

Nothing below decides that second direction. This ADR exists to record what was decided, strike what
is no longer available, and hand Ran one question.

## What was signed, and when

The Logistic Orders spec, `md_files/plans/inventory/2026-07-20-logistic-orders-spec.md`, opens at line
3 with "Status: FULLY SIGNED - zero open decisions (see §11 sign-off log ...)" and "Supersedes:
line-level deduct-on-add / sync-stock as the deduction model". Section 1, line 7: "Billing lines
(estimate / job / invoice) never move stock - they can be packages, scope-of-work, services,
discounts; the LO is where a human decomposes them into real parts." Section 2, line 18, names what
was removed: "Removed as deduction paths: deduct-on-add and sync-stock on job/invoice lines,
including the restricted-tech van auto-deduct (QA-405)." Section 9, whose heading at line 98 reads
"Explicitly out of scope for v1 (confirmed)", lists at line 100 - among partial staging, kit/BOM
auto-decomposition, email/SMS notifications and multi-step approval - "automated job-lines to LO
coverage checks". Section 11's sign-off log records at line 115 "Signed by Ran (relayed verbally to
the PM session)", and line 116 re-affirms the section 2 deduction doctrine together with its accepted
human-discipline risk: field usage is reconciled by manual adjustment after the job, and it is "the
responsibility of the business owner to check."

So the severance in the billing-to-stock direction is not a leftover. Ran signed it on 2026-07-20 and
commit `dd1443728` ("feat(inventory): retire line-level stock sync - LO processing owns deduction",
#879) implemented it deliberately. SRVW-116's premise - that this is "a leftover of the LO-4
refactor, not a decision" - is wrong for that direction, and any argument for changing it has to
start by saying so.

## What the spec did not decide

The spec settles which document deducts stock. It never decides that a processed LO creates a billing
line. Section 9's deferral is "automated job-lines to LO coverage checks", which is a reconciliation
warning, not a billing bridge - and "for v1" is a deferral, not a permanent severance. The section 11
sign-off log enumerates the section 9 cuts Ran actually signed (no partial staging, no kit
auto-decomposition, in-app notifications only, single approval step) and does not mention coverage
checks at all. The stock-to-billing direction was never put to him in either form.

The case for building it is measured, not inferred. The Workiz parity report,
`md_files/specs/competitive/2026-07-30-workiz-servwave-behavioral-parity-validation.md`, written ten
days after the spec was signed, records at line 386: "The forced double-entry: a contractor must enter
material twice - once as a billable job line (customer price), once as an LO line (stock) - with
nothing reconciling them. There is a warning banner for the legacy overlap and no guard for the new
one." Its section 4.5 capability table puts it plainly at line 380: "Materials used on a job ->
billable invoice line | NO. Processing an LO writes only StockMovement. No JobLineItem, no
job_line_item_id on the LO line | GAP - the module's defining gap."

Secondarily, and as an argument about typical usage rather than something the code proves: section
1's model presupposes a billing line authored first, for the LO to decompose into real parts. That
fits ServWave's documented Urgent workflow least well - Lead to Urgent Job with no estimate and no
deposit, then an Invoice carrying line-item charges - because there is no package line waiting to be
decomposed. This is an illustration of where the model strains, not evidence of a defect.

## Option A is struck, on the spec's own words and the C2 freeze collision

Option A on the card is "un-park `line_stock_sync` (billing lines drive stock)". Two independent
reasons remove it from the live option set.

First, the spec supersedes it and lists sync-stock among the removed deduction paths (both quoted
under "What was signed").

Second, un-parking it collides with the C2 legacy freeze that shipped in the same commit.
`backend/src/controllers/job-lines.controller.ts:457` and
`backend/src/controllers/invoice-lines.controller.ts:748` both refuse quantity edits on lines whose
`stock_status` is `SYNCED`, answering 400 `LEGACY_STOCK_LINE`. Two live deduction models would let
the same physical stock move twice, which is the exact scenario that freeze exists to prevent.

For the record, and correcting the card's undercount of "the one manual bridge": there are four
parked routes across two files, not one. `backend/src/routes/job.routes.ts:59-60` and
`backend/src/routes/invoice.routes.ts:50-51` each register `/:id/line-items/sync-stock` and the
`:lineId` variant behind `featureDisabled('line_stock_sync')`, which returns 404 `FEATURE_DISABLED`
and never calls `next()` (`backend/src/middleware/featureDisabled.ts`). Their handlers are dormant at
`job-lines.controller.ts:657/710` and `invoice-lines.controller.ts:587/644`, and those are the only
code in the repo that writes `stock_status: 'SYNCED'` (`job-lines.controller.ts:650`,
`invoice-lines.controller.ts:571`).

The live choice is B or C.

## The status quo, recorded so it stops being re-filed

In code, every billing line is stamped `NOT_TRACKED` unconditionally at seven sites, not the four the
card names: `backend/src/controllers/job.controller.ts:1236`, `:1536` and `:3625`;
`invoice.controller.ts:202`; `estimate.controller.ts:3570`; `job-lines.controller.ts:332`; and
`invoice-lines.controller.ts:414`.

In the schema, `LogisticOrderLine` (`backend/prisma/schema.prisma:2838-2868`) declares no relation to
any billing-line model in either direction - its relations are `logistic_order`, `item`,
`from_location`, `stock_movements` and `organization` - and `JobLineItem` (`:939`) and
`InvoiceLineItem` (`:902`) likewise declare no `LogisticOrderLine` relation.

The consume path, `backend/src/lib/logisticOrders.ts:565-580` inside `processLogisticOrder` (`:416`),
passes `orgId`, `jobId`, `logisticOrderId` and `logisticOrderLineId` to `applyStockMovement` and never
a line-item id.

Measured on staging `knriiqdqxgfoecsfarlx`, re-run for this ADR on 2026-08-03: 11 LO-linked stock
movements, 6 of them consumes, 0 carrying a `job_line_item_id` or an `invoice_line_item_id`; 4535 of
4535 invoice lines `NOT_TRACKED`; 2438 of 2439 job lines `NOT_TRACKED`, the single exception being a
legacy QA row ("QA-WIDGET line", `stock_status` `UNSYNCED`); 6 logistic orders, 1 `PROCESSED` and 3
`RETURNED`. The 0-of-11 linkage is the honest number here. A related figure that has circulated - that
all 6 consumes sit on jobs with zero billing lines - should not be repeated: 3 of the 6 have a NULL
`job_id`, so for half the sample that is a null-join artifact rather than evidence.

## The one open question: build Option B?

The recommended default is not a blank slate. The parity report ranks this finding #1 of 20 in its
section 6 and sequences it in section 10 as "Phase 3 - the one that makes inventory real". Its section
6 item 1, at line 460, reads: "Consumed material never becomes revenue (section 4.5). Fix: on LO
process with a job_id, insert one JobLineItem per line behind an org setting, and add
logistic_order_line_id to JobLineItem so the unwind can reverse it. This is the inventory module's
reason for existing, half-built."

If the answer is B, four sub-answers are needed that the codebase cannot supply. Each carries this
ADR's recommendation and its reason; the answer is Ran's.

1. **What price does a generated line carry** - `PriceBookItem.unit_price`, `unit_cost`, or cost plus
   a markup? This is not a detail: `LogisticOrderLine` has no price column at all
   (`schema.prisma:2838-2868` is qty plus `item_sku`/`item_name` plus `from_location` plus
   `sequence`), so any bridge must resolve the price from `PriceBookItem` at bridge time and snapshot
   it onto the generated line. `unit_price` is not `unit_cost`, and picking the wrong one is a
   money-losing default in one direction and a customer-facing overcharge in the other. Recommend
   `unit_price`: it is the only non-null price on the catalog row (`unit_cost` is nullable) and it is
   already the customer-facing number every other billing line carries. Cost-plus-markup is not
   reachable without new schema - `PriceBookItem` has no markup column.
2. **Does the org setting default ON or OFF for the existing SCALE orgs** (count under Entitlement
   blast radius)? Recommend OFF. ON silently starts putting charges in front of customers for lines no
   human priced.
3. **Does a generated line stay editable**, or is it frozen to its LO line the way legacy `SYNCED`
   lines are frozen today by the C2 guard? Recommend editable, since the LO line has no price of its
   own and the office will want to correct it - but freezing is the safer answer for reconciliation.
4. **Smaller: `is_taxable`.** `JobLineItem.is_taxable` defaults `true`, so a generated line inherits
   `true` unless the bridge sets otherwise. Recommend copying `PriceBookItem.taxable` (which also
   defaults `true`) rather than leaning on the column default, so a catalog item deliberately marked
   non-taxable does not silently become taxable the moment an LO generates its line.

The honest tension, which is why this is a product call rather than a derivable default: Workiz
reaches this outcome the Option A way. Its catalog item on the job is simultaneously billing truth
and stock truth, which is the direction the signed spec removed - billing lines driving stock. The
parity report's section 4.5 table is the citable form of this - the row quoted under "What the spec did
not decide" marks that capability as present for Workiz and absent for ServWave. So "match
Workiz" and "preserve the signed architecture" point at different answers. Note the limit of the
evidence: the comparison rests on the parity report's behavioural table, not on an inspection of
Workiz's own data model.

## If the answer is B: the shape of the card to cut

Written out so that a "yes" costs one action. No Linear card is created for Option B now - the
decision has not been made, and a card for an unchosen option pollutes a backlog that was recently
pruned.

**(a) Both reversal paths, not one.** Missing either silently leaves a billed line for material that
went back on the shelf. The paths are `returnProcessedLo`
(`backend/src/lib/logisticOrders.ts:642`, its return write at `:680`) and `applyProcessedLineDiff`
(`:906`, returns at `:1070` and `:1086`, consumes at `:1170` and `:1187`) for edits to an
already-`PROCESSED` order. That `returnProcessedLo` is the funnel is quotable rather than asserted:
the docblock at `logisticOrders.ts:801-802` states that `PROCESSED` LOs are unwound through
`returnProcessedLo`, "the ONLY unwind path (spec §14 H1)". Staging already holds 3 `RETURNED` LOs, so
this is live behaviour, not a hypothetical.

**(b) Tenancy is anchored on the LO row, not on the request.** Only `processLogisticOrder` (`:416`) is
request-scoped, taking `orgId` from `req.user!.organization_id` at `:422`. `returnProcessedLo`
(`:642`) receives a transaction client plus the LO row and scopes on the row itself - its claim
`updateMany` at `:646-648` uses `organization_id: lo.organization_id`. `applyProcessedLineDiff`
(`:906`) and `applyAnchoredLoUnwind` (`:813`) take a bare `tx` with no request at all. So a generated
`JobLineItem` must copy `organization_id` from the `LogisticOrderLine`/`LogisticOrder` row inside the
transaction (`schema.prisma:2861`); pointing at `job.controller.ts:1236`'s request-scoped `createMany`
as the pattern to follow would be a trap on two of the three paths. Any lookup that genuinely is on a
request path still spreads `tenantWhere(req)`. Second trap to flag: `JobLineItem` carries an
`organization_id` column, `InvoiceLineItem` does not - it scopes through `invoice_id`.

The rest of the card body - TDD ordering, sizing, and a back-compat sample - is process content, not a
decision consequence, and is kept ready to paste in
`md_files/plans/inventory/2026-08-03-lo-billing-bridge-option-b-card-shape.md`.

## Consequences and what this does not cover

**The struck option is still advertised in-repo.** Three comments on `origin/staging` present Option A
as available: `job.routes.ts:54-58` and `invoice.routes.ts:45-49` both say "The handlers stay dormant
in the controller (bulkSyncStock/syncStockLine) so un-parking is a one-line revert", and
`featureDisabled.ts`'s own header says "the route stays mounted so un-parking is a one-line revert".
Those comments describe a rollback affordance, not a live option: Option A is struck by this ADR.
Amending the three comments to say so is a named follow-up, deliberately left outside this docs-only
diff. Without this paragraph an auditor reading only the code finds four routes and two dormant
handler pairs advertising exactly the option this ADR removes, and re-files the card.

**The same severance exists on the cost side.** `getJobMaterialCost`
(`backend/src/controllers/inv-po.controller.ts:1674`) sums only `purchaseOrderLine` and
`jobStageLine`, so material consumed from van stock via an LO contributes zero to job cost. The
comment that justifies this at `:1671-1672` - "StockMovement carries no cost/job_id and JobCharge is
billing-only, so neither is the source" - is factually false on `origin/staging`:
`schema.prisma:2161` gives `StockMovement` a `job_id` and `:2164` gives it a `unit_cost`, and the LO
consume path already stamps both (`logisticOrders.ts:565-580` passes `jobId` and `unitCost`).
Disposition: filed separately as its own Linear card (SRVW-183), not folded in, because it is true
under every branch of this decision. That card must pose the dedup rule as an open design question
rather than implement parity section 6 item 16 literally - PO receiving already writes a job-anchored
stock movement (`inv-po.controller.ts:1014-1026`), so summing consume movements on top of the
existing PO-line sum would double-count material bought on a job-anchored PO and then issued to that
job by an LO.

**Entitlement blast radius** is 7 SCALE orgs today (`inventory` is minPlan SCALE, 0 PRO overrides
measured 2026-08-03). SRVW-94 reports the LO routes are missing `requireFeature` entirely, which would
widen it.

**Source correction.** SRVW-116 cites parity report section 2.7, which is the unrelated overpayment
defect. The real source is section 4.5 plus section 6 item 1 plus section 10 Phase 3. The card's
Source line has been corrected to match.

See `md_files/plans/inventory/2026-07-20-logistic-orders-spec.md` sections 1, 2, 9 and 11, and
`md_files/specs/competitive/2026-07-30-workiz-servwave-behavioral-parity-validation.md` sections 4.5,
6 item 1, 6 item 16 and 10. The parity report is not yet committed to `origin/staging`, so that second
path dangles until it is - which is why its two load-bearing lines are quoted inline above.
