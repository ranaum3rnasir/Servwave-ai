# Step 6: Job Management & Scheduling — Approved Spec

> Approved by VP Product review, 2026-02-27.
> Research: 5 competitors analyzed (Jobber, ServiceTitan, Workiz, HouseCall Pro, FieldPulse).

---

## Split Strategy

- **Step 6A:** Schema migration + full backend (controller, routes, tests, email)
- **Step 6B:** All frontend pages + calendar

---

## Schema Migration

### Add to Job model
| Field | Type | Purpose |
|-------|------|---------|
| `started_at` | `DateTime?` | Auto-set on IN_PROGRESS transition |
| `estimated_duration` | `Int?` | Minutes — for calendar block sizing |
| `dispatched_at` | `DateTime?` | When dispatcher confirms assignment |
| `completion_notes` | `String?` | What tech did (vs `scope_notes` = what needs doing) |

### JobStatus enum (add DISPATCHED)
```prisma
enum JobStatus {
  UNASSIGNED
  SCHEDULED
  DISPATCHED    // NEW
  IN_PROGRESS
  COMPLETED
  CANCELLED
}
```

---

## Status Transitions

### Valid transitions (exhaustive)
| From | To | Requirements | Auto-set |
|------|-----|-------------|----------|
| UNASSIGNED | SCHEDULED | `assigned_to` + `scheduled_start` must be set | — |
| SCHEDULED | DISPATCHED | — | `dispatched_at = now()` |
| DISPATCHED | IN_PROGRESS | — | `started_at = now()` |
| IN_PROGRESS | COMPLETED | `completion_notes` required | `completed_at = now()` |
| UNASSIGNED | CANCELLED | `cancelled_reason` required | `cancelled_at = now()` |
| SCHEDULED | CANCELLED | `cancelled_reason` required | `cancelled_at = now()` |
| DISPATCHED | CANCELLED | `cancelled_reason` required | `cancelled_at = now()` |
| IN_PROGRESS | CANCELLED | `cancelled_reason` required | `cancelled_at = now()` |
| SCHEDULED | UNASSIGNED | — | Clear `assigned_to`, `scheduled_start`, `scheduled_end` |

Every transition creates a TimelineEvent.

---

## API Endpoints

```
GET    /api/jobs                    — List (pagination, filters: status, assigned_to, customer_id, date range, is_urgent, search)
GET    /api/jobs/stats              — Bundled stats (or bundle into list)
POST   /api/jobs                    — Create (two modes: from_estimate_id OR urgent)
GET    /api/jobs/:id                — Detail (include customer, location, estimate, charges, assigned user)
PATCH  /api/jobs/:id                — Update fields (scheduled_start/end, assigned_to, scope_notes, estimated_duration)
POST   /api/jobs/:id/transition     — Status transition (body: { status, cancelled_reason?, completion_notes? })
DELETE /api/jobs/:id                — Delete (only UNASSIGNED/CANCELLED)

GET    /api/jobs/:id/charges        — List charges
POST   /api/jobs/:id/charges        — Add charge
PATCH  /api/jobs/:id/charges/:chargeId — Update charge
DELETE /api/jobs/:id/charges/:chargeId — Remove charge

GET    /api/jobs/:id/notes          — List notes
POST   /api/jobs/:id/notes          — Add note

GET    /api/jobs/:id/timeline       — List timeline events
```

---

## Job Creation Rules

### Standard (from estimate)
- Estimate must be APPROVED
- If deposit exists, it must be PAID
- Auto-populate: `scope_notes` from estimate, `service_location_id` from lead, `customer_id` from lead
- `estimate_id` unique constraint prevents duplicate jobs from same estimate
- Status starts as UNASSIGNED

### Urgent (no estimate)
- `is_urgent = true`, `urgency_reason` required
- `customer_id` + `service_location_id` required
- No estimate or deposit needed
- Status starts as UNASSIGNED

---

## Permissions

