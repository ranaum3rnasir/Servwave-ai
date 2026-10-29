# Estimates Module Enhancement — P0 + P1 Implementation Plan

## Context

The current estimate form works but feels unintuitive compared to competitors (HouseCall Pro, Workiz, Jobber, ServiceTitan). Research revealed key gaps: no price book/service catalog, no discounts, no internal cost/margin tracking, no drag-to-reorder, no estimate templates, no expiration dates, no digital signatures, and no terms & conditions. This plan addresses all of these across two priority tiers.

**User decisions:**
- Price Book: Services + Materials as two distinct types
- Discounts: Both estimate-level AND per-line-item
- Optional Line Items: P1 (not P0)
- Margin Display: On the form while editing (internal only, toggle-controlled)
- Digital Signature: Included in P1 (MVP requirement)

---

## P0 — Build Now (8 tasks)

### P0-1: Prisma Schema — Price Book + Discount/Cost Fields
**Complexity:** M | **Files:** `backend/prisma/schema.prisma`

Add new enums:
- `PriceBookItemType` (SERVICE, MATERIAL)
- `DiscountType` (PERCENTAGE, FIXED_AMOUNT)

Add new models:
- `PriceBookCategory` — id, name, parent_id (self-ref for subcategories), sort_order, is_active
- `PriceBookItem` — id, name, description, type (PriceBookItemType), category_id (FK), unit_cost (Decimal 12,2), unit_price (Decimal 12,2), taxable (bool), is_active (bool), sort_order

Add fields to `Estimate`:
- `discount_type` (DiscountType, nullable), `discount_value` (Decimal 12,2, nullable), `discount_name` (String, nullable), `discount_amount` (Decimal 12,2, default 0)

Add fields to `EstimateLineItem`:
- `price_book_item_id` (UUID FK nullable), `unit_cost` (Decimal 12,2, nullable)
- `discount_type` (DiscountType, nullable), `discount_value` (Decimal 12,2, nullable), `discount_amount` (Decimal 12,2, default 0)
- `item_type` (PriceBookItemType, default SERVICE) — for separating services vs materials in UI

Run migration. All new columns are nullable or have defaults, so existing data is safe.

---

### P0-2: Backend — Price Book CRUD Controller + Routes
**Complexity:** M | **Depends on:** P0-1
**Create:** `backend/src/controllers/price-book.controller.ts`, `backend/src/routes/price-book.routes.ts`
**Modify:** `backend/src/app.ts` (register `/api/price-book` route)

Endpoints:
| Method | Route | Auth | Purpose |
|--------|-------|------|---------|
| GET | `/categories` | ADMIN, SALES, DISPATCHER | List all categories (flat, with parent_id) |
| POST | `/categories` | ADMIN | Create category |
| PATCH | `/categories/:id` | ADMIN | Update category |
| DELETE | `/categories/:id` | ADMIN | Delete (only if no items reference it) |
| GET | `/items` | ADMIN, SALES, DISPATCHER | Paginated list, filter by type/category/search/is_active |
| GET | `/items/search?q=&type=` | ADMIN, SALES | Lightweight autocomplete (top 20, minimal fields) |
| POST | `/items` | ADMIN, SALES | Create item |
| GET | `/items/:id` | ADMIN, SALES, DISPATCHER | Get single item |
| PATCH | `/items/:id` | ADMIN, SALES | Update item |
| DELETE | `/items/:id` | ADMIN, SALES | Soft delete (is_active: false) |

Follow existing controller patterns: Zod schemas at top, Prisma queries, structured error responses.

---

### P0-3: Backend — Update Estimate Controller for Discounts + Cost
**Complexity:** M | **Depends on:** P0-1
**Modify:** `backend/src/controllers/estimate.controller.ts`

Changes:
1. Update `lineItemSchema` — add: `price_book_item_id`, `unit_cost`, `discount_type`, `discount_value`, `item_type`
2. Update `createEstimateSchema` / `updateEstimateSchema` — add: `discount_type`, `discount_value`, `discount_name`
3. Rewrite `calculateTotals()` with new order:
   - Per-line: `line_total = qty * unit_price`, `discount_amount` = (% of line_total or fixed), `effective = line_total - discount_amount`
   - `subtotal = sum(effective)`, `estimate_discount = (% of subtotal or fixed)`
   - `discounted_subtotal = subtotal - estimate_discount`
   - `tax = taxable_portion_after_discounts * tax_rate`
   - `total = discounted_subtotal + tax`
