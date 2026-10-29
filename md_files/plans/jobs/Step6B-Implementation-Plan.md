# Step 6B -- Job Management Frontend: Final Implementation Plan

> **Status:** APPROVED -- Ready for implementation
> **Date:** 2026-02-27
> **Consolidated from:** PM Requirements, UI/UX Spec, Engineering Plan
> **Reviewed by:** Development Team Lead

---

## Executive Summary

**Scope:** Build the full Job Management frontend -- list page, detail page, 4 dialogs, and cross-entity integration with EstimateDetailPage. The SchedulePage (calendar) is explicitly deferred to Step 6.1.

**Metrics:**
- New files: 6
- Modified files: 3
- Estimated LOC: ~2,200-2,500
- TanStack queries: 4 query keys
- Mutations: 11
- Implementation phases: 5 (sequential with some parallelism)

---

## Resolved Decisions

These decisions were disputed or ambiguous across the three source plans. Each is now settled.

### D1: SchedulePage Scope
**Decision:** Defer entirely to Step 6.1. Do NOT create SchedulePage.tsx, do NOT install react-big-calendar, do NOT add a Schedule nav item. The `/schedule` route does not exist yet. This keeps 6B focused and avoids shipping an incomplete calendar.

### D2: Charges Tab Approach
**Decision:** Use a **dialog-based approach** for adding/editing charges (not inline editing). Reasoning: inline editing requires per-row edit/save/cancel state management which adds complexity for little MVP gain. The flow is:
- "Add Charge" button opens a small dialog with description, qty, unit_price, is_taxable fields.
- Edit: click a charge row to open the same dialog pre-filled. Save calls PATCH.
- Delete: trash icon with a simple confirmation (window.confirm, no dialog component needed).
This matches the simplicity principle while being fully functional.

### D3: Backend Change -- Estimate Detail Must Include Job
**Decision:** REQUIRED. The `estimateDetailSelect` in `estimate.controller.ts` does NOT currently include the linked job. We must add:
```ts
job: { select: { id: true, job_number: true, status: true } }
```
This is a small, safe change (additive only). Without it, the "Create Job" / "View Job" button on EstimateDetailPage cannot determine if a job already exists.

### D4: Assign Endpoint -- scheduled_start/scheduled_end
**Decision:** These are OPTIONAL on the backend (`assignJobSchema` marks them as `.optional()`). The PM was correct. The dialog should include datetime pickers but they are not required to submit. The dialog name is "Assign Technician" (not "Assign & Schedule") to match the fact that scheduling is optional.

### D5: Tab Structure on Detail Page
**Decision:** 4 tabs: **Details, Charges, Notes, Timeline**. Rationale:
- The Engineer's "Line Items" tab (showing estimate line items for standard jobs) is merged INTO the Charges tab. For standard jobs, the Charges tab shows read-only estimate line items with a header "Line Items from Estimate". For urgent jobs, it shows editable charges. This avoids having a 5th tab and keeps the "what does this job cost?" information in one place.
- Tab default: `details` (most useful on first view).

### D6: Charges Tab Visibility
**Decision:** The Charges tab is visible on ALL jobs (not just urgent). For standard jobs it shows read-only estimate line items. For urgent jobs it shows editable charges. This was debated between PM (always visible) and Engineer (urgent only). PM's approach wins because it provides useful context for all jobs.

### D7: SALES Note Permissions
**Decision:** SALES users can READ notes but CANNOT add them. The backend enforces this (POST notes route excludes SALES). Frontend hides the "Add Note" textarea for SALES users. The `canAccessJob` function in the backend allows SALES read access via `estimate.lead.assigned_to`.

### D8: Job Edit Approach
**Decision:** Deferred to Phase 2 of implementation. For MVP Phase 1, editing UNASSIGNED/SCHEDULED jobs (scope_notes, service_location_id, estimated_duration) is low priority. When implemented, it will be inline on the Details tab (pencil icon to toggle edit mode), not a separate page.

---

## File Plan

### New Files (6)

