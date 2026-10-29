# Step 6B — Job Management Frontend: Unified Implementation Plan

> **Merged from:** PM Requirements, UI/UX Spec, Engineering Implementation Plan
> **Date:** 2026-02-27
> **Status:** APPROVED WITH REVISIONS — Team Lead reviewed, revisions applied

---

## Design Discussion Summary

### Round 1: Page Inventory & User Flows

**PM:** We need five user-facing surfaces:
1. **JobsPage** — primary list view with KPI strip, search, filters, export
2. **JobDetailPage** — full detail view with hero, tabs, actions
3. **NewUrgentJobDialog** — multi-step customer search + location + urgency form
4. **ScheduleJobDialog** — technician assignment + optional datetime
5. **CompleteJobDialog** + **CancelJobDialog** — simple textarea confirmation dialogs

Two job creation flows:
- **Standard:** User clicks "Create Job" on EstimateDetailPage (APPROVED estimate, deposit paid) -> POST /api/jobs { estimate_id } -> navigate to new job
- **Urgent:** User clicks "New Urgent Job" on JobsPage -> dialog flow -> POST /api/jobs { is_urgent, customer_id, service_location_id, urgency_reason } -> navigate to new job

**UI:** All surfaces map directly to existing patterns. No new visual patterns needed except:
- Timeline tab (simple chronological list -- new but trivial)
- Charges editable table (simplified version of estimate line items -- add via inline row, delete via trash icon)
- Urgent badge (orange AlertTriangle badge, consistent across list + detail + calendar)

**Engineer:** File structure follows the established convention: pages in `pages/`, dialogs in `components/jobs/`. Types defined locally per file (no shared types file). All seven new files + four modified files.

### Round 2: JobsPage (List)

**PM:** KPI metrics are status counts only (no dollar values like estimates). Five cells: Unassigned, Scheduled, In Progress, Completed, Cancelled. The backend bundles stats in the list response so one query serves both. Filters: status (multi), assigned tech (single), type urgent/standard (single). Empty state: "No jobs found." message in DataTable.

**UI:** The KPI strip uses `grid-cols-3 lg:grid-cols-5` with `divide-x`. Each cell shows icon + label + count. No subtitle dollar values (unlike estimates). The urgent badge in the job number column uses `AlertTriangle` icon in orange inline with the job number. Table columns: Job #, Customer, Status, Location, Assigned To, Scheduled, Created. The "Type" column is redundant with the urgent badge on the job number -- agreed to merge.

**Engineer:** Query key: `['jobs', { page, pageSize, search, statuses, assignedTo, isUrgent }]`. Technician list for filter fetched with `['users', { role: 'TECHNICIAN' }]` via `GET /api/users?role=TECHNICIAN`. Filter state: simple useState hooks (same pattern as EstimatesPage). Export: CSV with same pattern.

### Round 3: JobDetailPage

**PM:** Hero card shows: job number + status badge + urgent badge, customer name (linked), estimate link (if standard). Context strip: Client Details (name, phone, email) | Service Address | Job Info (number, status, type, created date). KPI strip: Estimate Total (standard) or Charges Total (urgent) | Scheduled Date | Duration | Completed Date.

Action buttons per status:
- UNASSIGNED: [Assign Tech] primary, overflow: [Cancel, Delete]
- SCHEDULED: [Start Job] primary, overflow: [Reassign, Unassign, Cancel]
- IN_PROGRESS: [Complete Job] primary, overflow: [Cancel]
- COMPLETED: read-only, no actions
- CANCELLED: read-only, no actions

**UI:** Five tabs:
1. **Work Items** (default) -- for standard jobs: read-only estimate line items (same rendering as EstimateDetailPage). For urgent jobs: editable charges table.
2. **Details** -- dl key-value pairs for all job metadata
3. **Notes** -- identical to EstimateDetailPage notes tab
4. **Timeline** -- chronological event list with event type icons and timestamps

Agreed to name the first tab "Work Items" instead of having separate "Line Items" and "Charges" tabs. The content adapts based on job type. This avoids conditional tab visibility and keeps the tab count manageable.

**Engineer:** Three parallel queries: job detail, notes, timeline. Mutations for all status actions + charges CRUD. The `getAvailableActions` helper function extracts role+status logic.

### Round 4: Job Creation Flows

**PM:** Standard flow is a single button click on EstimateDetailPage -- no form needed. The backend derives customer_id and service_location_id from the estimate. Urgent flow is a multi-step dialog.

**UI:** Standard: just a Button on EstimateDetailPage hero card. Show "View Job" link if job already exists. Show disabled button with message if deposit is REQUESTED. Urgent: dialog follows NewEstimateDialog pattern (search customers -> expand -> select location -> fill urgency form -> submit).

**Engineer:** Standard job creation uses a useMutation inline on EstimateDetailPage. Urgent job creation uses a useMutation in NewUrgentJobDialog. Both navigate to `/jobs/:id` on success. For the estimate detail page, need to verify the backend returns job data in the estimate response -- if not, a small backend addition is needed.

