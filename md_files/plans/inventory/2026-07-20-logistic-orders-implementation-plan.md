# Logistic Orders v1 — Implementation Plan

**Date:** 2026-07-20 · **Status:** READY TO BUILD
**Sources (read both before starting):** `2026-07-20-logistic-orders-spec.md` (WHAT — fully signed, §11–§15) · `2026-07-20-lo-build-readiness.md` (WHERE — every file:line precedent). This document is the HOW: order of work, per-PR scope, edge-case matrix, test plan, QA plan.

**Prerequisites:**
- PR **#859** (pool-starvation + per-line delete auto-return, commit `73a536b3`) — ✅ **MERGED to staging 2026-07-20** (merge commit `4c15e81e`). All LO work branches from staging at or after that commit.
- Worktree per convention: `git worktree add ../alpha_crm-worktrees/<branch> -b <branch> origin/staging` — copy BOTH `backend/.env` and `frontend/.env`.
- **Never `prisma migrate dev` from a worktree** (local .env = live staging DB). Hand-write migration SQL; CI migration-check + Render `migrate deploy` apply it.
- No AI attribution in any git artifact (CLAUDE.md rule 8).

**Former micro-flags — BOTH RESOLVED (Ran 2026-07-20, post-plan):**
1. Number format `LO-J00042-1` — ✅ **CONFIRMED.** Build exactly as specified.
2. DISPATCHER role defaults (create/read/update/process/cancel) — ✅ **CONFIRMED KEPT.**

**Zero open decisions remain. The plan is fully locked.**

---

## 0. PR train (5 PRs, each independently green on staging)

| PR | Name | Contents | Depends on |
|---|---|---|---|
| **LO-1** | Foundations | Migration (ALL schema for the whole program, incl. plan materials), Prisma models, numbering allocators, CASL wiring + seeding | #859 merged |
| **LO-2** | Backend API | LO CRUD + lifecycle + processing + unwind + document-verb integration + notifications + movements filter | LO-1 |
| **LO-3** | Frontend LO surfaces | LO list / detail / editor / picker, Job Logistics fold-in, Invoice tab, cancel-dialog LO rows | LO-2 |
| **LO-4** | Legacy retirement flip | featureDisabled on sync routes, deduct-on-add removal, C2 qty freeze, NOT_TRACKED stamps, frontend retirement + relocations, ~48-test rewrite | LO-3 (one coordinated flip — UI must never offer buttons that 404) |
| **LO-5** | Service-plan materials | `instantiatePlanMaterials` in scheduleVisit + PlanBuilderDialog "Default materials" + PlanDetailSheet block + adjustment reason presets | LO-2 (backend), LO-3 (picker reuse) |

Rationale for the split: LO-1/LO-2 are additive (both stock models coexist, legacy paths untouched — safe to merge early). LO-4 is the behavior flip and carries the whole test-fallout cost in one reviewable unit. LO-5 is independent of the flip.

Every PR: staging first; `main` promotion only via the QA-sheet gate after the Phase QA re-run (§6). Delete merged branches.

---

## 1. PR LO-1 — Foundations

### 1.1 Migration (one file, template = `20260717050000_inventory_p4_assets`)

Follow the build-readiness §1 checklist item by item. Contents:

