# Step 6A Implementation Plan — Job Management Backend

## Context

Step 5 (Estimates & Deposits) is complete with 289 passing tests. The Job and JobCharge Prisma models exist in the schema but no controller, routes, or tests are built yet. Three fields are missing from the Job model (`started_at`, `estimated_duration`, `completion_notes`). This plan implements the full job management backend: schema migration, deposit gate, job CRUD, status transitions, charges, notes, email, and ~90 tests.

**Source specs:** `md_files/plans/jobs/Step6-Job-Management-Plan.md` (approved spec) + `md_files/plans/jobs/Step6A-Job-Backend-Plan.md` (implementation plan)

---

## Decisions Made

| Question | Decision | Rationale |
|----------|----------|-----------|
| DISPATCHED status | **Skip for MVP** | Schema already omits it; simplifies state machine |
| Tech note visibility | **Own jobs only** | Consistent with "assigned only" principle |
| Job numbering | **Global sequential** `JOB-YYYY-NNNN` | Same as estimates |
| Timeline for charges | **No** — status transitions only | Consistent with estimates (no timeline for line item edits) |
| Charges on standard jobs | **No** — urgent only | Standard jobs inherit from estimate; avoids quote-vs-charge confusion |
| Delete allowed statuses | **UNASSIGNED only**, no invoice | CANCELLED jobs stay for audit trail |
| Transition endpoints | **Individual actions** (`/assign`, `/start`, etc.) | Clearer auth/validation per action, matches estimate pattern |
| Job stats | **Count-only** per status | Jobs have no `total_amount` field; monetary data lives on estimate/invoice |

---

## Files Affected (Ordered)

| # | File | Action |
|---|------|--------|
| 1 | `backend/prisma/schema.prisma` | MODIFY — add 3 fields to Job model |
| 2 | `backend/src/lib/email.ts` | MODIFY — add `sendJobAssignmentEmail` |
| 3 | `backend/src/controllers/estimate.controller.ts` | MODIFY — add `markDepositPaid` handler |
| 4 | `backend/src/routes/estimate.routes.ts` | MODIFY — add mark-deposit-paid route |
| 5 | `backend/src/controllers/job.controller.ts` | **CREATE** — full controller (~500 lines) |
| 6 | `backend/src/routes/job.routes.ts` | **CREATE** — all routes |
| 7 | `backend/src/app.ts` | MODIFY — wire job routes |
| 8 | `backend/src/__tests__/setup.ts` | MODIFY — add job/jobCharge/deposit mocks + email mock |
| 9 | `backend/src/__tests__/helpers.ts` | MODIFY — add job fixtures |
| 10 | `backend/src/__tests__/estimates.test.ts` | MODIFY — add ~9 mark-deposit-paid tests |
| 11 | `backend/src/__tests__/jobs.test.ts` | **CREATE** — ~90 tests |

---

## Phase 1: Schema Migration

Add 3 nullable fields to Job model in `schema.prisma` (after `cancelled_reason`):

```prisma
started_at          DateTime?       // Auto-set on IN_PROGRESS transition
estimated_duration  Int?            // Minutes — for calendar block sizing
completion_notes    String?         // Required on completion
```

Migration via Supabase MCP (same pattern as previous steps). All nullable = non-breaking.

**Gate:** `npx prisma validate` + `npx prisma generate` + existing 289 tests pass.

---

## Phase 2: Email — `sendJobAssignmentEmail`

Add to `backend/src/lib/email.ts` following the existing fire-and-forget pattern:

- **Params:** `to`, `technicianName`, `jobNumber`, `customerName`, `scheduledStart?`, `serviceAddress`, `scopeNotes?`
- **Subject:** `"New Job Assignment: ${jobNumber}"`
- **Guard:** `if (!resend) { logger.warn(...); return; }`
- **Pattern:** Same HTML template with `wrapHtml()`, plain text fallback, errors caught internally

