# Step 5: Estimates Module — Implementation Plan

## Context

Step 5 builds the Estimates module — the bridge between sales (leads) and operations (jobs). A sales rep creates a formal quote with itemized line items for a customer. The customer views it via a public link and approves or declines. Deposits are deferred to Step 5.1.

**Key decisions:**
- Locked after SENT (edit → cancel + duplicate as new DRAFT)
- Auto-transition: first estimate → lead ESTIMATING; estimate approved → lead APPROVED
- Yearly-reset numbering: EST-2026-0001
- Per-estimate tax rate via searchable US state dropdown
- `state_tax_rates` DB table (seeded), `app_settings` key-value table (no UI yet)
- Public view: customer approves/declines via token link (simple functional page, no branding)
- Duplicate: deep-copy line items + scope into new DRAFT on same lead

---

## Phase 1: Database Migrations

### 1.1 Schema changes (`backend/prisma/schema.prisma`)
- Add `tax_rate Decimal @default(0) @db.Decimal(5, 4)` to `Estimate` model
- Add `StateTaxRate` model: `id`, `state_code` (unique, VARCHAR 2), `state_name` (VARCHAR 50), `tax_rate` (Decimal 5,4)
- Add `AppSetting` model: `key` (PK, VARCHAR 100), `value` (Text), `updated_at`

### 1.2 Apply migration via Supabase MCP
- Run the DDL to add the `tax_rate` column, create `state_tax_rates` and `app_settings` tables
- Then `npx prisma db pull` + `npx prisma generate` to sync client

### 1.3 Seed state tax rates + default setting
- Modify `backend/src/seed.ts` — add a separate `seedStateTaxRates()` function
- Insert all 50 states + DC with general state sales tax rates
- Insert `app_settings` row: `key=default_tax_state`, `value=Texas`

---

## Phase 2: Backend — Supporting Endpoints

### 2.1 State tax rates controller + route
- **New:** `backend/src/controllers/state-tax-rate.controller.ts` — single `list` handler
- **New:** `backend/src/routes/state-tax-rate.routes.ts` — `GET /` (authenticate + authorize ADMIN/SALES/DISPATCHER)

### 2.2 App settings controller + route
- **New:** `backend/src/controllers/settings.controller.ts` — `getByKey`, `updateByKey`
- **New:** `backend/src/routes/settings.routes.ts` — `GET /:key` (all staff), `PATCH /:key` (ADMIN only)

### 2.3 Register routes in `backend/src/app.ts`
- Add `/api/state-tax-rates` and `/api/settings`

---

## Phase 3: Backend — Estimate Controller + Routes

### 3.1 Estimate controller (`backend/src/controllers/estimate.controller.ts`)

**Zod schemas:** `createEstimateSchema`, `updateEstimateSchema`, `cancelEstimateSchema`

**CRUD handlers:**
| Handler | Method | Path | Rules |
|---------|--------|------|-------|
| `list` | GET | `/api/estimates` | Paginated, search, filter by status/lead_id. Sales sees only own leads' estimates. Bundled stats (total, draft, sent, approved, total value) |
| `create` | POST | `/api/estimates` | Validate lead exists + not terminal. Sales guard. Generate EST-YYYY-NNNN (yearly reset, transaction-safe). Calculate totals. Auto-transition lead → ESTIMATING |
| `getById` | GET | `/api/estimates/:id` | Include line_items, lead+customer, creator. Sales guard |
| `update` | PATCH | `/api/estimates/:id` | DRAFT only. Replace line items via delete+create in transaction. Recalculate totals |
| `remove` | DELETE | `/api/estimates/:id` | DRAFT only |

**Action handlers:**
| Handler | Method | Path | Rules |
|---------|--------|------|-------|
| `send` | POST | `/:id/send` | DRAFT → SENT. Generate `public_token`, set `sent_at` |
| `cancel` | POST | `/:id/cancel` | DRAFT or SENT → CANCELLED. Requires `cancelled_reason` |
| `duplicate` | POST | `/:id/duplicate` | Deep-copy scope_notes, tax_rate, line items → new DRAFT with new number |

