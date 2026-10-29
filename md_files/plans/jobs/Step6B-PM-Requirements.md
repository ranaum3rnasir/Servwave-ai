# Step 6B — Job Management Frontend: Product Requirements

> **Author:** Product Manager
> **Date:** 2026-02-27
> **Status:** Draft for merge with UI Expert + Engineer plans

---

## 1. User Stories (Priority Order)

### P0 — Must Have for MVP

**US-1: Dispatcher views all jobs at a glance**
> As a Dispatcher, I need to see all jobs in one list with status counts so I can prioritize my day.
- **AC-1:** JobsPage shows a KPI strip with counts for Unassigned, Scheduled, In Progress, Completed, Cancelled.
- **AC-2:** DataTable shows Job #, Customer, Location (city, state), Status, Assigned To, Type (Urgent/Standard badge), Created date.
- **AC-3:** Clicking a row navigates to JobDetailPage.
- **AC-4:** Search works across job number, customer name, and company name.
- **AC-5:** Filters: status (multi-select), assigned technician (single-select), type (urgent/standard).
- **AC-6:** Page loads in under 2 seconds with 500+ jobs.

**US-2: Admin creates a job from an approved estimate**
> As an Admin, I need to convert an approved estimate into a job so work can begin.
- **AC-1:** EstimateDetailPage shows "Create Job" button when estimate status is APPROVED.
- **AC-2:** Button is hidden if a job already exists for this estimate (backend returns 409).
- **AC-3:** Button is hidden if deposit exists with status REQUESTED (deposit must be PAID or absent).
- **AC-4:** Clicking the button calls `POST /api/jobs { estimate_id }` and navigates to the new job's detail page.
- **AC-5:** Success toast: "Job JOB-YYYY-NNNN created".
- **AC-6:** Button is only visible to ADMIN and DISPATCHER roles.

**US-3: Dispatcher creates an urgent job**
> As a Dispatcher, I need to create a job directly (without an estimate) for emergency calls.
- **AC-1:** JobsPage has a "New Urgent Job" button (visible to ADMIN, DISPATCHER, TECHNICIAN).
- **AC-2:** Clicking opens a dialog with: customer search/select, service location picker (auto-loads locations for selected customer), urgency reason (required textarea), scope notes (optional textarea).
- **AC-3:** Customer search queries the existing customer API (typeahead, minimum 2 chars).
- **AC-4:** Location dropdown populates after customer is selected. If customer has no locations, show a warning message.
- **AC-5:** Submitting calls `POST /api/jobs { is_urgent: true, customer_id, service_location_id, urgency_reason, scope_notes }`.
- **AC-6:** On success, navigate to the new job's detail page.
- **AC-7:** "Urgent" badge is prominently displayed in orange on the created job.

**US-4: Dispatcher assigns a technician to a job**
> As a Dispatcher, I need to assign a technician and optionally set schedule dates so the tech knows where to go.
- **AC-1:** JobDetailPage shows "Assign Technician" button when status is UNASSIGNED.
- **AC-2:** Clicking opens AssignJobDialog with: technician dropdown (active TECHNICIANs only), optional scheduled_start (date+time picker), optional scheduled_end (date+time picker).
- **AC-3:** Technician dropdown fetches from `GET /api/users` filtered to role=TECHNICIAN, is_active=true.
- **AC-4:** Submitting calls `POST /api/jobs/:id/assign`.
- **AC-5:** Job status transitions to SCHEDULED. Page refreshes to show updated status and assigned tech.
- **AC-6:** When job is SCHEDULED, show "Reassign" button (calls assign again) and "Unassign" button (calls unassign, returns to UNASSIGNED).
- **AC-7:** Only ADMIN and DISPATCHER can see assign/unassign buttons.

**US-5: Technician starts and completes a job**
> As a Technician, I need to mark a job as started and then completed so the office knows my status.
- **AC-1:** JobDetailPage shows "Start Job" button when status is SCHEDULED (visible to assigned tech + Admin/Dispatcher).
- **AC-2:** Clicking "Start Job" calls `POST /api/jobs/:id/start`. Job moves to IN_PROGRESS.
- **AC-3:** JobDetailPage shows "Complete Job" button when status is IN_PROGRESS.
- **AC-4:** Clicking "Complete Job" opens a dialog requiring completion_notes (textarea, required, min 1 char).
- **AC-5:** Submitting calls `POST /api/jobs/:id/complete`. Job moves to COMPLETED.
- **AC-6:** Completed jobs show completion notes and completed_at timestamp in the Details tab.