### Round 5: Action Dialogs & Status Transitions

**PM:** All confirmed as specified. Start Job is a direct button click (no dialog). Delete is a direct action with no dialog (UNASSIGNED only). Assign/Reassign, Complete, Cancel each have dialogs.

**UI:** Dialog sizes: ScheduleJobDialog `max-w-sm`, CompleteJobDialog `max-w-sm`, CancelJobDialog `max-w-sm`, NewUrgentJobDialog `max-w-md`. Button styles: "Complete" uses default variant (success action), "Cancel Job" uses destructive variant, "Start" uses default variant.

**Engineer:** All mutations follow the same invalidation pattern: invalidate `['job', id]`, `['jobs']`, and `['job-timeline', id]` on success.

### Round 6: Cross-Entity Integration

**PM:** Three integration points:
1. EstimateDetailPage: "Create Job" button + "View Job" link
2. CustomerDetailPage: Jobs tab already works, just needs JobDetailPage to exist at `/jobs/:id`
3. LeadDetailPage: Could show linked jobs from estimates, but this is P1 -- defer

**UI:** The EstimateDetailPage needs a "Create Job" button next to Send/Copy Link. When a job exists, show "View Job" outline button instead. The CustomerDetailPage Jobs tab already navigates to `/jobs/:id`.

**Engineer:** The EstimateDetailPage change requires verifying the backend estimate detail response includes job data. Check if `estimateDetailSelect` includes the `job` relation. If not, add it.

### Round 7: Edge Cases & Polish

**PM:** Edge cases: (1) Estimate already has a job (409 from backend -- show error toast), (2) Tech tries to start someone else's job (403 -- show error), (3) Job deleted while viewing (404 on refetch -- navigate to list).

**UI:** Loading state: Loader2 spinner centered (same as EstimateDetailPage). Error state: "Job not found" text centered. Permission denied: rely on backend 403; frontend shows error message from response.

**Engineer:** No error boundaries needed beyond existing patterns. Use the same `(mutation.error as ...)?.response?.data?.error` pattern for error display in dialogs.

---

## FINAL IMPLEMENTATION PLAN

### 1. Page & Component Inventory

#### New Files (7)

| # | File | Purpose | LOC Est. |
|---|------|---------|----------|
| 1 | `frontend/src/pages/JobsPage.tsx` | Full list page replacing placeholder | ~350 |
| 2 | `frontend/src/pages/JobDetailPage.tsx` | Job detail with hero, KPI, tabs, actions | ~650 |
| 3 | `frontend/src/components/jobs/NewUrgentJobDialog.tsx` | Multi-step: customer search -> location -> urgency form | ~250 |
| 4 | `frontend/src/components/jobs/AssignJobDialog.tsx` | Technician select + optional datetime | ~150 |
| 5 | `frontend/src/components/jobs/CompleteJobDialog.tsx` | Completion notes textarea | ~80 |
| 6 | `frontend/src/components/jobs/CancelJobDialog.tsx` | Cancellation reason textarea | ~80 |
| 7 | `frontend/src/pages/SchedulePage.tsx` | Placeholder for Step 6.1 (shows "Coming soon") | ~15 |

#### Modified Files (5)

| # | File | Changes |
|---|------|---------|
| 1 | `frontend/src/App.tsx` | Add lazy imports for JobDetailPage, SchedulePage; add routes `/jobs/:id`, `/schedule` |
| 2 | `frontend/src/pages/EstimateDetailPage.tsx` | Add "Create Job" / "View Job" button with deposit gate + **"Mark Deposit Paid" button** (ADMIN/DISPATCHER, when APPROVED + deposit REQUESTED) |
| 3 | `frontend/src/components/layout/nav-config.ts` | Add Schedule nav item (CalendarDays icon, ADMIN+DISPATCHER) |
| 4 | `backend/src/controllers/estimate.controller.ts` | Add `job` relation to `estimateDetailSelect` (confirmed missing) |
| 5 | `backend/src/controllers/job.controller.ts` | *(no change needed — verified API alignment)* |

#### No Changes Needed

- `status-badge.tsx` -- already has all job statuses
- `CustomerDetailPage.tsx` -- Jobs tab already navigates to `/jobs/:id`
- `data-table.tsx` -- reused as-is
- `filter-chip.tsx` -- reused as-is

---

### 2. Detailed Page Specs

#### 2.1 JobsPage.tsx

**Layout:** `div.space-y-6` containing heading, KPI strip, DataTable.

**Heading:** `h1 "Jobs"` + count pill badge (from `data.pagination.total`).

**KPI Strip:** Single `Card.p-0.overflow-hidden` with `grid grid-cols-3 divide-x divide-border lg:grid-cols-5`.

| Cell | Icon | Label | Value |
|------|------|-------|-------|
| 1 | AlertCircle | Unassigned | `stats.unassigned` |
| 2 | CalendarDays | Scheduled | `stats.scheduled` |
| 3 | Play | In Progress | `stats.in_progress` |
| 4 | CheckCircle2 | Completed | `stats.completed` |
| 5 | Ban | Cancelled | `stats.cancelled` |