4. Update all select objects — add new fields; **exclude `unit_cost` from public selects**
5. Update `create`, `update`, `duplicate` handlers to pass new fields through
6. `duplicate` copies discount fields from source

---

### P0-4: Backend — Price Book + Discount Tests
**Complexity:** M | **Depends on:** P0-2, P0-3
**Create:** `backend/src/__tests__/price-book.test.ts`
**Modify:** `backend/src/__tests__/estimates.test.ts`, `backend/src/__tests__/helpers.ts`

~45 new tests:
- Category CRUD (~8), Item CRUD + search (~15), role checks (~7)
- Estimate discounts: per-line %, per-line $, estimate-level, combined, totals correct (~10)
- `unit_cost` excluded from public endpoint (~2)
- Duplicate copies discounts (~2)

---

### P0-5: Frontend — Price Book Management Page
**Complexity:** L | **Depends on:** P0-2
**Create:** `frontend/src/pages/PriceBookPage.tsx`
**Modify:** `frontend/src/App.tsx` (add route `/price-book`), `frontend/src/components/layout/nav-config.ts` (add nav item with `BookOpen` icon)

Two-tab page:
- **Items tab:** DataTable (Name, Type badge, Category, Unit Cost, Unit Price, Taxable, Status). Filters: type, category, active/inactive. Search by name. "Add Item" button → dialog form. Row click → edit dialog.
- **Categories tab:** Nested list with indent for subcategories. Add/edit/delete inline.

Follow existing page patterns (KPI strip, DataTable, filters).

---

### P0-6: Frontend — Redesigned Estimate Form
**Complexity:** L | **Depends on:** P0-2, P0-3
**Modify:** `frontend/src/pages/EstimateFormPage.tsx`

**Layout change:** Switch from 3-column (1/3 + 2/3) to 2-column (fixed 280px sidebar + fluid main):
- **Left sidebar (sticky):** Scope notes → Tax settings → Totals card (with estimate-level discount inputs)
- **Main area:** Price book search bar → Services section → Materials section → Internal margin summary

**New UI elements:**

1. **Price book autocomplete** — search bar above line items using `Command` (cmdk) popover. Type → debounced search → results grouped by category → select → auto-add to correct section (service/material) with fields pre-filled.
   - Install: `cmdk` package
   - `[+ Freeform]` button adds blank row

2. **Services + Materials sections** — two separate section headers with section subtotals. Each section has its own list of line items. Items auto-placed by `item_type`. Sequence numbers per-section.

3. **Line item columns:** Drag handle (⠿) | # | Description | Qty | Unit Price | Discount ($/% toggle) | Taxable (☑) | Line Total | Delete (🗑)

4. **Per-line discount** — inline column with $/% suffix toggle dropdown. Live total recalculation.

5. **Estimate-level discount** — in the totals sidebar card: name input, type toggle ($/%), value input, computed amount display.

6. **Cost/margin toggle** — "Show Cost" checkbox in section header. When ON: reveals secondary row below each item showing editable `unit_cost` input + computed margin ($ and %). Shows aggregate "Internal Margin Summary" bar at bottom: Total Cost | Margin $ | Margin %.

7. **"Save to price book"** link — shown on freeform items (no `price_book_item_id`). Opens small dialog to confirm name/category before saving.

8. **Totals breakdown:**
```
Subtotal               $X,XXX.XX
Line Item Discounts      -$XX.XX
Estimate Discount       -$XXX.XX
─────────────────────────────────
Taxable Subtotal       $X,XXX.XX
Tax (STATE X.XX%)        $XXX.XX
═════════════════════════════════
TOTAL                  $X,XXX.XX
```

**Form structure:** One `useFieldArray` with `item_type` field. Frontend filters into two display sections, merges back on submit. Sequence numbers reassigned on submit (services first, then materials).

**Responsive:** At < 1024px, sidebar stacks above main. Line items switch to card-per-item layout.

---

### P0-7: Frontend — Update Detail + Public Pages for Discounts
**Complexity:** S | **Depends on:** P0-3
**Modify:** `frontend/src/pages/EstimateDetailPage.tsx`, `frontend/src/pages/PublicEstimatePage.tsx`

