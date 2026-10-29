# Step 6A Plan — Job Management Backend

## Context

Step 6 builds the Job Management module. Per the approved spec (`md_files/plans/jobs/Step6-Job-Management-Plan.md`), we're splitting into three deliverables:
- **Step 6A** (this plan): Schema migration + full backend (controller, routes, tests, email)
- **Step 6B**: All frontend pages (JobsPage, JobDetailPage, creation flows, charges UI)
- **Step 6.1**: Scheduling & Calendar (backend + frontend — separate step)

**Decisions made:**
- DISPATCHED status: **skipped** for MVP (flow is UNASSIGNED → SCHEDULED → IN_PROGRESS → COMPLETED)
- Deposit gate: enforce + add **manual "Mark Deposit Paid"** button (Admin/Dispatcher)
- Completion notes: **required** to complete a job
- No extra charges on standard jobs beyond estimate line items
- Schedule is a **separate page** (Step 6.1)

---

## 1. Schema Migration

**File:** `backend/prisma/schema.prisma`

Add 3 fields to Job model:
```
started_at         DateTime?           // Auto-set on IN_PROGRESS transition
estimated_duration Int?                // Minutes — for calendar block sizing (Step 6.1)
completion_notes   String?             // Required on completion
```

No enum changes (DISPATCHED skipped). Migration via Supabase MCP (same pattern as previous steps).

---

## 2. Mark Deposit Paid (Estimate Module Addition)

**Files:**
- `backend/src/controllers/estimate.controller.ts` — add `markDepositPaid` handler
- `backend/src/routes/estimate.routes.ts` — add `POST /api/estimates/:id/mark-deposit-paid`
- `backend/src/__tests__/estimates.test.ts` — add tests

**Logic:**
- Only APPROVED estimates with a deposit in REQUESTED status
- Admin/Dispatcher only
- Sets deposit `status = PAID`, `paid_at = now()`
- Creates timeline event
- This unblocks standard job creation

---

## 3. Job Controller

**File:** `backend/src/controllers/job.controller.ts`

### Select Objects
- `jobListSelect` — job_number, status, is_urgent, customer (name), assigned_user (name), service_location (city/state), scheduled_start, created_at
- `jobDetailSelect` — all above + scope_notes, estimate (with line_items), charges, invoice, completion_notes, estimated_duration, timestamps

### Handlers

| Handler | Method | Description |
|---------|--------|-------------|
| `list` | GET / | Paginated, search (job_number, customer name), filters (status multi-value, assigned_to, customer_id, is_urgent, date range). TECHNICIAN auto-filtered to assigned. SALES sees jobs from their leads (read-only). Bundled stats via `Promise.all`. |
| `create` | POST / | Two modes: **standard** (`estimate_id` provided → validate APPROVED + deposit PAID or no deposit, auto-populate from estimate/lead) or **urgent** (`is_urgent=true`, `customer_id` + `service_location_id` + `urgency_reason` required). Auto-generates `JOB-YYYY-NNNN` inside `$transaction`. Creates timeline event. |
| `getById` | GET /:id | Full detail with includes. TECHNICIAN guard (own jobs only). SALES guard (jobs from their leads). |
| `update` | PATCH /:id | Update `scope_notes`, `service_location_id`, `estimated_duration`. Only UNASSIGNED/SCHEDULED status. Admin/Dispatcher only. |
| `remove` | DELETE /:id | Only UNASSIGNED jobs with no invoice. Admin/Dispatcher only. |
| `assign` | POST /:id/assign | Set `assigned_to` (must be active TECHNICIAN user). UNASSIGNED/SCHEDULED only. Admin/Dispatcher only. Timeline event. |
| `unassign` | POST /:id/unassign | Clear `assigned_to`, `scheduled_start`, `scheduled_end`. SCHEDULED → UNASSIGNED. Admin/Dispatcher only. Timeline event. |
| `start` | POST /:id/start | SCHEDULED → IN_PROGRESS. Sets `started_at = now()`. Only assigned tech or Admin/Dispatcher. Timeline event. |
| `complete` | POST /:id/complete | IN_PROGRESS → COMPLETED. Requires `completion_notes`. Sets `completed_at = now()`. Only assigned tech or Admin/Dispatcher. Timeline event. |
| `cancel` | POST /:id/cancel | UNASSIGNED/SCHEDULED/IN_PROGRESS → CANCELLED. Requires `cancelled_reason`. Sets `cancelled_at = now()`. Admin/Dispatcher only. Timeline event. |
| `getCharges` | GET /:id/charges | List charges ordered by sequence. |
| `addCharge` | POST /:id/charges | Add charge (description, quantity, unit_price, is_taxable). Auto-calculate `line_total`. Only urgent jobs, not COMPLETED/CANCELLED. |
| `updateCharge` | PATCH /:id/charges/:chargeId | Update charge fields. Recalculate `line_total`. |
| `removeCharge` | DELETE /:id/charges/:chargeId | Remove charge. Only if job not COMPLETED/CANCELLED. |
| `getNotes` | GET /:id/notes | Polymorphic notes (entity_type=JOB). Same pattern as estimates. |
| `addNote` | POST /:id/notes | Add note. Same pattern as estimates. |
| `getTimeline` | GET /:id/timeline | List timeline events for this job. |