Each cell: icon (h-5 w-5 text-gray-400) + label (xs uppercase tracking-wide text-secondary) + count (2xl font-bold tabular-nums). No dollar subtitles (unlike estimates -- jobs have counts only).

**DataTable Columns (7):**

```typescript
const columns: ColumnDef<JobListItem, unknown>[] = [
  {
    accessorKey: 'job_number',
    header: 'Job #',
    cell: ({ row }) => (
      <div className="flex items-center gap-2">
        <span className="font-medium text-primary">{row.original.job_number}</span>
        {row.original.is_urgent && (
          <Badge variant="outline" className="bg-danger/10 text-danger border-danger/20 text-[10px]">
            <AlertTriangle className="h-3 w-3 mr-0.5" />
            Urgent
          </Badge>
        )}
      </div>
    ),
  },
  {
    accessorKey: 'customer',
    header: 'Customer',
    cell: ({ row }) => (
      <div>
        <span className="font-medium text-text-primary">
          {row.original.customer.first_name} {row.original.customer.last_name}
        </span>
        {row.original.customer.company_name && (
          <p className="text-xs text-text-secondary">{row.original.customer.company_name}</p>
        )}
      </div>
    ),
  },
  {
    accessorKey: 'status',
    header: 'Status',
    cell: ({ row }) => <StatusBadge status={row.original.status} />,
  },
  {
    accessorKey: 'service_location',
    header: 'Location',
    cell: ({ row }) => {
      const loc = row.original.service_location;
      return loc
        ? <span className="text-sm">{loc.address_line1}, {loc.city}</span>
        : <span className="text-text-secondary italic">--</span>;
    },
  },
  {
    accessorKey: 'assigned_user',
    header: 'Assigned To',
    cell: ({ row }) => {
      const tech = row.original.assigned_user;
      return tech
        ? <span>{tech.first_name} {tech.last_name}</span>
        : <span className="text-text-secondary italic">Unassigned</span>;
    },
  },
  {
    accessorKey: 'scheduled_start',
    header: 'Scheduled',
    cell: ({ row }) =>
      row.original.scheduled_start
        ? new Date(row.original.scheduled_start).toLocaleDateString()
        : <span className="text-text-secondary">{'\u2014'}</span>,
  },
  {
    accessorKey: 'created_at',
    header: 'Created',
    cell: ({ row }) => new Date(row.original.created_at).toLocaleDateString(),
  },
];
```

**Filter State:**
```typescript
const [page, setPage] = useState(1);
const [pageSize, setPageSize] = useState(25);
const [search, setSearch] = useState('');
const [statuses, setStatuses] = useState<string[]>([]);
const [assignedTo, setAssignedTo] = useState('');
const [isUrgent, setIsUrgent] = useState(''); // '' | 'true' | 'false'
const [showUrgentDialog, setShowUrgentDialog] = useState(false);
```

**Filters (DropdownMenu):**
- Status sub-menu: multi-select checkboxes for UNASSIGNED, SCHEDULED, IN_PROGRESS, COMPLETED, CANCELLED
- Assigned To sub-menu: single-select, fetched from `GET /api/users?role=TECHNICIAN`
- Type sub-menu: single-select (All / Standard / Urgent)

**Header Actions:**
- Export CSV button
- "New Urgent Job" button (opens NewUrgentJobDialog). Visible to ADMIN, DISPATCHER, TECHNICIAN.

**Query:**
```typescript
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
```

**Technician list for filter:**
```typescript
const { data: techsData } = useQuery({
  queryKey: ['users', { role: 'TECHNICIAN' }],
  queryFn: async () => {
    const { data } = await api.get('/api/users', { params: { role: 'TECHNICIAN' } });
    return data.users;
  },
});
```

---

#### 2.2 JobDetailPage.tsx

**Layout:** `div.space-y-4` containing Breadcrumb, Hero Card, Tabs Card.

**Breadcrumb:** Context-aware via `location.state?.breadcrumbs`. Default: `[Jobs, {job_number}]`.

**Hero Card (Card.p-4):**

Top row: Job number (h1, text-xl) + StatusBadge + Urgent badge (if is_urgent) | Action buttons (right-aligned).

Customer subtitle: "Customer Name -- Company | View Estimate (link, if standard job)"

**Context Strip (3-col grid, border-t, mt-4):**
- Col 1: Client Details (name, phone with formatPhone, email)
- Col 2: Service Address (address_line1, line2, city state zip)
- Col 3: Job Info (number, type, created date, assigned tech if any)

**KPI Strip (grid, divide-x, border-t, mt-4):**

For standard jobs:
| Metric | Icon | Value |
|--------|------|-------|
| Estimate Total | FileText | formatCurrency(estimate.total_amount) |
| Duration | Clock | estimated_duration ? `${estimated_duration} min` : '--' |
| Scheduled | CalendarDays | scheduled_start date or '--' |
| Completed | CheckCircle2 | completed_at date or '--' |

