# Emanuel Modules — Unified Persisted Integration (Design Spec)

**Date:** 2026-06-01
**Branch:** `feat/emanuel-design-system` (worktree `../alpha_crm-worktrees/feat-emanuel-design-system`)
**Status:** Draft for review
**Author:** synthesized with RAN (decisions captured inline)

---

## Goal

Make the ported **Inventory** and **Communication** modules run on **real, persisted, unified data** in the ALPHA database — seeded from Emanuel's rich mock data — so the whole app is alive and internally consistent when reviewed. As part of this, **merge Emanuel's catalog/price-book model with ALPHA's existing (empty) price book into one model**, and repoint Estimates at it.

## Architecture (one paragraph)

For each module we add backend Prisma models, `/api/*` routes (read + CRUD), and a backend CASL subject, then replace the frontend seam's `USE_MOCK = true` with real HTTP calls. A single **unified seed script** transforms Emanuel's `_mock/{inventory,communication}/*` arrays into real rows in **one demo organization on the staging database**, mapping his phone-customers → `Customer`, techs → `User` (staff), and jobs → `Job`, so module records foreign-key to the same entities the core CRM uses. The existing `PriceBookItem`/`PriceBookCategory` models are replaced by a unified **`CatalogItem`/`CatalogCategory`** model (a superset), and `EstimateLineItem.price_book_item_id` is repointed to it.

## Tech Stack

Prisma + PostgreSQL (Supabase), Express + TypeScript controllers, Zod validation, CASL RBAC, TanStack Query seam on the frontend. No new infrastructure.

---

## Decisions locked with RAN

| # | Decision |
|---|----------|
| D1 | **Unified data** — Emanuel's entities map onto real ALPHA `Customer`/`User`/`Job`; module records FK to them. |
| D2 | **Both modules** wired before review (not one-at-a-time). |
| D3 | **Merge the price-book model now** — do not defer. ALPHA's existing price book is **empty**, so this is a clean structural change, not a data migration. |
| D4 | **Target = one demo org on the staging DB.** Never prod (B&G live data lives there). |

## Non-goals (explicitly deferred this round)

Building the *display + CRUD + unified seed* is the whole scope. We are **not** building:

- **Communication:** any telephony provider (CallTrackingMetrics/Twilio), 10DLC registration, the compliance/consent engine, live STT/transcription, or live AI disposition/booking. We seed and **display** calls/texts/threads/voicemails; we do not place or receive real ones.
- **Inventory:** vendor EDI/portal feeds, barcode/serial scanning hardware, AI auto-categorize, real stock-movement posting side effects, or AP/3-way-match.
- **Price book:** the PRD's advanced pricing **engine** — versioning (`price_book_version`), markup-rule tiers, customer/contract/membership overrides. The unified model carries `unit_cost` + `sell_price` + an optional `list_price` (the fields the ported UI and Estimates actually use); the engine is a later track.
- Any write-back from these modules into production data.

These deferrals are what make "two huge modules" tractable as a single persisted-demo build.

---

## 1. Target environment & safety

- All work on `feat/emanuel-design-system`; promote to `staging` only after review; never to `main`/prod directly.
- **Seed target:** a single dedicated demo organization in the **staging** Supabase project. The implementation plan's first task is to **verify row counts** on staging (`price_book_items`, `price_book_categories`) to confirm the "empty price book" assumption before the migration runs, and to confirm/create the demo org id.
- The seed is **idempotent and org-scoped** — re-runnable, and it only ever writes to the demo org. It must refuse to run against a `DATABASE_URL` that looks like prod (guard on org id / a `SEED_DEMO=true` env gate).

## 2. Price-book unification (the structural change)

**Current state:** `PriceBookItem` (name, description, image_url, type `SERVICE|MATERIAL`, category_id, unit_cost, unit_price, taxable, is_active, sort_order, org_id) and `PriceBookCategory` (self-parenting tree). `EstimateLineItem.price_book_item_id` → `PriceBookItem.id`; the Estimate form picker calls `GET /api/price-book/items/search` and snapshots `unit_price`/`unit_cost`/`is_taxable`/`image_url`/`item_type` onto the line. **The table is empty.**