| # | File | Purpose | Est. LOC |
|---|------|---------|----------|
| 1 | `frontend/src/pages/JobsPage.tsx` | Full list page (replaces placeholder) | ~400 |
| 2 | `frontend/src/pages/JobDetailPage.tsx` | Detail page: hero, KPI, tabs, actions | ~700 |
| 3 | `frontend/src/components/jobs/NewUrgentJobDialog.tsx` | Customer search -> location -> urgency form | ~250 |
| 4 | `frontend/src/components/jobs/AssignJobDialog.tsx` | Technician picker + optional datetime | ~150 |
| 5 | `frontend/src/components/jobs/CompleteJobDialog.tsx` | Completion notes textarea | ~80 |
| 6 | `frontend/src/components/jobs/CancelJobDialog.tsx` | Cancellation reason textarea | ~80 |

### Modified Files (3)

| # | File | Changes |
|---|------|---------|
| 1 | `frontend/src/App.tsx` | Add lazy import + route for `/jobs/:id` |
| 2 | `frontend/src/pages/EstimateDetailPage.tsx` | Add "Create Job" / "View Job" button (APPROVED status, deposit gate) |
| 3 | `backend/src/controllers/estimate.controller.ts` | Add `job` to `estimateDetailSelect` |

### NOT Changed (confirmed)

| File | Why |
|------|-----|
| `status-badge.tsx` | Already has all 5 job statuses mapped |
| `nav-config.ts` | Jobs already in sidebar for ADMIN, DISPATCHER, TECHNICIAN |
| `Header.tsx` | Already maps `/jobs` to "Jobs" |
| `CustomerDetailPage.tsx` | Jobs tab already exists and links to `/jobs/:id` (will just work once the route resolves) |
| `frontend/package.json` | No new dependencies (react-big-calendar deferred to 6.1) |

---

## TypeScript Interfaces

All interfaces are defined locally in each page file (matching existing codebase pattern -- no shared types file).

### JobsPage.tsx

```typescript
interface JobListItem {
  id: string;
  job_number: string;
  status: string;
  is_urgent: boolean;
  scheduled_start: string | null;
  scheduled_end: string | null;
  created_at: string;
  customer: {
    id: string;
    first_name: string;
    last_name: string;
    company_name: string | null;
  };
  assigned_user: {
    id: string;
    first_name: string;
    last_name: string;
  } | null;
  service_location: {
    id: string;
    address_line1: string;
    city: string;
    state: string;
  } | null;
}

interface JobStats {
  unassigned: number;
  scheduled: number;
  in_progress: number;
  completed: number;
  cancelled: number;
}
```

### JobDetailPage.tsx

```typescript
interface JobDetail {
  id: string;
  job_number: string;
  status: string;
  is_urgent: boolean;
  urgency_reason: string | null;
  scope_notes: string | null;
  estimated_duration: number | null;
  completion_notes: string | null;
  assigned_to: string | null;
  scheduled_start: string | null;
  scheduled_end: string | null;
  started_at: string | null;
  completed_at: string | null;
  cancelled_at: string | null;
  cancelled_reason: string | null;
  created_at: string;
  updated_at: string;
  customer: {
    id: string;
    first_name: string;
    last_name: string;
    company_name: string | null;
    email: string | null;
    phone: string;
  };
  assigned_user: {
    id: string;
    first_name: string;
    last_name: string;
    email: string | null;
  } | null;
  service_location: {
    id: string;
    address_line1: string;
    address_line2: string | null;
    city: string;
    state: string;
    zip: string;
  } | null;
  estimate: {
    id: string;
    estimate_number: string;
    total_amount: number | string;
    status: string;
    deposit: {
      id: string;
      amount: number | string;
      status: string;
      paid_at: string | null;
    } | null;
    line_items: EstimateLineItem[];
  } | null;
  charges: JobCharge[];
  invoice: {
    id: string;
    invoice_number: string;
    status: string;
    total_amount: number | string;
  } | null;
}

interface EstimateLineItem {
  id: string;
  sequence: number;
  description: string;
  quantity: number;
  unit_price: number;
  is_taxable: boolean;
  line_total: number;
  item_type: string;
}

interface JobCharge {
  id: string;
  sequence: number;
  description: string;
  quantity: number;
  unit_price: number;
  is_taxable: boolean;
  line_total: number;
}

interface NoteSummary {
  id: string;
  content: string;
  created_at: string;
  creator: { id: string; first_name: string; last_name: string };
}

interface TimelineEvent {
  id: string;
  event_type: string;
  description: string;
  metadata: Record<string, unknown> | null;
  created_at: string;
  creator: { id: string; first_name: string; last_name: string };
}
```