1. Enum `LogisticOrderStatus` = `DRAFT | PENDING_APPROVAL | APPROVED | PROCESSED | CANCELLED | RETURNED` (guarded `DO $$ … pg_type` block). **RETURNED is in from day one** (spec §14 H1).
2. `logistic_orders`: id, organization_id (RESTRICT), `number` + `@@unique([organization_id, number])`, `seq INT NULL` (per-anchor sequence; NULL for standalone), status, six anchor FKs ALL `SET NULL` — `job_id, invoice_id, estimate_id, lead_id, customer_id, service_plan_id` — notes, created_by, submitted_at/by, approved_at/by, processed_at/by, cancelled_at, cancelled_reason, timestamps. Indexes: org, status, each anchor FK.
3. `logistic_order_lines`: id, organization_id, logistic_order_id (CASCADE), item_id → PriceBookItem (SET NULL), item_sku/item_name snapshots, `qty DECIMAL(10,2)`, from_location_id → InventoryLocation (SET NULL, nullable), sequence. Indexes: org, LO, item.
4. `service_plan_material_lines`: id, organization_id, service_plan_id (CASCADE), item_id → PriceBookItem (SET NULL), item_sku/item_name snapshots, `qty DECIMAL(10,2)`, position. (Snapshots so a SetNull'd item still renders in the builder with a "removed from catalog" hint.)
5. `stock_movements`: `ADD COLUMN IF NOT EXISTS logistic_order_id / logistic_order_line_id UUID` + pg_constraint-guarded SET NULL FKs + indexes (byte-for-byte the `job_line_item_id` precedent, p0:40-113).
6. `organizations`: `logistic_order_prefix` default `'LO'`, `logistic_order_next_number` default 1, `logistic_order_first_issued_at`.
7. RLS on all three new tables: ENABLE + FORCE, `DROP POLICY IF EXISTS` → `CREATE POLICY "tenant_isolation"` (p4:108-120 body), plus pg_roles-guarded `REVOKE ALL FROM anon/authenticated`.
8. role_permissions seeding for existing orgs: DEFAULT_GRANTS-style cross-join with NOT EXISTS/ON CONFLICT (generate via `npx tsx src/scripts/check-role-permission-drift.ts --emit-sql` after editing defaultGrants).
9. Portable + idempotent throughout (runs on vanilla postgres:16 AND twice on staging).

**Acceptance:** CI migration-check green; `prisma validate` green; `npx prisma migrate diff` between schema and migration is empty.

### 1.2 Numbering

- `numbering.ts`: `Entity` union + `FIELDS` gain `logistic_order`. **Self-heal subquery for this entity excludes anchored rows:** `WHERE number NOT LIKE '%-%'` (readiness §2 — anchored trailing digits would bump the flat counter).
- New `allocateAnchoredNumber(tx, { org, anchorTable, anchorId, anchorNumber })` in `lib/numbering.ts`: in-tx `SELECT … FOR UPDATE` on the **anchor row**, `MAX(seq)+1` over `logistic_orders WHERE <anchor FK> = anchorId`, returns `{ number: \`LO-${anchorNumber}-${seq}\`, seq }`. `@@unique(org, number)` is the race backstop — no retry loop. Written generically enough that the estimate-renumbering session can reuse it (spec §11 build note c).
- Anchor precedence for the number (most specific wins; the rest stay plain links): **job > invoice > estimate > lead > customer > service_plan**. No anchors → flat `allocateNumber` → `LO00001`.
- **Mint-once:** number + seq stamped at creation, immutable; re-linking never renumbers.

**Tests (unit, this PR):** flat allocation + self-heal exclusion (seed an anchored `LO-J00001-7` row, assert flat counter unaffected); anchored seq 1→2→3 per anchor; two anchors on different jobs don't share a sequence; precedence pick; seq persists as int (create -1 … -10, assert numeric ordering by `seq` not string sort).

### 1.3 CASL (readiness §4, all 10 points)

- `catalog.ts`: Subject += `LogisticOrder`; Action += `submit`, `process` (**`approve` stays OUT — capability-only**, mirrors `location_restricted`).
- `defaultGrants.ts`: ADMIN implicit full (short-circuit); SALES create/submit/read; DISPATCHER create/read/update/process/cancel; **NO TECHNICIAN grant in v1** (spec §12 signed — re-add with the new tech app).
- `userCapabilities.ts`: `approve` LogisticOrder, org-wide (no ownCondition), `impliesRead: true`. Pre-wire `process` capability row for the future tech-van hook (dormant).
- `scopeWhereFor.ts`: `ScopeResource` += `'LogisticOrder'`.
- `roleViewModel.ts`: MODULES += `{ subject: 'LogisticOrder', label: 'Logistic Orders' }`.
- Frontend `lib/ability.ts`: AppSubject/AppAction extended (ships in LO-1 to keep types in one place; unused until LO-3).

**Acceptance:** role matrix renders the new module; UserPermissionsDialog shows the Approve toggle automatically; drift script reports zero drift after the seeding migration.

---

## 2. PR LO-2 — Backend API

New files: `backend/src/controllers/logistic-order.controller.ts`, `routes/logistic-order.routes.ts`, `lib/logisticOrders.ts` (shared: `returnProcessedLo`, `processLogisticOrder`, `instantiatePlanMaterials` lands here in LO-5).

### 2.1 Routes & schemas

| Route | Guard | Notes |
|---|---|---|
| `GET /api/logistic-orders` | `canDo('read','LogisticOrder')` + `scopeWhereFor` | filters: `status`, `job_id`, `invoice_id`, `service_plan_id`, `q` (number/notes) |
| `POST /api/logistic-orders` | create | body: optional anchors (org-scope-validate EVERY anchor id), notes, lines[]. Mints number in-tx. Status DRAFT |
| `GET /:id` | read | includes lines + anchor summaries (numbers for links) |
| `PATCH /:id` | update | `{ notes?, cancelled_reason?, lines? }` — lines[] is a full-replace diffed server-side (see 2.3) |
| `POST /:id/submit` | submit | DRAFT → PENDING_APPROVAL; notify approvers |
| `POST /:id/approve` | approve capability | PENDING_APPROVAL → APPROVED; notify creator |
| `POST /:id/process` | process | APPROVED → PROCESSED. **Fast-forward:** if caller holds approve, accepts DRAFT/PENDING_APPROVAL too, stamping submitted/approved/processed `*_at/by` all with now+actor (§12 rec 1); suppress notifications on the straight-through path |
| `POST /:id/cancel` | cancel | DRAFT/PENDING_APPROVAL/APPROVED → CANCELLED (never from PROCESSED — document verbs own that unwind). `cancelled_reason` optional |
| `DELETE /:id` | delete (ADMIN default) | PROCESSED → `returnProcessedLo` first, then delete, one tx (before-delete ordering per commit `73a536b3`) |

All controllers: `tenantWhere(req)` spread into every where/data. Zod + `validate()` per house pattern. Line rules at write time: item must exist and be `track_inventory: true` **at add time** (SetNull later is tolerated); qty > 0; `from_location_id` nullable on DRAFT but org-scope-validated when present.

### 2.2 Processing (`processLogisticOrder`) — readiness §5 verbatim

- **Pre-tx** (global client): load LO + lines, status guard, `orgBlocksNegativeStock`, batch `resolveItemsById`, validate every line's `from_location_id` present + org-scoped (422 with per-line detail if any line lacks a location or its item was SetNull'd), build actor string.
- **In-tx** (tx client everywhere — pool-starvation discipline):
  1. Atomic status claim: `updateMany({ where: { id, status: <expected>, …tenantWhere } })`, count 0 → 409 `STALE_STATUS` (concurrent-process guard).
  2. Block mode: aggregate pre-check over all balances → throw `AggregateShortageError` with `details[]` (item, location, requested, onHand) → 409, nothing deducted. Per-line conditional-atomic decrement still backstops races.
  3. Per line sequentially: `applyStockMovement(tx, { type:'consume', … })` — inherits low-stock alerts, negative policy, ledger snapshots. Stamp `logistic_order_id`, `logistic_order_line_id`, `job_id` from the LO's job anchor, `reference = <LO number>`.
  4. Warn mode: collect `{ onHandAfter, shortage }` per line into the 200 payload (frontend toasts via the relocated `toastStockWarning`).
