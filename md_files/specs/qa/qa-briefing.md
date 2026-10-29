# ALPHA CRM — QA Briefing (Deep Dive)

> **Purpose.** This document is the single, self-contained brief for building a manual QA test plan that covers the entire ALPHA CRM app. The business goal is to replace the dispatcher workflow currently done in Workiz, so every screen, state, and role path must be verified end-to-end. It was compiled by reading the Prisma schema, every backend route and controller, the frontend router and feature folders, existing Jest + Playwright suites, and the Obsidian vault.

---

## 1. Project Snapshot

| Item | Value |
|------|-------|
| Product | ALPHA CRM — FSM for SMB HVAC/plumbing/electrical contractors (5–30 techs) |
| Phase | Phase 0 MVP (dual-run validation against Workiz; no external customers yet) |
| Step progress | 12/14 steps done; **Step 9B Reports** in progress, Step 10 Polish next |
| Monorepo | npm workspaces — `backend/` (Express + Prisma), `frontend/` (React + Vite) |
| DB / Auth / Storage | Supabase (PostgreSQL, Auth, Storage) |
| Payments / Email | Stripe (test mode), Resend |
| Roles | ADMIN, SALES, DISPATCHER, TECHNICIAN |
| Numbering | Lead `L00001`, Estimate `E00001`, Job `J00001`, Invoice `I00001` |
| Design system | Charcoal `#242424`, Inter font, shadcn/ui, 12px card radius, Cal.com shadow stack |
| Test suites today | ~605 backend Jest tests, ~68 Playwright E2E specs (Chromium only) |

Key file anchors: `backend/prisma/schema.prisma`, `backend/src/routes/`, `backend/src/controllers/`, `frontend/src/App.tsx`, `frontend/src/features/`, `frontend/src/pages/tech/`, `frontend/e2e/specs/`.

---

## 2. Data Model (Prisma) at a Glance

**Entities.** User, Customer, CustomerEmail (extra emails), ServiceLocation, Lead, LeadTag, Tag, Estimate, EstimateLineItem, EstimateSendConfig, Deposit, Job, JobCharge, Invoice, Payment, Attachment, Note, TimelineEvent, PriceBookCategory, PriceBookItem, StateTaxRate, AppSetting, StripeEvent.

**Enums (exhaustive list, watch these in QA):**

- `Role`: ADMIN, SALES, DISPATCHER, TECHNICIAN
- `LeadStatus`: NEW, CONTACTED, WALKTHROUGH_SCHEDULED, WALKTHROUGH_COMPLETED, ESTIMATED, WON, LOST, CANCELLED
- `EstimateStatus`: DRAFT, SENT, PENDING, APPROVED, DECLINED, EXPIRED, CANCELLED
- `DepositStatus`: REQUESTED, PAID, VOIDED, REFUNDED
- `JobStatus`: UNASSIGNED, SCHEDULED, EN_ROUTE, ON_SITE, IN_PROGRESS, COMPLETED, CANCELLED
- `InvoiceStatus`: DRAFT, SENT, PARTIAL, PAID, VOIDED
- `PaymentMethod`: CARD, CASH, CHECK, BANK_TRANSFER
- `AttachmentContext`: WALKTHROUGH, JOB_WORK, ESTIMATE, OTHER, BEFORE_PHOTO, DURING_PHOTO, AFTER_PHOTO, ISSUE_PHOTO
- `DiscountType`: PERCENTAGE, FIXED_AMOUNT
- `PriceBookItemType`: SERVICE, MATERIAL
- Polymorphic scoping: `AttachmentEntity` = {LEAD, ESTIMATE, JOB, INVOICE}; `NoteEntity` = {CUSTOMER, LEAD, ESTIMATE, JOB, INVOICE}

**Key relationships.** Customer 1→N ServiceLocation, Lead, Job. Lead 1→N Estimate. Estimate 1→N LineItem, 1→0..1 Deposit, 1→0..1 EstimateSendConfig, 1→0..1 Job. Job 1→N JobCharge, 1→0..1 Invoice. Invoice 1→N Payment. Attachment/Note/TimelineEvent are polymorphic on `(entity_type, entity_id)`.

**Money fields** are `Decimal(12,2)`; tax rates `Decimal(5,4)`. Signatures (estimate + job complete) store base64 `signature_data` + `signature_ip` + `signature_at`.

---

## 3. Top-Level Frontend Route Map

Source: `frontend/src/App.tsx`. Guards use `<ProtectedRoute allowedRoles={...}>` around sections.

### 3.1 Public (no auth)

| Path | Component | Purpose |
|------|-----------|---------|
| `/login` | `LoginPage` | Email/password login; role-based post-login redirect (TECHNICIAN → `/tech/today`, else → `/`) |
| `/p/estimates/:id` | `PublicEstimatePage` | Customer-facing estimate with approve/decline/signature + deposit payment selection |
| `/p/invoices/:id` | `PublicInvoicePage` | Customer-facing invoice with Stripe checkout |