### Dialog Props

```typescript
interface AssignJobDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  jobId: string;
  currentAssignedTo?: string | null;
}

interface CompleteJobDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  jobId: string;
}

interface CancelJobDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  jobId: string;
}

interface NewUrgentJobDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}
```

---

## TanStack Query Integration

### Query Keys

```typescript
['jobs', { page, pageSize, search, statuses, assignedTo, isUrgent, dateRange }]  // List + stats
['job', jobId]                    // Single job detail
['job-notes', jobId]              // Job notes
['job-timeline', jobId]           // Job timeline events
['users', { role: 'TECHNICIAN' }] // Technicians (for assign dialog + filter)
```

### Queries

```typescript
// JobsPage -- list with bundled stats
const { data, isLoading } = useQuery({
  queryKey: ['jobs', { page, pageSize, search, statuses, assignedTo, isUrgent }],
  queryFn: async () => {
    const { data } = await api.get('/api/jobs', {
      params: {
        page,
        limit: pageSize,
        search: search || undefined,
        status: statuses.length > 0 ? statuses : undefined,
        assigned_to: assignedTo || undefined,
        is_urgent: isUrgent !== '' ? isUrgent : undefined,
      },
    });
    return data; // { jobs, pagination, stats }
  },
});

// JobDetailPage -- single job
const { data: jobData, isLoading } = useQuery({
  queryKey: ['job', id],
  queryFn: async () => {
    const { data } = await api.get(`/api/jobs/${id}`);
    return data.job;
  },
  staleTime: 30_000,             // 30s for fresher job status data
  refetchOnWindowFocus: true,
});

// Job notes (separate query, matches estimate pattern)
const { data: notesData, refetch: refetchNotes } = useQuery({
  queryKey: ['job-notes', id],
  queryFn: async () => {
    const { data } = await api.get(`/api/jobs/${id}/notes`);
    return data.notes;
  },
  enabled: Boolean(id),
});

// Job timeline
const { data: timelineData } = useQuery({
  queryKey: ['job-timeline', id],
  queryFn: async () => {
    const { data } = await api.get(`/api/jobs/${id}/timeline`);
    return data.events;
  },
  enabled: Boolean(id),
});

// Technicians (for AssignJobDialog and JobsPage filter)
const { data: technicians } = useQuery({
  queryKey: ['users', { role: 'TECHNICIAN' }],
  queryFn: async () => {
    const { data } = await api.get('/api/users', { params: { role: 'TECHNICIAN' } });
    return data.users.filter((u: { is_active: boolean }) => u.is_active);
  },
  enabled: open, // only fetch when dialog/filter is open
});
```

### Mutations

```typescript
// Create standard job (from estimate)
mutationFn: (estimateId: string) => api.post('/api/jobs', { estimate_id: estimateId })
onSuccess: invalidate ['jobs'], ['estimate', estimateId], navigate to /jobs/:id

// Create urgent job
mutationFn: (body) => api.post('/api/jobs', { is_urgent: true, ...body })
onSuccess: invalidate ['jobs'], navigate to /jobs/:id

// Assign
mutationFn: (body: { assigned_to, scheduled_start?, scheduled_end? }) => api.post(`/api/jobs/${id}/assign`, body)
onSuccess: invalidate ['job', id], ['jobs'], ['job-timeline', id]

// Unassign
mutationFn: () => api.post(`/api/jobs/${id}/unassign`)
onSuccess: invalidate ['job', id], ['jobs'], ['job-timeline', id]

// Start
mutationFn: () => api.post(`/api/jobs/${id}/start`)
onSuccess: invalidate ['job', id], ['jobs'], ['job-timeline', id]

// Complete
mutationFn: (body: { completion_notes }) => api.post(`/api/jobs/${id}/complete`, body)
onSuccess: invalidate ['job', id], ['jobs'], ['job-timeline', id]

// Cancel
mutationFn: (body: { cancelled_reason }) => api.post(`/api/jobs/${id}/cancel`, body)
onSuccess: invalidate ['job', id], ['jobs'], ['job-timeline', id]

// Delete
mutationFn: () => api.delete(`/api/jobs/${id}`)
onSuccess: invalidate ['jobs'], navigate to /jobs

// Add note
mutationFn: (body: { content }) => api.post(`/api/jobs/${id}/notes`, body)
onSuccess: refetchNotes(), clear note input

// Add charge
mutationFn: (body) => api.post(`/api/jobs/${id}/charges`, body)
onSuccess: invalidate ['job', id]

// Update charge
mutationFn: ({ chargeId, ...body }) => api.patch(`/api/jobs/${id}/charges/${chargeId}`, body)
onSuccess: invalidate ['job', id]

// Remove charge
mutationFn: (chargeId) => api.delete(`/api/jobs/${id}/charges/${chargeId}`)
onSuccess: invalidate ['job', id]
```