### Helper Functions
- `generateJobNumber(tx)` — adapts `generateEstimateNumber()` pattern for `JOB-YYYY-NNNN`
- `canAccessJob(job, req)` — RBAC: Admin/Dispatcher see all, Technician sees assigned, Sales sees jobs from their leads

### RBAC Summary
| Role | List | Create | Update | Actions | Charges | Notes |
|------|------|--------|--------|---------|---------|-------|
| Admin | All | Standard + Urgent | Yes | All | Add/Edit/Remove | Read/Write |
| Dispatcher | All | Standard + Urgent | Yes | All | Add/Edit/Remove | Read/Write |
| Technician | Assigned only | Urgent only | No | Start, Complete | Add (urgent only) | Read/Write |
| Sales | From their leads | No | No | No | No | Read only |

---

## 4. Job Routes

**File:** `backend/src/routes/job.routes.ts`

```
router.use(authenticate);

// Stats/lookups before :id
router.get('/stats', authorize('ADMIN','DISPATCHER','TECHNICIAN'), getStats);

// CRUD
router.get('/', authorize('ADMIN','DISPATCHER','TECHNICIAN','SALES'), list);
router.post('/', authorize('ADMIN','DISPATCHER','TECHNICIAN'), validate(createJobSchema), create);
router.get('/:id', authorize('ADMIN','DISPATCHER','TECHNICIAN','SALES'), getById);
router.patch('/:id', authorize('ADMIN','DISPATCHER'), validate(updateJobSchema), update);
router.delete('/:id', authorize('ADMIN','DISPATCHER'), remove);

// Status actions
router.post('/:id/assign', authorize('ADMIN','DISPATCHER'), validate(assignJobSchema), assign);
router.post('/:id/unassign', authorize('ADMIN','DISPATCHER'), unassign);
router.post('/:id/start', authorize('ADMIN','DISPATCHER','TECHNICIAN'), start);
router.post('/:id/complete', authorize('ADMIN','DISPATCHER','TECHNICIAN'), validate(completeJobSchema), complete);
router.post('/:id/cancel', authorize('ADMIN','DISPATCHER'), validate(cancelJobSchema), cancel);

// Charges (nested)
router.get('/:id/charges', authorize('ADMIN','DISPATCHER','TECHNICIAN'), getCharges);
router.post('/:id/charges', authorize('ADMIN','DISPATCHER','TECHNICIAN'), validate(addChargeSchema), addCharge);
router.patch('/:id/charges/:chargeId', authorize('ADMIN','DISPATCHER','TECHNICIAN'), validate(updateChargeSchema), updateCharge);
router.delete('/:id/charges/:chargeId', authorize('ADMIN','DISPATCHER','TECHNICIAN'), removeCharge);

// Notes (nested)
router.get('/:id/notes', authorize('ADMIN','DISPATCHER','TECHNICIAN','SALES'), getNotes);
router.post('/:id/notes', authorize('ADMIN','DISPATCHER','TECHNICIAN'), validate(noteSchema), addNote);

// Timeline
router.get('/:id/timeline', authorize('ADMIN','DISPATCHER','TECHNICIAN','SALES'), getTimeline);
```

**Wire into:** `backend/src/app.ts` — add `app.use('/api/jobs', jobRoutes);`

---

## 5. Email — Job Assignment Notification

**File:** `backend/src/lib/email.ts`

Add `sendJobAssignmentEmail(params)`:
- **Params:** `to`, `technicianName`, `jobNumber`, `customerName`, `scheduledStart` (optional), `serviceAddress`, `scopeNotes`
- **Subject:** `"New Job Assignment: ${jobNumber}"`
- **Body:** Job details, customer, address, schedule, scope
- **Pattern:** Same fire-and-forget as existing estimate emails
- Called from `assign` handler (after successful assignment)

---

## 6. Zod Validation Schemas

Defined at the top of `job.controller.ts` (same pattern as estimate controller):