**US-6: Admin/Dispatcher cancels a job**
> As an Admin, I need to cancel a job that's no longer needed with a documented reason.
- **AC-1:** "Cancel Job" action available in the overflow menu (three-dot) for UNASSIGNED, SCHEDULED, IN_PROGRESS jobs.
- **AC-2:** Opens CancelJobDialog requiring cancelled_reason (textarea, required).
- **AC-3:** Calls `POST /api/jobs/:id/cancel`.
- **AC-4:** Cancelled jobs display the reason and cancelled_at in the Details tab.
- **AC-5:** Only ADMIN and DISPATCHER see the cancel option.

**US-7: View job details with full context**
> As any authorized user, I need to see all job information in one place.
- **AC-1:** Hero card shows: job number, status badge, type badge (Urgent/Standard), customer name (linked), service location address.
- **AC-2:** KPI strip shows: Estimate Total (if linked), Charges Total (for urgent jobs), Scheduled Date, Duration.
- **AC-3:** Tabs: Details, Charges (urgent jobs only, or show estimate line items for standard jobs), Notes, Timeline.
- **AC-4:** Details tab shows: scope notes, assigned technician, schedule dates, estimate link (for standard), urgency reason (for urgent), completion notes (if completed), cancellation reason (if cancelled).
- **AC-5:** Context-aware breadcrumbs: if navigated from Customer page, breadcrumbs show Customer > Job #.

**US-8: Manage charges on urgent jobs**
> As a Technician, I need to add line items to an urgent job so we can invoice the customer.
- **AC-1:** Charges tab visible on ALL jobs. For standard jobs, it shows read-only estimate line items. For urgent jobs, it shows editable charges.
- **AC-2:** Urgent job charges: Add button opens inline row or dialog with description, quantity, unit_price, is_taxable toggle.
- **AC-3:** Edit: click a charge to edit inline. Save/cancel.
- **AC-4:** Delete: trash icon with confirmation.
- **AC-5:** Running total displayed at bottom.
- **AC-6:** Charges cannot be added/edited/removed on COMPLETED or CANCELLED jobs. UI disables controls.
- **AC-7:** Only users with job access (tech assigned, admin, dispatcher) can manage charges.

**US-9: Add notes to jobs**
> As any authorized user, I need to add notes to track communications and progress.
- **AC-1:** Notes tab with textarea + Add Note button + chronological list (newest first).
- **AC-2:** Each note shows author name, timestamp, and content.
- **AC-3:** Same pattern as estimate/lead notes.
- **AC-4:** SALES users can read notes but only on jobs from their leads. They CANNOT add notes (backend blocks SALES from POST notes).

**US-10: View job timeline**
> As an Admin/Dispatcher, I need an audit trail of all actions on a job.
- **AC-1:** Timeline tab shows all events: created, assigned, started, completed, cancelled, unassigned.
- **AC-2:** Each event shows: event type, description, who did it, when.
- **AC-3:** Ordered newest first.

### P1 — Important but not blocking

**US-11: Export job list**
> As a Dispatcher, I want to export the current filtered job list as CSV.
- **AC-1:** Export button exports visible rows to CSV with columns matching the table.

**US-12: Delete an unassigned job**
> As an Admin, I need to delete a job that was created by mistake.
- **AC-1:** Delete option in overflow menu, only for UNASSIGNED jobs with no invoice.
- **AC-2:** Confirmation dialog: "Are you sure? This cannot be undone."
- **AC-3:** On success, navigate back to JobsPage.
- **AC-4:** Only ADMIN and DISPATCHER.

**US-13: Date range filter on jobs list**
> As a Dispatcher, I want to filter jobs by creation date range.
- **AC-1:** Date range dropdown (Last 30 days, Last 90 days, Last year, All Time) — same pattern as EstimatesPage.

### P2 — Nice-to-have for later

**US-14: Batch status updates**
> As a Dispatcher, I want to select multiple unassigned jobs and assign them all to one technician.
- Deferred to Step 6.1 (calendar/scheduling).

**US-15: Job duration tracking**
> As an Admin, I want to see actual duration (started_at to completed_at) vs estimated_duration.
- Can show on detail page hero strip. Low effort.