- `occurred_at` = processing time (settles the date axis; the `service_date` snapshot idea stays PARKED, spec §11 note).
- Notifications fire AFTER the tx, never try/catch-wrapped inconsistently (`inventoryEmit` pattern).

### 2.3 PROCESSED line-ops (M5 table, server-side diff inside PATCH)

When PATCHing a PROCESSED LO's lines, diff against existing by line id, one tx:

| Op | Stock effect |
|---|---|
| qty increase | consume delta (block-mode applies) |
| qty decrease | return delta |
| remove line | return full qty |
| add line | consume full qty (block-mode applies) |
| location change | return old location + consume new (block-mode applies to the consume side) |
| item swap on an existing line | **400 rejected** — delete + re-add |

Reuse the tested delta semantics from job-lines/invoice-lines (returnSyncedLines-style loop for the return side); movements carry the LO stamps + `reference = "<LO number> edited"`.

### 2.4 `returnProcessedLo(tx, lo)` — THE single unwind (H1)

Compare-and-set: `updateMany({ where: { id, status:'PROCESSED' }, data: { status:'RETURNED' } })`; count 0 → no-op return. Then one `return` movement per line (LO stamps, `reference = "<LO number> returned"`). **Every unwind path calls this and only this** — CAS makes multi-anchor double-return structurally impossible.