---

## Page & Component Specifications

### 1. JobsPage.tsx

**Layout:** Identical to EstimatesPage -- heading with count badge, KPI strip card, DataTable.

**State:**
```typescript
const [page, setPage] = useState(1);
const [pageSize, setPageSize] = useState(25);
const [search, setSearch] = useState('');
const [statuses, setStatuses] = useState<string[]>([]);
const [assignedTo, setAssignedTo] = useState('');
const [isUrgent, setIsUrgent] = useState('');        // '' | 'true' | 'false'
const [dateRange, setDateRange] = useState('');        // '' | '30' | '90' | '365'
const [showUrgentDialog, setShowUrgentDialog] = useState(false);
```

**KPI Strip (5 cells, single Card with divide-x):**

| Cell | Icon | Label | Color |
|------|------|-------|-------|
| 1 | AlertCircle | Unassigned | warning |
| 2 | CalendarDays | Scheduled | info/blue |
| 3 | Play | In Progress | primary |
| 4 | CheckCircle2 | Completed | success |
| 5 | Ban | Cancelled | gray |

Each cell shows the count from `stats`. No dollar values (unlike estimates).

**DataTable Columns (7 columns):**

| # | Column | Content | Notes |
|---|--------|---------|-------|
| 1 | Job # | `font-medium text-primary` + urgent badge if `is_urgent` | AlertTriangle icon in `bg-danger/10 text-danger` |
| 2 | Customer | `first_name last_name`, company_name subtitle | Same pattern as EstimatesPage |
| 3 | Status | StatusBadge | Existing component |
| 4 | Location | `city, state` | Truncated |
| 5 | Assigned To | Tech name or italic "Unassigned" | `text-text-secondary italic` when null |
| 6 | Scheduled | `scheduled_start` formatted date or em-dash | |
| 7 | Created | `created_at` formatted date | |

**Filters (DropdownMenu with sub-menus, same pattern as EstimatesPage):**
- Status: multi-select checkboxes (UNASSIGNED, SCHEDULED, IN_PROGRESS, COMPLETED, CANCELLED)
- Assigned To: single-select list of active technicians
- Type: single-select (All / Standard / Urgent)

**Header Actions:**
- Date range dropdown (All Time, Last 30, Last 90, Last Year)
- Export button (CSV, same pattern)
- "New Urgent Job" button (primary) -- hidden for SALES role

**Role-based rendering:**
- ADMIN, DISPATCHER: see all jobs, full actions, "New Urgent Job" button
- TECHNICIAN: sees only their assigned jobs (backend filters), "New Urgent Job" button visible
- SALES: sees read-only jobs from their leads (backend filters), NO "New Urgent Job" button

**Row click:** `navigate(/jobs/${job.id})`

---

### 2. JobDetailPage.tsx

**Layout:** Same as EstimateDetailPage -- Breadcrumb, Hero Card, Tabs Card.

**Breadcrumbs:** Context-aware via `location.state?.breadcrumbs`. Default: `Jobs > JOB-2026-0001`.

**Hero Card structure:**

```
+------------------------------------------------------------------------+
| JOB-2026-0001  [Scheduled]  [! Urgent]              [Start Job] [...]  |
| John Smith -- ACME Corp  .  View Estimate  .  View Customer            |
|------------------------------------------------------------------------|
| CLIENT DETAILS          | SERVICE ADDRESS        | JOB INFO             |
| John Smith              | 123 Main St            | JOB-2026-0001        |
| ACME Corp               | Denver, CO 80202       | Scheduled             |
| (303) 555-1234          |                        | Assigned: Mike Torres |
| john@acme.com           |                        | Feb 15, 2026 9:00 AM |
|------------------------------------------------------------------------|
| [Clock] Est. Duration | [DollarSign] Est. Total | [Receipt] Charges    |
|  2h 30m               |  $4,500.00              | $0.00                 |
+------------------------------------------------------------------------+
```