- **Detail page:** Show line item discounts in table. Show discount row in totals. Split line items by type (Services/Materials sections). No cost/margin display (edit-only per user decision).
- **Public page:** Show discounts in totals. Show per-line discounts in adjusted line totals. Never show `unit_cost`. Split by type with section headers.

---

### P0-8: Frontend — Drag-to-Reorder Line Items
**Complexity:** S | **Depends on:** P0-6
**Modify:** `frontend/package.json`, `frontend/src/pages/EstimateFormPage.tsx`

Install `@dnd-kit/core` + `@dnd-kit/sortable` + `@dnd-kit/utilities`.

Wrap each section (Services, Materials) in `DndContext` + `SortableContext`. Each line item row uses `useSortable`. Drag handle = `GripVertical` icon. On drag end, use `useFieldArray.move()`. Reorder within sections only (not across).

---

## P1 — Build Next (8 tasks)

### P1-1: Schema — Templates + Expiration + Optional Items + Signature
**Complexity:** M | **Depends on:** P0-1
**Modify:** `backend/prisma/schema.prisma`

New models:
- `EstimateTemplate` — id, name, description, scope_notes, tax_rate, is_active, created_by (FK User)
- `EstimateTemplateItem` — id, template_id (FK, cascade), sequence, price_book_item_id (FK nullable), description, quantity, unit_price, unit_cost, is_taxable, item_type

New fields on `Estimate`:
- `expires_at` (DateTime nullable)
- `signature_data` (String nullable — base64 data URL)
- `signature_ip` (String nullable)
- `signature_at` (DateTime nullable)

New fields on `EstimateLineItem`:
- `is_optional` (Boolean, default false)
- `is_recommended` (Boolean, default false)
- `is_selected` (Boolean, default true)

---

### P1-2: Backend — Estimate Templates CRUD
**Complexity:** M | **Depends on:** P1-1
**Create:** `backend/src/controllers/estimate-template.controller.ts`, `backend/src/routes/estimate-template.routes.ts`
**Modify:** `backend/src/app.ts`, `backend/src/controllers/estimate.controller.ts` (add `saveAsTemplate` action)

Endpoints: list, get, create, update, delete (soft), save-as-template. Roles: ADMIN, SALES.

---

### P1-3: Backend — Expiration Date Logic
**Complexity:** S | **Depends on:** P1-1
**Modify:** `backend/src/controllers/estimate.controller.ts`

- `create`: auto-set `expires_at` = now + N days (from AppSetting `default_estimate_validity_days`, default 30)
- `send`: if `expires_at` null or past, set to now + default days
- `approvePublic`: reject if `expires_at < now`, auto-transition to EXPIRED
- `getPublic`: lazy expiration — if SENT and expired, set status to EXPIRED
- Update schema allows overriding `expires_at`

---

### P1-4: Backend — Optional Line Items Logic
**Complexity:** S | **Depends on:** P1-1
**Modify:** `backend/src/controllers/estimate.controller.ts`

- Update schemas to accept `is_optional`, `is_recommended`
- `calculateTotals`: only non-optional or selected items in main total; separate `optional_total`
- `approvePublic`: accept `selected_items: string[]` (line item IDs). Mark selections. Recalculate totals.
- Public select includes `is_optional`, `is_recommended`, `is_selected`

---

### P1-5: Backend — Terms & Conditions + Digital Signature
**Complexity:** S | **Depends on:** P1-1
**Modify:** `backend/src/controllers/estimate.controller.ts`

- `getPublic`: fetch AppSetting `estimate_terms`, include in response
- `approvePublic`: require `signature_data` (base64), capture `signature_ip` from request, set `signature_at`
- Validate signature_data format (starts with `data:image/`)

---

### P1-6: Backend — P1 Tests
**Complexity:** M | **Depends on:** P1-2 through P1-5
**Create:** `backend/src/__tests__/estimate-templates.test.ts`
**Modify:** `backend/src/__tests__/estimates.test.ts`

~40 new tests: template CRUD, save-as-template, expiration logic, optional items totals, approval with selections, signature required, terms in public response.

---

### P1-7: Frontend — Estimate Templates UI
**Complexity:** M | **Depends on:** P1-2
**Create:** `frontend/src/components/estimates/LoadTemplateDialog.tsx`, `frontend/src/components/estimates/SaveTemplateDialog.tsx`
**Modify:** `frontend/src/pages/EstimateFormPage.tsx`, `frontend/src/pages/EstimateDetailPage.tsx`