| Role | Access |
|------|--------|
| Admin, Dispatcher | Full access to all jobs |
| Sales | Read-only on jobs linked to their estimates |
| Technician | Read/update only their assigned jobs; can add charges/notes; can transition DISPATCHED → IN_PROGRESS → COMPLETED |

---

## Email

`sendJobAssignmentEmail` — sent to the assigned tech when job moves UNASSIGNED → SCHEDULED (or reassigned). Includes: job number, customer name, service address, scheduled date/time, scope notes.

---

## Frontend Pages

### Jobs List Page (`JobsPage.tsx`)
- KPI strip: Total Jobs, Unassigned, Scheduled, In Progress, Completed This Month
- DataTable: Job #, Customer, Service Location, Status, Assigned To, Scheduled Date, Urgent badge, Created
- Filters: Status (multi-select), Assigned To (multi-select), Urgent (yes/no), Date range
- "New Urgent Job" button

### Job Detail Page (`JobDetailPage.tsx`)
- Breadcrumbs (context-aware)
- Hero card: Job #, status badge, customer, address, tech, schedule, urgent badge
- KPI strip: Estimated Duration, Time Since Created, Charges Total (urgent)
- Action buttons: Dispatch, Start, Complete, Cancel, Edit Schedule
- Tabs: Details, Charges (urgent jobs), Notes, Timeline

### Scheduling Calendar
- `react-big-calendar` + `date-fns`
- Daily, Weekly and Monthly view only for MVP
- Events: job number, customer, tech, color-coded by status
- Click event → job detail
- Sidebar: UNASSIGNED jobs list
- Click unassigned job → "Schedule Job" dialog (pick tech, date/time)
- Drag-and-drop functionality
- Filter by technician

### Job Creation Flows
- "Convert to Job" button on EstimateDetailPage (visible when APPROVED + deposit PAID or no deposit)
- "New Urgent Job" dialog on JobsPage (customer search, location picker, urgency reason)

### Cross-entity Updates
- CustomerDetailPage: add Jobs tab
- LeadDetailPage: show linked job if exists

---

## Tests

Target 80-100 backend tests covering:
- CRUD operations
- Both creation flows (from estimate, urgent)
- Every valid transition
- Every invalid transition (expect 400)
- Deposit gating (unpaid → fail, paid → success, no deposit → success)
- Duplicate job from same estimate (expect 409 from unique constraint)
- Charges CRUD
- Notes CRUD
- Stats endpoint
- Role-based authorization
- Pagination and filtering

---

## Deferred Items

| Feature | Deferred To | Reason |
|---------|------------|--------|
| ON_HOLD status | Step 10 | Adds state complexity; notes suffice |
| Job attachments | Step 7 | New infrastructure (Supabase Storage not wired) |
| Drag-and-drop calendar | Step 10 | react-dnd risk; click-to-schedule for MVP |
| Digital signatures | Step 7 | Mobile-first feature |
| Photo capture (mobile) | Step 7 | Desktop upload deferred too (no attachment system) |
| "On My Way" notification | Step 7 | Technician-initiated, needs mobile |
| Job forms / checklists | Post-MVP | Needs form builder |
| Appointment reminders | Post-MVP | Needs cron/queue |
| Recurring jobs | Post-MVP | Needs RRULE, job generation |
| GPS tracking | Post-MVP | Needs mobile geolocation |
| SMS notifications | Post-MVP | Needs Twilio |
| Route optimization | Post-MVP | Google Maps API, algorithmic |
| Custom workflows | Post-MVP | Enterprise feature |
| Multi-job projects | Post-MVP | Enterprise feature |

---

## Open Questions

1. **Job number generation** — replicate the `EST-YYYY-NNNN` sequence approach for `JOB-YYYY-NNNN`
2. **Deposit gating strictness** — deposit must be PAID or not exist. REQUESTED blocks creation.
3. **Calendar library** — `react-big-calendar` vs `@schedule-x/react` — evaluate at start of 6B
4. **Technician availability** — visual only for MVP (dispatcher sees overlapping blocks, resolves manually)
5. **Timezone handling** — store UTC, display in company local timezone via `date-fns-tz`; single timezone from env/app setting