**Context strip:** 3-column grid identical to EstimateDetailPage pattern.

**KPI strip cells:**

| Cell | Icon | Label | Value | Condition |
|------|------|-------|-------|-----------|
| 1 | Clock | Est. Duration | `Xh Ym` from estimated_duration (minutes), "--" if null | Always |
| 2 | DollarSign | Estimate Total | `formatCurrency(estimate.total_amount)`, "--" if no estimate | Always |
| 3 | Receipt | Charges Total | Sum of `charges[].line_total` | Only if urgent or charges exist |

**Action Buttons -- Role + Status Matrix:**

Helper function to extract from page component:
```typescript
function getAvailableActions(job: JobDetail, userRole: string, userId: string) {
  const canManage = userRole === 'ADMIN' || userRole === 'DISPATCHER';
  const isAssignedTech = userRole === 'TECHNICIAN' && job.assigned_to === userId;
  const canWork = canManage || isAssignedTech;
  const isSales = userRole === 'SALES';

  return {
    canAssign: canManage && ['UNASSIGNED', 'SCHEDULED'].includes(job.status),
    canUnassign: canManage && job.status === 'SCHEDULED',
    canStart: canWork && job.status === 'SCHEDULED',
    canComplete: canWork && job.status === 'IN_PROGRESS',
    canCancel: canManage && ['UNASSIGNED', 'SCHEDULED', 'IN_PROGRESS'].includes(job.status),
    canDelete: canManage && job.status === 'UNASSIGNED' && !job.invoice,
    canEditCharges: canWork && job.is_urgent && !['COMPLETED', 'CANCELLED'].includes(job.status),
    canAddNotes: !isSales,
  };
}
```

**Primary button by status:**

| Status | Primary Button | Icon | Overflow Items |
|--------|---------------|------|----------------|
| UNASSIGNED | Assign Technician | UserPlus | Delete, Cancel |
| SCHEDULED | Start Job | Play | Reassign, Unassign, Cancel |
| IN_PROGRESS | Complete Job | CheckCircle2 | Cancel |
| COMPLETED | (none) | -- | (none) |
| CANCELLED | (none) | -- | (none) |

**Tabs (4 tabs):**

#### Tab 1: Details (default)
Two-column layout (`grid grid-cols-1 lg:grid-cols-2 gap-6`):

Left column -- Job Info (`dl` with `flex justify-between` rows):
- Number, Status (StatusBadge), Type (Standard/Urgent badge)
- Created date + by whom
- Assigned To (name or "Unassigned")
- Scheduled Start / End (if set)
- Started At (if IN_PROGRESS or COMPLETED)
- Completed At + Completion Notes (if COMPLETED)
- Cancelled At + Reason (if CANCELLED)
- Linked Estimate (clickable link to `/estimates/:id`, for standard jobs only)

Right column -- Scope Notes:
- `h3` "Scope Notes"
- `p.whitespace-pre-wrap` with content or italic "No scope notes"
- If urgent: additional "Urgency Reason" section in `text-danger`

#### Tab 2: Charges (count subtitle)

**Standard jobs (has estimate):**
- Header: "Line Items from Estimate" + link to estimate
- Read-only list of estimate line items using same card-style rendering as EstimateDetailPage (image placeholder, description, qty, unit price, total)
- Totals summary at bottom (subtotal from estimate)

**Urgent jobs:**
- Table with columns: #, Description, Qty, Unit Price, Tax, Total, Actions
- Each row is read-only display with edit (Pencil icon) and delete (Trash2 icon) buttons
- "Add Charge" button below table opens AddChargeDialog (reuses the same dialog for edit)
- Running subtotal at bottom
- Controls disabled for COMPLETED/CANCELLED jobs

**Add/Edit Charge Dialog (inline within JobDetailPage, not a separate file):**
- Simple `Dialog` with: description (Input), quantity (Input type=number), unit_price (Input type=number), is_taxable (Checkbox)
- Submit calls POST (add) or PATCH (edit)
- ~50 lines, not worth a separate file