**Gate:** Function exported, follows existing pattern.

---

## Phase 3: Mark Deposit Paid (Estimate Module)

### `estimate.controller.ts` — add `markDepositPaid` handler:
1. Fetch estimate by ID with `{ id, status, estimate_number, deposit: { id, status } }`
2. Validate: exists (404), status APPROVED (400), deposit exists (400), deposit REQUESTED (400 if already PAID)
3. `Promise.all`: update deposit (`status=PAID`, `paid_at=now()`) + create timeline event (`DEPOSIT_PAID`)
4. Return updated estimate with `estimateDetailSelect`

### `estimate.routes.ts` — add route:
```
POST /:id/mark-deposit-paid  →  authorize('ADMIN','DISPATCHER')  →  markDepositPaid
```

**Gate:** Existing 289 tests pass + new ~9 mark-deposit-paid tests pass.

---

## Phase 4: Job Controller — Helpers & Select Objects

**File:** `backend/src/controllers/job.controller.ts` (NEW)

### `generateJobNumber(tx)` — exact replica of estimate pattern:
- Query `tx.job.findFirst({ where: { job_number: { startsWith: 'JOB-YYYY-' } }, orderBy: { job_number: 'desc' } })`
- Parse last number, increment, pad to 4 digits
- **Must run inside `$transaction`**

### `canAccessJob(job, req)`:
- Admin/Dispatcher → always true
- Technician → `job.assigned_to === req.user.id`
- Sales → `job.estimate?.lead?.assigned_to === req.user.id` (read-only)

### Select objects:
- **`jobListSelect`:** id, job_number, status, is_urgent, scheduled_start, scheduled_end, created_at + customer(name), assigned_user(name), service_location(city/state/address)
- **`jobDetailSelect`:** All fields + customer(+email/phone), assigned_user(+email), service_location(full), estimate(+line_items+deposit), charges, invoice

### Zod schemas:
- **`createJobSchema`** — `superRefine`: if `is_urgent` → require customer_id + service_location_id + urgency_reason; else → require estimate_id
- **`updateJobSchema`** — scope_notes?, service_location_id?, estimated_duration?
- **`assignJobSchema`** — assigned_to (uuid, required)
- **`completeJobSchema`** — completion_notes (string, required, min 1)
- **`cancelJobSchema`** — cancelled_reason (string, required, min 1)
- **`addChargeSchema`** — description, quantity(positive), unit_price(non-negative), is_taxable?
- **`updateChargeSchema`** — all charge fields optional
- **`noteSchema`** — content (string, required, min 1)

---

## Phase 5: Job Controller — CRUD Handlers

### `create` (POST /) — Two modes:

**Standard** (`estimate_id` provided):
1. Fetch estimate with status, lead (customer_id, service location), deposit
2. Validate: APPROVED (400), deposit PAID or absent (400 if REQUESTED)
3. `$transaction`: generate number → create job (auto-populate from estimate/lead) → timeline event
4. Catch P2002 on estimate_id → return 409 "A job already exists for this estimate"

**Urgent** (`is_urgent=true`):
1. Validate customer exists, service location exists & belongs to customer
2. `$transaction`: generate number → create job → timeline event

### `list` (GET /):
- Pagination, search (job_number, customer name), filters (status multi-value, assigned_to, customer_id, is_urgent, date range)
- TECHNICIAN auto-filter: `where.assigned_to = req.user.id`
- SALES auto-filter: `where.estimate = { lead: { assigned_to: req.user.id } }`
- Bundled stats via `Promise.all`: count per status (5 counts)

### `getById` (GET /:id):
- Fetch with `jobDetailSelect` + estimate.lead.assigned_to for SALES check
- `canAccessJob()` guard

### `update` (PATCH /:id):
- UNASSIGNED/SCHEDULED only (400 otherwise)
- Admin/Dispatcher only (route middleware)
- Fields: scope_notes, service_location_id, estimated_duration