> Note: the backend public API paths are `/api/estimates/:id/public` and `/api/invoices/:id/public`. The client-facing URLs are `/p/...`. Public tokens are stored on `public_token` columns.

### 3.2 Technician (TECHNICIAN role only, `<TechLayout>`)

| Path | Component | Notes |
|------|-----------|-------|
| `/tech/today` | `TechTodayPage` | Today's assigned jobs, progress ring, greeting; uses `useTechJobs` (offline fallback) |
| `/tech/schedule` | `TechSchedulePage` | Tech's week view |
| `/tech/jobs` | `TechJobsPage` | All assigned jobs with filters |
| `/tech/jobs/:id` | `TechJobDetailPage` | Status state machine (Start → En route → On site → In progress → Complete), photos, activity, `TechCompleteSheet` bottom sheet |
| `/tech/profile` | `TechProfilePage` | Profile + offline/notification toggles (placeholder) |

Layout wraps all tech routes with bottom nav, Framer Motion slide transitions, swipe gesture, safe-area insets, `OfflineBanner`.

### 3.3 Desktop (ADMIN, SALES, DISPATCHER, `<AppLayout>`)

All under one `ProtectedRoute` gate; `/users` is further nested inside an `ADMIN`-only gate.

| Path | Component |
|------|-----------|
| `/` | `DashboardPage` |
| `/customers` | `CustomersPage` |
| `/customers/new`, `/customers/:id`, `/customers/:id/edit` | `CustomerFormPage` / `CustomerDetailPage` |
| `/leads`, `/leads/new`, `/leads/:id`, `/leads/:id/edit` | `LeadsPage` / `LeadFormPage` / `LeadDetailPage` |
| `/estimates`, `/estimates/new`, `/estimates/:id`, `/estimates/:id/edit` | `EstimatesPage` / `EstimateFormPage` / `EstimateDetailPage` |
| `/jobs`, `/jobs/:id` | `JobsPage` / `JobDetailPage` |
| `/schedule` | `SchedulePage` (react-big-calendar + DnD) |
| `/invoices`, `/invoices/:id` | `InvoicesPage` / `InvoiceDetailPage` |
| `/price-book` | `PriceBookPage` |
| `/reports` | `ReportsPage` (placeholder for Step 9B) |
| `/users` | `UsersPage` (ADMIN only, placeholder) |

> **QA watch-out:** the React Router gate for desktop lets SALES see every page, but backend endpoints further filter what SALES actually returns (own leads, own estimates, own-lead jobs/invoices). Verify that a SALES user navigating to e.g. `/price-book` sees a usable view or an empty/forbidden state, not an error screen — this is a likely rough edge.

### 3.4 Fallback

`*` redirects to `/` (i.e., unauthenticated users on an unknown path will be bounced to login via `ProtectedRoute`).

---

## 4. Backend API — Complete Endpoint Catalogue

All routes mounted in `backend/src/app.ts` at `/api/...`. Auth: all non-public routes require `authenticate` (Supabase JWT via Bearer). Role guards via `authorize(...)`. Validation via `validate(zodSchema)` on write routes. Rate limits: 100 req/15min global, 5/15min on `/api/auth/login` (auth limiter), plus `publicReadLimiter` and `publicActionLimiter` on public estimate/invoice endpoints.

### 4.1 Auth — `/api/auth`

- `POST /login` (auth-limited) — email/password → JWT + user profile
- `POST /logout` (auth) — invalidate session
- `POST /refresh` — token refresh
- `GET /me` (auth) — current user profile

### 4.2 Users — `/api/users` (ADMIN only)

`GET /`, `POST /`, `GET /:id`, `PATCH /:id`, `DELETE /:id` (deactivate). Creation writes to Supabase Auth + Prisma `users`. No self-registration.

### 4.3 Customers — `/api/customers`

- `GET /stats` (ADMIN/DISP/SALES)
- `GET /export` (ADMIN/DISP/SALES)
- `GET /` (ADMIN/DISP/SALES) — pagination, search (names, emails, extra_emails), filters (ad_source, state via service_locations, payment_type)
- `POST /` (ADMIN/DISP) — required: first_name, last_name, email, phone ≥10 chars
- `GET /:id` (ADMIN/DISP/SALES)
- `PATCH /:id` (ADMIN/DISP/SALES)
- `DELETE /:id` (ADMIN/DISP) — hard delete, blocked if leads/jobs exist
- `GET /:id/summary` (ADMIN/DISP/SALES) — lifetime revenue, AR, deposit, past-due counts
- `POST /:id/notes` (ADMIN/DISP/SALES)
- Locations: `POST /:id/locations`, `PATCH /:id/locations/:locId` (ADMIN/DISP/SALES), `DELETE /:id/locations/:locId` (ADMIN/DISP)