---

## 2. Page-by-Page Feature Requirements

### 2.1 JobsPage (`/jobs`)

**Header:** "Jobs" title + total count badge.

**KPI Strip (single card, divide-x):**
| Cell | Icon | Label | Value | Notes |
|------|------|-------|-------|-------|
| 1 | AlertCircle (yellow) | Unassigned | count | Highlight if > 0 |
| 2 | Calendar | Scheduled | count | |
| 3 | Play | In Progress | count | |
| 4 | CheckCircle2 | Completed | count | |
| 5 | Ban | Cancelled | count | |

**DataTable Columns:**
| Column | Content | Sortable |
|--------|---------|----------|
| Job # | `JOB-YYYY-NNNN` as link-styled text | No (server paginated) |
| Customer | First Last + company name subtitle | No |
| Location | `address_line1, city, state` | No |
| Status | StatusBadge component | No |
| Assigned To | Tech name or italic "Unassigned" | No |
| Type | Badge: "Urgent" (orange) or "Standard" (gray) | No |
| Created | Date formatted | No |

**Filters (DropdownMenu pattern):**
- Status: multi-select checkboxes (UNASSIGNED, SCHEDULED, IN_PROGRESS, COMPLETED, CANCELLED)
- Assigned To: single-select list of active technicians (fetched from users endpoint, filtered role=TECHNICIAN)
- Type: single-select (All, Urgent Only, Standard Only)

**Header Actions:**
- Date range dropdown (All Time, Last 30 days, Last 90 days, Last year)
- Export button
- "New Urgent Job" button (primary)

**Roles:**
- ADMIN, DISPATCHER: see all jobs, full actions
- TECHNICIAN: sees only their assigned jobs (backend auto-filters), "New Urgent Job" button visible
- SALES: sees read-only jobs linked to their leads (backend auto-filters), no "New Urgent Job" button

### 2.2 JobDetailPage (`/jobs/:id`)

**Breadcrumbs:** Context-aware. Default: `Jobs > JOB-2026-0001`. From customer: `Customers > John Doe > JOB-2026-0001`.

**Hero Card:**
- Job number (h1) + StatusBadge + Type Badge (Urgent=orange, Standard=gray)
- Customer name (linked to CustomerDetailPage) + service address
- Context strip (same 3-column pattern as EstimateDetailPage):
  - Column 1: Client Details (name, phone, email)
  - Column 2: Service Address (full address from service_location)
  - Column 3: Job Info (number, status, created date, assigned tech)
- KPI strip below:
  - Standard jobs: Estimate Total | Deposit (status + amount) | Scheduled Date | Duration
  - Urgent jobs: Charges Total | Scheduled Date | Duration

**Action Buttons (right side of hero):**
Primary actions change based on status:

| Status | Primary Button | Overflow Menu |
|--------|---------------|---------------|
| UNASSIGNED | Assign Technician | Edit, Delete, Cancel |
| SCHEDULED | Start Job (tech) / Reassign (dispatcher) | Unassign, Edit, Cancel |
| IN_PROGRESS | Complete Job | Cancel |
| COMPLETED | (none) | (none) |
| CANCELLED | (none) | (none) |

**Tabs:**
1. **Details** — Scope notes, estimate link (for standard), urgency reason (for urgent), schedule info, completion notes, cancellation reason. Edit button for UNASSIGNED/SCHEDULED jobs.
2. **Charges** (with count subtitle) — For urgent: editable charges table. For standard: read-only estimate line items (reuse the same card layout from EstimateDetailPage).
3. **Notes** (with count subtitle) — Add + list, same pattern as estimates.
4. **Timeline** — Audit trail of all events.

### 2.3 EstimateDetailPage Updates

**New elements:**
- "Create Job" primary button — visible when:
  - Status is APPROVED
  - No job exists for this estimate (check `estimate.job` in the detail response, or handle 409 from backend)
  - Deposit is PAID or doesn't exist
  - User is ADMIN or DISPATCHER
- If a job already exists: show "View Job" link instead, linking to `/jobs/:jobId`.
- The estimate detail response already includes the linked job — need to verify the backend includes it. (It does via `estimate.job` or we check after creation.)

**Important backend note:** The estimate detail select does NOT currently include the linked job. The engineer will need to add `job: { select: { id: true, job_number: true, status: true } }` to the `estimateDetailSelect` in the estimate controller.