#### Tab 3: Notes (count subtitle)
- Identical to EstimateDetailPage notes tab
- "Add Note" textarea + button (hidden for SALES users)
- Chronological list (newest first), creator name + timestamp + content

#### Tab 4: Timeline (count subtitle)
- Vertical timeline with event icons:
  - CREATED: `Plus`
  - ASSIGNED: `UserPlus`
  - UNASSIGNED: `UserMinus`
  - STARTED: `Play`
  - COMPLETED: `CheckCircle2`
  - CANCELLED: `XCircle`
- Each event: icon circle + description + "by Name . datetime"
- Vertical connecting line between events

**State:**
```typescript
const [assignOpen, setAssignOpen] = useState(false);
const [completeOpen, setCompleteOpen] = useState(false);
const [cancelOpen, setCancelOpen] = useState(false);
const [chargeDialogOpen, setChargeDialogOpen] = useState(false);
const [editingCharge, setEditingCharge] = useState<JobCharge | null>(null);
const [noteContent, setNoteContent] = useState('');
```

---

### 3. NewUrgentJobDialog.tsx

**Pattern:** Same multi-step approach as NewEstimateDialog.

**Flow:**
1. Search customers (typeahead, `GET /api/customers?search=...&limit=6`)
2. Click customer -> shows their service locations
3. Select location -> form expands with urgency_reason + scope_notes
4. Submit -> `POST /api/jobs { is_urgent: true, customer_id, service_location_id, urgency_reason, scope_notes }`
5. On success -> navigate to `/jobs/:id`, close dialog

**Layout:** `max-w-lg`

**Step 1 (customer search):**
- AlertTriangle icon + "Create Urgent Job" heading
- Search input with debounce (300ms)
- Customer results list (name + company, clickable)

**Step 2 (after customer selected):**
- "for {customer name}" subtitle
- Service Location dropdown (Select component, shows `address_line1, city, state`)
- If no locations: warning message "This customer has no service locations."
- Urgency Reason (Textarea, required, max 2000 chars)
- Scope Notes (Textarea, optional, max 5000 chars)
- "Back" button (returns to step 1) + "Create Job" submit button

**State:**
```typescript
const [search, setSearch] = useState('');
const [debouncedSearch] = useDebounce(search, 300);
const [selectedCustomer, setSelectedCustomer] = useState<Customer | null>(null);
const [selectedLocationId, setSelectedLocationId] = useState('');
const [urgencyReason, setUrgencyReason] = useState('');
const [scopeNotes, setScopeNotes] = useState('');
```

**Customer locations:** Fetched via `GET /api/customers/:id` when customer is selected (the customer detail response includes service_locations).

---

### 4. AssignJobDialog.tsx

**Pattern:** Same as AssignLeadDialog (Dialog with Select + Labels).

**Fields:**
1. Technician (Select, required) -- fetches `GET /api/users` filtered to active TECHNICIANs
2. Scheduled Start (input type="datetime-local", optional)
3. Scheduled End (input type="datetime-local", optional)

**Validation:** If both dates are provided, start must be before end (frontend check).

**Submit:** `POST /api/jobs/:id/assign` with `{ assigned_to, scheduled_start?, scheduled_end? }`

**Pre-fill:** When reassigning (job already has `assigned_to`), pre-select current technician.

---

### 5. CompleteJobDialog.tsx

**Pattern:** Copy CancelEstimateDialog.

**Fields:**
- Completion Notes (Textarea, required, min 1 char, max 5000)

**Submit:** `POST /api/jobs/:id/complete` with `{ completion_notes }`

---

### 6. CancelJobDialog.tsx

**Pattern:** Identical to CancelEstimateDialog.

**Fields:**
- Cancellation Reason (Textarea, required, min 1 char, max 2000)

**Submit:** `POST /api/jobs/:id/cancel` with `{ cancelled_reason }`

---

## Cross-Entity Integration

### EstimateDetailPage Changes

Add job-related buttons to the hero card action area:

```typescript
// Conditions (computed from estimate detail response)
const hasJob = Boolean(est.job);
const isApproved = est.status === 'APPROVED';
const depositBlocked = est.deposit && est.deposit.status === 'REQUESTED';
const canCreateJob = (user?.role === 'ADMIN' || user?.role === 'DISPATCHER')
  && isApproved && !hasJob && !depositBlocked;
```