### `remove` (DELETE /:id):
- UNASSIGNED only, no invoice (400 otherwise)
- Admin/Dispatcher only

---

## Phase 6: Job Controller — Status Actions

| Action | From → To | Requirements | Auto-set | Who |
|--------|-----------|-------------|----------|-----|
| `assign` | UNASSIGNED/SCHEDULED | assigned_to must be active TECHNICIAN | — | Admin/Dispatcher |
| `unassign` | SCHEDULED → UNASSIGNED | — | Clear assigned_to, schedule | Admin/Dispatcher |
| `start` | SCHEDULED → IN_PROGRESS | — | `started_at = now()` | Assigned tech or Admin/Dispatcher |
| `complete` | IN_PROGRESS → COMPLETED | `completion_notes` required | `completed_at = now()` | Assigned tech or Admin/Dispatcher |
| `cancel` | UNASSIGNED/SCHEDULED/IN_PROGRESS → CANCELLED | `cancelled_reason` required | `cancelled_at = now()` | Admin/Dispatcher |

Every transition creates a TimelineEvent. `assign` also fires `sendJobAssignmentEmail` (fire-and-forget, after response).

---

## Phase 7: Job Controller — Charges, Notes, Timeline

### Charges (urgent jobs only):
- `getCharges` — list ordered by sequence
- `addCharge` — validate `is_urgent=true` (400 if standard), not COMPLETED/CANCELLED, auto-calc line_total, auto-increment sequence
- `updateCharge` — recalculate line_total if qty/price changed
- `removeCharge` — delete + renumber remaining sequences

### Notes (polymorphic, entity_type=JOB):
- `getNotes` / `addNote` — same pattern as estimates, with `canAccessJob()` check
- SALES can read (GET) but not write (POST excluded from route authorize)

### Timeline:
- `getTimeline` — list events for entity_type=JOB, entity_id=job.id, ordered by created_at desc

---

## Phase 8: Routes & Wiring

### `backend/src/routes/job.routes.ts` (NEW):
```
router.use(authenticate)

GET    /stats                          → ADMIN,DISPATCHER,TECHNICIAN
GET    /                               → ADMIN,DISPATCHER,TECHNICIAN,SALES
POST   /                               → ADMIN,DISPATCHER,TECHNICIAN  + validate(createJobSchema)
GET    /:id                            → ADMIN,DISPATCHER,TECHNICIAN,SALES
PATCH  /:id                            → ADMIN,DISPATCHER  + validate(updateJobSchema)
DELETE /:id                            → ADMIN,DISPATCHER

POST   /:id/assign                     → ADMIN,DISPATCHER  + validate(assignJobSchema)
POST   /:id/unassign                   → ADMIN,DISPATCHER
POST   /:id/start                      → ADMIN,DISPATCHER,TECHNICIAN
POST   /:id/complete                   → ADMIN,DISPATCHER,TECHNICIAN  + validate(completeJobSchema)
POST   /:id/cancel                     → ADMIN,DISPATCHER  + validate(cancelJobSchema)

GET    /:id/charges                    → ADMIN,DISPATCHER,TECHNICIAN
POST   /:id/charges                    → ADMIN,DISPATCHER,TECHNICIAN  + validate(addChargeSchema)
PATCH  /:id/charges/:chargeId          → ADMIN,DISPATCHER,TECHNICIAN  + validate(updateChargeSchema)
DELETE /:id/charges/:chargeId          → ADMIN,DISPATCHER,TECHNICIAN

GET    /:id/notes                      → ADMIN,DISPATCHER,TECHNICIAN,SALES
POST   /:id/notes                      → ADMIN,DISPATCHER,TECHNICIAN  + validate(noteSchema)

GET    /:id/timeline                   → ADMIN,DISPATCHER,TECHNICIAN,SALES
```

### `backend/src/app.ts`:
Add `app.use('/api/jobs', jobRoutes)` after estimates route.