### 4.4 Leads — `/api/leads`

- `GET /stats`, `GET /assignees`, `GET /`, `POST /`, `GET /:id`, `PATCH /:id` — ADMIN/SALES/DISP
- `GET /:id/notes`, `POST /:id/notes` — also TECHNICIAN
- Actions — `POST /:id/assign` (ADMIN/DISP), `POST /:id/contact` (ADMIN/SALES/DISP), `POST /:id/mark-lost`, `POST /:id/cancel`
- Walkthrough: `POST /:id/walkthrough` (notes/duration — all + TECHNICIAN), `POST /:id/walkthrough/schedule`, `POST /:id/walkthrough/complete` (+TECHNICIAN), `POST /:id/walkthrough/cancel`
- Tags: `POST /:id/tags`, `DELETE /:id/tags/:tagId` (ADMIN/SALES/DISP)

### 4.5 Estimates — `/api/estimates`

Public:
- `GET /:id/public`
- `POST /:id/approve` (with signature)
- `POST /:id/decline`
- `POST /:id/change-payment-method`

Authenticated:
- `GET /stats`, `GET /creators`, `GET /`, `GET /:id` (ADMIN/SALES/DISP)
- `POST /`, `PATCH /:id`, `DELETE /:id` (ADMIN/SALES)
- Actions: `/:id/send`, `/:id/cancel`, `/:id/duplicate` (ADMIN/SALES); `/:id/mark-deposit-received`, `/:id/waive-deposit`, `/:id/reactivate-deposit` (ADMIN/DISP); `/:id/refund-deposit` (ADMIN only)
- Notes: `GET /:id/notes`, `POST /:id/notes` (ADMIN/SALES/DISP)

### 4.6 Jobs — `/api/jobs`

- `GET /stats` (ADMIN/DISP/TECH)
- `GET /my-today` (TECH/ADMIN/DISP)
- CRUD: `GET /`, `GET /:id` (ADMIN/DISP/TECH/SALES) / `POST /` (ADMIN/DISP/TECH) / `PATCH /:id`, `DELETE /:id` (ADMIN/DISP)
- Status actions: `/:id/assign`, `/:id/unassign`, `/:id/cancel` (ADMIN/DISP); `/:id/en-route`, `/:id/arrive`, `/:id/start`, `/:id/complete` (ADMIN/DISP/TECH)
- Charges: `GET/POST/PATCH/DELETE /:id/charges[/:chargeId]` (ADMIN/DISP/TECH)
- Notes (+SALES read), Walkthrough (urgent): `POST /:id/walkthrough`, Timeline: `GET /:id/timeline`

### 4.7 Invoices — `/api/invoices`

Public: `GET /:id/public`, `POST /:id/public/checkout`.
Auth:
- CRUD: list/detail (ADMIN/DISP/TECH/SALES), `POST /` (ADMIN/DISP/TECH), `PATCH`/`DELETE` (ADMIN/DISP only)
- Actions: `/:id/send`, `/:id/resend` (ADMIN/DISP); `/:id/void` (ADMIN only); `/:id/payments` (ADMIN/DISP/TECH)
- Notes: list (all logged-in except TECH has write); write is ADMIN/DISP/TECH

### 4.8 Price Book — `/api/price-book`

- Categories: list (ADMIN/SALES/DISP); create/update/delete (ADMIN only)
- Items: `GET /items/search` (ADMIN/SALES); list (ADMIN/SALES/DISP); create/update/delete (ADMIN/SALES)

### 4.9 Misc

- `/api/tags` — CRUD (ADMIN/SALES/DISP)
- `/api/state-tax-rates` — GET (ADMIN/SALES/DISP)
- `/api/settings/:key` — GET any role; PATCH ADMIN only
- `/api/search` — global search (all authenticated)
- `/api/attachments/:entityType/:entityId` — GET/POST/PATCH/DELETE, 25 MB multer limit, memory storage → Supabase Storage
- `/api/dashboard` — (ADMIN/DISP/SALES)
- `/api/webhooks/stripe` — raw-body Stripe webhook

### 4.10 Test-only helpers (not in production)

`POST /api/test/expire-estimates`, `PATCH /api/test/backdate-estimate/:id`, `POST /api/test/cleanup` (deletes everything with email suffix `@e2e.local`). Useful for QA seeding + teardown during manual runs in staging.

---

## 5. RBAC Matrix (Derived from Route Guards)

Legend: ✅ full, 🔸 scoped (only own/related records), ❌ denied.

