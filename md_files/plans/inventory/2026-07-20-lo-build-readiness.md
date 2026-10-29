# Logistic Orders v1 — Build-Readiness Report (migration / compat / integrity lens)

**Date:** 2026-07-20 · **Companion to:** `2026-07-20-logistic-orders-spec.md` (see its §13 for adopted decisions) · **Codebase audited:** worktree `inv-pool-fix` (staging + PR #859). All file:line refs relative to that tree.

## 1. Migration — READY. Template = the P4 assets migration

`backend/prisma/migrations/20260717050000_inventory_p4_assets/migration.sql` is the most recent new-tenant-table migration and the byte-for-byte template. RLS lives **in the migration SQL**, app scoping stays `tenantWhere(req)`.

Builder checklist (each item has cited precedent):

1. **Never `prisma migrate dev` from the worktree** — worktree `.env` points at staging (CLAUDE.md). Hand-write SQL; CI migration-check (vanilla postgres:16) + Render `migrate deploy` apply it.
2. Enum guard for `LogisticOrderStatus`: `DO $$ … IF NOT EXISTS (SELECT 1 FROM pg_type …)` — precedent `20260717032601_inventory_p0_schema/migration.sql:24-27` (StockSyncStatus).
3. `CREATE TABLE IF NOT EXISTS logistic_orders / logistic_order_lines` (p4:26, p4:66). Org FK `ON DELETE RESTRICT` (p4:100-104); anchor FKs (job/invoice/estimate/lead/customer) `SET NULL`; lines→LO `CASCADE`; `item_id`→PriceBookItem `SET NULL`.
4. StockMovement: `ADD COLUMN IF NOT EXISTS logistic_order_id / logistic_order_line_id UUID` + pg_constraint-guarded `SET NULL` FKs + `CREATE INDEX IF NOT EXISTS` — precedent p0:40-45, 79-107, 109-113 (exactly how `job_line_item_id` was added). Prisma model: `schema.prisma:1839-1882` (FK block 1864-1868, indexes 1873-1880).
5. Organizations numbering columns: `logistic_order_prefix` (default `'LO'` — NOT `'LO-'`; spec wants flat `LO00001`), `logistic_order_next_number` (default 1), `logistic_order_first_issued_at` — precedent p0:35-37 (`purchase_order_*`); `number_padding` at schema:1472 applies.
6. RLS on both new tables: `ENABLE` + `FORCE ROW LEVEL SECURITY`, `DROP POLICY IF EXISTS` then `CREATE POLICY "tenant_isolation"` with the body at p4:108-120 (bypass_rls OR current_org_id), fail-closed, inert until `DB_TENANT_GUARD=on` (p4:106-107).
7. Grant strip: pg_roles-guarded `REVOKE ALL … FROM anon/authenticated` on both tables — p4:126-135 (the dynamic sweep migration only covered tables existing at its run time).
8. role_permissions seeding for existing orgs: LogisticOrder is a NEW subject with new defaults → DEFAULT_GRANTS-style cross-join over `organizations` with NOT-EXISTS/ON CONFLICT (template `20260707130000_sync_role_permission_defaults`, generated via `npx tsx src/scripts/check-role-permission-drift.ts --emit-sql`). NOT the subject-split derivation style.
9. `@@unique([organization_id, number])` (mirrors estimates schema:463 / POs schema:1990) + indexes on org, status, each anchor FK, and the int `seq`.
10. Portable/idempotent throughout; `gen_random_uuid()` is fine (PG13+).

## 2. Numbering — flat READY, anchored is NEW CODE

- `allocateNumber` (`backend/src/lib/numbering.ts:37-66`): closed `FIELDS` record (:3-14); single `UPDATE organizations … RETURNING` under row lock — no retry loop needed. Add `logistic_order` to the `Entity` union + `FIELDS` + the three org columns → flat `LO00001` exactly like `purchase_order`. Call-site precedent: `estimate.controller.ts:884` (in-tx).
- **Self-heal trap (ADOPTED fix):** the counter self-heals via `MAX((substring(number FROM '[0-9]+$'))::int)` over ALL rows (:47-51). Anchored `LO-J00042-7` rows share the column; their trailing digit is the per-anchor seq and would bump the flat counter (gaps, never collisions). Fix: exclude anchored rows in the `logistic_order` self-heal subquery (`WHERE number NOT LIKE '%-%'`). Prior art: `learning-numbering-guard-mixed-format-crash`.
- **`allocateAnchoredNumber()` is greenfield** — no per-anchor sequence or retry precedent exists (nearest P2002 handling is catch-and-classify: `ctm-webhook.controller.ts:196-202`, `price-book.controller.ts:92`). **ADOPTED shape:** in-tx `SELECT … FOR UPDATE` on the **anchor row**, then `MAX(seq)+1` — serializes like allocateNumber's org-row lock, no retry loop. `@@unique(org, number)` is the conflict backstop; persist the int `seq` column (spec §11). `(org, anchor, seq)` uniqueness optional belt-and-braces.

## 3. featureDisabled + test fallout — READY pattern; the test delta is the real §7 cost

`featureDisabled` (`backend/src/middleware/featureDisabled.ts:6-10`) returns 404 `{ error: 'FEATURE_DISABLED', feature }`; auth runs first. **Widen its union** to add `'line_stock_sync'` or it won't typecheck. Mount precedent: `inv-stock.routes.ts:27-30` (guards dropped from the line, handlers stay for cheap un-parking).

**Exactly four routes die:** `job.routes.ts:60` (bulk sync), `:61` (single sync), `invoice.routes.ts:47`, `:48`. Dormant-but-kept: `job-lines.controller.ts:638-864` sync handlers/schemas + invoice equivalents.

**Routes that STAY (legacy-row protection):** POST add-line (loses the deduct-on-add block `job-lines.controller.ts:280-310` / `invoice-lines.controller.ts:341-353`; `stock_location_id` leaves the schemas — job-lines:83, invoice-lines:72); PATCH qty-delta; DELETE with before-delete return; job cancel/delete + invoice void/delete document verbs — all unchanged.

Per-suite fallout:

| Suite | Dies (replace each dead route with one 404 FEATURE_DISABLED test) | Keeps |
|---|---|---|
| `job-lines-stock.test.ts` | deduct-on-add deduction tests (:156,:216,:226,:245,:257); sync single :270 (9); sync bulk :396 (3) | :178/:190/:204 adapt (stamps still produced); **PATCH qty-delta :481 (6) + DELETE auto-return :583 (5) keep verbatim** — SYNCED arrange is pure mock fixture, no dead-route dependence |
| `invoice-lines-stock.test.ts` | deduct-on-add (4); sync single :257 (5); sync bulk :344 (2) | :206 adapts; PATCH :385 (5) + DELETE :467 (4) keep verbatim |
| `inventory-van-restriction.test.ts` | addLine-restricted job :274 (10), invoice :397 (4), sync forcing :447 (6) — die with QA-405 removal | qty-delta restricted :535 (5) — `location_restricted` capability stays live at the delta seams + `inv-locations.controller.ts:274` |
| `inventory-tx-connection-isolation.test.ts` | nothing | keeps entirely (its three sites stay live paths); extend the distinct-tx-spy harness to LO processing |
| `job-lines.test.ts` / `invoice-lines.test.ts` / `jobs.test.ts` / `invoices.test.ts` / `inventory-p0-shape.test.ts` | nothing | keep; check whether `addLineSchema` is `.strict()` — if not, old clients sending `stock_location_id` get silent strip (fine pre-release) |

**~48 tests die or need rewriting. The keepers (qty-delta / auto-return) must be re-run against the modified controllers to prove legacy self-neutralization.**

## 4. CASL wiring — READY. Template = the PurchaseOrder/Vendor subject split

1. `backend/src/lib/permissions/catalog.ts:1-7` `Subject` += `'LogisticOrder'`; `:9-20` `Action` += `submit`/`approve`/`process` (`cancel` exists). **`approve` stays OUT of the catalog** (capability-only, mirroring `location_restricted`, catalog.ts:18-19 — `isCatalogEntry` rejects it on the role-permission write path); `process` goes IN (DISPATCHER role default).
2. `defaultGrants.ts` — SALES: create/submit/read; DISPATCHER: create/read/update/process/cancel; TECHNICIAN: read with own-job condition `{ job: { assignees: { some: { user_id: '{{userId}}' } } } }` (mirror `OWN_INVOICE_VIA_JOB`, defaultGrants.ts:9).
3. `userCapabilities.ts:37-190` — add `approve` LogisticOrder (org-wide: omit `ownCondition` → unconditional can via `defineAbility.ts:106-108`; `impliesRead: true` so approvers see the pending list). Optionally pre-wire `process` for the future tech van-self-serve hook.
4. `defineAbility.ts` — no change (ADMIN short-circuit :59-62 covers admins-default-yes).
5. `scopeWhereFor.ts:12` — **ADOPTED:** extend `ScopeResource` with `'LogisticOrder'` for list row-scoping (vs hand-rolling the tech where-clause).
6. `roleViewModel.ts:10-20` `MODULES` += `{ subject: 'LogisticOrder', label: 'Logistic Orders' }` — role matrix shows CRUD cells only; submit/process not matrix-editable (same as Job's lifecycle verbs).
7. Seeding migration per §1.8.
8. Routes: `canDo('<action>','LogisticOrder')` per `inv-stock.routes.ts:14-21`.
9. Frontend `lib/ability.ts:3-10` `AppSubject` += `'LogisticOrder'`; `:12-25` `AppAction` += the verbs. Usage: `useAppAbility()` → `ability.can(…)` as in `InventoryPage.tsx:137-140`.
10. `UserPermissionsDialog.tsx` — zero change; the approve toggle appears automatically (renders `USER_CAPABILITIES` dynamically via `user.controller.ts:775-791`).

## 5. LO processing transaction — pattern READY; two ADOPTED decisions

**Before `$transaction`** (global client): load LO + lines + status guard; `orgBlocksNegativeStock` (:326-332); batch `resolveItemsById` (:336-347); validate every line's org-scoped `from_location_id`; build actor.

**Inside `$transaction`** (tx everywhere — pool-starvation discipline, `inv-stock.controller.ts:300-304`):
(a) atomic status claim `updateMany({ where: { id, status:'APPROVED', …tenantWhere } })`, count 0 → 409 (mirrors `decideStockApproval` :862-872);
(b) per line sequentially `applyStockMovement(tx, { type:'consume', blockNegative, … })` — balance-first-movement-last (:157-162) means block-mode ShortageError aborts before any ledger row;
(c) warn mode collects `{ onHandAfter, shortage }` per line for the 200 payload. `occurred_at = new Date()` at :250 = processing time = spec §5.

- **ADOPTED — multi-line 409 (option b):** in-tx pre-check pass over all balances → new `AggregateShortageError` with `details[]` + response fn; the per-line conditional-atomic decrement (:190-202) still backstops races. First-failure-only would degrade the signed "per-line detail."
- **Required:** `StockMovementInput` (:120-138) + create block (:248-267) gain `logisticOrderId`/`logisticOrderLineId` (thread like `jobLineItemId`); extend `movementInclude` (:49-54) + `mapMovement` (:22-44) for drill-through.
- Everything else exists: blockNegative consume-only (:160-162), Decimal-safe qty (:125), cost/actor threading.

## 6. Movements list filter — two lines

`listMovementsQuerySchema` (:525-536) += `logistic_order_id: z.string().uuid().optional()`; where-builder (:551-564) += the clause, exactly like `job_id` (:554). Index from §1.4.

## 7. Notifications — READY

- Reuse `emit()` (`services/notifications/notificationService.ts`) + `TEMPLATES` entries (`templates.ts:363+`, category `'INVENTory'` exists; `Notification.verb`/`object_type` are plain String — **no enum migration**) + `resolveRecipients` cases (`resolveRecipients.ts:81-355`). Fire AFTER the tx like `emitStockApprovalRequested` (`inv-stock.controller.ts:822-828`); never try/catch-wrapped (`inventoryEmit.ts:4-6`).
- Approve-grant holders ARE queryable: `userPermissionOverride.findMany({ where: { organization_id, subject:'LogisticOrder', action:'approve', effect:'allow' } })` (`schema.prisma:1666-1682`) ∪ ADMINs via `loadRoleHolders` (`roleHolders.ts:24-39`). Pre-resolved-recipients precedent: `automation.message` (`resolveRecipients.ts:255-263`). Submit = ADMIN INTERRUPT+needs_action + `strArr('approver_ids')` (mirror :322-326); approve = `str('created_by_id')` → creator (mirror `lead.assigned` :101-105).
- `filterByAccess.ts:21-26` has no LO type → recipients pass unfiltered (:53-56). Fine while recipients are approvers+creator (org-wide readers); revisit if technicians ever get notified (own-job read scope).

## Risks, ranked

1. **HIGH — test rewrite volume:** ~48 tests across 3 suites; budget it, and re-run the keepers against modified controllers.
2. **MEDIUM — multi-line 409:** adopted (aggregate pre-check) — build it before TDD starts; it shapes the error contract and the frontend.
3. **MEDIUM — anchored numbering greenfield:** adopted shape (anchor-row FOR UPDATE + int seq + self-heal exclusion).
4. **LOW — catalog stance:** adopted (`approve` capability-only, `process` cataloged) — settle before writing the seeding migration.
5. **LOW — `featureDisabled` union widening** required for `'line_stock_sync'`.

---

# Part 2 — Edge-case collision audit (full findings, 2026-07-20)

Spec amendments were adopted into spec §14; this part preserves the file:line evidence for the builder.

## C1 — Document verbs with no LO rule (CRITICAL, amendment adopted)

Today every destructive verb auto-returns SYNCED lines: invoice void `invoice.controller.ts:1285` (returns 1320-1343, stamps UNSYNCED) · invoice delete (DRAFT) `:1068` (returns 1088-1103 pre-delete) · job delete (UNASSIGNED) `job.controller.ts:1452-1480` (returnSyncedLines :1472 pre-cascade). Job cancel is blocked for COMPLETED jobs (`job.controller.ts:2316` — UNASSIGNED/SCHEDULED/IN_PROGRESS only), so **invoice void is the only unwind for finished work**. Job delete SetNulls `job_id`, silently orphaning a PROCESSED LO. Adopted rules in spec §14 C1; build them through the single `returnProcessedLo` (H1).

## C2 — Legacy SYNCED rows are a live consume path (CRITICAL, OPEN for Ran)

"New lines never become SYNCED" is true — the only SYNCED writers are deduct-on-add + the four sync routes (`job-lines.controller.ts:315,724,759,819`, `invoice-lines.controller.ts:585`), all retired. But legacy rows stay editable: job qty-delta consume on increase `job-lines.controller.ts:479-546` (consume 539-541; NO job-status guard on updateLine) · invoice qty-delta `invoice-lines.controller.ts:731-840` (consume 801-832; editable while DRAFT/SENT/PARTIAL per `isInvoiceEditable`, comment :526). Decreases/deletes are benign (they unwind legacy stock). Double-movement matrix: increase legacy line + office LO for the same parts = double consume (invisible — §9 cut coverage checks); decrease + LO covering same parts = phantom return. Freeze = one guard clause per controller.

## H1 — Return idempotency (adopted)

Legacy idempotency is structural: return loops filter `stock_status:'SYNCED'` + stamp UNSYNCED in-tx (`job.controller.ts:2358-2375` cascade, `2400-2417` job lines; rule documented `inv-stock.controller.ts:421-424`). LO analog = compare-and-set on PROCESSED→RETURNED. Multi-anchor hazard: job cancel cascade-voids SENT/PARTIAL invoices (`job.controller.ts:2324, 2343-2394`) AND returns job LOs — without the single guarded function, a job+invoice-anchored LO returns twice in one tx.

## H2 — Attribution (adopted)

Readers that break without stamping: usage report `report.controller.ts:544-580` (job join :561-562; NO invoice_id FK on StockMovement — `inv-stock.controller.ts:47-48`) · movements `job_id` filter `inv-stock.controller.ts:530,556` · Action log `frontend/src/components/inventory/ActionLogView.tsx:127-128, 289-301` · `mapMovement`/`movementInclude` `inv-stock.controller.ts:22-54`. Low-stock alerts safe IFF processing uses `applyStockMovement` (`emitLowStockIfCrossing` inside it, :187-224).

## H3 — Transition visibility (adopted)

`CancelJobDialog.tsx:36` shows the legacy synced-count warning today; mounted from `JobDetailPage.tsx:60` + `SchedulePage.tsx:3089` (one component). Cancel dialog shows BOTH populations; LO create/edit shows legacy-SYNCED notice.

## M1 — Retired-UI list, completed (adopted)

Beyond the spec's three: `JobDetailPage.tsx:758` completion toast "never synced" (retire) · `JobDetailPage.tsx:1067` delete-confirm "will be returned" (KEEP — true for legacy) · `CreateJobInvoiceDialog.tsx:65` unsynced nudge (retire) · `InvoiceDetailPage.tsx:527` void/delete synced copy (KEEP) · `LineItemsEditor.tsx:211-217` + `InvoiceLineItemsEditor.tsx:215-221` delete toasts (KEEP) · `AddLineDialog.tsx:741-743` edit hint (retire only WITH the C2 freeze). **Pill rule:** `StockStatusChip` (via `LineItemRow.tsx:219-249`) is the only edit-moves-stock signal — remove only together with the C2 freeze, else keep on legacy SYNCED rows.

## M2 — Frontend blast radius (adopted build checklist)

API fns to delete: `frontend/src/lib/api/jobs.ts:209-226`, `frontend/src/lib/api/invoices.ts:127-141`. `SyncStockDialog.tsx`: retire, but FIRST relocate its exports `extractShortage`/`toastStockWarning` (consumed by `LineItemsEditor.tsx:63-65`, `InvoiceLineItemsEditor.tsx:68-70`, `TechItemsTab.tsx:36`; still needed for legacy qty-delta + LO shortage errors). Job editor: `LineItemsEditor.tsx:129, 157-186, 287, 381, 411` · `LineItemsTable.tsx:156, 286, 398` · `LineItemRow.tsx:65, 87, 221, 249`. Invoice editor: `InvoiceLineItemsEditor.tsx:145, 154, 170-190, 274-286, 362, 392`. AddLineDialog stock section: state 319-348, van pre-resolution 467-472, **per-location on-hand fetch 502-514 (SALVAGE for the LO picker)**, payload 615-618, session memory 678 (`stockLocationMemory.ts` — repurpose for LO from-location default). Mobile: `TechItemsTab.tsx` van-deduct branch (header 1-18, vanOnHand 111-113, payload 164, restricted-lock UI) reduces to plain add-billing-line; copy currently promises deduction. Free win: `EstimateLineItemsEditor.tsx:53` reuses AddLineDialog → estimates today show a **silent no-op** "Deduct from" select (estimate schema has no stock_location_id — zod strips it); removal fixes a pre-existing lie.

## M3 — Restricted-tech sites (adopted)

`resolveRestrictedVan` (`inv-stock.controller.ts:395-407`) call sites — die with seams: `job-lines.controller.ts:294`, `:676`, `invoice-lines.controller.ts:351-357`, `:537`. MUST survive unless the C2 freeze lands: `job-lines.controller.ts:500`, `invoice-lines.controller.ts:755` (qty-increase van enforcement). Keep: `inv-locations.controller.ts:274` my-van `restricted` flag (vestigial in v1; §11 QA-405-replacement hook) + `location_restricted` capability rows (`userCapabilities.ts:178-183`, `catalog.ts:20`). Tests: `inventory-van-restriction.test.ts` :274/:397/:447 die; :535 survives (or converts to freeze assertions). `inventory-my-van.test.ts` survives. Frontend `add-line-dialog-van.test.tsx`, `tech-items-tab.test.tsx` die; `job-items-editor.test.tsx:658-708` payload asserts die.

## M4-M6, L-items

M4 plan-visit jobs: `NOT_BILLABLE` guard (`job-lines.controller.ts:59-60`, enforced :262,:396,:455,:579,:663) means plan visits can never have legacy SYNCED lines (clean); nothing stops LO anchoring; job cancel already frees the PlanVisit slot (`job.controller.ts:2443-2448`) in the same tx. OPEN for Ran (recommend ALLOW). · M5 PROCESSED line-ops table adopted (spec §14). · M6 stamps: estimate→job `job.controller.ts:1110` + `buildOwnedLineCreates` `invoice.controller.ts:184-196` kept stamping UNSYNCED → adopted: all new lines NOT_TRACKED; job→invoice NOT_TRACKED rule (`job.controller.ts:3128-3136`) STAYS. · L3 no LO transition on a CANCELLED job (mirrors `job.controller.ts:2396-2399`, `job-lines.controller.ts:669`). · L4 tech read grant is API-only in v1. · L5 DRAFT invoices survive job cancel un-voided (`job.controller.ts:2322-2324`) — LO unwound later by its own verb; §10 test case. · L6 additional test fallout: SYNCED-fixture messaging asserts in `invoice-line-items-editor.test.tsx`, `invoice-detail-page.test.tsx`, `job-detail-page.test.tsx`.
