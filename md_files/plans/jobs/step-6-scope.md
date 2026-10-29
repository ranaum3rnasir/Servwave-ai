# Step 6 & 6.1 — Scope & Tracker

## Step 6 — Job Management (Core CRUD + Workflows)

Everything needed to create, view, edit, and manage jobs — without scheduling/calendar.

### Backend

| # | Item | Description | Status |
|---|------|-------------|--------|
| B1 | **Job controller — list** | Paginated, search, filter by status/assigned_to/customer_id/is_urgent/date range. SALES read-only (jobs from their leads). TECHNICIAN sees only assigned. Bundled stats (per-status counts). | |
| B2 | **Job controller — create (standard)** | From APPROVED estimate. Validates estimate is approved (deposit gate deferred — see note). Auto-populates customer_id, service_location_id, scope_notes from estimate. Auto-generates `JOB-YYYY-NNNN`. Creates timeline event. | |
| B3 | **Job controller — create (urgent)** | No estimate required. Requires `customer_id`, `service_location_id`, `urgency_reason`. Sets `is_urgent=true`. Auto-generates job number. Roles: ADMIN, DISPATCHER, TECHNICIAN. | |
| B4 | **Job controller — getById** | Includes customer, service_location, estimate (with line_items), assigned_user, charges, invoice, notes. TECHNICIAN can only access own jobs. SALES read-only for jobs from their leads. | |
| B5 | **Job controller — update** | Update scope_notes, service_location_id. Only UNASSIGNED/SCHEDULED jobs (not once IN_PROGRESS). | |
| B6 | **Job controller — delete** | Only UNASSIGNED jobs with no invoice. Admin/Dispatcher only. | |
| B7 | **Job controller — assign** | Set `assigned_to` (must be active TECHNICIAN). UNASSIGNED/SCHEDULED only. Admin/Dispatcher only. | |
| B8 | **Job controller — start** | SCHEDULED → IN_PROGRESS. Only assigned tech or Admin/Dispatcher. Records timeline event. | |
| B9 | **Job controller — complete** | IN_PROGRESS → COMPLETED. Sets `completed_at`. Only assigned tech or Admin/Dispatcher. Records timeline event. | |
| B10 | **Job controller — cancel** | UNASSIGNED/SCHEDULED/IN_PROGRESS → CANCELLED. Requires `cancelled_reason`. Sets `cancelled_at`. Admin/Dispatcher only. | |
| B11 | **Job charges — CRUD** | Add/update/remove charges on a job. Sequence auto-managed. Available for urgent jobs and as additional charges on standard jobs. Only while job is not COMPLETED/CANCELLED. | |
| B12 | **Job notes — get/add** | Polymorphic notes (entity_type=JOB). Same pattern as leads/estimates/customers. | |
| B13 | **Job routes** | Wire all endpoints with authenticate + authorize + validate middleware. | |
| B14 | **Job stats endpoint** | Per-status counts: Unassigned, Scheduled, In Progress, Completed, Cancelled. Bundled into list response. | |
| B15 | **Backend unit tests** | Full test suite following existing patterns (customers/leads/estimates test files). | |

### Frontend