| Capability | ADMIN | SALES | DISPATCHER | TECHNICIAN |
|---|:-:|:-:|:-:|:-:|
| Log in to app | ✅ desktop | ✅ desktop | ✅ desktop | ✅ tech mobile |
| User management (`/users`) | ✅ | ❌ | ❌ | ❌ |
| Settings (`/api/settings` PATCH) | ✅ | ❌ | ❌ | ❌ |
| Price-book categories: create/edit/delete | ✅ | ❌ | ❌ | ❌ |
| Price-book items: create/edit/delete | ✅ | ✅ | ❌ | ❌ |
| Customers: read/search | ✅ | ✅ | ✅ | ❌ (no API access) |
| Customers: create | ✅ | ❌ | ✅ | ❌ |
| Customers: update | ✅ | ✅ | ✅ | ❌ |
| Customers: delete | ✅ | ❌ | ✅ | ❌ |
| Leads: read | ✅ | 🔸 own assigned | ✅ | 🔸 by id only |
| Leads: create | ✅ | ✅ (auto-assigned to self) | ✅ | ❌ |
| Leads: update | ✅ | 🔸 own | ✅ | ❌ |
| Leads: assign | ✅ | ❌ | ✅ | ❌ |
| Leads: contact / mark-lost / cancel | ✅ | 🔸 own | ✅ | ❌ |
| Walkthrough schedule / cancel | ✅ | 🔸 own | ✅ | ❌ |
| Walkthrough complete / update notes | ✅ | 🔸 own | ✅ | 🔸 if performer |
| Estimates: read | ✅ | 🔸 own leads | ✅ | ❌ |
| Estimates: create / edit / delete / duplicate / send / cancel | ✅ | 🔸 own leads | ❌ | ❌ |
| Mark deposit received / waive / reactivate | ✅ | ❌ | ✅ | ❌ |
| Refund deposit | ✅ | ❌ | ❌ | ❌ |
| Estimate public approve/decline/change-method | n/a (public token) | | | |
| Jobs: read | ✅ | 🔸 own-lead jobs | ✅ | 🔸 own assigned |
| Jobs: create (standard) | ✅ | ❌ | ✅ | ✅ (API allows; flow primarily urgent) |
| Jobs: create urgent | ✅ | ❌ | ✅ | ✅ |
| Jobs: update / delete | ✅ | ❌ | ✅ | ❌ |
| Jobs: assign / unassign / cancel | ✅ | ❌ | ✅ | ❌ |
| Jobs: en-route / arrive / start / complete | ✅ | ❌ | ✅ | ✅ |
| Job charges add/edit/delete | ✅ | ❌ | ✅ | ✅ |
| Invoices: read | ✅ | 🔸 own-lead invoices | ✅ | 🔸 own-lead invoices |
| Invoices: create (from completed job) | ✅ | ❌ | ✅ | ✅ |
| Invoices: update / delete | ✅ | ❌ | ✅ | ❌ |
| Invoices: send / resend | ✅ | ❌ | ✅ | ❌ |
| Invoices: void | ✅ | ❌ | ❌ | ❌ |
| Invoices: record payment | ✅ | ❌ | ✅ | ✅ |

**QA implication.** Every role column above is a discrete test pass. In particular: SALES should see scoped lists (only their leads, estimates, jobs derived from their leads, invoices derived from those jobs); TECHNICIAN should be funnelled to `/tech/today` and never see admin/dispatcher desktop screens.

---

## 6. State Machines (Canonical)

### 6.1 Lead

```
NEW ──contact()──> CONTACTED
  │                  │
  │                  ├─schedule-walkthrough()──> WALKTHROUGH_SCHEDULED
  │                  │                              │
  │                  │                              ├─complete-walkthrough()──> WALKTHROUGH_COMPLETED
  │                  │                              └─cancel-walkthrough()────> CONTACTED
  │                  │
  │                  └─estimate.send()────> ESTIMATED (auto on first estimate SENT)
  │                                           │
  │                                           └─estimate.approve()/mark-paid── > WON
  │
  ├─mark-lost()──> LOST    (terminal)
  └─cancel()────> CANCELLED (terminal)
```

Notes: `walkthrough_needed` (bool, default true) gates estimate creation. On mark-lost / cancel, active estimates (DRAFT/SENT/PENDING) auto-cancel and REQUESTED deposits auto-void. Rescheduling a walkthrough preserves its token; reassigning the lead transparently reassigns the walkthrough performer.

### 6.2 Estimate + Deposit

```
DRAFT ─send()─> SENT ─(deposit REQUESTED + method selected)─> PENDING
  │               │                                              │
  │               │                                              ├─public approve────> APPROVED (+signature)
  │               │                                              ├─public decline────> DECLINED  (void deposit)
  │               │                                              └─expiration-cron──> EXPIRED/CANCELLED
  │               │
  │               ├─mark-deposit-received──> APPROVED (deposit PAID, lead WON)
  │               ├─waive-deposit──> APPROVED or CANCELLED (deposit VOIDED)
  │               ├─cancel()──> CANCELLED (void REQUESTED deposit)
  │               └─expiration-cron──> EXPIRED/CANCELLED
  │
  └─delete() (DRAFT only)

Deposit: REQUESTED ─(cash/check manual)─> PAID
                    ─(Stripe checkout completed)─> PAID
                    ─(refund endpoint)─> REFUNDED  (only if no job yet)
                    ─(waive/void)─> VOIDED
                    ─(reactivate on VOIDED)─> REQUESTED
```