### 2.4 Urgent Job Dialog (from JobsPage)

**Fields:**
1. Customer search (typeahead, required) — uses existing customer search API
2. Service Location (dropdown, required) — populated after customer selected. Shows "address_line1, city, state" per option. If customer has no locations, show message: "This customer has no service locations. Add one first."
3. Urgency Reason (textarea, required, max 2000 chars)
4. Scope Notes (textarea, optional, max 5000 chars)

**Validation:**
- All required fields must be filled before Submit is enabled
- Zod schema on frontend for immediate feedback

### 2.5 Cross-Entity Pages

**CustomerDetailPage — Jobs Tab:**
Already exists (JobsTab component found in code). Verify it:
- Links to JobDetailPage with context-aware breadcrumbs
- Shows: Job #, Status, Location, Technician, Scheduled date, Invoice link
- Empty state: "No jobs yet." with briefcase icon

**LeadDetailPage:**
- If the lead has estimates that have been converted to jobs, show a "Job" indicator next to the estimate in the estimates section.
- No separate jobs tab needed on lead detail — jobs are accessed via estimate link.

**EstimateDetailPage:**
- Already covered in 2.3. Show "Create Job" or "View Job" depending on state.

---

## 3. Business Rules the Frontend Must Enforce

### 3.1 Button/Action Visibility Matrix

| Action | UNASSIGNED | SCHEDULED | IN_PROGRESS | COMPLETED | CANCELLED |
|--------|-----------|-----------|-------------|-----------|-----------|
| Assign | Admin, Dispatcher | Admin, Dispatcher (reassign) | - | - | - |
| Unassign | - | Admin, Dispatcher | - | - | - |
| Start | - | Assigned Tech, Admin, Dispatcher | - | - | - |
| Complete | - | - | Assigned Tech, Admin, Dispatcher | - | - |
| Cancel | Admin, Dispatcher | Admin, Dispatcher | Admin, Dispatcher | - | - |
| Edit | Admin, Dispatcher | Admin, Dispatcher | - | - | - |
| Delete | Admin, Dispatcher | - | - | - | - |
| Add Charge | Admin, Dispatcher, Assigned Tech (urgent only) | Same | Same | - | - |
| Add Note | Admin, Dispatcher, Assigned Tech | Same | Same | Same | Same |

### 3.2 Validation Rules

- **Assign:** `assigned_to` is required. `scheduled_start` and `scheduled_end` are optional but recommended. If both are provided, start must be before end.
- **Complete:** `completion_notes` is required (min 1 char, max 5000).
- **Cancel:** `cancelled_reason` is required (min 1 char, max 2000).
- **Add Charge:** `description` required (min 1, max 500), `quantity` positive number, `unit_price` non-negative number.
- **Create Urgent Job:** `customer_id`, `service_location_id`, `urgency_reason` all required.
- **Create Job from Estimate:** Only if estimate is APPROVED and deposit is not REQUESTED.

### 3.3 Confirmation Dialogs Required

| Action | Dialog? | Content |
|--------|---------|---------|
| Create Job (from estimate) | No | Direct action, success toast |
| Create Urgent Job | No | Dialog is the form itself |
| Assign Technician | Yes (is the form dialog) | Technician + schedule pickers |
| Unassign | Yes, simple confirm | "This will remove the technician and clear the schedule. The job will return to Unassigned status." |
| Start Job | No | Direct action, success toast |
| Complete Job | Yes (form dialog) | Completion notes textarea |
| Cancel Job | Yes (form dialog) | Cancellation reason textarea |
| Delete Job | Yes, destructive confirm | "Are you sure you want to delete this job? This cannot be undone." |

### 3.4 Create Job from Estimate — Frontend Gate Logic

Before showing the "Create Job" button on EstimateDetailPage:
```
show = estimate.status === 'APPROVED'
  && !estimate.job  // no job already created
  && (!estimate.deposit || estimate.deposit.status === 'PAID')
  && ['ADMIN', 'DISPATCHER'].includes(user.role)
```

If estimate is APPROVED but deposit is REQUESTED, show a disabled button or info message: "Pay deposit before creating a job." This guides the dispatcher to mark the deposit as paid first.

If a job already exists, show "View Job: JOB-YYYY-NNNN" link instead.

### 3.5 SALES Role — Read-Only Enforcement