### 2.5 Document-verb integration (C1 — edits to existing controllers)

| Verb | Site | Added behavior (same tx) |
|---|---|---|
| Job cancel | `job.controller.ts` ~:2282-2448 | PROCESSED LOs anchored to job → `returnProcessedLo`; open LOs → CANCELLED. Cascade-voided invoices' LOs are covered by the CAS (no special-casing) |
| Job delete | `job.controller.ts` ~:1452-1480 | same as cancel, before the cascade; LO survives unanchored (SetNull) as a historical document |
| Invoice void | `invoice.controller.ts` ~:1285 | PROCESSED LOs anchored to invoice → `returnProcessedLo`; open LOs left alone (still valid intent) |
| Invoice delete (DRAFT) | `invoice.controller.ts` ~:1068 | same as void |

Plus: **no LO status transition is legal when the anchored job is CANCELLED** (L3 — guard in submit/approve/process/cancel mirroring `job-lines.controller.ts:669`). A DRAFT invoice surviving job-cancel keeps its LO (L5 — explicit test).

### 2.6 Movements & notifications

- `listMovementsQuerySchema` += `logistic_order_id`; where-builder clause like `job_id`. `movementInclude` + `mapMovement` + usage-report select gain the `logistic_order` join (H2 — job AND invoice attribution must survive in the usage report and Action log).
- Notifications (readiness §7): TEMPLATES entries under category INVENTORY; submit → approve-grant holders (`userPermissionOverride` query ∪ ADMINs via `loadRoleHolders`), INTERRUPT + needs_action; approve → creator. Suppressed entirely on the fast-forward path.

### 2.7 LO-2 tests (TDD, red-first, revert-checked per house rule)

New suites (mock-prisma harness per existing inventory suites):
- `logistic-orders.test.ts` — CRUD, anchor validation (cross-org anchor id → 404), numbering integration (anchored + flat + precedence), lifecycle legal/illegal transitions (full matrix incl. RETURNED terminal, CANCELLED terminal), fast-forward stamping (all six `*_at/by` set), cancel-from-PROCESSED rejected, permissions (SALES submit ok / approve 403; capability grant flips it; scopeWhereFor applied on list).
- `logistic-orders-processing.test.ts` — happy path movements with all stamps; multi-location same-item lines; block-mode `AggregateShortageError` 409 with per-line details and ZERO movements written; warn-mode negative + payload warnings; missing from_location 422; SetNull'd item 422; CAS 409 on stale status; low-stock alert fires (inherits `applyStockMovement`); balance-before-movement ordering via `invocationCallOrder`.
- `logistic-orders-unwind.test.ts` — `returnProcessedLo` CAS idempotency (call twice inside one tx → one set of return movements); job cancel with mixed statuses (PROCESSED→RETURNED + returns, DRAFT/APPROVED→CANCELLED); job+invoice multi-anchor LO in a cancel-cascade-void tx returns ONCE; invoice void/delete verbs; job delete verb + SetNull orphan survives; L3 cancelled-job transition guard; L5 draft-invoice-survives case; PROCESSED PATCH diff table (all six ops incl. item-swap 400).
- `inventory-tx-connection-isolation.test.ts` — extend the distinct-tx-spy harness to `processLogisticOrder` and `returnProcessedLo` (no global-prisma calls inside tx).
- Notifications: emit-after-tx assert, recipient resolution (override ∪ admins), straight-through suppression.