Notable rules (see `estimate.controller.ts`, `webhook.controller.ts`, `cron/estimate-expiration.ts`):
- Send DRAFT→SENT generates `public_token`, sets `valid_until` from send_config (default 7 days). If deposit required + not waived, deposit row created with `status=REQUESTED`.
- Public approve always sets `signature_data`, `signature_ip`, `signature_at`.
- `change-payment-method` (public): switching TO CARD creates a Stripe Checkout Session + surcharge; non-card just records the choice and alerts the creator.
- Expiration cron cancels estimates past `valid_until`, voids their deposits, and reverts the lead to ESTIMATED if no other active estimates exist (never overrides WON/LOST/CANCELLED).
- Refund requires no job yet; Stripe refund runs outside the DB transaction, so a Stripe failure leaves the record unchanged.

### 6.3 Job

```
UNASSIGNED ─assign()──> SCHEDULED ──en-route()──> EN_ROUTE ──arrive()──> ON_SITE
                            │                                              │
                            ├─start()──────────────────────────────> IN_PROGRESS
                            │                                              │
                            │                                              └─complete()──> COMPLETED (+optional signature)
                            │
                            ├─unassign()──> UNASSIGNED
                            └─cancel()────> CANCELLED
```

Standard job: created only from APPROVED estimate with deposit PAID or VOIDED (blocks if REQUESTED). Inherits primary service location if not specified.
Urgent job: `is_urgent=true`, no estimate, requires `urgency_reason` + customer + location; can be created by TECHNICIAN. Charges are added via `jobs/:id/charges` and become invoice line items. An urgent job can also capture a post-hoc walkthrough note via `POST /:id/walkthrough`.
Assign conflict detection checks overlapping jobs + walkthroughs on the target technician; `force=true` skips it. All-day assign auto-computes `scheduled_end` from `scheduled_start`.

### 6.4 Invoice + Payment

```
(Job COMPLETED) ──create()──> DRAFT ─send()─> SENT ─recordPayment(partial)─> PARTIAL ─> PAID
                                  │                                             │
                                  │                                             └─resend()
                                  │
                                  └─void()──> VOIDED
```

- Invoice creation collects estimate line items + job charges, applies a **deposit credit** (creates a `Payment` with `reference=DEPOSIT-CREDIT` for audit; amount = deposit.amount − total_refunded), calculates tax (pro-rating any discount across taxable estimate items only; charges are never discounted), and computes `due_date` from `customer.payment_type` (COD, NET_15, NET_30, NET_60, EOM).
- Send generates `public_token`; resend updates `sent_at` without rotating token.
- `recordPayment` uses row-locked `SELECT FOR UPDATE`; transitions SENT→PARTIAL when remaining>0, →PAID when 0; amount cannot exceed amount_due.
- Void blocked when PAID or already VOIDED.
- Public Stripe checkout returns `{ checkout_url, surcharge_amount }` and supports PARTIAL invoices.

### 6.5 Stripe Webhook (`/api/webhooks/stripe`)

Events handled: `checkout.session.completed` (two metadata modes — deposit vs invoice), `payment_intent.*`, refund events, payment link events. Idempotency through `stripe_events.stripe_event_id` unique key — duplicates returned as `{ duplicate: true }`. On deposit completion: deposit→PAID, estimate→APPROVED, lead→WON, timeline events, emails. On invoice completion: Payment created, invoice→PAID, amount_due=0, emails.

### 6.6 Cron

`expireEstimates()` (backend/src/cron/estimate-expiration.ts): runs periodically (and is callable via `POST /api/test/expire-estimates`). Transaction-safe, continues on error per estimate.

---

## 7. Screens Explained (QA-level Detail)

### 7.1 Dashboard (`/`)
KPI cards: Jobs Today, Revenue MTD, AR Aging, Open Leads, Close Rate. Revenue chart (Recharts, 6/12-month switch). Needs-attention list: overdue invoices, expiring estimates (72h), oldest unassigned lead, late jobs, unscheduled walkthroughs. Daily schedule by technician. Activity feed: last 20 timeline events. Animated counters via `useCountUp`. Returns role-scoped data (backend `dashboard.controller.ts`).

### 7.2 Customers
- **List:** multi-filter (ad_source, state, job_type, payment_type), search by name/email/extra email/phone, sort, pagination. Stats chips (total, newThisMonth, activeLeads, activeJobs). Export CSV.
- **Detail:** tabs `Overview`, `Locations`, `Leads`, `Jobs`, `Activity`. Primary location toggle. Customer summary card (lifetime revenue, AR, past due). NewEstimateDialog shortcut.
- **Form:** create + edit. Nested service-locations array, extra emails array, ad source picker, payment_type dropdown (affects invoice due date).

