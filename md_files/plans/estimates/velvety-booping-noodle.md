# Step 5: Estimates — Corrected Implementation Plan

## Context
Step 5 builds the Estimates module — the bridge between sales (leads) and operations (jobs). Based on the original plan in `md files/Step5-Estimates-Plan.md`, reviewed and corrected for gaps against business rules, workflows, and data model.

## Decisions from Gap Analysis
1. **Lead auto-transition on estimate approval:** Lead moves to **WON** (not "APPROVED" which doesn't exist)
2. **EXPIRED status:** Deferred — status exists in enum but no trigger mechanism in Step 5
3. **Notes:** Added to controller spec (GET/POST handlers following lead/customer pattern)
4. **Deposits:** Deferred to Step 5.1 (separate mini-step before Step 6)
5. **Dispatcher:** Read-only for estimates (Admin/Sales write, Admin/Sales/Dispatcher read)
6. **Timeline events:** Added — create TimelineEvent records for all estimate actions
7. **Lead rollback:** No auto-rollback. Lead stays ESTIMATING even if all estimates cancelled.

---

## Phase 1: Database Migrations

### 1.1 Schema changes (`backend/prisma/schema.prisma`)
- Add `tax_rate Decimal @default(0) @db.Decimal(5,4)` to Estimate model
- Add `StateTaxRate` model: `id`, `state_code` (unique, VARCHAR 2), `state_name` (VARCHAR 50), `tax_rate` (Decimal 5,4)
- Add `AppSetting` model: `key` (PK, VARCHAR 100), `value` (Text), `updated_at`

### 1.2 Apply migration via Supabase MCP
- DDL for tax_rate column, state_tax_rates table, app_settings table
- `npx prisma db pull` + `npx prisma generate`

### 1.3 Seed data (`backend/src/seed.ts`)
- `seedStateTaxRates()` — 50 states + DC with general sales tax rates
- `app_settings` row: `key=default_tax_state`, `value=Texas`

---

## Phase 2: Backend — Supporting Endpoints

### 2.1 State tax rates (`backend/src/controllers/state-tax-rate.controller.ts`)
- `list` handler — GET /api/state-tax-rates (auth: ADMIN/SALES/DISPATCHER)

### 2.2 App settings (`backend/src/controllers/settings.controller.ts`)
- `getByKey` — GET /api/settings/:key (all staff)
- `updateByKey` — PATCH /api/settings/:key (ADMIN only)

### 2.3 Register routes in `backend/src/app.ts`

---

## Phase 3: Backend — Estimate Controller

**File:** `backend/src/controllers/estimate.controller.ts`

### CRUD handlers
| Handler | Method | Path | Key rules |
|---------|--------|------|-----------|
| `list` | GET | `/api/estimates` | Paginated, search (estimate # or customer name via lead→customer join), filter by status/lead_id. Sales sees only own leads' estimates. Bundled stats. |
| `create` | POST | `/api/estimates` | Validate lead exists + not terminal. Sales guard. Generate EST-YYYY-NNNN (transaction-safe). Calculate totals. Auto-transition lead → ESTIMATING. **Create TimelineEvent.** |
| `getById` | GET | `/api/estimates/:id` | Include line_items, lead+customer, creator. Sales guard. |
| `update` | PATCH | `/api/estimates/:id` | DRAFT only. Replace line items (delete+create in transaction). Recalculate totals. |
| `remove` | DELETE | `/api/estimates/:id` | DRAFT only. |

### Action handlers
| Handler | Method | Path | Key rules |
|---------|--------|------|-----------|
| `send` | POST | `/:id/send` | DRAFT → SENT. Generate public_token, set sent_at. **TimelineEvent.** |
| `cancel` | POST | `/:id/cancel` | DRAFT/SENT → CANCELLED. Requires cancelled_reason. **TimelineEvent.** |
| `duplicate` | POST | `/:id/duplicate` | Deep-copy scope_notes, tax_rate, line items → new DRAFT. |

### Public handlers (no auth)
| Handler | Method | Path | Key rules |
|---------|--------|------|-----------|
| `getPublic` | GET | `/:id/public?token=` | Token-validated. Returns estimate for customer view. |
| `approvePublic` | POST | `/:id/approve?token=` | SENT → APPROVED. **Auto-transition lead → WON. TimelineEvent.** |
| `declinePublic` | POST | `/:id/decline?token=` | SENT → DECLINED. **TimelineEvent.** |

### Notes handlers
| Handler | Method | Path | Key rules |
|---------|--------|------|-----------|
| `listNotes` | GET | `/:id/notes` | entity_type=ESTIMATE, entity_id=:id |
| `createNote` | POST | `/:id/notes` | Same pattern as lead/customer notes |

### Helpers
- `generateEstimateNumber(tx)` — transaction-safe yearly counter
- `calculateTotals(lineItems, taxRate)` — subtotal, tax on taxable items, total

### Routes (`backend/src/routes/estimate.routes.ts`)
- **Public routes first** (before `authenticate` middleware)
- Then auth-gated CRUD + actions + notes
- Roles: ADMIN/SALES write, ADMIN/SALES/DISPATCHER read

---

## Phase 4: Backend Tests

### 4.1 Update test infrastructure
- `backend/src/__tests__/setup.ts` — add mocks for estimate, estimateLineItem, stateTaxRate, appSetting, timelineEvent
- `backend/src/__tests__/helpers.ts` — ESTIMATE_FIXTURE, STATE_TAX_FIXTURE

### 4.2 Estimate tests (`backend/src/__tests__/estimates.test.ts`)
~70 tests covering:
- List: pagination, search, status filter, lead_id filter, Sales auto-filter (5)
- Create: success + lead auto-transition to ESTIMATING + timeline event, missing lead, terminal lead, Sales guard, validation (8)
- GetById: success, 404, Sales can/cannot view (4)
- Update: draft only, line items replacement, recalculation, Sales guard (6)
- Delete: draft only, 404, Sales guard (4)
- Send: success + timeline, not-draft error, generates token (4)
- Cancel: from DRAFT, from SENT, reason required, cannot cancel APPROVED, timeline (5)
- Duplicate: success, copies line items, new number (3)
- Public view: valid token, invalid token, wrong status (4)
- Approve: success + lead→WON + timeline, invalid token, not-SENT (4)
- Decline: success + timeline, invalid token, not-SENT (3)
- Notes: list, create, 404 (3)
- Role access: Technician blocked, Dispatcher read-only (6)
- Tax rates + settings endpoints (6)

### 4.3 Run `npm test --workspace=backend`

---

## Phase 5: Frontend — Estimates List Page

Replace placeholder `frontend/src/pages/EstimatesPage.tsx`. Follow LeadsPage pattern.

**KPI strip** (grid-cols-2 lg:grid-cols-5 divide-x):
- Total Estimates, Drafts, Sent/Awaiting, Approved, Total Value

**DataTable columns:** Estimate #, Customer, Status, Total, Created By, Date

**Toolbar:** Search + status filter + Export CSV + "New Estimate" → `/estimates/new`

**Row click** → `/estimates/:id`

---

## Phase 6: Frontend — Estimate Form Page

**New file:** `frontend/src/pages/EstimateFormPage.tsx`

Full-page form (not dialog). Two-column at lg:. RHF + Zod + useFieldArray.

**URLs:** Create `/estimates/new?lead_id=xxx` | Edit `/estimates/:id/edit`

**Sections:**
1. Lead info banner (read-only, fetched from lead API) — **show error if lead_id invalid or lead is terminal**
2. Scope notes (textarea) + Tax rate dropdown (searchable state selector via Popover+Command)
3. Line items table (useFieldArray): #, Description, Qty, Unit Price, Taxable (Switch), Total, Delete
4. Totals block (live-calculated): Subtotal, Tax line, Total
5. Action bar: Cancel + Submit

**Tax rate:** Fetch states from GET /api/state-tax-rates, default from GET /api/settings/default_tax_state

---

## Phase 7: Frontend — Estimate Detail Page

**New file:** `frontend/src/pages/EstimateDetailPage.tsx`

**Hero card:** Estimate number + StatusBadge, subtitle (customer, lead, date), KPI strip (Subtotal, Tax Rate, Tax Amount, Total)

**Action buttons by status:**
| Status | Primary CTA | Actions dropdown |
|--------|------------|-----------------|
| DRAFT | "Send" (blue) | Edit, Cancel, Delete |
| SENT | "Copy Link" | Duplicate, Cancel |
| APPROVED | — | Duplicate |
| DECLINED/CANCELLED | — | Duplicate |

**Tabs:** Line Items (default), Details, Notes

**New component:** `frontend/src/components/estimates/CancelEstimateDialog.tsx` (same pattern as MarkLostDialog)

---

## Phase 8: Frontend — Public Estimate Page

**New file:** `frontend/src/pages/PublicEstimatePage.tsx`

**Route:** `/p/estimates/:id?token=xxx` (outside auth layout)

Minimal clean page (max-w-2xl, centered). Uses raw fetch() — no JWT.

**Status rendering:** SENT → buttons, APPROVED → green banner, DECLINED → muted banner, Other → unavailable message

**Both Approve and Decline get confirmation dialogs** (approve is consequential too).

---

## Phase 9: Frontend — Lead Detail Integration

### Update LeadDetailPage.tsx
- "New Estimate" button in Estimates tab header (ADMIN/SALES, lead not terminal)
- Make estimate rows clickable → `/estimates/:id`
- Add "Created By" column (needs backend: include creator in lead detail estimates)
- "Create Estimate" button in lead hero actions (ADMIN/SALES, not terminal)

### Update lead.controller.ts getById
- Add `creator` to estimates include in the lead detail select

---

## Phase 10: Verification

1. `npm test --workspace=backend` — all tests pass
2. `cd frontend && npx tsc --noEmit` — no type errors
3. Manual smoke: create estimate from lead → send → open public link → approve → verify lead moves to WON
4. Verify lead auto-transitions (ESTIMATING on first estimate create, WON on approve)

---

## Phase 11: Documentation

- Update CLAUDE.md — new files, routes, mark Step 5 complete
- Run `/end-session` to sync knowledge base

---

## Files Summary

**New (13):**
- `backend/src/controllers/estimate.controller.ts`
- `backend/src/controllers/state-tax-rate.controller.ts`
- `backend/src/controllers/settings.controller.ts`
- `backend/src/routes/estimate.routes.ts`
- `backend/src/routes/state-tax-rate.routes.ts`
- `backend/src/routes/settings.routes.ts`
- `backend/src/__tests__/estimates.test.ts`
- `frontend/src/pages/EstimateFormPage.tsx`
- `frontend/src/pages/EstimateDetailPage.tsx`
- `frontend/src/pages/PublicEstimatePage.tsx`
- `frontend/src/components/estimates/CancelEstimateDialog.tsx`

**Modified (9):**
- `backend/prisma/schema.prisma` — tax_rate field, StateTaxRate, AppSetting models
- `backend/src/app.ts` — register 3 new route groups
- `backend/src/seed.ts` — seed state tax rates + default setting
- `backend/src/controllers/lead.controller.ts` — include creator in estimates for lead detail
- `backend/src/__tests__/setup.ts` — add Prisma mocks for new models
- `backend/src/__tests__/helpers.ts` — add estimate fixtures
- `frontend/src/App.tsx` — add estimate routes + public route
- `frontend/src/pages/EstimatesPage.tsx` — replace placeholder
- `frontend/src/pages/LeadDetailPage.tsx` — wire estimate creation + clickable rows