- "Load Template" dropdown on estimate form — shows templates, selecting one replaces line items (with confirmation)
- "Save as Template" action in estimate detail dropdown menu + button on form

---

### P1-8: Frontend — Expiration, Optional Items, Terms, Signature on Public Page
**Complexity:** M | **Depends on:** P1-3 through P1-5
**Modify:** `frontend/src/pages/PublicEstimatePage.tsx`, `frontend/src/pages/EstimateFormPage.tsx`, `frontend/src/pages/EstimateDetailPage.tsx`

Install `react-signature-canvas` + `@types/react-signature-canvas`.

- **PublicEstimatePage:** Expiration banner + block approval if expired. Optional items split into "Included" + "Optional Add-ons" sections with checkboxes (recommended = pre-checked). Dynamic totals. Terms section below totals. Signature pad before approve confirmation (required). Show captured signature after approval.
- **EstimateFormPage:** `expires_at` date picker in sidebar. `is_optional`/`is_recommended` toggles per line item.
- **EstimateDetailPage:** Show expiration in details tab. Show optional item indicators in line items table.

---

## P2 — Post-MVP (documented, not built now)

Create file `memory/post-mvp-features.md` to document:
- Good-Better-Best multi-option estimates (2-3 complete option packages side-by-side)
- Photo/attachment embedding on estimates with customer visibility toggle
- Photo annotations (draw on photos)
- Estimate PDF export/download
- Customer financing integration
- Per-line-item named/reusable discounts
- Change orders on approved estimates
- Price book bundles/packages (group multiple items as one)
- Price book CSV import/export
- Price book images (visual price book for on-site selling)
- Dimensional pricing (price per sq ft, linear ft, etc.)
- Read receipts (track when customers view estimates)
- Offline estimate creation

---

## Implementation Order (Linear)

```
P0-1  Schema (price book + discounts + cost)
P0-2  Price Book backend CRUD
P0-3  Estimate controller updates (discounts + cost)
P0-4  Backend tests (price book + discounts)
P0-5  Price Book frontend page
P0-6  Estimate form redesign (autocomplete, sections, discounts, margins)
P0-7  Detail + Public pages (discount display)
P0-8  Drag-to-reorder
── P0 Complete ──
P1-1  Schema (templates, expiration, optional, signature)
P1-2  Template backend CRUD
P1-3  Expiration backend logic
P1-4  Optional items backend logic
P1-5  Terms + Signature backend
P1-6  P1 backend tests
P1-7  Templates frontend UI
P1-8  Public page P1 features (expiration, optional, terms, signature)
── P1 Complete ──
```

---

## Key Architectural Decisions

1. **Single `line_items` array with `item_type` field** — backend stays simple (one array); frontend splits by type for display, merges on submit
2. **Discount order:** line discounts → estimate discount → tax on discounted taxable portion
3. **Price book soft-delete** — `is_active: false` (historical line items may reference PB items)
4. **Lazy expiration** — check on public page access, no cron job needed for MVP
5. **Signature as base64** — stored directly in DB column for MVP; future: upload to Supabase Storage
6. **Cost/margin toggle** — conscious opt-in to prevent accidental exposure during screen-sharing

---

## Verification Plan

After each task:
1. Run `npx prisma validate` (from backend/) after schema changes
2. Run `npm test --workspace=backend` after backend changes — all tests must pass
3. Run `npx tsc --noEmit` (from frontend/) after frontend changes — no type errors
4. Manual testing: create/edit estimates with new features, verify totals calculate correctly
5. Test public page: verify `unit_cost` is never exposed, discounts display correctly
6. Test role permissions: SALES can only access own leads' estimates, TECHNICIAN blocked

After P0 complete:
- Create a price book item, use it in an estimate, verify autocomplete works
- Apply line + estimate discounts, verify total calculation matches: `subtotal - line_discounts - est_discount + tax = total`
- Toggle margins on/off, verify cost data never leaks to public view
- Drag-reorder items, save, reload — verify sequence preserved

After P1 complete:
- Create template from estimate, load it into new estimate
- Send estimate, verify expiration date set, wait/manually expire, verify approval blocked
- Add optional items, verify public page shows checkboxes, approve with selections
- Test signature: draw, approve, verify stored, verify displayed after approval
- Verify terms appear on public page