### 7.3 Leads
- **List:** columns customer name, phone, service_request, status badge, walkthrough status (needs/scheduled/done), last contacted, assigned user. Filters: status multi-select, job_source, job_type, walkthrough_status, walkthrough date window. Stat chips: new this week, unassigned, won this month.
- **Form:** create (full customer inline or existing), edit restricted to service_request/notes/job_type/job_source. Zod schemas differ per mode.
- **Detail:** tabs `Overview`, `Walkthrough`, `Estimates`. Dialogs: AssignLead, Contact, MarkLost, Cancel, ScheduleWalkthrough, CancelWalkthrough. Timeline + notes in activity panel.

### 7.4 Estimates
- **List:** stats per status (draft count+value, sent, pending, approved, declined, cancelled, pending deposits). Filters: status multi-select + date range 30/90/365d. NewEstimateDialog (search lead, auto-fill).
- **Form:** line items CRUD with description/qty/unit_price/taxable/discount (per line), price-book item picker (autocomplete), tax rate, deposit % + terms, scope notes, valid-for days. Displays `EstimateDocumentView` PDF-style preview.
- **Detail:** tabs `Document`, `Activity`. Action toolbar: Send, Cancel, Duplicate; when SENT/PENDING: MarkDepositReceived, WaiveDeposit, RefundDeposit, ReactivateDeposit; when APPROVED: Create Job.
- **Public (`/p/estimates/:id`):** estimate preview, payment method picker (if deposit), Stripe Checkout trigger, signature canvas, accept/decline buttons.

### 7.5 Jobs
- **List:** columns job#, customer, address, tech, status, urgency, scheduled window. Filters by status, assignee, urgency, date. `New Urgent Job` dialog.
- **Detail:** tabs `Overview`, `Estimate / Charges`, `Activity`, `Walkthrough`. Status state-machine dropdown. AssignJob, CompleteJob (notes + signature + photos), CancelJob dialogs. Charges tab editable only for urgent jobs and non-terminal statuses.
- **Tech-mobile detail (`/tech/jobs/:id`):** status dot, one-tap progression (Start → En route → On site → In progress), elapsed timer, photo capture (before/during/after/issue), `TechCompleteSheet` bottom sheet with notes + signature. Offline-safe via service worker + `useOfflineMutation`.

### 7.6 Schedule (`/schedule`)
`react-big-calendar` + `withDragAndDrop` HOC. Views: month, week, day, agenda, plus `TechnicianGridView` multi-tech week grid. Drag-drop triggers reschedule (optimistic + rollback). Right-click `ContextMenu` (assign, reschedule, cancel). `ScheduleSearch` bar, `QuickScheduleCard` for recent jobs, `SettingsGearDropdown`. `usePlanMode` lets dispatcher preview ghost placements without committing. Conflict detection is server-side (can be forced).

### 7.7 Invoices
- **List:** stats (draft, sent, partial, paid, voided, collected-MTD). Filters by status, overdue, date range.
- **Detail:** tabs `Line Items`, `Payments`. Send/Resend, RecordPayment (amount/method/ref/notes), Void. Public link copy button. Timeline.
- **Public (`/p/invoices/:id`):** totals, payment CTA → Stripe Checkout (PARTIAL supported; surcharge displayed).

### 7.8 Price Book
Tree of categories (nested), items listed per category with cost, price, type (SERVICE/MATERIAL), taxable, active, image. Inline edit; category add/edit/delete (ADMIN only). Item image upload via Supabase Storage (≤2MB). Used by estimate line-item picker.

### 7.9 Reports (`/reports`)
Currently a placeholder — Step 9B in progress. **QA tip:** verify the placeholder doesn't 404 and that sidebar routing works for all roles.

### 7.10 Users (`/users`)
ADMIN-only. Placeholder in current codebase but route guard is live. **QA tip:** verify non-admins redirected away; the user CRUD is reachable via API.

### 7.11 Login (`/login`)
Email/password form, rate-limited (5/15min). Successful auth redirects TECHNICIAN to `/tech/today`, others to `/`. Token cached in Zustand + `localStorage`.

### 7.12 Technician suite
`TechLayout` bottom nav (Today, Schedule, Jobs, Alerts [disabled], More). Framer Motion AnimatePresence between tabs, horizontal swipe gestures, `OfflineBanner`, `TechProfilePage` placeholder. Offline DB via Dexie (verify jobs list still renders when offline), `useTechJobs` hook exposes `isOfflineFallback`.

---

## 8. Cross-Cutting Behaviours

