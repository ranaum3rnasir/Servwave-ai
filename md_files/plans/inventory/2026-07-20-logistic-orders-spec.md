# Logistic Orders — v1 Specification

**Date:** 2026-07-20 · **Status:** **FULLY SIGNED — zero open decisions** (see §11 sign-off log; numbering + dispatcher flags closed by Ran 2026-07-20 post-plan) · **Supersedes:** line-level deduct-on-add / sync-stock as the deduction model · **Build from:** `2026-07-20-logistic-orders-implementation-plan.md`

## 1. Concept

A **Logistic Order (LO)** is the form of *physical* items for a piece of work, and the **single place where tracked stock is deducted**. Billing lines (estimate / job / invoice) never move stock — they can be packages, scope-of-work, services, discounts; the LO is where a human decomposes them into real parts.

Industry analogue: material requisition / goods issue (NetSuite "item fulfillment", ServiceTitan "requisition", D365 work-order product → `Used`). Manual-adjustment philosophy borrowed from Zoho Inventory: every manual change carries a reason, a date, and an actor.

## 2. Deduction doctrine (v1)

Stock moves **only** via:

1. **LO processing** — the `APPROVED → PROCESSED` transition writes one `consume` movement per line.
2. **Manual inventory actions** — adjustment (reason **required**), restock, transfer, physical count. Ledger already records date + actor.

Removed as deduction paths: deduct-on-add and sync-stock on job/invoice lines, **including the restricted-tech van auto-deduct (QA-405)**. Field usage is reconciled after the fact by a manual adjustment or an office-created LO. Accepted risk (Ran ruling 2026-07-20): relies on human discipline; the business owner audits. Doctrinal support: van stock is assumed inaccurate between counts everywhere — cycle counts converge it.

## 3. Data model

```prisma
enum LogisticOrderStatus { DRAFT PENDING_APPROVAL APPROVED PROCESSED CANCELLED }

model LogisticOrder {
  id, organization_id, number (unique per org), status
  // Anchors — all optional, all SetNull. "It's just a link."
  job_id?, invoice_id?, estimate_id?, lead_id?, customer_id?
  notes?
  created_by, submitted_at/by?, approved_at/by?, processed_at/by?, cancelled_at?/reason?
  timestamps
}

model LogisticOrderLine {
  id, organization_id, logistic_order_id (Cascade)
  item_id (PriceBookItem, SetNull) + item_sku/item_name snapshots (ledger doctrine)
  qty Decimal(10,2)
  from_location_id (InventoryLocation)
  sequence
}
```

- **Tracked items only** (`track_inventory = true` at add time) appear in the LO item picker.
- **Multi-location pulls:** the same item MAY appear on multiple lines with different source locations (5 units = 3 from Main + 2 from Van). No uniqueness on (LO, item).
- A line cannot be processed without a `from_location_id` — form completeness, not a status lock.
- `StockMovement` gains `logistic_order_id` / `logistic_order_line_id` (SetNull, additive migration) for drill-through, mirroring the `job_line_item_id` precedent.

## 4. Numbering

**Code finding:** today's estimate numbers are a FLAT global per-org sequence — `allocateNumber(tx,'estimate',org)` → `E00042` (`backend/src/lib/numbering.ts`, `estimate.controller.ts:884`). The anchored `parent-1, -2` scheme does not exist in the implementation. LO therefore becomes the **first anchored numbering** in the product.

Proposed format:

| Context | Number |
|---|---|
| Anchored at creation (job J00042) | `J00042-LO1`, `J00042-LO2`, … |
| Anchored to invoice I00107 | `I00107-LO1` |
| Anchored to estimate / lead / customer | same pattern on that entity's number |
| Standalone | `LO00001` (global, via `allocateNumber` — new `logistic_order` entity row) |

Rules: per-anchor sequence starts at 1; computed in-tx with a unique `(org, number)` constraint + conflict retry. **The number is stamped at creation from the then-current anchor and is immutable** — re-linking later never renumbers. If Ran later wants estimates to adopt the same anchored scheme, that is a separate change.

## 5. Lifecycle, permissions, editing

**Transitions:** `DRAFT → PENDING_APPROVAL` (submit; notifies approvers) → `APPROVED` (approver) → `PROCESSED` (deduction fires). `CANCELLED` from any pre-processed state. An actor holding the approve grant can move their own draft straight through — approval collapses naturally for small shops; no org toggle.