| Schema | Fields |
|--------|--------|
| `createJobSchema` | `estimate_id?` (uuid), `customer_id?` (uuid), `service_location_id?` (uuid), `is_urgent?` (boolean), `urgency_reason?` (string), `scope_notes?` (string), `estimated_duration?` (int, positive) |
| `updateJobSchema` | `scope_notes?`, `service_location_id?` (uuid), `estimated_duration?` (int) |
| `assignJobSchema` | `assigned_to` (uuid, required) |
| `completeJobSchema` | `completion_notes` (string, required, min 1 char) |
| `cancelJobSchema` | `cancelled_reason` (string, required, min 1 char) |
| `addChargeSchema` | `description` (string), `quantity` (number, positive), `unit_price` (number, non-negative), `is_taxable?` (boolean) |
| `updateChargeSchema` | All charge fields optional |
| `noteSchema` | `content` (string, required, min 1 char) |

---

## 7. Test Fixtures & Setup Updates

**File:** `backend/src/__tests__/setup.ts`
- Add `job` mock methods to prisma mock (findMany, findUnique, create, update, delete, count, aggregate)
- Add `jobCharge` mock methods
- Mock `sendJobAssignmentEmail` in email mock

**File:** `backend/src/__tests__/helpers.ts`
- Add `JOB_FIXTURE`, `URGENT_JOB_FIXTURE`, `JOB_CHARGE_FIXTURE` constants
- Add `ESTIMATE_APPROVED_FIXTURE` (with APPROVED status + deposit PAID)

**File:** `backend/src/__tests__/jobs.test.ts` — target ~90 tests

| Category | Tests |
|----------|-------|
| List | Pagination, search, status filter, assigned_to filter, is_urgent filter, date range, TECHNICIAN auto-filter, SALES auto-filter, bundled stats |
| Create (standard) | From approved estimate, auto-populate fields, auto-generate number, deposit PAID check, deposit REQUESTED blocks, no deposit allows, duplicate estimate_id blocked (409), invalid estimate_id, non-APPROVED estimate |
| Create (urgent) | With all fields, missing urgency_reason, missing customer_id, tech can create urgent |
| Get by ID | Full detail, TECHNICIAN own job, TECHNICIAN other's job (403), SALES read-only, not found (404) |
| Update | Valid fields, IN_PROGRESS blocked, Admin ok, Technician blocked (403) |
| Delete | UNASSIGNED ok, SCHEDULED blocked, with invoice blocked, Technician blocked |
| Assign | Valid tech, non-TECHNICIAN role blocked, inactive user blocked, COMPLETED blocked |
| Unassign | SCHEDULED → UNASSIGNED, clears fields |
| Start | SCHEDULED → IN_PROGRESS, sets started_at, wrong status blocked, non-assigned tech blocked |
| Complete | IN_PROGRESS → COMPLETED, completion_notes required, sets completed_at |
| Cancel | Various statuses → CANCELLED, reason required, COMPLETED blocked |
| Charges | Add, update, remove, blocked on COMPLETED, sequence management |
| Notes | Get, add, entity_type=JOB |
| Timeline | List events for job |
| Auth | Unauthenticated (401), wrong role (403) |

---

## 8. Files Modified (Summary)

| File | Action |
|------|--------|
| `backend/prisma/schema.prisma` | Add 3 fields to Job model |
| `backend/src/controllers/job.controller.ts` | **NEW** — full controller |
| `backend/src/routes/job.routes.ts` | **NEW** — all routes |
| `backend/src/app.ts` | Wire job routes |
| `backend/src/controllers/estimate.controller.ts` | Add `markDepositPaid` handler |
| `backend/src/routes/estimate.routes.ts` | Add mark-deposit-paid route |
| `backend/src/lib/email.ts` | Add `sendJobAssignmentEmail` |
| `backend/src/__tests__/setup.ts` | Add job mocks |
| `backend/src/__tests__/helpers.ts` | Add job fixtures |
| `backend/src/__tests__/jobs.test.ts` | **NEW** — ~90 tests |
| `backend/src/__tests__/estimates.test.ts` | Add mark-deposit-paid tests |

---

## 9. Execution Order

1. Schema migration (add 3 fields to Job model via Supabase MCP)
2. Mark Deposit Paid feature (estimate controller + route + tests)
3. Job controller — helper functions + select objects + create handlers
4. Job controller — list, getById, update, delete
5. Job controller — status actions (assign, unassign, start, complete, cancel)
6. Job controller — charges CRUD
7. Job controller — notes + timeline
8. Job routes — wire everything
9. Email — sendJobAssignmentEmail
10. Test setup — fixtures, mocks
11. Tests — write all ~90 tests
12. Run full test suite, verify all pass (existing 289 + new ~90)
13. Update CLAUDE.md and memory files

---

## 10. Verification

- `npm test --workspace=backend` — all tests pass (existing 289 + new ~90 ≈ 380+)
- `npx prisma validate` — schema valid after migration
- Manual API testing with Postman/curl for create standard, create urgent, status transitions
- Verify deposit gate: create from estimate with REQUESTED deposit → blocked; mark paid → unblocked
- Verify TECHNICIAN can only see/act on assigned jobs
- Verify SALES can only read jobs from their leads