**Public handlers (no auth middleware):**
| Handler | Method | Path | Rules |
|---------|--------|------|-------|
| `getPublic` | GET | `/:id/public?token=` | Token-validated. Returns estimate data for customer view |
| `approvePublic` | POST | `/:id/approve?token=` | SENT → APPROVED. Auto-transition lead → APPROVED |
| `declinePublic` | POST | `/:id/decline?token=` | SENT → DECLINED |

**Helpers:** `generateEstimateNumber(tx)`, `calculateTotals(lineItems, taxRate)`

### 3.2 Estimate routes (`backend/src/routes/estimate.routes.ts`)
- Public routes first (before `authenticate` middleware)
- Then auth-gated CRUD + actions
- Role guards: ADMIN/SALES for write ops, ADMIN/SALES/DISPATCHER for reads

### 3.3 Register in `backend/src/app.ts`
- Add `/api/estimates`

---

## Phase 4: Backend — Tests

### 4.1 Update test infrastructure
- **Modify** `backend/src/__tests__/setup.ts` — add mocks for `estimate`, `estimateLineItem`, `stateTaxRate`, `appSetting`
- **Modify** `backend/src/__tests__/helpers.ts` — add `ESTIMATE_FIXTURE`, `STATE_TAX_FIXTURE`

### 4.2 Estimate tests (`backend/src/__tests__/estimates.test.ts`)
~60-70 tests covering:
- List: pagination, search, status filter, lead_id filter, Sales auto-filter (5)
- Create: success, missing lead, terminal lead, Sales guard, auto-transition, validation (8)
- GetById: success, 404, Sales can/cannot view (4)
- Update: draft only, line items replacement, recalculation, Sales guard (6)
- Delete: draft only, 404, Sales guard (4)
- Send: success, not-draft error, generates token (4)
- Cancel: from DRAFT, from SENT, reason required, cannot cancel APPROVED (4)
- Duplicate: success, copies line items, new number (3)
- Public view: valid token, invalid token, wrong status (4)
- Approve: success, invalid token, not-SENT, lead auto-transition (4)
- Decline: success, invalid token, not-SENT (3)
- Role access: Technician blocked, Dispatcher read-only (6)
- Tax rates + settings endpoints (6)

### 4.3 Run tests
- `npm test --workspace=backend` — verify all 117 existing + ~65 new pass

---

## Phase 5: Frontend — Estimates List Page

### 5.1 Replace placeholder `frontend/src/pages/EstimatesPage.tsx`

Follow LeadsPage pattern. Query: `GET /api/estimates` (bundled stats).

**KPI strip** (single card, `grid-cols-2 lg:grid-cols-5 divide-x`):
- Total Estimates (FileText icon)
- Drafts (Edit3 icon)
- Sent / Awaiting (Send icon)
- Approved (CheckCircle icon)
- Total Value (DollarSign icon, formatCurrency)

**DataTable columns:**
| Column | Cell content |
|--------|-------------|
| Estimate # | `estimate_number` (font-medium, text-primary) |
| Customer | customer first+last name |
| Status | `<StatusBadge>` |
| Total | `formatCurrency(total_amount)` (font-semibold) |
| Created By | creator name |
| Date | formatted `created_at` |