**Permissions:** new CASL subject `LogisticOrder`. Defaults: ADMIN full; DISPATCHER create/read/update/process; SALES create + submit (they author the form) but not approve/process; TECHNICIAN read LOs anchored to their own jobs. **Approve = per-user grantable capability** via the existing `userCapabilities` pattern (admins default yes) — zero new framework.

**Processing semantics:** all-or-nothing in one transaction. Org negative-stock policy applies per line: block-mode shortage on any line → 409 with per-line detail, nothing deducted; warn-mode proceeds negative with warnings. Movement `occurred_at` = processing time (physically true — this resolves the old date-axis debate; task #18 dies). All pre-tx resolution per the pool-starvation lesson.

**Manual-edits rule (Ran):** statuses gate the deduction event, not editability.
- Editing a PROCESSED LO's qty auto-posts the delta (5→3 returns 2; 3→5 consumes 2) — reuses the existing tested delta code.
- Deleting a PROCESSED LO returns all its stock first (same before-delete ordering as the per-line delete fix).

**Job cancellation** (Ran ruling): the cancel dialog lists the job's LOs and statuses, showing which items will be returned. On confirm: PROCESSED LOs auto-return their stock and become CANCELLED; open LOs simply become CANCELLED.

## 6. Notifications (v1: in-app only)

- Submit → users holding the approve grant ("J00042-LO1 awaiting approval").
- Approve → creator.
- Pending-approval list/tab with badge count in the Inventory module.

## 7. UI surfaces (v1)

- **Inventory module → "Logistic Orders" tab:** list w/ status filter, create standalone, pending-approval view.
- **Job page → Logistic Orders tab:** list + create (pre-anchored). Same for invoice detail (covers standalone invoices).
- **Estimate / Lead / Customer:** schema supports the links; dedicated tabs deferred (v1 cut — flag to veto).
- **LO detail:** header (number, status, anchor links, actor trail), line editor (tracked-item picker showing per-location on-hand for the selected item — reuses the existing per-item fetch), Submit / Approve / Process buttons per permission, clean print view, cancel.

**Retired UI:** AddLineDialog "Deduct from" select + on-hand hint; job/invoice line sync buttons; SYNCED stock pills. `stock_status` stays in the DB; new lines simply never become SYNCED, so the legacy qty-delta/auto-return backend self-neutralizes while still protecting pre-LO rows.

**Route changes:** `featureDisabled('line_stock_sync')` on the four sync-stock routes; `stock_location_id` removed from the add-line schemas (pre-release API break is fine).

## 8. Manual adjustment hardening (Zoho-style)

`set-quantity` (and any signed adjust UI) makes **reason required**. Date + actor already ledgered.

## 9. Explicitly out of scope for v1 (confirmed)

Partial staging (all-or-nothing processing) · kit/BOM auto-decomposition (human decomposes) · email/SMS notifications · multi-step approval · automated job-lines↔LO coverage checks · van one-tap deduct (removed per ruling) · committed/available math — **future hook:** an APPROVED-but-unprocessed LO *is* a committed quantity; `Available = on-hand − committed` and the currently-hidden `reserved` column come free in v2.

## 10. Build & QA plan

Additive, portable, idempotent migration (CLAUDE.md rules). Backend TDD with revert-checked tests; tx-connection-isolation discipline applies. Then: retire line-sync UI, re-run the QA scenario suite end-to-end on the LO model, re-issue the release verdict (#15). Purchasing gate (#13) and SALES tightening (#14) proceed unchanged.

## Open questions for sign-off

1. **Numbering:** confirm `J00042-LO1` style + flat `LO00001` for standalone — knowing estimates are actually flat today.
2. **SALES:** create + submit but not approve/process — correct?
3. **Processing all-or-nothing** on block-mode shortage — OK?
4. **v1 UI cut:** LO tabs on Job + Invoice + Inventory only (estimate/lead/customer links exist in schema, tabs later) — OK?

## 11. Sign-off log & PM review (2026-07-20, inventory-PM session)

**Signed by Ran (relayed verbally to the PM session):**
- §2 deduction doctrine incl. the accepted human-discipline risk — re-affirmed: field usage reconciled by manual adjustment after the job; "the responsibility of the business owner to check."
- LO ≠ adjustment — two distinct ledgered paths (his words: an LO is not the same as an adjustment; adjustments must carry date + reason + who, per Zoho Inventory).
- §3 anchors-to-everything + standalone LOs, presented in-context ("jobs will have a logistic order tab").
- §3 multi-location — items live at multiple locations; multi-location pulls per LO confirmed.
- §5 job-cancel dialog lists the job's LOs + statuses + what returns.
- §8 required reason on manual adjustment.
- §9 cuts: no partial staging, no kit auto-decomposition, in-app notifications only, single approval step.
- Q3 effectively signed via "no partial staging" (all-or-nothing processing).

**Q1 numbering — RESOLVED 2026-07-20 (Ran's second pass, PM-adjusted):**
Ran's rule: `LO` is the document PREFIX and the suffix is always `-1, -2, …` — no type token inside the suffix ("we keep the same ID number, just with a different prefix"). PM adjustment — **CONFIRMED by Ran 2026-07-20** ("the LO-J00042-1 format is confirmed"): the anchor's own letter stays in the core, because per-entity sequences overlap numerically — job `J00042` and invoice `I00042` both exist, so bare `LO00042-1` cannot say which parent it belongs to. **Final format: `LO-J00042-1`, `LO-J00042-2` · `LO-I00107-1` · standalone `LO00001` (flat — signed) · mint-once at creation, re-linking never renumbers.**
Build notes: (a) multi-anchor at creation → the number takes the most specific anchor: job > invoice > estimate > lead > customer; the rest stay plain links. (b) Persist the seq as an int column — string sort puts `-10` before `-2`. (c) Implement as a shared `allocateAnchoredNumber()` helper; the estimate-renumbering session must reuse it (mirror scheme, e.g. `E-J00042-1`), not re-implement.

**Q2 SIGNED (Ran 2026-07-20):** SALES role defaults = create + submit; approve/process excluded from defaults, admin-grantable per user via the existing `userCapabilities` pattern — exactly §5's design.
**Q4 SIGNED (Ran 2026-07-20):** v1 tabs on Job + Invoice + Inventory only; estimate/lead/customer remain schema links without tabs.

**Design constraint (Ran, binding on build and review):** the module must stay easy and understandable — few options, obvious flows. The small-shop happy path is three actions: create LO → add lines → Process (approval collapses when the actor holds the grant). Anything exceeding that budget needs a stated reason.

**Review pass:** adversarial spec review running in the PM session — three lenses: codebase edge-case collisions (cancel/void/delete × legacy SYNCED coexistence), UX simplicity vs the constraint above, migration/compat & test fallout. Findings will be appended here.

## 12. Review findings — UX lens (2026-07-20, adopted by PM unless marked open)

Verdict: the data model and lifecycle are already simple; the risk was literal rendering. As written the happy path costs ~28 interactions; with the two amendments below it lands exactly on the three-action budget.

**Adopted amendments (implement these, they refine §5/§7/§8 wording):**
1. **One primary action per state and permission.** A grant holder on their own DRAFT sees a single **Process** button that fast-forwards DRAFT→…→PROCESSED server-side in one transaction, stamping all `*_at/by` columns (audit trail intact). Non-holders see **Submit for approval**. Suppress §6 notifications on the straight-through path (never notify an actor about their own click). §5 already permits this; §7's "Submit / Approve / Process buttons" is superseded by this wording.
2. **No per-line location friction.** New line inherits the previous line's `from_location`; line 1 resolves via the existing chain (`stockLocationMemory.ts` session memory → `org.default_inventory_location_id` → first location); every line keeps its override select with per-location on-hand. 8 lines from one warehouse = 1 decision. Default qty = 1. No new header field.
3. **§8 amended: preset reason + optional note, not required free text.** v1 fixed list: `Cycle count / Damaged / Used on job / Returned to vendor / Lost or stolen / Other` (note required only for Other). "Used on job" is the doctrinally load-bearing preset — it makes §2's field-usage reconciliations filterable. User-managed reason lists deferred (settings surface = new option).
4. **Pending-approval = a status filter chip + badge on the ONE Logistic Orders list** (Inventory `ViewTab` `highlight` pattern), not a separate approvals surface.
5. **Standalone create = one screen, zero anchor UI.** Attach-later re-link UI deferred (schema links ship; anyone reconciling a job creates from the job tab, pre-anchored).
6. **Cancel-job dialog rows:** per LO one row — number · status badge · aggregated consequence ("returns 12 units"), one closing sentence "Processed orders return their stock automatically." No per-line lists, no checkboxes.
7. **Post-processed edits** show the existing delta-hint pattern ("Saving returns 2 to Main Warehouse") before commit. `cancelled_reason` stays optional — correct asymmetry vs required adjustment reason.
8. **Print view deferred** (only §7 item with no ruling behind it; afternoon-sized to add later).
9. **Build reuse requirement:** one `LOList` component (re-anchored by props) + one LO detail/editor (doubles as standalone create) + one picker. Net new chrome after cuts ≈ 7 surfaces, 3 real components; the spec also retires 3 surfaces.

**SIGNED (Ran 2026-07-20, second pass):**
- **Job-page tab: fold the LO list into the existing "Logistics" tab** as its top section — no 10th tab. (`JobDetailPage.tsx:1319` collision resolved.)
- **Technician surface: NONE in v1, and do not touch the existing tech mobile UI** — Ran is replacing the tech experience wholesale in separate work. **v1 UI focus = ADMIN + SALES office surfaces only.** Drop the TECHNICIAN read grant from v1 defaults (re-add with the new tech app; trivial later). DISPATCHER role defaults **stay** in the permission model (same desktop screens as admin, zero extra UI work) — **CONFIRMED by Ran 2026-07-20** ("Dispatcher keeps its role default").

## 13. Review findings — migration/compat lens (2026-07-20; full report: `2026-07-20-lo-build-readiness.md`)

Verdict: **every pattern needed has a live template in the codebase.** Adopted decisions (implementation-level, PM):
1. **Migration template** = the P4 assets migration (`20260717050000_inventory_p4_assets`): enum guard, IF-NOT-EXISTS tables, RLS enable+force+policy, pg_roles-guarded grant strip. role_permissions seeding for existing orgs via the DEFAULT_GRANTS cross-join style (NOT the subject-split derivation). Never `prisma migrate` from a worktree.
2. **Numbering:** flat `LO00001` via `allocateNumber` (new `logistic_order` entity + three org columns, prefix `'LO'`). Anchored `allocateAnchoredNumber()` = in-tx `SELECT … FOR UPDATE` on the **anchor row** + `MAX(seq)+1`, persisted int `seq`, `unique(org, number)` backstop — no retry loop. The flat counter's self-heal subquery must exclude anchored rows (`WHERE number NOT LIKE '%-%'`) or anchored seqs bump the standalone sequence.
3. **Multi-line 409:** in-tx pre-check over all balances → new `AggregateShortageError` with `details[]` + response fn (implements the signed "per-line detail"); the conditional-atomic decrement still backstops races.
4. **CASL:** `approve` = capability-only, NOT in the catalog (mirrors `location_restricted`); `process` = cataloged DISPATCHER default; `ScopeResource` extended with `'LogisticOrder'`; `StockMovementInput` + create block gain `logisticOrderId`/`logisticOrderLineId`.
5. `featureDisabled` union gains `'line_stock_sync'` (returns 404, auth first).
6. **Notifications:** reuse `emit()` + `TEMPLATES` + `resolveRecipients` (no enum migration — verb/object_type are plain String). Approve-grant holders = `userPermissionOverride` query ∪ ADMINs via `loadRoleHolders`; emits fire AFTER the tx.
7. **Cost transparency:** ~48 tests across 3 suites die or need rewriting; the qty-delta/delete-return keepers must re-run against the modified controllers to prove legacy self-neutralization.

## 14. Review findings — edge-case lens (2026-07-20; detail in build-readiness Part 2)

Two critical gaps found pre-build; closed by these adopted amendments:

**C1 — document-verb table (extends §5).** Job cancel was the ONLY spec'd LO unwind — but COMPLETED jobs cannot be cancelled (`job.controller.ts:2316`), so invoice void is the only unwind for finished work, and it had no LO rule (stranded stock). Adopted: **invoice void / invoice delete → return PROCESSED LOs anchored to that invoice; job delete → return PROCESSED + cancel open LOs in the same tx** (the LO survives unanchored via SetNull as a historical document). A DRAFT invoice that survives job-cancel keeps its LO (unwound later by its own verb — test case for §10).

**H1 — return idempotency + state-machine fix.** §5 self-contradicted ("CANCELLED from any pre-processed state" vs PROCESSED→CANCELLED on job cancel), and a multi-anchor LO (job+invoice) could be returned twice inside one cancel tx. Adopted: **new terminal status `RETURNED`** (deducted-then-unwound; `CANCELLED` = never deducted), and one `returnProcessedLo(tx, lo)` guarded by compare-and-set (`updateMany where status='PROCESSED'`; count 0 → no-op) used by EVERY unwind path.

**H2 — attribution stamping.** Adopted: LO processing MUST go through `applyStockMovement` per line (inherits low-stock alerts + negative-stock policy + ledger snapshots); each movement stamps `job_id` from the LO's anchor and `reference = <LO number>`; `movementInclude` + the usage-report select gain a `logistic_order` join so job AND invoice attribution survive in the usage report and Action log.

**H3 — transition visibility.** Adopted: LO create/edit on a job that still has legacy SYNCED lines shows a one-line notice listing them; the cancel dialog lists BOTH the job's LOs and the legacy "N synced item(s) will be returned" row while any SYNCED line exists.

**M-tier adopted:** retired-UI list completed (six unnamed surfaces incl. the completion toast, CreateJobInvoiceDialog nudge, editor toasts; SYNCED pills removed only TOGETHER with the C2 freeze) · blast-radius rule: relocate `extractShortage`/`toastStockWarning` out of SyncStockDialog before deleting it; salvage AddLineDialog's per-location on-hand fetch for the LO picker; fix the estimate editor's inherited no-op "Deduct from" select (pre-existing lie) · restricted-tech: the 4 addLine/sync seams die; van-balances view stays; `location_restricted` capability rows stay · **PROCESSED line-ops table:** add line → consume on save; remove line → return; location change → return old + consume new (block-mode applies to the consume side); item swap → forbidden (delete + re-add) · **all new lines stamp `NOT_TRACKED`** (clean era marker; kills the misleading UNSYNCED stamps); the job→invoice NOT_TRACKED copy rule stays · no LO status transition is legal on a CANCELLED job (mirrors the cancel-is-terminal invariant).

**C2 — legacy qty freeze: SIGNED YES (Ran 2026-07-20).** Freeze quantity edits on `stock_status='SYNCED'` lines (400 `LEGACY_STOCK_LINE`); price/description/tax edits and delete-with-auto-return stay. All restricted-tech enforcement seams retire together; SYNCED pills retire with the freeze (M1 rule).

**M4 — SIGNED ALLOW (Ran 2026-07-20):** plan-visit jobs may anchor LOs — an LO is goods issue, not billing; the `NOT_BILLABLE` guard keeps applying to billing lines only. Ran extended the ruling into a plan-level materials template → §15.

**PM build notes from the hardening session (avoid re-learning):**
- PR #859 merges regardless of LO timing — the pool-starvation fixes cover restock/bulk-restock/transfer/set-quantity, which remain live deduction paths under §2.2. The tx-isolation discipline and the distinct-tx-spy harness (`inventory-tx-connection-isolation.test.ts`) apply verbatim to LO processing tests.
- §5's qty-delta and before-delete-return semantics are already implemented and revert-check-tested in job-lines/invoice-lines controllers (delete fix, commit 73a536b3) — reuse, don't reimplement. `returnSyncedLines` is the return loop.
- QA-405 replacement hook (NOT v1): tech van self-serve = per-user approve+process grant on own-job LOs via the existing `userCapabilities` pattern — recovers one-tap field deduction inside the LO model, zero new framework.
- Date axis: `occurred_at` = processing time (§5) stands. If Ran still wants usage reported by JOB scheduled date (his earlier ask), add a nullable `service_date` snapshot on StockMovement populated from the LO's job anchor at processing; the usage report groups by `service_date ?? occurred_at`. Parked, not signed.
- Release bookkeeping: verdict re-issue (#15) now gates on the LO-model QA re-run (§10). Purchasing gate (#13), SALES tightening (#14), Inventory Value tile fix (#20), hide-reserved (#22) proceed unchanged. Date-axis task (#18) retired as resolved by §5. Picker task (#19) repurposed to the LO line-editor picker — tracked-only filter + per-location on-hand; note `searchItems`' select currently omits `track_inventory`, so don't reuse it blindly for the LO picker.

## 15. Service-plan materials template (Ran 2026-07-20: "let's include that thing as well" — design concluded by PM)

**Intent (Ran):** define materials once on a service plan; every generated visit gets an LO automatically; each visit's LO stays adjustable per job.

**Research grounding:** the ONLY visit-job creation path today is the manual `scheduleVisit` (`backend/src/controllers/service-plan.controller.ts:513-588`, in-tx; route `service-plan.routes.ts:24`). The auto-generation cron does NOT exist yet (confirmed — `backend/src/cron/` has only estimate-expiration; the four registered crons in `index.ts` touch nothing plan-related). Plans carry billing-only free-text `ServicePlanLineItem`s (schema:835-849) — no material/product references anywhere on `service_plan*` tables. Visit = `Job` row with `source_plan_id` + a `PlanVisit` join row (`job_id` SetNull); skipped visits have `job_id: null`.

**Decisions (PM, per Ran's "take the call"):**
1. **The template is plan data, not a fake document.** New model `ServicePlanMaterialLine` — `service_plan_id` (Cascade), `item_id` → PriceBookItem (SetNull), `qty Decimal(10,2)`, `position` — mirroring the existing `ServicePlanLineItem` shape. NOT a `LogisticOrder` row with a TEMPLATE status: a template has no number, no lifecycle, no anchors, and polluting the LO status enum would leak into every list, count, and report.
2. **Instantiation** happens inside the `scheduleVisit` transaction, after job + PlanVisit create: if the plan has material lines, mint ONE LO — status **DRAFT**, anchored to the visit job (number `LO-J…-1` per §4) **and** to the plan via a new sixth anchor `service_plan_id` (SetNull, additive — enables per-plan materials reporting later), lines = item sku/name snapshot + qty, `from_location_id` null (filled by the default chain in the editor at process time, §12 rec 2), `created_by` = the scheduling actor, notes reference the plan number. Extract as **`instantiatePlanMaterials(tx, plan, job, actor)`** — the future auto-generation cron calls the same function.
3. **Never auto-processed.** DRAFT only. Deduct-at-issue doctrine: stock moves when parts are pulled (Process), not when a visit lands on the calendar — auto-processing would recreate the rejected deduct-at-scheduling model and fire shortage errors inside visit scheduling. Office processes when staging the parts.
4. **Per-visit divergence is free:** the minted LO is an ordinary DRAFT LO — edit/add/remove lines via the normal lifecycle ("they can change that according to the job itself"). Template edits affect FUTURE visits only; minted LOs are documents and never retro-change.
5. **Skipped visits mint nothing** (`job_id: null` — no job, no materials). **Cancel/reschedule falls out of §14:** open LO → CANCELLED, processed → RETURNED; re-scheduling the freed slot mints a fresh LO from the then-current template.
6. **Permissions:** template editing = `update ServicePlan` (existing). Instantiation is a system side-effect of plan configuration — the scheduling actor does NOT need a LogisticOrder create grant.
7. **Dead catalog refs at mint** (item SetNull'd since the template was authored): skip the line, append a notice to the minted LO's notes.
8. **UI (v1, admin+sales focus per §12):** "Default materials" repeatable-row section in `PlanBuilderDialog` (beside Line items, `ServicePlansPage.tsx:315-331`) using the same tracked-item picker as the LO line editor; read-only materials block in `PlanDetailSheet` (near :383-388). **Deferred:** materials on `ServicePlanTemplate` (plan-from-template flow) — plan-level only in v1; a visits/LO listing inside the plan sheet (the minted LO is reachable via the job's Logistics tab and the Inventory LO list).

**Builder schema note:** `LogisticOrder` gains `service_plan_id?` (SetNull) as a sixth anchor; numbering precedence unchanged (job remains most specific). Migration additions follow the §13 / build-readiness checklist (IF-NOT-EXISTS, RLS, grant strip, indexes on the new FK).