- **Timeline events.** Written by every meaningful action (create/assign/status change/approve/decline/deposit paid/void/refund/invoice sent/payment received). Entity-scoped via `(entity_type, entity_id)`.
- **Attachments.** Polymorphic on `AttachmentEntity`; `AttachmentContext` tags purpose (WALKTHROUGH, BEFORE_PHOTO…). 25 MB upload cap, multer in-memory, written to Supabase Storage. QA: upload types accepted, oversized rejection, public URL lifecycle.
- **Notes.** Polymorphic on `NoteEntity`. Writable by roles listed above.
- **Global search** (`/api/search`): searches leads, customers, jobs, estimates by name/number. Cmd+K palette in `AppLayout`.
- **Email (`lib/email.ts` via Resend).** Fire-and-forget. Events firing email (full list inferred from controllers):
  - Estimate: send, approved confirmation, decline alert, deposit receipts (Stripe + manual), deposit paid alert to creator, payment method selected alert, refund notification.
  - Lead/walkthrough: scheduled, rescheduled, cancelled, completed (all fan out to customer + performer + owner).
  - Job: assignment to tech, first-schedule email to customer, reschedule, en-route.
  - Invoice: sent, payment received, fully paid, internal payment alert.
- **Numbering.** `L`, `E`, `J`, `I` + 5-digit zero-padded monotonically increasing counter. QA: no collisions under concurrent creates, correct format displayed everywhere.
- **Idempotency.** StripeEvent unique constraint, payment row-locking on invoice update.
- **Rate limits.** 100 req/15min global, 5/15min auth login, public read/action limiters on public estimate/invoice endpoints.

---

## 9. Known / Likely Risk Areas (for focused QA)

From vault learnings and spotted in code:

1. **Invoice OVERDUE is frontend-computed** — not a DB enum. Easy to get wrong on list filter.
2. **TanStack Query cache invalidation across modules** — an action in one module (e.g., approving an estimate) must invalidate leads list, jobs list, dashboard, etc. Stale data is a known learning.
3. **Walkthrough-needed gate** — estimate send is blocked if lead is in `WALKTHROUGH_SCHEDULED` or NEW; QA should hit every gate path.
4. **Deposit-method switch to CARD** — creates a new Stripe Checkout session each time; verify no duplicate deposits/payments if customer switches back and forth.
5. **Refund window** — refund only allowed pre-job; after job creation, refund must go out-of-band. Verify UI hides the button once a job exists.
6. **Expiration cron** — both on a schedule and via the test endpoint. Verify lead doesn't revert out of WON/LOST/CANCELLED.
7. **Role leakage on frontend** — SALES has access to the desktop gate for every page; the SALES experience for pages like Price Book, Users, Reports, Dashboard-global should be verified explicitly.
8. **SALES auto-assign on lead create** — if a dispatcher creates on behalf of a sales rep, assignment semantics must match the API behavior.
9. **Urgent job → invoice path** — invoice calculation includes job charges; tax proration is only on estimate items.
10. **Public token expiry + revisit UX** — what happens if a customer opens an expired public link.
11. **Deposit credit on invoice** — always applies full net deposit (minus refunds). Verify display matches.
12. **Schedule DnD + conflict detection** — dispatcher force-override, plan mode ghost events, drag across day boundaries, multi-tech resource grid.
13. **Offline tech mobile** — Dexie cache, service-worker sync: verify job detail renders from cache, note/photo queue survives reload, sync happens on reconnect.
14. **Email failures silent** — all email calls are fire-and-forget. Verify relevant UI cues exist so QA can tell whether email "should have" been sent.
15. **Signature capture** — estimate approval AND job completion both capture signature; QA needs to verify render + IP + timestamp + PDF display.
16. **Attachments lifecycle** — delete from UI must also clear Supabase Storage (verify no orphaned files).
17. **StateTaxRate lookup** — tax rate on estimate depends on service_location.state; verify when state is changed mid-estimate.
18. **Rate-limit UX** — hitting 5 failed logins in 15 minutes must surface a clear error.

---

## 10. Existing Test Coverage Snapshot

| Suite | Scope | Strengths | Gaps for manual QA |
|---|---|---|---|
| Backend Jest (`backend/src/__tests__/*.test.ts`, ~605 tests) | Endpoints + role guards + state transitions + validation, plus Stripe webhook + expiration cron | Strong on happy path + common guards | Doesn't cover real email delivery, real Stripe sessions, browser behaviour |
| Playwright E2E (`frontend/e2e/specs/*`, ~68 specs) | Lead lifecycle (L-01 → L-33), estimate CRUD/send/approve/decline/deposit/refund/expire, jobs CRUD/assign/complete/charges, invoices workflow, role-perspective day-01…day-08, schedule DnD + resize + overflow, smoke, visual screenshots | Good happy-path + guard coverage | Chromium-only, online-only, no real mobile viewport matrix (real hardware: see the [real-device release checklist](real-device-release-checklist.md)), no accessibility sweep, no performance/load tests |
| Playwright setup | baseURL `http://localhost:5173`, Chromium only, `workers=1`, retries=1, admin session via `storageState` in `e2e/.auth/admin.json` | | |