---

## Phase 9: Test Infrastructure

### `setup.ts` — add mocks:
- `job`: findMany, findFirst, findUnique, create, update, delete, count
- `jobCharge`: findMany, findFirst, create, update, updateMany, delete, deleteMany
- `deposit`: update, findUnique
- Email: `sendJobAssignmentEmail` mock

### `helpers.ts` — add fixtures:
- `ESTIMATE_APPROVED_FIXTURE` (status APPROVED + deposit PAID)
- `JOB_FIXTURE` (standard job, UNASSIGNED, linked to approved estimate)
- `URGENT_JOB_FIXTURE` (is_urgent=true, no estimate)
- `JOB_CHARGE_FIXTURE` (single charge on urgent job)

---

## Phase 10: Tests (~90 total)

### `estimates.test.ts` — add ~9 mark-deposit-paid tests:
- Admin/Dispatcher can mark paid ✓
- Sales/Tech blocked (403)
- Estimate not found (404)
- Not APPROVED (400), no deposit (400), already PAID (400)
- Unauthenticated (401)

### `jobs.test.ts` — ~86 tests:

| Category | # | Key scenarios |
|----------|---|---------------|
| List | 10 | Pagination, search, filters, TECH auto-filter, SALES auto-filter, stats |
| Create standard | 10 | Success, deposit gate (PAID ok, REQUESTED blocked, no deposit ok), non-APPROVED blocked, duplicate 409, TECH/SALES blocked |
| Create urgent | 7 | Success, TECH can create, missing fields blocked, invalid FK |
| Get by ID | 5 | Detail, TECH own ok, TECH other 403, SALES read-only, 404 |
| Update | 5 | Valid, IN_PROGRESS blocked, TECH blocked, 404 |
| Delete | 5 | UNASSIGNED ok, SCHEDULED blocked, has invoice blocked, TECH blocked |
| Assign | 6 | Valid, non-TECH role blocked, inactive blocked, COMPLETED blocked, email sent |
| Unassign | 3 | SCHEDULED→UNASSIGNED, clears fields, wrong status blocked |
| Start | 5 | SCHEDULED→IN_PROGRESS, sets started_at, wrong status, non-assigned tech |
| Complete | 5 | IN_PROGRESS→COMPLETED, notes required, sets completed_at, wrong status |
| Cancel | 5 | Various→CANCELLED, reason required, COMPLETED blocked |
| Charges | 10 | Add/update/remove, standard job blocked, COMPLETED blocked, sequence mgmt |
| Notes | 4 | Get, add, TECH own job, SALES no-write |
| Timeline | 2 | List events, access control |
| Auth | 4 | 401 unauthenticated, role-based 403s |

---

## Phase 11: Documentation

- Update `CLAUDE.md`: directory structure, test count (~380), email functions (5)
- Update `memory/MEMORY.md`: mark Step 6A complete
- Update `memory/codebase.md`: add job controller/routes/tests

---

## Verification

1. `npx prisma validate` — schema valid
2. `npm test --workspace=backend` — all ~380 tests pass (289 existing + ~9 deposit + ~86 jobs)
3. Manual curl: create standard job, create urgent job, full status transition cycle
4. Verify deposit gate: REQUESTED deposit blocks → mark paid → unblocks job creation
5. Verify TECHNICIAN isolation: can only see/act on assigned jobs
6. Verify SALES isolation: read-only on jobs from their leads

---

## Commit Strategy (branch: `step-6a/job-backend`)

1. `feat: add started_at, estimated_duration, completion_notes to Job schema`
2. `feat: add sendJobAssignmentEmail to email service`
3. `feat: add markDepositPaid handler to estimate controller`
4. `feat: implement job controller with CRUD, status actions, charges, notes`
5. `feat: add job routes and wire into app`
6. `test: add job management backend tests (~90 tests)`
7. `docs: update CLAUDE.md and memory for Step 6A completion`