**Toolbar:** Search (estimate # or customer name) + status filter dropdown + Export CSV + "New Estimate" button → `/estimates/new`
**Row click** → `/estimates/:id`

---

## Phase 6: Frontend — Estimate Form Page

### 6.1 New `frontend/src/pages/EstimateFormPage.tsx`

Full-page form (not dialog). Two-column layout at `lg:`. Uses RHF + Zod + `useFieldArray`.

**URLs:** Create `/estimates/new?lead_id=xxx` | Edit `/estimates/:id/edit` (DRAFT only)

**Layout (Workiz-inspired, adapted to our design system):**

```
┌─────────────────────────────────────────────────────────────┐
│  ← Back to Lead                        Create Estimate      │
├─────────────────────────────────────────────────────────────┤
│  ┌──────────── Lead Info (read-only banner) ──────────────┐ │
│  │  Customer: John Smith  │  Service: AC Repair  │  #123  │ │
│  └────────────────────────────────────────────────────────┘ │
│                                                             │
│  ┌── LEFT COL ──────────┐  ┌── RIGHT COL ──────────────┐   │
│  │  Scope Notes          │  │  Tax Rate                 │   │
│  │  [Textarea rows=4]    │  │  [🔍 New York — 8.88% ▼] │   │
│  └───────────────────────┘  └───────────────────────────┘   │
│                                                             │
│  ┌──────── Line Items (full width) ───────────────────────┐ │
│  │  Items                                     + Add Item  │ │
│  │  ┌───┬─────────────┬──────┬─────────┬───────┬───────┐ │ │
│  │  │ # │ Description │ Qty  │ Price   │Taxable│ Total │ │ │
│  │  ├───┼─────────────┼──────┼─────────┼───────┼───────┤ │ │
│  │  │ 1 │ [_________] │[1.0] │[$0.00]  │  [✓]  │$0.00 🗑│ │ │
│  │  │ 2 │ [_________] │[1.0] │[$0.00]  │  [✓]  │$0.00 🗑│ │ │
│  │  └───┴─────────────┴──────┴─────────┴───────┴───────┘ │ │
│  └────────────────────────────────────────────────────────┘ │
│                                                             │
│                             Subtotal:       $1,000.00       │
│                             Tax (NY 8.88%):    $88.80       │
│                             ─────────────────────────       │
│                             Total:          $1,088.80       │
│                                                             │
│  ──────────────────────────────────────────────────────────  │
│                              [Cancel]  [Create Estimate]    │
└─────────────────────────────────────────────────────────────┘
```

**Lead info banner** (top, read-only):
- Fetched from `GET /api/leads/:lead_id`
- Shows: customer name, service request (truncated), lead ID as link
- Styled: `bg-background-light/50 rounded-lg p-3 border border-border`

**Scope notes** (left col): `<Textarea rows={4}>`, optional, max 5000

**Tax rate dropdown** (right col):
- Fetch states: `GET /api/state-tax-rates` (staleTime: Infinity)
- Fetch default: `GET /api/settings/default_tax_state` → pre-select
- Searchable via `<Popover>` + `<Command>` (cmdk) from shadcn
- Options: `"New York — 8.88%"` format
- Stores `tax_rate` decimal value on selection

**Line items table** (`useFieldArray`):
| Col | Width | Input | Notes |
|-----|-------|-------|-------|
| # | 40px | Sequence (read-only) | Auto-increments |
| Description | flex-1 | `<Input>` | Required, max 500 |
| Qty | 80px | `<Input type="number" step="0.01">` | Default 1, min 0.01 |
| Unit Price | 120px | `<Input type="number" step="0.01">` | Min 0 |
| Taxable | 70px | `<Switch>` | Default true |
| Total | 100px | Computed (read-only) | qty × unit_price |
| Delete | 40px | Trash2 icon | Hidden if only 1 row |

- "+ Add Item" button: Plus icon + text, top-right of items header
- Table: `border border-border rounded-lg`, header `bg-background-light/50`
- Min 1 row enforced by Zod

**Totals** (right-aligned block below items):
- Subtotal, Tax line (`Tax ({state} {rate}%): $XX.XX`), separator, **Total** (bold, text-lg)
- Live-calculated via `watch()` from RHF

**Actions** (`border-t pt-4 flex justify-end gap-3`):
- Cancel → navigate back | Submit → "Create Estimate" or "Save Changes"

**Edit mode:** Fetch estimate `GET /api/estimates/:id`, redirect if not DRAFT, pre-populate all fields. Submit → `PATCH /api/estimates/:id`.

### 6.2 Add routes in `frontend/src/App.tsx`

Inside AppLayout (protected):
- `/estimates/new` → EstimateFormPage
- `/estimates/:id/edit` → EstimateFormPage
- `/estimates/:id` → EstimateDetailPage

Outside ProtectedRoute (public, before catch-all):
- `/p/estimates/:id` → PublicEstimatePage (uses `/p/` prefix for public routes)

---

## Phase 7: Frontend — Estimate Detail Page

### 7.1 New `frontend/src/pages/EstimateDetailPage.tsx`

Follows LeadDetailPage layout. Inspired by Workiz's all-in-one estimate view.

**Layout:**

```
┌── Breadcrumb: Estimates > EST-2026-0001 ─────────────────────┐

┌── Hero Card ─────────────────────────────────────────────────┐
│  EST-2026-0001      [StatusBadge ▼]    [Actions ▼] [Send ▶] │
│  John Smith · AC Repair · Created Feb 23, 2026               │
│  ┌──────────┬───────────┬────────────┬─────────────┐        │
│  │ Subtotal │ Tax Rate  │ Tax Amount │    Total    │        │
│  │ $1,000   │ NY 8.88%  │ $88.80     │  $1,088.80 │        │
│  └──────────┴───────────┴────────────┴─────────────┘        │
└──────────────────────────────────────────────────────────────┘

┌── Content Card (tabs) ───────────────────────────────────────┐
│  [Line Items (8)]  [Details]  [Notes (3)]                    │
│  ────────────────────────────────────────────────────────── │
│  (active tab content)                                        │
└──────────────────────────────────────────────────────────────┘
```

**Hero — title row:**
- Estimate number (text-xl font-bold) + clickable status dropdown (Workiz-style)
  - Status as `<StatusBadge>` with chevron, only for DRAFT/SENT (valid transitions)
  - DRAFT can → SENT; other transitions happen via action buttons
- Subtitle: Customer name (link) · Lead service request (link) · "Created {date}"

**Hero — action buttons** (right side, Workiz "Actions" + primary CTA):
| Status | Primary CTA | Actions dropdown |
|--------|------------|-----------------|
| DRAFT | "Send" (blue) | Edit, Cancel, Delete |
| SENT | "Copy Link" (copies public URL) | Duplicate, Cancel |
| APPROVED | — | Duplicate |
| DECLINED/EXPIRED/CANCELLED | — | Duplicate |

**Hero — KPI strip** (`grid-cols-2 sm:grid-cols-4` with Separator):
- Subtotal (formatCurrency)
- Tax Rate (`"{state} {rate}%"`)
- Tax Amount (formatCurrency)
- Total (formatCurrency, font-bold)

**Tab: Line Items** (default tab):
- Read-only table: #, Description, Qty, Unit Price, Taxable (Yes/No), Line Total
- Header: `bg-background-light/50`, uppercase text-xs
- Summary row at bottom: bold "Total" label + total amount (right-aligned)

**Tab: Details** (two-column, `lg:divide-x`):
- Left — Estimate info: scope notes, created by, timestamps (created/sent/approved/declined/cancelled), cancelled_reason if applicable (in subtle warning box)
- Right — Related: lead (service request, status badge, link), customer (name, phone, email, link), service address

**Tab: Notes:**
- Same pattern as LeadDetailPage notes
- `GET /api/estimates/:id/notes` | `POST /api/estimates/:id/notes`

**Action implementations:**
- Send: `POST /:id/send` → toast with public link
- Cancel: opens CancelEstimateDialog
- Delete: confirmation → `DELETE /:id` → navigate to list
- Duplicate: `POST /:id/duplicate` → navigate to new estimate
- Edit: navigate to `/:id/edit`
- Copy Link: `{origin}/p/estimates/:id?token={public_token}` → clipboard → toast

### 7.2 New `frontend/src/components/estimates/CancelEstimateDialog.tsx`

Same pattern as MarkLostDialog (`max-w-sm`):
- Props: `{ open, onOpenChange, estimateId }`
- Textarea: "Cancellation reason *"
- Calls `POST /api/estimates/:id/cancel` with `{ cancelled_reason }`
- Invalidates `['estimate', estimateId]` + `['estimates']`
- Button: "Cancel Estimate" (variant="destructive")

---

## Phase 8: Frontend — Public Estimate Page

### 8.1 New `frontend/src/pages/PublicEstimatePage.tsx`

**Outside auth layout** — no sidebar, no header, no JWT.
Route: `/p/estimates/:id?token=xxx`

```
┌──────────────────────────────────────────────────────────┐
│                       ALPHA CRM                          │
│                                                          │
│  ┌── Estimate Card (max-w-2xl mx-auto) ──────────────┐  │
│  │  Estimate EST-2026-0001           Status: Sent     │  │
│  │  Prepared for: John Smith                          │  │
│  │                                                    │  │
│  │  Scope of Work:                                    │  │
│  │  Replace AC unit and install new thermostat...     │  │
│  │                                                    │  │
│  │  ┌────┬──────────────┬──────┬──────────┬────────┐  │  │
│  │  │ #  │ Description  │ Qty  │ Price    │ Amount │  │  │
│  │  ├────┼──────────────┼──────┼──────────┼────────┤  │  │
│  │  │ 1  │ AC Unit      │ 1    │ $800.00  │$800.00 │  │  │
│  │  │ 2  │ Labor (4 hr) │ 4    │ $50.00   │$200.00 │  │  │
│  │  └────┴──────────────┴──────┴──────────┴────────┘  │  │
│  │                                                    │  │
│  │                      Subtotal:       $1,000.00     │  │
│  │                      Tax (NY 8.88%):    $88.80     │  │
│  │                      ─────────────────────────     │  │
│  │                      Total:          $1,088.80     │  │
│  │                                                    │  │
│  │  [  ✓ Approve Estimate  ]  [  ✗ Decline  ]        │  │
│  │     (green, filled)         (red, outline)         │  │
│  └────────────────────────────────────────────────────┘  │
│                                                          │
│                   Powered by ALPHA CRM                   │
└──────────────────────────────────────────────────────────┘
```

**Technical:**
- Raw `fetch()` (no JWT interceptor) for all API calls
- Reads `id` from params, `token` from `useSearchParams()`
- Fetch: `GET /api/estimates/:id/public?token=xxx`
- Layout: `max-w-2xl mx-auto py-8 px-4`, white card, clean

**Status-dependent rendering:**
| Status | Shows |
|--------|-------|
| SENT | Full estimate + Approve/Decline buttons |
| APPROVED | Estimate + green banner: "You approved this estimate on {date}" |
| DECLINED | Estimate + muted banner: "This estimate was declined on {date}" |
| Other | "This estimate is no longer available" message |

**Approve/Decline:**
- `POST /api/estimates/:id/approve?token=xxx` or `/decline?token=xxx`
- Buttons disabled while pending
- After action: buttons replaced by status banner
- Decline: inline "Are you sure?" confirmation before submitting

**Error states:** Invalid token → "This link is invalid or has expired" | Network error → retry message

---

## Phase 9: Frontend — Lead Detail Integration

### 9.1 Update EstimatesTab in `frontend/src/pages/LeadDetailPage.tsx`

**Changes:**
- Add "New Estimate" button to tab header (right-aligned, `variant="outline" size="sm"`)
  - Navigates to `/estimates/new?lead_id=${leadId}`
  - Only for ADMIN/SALES, lead not terminal (WON/LOST/CANCELLED)
- Make rows clickable → `/estimates/${est.id}` (add `cursor-pointer hover:bg-background-light/50`)
- Estimate number as text-primary (visual link cue)
- Add "Created By" column (needs backend change: add `creator` to estimates include in `lead.controller.ts` getById)

### 9.2 Add "Create Estimate" to lead hero actions
- FileText icon + "Create Estimate" button alongside Edit/Assign/Mark Lost
- Visible for ADMIN/SALES when lead not terminal
- Navigates to `/estimates/new?lead_id=${leadId}`

---

## Phase 10: Verification

1. `npm test --workspace=backend` — all ~182 tests pass
2. `cd frontend && npx tsc --noEmit` — no type errors
3. Manual smoke test: create estimate from lead, send, open public link, approve
4. Verify lead auto-transitions (ESTIMATING on create, APPROVED on approve)

---

## Phase 11: Documentation

- Update `CLAUDE.md` — new files, routes, mark Step 5 complete
- Run `/end-session` skill to sync knowledge base

---

## Files Summary

**New (11):**
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

**Modified (8):**
- `backend/prisma/schema.prisma` — tax_rate field, StateTaxRate, AppSetting models
- `backend/src/app.ts` — register 3 new route groups
- `backend/src/seed.ts` — seed state tax rates + default setting
- `backend/src/__tests__/setup.ts` — add Prisma mocks for new models
- `backend/src/__tests__/helpers.ts` — add estimate fixtures
- `frontend/src/App.tsx` — add estimate routes + public route
- `frontend/src/pages/EstimatesPage.tsx` — replace placeholder
- `frontend/src/pages/LeadDetailPage.tsx` — wire estimate creation + clickable rows