**Three states:**

| Condition | UI |
|-----------|-----|
| `canCreateJob` | "Create Job" primary button (Briefcase icon). On click: `POST /api/jobs { estimate_id }`, then navigate to `/jobs/:id` |
| `isApproved && !hasJob && depositBlocked` | Disabled "Create Job" button + tooltip/helper text: "Mark deposit as paid first" |
| `hasJob` | "View Job: JOB-YYYY-NNNN" outline button linking to `/jobs/:estJob.id` with status badge |

**Error handling:** If POST returns 409, show toast "A job already exists for this estimate" and refetch estimate data.

**Mutation:**
```typescript
const createJobMutation = useMutation({
  mutationFn: async () => {
    const { data } = await api.post('/api/jobs', { estimate_id: est.id });
    return data.job;
  },
  onSuccess: (job) => {
    queryClient.invalidateQueries({ queryKey: ['jobs'] });
    queryClient.invalidateQueries({ queryKey: ['estimate', id] });
    navigate(`/jobs/${job.id}`);
  },
  onError: (err: any) => {
    if (err.response?.status === 409) {
      queryClient.invalidateQueries({ queryKey: ['estimate', id] });
    }
  },
});
```

### CustomerDetailPage
No changes needed. The existing Jobs tab already links to `/jobs/:id`. Once JobDetailPage exists at that route, navigation will work automatically.

### LeadDetailPage
Deferred. Low priority -- users can navigate Lead -> Estimate -> Job. No changes in this step.

---

## Backend Changes

### 1. Add `job` to estimateDetailSelect

**File:** `backend/src/controllers/estimate.controller.ts`

**Change:** Add to `estimateDetailSelect` object:
```typescript
const estimateDetailSelect = {
  // ... existing fields ...
  job: { select: { id: true, job_number: true, status: true } },
};
```

**Impact:** Purely additive. All existing estimate responses will now include `job: null` (for estimates without jobs) or `job: { id, job_number, status }`. No breaking changes.

### 2. Verify: No other backend changes needed

The job controller already supports all needed endpoints:
- `GET /api/jobs` -- list with stats (bundled)
- `POST /api/jobs` -- create (standard + urgent)
- `GET /api/jobs/:id` -- detail with full relations
- `PATCH /api/jobs/:id` -- update
- `DELETE /api/jobs/:id` -- delete
- `POST /api/jobs/:id/assign` -- assign
- `POST /api/jobs/:id/unassign` -- unassign
- `POST /api/jobs/:id/start` -- start
- `POST /api/jobs/:id/complete` -- complete
- `POST /api/jobs/:id/cancel` -- cancel
- `GET/POST /api/jobs/:id/charges` -- charges CRUD
- `PATCH/DELETE /api/jobs/:id/charges/:chargeId`
- `GET/POST /api/jobs/:id/notes` -- notes
- `GET /api/jobs/:id/timeline` -- timeline

All role-based access control is enforced server-side. The frontend mirrors these rules for UI hiding but does not need to be the sole enforcer.

---

## Empty States