---

## 3. PR LO-3 — Frontend LO surfaces

New: `frontend/src/lib/api/logisticOrders.ts` (TanStack Query hooks; query keys `['logistic-orders', orgScopedFilters]`), `frontend/src/components/inventory/lo/` — **three real components** (§12 rec 9):

1. **`LOList`** — one table component re-anchored by props (`{ jobId? | invoiceId? | servicePlanId? }`). Columns: number, status badge, anchor link, line count, total units, created/processed dates. Status **filter chips** with a pending-approval chip + badge count (Inventory `ViewTab` `highlight` pattern) — NOT a separate approvals surface.
2. **`LODetailSheet` / editor** (doubles as standalone create — one screen, zero anchor UI on standalone): header (number, status, anchor links, actor trail), line editor, action buttons, cancel. **One primary action per state and permission:** grant holder on own DRAFT sees a single **Process** button (fast-forward endpoint); non-holders see **Submit for approval**. Post-processed edits show the delta hint before commit ("Saving returns 2 to Main Warehouse"). Print view DEFERRED.
3. **`LOLinePicker`** — tracked-only item search (**do NOT reuse `searchItems` blindly — its select omits `track_inventory`**; extend or add a param) + per-location on-hand display (SALVAGE AddLineDialog's per-location fetch, `AddLineDialog.tsx:502-514`). Line defaults: qty 1; `from_location` inherits the previous line, line 1 via `stockLocationMemory.ts` session memory → `org.default_inventory_location_id` → first location; every line keeps its override select.

Placements:
- **Inventory module:** "Logistic Orders" tab (list + create standalone + pending badge on the tab).
- **Job page:** fold `LOList` into the EXISTING **Logistics tab as its top section** (`JobDetailPage.tsx:1319`) — no 10th tab. Create pre-anchored to the job.
- **Invoice detail:** Logistic Orders tab (covers standalone invoices). Estimate/lead/customer: schema links only, NO tabs (signed).
- **CancelJobDialog** (`CancelJobDialog.tsx:36` — one component, used from JobDetailPage + SchedulePage): add LO rows — per LO: number · status badge · aggregated consequence ("returns 12 units") · one closing sentence "Processed orders return their stock automatically." Keep the legacy "N synced item(s) will be returned" row while any SYNCED line exists (H3). No per-line lists, no checkboxes.
- **H3 notice:** LO create/edit on a job that still has legacy SYNCED lines shows a one-line notice listing them.

Shortage UX: 409 `AggregateShortageError` renders per-line detail; relocate `extractShortage`/`toastStockWarning` out of `SyncStockDialog.tsx` into `frontend/src/lib/stockToasts.ts` (or similar) **in this PR** — LO-4 deletes their old home.

Design system: tokens only (no raw hex/palette classes); **Process/Submit = `business` (sage) variant** (forward-motion CTA per CLAUDE.md); status badges via existing badge patterns; cards `rounded-card shadow-card border-border`; Manrope defaults. v1 audience = ADMIN + SALES desktop; **do not touch the tech mobile UI**.

**Frontend tests:** `lo-list.test.tsx` (chips filter, pending badge, ability-gated create), `lo-detail.test.tsx` (one-primary-action per state/permission matrix, delta hint on processed edit, shortage 409 rendering), `lo-line-picker.test.tsx` (tracked-only, location inheritance chain, qty default), cancel-dialog rows (mixed statuses + legacy row).

---

## 4. PR LO-4 — Legacy retirement flip (one coordinated PR)

Backend:
1. `featureDisabled` union += `'line_stock_sync'`; mount on the four sync routes (`job.routes.ts:60-61`, `invoice.routes.ts:47-48`). Handlers stay dormant.
2. Remove deduct-on-add blocks (`job-lines.controller.ts:280-310`, `invoice-lines.controller.ts:341-353`); drop `stock_location_id` from both add-line schemas (pre-release API break — fine).
3. **C2 freeze (SIGNED):** qty edits on `stock_status='SYNCED'` lines → 400 `LEGACY_STOCK_LINE` in BOTH qty-delta controllers. Price/description/tax edits and delete-with-auto-return STAY. The four restricted-tech addLine/sync seams die; the two qty-delta van-enforcement sites die WITH the freeze (frozen lines can't change qty at all). Keep: `inv-locations.controller.ts:274` my-van flag + `location_restricted` capability rows.
4. **All new lines stamp `NOT_TRACKED`** (era marker — kills misleading UNSYNCED stamps): estimate→job copy `job.controller.ts:1110`, `buildOwnedLineCreates` `invoice.controller.ts:184-196`, both add-line paths. Job→invoice NOT_TRACKED copy rule stays.

Frontend (M1/M2 checklists in build-readiness — work through them line by line):
- Delete: sync API fns (`api/jobs.ts:209-226`, `api/invoices.ts:127-141`), `SyncStockDialog.tsx` (exports already relocated in LO-3), sync buttons/toasts in both line editors, AddLineDialog stock section (state/payload/van pre-resolution), `CreateJobInvoiceDialog.tsx:65` nudge, `JobDetailPage.tsx:758` completion toast, estimate editor's inherited no-op "Deduct from" select (fixes a pre-existing lie).
- `TechItemsTab.tsx` van-deduct branch reduces to plain add-billing-line; fix its copy (currently promises deduction). This is a code reduction, not a redesign — tech UI otherwise untouched.
- **SYNCED pills** (`StockStatusChip` via `LineItemRow.tsx:219-249`): remove — legal ONLY because the C2 freeze lands in the same PR. KEEP the truthful legacy copy: `JobDetailPage.tsx:1067` delete-confirm, `InvoiceDetailPage.tsx:527` void copy, both editors' delete toasts.

Tests (~48 die/rewrite — budget a full day; per-suite table in build-readiness §3):
- Each dead route → ONE 404 `FEATURE_DISABLED` test.
- Deduct-on-add tests → replaced by "add line writes NO movement + stamps NOT_TRACKED" asserts.
- New freeze tests: SYNCED qty edit → 400 `LEGACY_STOCK_LINE` (both controllers); price edit still 200; delete still auto-returns (**re-run the keeper suites — qty-delta :481/:385 partially convert to freeze asserts, DELETE auto-return :583/:467 keep verbatim**).
- Van-restriction suite: :274/:397/:447 die; :535 converts to freeze asserts.
- Frontend dead tests: `add-line-dialog-van.test.tsx`, `tech-items-tab.test.tsx` (van bits), `job-items-editor.test.tsx:658-708` payload asserts, SYNCED-messaging asserts in `invoice-line-items-editor/invoice-detail-page/job-detail-page` tests.
- **Revert-check the freeze**: revert the guard, watch the new 400 tests go red (placebo-test learning).

---

## 5. PR LO-5 — Service-plan materials + adjustment presets

Backend (spec §15):
1. `instantiatePlanMaterials(tx, plan, job, actor)` in `lib/logisticOrders.ts`: no material lines → no-op; else mint ONE LO — status DRAFT, anchors `job_id` + `service_plan_id`, number `LO-J…-n` (job precedence), lines = snapshot sku/name + qty, `from_location_id` null, `created_by` = scheduling actor, notes reference the plan. **Dead catalog refs (item SetNull'd since authoring): skip the line, append a notice to the LO's notes.** Never auto-processed.
2. Call it inside the `scheduleVisit` tx (`service-plan.controller.ts:513-588`), after job + PlanVisit create. The future auto-generation cron calls the same function — leave a pointer comment only if the file convention has them; otherwise the shared function IS the contract.
3. ServicePlan CRUD gains `material_lines[]` (create/update full-replace, mirroring `ServicePlanLineItem` handling). Template editing = `update ServicePlan` — instantiation needs NO LogisticOrder create grant (system side-effect).
4. **Adjustment reason presets (§8 as amended by §12 rec 3):** backend keeps/enforces non-empty `reason` on `set-quantity`; frontend dialog offers the fixed list `Cycle count / Damaged / Used on job / Returned to vendor / Lost or stolen / Other` + note field (note required only for Other, composed into the reason string).

Frontend:
- `PlanBuilderDialog`: "Default materials" repeatable-row section beside Line items (`ServicePlansPage.tsx:315-331` pattern), reusing `LOLinePicker`'s item search (qty only — no location at template level).
- `PlanDetailSheet`: read-only materials block (near :383-388), with "removed from catalog" hint on SetNull'd items.
- DEFERRED (signed): materials on `ServicePlanTemplate`; visits/LO listing inside the plan sheet (minted LO reachable via job Logistics tab + Inventory list).

Tests:
- `service-plan-materials.test.ts` — scheduleVisit with materials mints exactly one DRAFT LO with correct anchors/number/lines/actor, inside the SAME tx (tx-spy); no materials → no LO; dead-ref line skipped + notes appended; skipped visit (`job_id: null` path) mints nothing; template edit does NOT touch previously minted LOs; visit-job cancel → minted LO CANCELLED (open) / RETURNED (processed) via the LO-2 verb tests' machinery; re-scheduling a freed slot mints a fresh LO from the then-current template.
- Plan CRUD material_lines round-trip; `PlanBuilderDialog` section test (add/remove rows, qty validation); PlanDetailSheet render.
- Adjustment presets: frontend dialog test (Other requires note); backend reason-required already covered.

---

## 6. Edge-case matrix (every row = at least one automated test; ✓QA = also in the manual QA script)

| # | Case | Expected | PR |
|---|---|---|---|
| E1 | Concurrent process of same LO | one 200, one 409 STALE_STATUS (CAS) | LO-2 |
| E2 | Block-mode shortage on line 3 of 5 | 409 aggregate detail, ZERO movements ✓QA | LO-2 |
| E3 | Warn-mode multi-line shortage | 200 + per-line warnings, negative balances ✓QA | LO-2 |
| E4 | Same item, two lines, two locations | two consume movements ✓QA | LO-2 |
| E5 | Process with a null from_location line | 422 per-line detail, nothing moved | LO-2 |
| E6 | Item SetNull'd between add and process | 422, names the snapshot sku | LO-2 |
| E7 | Job cancel: PROCESSED + DRAFT LOs + legacy SYNCED lines | RETURNED+returns / CANCELLED / legacy returns; dialog shows all three ✓QA | LO-2/3 |
| E8 | Job+invoice multi-anchor LO inside cancel-cascade-void | returned ONCE (CAS) | LO-2 |
| E9 | Invoice void on completed job's PROCESSED LO | RETURNED + stock back ✓QA (the C1 stranded-stock case) | LO-2 |
| E10 | Job delete with PROCESSED LO | returns, LO survives unanchored (SetNull) | LO-2 |
| E11 | DRAFT invoice survives job cancel | its LO untouched; unwound later by invoice's own verb | LO-2 |
| E12 | Any LO transition on a CANCELLED job | 409/400 rejected | LO-2 |
| E13 | Delete PROCESSED LO | return first, then delete, one tx | LO-2 |
| E14 | PROCESSED PATCH: all six line-ops | M5 table incl. item-swap 400 ✓QA (qty edit) | LO-2 |
| E15 | Anchored numbering: 10+ LOs on one job | `-10` after `-9` (int seq, not string sort) | LO-1 |
| E16 | Flat counter after anchored rows exist | self-heal ignores `LO-…` rows; standalone sequence unbroken ✓QA | LO-1 |
| E17 | Concurrent create on same anchor | distinct seqs (FOR UPDATE serializes); unique backstop | LO-1 |
| E18 | Cross-org anchor id in create | 404, no LO minted | LO-2 |
| E19 | SALES: submit own draft / approve attempt / grant flip | 200 / 403 / 200 ✓QA | LO-2 |
| E20 | Fast-forward Process by grant holder from DRAFT | all six `*_at/by` stamped, zero notifications ✓QA | LO-2 |
| E21 | Legacy SYNCED qty edit after freeze | 400 LEGACY_STOCK_LINE; price edit 200; delete auto-returns ✓QA | LO-4 |
| E22 | Sync routes after flip | 404 FEATURE_DISABLED ✓QA | LO-4 |
| E23 | New line anywhere post-flip | stamps NOT_TRACKED, no movement | LO-4 |
| E24 | scheduleVisit with/without materials; dead ref; skip | one DRAFT LO / no LO / skip+note / nothing ✓QA | LO-5 |
| E25 | Visit-job cancel + slot re-schedule | old LO cancelled/returned; fresh LO from current template ✓QA | LO-5 |
| E26 | Usage report + Action log after LO processing | job AND invoice attribution present, LO drill-through ✓QA | LO-2 |
| E27 | Low-stock threshold crossed by LO processing | alert emits (via applyStockMovement) | LO-2 |
| E28 | Plan-visit job (NOT_BILLABLE) anchors an LO | allowed (M4 signed); billing lines still blocked | LO-2 |

---

## 7. QA plan (manual, staging = servwave-demo.vercel.app, before any main promotion)

Run as the LO scenario suite; record per-row in the QA sheet (hard promotion gate). Suggested order:

1. **Happy path budget check:** standalone LO — create → add 3 lines → Process. MUST be ~3 actions (design constraint is binding; count clicks). Verify movements in Action log with LO reference.
2. **Job flow:** create LO from job Logistics tab (pre-anchored, number `LO-J…-1`); second LO → `-2`.
3. **Approval flow:** as SALES — create + submit (approve button absent); admin sees badge + notification, approves (creator notified), processes. Grant SALES approve via UserPermissionsDialog → SALES now sees single Process button on own drafts.
4. **Shortage both modes:** org block ON → over-consume → per-line 409 dialog, stock unchanged; org block OFF → warning toast, negative balance visible.
5. **Multi-location pull** (E4) + location inheritance while adding lines (one decision for 8 lines).
6. **PROCESSED edit:** qty 5→3 shows delta hint, returns 2; delete LO returns rest.
7. **Cancel-job dialog:** job with one PROCESSED LO + one DRAFT LO + one legacy SYNCED line — dialog shows both LO rows + legacy row; confirm; verify returns + statuses.
8. **Invoice void** on a completed job with a processed LO (E9 — the historically stranded case).
9. **Legacy freeze:** on a pre-flip job with SYNCED lines — qty edit blocked with clear error, price edit fine, delete returns stock, H3 notices visible.
10. **Plan materials:** author defaults on a plan → schedule visit → DRAFT LO minted with plan+job anchors; edit it per job; skip a visit → nothing; cancel visit job → LO cancelled; re-schedule → fresh LO. Template edit affects next visit only.
11. **Numbering integrity:** after all of the above, create a standalone LO — flat sequence continuous (E16).
12. **Reports:** inventory usage report groups correctly; movement list filters by LO.
13. **Adjustment presets:** set-quantity requires a preset; Other requires note.
14. **Regression sweep:** tech mobile untouched (visual glance); estimates/jobs/invoices line editing unaffected apart from removed stock UI; role matrix + permissions dialog render.
15. **RLS/tenancy spot-check:** second org sees no LOs, cross-org anchor rejected (API check).

Exit criteria: all rows `approved` in the QA sheet → staging→main promotion PR → **re-issue the inventory release verdict (#15)**.

---

## 8. Bookkeeping on completion

- PR bodies: `Fixes #<n>` where an issue exists; staging first, main only after QA gate; never self-merge main.
- Update `memory/pipeline-status.md` (inventory stage confidence) + vault: module note Current State, Decision note (LO deduction doctrine + anchored numbering), Learning notes if anything breaks, `log.md`.
- Task ledger: #18 retired (date axis resolved) · #19 satisfied by `LOLinePicker` · #21 (delete-return) shipped via #859 · #13/#14/#20/#22 proceed unchanged alongside.
- Parked (do not build): `service_date` snapshot column · print view · attach-later re-link UI · tech Materials card + van self-serve grant hook · `ServicePlanTemplate` materials · v2 committed/available math.