For urgent jobs:
| Metric | Icon | Value |
|--------|------|-------|
| Charges Total | DollarSign | sum of charges line_total |
| Duration | Clock | estimated_duration or '--' |
| Scheduled | CalendarDays | scheduled_start date or '--' |
| Completed | CheckCircle2 | completed_at date or '--' |

**Action Buttons (getAvailableActions helper):**

```typescript
function getAvailableActions(job: JobDetail, userRole: string, userId: string) {
  const canManage = userRole === 'ADMIN' || userRole === 'DISPATCHER';
  const isAssignedTech = userRole === 'TECHNICIAN' && job.assigned_to === userId;
  const canWork = canManage || isAssignedTech;

  return {
    canAssign: canManage && ['UNASSIGNED', 'SCHEDULED'].includes(job.status),
    canUnassign: canManage && job.status === 'SCHEDULED',
    canStart: canWork && job.status === 'SCHEDULED',
    canComplete: canWork && job.status === 'IN_PROGRESS',
    canCancel: canManage && ['UNASSIGNED', 'SCHEDULED', 'IN_PROGRESS'].includes(job.status),
    canDelete: canManage && job.status === 'UNASSIGNED' && !job.invoice,
    canEditCharges: canWork && job.is_urgent && !['COMPLETED', 'CANCELLED'].includes(job.status),
    canAddNotes: userRole !== 'SALES',
  };
}
```

Primary button placement:
- UNASSIGNED: "Assign Tech" primary button
- SCHEDULED: "Start Job" primary button
- IN_PROGRESS: "Complete Job" primary button
- COMPLETED/CANCELLED: no primary button

Overflow menu (three-dot MoreHorizontal):
- UNASSIGNED: Cancel, Delete
- SCHEDULED: Reassign (opens AssignJobDialog), Unassign, Cancel
- IN_PROGRESS: Cancel

**Tabs Card (Card.p-0):**

Tab 1: **Work Items** (default tab)
- Standard jobs: read-only estimate line items using the same rendering as EstimateDetailPage (image thumbnail, name, detail, qty, unit_price, taxable flag, line_total). Plus totals section.
- Urgent jobs: charges table with Add Charge button (if canEditCharges). Each charge row: description, qty, unit_price, taxable, line_total, edit/delete buttons. Running total at bottom.

Tab 2: **Details**
- dl list with key-value pairs:
  - Job Number, Status, Type (Standard/Urgent), Created (date)
  - Assigned To (tech name or "Unassigned")
  - Scheduled Start, Scheduled End, Duration
  - Scope Notes (whitespace-pre-wrap)
  - Urgency Reason (urgent jobs only)
  - Completion Notes (completed jobs only, with completed_at timestamp)
  - Cancellation Reason (cancelled jobs only, with cancelled_at timestamp)
  - Linked Estimate (link to `/estimates/:id`, standard jobs only)

Tab 3: **Notes** (count in tab label)
- Same pattern as EstimateDetailPage: textarea + Add Note button + chronological list.
- SALES users: no textarea (read-only).

Tab 4: **Timeline** (count in tab label)
- Chronological list (newest first). Each event:
  ```
  [EventTypeIcon] Event description
  By FirstName LastName -- timestamp
  ```
- Event type icons: CREATED (Plus), ASSIGNED (UserCheck), UNASSIGNED (UserX), STARTED (Play), COMPLETED (CheckCircle2), CANCELLED (XCircle)

**Queries:**
```typescript
// Job detail
const { data: jobData, isLoading } = useQuery({
  queryKey: ['job', id],
  queryFn: async () => { const { data } = await api.get(`/api/jobs/${id}`); return data.job; },
});

// Notes
const { data: notesData, refetch: refetchNotes } = useQuery({
  queryKey: ['job-notes', id],
  queryFn: async () => { const { data } = await api.get(`/api/jobs/${id}/notes`); return data.notes; },
  enabled: Boolean(id),
});

// Timeline
const { data: timelineData } = useQuery({
  queryKey: ['job-timeline', id],
  queryFn: async () => { const { data } = await api.get(`/api/jobs/${id}/timeline`); return data.events; },
  enabled: Boolean(id),
});
```

---

#### 2.3 NewUrgentJobDialog.tsx

**Layout:** Same as NewEstimateDialog -- centered icon (Briefcase), title "Create Urgent Job", search input, results list.

**Flow:**
1. User types customer search (min 2 chars, debounced 300ms)
2. Customer results appear as clickable rows
3. Click customer -> expand to show service locations (fetched from `GET /api/customers/:id` which includes locations in the response)
4. Click location -> form section appears below with:
   - Urgency Reason (required, Textarea, 3 rows)
   - Scope Notes (optional, Textarea, 2 rows)
5. Submit button ("Create Urgent Job") calls `POST /api/jobs { is_urgent: true, customer_id, service_location_id, urgency_reason, scope_notes }`
6. On success: close dialog, navigate to `/jobs/:id`

**State:**
```typescript
const [search, setSearch] = useState('');
const [debouncedSearch, setDebouncedSearch] = useState('');
const [selectedCustomerId, setSelectedCustomerId] = useState<string | null>(null);
const [selectedLocationId, setSelectedLocationId] = useState<string | null>(null);
const [urgencyReason, setUrgencyReason] = useState('');
const [scopeNotes, setScopeNotes] = useState('');
```