| Location | Condition | Display |
|----------|-----------|---------|
| JobsPage | No jobs at all | Briefcase icon + "No jobs yet. Create one from an approved estimate or start an urgent job." |
| JobsPage | No matching filters | "No jobs match your filters." + Clear Filters button |
| Charges tab (urgent) | No charges | "No charges yet. Add a charge to track work performed." |
| Charges tab (standard) | No estimate line items | "No line items on the linked estimate." (shouldn't happen) |
| Notes tab | No notes | "No notes yet." |
| Timeline tab | No events | "No timeline events." |
| Assign dialog | No technicians | "No active technicians found." |
| Urgent dialog | No locations | "This customer has no service locations." |

---

## Error Handling

| HTTP Status | Context | Toast Message |
|-------------|---------|---------------|
| 409 | Create job (duplicate) | "A job already exists for this estimate." |
| 400 | Estimate not approved | "Estimate must be approved before creating a job." |
| 400 | Deposit not paid | "Deposit must be paid before creating a job." |
| 400 | Invalid status transition | Backend message (e.g., "Only scheduled jobs can be started") |
| 400 | Charges on standard job | "Charges can only be added to urgent jobs." |
| 403 | Insufficient permissions | "You don't have permission to perform this action." |
| 404 | Job not found | Full-page "Job not found" with back link |
| 5xx / Network | Any | "Something went wrong. Please try again." |

---

## Implementation Sequence

### Phase 1: Backend + Routes (no frontend dependencies)

**1.1** Add `job` to `estimateDetailSelect` in `estimate.controller.ts`
**1.2** Add lazy import + route for `/jobs/:id` in `App.tsx`

```tsx
const JobDetailPage = lazy(() => import('@/pages/JobDetailPage'));
// Inside routes:
<Route path="/jobs/:id" element={<JobDetailPage />} />
```

### Phase 2: Dialogs (can be built in parallel, no page dependencies)

**2.1** `CancelJobDialog.tsx` -- simplest, copy CancelEstimateDialog pattern
**2.2** `CompleteJobDialog.tsx` -- same pattern, required completion_notes
**2.3** `AssignJobDialog.tsx` -- technician Select + datetime inputs
**2.4** `NewUrgentJobDialog.tsx` -- most complex (multi-step customer search + location + form)

### Phase 3: JobsPage (depends on Phase 2.4 for NewUrgentJobDialog import)

**3.1** `JobsPage.tsx` -- full rewrite replacing placeholder
- KPI strip, DataTable, filters, search, export, "New Urgent Job" button
- Row click navigates to `/jobs/:id`

### Phase 4: JobDetailPage (depends on Phase 1.2, Phase 2.1-2.3)

**4.1** Hero card with context strip + KPI strip
**4.2** Action buttons (status + role gated)
**4.3** Details tab
**4.4** Charges tab (read-only for standard, editable for urgent with inline add/edit dialog)
**4.5** Notes tab
**4.6** Timeline tab

### Phase 5: EstimateDetailPage Integration (depends on Phase 1.1)

**5.1** Add "Create Job" / "View Job" button to EstimateDetailPage
- Create job mutation
- Deposit gate logic
- "View Job" link when job exists

---

## Testing Checklist

After implementation, verify:

- [ ] JobsPage loads with KPI strip and data table
- [ ] Filters work: status, assigned to, type, date range
- [ ] Search works across job number, customer name, company
- [ ] "New Urgent Job" opens dialog, creates job, navigates to detail
- [ ] JobDetailPage shows correct hero, context strip, KPI
- [ ] Action buttons respect status + role matrix
- [ ] Assign dialog assigns technician, job transitions to SCHEDULED
- [ ] Start job transitions to IN_PROGRESS
- [ ] Complete dialog requires notes, transitions to COMPLETED
- [ ] Cancel dialog requires reason, transitions to CANCELLED
- [ ] Unassign returns to UNASSIGNED
- [ ] Delete works for UNASSIGNED jobs only
- [ ] Charges tab: read-only estimate line items for standard jobs
- [ ] Charges tab: add/edit/delete charges for urgent jobs
- [ ] Notes tab: add + list (hidden for SALES)
- [ ] Timeline tab: shows events in order
- [ ] Breadcrumbs: context-aware from Jobs, Customers, Estimates
- [ ] EstimateDetailPage: "Create Job" button when APPROVED + no job + deposit OK
- [ ] EstimateDetailPage: "View Job" link when job exists
- [ ] EstimateDetailPage: disabled state when deposit REQUESTED
- [ ] SALES user sees read-only view, no action buttons
- [ ] TECHNICIAN sees only their jobs, can start/complete/add charges+notes
- [ ] Error toasts for all error conditions
- [ ] 404 page for invalid job ID
- [ ] CSV export works

---

## What Is NOT In This Plan (Deferred)

| Feature | Deferred To | Reason |
|---------|-------------|--------|
| SchedulePage (calendar) | Step 6.1 | Separate step per project plan |
| react-big-calendar dependency | Step 6.1 | Not needed until calendar page |
| Schedule nav item | Step 6.1 | No page to link to yet |
| Job edit (scope_notes, location, duration) | Phase 2 of 6B | Low priority, inline edit on detail page |
| LeadDetailPage job indicator | Step 6.1 or polish | Users navigate via estimate link |
| Batch status updates | Step 6.1 | Calendar/scheduling feature |
| Drag-and-drop scheduling | Step 10 | Polish phase |
| Duration tracking display | Step 6.1 | Nice-to-have |