**Manual QA should concentrate on:** Safari/Firefox, real-device mobile (run the [real-device release checklist](real-device-release-checklist.md); the separate technician app is retired, so technicians and office staff use the same main app on phones), offline flows, concurrent multi-user (e.g., dispatcher reassigns while tech is en-route), real email delivery checks, real Stripe test mode round trips, accessibility, content overflow/long-string rendering.

---

## 11. Obsidian Vault Pointers

Path: `C:\Users\ranro\Documents\ALPHA_CRM\Vault\ALPHA_CRM_VAULT`.
- `index.md` — MOC, read first.
- `Modules/` — 13 hub pages (Auth, Customers, Leads, Estimates, Jobs, Schedule, Invoices, Deposits/Stripe, Price Book, Attachments, Tech Mobile, Notifications, Users).
- `Workflows/` — Standard-Flow, Urgent-Flow, role-perspective notes + 2 canvas diagrams.
- `Decisions/` (12), `Learnings/` (8), `Ideas/` (10), `Status/Current-Focus.md`, `Bases/`.
- `log.md` — append-only session log.
- Latest focus (2026-04-14 / -20): Step 7 Tech Mobile merged; Step 9A Dashboard done; Step 9B Reports in progress; Step 10 Polish next. Parked KIs: KI-003 customers layout, KI-004 scheduler dept filter.

Also see `md_files/plans/miro-flows/*.mermaid` — authoritative lifecycle diagrams for full flow, urgent flow, and each role's journey (admin, dispatcher, technician, customer).

---

## 12. Workiz Parity Checklist (Dispatcher Perspective)

The goal is to allow a dispatcher to stop using Workiz. The dispatcher's daily routines — mapped to ALPHA screens — look like this:

| Workiz task | ALPHA screen | Actions QA must exercise |
|---|---|---|
| Inbound lead triage | `/leads` list + LeadDetail | Create (inline customer), assign to SALES, contact, schedule walkthrough with conflict detect |
| Quote generation | `/estimates/new` + `/estimates/:id` | Line items (service + material), tax, discount, deposit options, send to customer |
| Quote approval follow-up | Activity feed on `/leads/:id` + `/estimates/:id` | See public approval, deposit method chosen, webhook processing |
| Deposit handling (card/manual) | `MarkDepositReceivedDialog`, Stripe public flow | Manual mark, waive, reactivate, refund (pre-job only) |
| Job creation | "Create Job" on approved estimate + `NewUrgentJobDialog` | Standard flow from estimate, urgent flow without |
| Scheduling & dispatch | `/schedule` | Drag-drop, multi-tech grid, conflict override, plan mode, reschedule emails |
| Tech live status | `JobDetailPage` overview + Dashboard schedule widget | En-route, arrive, start, complete transitions; timeline visibility |
| Invoice generation | `InvoiceDetailPage` | Create from completed job, deposit credit, tax/discount display, send |
| Payment capture | Invoice actions + public Stripe checkout | Record partial/full, multi-method, void (ADMIN), public Stripe flow |
| Customer ledger | `CustomerDetailPage` + `/api/customers/:id/summary` | Lifetime revenue, AR aging, past-due counts |
| Reports (EOD/weekly) | `/reports` (WIP) + Dashboard | Treat as placeholder; verify not broken |
| User admin | `/users` (placeholder) + Supabase | Smoke only; admin creates user via API today |

Every row above is a candidate "scenario group" in the manual QA test plan to follow.

---

## 13. What to Produce Next

A manual QA test plan organized by:

1. Smoke (login, nav, role routing).
2. Per-module happy path (Customers → Leads → Estimates → Jobs → Invoices → Schedule → Price Book → Dashboard → Reports → Users → Tech Mobile → Public pages).
3. State-transition matrix tests for Lead, Estimate, Deposit, Job, Invoice (covering every arrow in section 6).
4. RBAC matrix tests (one pass per role, explicitly verifying denied surfaces).
5. Workiz-parity dispatcher scenarios (section 12).
6. Cross-cutting: notes, attachments, timeline, search, email triggers (with Resend sandbox), Stripe (test mode), offline tech, rate limits, 404/guard behavior.
7. Negative + edge cases: validation, long text, date boundary, conflict detection, concurrency, expired tokens, network drop.
8. Non-functional: accessibility, browser compatibility, mobile responsiveness, performance sanity.

Each test case should cite the endpoint + state precondition + expected timeline/email/side effect using the state machines in section 6, so failures are fully reproducible.

---

*Compiled from live source code in `alpha_crm/` on 2026-04-21.*