| # | Item | Description | Status |
|---|------|-------------|--------|
| F1 | **JobsPage — list** | KPI strip (per-status counts), DataTable (Job #, Customer, Location, Status, Assigned To, Type badge, Created), search, filters (status, assigned_to, is_urgent), export, "New Job" button. | |
| F2 | **JobDetailPage** | Breadcrumb → hero card (job #, StatusBadge, customer link, type badge urgent/standard, KPI strip) → merged panel with sidebar (job info, customer, location, estimate link) + tabs (Charges table, Details, Notes). Action buttons based on status. | |
| F3 | **Create Job from Estimate** | "Create Job" button on EstimateDetailPage (visible when APPROVED). Navigates to job detail after creation. | |
| F4 | **Create Urgent Job flow** | Dialog or form to create urgent job — pick customer, pick service location, enter urgency reason + scope notes. Accessible from JobsPage "New Job" button. | |
| F5 | **Job charges UI** | Editable table on JobDetailPage Charges tab. Add/edit/remove charges. Same data-entry table pattern as estimate line items (simpler — no price book). | |
| F6 | **Job status actions** | Action buttons: Assign Tech, Start Job, Complete Job, Cancel Job — each as dialog or inline action on detail page. | |
| F7 | **Job notes tab** | Same notes pattern as estimates/leads/customers. Add + list. | |
| F8 | **App.tsx routes** | Add `/jobs/:id`, `/jobs/new` (if needed) routes. | |
| F9 | **Sidebar nav update** | Jobs nav item already exists with correct roles. Verify it works. | |
| F10 | **Cross-entity links** | Customer detail → Jobs tab (link to jobs). Lead detail → show job if created. Estimate detail → show linked job. | |

### Notes
- **Deposit gate:** The schema has `Deposit` model and business rules say standard jobs require PAID deposit. Since Stripe isn't wired yet (deferred from Step 5), we have two options: (a) enforce deposit check now and require manual deposit status management, or (b) skip deposit gate for MVP and add it when Stripe is wired. **Decision needed.**
- **Email notifications:** No job-related emails defined yet. Could add tech assignment notification later.

---

## Step 6.1 — Scheduling & Calendar

Everything related to scheduling jobs on a calendar and managing technician availability.
**Status: IN PROGRESS** — Full implementation plan: `Step6.1-Schedule-Calendar-Plan.md`

### Finalized Decisions

| Topic | Decision |
|-------|----------|
| Default view | **Week** |
| Drag-and-drop | **In scope** — reschedule + cross-tech reassign |
| Conflict handling | **Warning + confirm/cancel** (not hard block) — 409 + `force` bypass flag |
| Dialog | **Reuse `AssignJobDialog`** + extend with defaultStart/End props + conflict warning |
| Drag restrictions | **None** — across days, weeks, techs all allowed |
| Grouped-by-tech | **Toggle** (prominent), Day/Week/Month available in both modes |
| Grouped view staff | **All staff: Technicians + SALES** (jobs under techs, walkthroughs under SALES) |
| Calendar events | **SCHEDULED + IN_PROGRESS jobs + Walkthroughs** |
| Walkthrough duration | **Default 60 min**, stored as `walkthrough_duration_minutes` (new schema field) |
| Schedule endpoint | **Reuse `GET /api/jobs`** with existing date filters — no new endpoint |
| Tech list | **Reuse `GET /api/users?role=TECHNICIAN`** + `?role=SALES` — no new endpoint |

### Backend

| # | Item | Description | Status |
|---|------|-------------|--------|
| S-B1 | **Schema migration** | Add `walkthrough_duration_minutes Int?` to Lead model | |
| S-B2 | **Conflict detection in `assign()`** | Overlap check before update; return 409 with conflicting job number. Add `force: boolean?` to `assignJobSchema` to bypass. | |
| S-B3 | **Lead list — walkthrough date filters** | Add `walkthrough_after` / `walkthrough_before` query params to `GET /api/leads` list handler | |
| S-B4 | **Lead walkthrough — duration field** | Add `walkthrough_duration_minutes` to `walkthroughSchema` + `updateWalkthrough` + `leadDetailSelect` | |
| S-B5 | **Backend tests** | Conflict detection tests (with/without force) in `jobs.test.ts` | |

### Frontend

| # | Item | Description | Status |
|---|------|-------------|--------|
| S-F1 | **Install deps** | `react-big-calendar`, `date-fns`, `date-fns-tz`, `@types/react-big-calendar` | |
| S-F2 | **SchedulePage rewrite** | Two-pane: unassigned sidebar (280px, hidden mobile) + calendar. Week default. Standard / By Technician toggle. Day/Week/Month switcher. Staff filter dropdown. | |
| S-F3 | **Calendar events** | Jobs (SCHEDULED=blue, IN_PROGRESS=primary) + Walkthroughs (amber). Grouped view uses react-big-calendar `resources` (all Technicians + SALES as columns). | |
| S-F4 | **Drag-and-drop** | Reschedule (move time), reassign (move to another tech row → same time), drag from sidebar (opens AssignJobDialog or auto-assigns in grouped view). Walkthrough drag updates `walkthrough_scheduled_at`. | |
| S-F5 | **Conflict warning** | Catch 409 on drop → inline confirm → "Schedule Anyway" re-fires with `force: true` | |
| S-F6 | **AssignJobDialog enhancement** | Add `defaultStart?`/`defaultEnd?` props + 409 conflict warning + "Schedule Anyway" flow | |
| S-F7 | **LeadDetailPage — walkthrough duration** | Add Duration select (30min/1hr/1.5hr/2hr) to walkthrough form | |
| S-F8 | **Sidebar nav + route** | ✅ Already done in Step 6B — no changes needed | |

### Notes
- `GET /api/jobs/schedule` is NOT needed — existing `GET /api/jobs` with date filters serves the calendar.
- Drag-to-resize (changing event duration on calendar) is deferred — not in 6.1 scope.
- Calendar is primarily for Admin/Dispatcher. Technicians see their schedule on mobile (Step 7).

---

## Existing Infrastructure We'll Build On

| What | Where | Reuse? |
|------|-------|--------|
| Job + JobCharge Prisma models | `schema.prisma:190-235` | Ready — no migration needed |
| JobStatus enum | `schema.prisma` (UNASSIGNED, SCHEDULED, IN_PROGRESS, COMPLETED, CANCELLED) | Ready |
| NoteEntity.JOB | `schema.prisma` | Ready |
| AttachmentEntity.JOB | `schema.prisma` | Ready |
| JobsPage placeholder | `frontend/src/pages/JobsPage.tsx` | Replace |
| `/jobs` route in App.tsx | `App.tsx:72` | Extend |
| Sidebar "Jobs" nav item | `nav-config.ts:62-65` (ADMIN, DISPATCHER, TECHNICIAN) | Ready |
| Timeline events table | `timeline_events` | Reuse for job events |
| Notes pattern | customer/lead/estimate controllers | Copy pattern |
| KPI strip / DataTable / StatusBadge | `frontend/src/components/ui/` | Reuse |
| Numbering pattern (`EST-YYYY-NNNN`) | `estimate.controller.ts` | Adapt for `JOB-YYYY-NNNN` |

---

## Open Questions

1. **Deposit gate** — Enforce for standard job creation now, or defer until Stripe is wired?
2. **Job edit** — Should scope_notes / service_location be editable after IN_PROGRESS?
3. **Charges on standard jobs** — Can you add extra charges beyond what came from the estimate?
4. **Schedule as separate page vs tab** — Dedicated `/schedule` page or a calendar tab on `/jobs`?
5. **Email on tech assignment** — Notify technician via email when assigned to a job?