**Customer search query:** Same as NewEstimateDialog: `GET /api/customers?search=...&limit=6`.

**Location fetch:** When customer is expanded, use `GET /api/customers/:id` which returns `service_locations[]` in the response.

---

#### 2.4 AssignJobDialog.tsx

**Layout:** `Dialog` with `max-w-sm`. Header: "Assign Technician" / "Reassign Technician" (based on currentAssignedTo prop).

**Fields:**
1. Technician (Select, required) -- fetches `GET /api/users?role=TECHNICIAN`, shows only active users
2. Scheduled Start (datetime-local input, optional)
3. Scheduled End (datetime-local input, optional)

**Props:**
```typescript
interface AssignJobDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  jobId: string;
  currentAssignedTo?: string | null;
}
```

**Submit:** `POST /api/jobs/:id/assign { assigned_to, scheduled_start?, scheduled_end? }`

**Invalidation:** `['job', jobId]`, `['jobs']`, `['job-timeline', jobId]`

---

#### 2.5 CompleteJobDialog.tsx

**Layout:** Identical to CancelEstimateDialog pattern. `max-w-sm`.

**Header:** "Complete Job" + description "Please provide completion notes."

**Fields:** Completion Notes (required, Textarea, 3 rows, placeholder "Describe the work completed...")

**Submit button:** "Complete Job" (default variant, not destructive). Disabled if notes empty or mutation pending.

**Submit:** `POST /api/jobs/:id/complete { completion_notes }`

---

#### 2.6 CancelJobDialog.tsx

**Layout:** Copy of CancelEstimateDialog. `max-w-sm`.

**Header:** "Cancel Job" + description "This action cannot be undone. Please provide a reason."

**Fields:** Reason (required, Textarea, 3 rows)

**Submit button:** "Cancel Job" (destructive variant). Disabled if reason empty or mutation pending.

**Submit:** `POST /api/jobs/:id/cancel { cancelled_reason }`

---

### 3. API Integration Map

#### Query Keys

| Key | Endpoint | Where Used | When Fires |
|-----|----------|------------|------------|
| `['jobs', filters]` | `GET /api/jobs` | JobsPage | On mount, filter/page change |
| `['job', id]` | `GET /api/jobs/:id` | JobDetailPage | On mount |
| `['job-notes', id]` | `GET /api/jobs/:id/notes` | JobDetailPage Notes tab | On mount (enabled: id) |
| `['job-timeline', id]` | `GET /api/jobs/:id/timeline` | JobDetailPage Timeline tab | On mount (enabled: id) |
| `['users', { role: 'TECHNICIAN' }]` | `GET /api/users?role=TECHNICIAN` | AssignJobDialog, JobsPage filter | On dialog open / page mount |
| `['customers-search', search]` | `GET /api/customers?search=...` | NewUrgentJobDialog | On search input |
| `['customer', id]` | `GET /api/customers/:id` | NewUrgentJobDialog (locations) | On customer expand |

#### Mutations & Invalidation

| Action | Endpoint | Invalidates | Navigation |
|--------|----------|------------|------------|
| Create standard job | `POST /api/jobs { estimate_id }` | `['jobs']`, `['estimate', estId]`, `['estimates']` | `/jobs/:newId` |
| Create urgent job | `POST /api/jobs { is_urgent, ... }` | `['jobs']` | `/jobs/:newId` |
| Assign job | `POST /api/jobs/:id/assign` | `['job', id]`, `['jobs']`, `['job-timeline', id]` | -- |
| Unassign job | `POST /api/jobs/:id/unassign` | `['job', id]`, `['jobs']`, `['job-timeline', id]` | -- |
| Start job | `POST /api/jobs/:id/start` | `['job', id]`, `['jobs']`, `['job-timeline', id]` | -- |
| Complete job | `POST /api/jobs/:id/complete` | `['job', id]`, `['jobs']`, `['job-timeline', id]` | -- |
| Cancel job | `POST /api/jobs/:id/cancel` | `['job', id]`, `['jobs']`, `['job-timeline', id]` | -- |
| Delete job | `DELETE /api/jobs/:id` | `['jobs']` | `/jobs` |
| Add note | `POST /api/jobs/:id/notes` | `refetchNotes()` | -- |
| Add charge | `POST /api/jobs/:id/charges` | `['job', id]` | -- |
| Update charge | `PATCH /api/jobs/:id/charges/:cid` | `['job', id]` | -- |
| Remove charge | `DELETE /api/jobs/:id/charges/:cid` | `['job', id]` | -- |

---

### 4. Routing Changes (App.tsx)

#### New Lazy Imports

```typescript
const JobDetailPage = lazy(() => import('@/pages/JobDetailPage'));
const SchedulePage = lazy(() => import('@/pages/SchedulePage'));
```

Note: `JobsPage` is already imported (line 13).

#### New Routes