**Target model — `CatalogItem`** (replaces `PriceBookItem`; superset of Emanuel's `Item` + the old fields):

- Identity/catalog: `sku`, `mpn?`, `upc?`, `name`, `description?`, `category_id?`, `brand_id?`, `trade?`, `kind` (enum — supersedes `type`; maps to the old `SERVICE|MATERIAL` for estimates), `uom`, `status`/`is_active`.
- Pricing (what Estimates consume): `unit_cost?`, `sell_price` (= old `unit_price`), `list_price?` (customer-facing override), `taxable`.
- Inventory-only: `serialized`, `hazmat`, `photo_url?`, `visibility` (`catalog|internal_only`), `customer_name?`, `customer_description?`, `key_features?` (Json).
- `organization_id`, timestamps, `sort_order`.
- Relations: `category` → `CatalogCategory`, `brand` → `Brand`, `line_items` → `EstimateLineItem`, plus inventory relations (`stock_balances`, `movements`, …).

**`CatalogCategory`** replaces `PriceBookCategory` (same self-parenting tree shape, renamed).

**Estimate repoint:**
- `EstimateLineItem.price_book_item_id` → renamed/retargeted to `catalog_item_id` → `CatalogItem.id`. `item_type` stays (derived from `CatalogItem.kind` at select time) so existing estimate logic/PDF is untouched.
- A back-compat route alias keeps the Estimate picker working: `GET /api/price-book/items/search` continues to exist (now querying `CatalogItem` where the item is *sellable* — `visibility = catalog` / `kind` is a sellable kind) and returns the same response shape the picker already consumes. New canonical path: `GET /api/catalog/items/search`. **Net: the Estimate form needs zero or near-zero change.**

**Migration:** because the table is empty, the Prisma migration is essentially DROP/CREATE + rename the FK column; no row backfill. The plan verifies emptiness first; if any rows exist in the demo org, they're disposable test data and get reseeded.

**CASL:** keep the `PriceBook` subject as an alias OR rename to `Catalog`; frontend `AppSubject` and backend catalog updated together. (Recommendation: keep `PriceBook` subject string to avoid touching the estimate/nav gating; add `Inventory`/`Communication`. Confirm on review.)

## 3. Inventory backend

**New Prisma models** (fields sourced from `_mock/inventory/*` at plan time): `Brand`, `Vendor` (+ `VendorContact`), `InventoryLocation`, `Branch`, `StockBalance` (per item×location: on_hand/reserved/min/max), `StockMovement` (ledger), `PurchaseOrder` (+ `PurchaseOrderLine`), `PrePO`/`RFQ` (+ lines), `EstimateReservation`, `JobStage` (+ `JobStageLine`, `JobStageAttachment`), `StockApproval` (+ modifications). `CatalogItem`/`CatalogCategory` from §2. All carry `organization_id`.

**Cross-entity FKs (the "unified" part):** `PurchaseOrder.job_id?` → `Job`, `EstimateReservation.estimate_id` → `Estimate`, `JobStage.job_id` → `Job`, `StockMovement`/`StockApproval` requested/assigned tech → `User`. `Vendor` stays self-contained.

**Routes:** `/api/inventory/{items,vendors,brands,categories,locations,branches,movements,purchase-orders,rfqs,reservations,job-stages,stock-approvals}` — read + CRUD as the ported UI needs. `tenantWhere(req)` on every query. CASL subject `Inventory`.

**Seam flip:** `frontend/src/lib/api/inventory.ts` `USE_MOCK = false`; each hook's `queryFn` hits the matching route. Mock files stay as the seed source + type source.

## 4. Communication backend

**New Prisma models** (fields from `_mock/communication/*`): `CallSession`, `MessageThread` (+ `Message`), `PhoneAgent`, `Voicemail` (if separate in mock), `CallFlow`, `CallGroup`, `BlockedNumber`, `TextTemplate`, `TextAutomation`, `TrainingScenario`, `TrainingSession`, `WhatsAppChat` (+ messages), `Email` (+ `EmailGroup`), `ForwardRule`, `TeamMember`, plus the org's phone-number config. All carry `organization_id`.

**Cross-entity FKs:** `CallSession.customer_id?` → `Customer`, `…job_id?` → `Job`, `…agent` → `User`; `MessageThread.customer_id?` → `Customer`; `WhatsAppChat.customer_id?` → `Customer`. `PhoneAgent`/`TeamMember` reconcile to `User` (see §5). **No** auto-log to `TimelineEvent` this round (that's behavior, deferred) — but the FKs make it trivial later.

**Routes:** `/api/communication/{calls,threads,customers,agents,call-flows,call-groups,blocked,text-templates,text-automations,training-scenarios,training-sessions,whatsapp,emails,email-groups,forward-rules,team,unread-counts}` — read + the CRUD the UI exercises (compose/send writes to the thread; block/unblock; etc.). `tenantWhere(req)` everywhere. CASL subject `Communication`. `unread-counts` returns `{ sms, whatsapp, email }`.

**Seam flip:** `frontend/src/lib/api/communication.ts` `USE_MOCK = false`; `useUnreadCounts()` reads the new endpoint.

## 5. The unified seed (the heart)

A single script (`backend/src/seed-emanuel-demo.ts`) run against staging, in dependency order, all writes scoped to the demo org:

1. **Org + base** — ensure demo `Organization`; reset its module tables (idempotent wipe of seeded rows).
2. **Users/staff** — Emanuel's **techs (`_mock/inventory/techs.ts`) + phone agents → `User`** rows (`has_login=false` staff, role mapped, department from tech role). Build an id-map `mockTechId → userId`.
3. **Customers** — Emanuel's **phone-customers (`_mock/communication/phone-customers.ts`) → `Customer`** (+ a `ServiceLocation` from their address). De-dupe by phone/email against any existing demo customers. Id-map `mockCustomerId → customerId`.
4. **Catalog** — `CatalogCategory` tree, then `CatalogItem` from `_mock/inventory/inventory.ts` (this is *also* the price book Estimates now read). `Brand`, `Vendor` (+ contacts), `InventoryLocation`/`Branch`, `StockBalance`, `StockMovement`.
5. **Jobs** — Emanuel's inventory/phone job references → real `Job` rows (linked to the mapped Customer + a ServiceLocation + assigned mapped User). Id-map `mockJobId → jobId`.
6. **Inventory ops** — `PurchaseOrder`/lines, `RFQ`/`PrePO`, `EstimateReservation` (linked to seeded Estimates if we seed any; otherwise standalone), `JobStage`/lines/attachments, `StockApproval` — all FK'd via the id-maps.
7. **Communication** — `CallSession`/`MessageThread`/`Message`/`WhatsAppChat`/`Email`/`TextTemplate`/automations/training/flows/groups/blocked/forward-rules — FK'd to mapped Customers/Jobs/Users.

**Id-mapping** is the core technique: every transform looks up the real ALPHA id from the map built in steps 2–5, so the dataset is genuinely unified, not parallel.

## 6. Phasing & review gate

Internally phased, but **delivered together** for one review (per D2):

- **Phase 0 — Price-book unification** (model + estimate repoint + back-compat search route). Ship-blocking foundation; everything else builds on `CatalogItem`.
- **Phase 1 — Inventory backend** (models, routes, CASL, seam flip).
- **Phase 2 — Communication backend** (models, routes, CASL, seam flip).
- **Phase 3 — Unified seed** (the script + staging run).
- **Phase 4 — Verify**: `tsc` + build clean; backend tests green; flip both seams; manual click-through on staging demo org; confirm a phone call's customer === a Customers-list customer, a PO's job === a board job, and the Estimate picker still returns items.

**Then** RAN reviews the combined result.

## 7. Risks & open questions

1. **Estimate regression** — the repoint touches a live feature. Mitigation: keep the `/api/price-book/items/search` alias + response shape; add a test asserting the picker contract; verify on staging.
2. **Mock fidelity vs schema** — some mock fields have no ALPHA home (e.g. rich call/training metadata). We store them as Json columns rather than over-normalizing. Confirm acceptable.
3. **CASL subject naming** — keep `PriceBook` vs rename to `Catalog` (§2). **Open — recommend keep.**
4. **Advanced pricing engine** deferral — confirm the ported UI doesn't depend on markup/version/override behavior (it appears to use flat `sellPrice`/`listPrice`). To verify at plan time.
5. **Seed safety** — hard guard so the seed can never target prod. Plan includes an explicit org-id allowlist + env gate.

---

## Open decisions for RAN (review gate)

- **OK to keep the `PriceBook` CASL subject string** (rename internals to Catalog but not the permission subject), to avoid touching estimate/nav gating? *(recommend yes)*
- **Confirm advanced pricing engine is out of scope** this round (flat cost/sell/list only)? *(recommend yes)*
- **Demo org:** use the existing Alpha test org on staging, or create a fresh `Emanuel Demo` org? *(recommend existing Alpha test org)*