SALES users can see jobs linked to their leads but CANNOT:
- Create, edit, delete, or change status of any job
- Add charges or notes
- See the "New Urgent Job" button

The frontend should hide all action buttons for SALES users. The backend also enforces this, but the UI should be clean — no disabled buttons, just hidden.

### 3.6 TECHNICIAN Role — Scoped Enforcement

TECHNICIANs can only see their assigned jobs (backend auto-filters). On the detail page:
- Can start their own SCHEDULED jobs
- Can complete their own IN_PROGRESS jobs
- Can add charges to their own urgent jobs (not standard)
- Can add notes to their own jobs
- CANNOT assign/unassign/cancel/edit/delete
- CAN create urgent jobs (from JobsPage button)

---

## 4. Edge Cases and Error States

### 4.1 Empty States

| Scenario | What to Show |
|----------|-------------|
| No jobs at all | Briefcase icon + "No jobs yet. Create one from an approved estimate or start an urgent job." |
| No jobs matching filters | "No jobs match your filters." + Clear Filters button |
| No unassigned jobs | KPI shows 0, no special handling |
| No technicians available (assign dialog) | Empty dropdown + message "No active technicians found. Contact an admin." |
| No service locations for customer (urgent job) | Message in dialog: "This customer has no service locations. Please add a location first." with link to customer page |
| No charges on urgent job | "No charges yet. Add a charge to track work performed." |
| No notes | "No notes yet." |
| No timeline events | "No timeline events." (shouldn't happen — creation always adds one) |

### 4.2 Error Handling

| Error | Frontend Response |
|-------|------------------|
| 409 (job already exists for estimate) | Toast: "A job already exists for this estimate." Refresh estimate data to show the "View Job" link. |
| 400 (estimate not approved) | Toast: "Estimate must be approved before creating a job." |
| 400 (deposit not paid) | Toast: "Deposit must be paid before creating a job." |
| 400 (cannot update in-progress job) | Toast: "Cannot edit a job that is in progress." |
| 400 (only unassigned jobs can be deleted) | Toast: "Only unassigned jobs can be deleted." |
| 400 (charges only on urgent) | Toast: "Charges can only be added to urgent jobs." |
| 403 (insufficient permissions) | Toast: "You don't have permission to perform this action." |
| 404 (job not found) | Full-page "Job not found" message with back link to /jobs. |
| Network error | Toast: "Connection error. Please try again." |

### 4.3 Concurrent Editing

- If two dispatchers try to assign the same job simultaneously, the second will succeed (last write wins on assign). This is acceptable for MVP.
- If a dispatcher tries to start a job that was already cancelled by someone else, the backend returns 400. Frontend shows error toast and refetches job data.
- TanStack Query stale time (5 min default) means a dispatcher might see stale status. The detail page should refetch on focus or use a shorter staleTime for job queries (e.g., 30 seconds).

### 4.4 Long Lists

- Jobs list is server-paginated (same as estimates/leads). Default page size 25.
- Technician dropdown in assign dialog: unlikely to have more than 30 techs. No pagination needed.
- Charges: unlikely to exceed 50. No pagination needed.
- Notes: same pattern as other entities. No pagination needed for MVP.

---

## 5. Cross-Entity Integration Points

### 5.1 EstimateDetailPage -> Job

| Condition | What to Show |
|-----------|-------------|
| Estimate APPROVED, no deposit issue, no job exists | "Create Job" button (Admin/Dispatcher only) |
| Estimate APPROVED, deposit REQUESTED | Disabled "Create Job" + helper text "Mark deposit as paid first" |
| Estimate has a linked job | "View Job: JOB-YYYY-NNNN" link (StatusBadge next to it) |
| Estimate not APPROVED | No job-related UI |

**Backend change required:** Add `job` to `estimateDetailSelect`:
```ts
job: { select: { id: true, job_number: true, status: true } }
```

### 5.2 CustomerDetailPage -> Jobs

Already partially implemented (JobsTab component exists). Verify:
- Tab shows count subtitle (e.g., "3 jobs")
- Table rows link to JobDetailPage with breadcrumbs: `Customers > John Doe > JOB-2026-0001`
- Active jobs (UNASSIGNED, SCHEDULED, IN_PROGRESS) visually distinguished from completed/cancelled

### 5.3 LeadDetailPage -> Job (via Estimate)

- The lead's estimates section already shows estimate cards. If an estimate has a linked job, show a small "Job: JOB-YYYY-NNNN" link under the estimate card. This requires the lead detail endpoint to include `estimate.job` data.
- Low priority — users can navigate Estimate > Job. Can defer.

### 5.4 JobDetailPage -> Estimate

- For standard jobs: "Linked Estimate" section in sidebar/details showing estimate number (clickable link), total amount, deposit status.
- Breadcrumbs from estimate: `Estimates > EST-2025-0001 > JOB-2026-0001`.

### 5.5 JobDetailPage -> Customer

- Customer name in hero is a clickable link to `/customers/:id`.
- Breadcrumbs from customer: `Customers > John Doe > JOB-2026-0001`.

### 5.6 Sidebar Navigation

Already configured in `nav-config.ts`:
- Jobs: visible to ADMIN, DISPATCHER, TECHNICIAN
- SALES cannot see Jobs in sidebar (correct, since they access jobs through Estimates)

Wait -- SALES CAN access jobs via the API (read-only, filtered to their leads). But the sidebar hides Jobs from SALES. This means SALES can only reach a job through: Customer Detail > Jobs Tab, or Estimate Detail > View Job link. **This is acceptable for MVP** since SALES primarily works with leads and estimates, not jobs.

### 5.7 App.tsx Route Changes

Need to add:
```tsx
<Route path="/jobs/:id" element={<JobDetailPage />} />
```

The `/jobs` route already exists pointing to the placeholder JobsPage.

---

## 6. Feature Prioritization

### Phase 1 — Ship First (MVP Critical)
1. **JobsPage** — list, KPI, filters, search (US-1)
2. **JobDetailPage** — hero, details tab, notes tab, timeline tab (US-7, US-9, US-10)
3. **Create Job from Estimate** — button on EstimateDetailPage (US-2)
4. **Assign Technician** dialog (US-4)
5. **Start/Complete Job** actions (US-5)
6. **Cancel Job** dialog (US-6)
7. **App.tsx route** for `/jobs/:id`
8. **Cross-entity: EstimateDetailPage** shows Create Job / View Job

### Phase 2 — Ship Second (Important)
9. **Urgent Job Creation** dialog (US-3)
10. **Charges tab** — editable for urgent, read-only for standard (US-8)
11. **Cross-entity: CustomerDetailPage** — verify Jobs tab works with navigation
12. **Export** (US-11)
13. **Delete Job** (US-12)
14. **Date range filter** (US-13)

### Phase 3 — Polish (Nice-to-have)
15. **Duration tracking** display (US-15)
16. **Shorter staleTime** for job queries to reduce concurrent editing issues
17. **Cross-entity: LeadDetailPage** — show linked job on estimates
18. **SALES view** polish (ensure read-only is clean)

---

## 7. Open Decisions for Team Discussion

1. **Charges tab for standard jobs**: Show read-only estimate line items in the Charges tab, or rename the tab to "Work Scope" and show both estimate line items + any additional charges? The backend currently blocks adding charges to standard jobs (`is_urgent` check). For MVP, show estimate line items as read-only. Revisit if we ever allow supplemental charges on standard jobs.

2. **Urgent job "type" on the list page**: Should the "New Urgent Job" button be renamed to just "New Job" with a type toggle inside the dialog? The backend already supports both flows. For MVP, keep it simple — one button for urgent only. Standard jobs are always created from estimates.

3. **Job edit scope**: The backend allows editing `scope_notes`, `service_location_id`, `estimated_duration`, `scheduled_start`, `scheduled_end` on UNASSIGNED/SCHEDULED jobs. Should edit be a full page or inline on the detail page? **Recommendation:** Inline editing on the Details tab (small pencil icon to toggle edit mode) since it's only a few fields. No need for a full form page.

4. **Stale job data**: Should we add a manual "Refresh" button on the detail page, or rely on shorter staleTime + refetchOnWindowFocus? **Recommendation:** Use `staleTime: 30_000` (30s) for job detail queries and `refetchOnWindowFocus: true`. No manual button needed.

5. **SALES access to jobs from sidebar**: Currently sidebar hides Jobs from SALES. SALES can still reach jobs through estimate/customer links. Is this sufficient? **Recommendation:** Yes, this is fine. SALES role focuses on leads/estimates. Adding a sidebar link would create confusion since they can't take any action on jobs.