Add inside the AppLayout ProtectedRoute block, after the existing `/jobs` route:

```tsx
<Route path="/jobs/:id" element={<JobDetailPage />} />
<Route path="/schedule" element={<SchedulePage />} />
```

No `/jobs/new` route needed -- standard jobs are created via button on EstimateDetailPage, urgent jobs via dialog on JobsPage.

#### Nav Config Change

Add to `nav-config.ts` OPERATIONS section, after Jobs:

```typescript
{
  label: 'Schedule',
  href: '/schedule',
  icon: CalendarDays,
  roles: ['ADMIN', 'DISPATCHER'],
},
```

Import `CalendarDays` from lucide-react.

---

### 5. Cross-Entity Changes

#### 5.1 EstimateDetailPage.tsx

**What to add:** "Create Job" button and "View Job" link in the hero card action buttons area.

**Backend change REQUIRED:** Verified that `estimateDetailSelect` in `estimate.controller.ts` (line 38-121) does NOT include the `job` relation. Must add after the `deposit` field:
```typescript
job: { select: { id: true, job_number: true, status: true } },
```
This is a one-line addition at line 121 of `estimate.controller.ts`, inside the `estimateDetailSelect` object. The Prisma schema already has the `Estimate -> Job` relation (one-to-one via `estimate_id` on Job).

**Frontend logic:**
```typescript
const isApproved = est.status === 'APPROVED';
const hasJob = Boolean(est.job);
const depositBlocked = est.deposit && est.deposit.status === 'REQUESTED';
const canConvert = (user?.role === 'ADMIN' || user?.role === 'DISPATCHER') && isApproved && !hasJob;

// Create Job mutation
const createJobMutation = useMutation({
  mutationFn: async () => {
    const { data } = await api.post('/api/jobs', { estimate_id: id });
    return data.job;
  },
  onSuccess: (job) => {
    queryClient.invalidateQueries({ queryKey: ['estimate', id] });
    queryClient.invalidateQueries({ queryKey: ['estimates'] });
    queryClient.invalidateQueries({ queryKey: ['jobs'] });
    navigate(`/jobs/${job.id}`);
  },
});
```

**Button placement:** In the hero card action buttons div, after existing buttons:
```tsx
{canConvert && !depositBlocked && (
  <Button onClick={() => createJobMutation.mutate()} disabled={createJobMutation.isPending}>
    {createJobMutation.isPending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Briefcase className="mr-2 h-4 w-4" />}
    Create Job
  </Button>
)}
{canConvert && depositBlocked && (
  <Button disabled title="Deposit must be paid before creating a job">
    <Briefcase className="mr-2 h-4 w-4" />
    Create Job
  </Button>
)}
{hasJob && (
  <Button variant="outline" onClick={() => navigate(`/jobs/${est.job.id}`, {
    state: { breadcrumbs: [
      { label: 'Estimates', href: '/estimates' },
      { label: est.estimate_number, href: `/estimates/${id}` },
    ]}
  })}>
    <Briefcase className="mr-2 h-4 w-4" />
    View Job
  </Button>
)}
```

#### 5.2 CustomerDetailPage.tsx

**No changes needed.** The Jobs tab already navigates to `/jobs/:id` which will now resolve to JobDetailPage. Cross-entity breadcrumbs already work via `navWithBreadcrumbs`.

#### 5.3 LeadDetailPage.tsx

**Deferred to P1.** Currently leads show estimates but not jobs. Adding job visibility from leads is not critical for MVP.

---

### 6. Implementation Order

```
Phase 1: Foundation (no dependencies, ~30 min)
  1.1  App.tsx — add lazy imports + routes for /jobs/:id, /schedule
  1.2  nav-config.ts — add Schedule nav item
  1.3  SchedulePage.tsx — "Coming soon" placeholder

Phase 2: Simple Dialogs (no dependencies, ~1 hour)
  2.1  CancelJobDialog.tsx — copy CancelEstimateDialog, change endpoint
  2.2  CompleteJobDialog.tsx — same pattern, different field name
  2.3  AssignJobDialog.tsx — tech select + datetime inputs

Phase 3: JobsPage (depends on Phase 1, ~2 hours)
  3.1  JobsPage.tsx — full rewrite replacing placeholder
       KPI strip, columns, filters, search, export, urgent job button
  3.2  NewUrgentJobDialog.tsx — multi-step customer search + location + form
       Test: list loads, filters work, row click navigates, urgent creation works

Phase 4: JobDetailPage (depends on Phase 2 + 3, ~3 hours)
  4.1  JobDetailPage.tsx — hero card, KPI strip, action buttons
  4.2  Work Items tab — standard (line items) + urgent (charges table)
  4.3  Details tab
  4.4  Notes tab
  4.5  Timeline tab
       Test: all status transitions, charge CRUD, notes, breadcrumbs

Phase 5: Cross-Entity (depends on Phase 4, ~1 hour)
  5.1  Backend check — verify estimate detail includes job relation
  5.2  EstimateDetailPage.tsx — "Create Job" / "View Job" buttons

Total estimated time: ~7-8 hours
```

---

### 7. TypeScript Interfaces

All interfaces defined locally in each page file (matching existing pattern).

#### JobsPage types

```typescript
interface JobListItem {
  id: string;
  job_number: string;
  status: string;
  is_urgent: boolean;
  scheduled_start: string | null;
  scheduled_end: string | null;
  created_at: string;
  customer: { id: string; first_name: string; last_name: string; company_name: string | null };
  assigned_user: { id: string; first_name: string; last_name: string } | null;
  service_location: { id: string; address_line1: string; city: string; state: string } | null;
}

interface JobStats {
  unassigned: number;
  scheduled: number;
  in_progress: number;
  completed: number;
  cancelled: number;
}
```

#### JobDetailPage types

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
    id: string; first_name: string; last_name: string;
    company_name: string | null; email: string | null; phone: string;
  };
  assigned_user: { id: string; first_name: string; last_name: string; email: string | null } | null;
  service_location: {
    id: string; address_line1: string; address_line2: string | null;
    city: string; state: string; zip: string;
  } | null;
  estimate: {
    id: string; estimate_number: string; total_amount: number | string; status: string;
    deposit: { id: string; amount: number | string; status: string; paid_at: string | null } | null;
    line_items: EstimateLineItem[];
  } | null;
  charges: JobCharge[];
  invoice: { id: string; invoice_number: string; status: string; total_amount: number | string } | null;
}

interface EstimateLineItem {
  id: string; sequence: number; description: string;
  quantity: number; unit_price: number; is_taxable: boolean;
  line_total: number; item_type: string;
}

interface JobCharge {
  id: string; sequence: number; description: string;
  quantity: number; unit_price: number; is_taxable: boolean; line_total: number;
}

interface TimelineEvent {
  id: string; event_type: string; description: string;
  metadata: Record<string, unknown> | null; created_at: string;
  creator: { id: string; first_name: string; last_name: string };
}
```

---

### 8. Charges Table Design (Urgent Jobs)

The Work Items tab for urgent jobs shows an editable charges table.

**Layout:**
```
[+ Add Charge] button (top-right, visible when canEditCharges)

Table:
| # | Description | Qty | Unit Price | Taxable | Total | Actions |
|---|------------|-----|-----------|---------|-------|---------|
| 1 | AC repair  | 1   | $150.00   | Yes     | $150  | [Edit] [Delete] |
| 2 | Refrigerant| 2   | $45.00    | Yes     | $90   | [Edit] [Delete] |

Running Total: $240.00
```

**Add Charge:** Opens inline row at bottom of table (not a separate dialog). Fields: description (text input), quantity (number input), unit_price (number input), is_taxable (checkbox, default true). Save/Cancel buttons on the row.

**Edit Charge:** Clicking Edit replaces the row with editable inputs (same fields). Save/Cancel.

**Delete Charge:** Clicking trash icon shows a confirmation prompt (or just deletes immediately since it's a small action).

**Simpler alternative (recommended):** Instead of inline editing, use a small dialog for add/edit. This avoids complex inline edit state management. The dialog has the same four fields. Delete is direct with no confirmation (undo is not supported, but the action is low-risk).

Decision: Use a **small dialog** for add/edit charges, and **direct delete** (no confirmation) for removing charges. This keeps the implementation simple.

---

### 9. Risk Mitigations

| Risk | Mitigation |
|------|-----------|
| NewUrgentJobDialog complexity | Copy NewEstimateDialog structure closely; replace lead selection with location selection. Same state pattern. |
| Role+status action matrix complexity | Extract to `getAvailableActions()` pure function. Test with different role/status combinations. |
| Stale data after status transitions | All mutations invalidate both `['job', id]` and `['jobs']` to keep list page KPI stats fresh. |
| Estimate detail missing job relation | Check backend before implementation. If missing, add `job` to `estimateDetailSelect` (tiny change). |
| Calendar page (SchedulePage) | Deferred to Step 6.1. Just a placeholder for now. No react-big-calendar dependency needed yet. |

---

### 10. What's NOT in Scope (Deferred)

- **SchedulePage calendar view** -- Step 6.1 (separate task)
- **react-big-calendar dependency** -- not needed until 6.1
- **LeadDetailPage job visibility** -- P1, not blocking
- **Job editing form** -- PATCH /api/jobs/:id is available but editing scope_notes/schedule can be done inline on the detail page or via the assign dialog. No separate edit form page needed.
- **Toast notifications** -- Nice to have but not in existing patterns. Use the same approach as other pages (no toasts currently).
- **Optimistic updates** -- Not used anywhere in the codebase. Stick with invalidation-based refetching.
- **Thumbnails on job Work Items tab** -- Standard job line items will NOT render price book item thumbnails (unlike EstimateDetailPage). The backend `jobDetailSelect` doesn't include `price_book_item` in estimate line items. This is intentional — the job is the work record, not the sales document.
- **Inline duration editing** -- `estimated_duration` is read-only on the Details tab. Editable via the Assign dialog or direct PATCH (API exists but no UI).

---

## TEAM LEAD REVIEW

> **Reviewer:** Development Team Lead
> **Verdict:** APPROVED WITH REVISIONS
> **Date:** 2026-02-27

### Revisions Applied

#### Critical Fix: Mark Deposit Paid Button (C1)

**Problem:** The "Create Job" button on EstimateDetailPage is blocked when `deposit.status === 'REQUESTED'`. But there is NO UI to mark the deposit as paid. The backend endpoint exists (`POST /api/estimates/:id/mark-deposit-paid`, ADMIN/DISPATCHER only) but the frontend never wired it. Without this button, the standard job creation flow is broken for estimates with deposits.

**Fix:** Add a "Mark Deposit Paid" button to EstimateDetailPage as part of Phase 5:

```typescript
// Mark Deposit Paid mutation
const markDepositPaidMutation = useMutation({
  mutationFn: async () => {
    const { data } = await api.post(`/api/estimates/${id}/mark-deposit-paid`);
    return data;
  },
  onSuccess: () => {
    queryClient.invalidateQueries({ queryKey: ['estimate', id] });
  },
});
```

Button placement (hero card, near "Create Job"):
```tsx
{est.status === 'APPROVED' && est.deposit?.status === 'REQUESTED' &&
 (user?.role === 'ADMIN' || user?.role === 'DISPATCHER') && (
  <Button variant="outline" onClick={() => markDepositPaidMutation.mutate()}
    disabled={markDepositPaidMutation.isPending}>
    {markDepositPaidMutation.isPending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <DollarSign className="mr-2 h-4 w-4" />}
    Mark Deposit Paid
  </Button>
)}
```

#### Important Notes Added

**I1. SALES Role on JobsPage:**
- SALES is excluded from Jobs nav item (correct) but `/jobs` route is not role-gated in App.tsx
- If SALES navigates to `/jobs` directly (e.g., via URL), they'll see a filtered list (only their leads' jobs) — this is acceptable behavior
- **Action:** Hide "New Urgent Job" button and Export for SALES role. No route-level gating needed.

**I4. Charges Dialog is Inline:**
- The charge add/edit dialog is implemented **inline within JobDetailPage.tsx**, not as a separate component file
- This keeps the file inventory clean and follows the notes-inline pattern
- JobDetailPage LOC estimate increases from ~650 to ~750

**I6. KPI Stats Are Global Counts:**
- The backend `GET /api/jobs` stats are **global counts** (not role-filtered)
- A TECHNICIAN will see "5 Unassigned" in KPI but 0 rows in their table (they only see assigned jobs)
- **Accepted for MVP.** Consider role-filtered stats in future iteration.

#### Minor Additions

**Delete Confirmation:** Add `window.confirm('Are you sure you want to delete this job?')` before calling `DELETE /api/jobs/:id`. Low-effort safety net.

**Start/Unassign Loading States:** All direct-action buttons (Start Job, Unassign) must show `isPending` state with `Loader2` spinner, matching the Create Job button pattern.

**Error Display for Create Job:** Show `error.response.data.error` message when the mutation fails (e.g., 409 conflict if estimate already has a job). Use the same inline error pattern as dialog mutations.

**CSV Export Columns:** Follow EstimatesPage pattern — export all visible columns. File named `jobs-export-YYYY-MM-DD.csv`.

### Decisions Confirmed

| Question | Answer |
|----------|--------|
| Thumbnails on job Work Items? | No — skip for MVP |
| SALES access to /jobs route? | Allow (read-only, filtered). Hide action buttons. |
| Mark Deposit Paid in scope? | Yes — required for Create Job flow |
| Duration editable on detail? | No — defer to assign dialog |
| "Created by" on job detail? | Not available (backend doesn't include creator). Accepted for MVP. |

### Updated Implementation Order

```
Phase 1: Foundation (~30 min)
  1.1  App.tsx — add lazy imports + routes
  1.2  nav-config.ts — add Schedule nav item
  1.3  SchedulePage.tsx — placeholder

Phase 2: Simple Dialogs (~1 hour)
  2.1  CancelJobDialog.tsx
  2.2  CompleteJobDialog.tsx
  2.3  AssignJobDialog.tsx

Phase 3: JobsPage (~2 hours)
  3.1  JobsPage.tsx — full rewrite (hide actions for SALES)
  3.2  NewUrgentJobDialog.tsx

Phase 4: JobDetailPage (~3.5 hours)  ← increased from 3h
  4.1  Hero card + KPI strip + action buttons (with loading states)
  4.2  Work Items tab (standard line items + urgent charges w/ inline dialog)
  4.3  Details tab
  4.4  Notes tab
  4.5  Timeline tab

Phase 5: Cross-Entity (~1.5 hours)  ← increased from 1h
  5.1  Backend: add `job` relation to `estimateDetailSelect`
  5.2  EstimateDetailPage: "Mark Deposit Paid" button
  5.3  EstimateDetailPage: "Create Job" / "View Job" buttons
  5.4  Verify CustomerDetailPage Jobs tab works end-to-end

Total: ~8-9 hours
```
