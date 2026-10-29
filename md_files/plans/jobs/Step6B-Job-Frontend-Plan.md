# Step 6B — Job Management Frontend: Engineering Implementation Plan

## 1. File List

### New Files

| File | Purpose |
|------|---------|
| `frontend/src/pages/JobsPage.tsx` | Full list page (replaces placeholder) |
| `frontend/src/pages/JobDetailPage.tsx` | Job detail — hero, KPI, sidebar+tabs, actions |
| `frontend/src/pages/SchedulePage.tsx` | Calendar page (react-big-calendar) — Step 6.1, stubbed route now |
| `frontend/src/components/jobs/NewUrgentJobDialog.tsx` | Customer search → location → urgency form |
| `frontend/src/components/jobs/ScheduleJobDialog.tsx` | Technician picker + datetime for assign |
| `frontend/src/components/jobs/CompleteJobDialog.tsx` | Completion notes textarea |
| `frontend/src/components/jobs/CancelJobDialog.tsx` | Cancellation reason textarea |

### Modified Files

| File | Changes |
|------|---------|
| `frontend/src/App.tsx` | Add lazy imports + routes for `/jobs/:id`, `/schedule` |
| `frontend/src/pages/EstimateDetailPage.tsx` | Add "Convert to Job" button (APPROVED status, deposit check) |
| `frontend/src/pages/LeadDetailPage.tsx` | Show linked job in estimates table or separate row |
| `frontend/src/components/ui/status-badge.tsx` | Already has job statuses — no changes needed |
| `frontend/src/components/layout/nav-config.ts` | Add Schedule nav item (Calendar icon, ADMIN+DISPATCHER) |
| `frontend/package.json` | Add `react-big-calendar`, `date-fns`, `@types/react-big-calendar` |

---

## 2. TypeScript Interfaces

All interfaces defined locally in each page file (matching existing pattern — no shared types file).

### JobsPage.tsx types

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

### JobDetailPage.tsx types

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

### Dialog types

```typescript
// ScheduleJobDialog
interface ScheduleJobDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  jobId: string;
  currentAssignedTo?: string | null;
}

// CompleteJobDialog
interface CompleteJobDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  jobId: string;
}

// CancelJobDialog
interface CancelJobDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  jobId: string;
}

// NewUrgentJobDialog
interface NewUrgentJobDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}
```

---

## 3. API Integration Layer — TanStack Query

### Query Keys

```typescript
// List + stats (bundled in one response)
['jobs', { page, pageSize, search, statuses, assignedTo, isUrgent, dateRange }]

// Single job detail
['job', jobId]

// Job notes
['job-notes', jobId]

// Job timeline
['job-timeline', jobId]

// Job charges (if fetched separately — usually in detail response)
['job-charges', jobId]

// Technicians list (for assignment dialog)
['users', { role: 'TECHNICIAN' }]
```

### Fetcher Functions (inline in useQuery, matching existing pattern)

```typescript
// List jobs — JobsPage
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

// Job detail — JobDetailPage
const { data: jobData, isLoading } = useQuery({
  queryKey: ['job', id],
  queryFn: async () => {
    const { data } = await api.get(`/api/jobs/${id}`);
    return data.job;
  },
});

// Job notes — separate query (like estimate notes)
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
```

### Mutations

```typescript
// Create standard job (from estimate)
const createJobMutation = useMutation({
  mutationFn: async (estimateId: string) => {
    const { data } = await api.post('/api/jobs', { estimate_id: estimateId });
    return data.job;
  },
  onSuccess: (job) => {
    queryClient.invalidateQueries({ queryKey: ['jobs'] });
    queryClient.invalidateQueries({ queryKey: ['estimate', estimateId] });
    navigate(`/jobs/${job.id}`);
  },
});

// Create urgent job
const createUrgentMutation = useMutation({
  mutationFn: async (body: {
    is_urgent: true;
    customer_id: string;
    service_location_id: string;
    urgency_reason: string;
    scope_notes?: string;
  }) => {
    const { data } = await api.post('/api/jobs', body);
    return data.job;
  },
  onSuccess: (job) => {
    queryClient.invalidateQueries({ queryKey: ['jobs'] });
    navigate(`/jobs/${job.id}`);
  },
});

// Assign job
const assignMutation = useMutation({
  mutationFn: async (body: { assigned_to: string; scheduled_start?: string; scheduled_end?: string }) => {
    const { data } = await api.post(`/api/jobs/${id}/assign`, body);
    return data.job;
  },
  onSuccess: () => {
    queryClient.invalidateQueries({ queryKey: ['job', id] });
    queryClient.invalidateQueries({ queryKey: ['jobs'] });
  },
});

// Unassign
const unassignMutation = useMutation({
  mutationFn: async () => {
    const { data } = await api.post(`/api/jobs/${id}/unassign`);
    return data.job;
  },
  onSuccess: () => {
    queryClient.invalidateQueries({ queryKey: ['job', id] });
    queryClient.invalidateQueries({ queryKey: ['jobs'] });
  },
});

// Start job
const startMutation = useMutation({
  mutationFn: async () => {
    const { data } = await api.post(`/api/jobs/${id}/start`);
    return data.job;
  },
  onSuccess: () => {
    queryClient.invalidateQueries({ queryKey: ['job', id] });
    queryClient.invalidateQueries({ queryKey: ['jobs'] });
    queryClient.invalidateQueries({ queryKey: ['job-timeline', id] });
  },
});

// Complete job
const completeMutation = useMutation({
  mutationFn: async (body: { completion_notes: string }) => {
    const { data } = await api.post(`/api/jobs/${id}/complete`, body);
    return data.job;
  },
  onSuccess: () => {
    queryClient.invalidateQueries({ queryKey: ['job', id] });
    queryClient.invalidateQueries({ queryKey: ['jobs'] });
    queryClient.invalidateQueries({ queryKey: ['job-timeline', id] });
  },
});

// Cancel job
const cancelMutation = useMutation({
  mutationFn: async (body: { cancelled_reason: string }) => {
    const { data } = await api.post(`/api/jobs/${id}/cancel`, body);
    return data.job;
  },
  onSuccess: () => {
    queryClient.invalidateQueries({ queryKey: ['job', id] });
    queryClient.invalidateQueries({ queryKey: ['jobs'] });
    queryClient.invalidateQueries({ queryKey: ['job-timeline', id] });
  },
});

// Delete job
const deleteMutation = useMutation({
  mutationFn: async () => {
    await api.delete(`/api/jobs/${id}`);
  },
  onSuccess: () => {
    queryClient.invalidateQueries({ queryKey: ['jobs'] });
    navigate('/jobs');
  },
});

// Add note
const addNoteMutation = useMutation({
  mutationFn: async (body: { content: string }) => {
    const { data } = await api.post(`/api/jobs/${id}/notes`, body);
    return data.note;
  },
  onSuccess: () => {
    refetchNotes();
    setNoteContent('');
  },
});

// Add charge (urgent jobs only)
const addChargeMutation = useMutation({
  mutationFn: async (body: { description: string; quantity: number; unit_price: number; is_taxable: boolean }) => {
    const { data } = await api.post(`/api/jobs/${id}/charges`, body);
    return data.charge;
  },
  onSuccess: () => {
    queryClient.invalidateQueries({ queryKey: ['job', id] });
  },
});

// Update charge
const updateChargeMutation = useMutation({
  mutationFn: async ({ chargeId, ...body }: { chargeId: string } & Partial<{ description: string; quantity: number; unit_price: number; is_taxable: boolean }>) => {
    const { data } = await api.patch(`/api/jobs/${id}/charges/${chargeId}`, body);
    return data.charge;
  },
  onSuccess: () => {
    queryClient.invalidateQueries({ queryKey: ['job', id] });
  },
});

// Remove charge
const removeChargeMutation = useMutation({
  mutationFn: async (chargeId: string) => {
    await api.delete(`/api/jobs/${id}/charges/${chargeId}`);
  },
  onSuccess: () => {
    queryClient.invalidateQueries({ queryKey: ['job', id] });
  },
});
```

### Invalidation Strategy

| Action | Invalidate |
|--------|-----------|
| Create job | `['jobs']`, `['estimate', estimateId]` |
| Assign/Unassign/Start/Complete/Cancel | `['job', id]`, `['jobs']`, `['job-timeline', id]` |
| Delete job | `['jobs']`, navigate away |
| Add note | `refetchNotes()` (same as EstimateDetailPage) |
| Add/update/remove charge | `['job', id]` (charges in detail response) |
| Update job fields | `['job', id]`, `['jobs']` |

---

## 4. Component Architecture

### 4.1 JobsPage.tsx

**Layout:** Identical to EstimatesPage — heading with count badge, KPI strip card, DataTable.

**State:**
```typescript
const [page, setPage] = useState(1);
const [pageSize, setPageSize] = useState(25);
const [search, setSearch] = useState('');
const [statuses, setStatuses] = useState<string[]>([]);
const [assignedTo, setAssignedTo] = useState('');
const [isUrgent, setIsUrgent] = useState(''); // '' | 'true' | 'false'
const [showUrgentDialog, setShowUrgentDialog] = useState(false);
```

**KPI Strip:** 5-cell grid matching backend stats:
- Unassigned (AlertCircle icon, warning color)
- Scheduled (CalendarDays icon, info color)
- In Progress (Play icon, primary color)
- Completed (CheckCircle2 icon, success color)
- Cancelled (Ban icon, gray)

**Columns (ColumnDef):**
1. `job_number` — font-medium text-primary + urgent badge (AlertCircle icon)
2. `customer` — first_name last_name, company_name subtitle
3. `status` — StatusBadge
4. `service_location` — address_line1, city (truncated)
5. `assigned_user` — name or "Unassigned" italic
6. `scheduled_start` — date or em-dash
7. `created_at` — date

**Filters:** DropdownMenu with sub-menus (same pattern as EstimatesPage):
- Status (multi-select checkboxes) — UNASSIGNED, SCHEDULED, IN_PROGRESS, COMPLETED, CANCELLED
- Assigned To (single-select) — fetched from `GET /api/users?role=TECHNICIAN`
- Type (single-select) — All / Standard / Urgent

**Header Actions:**
- Date range dropdown (All Time, Last 30, Last 90, Last Year)
- Export button
- "New Urgent Job" button (opens NewUrgentJobDialog)

**Row Click:** `navigate(\`/jobs/${job.id}\`)`

**Data Flow:** Single useQuery returns `{ jobs, pagination, stats }`. Stats shown in KPI strip. Technicians list fetched separately for Assigned To filter.

### 4.2 JobDetailPage.tsx

**Layout:** Same as EstimateDetailPage — Breadcrumb, Hero Card, Tabs Card.

**State:**
```typescript
const [scheduleOpen, setScheduleOpen] = useState(false);
const [completeOpen, setCompleteOpen] = useState(false);
const [cancelOpen, setCancelOpen] = useState(false);
const [noteContent, setNoteContent] = useState('');
```

**Breadcrumb:** Context-aware via `location.state?.breadcrumbs` (same pattern).

**Hero Card:**
- Job number + StatusBadge + urgent badge (if is_urgent)
- Customer name (link to `/customers/:id`) + "View Estimate" link (if standard job)
- Context strip: Client Details | Service Address | Job Info (3-col grid, same as EstimateDetailPage)
- KPI strip: Estimate Total | Charges Total | Duration | Scheduled | Completed

**Action Buttons (role + status gated):**

| Status | Actions Available |
|--------|------------------|
| UNASSIGNED | Assign (opens ScheduleJobDialog), Delete |
| SCHEDULED | Start, Reassign, Unassign, Cancel |
| IN_PROGRESS | Complete (opens CompleteJobDialog), Cancel |
| COMPLETED | (read-only) |
| CANCELLED | (read-only) |

**Role gates:**
- `canManage` = ADMIN or DISPATCHER
- `canWork` = ADMIN or DISPATCHER or (TECHNICIAN && assigned to this job)
- `canViewOnly` = SALES (read-only)

**Tabs:**
1. **Line Items** (if standard job with estimate) — read-only list of estimate line items, same rendering as EstimateDetailPage line items
2. **Charges** (urgent jobs only) — editable table, Add Charge button, inline edit/delete. For standard jobs, this tab is hidden.
3. **Details** — dl list: Job #, Status, Type, Created By, Created, Started, Completed, Cancelled, Scope Notes, Urgency Reason, Completion Notes, Cancellation Reason
4. **Notes** — Same pattern as EstimateDetailPage notes tab
5. **Timeline** — Chronological list of timeline events (created, assigned, started, completed, cancelled)

### 4.3 NewUrgentJobDialog.tsx

**Layout:** Same pattern as NewEstimateDialog — centered icon, title, search, results.

**Flow:**
1. Search customers (same query as NewEstimateDialog: `GET /api/customers?search=...&limit=6`)
2. Click customer → expand to show service locations (fetched from customer response or `GET /api/customers/:id`)
3. Click location → form expands with urgency_reason (required) + scope_notes (optional)
4. Submit → creates urgent job → navigates to `/jobs/:id`

**State:**
```typescript
const [search, setSearch] = useState('');
const [debouncedSearch, setDebouncedSearch] = useState('');
const [selectedCustomerId, setSelectedCustomerId] = useState<string | null>(null);
const [selectedLocationId, setSelectedLocationId] = useState<string | null>(null);
const [urgencyReason, setUrgencyReason] = useState('');
const [scopeNotes, setScopeNotes] = useState('');
```

### 4.4 ScheduleJobDialog.tsx

**Layout:** Same as AssignLeadDialog (Dialog, Select, Labels).

**Form fields:**
- Technician Select (fetches `GET /api/users?role=TECHNICIAN`, filters active)
- Scheduled Start (datetime-local input)
- Scheduled End (datetime-local input)

**Submit:** Calls `POST /api/jobs/:id/assign` with `{ assigned_to, scheduled_start?, scheduled_end? }`.

**Invalidation:** `['job', id]`, `['jobs']`

### 4.5 CompleteJobDialog.tsx

**Layout:** Same as CancelEstimateDialog (Dialog, Textarea, destructive button).

**Form fields:**
- Completion Notes (required, Textarea)

**Submit:** `POST /api/jobs/:id/complete` with `{ completion_notes }`

### 4.6 CancelJobDialog.tsx

**Layout:** Identical to CancelEstimateDialog.

**Form fields:**
- Cancellation Reason (required, Textarea)

**Submit:** `POST /api/jobs/:id/cancel` with `{ cancelled_reason }`

---

## 5. Implementation Sequence

### Phase 1: Foundation (no dependencies)

1. **Install dependencies** — `react-big-calendar`, `date-fns`, `@types/react-big-calendar`
2. **App.tsx route updates** — add lazy imports and routes
3. **nav-config.ts** — add Schedule nav item (for later)

### Phase 2: JobsPage (depends on Phase 1)

4. **JobsPage.tsx** — full rewrite replacing placeholder
   - KPI strip, DataTable, filters, search, export
   - Test: verify list loads, filters work, row click navigates

### Phase 3: Dialogs (depends on Phase 1)

5. **CancelJobDialog.tsx** — simplest dialog, copy CancelEstimateDialog pattern
6. **CompleteJobDialog.tsx** — same pattern, required completion_notes
7. **ScheduleJobDialog.tsx** — technician select + datetime inputs
8. **NewUrgentJobDialog.tsx** — most complex dialog (customer search + location + form)

### Phase 4: JobDetailPage (depends on Phase 2 + Phase 3)

9. **JobDetailPage.tsx** — hero card, KPI strip, action buttons
10. **Tabs: Line Items** — read-only estimate line items rendering
11. **Tabs: Charges** — editable table (urgent jobs only)
12. **Tabs: Details** — dl key-value pairs
13. **Tabs: Notes** — same as estimate notes
14. **Tabs: Timeline** — chronological event list

### Phase 5: Cross-Entity Updates (depends on Phase 4)

15. **EstimateDetailPage.tsx** — "Convert to Job" button
16. **LeadDetailPage.tsx** — show linked job info
17. **CustomerDetailPage.tsx** — Jobs tab already works (links to `/jobs/:id` which now resolves)

### Phase 6: Schedule Page Stub (depends on Phase 1)

18. **SchedulePage.tsx** — basic calendar view with react-big-calendar (can be done in parallel or deferred to 6.1)

---

## 6. App.tsx Route Updates

### New Lazy Imports

```typescript
const JobDetailPage = lazy(() => import('@/pages/JobDetailPage'));
const SchedulePage = lazy(() => import('@/pages/SchedulePage'));
```

### New Routes (inside the AppLayout ProtectedRoute)

```tsx
{/* After existing /jobs route */}
<Route path="/jobs" element={<JobsPage />} />
<Route path="/jobs/:id" element={<JobDetailPage />} />
<Route path="/schedule" element={<SchedulePage />} />
```

**Note:** No `/jobs/new` route needed — standard jobs are created via button on EstimateDetailPage (POST then navigate). Urgent jobs are created via dialog on JobsPage.

### Role Gating

The `/jobs` and `/jobs/:id` routes do NOT need a ProtectedRoute wrapper with allowedRoles because the backend enforces role-based access. All authenticated users can reach the route; the backend returns 403 for unauthorized access. This matches the existing pattern for estimates and leads.

The `/schedule` page should be wrapped in a ProtectedRoute:
```tsx
<Route element={<ProtectedRoute allowedRoles={['ADMIN', 'DISPATCHER']} />}>
  <Route path="/schedule" element={<SchedulePage />} />
</Route>
```

---

## 7. StatusBadge — Already Complete

The `status-badge.tsx` already has all job statuses mapped:

```typescript
UNASSIGNED: { label: 'Unassigned', className: 'bg-warning/10 text-warning border-warning/20' },
SCHEDULED:  { label: 'Scheduled',  className: 'bg-info/10 text-info border-info/20' },
IN_PROGRESS:{ label: 'In Progress',className: 'bg-primary/10 text-primary border-primary/20' },
COMPLETED:  { label: 'Completed',  className: 'bg-success/10 text-success border-success/20' },
CANCELLED:  { label: 'Cancelled',  className: 'bg-gray-100 text-gray-600 border-gray-200' },
```

No changes needed.

---

## 8. Calendar Integration (Step 6.1 — SchedulePage)

### Dependencies

```bash
npm install react-big-calendar date-fns --workspace=frontend
npm install -D @types/react-big-calendar --workspace=frontend
```

### Localizer Setup

```typescript
import { Calendar, dateFnsLocalizer, Views } from 'react-big-calendar';
import { format, parse, startOfWeek, getDay } from 'date-fns';
import enUS from 'date-fns/locale/en-US';
import 'react-big-calendar/lib/css/react-big-calendar.css';

const locales = { 'en-US': enUS };

const localizer = dateFnsLocalizer({
  format,
  parse,
  startOfWeek,
  getDay,
  locales,
});
```

### Event Mapping

```typescript
interface CalendarEvent {
  id: string;
  title: string;
  start: Date;
  end: Date;
  resource: {
    job_number: string;
    status: string;
    is_urgent: boolean;
    customer_name: string;
    technician_name: string;
    assigned_to: string | null;
  };
}

function jobsToEvents(jobs: JobListItem[]): CalendarEvent[] {
  return jobs
    .filter(j => j.scheduled_start && j.scheduled_end)
    .map(j => ({
      id: j.id,
      title: `${j.job_number} — ${j.customer.first_name} ${j.customer.last_name}`,
      start: new Date(j.scheduled_start!),
      end: new Date(j.scheduled_end!),
      resource: {
        job_number: j.job_number,
        status: j.status,
        is_urgent: j.is_urgent,
        customer_name: `${j.customer.first_name} ${j.customer.last_name}`,
        technician_name: j.assigned_user
          ? `${j.assigned_user.first_name} ${j.assigned_user.last_name}`
          : 'Unassigned',
        assigned_to: j.assigned_user?.id ?? null,
      },
    }));
}
```

### Calendar Config

```tsx
<Calendar
  localizer={localizer}
  events={events}
  defaultView={Views.WEEK}
  views={[Views.DAY, Views.WEEK, Views.MONTH]}
  step={30}
  timeslots={2}
  min={new Date(0, 0, 0, 6, 0, 0)}  // 6 AM
  max={new Date(0, 0, 0, 20, 0, 0)} // 8 PM
  onSelectEvent={(event) => navigate(`/jobs/${event.id}`)}
  eventPropGetter={(event) => ({
    style: {
      backgroundColor: getStatusColor(event.resource.status),
      borderRadius: '6px',
      border: 'none',
      color: '#fff',
      fontSize: '12px',
      padding: '2px 6px',
    },
  })}
/>
```

### Status Color Map for Calendar

```typescript
const STATUS_COLORS: Record<string, string> = {
  UNASSIGNED: '#F59E0B',  // warning/amber
  SCHEDULED: '#3B82F6',   // info/blue
  IN_PROGRESS: '#2563EB', // primary
  COMPLETED: '#10B981',   // success/emerald
  CANCELLED: '#9CA3AF',   // gray
};
```

### SchedulePage Structure

```
SchedulePage
├── Header: "Schedule" + technician filter dropdown + view toggle
├── Calendar component (react-big-calendar)
└── Optional: Unassigned jobs sidebar (Step 6.1 enhancement)
```

### API Call for Calendar Data

```typescript
// Fetch jobs for visible date range
const { data } = useQuery({
  queryKey: ['jobs-schedule', { scheduledAfter, scheduledBefore, assignedTo }],
  queryFn: async () => {
    const { data } = await api.get('/api/jobs', {
      params: {
        scheduled_after: scheduledAfter,
        scheduled_before: scheduledBefore,
        assigned_to: assignedTo || undefined,
        status: ['SCHEDULED', 'IN_PROGRESS'], // Only show active jobs
        limit: 200, // Calendar needs all events in range
      },
    });
    return data.jobs;
  },
});
```

### CSS Override

Add to `frontend/src/index.css` (after Tailwind imports):

```css
/* react-big-calendar overrides to match design system */
.rbc-calendar {
  font-family: 'Inter', sans-serif;
}
.rbc-header {
  font-weight: 600;
  font-size: 0.75rem;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  color: var(--text-secondary);
  padding: 8px;
}
.rbc-today {
  background-color: rgba(37, 99, 235, 0.05);
}
.rbc-toolbar button {
  border-radius: 6px;
  font-size: 0.875rem;
}
.rbc-toolbar button.rbc-active {
  background-color: #2563EB;
  color: white;
}
```

---

## 9. Shared Concerns

### Reused Components (no changes)

| Component | Used In |
|-----------|---------|
| `DataTable` | JobsPage — same props as EstimatesPage |
| `StatusBadge` | JobsPage columns, JobDetailPage hero, all dialogs |
| `FilterChip` | JobsPage active filters strip |
| `Breadcrumb` | JobDetailPage — context-aware pattern |
| `Card` | JobDetailPage hero, JobsPage KPI strip |
| `Tabs/TabsList/TabsTrigger/TabsContent` | JobDetailPage tabs |
| `Dialog/DialogContent/DialogHeader/...` | All 4 dialogs |
| `Button`, `Input`, `Label`, `Textarea`, `Select` | Throughout |
| `DropdownMenu` (all sub-components) | JobsPage filters, JobDetailPage actions menu |

### Reused Patterns (copy + adapt)

| Pattern | Source | Adaptation |
|---------|--------|------------|
| KPI strip | EstimatesPage | Different metrics: per-status counts (no dollar values) |
| Filter dropdown with sub-menus | EstimatesPage | Different filter categories |
| Hero card with context strip | EstimateDetailPage | Different fields, add urgent badge |
| Notes tab | EstimateDetailPage | Same structure, different entity |
| Dialog with textarea + mutation | CancelEstimateDialog | Copy exactly for Cancel/Complete |
| Assignment dialog with Select | AssignLeadDialog | Fetch TECHNICIANs instead of SALES, add datetime inputs |
| Customer search dialog | NewEstimateDialog | Adapt: show locations instead of leads |
| Export CSV | EstimatesPage | Same pattern, different columns |
| Context-aware breadcrumbs | EstimateDetailPage | Same pattern with `location.state?.breadcrumbs` |

### New Patterns

| Pattern | Description |
|---------|------------|
| Charges editable table | Inline add/edit/delete rows. Similar to EstimateFormPage line items but simpler (no price book, no drag). Uses useMutation for each row action. |
| Timeline tab | New — chronological list with event_type icons and timestamps. Purely read-only display. |
| Calendar view | New — react-big-calendar integration with event mapping and status-based coloring. |

---

## 10. Risk Areas

### High Complexity

1. **NewUrgentJobDialog** — Multi-step flow (search → select customer → select location → fill form → submit). Most complex dialog. Needs careful state management for the expand/collapse flow. Copy NewEstimateDialog pattern closely but replace lead selection with location selection.

2. **Calendar integration (SchedulePage)** — react-big-calendar has its own CSS and event model. CSS overrides need to match the design system. Date range management for fetching events is tricky (need to refetch when user navigates calendar views). Consider `onRangeChange` callback to update query params.

3. **Charges editable table** — Inline editing with optimistic updates. Each row needs edit/save/cancel state. Consider a simpler approach: modal form for add, inline delete with confirmation. This avoids complex inline edit state.

### Role-Based UI Complexity

4. **Action button visibility** — Many combinations of role + status determine which buttons show. Extract to a helper:
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
  };
}
```

### Cross-Entity State

5. **Convert to Job from EstimateDetailPage** — Must handle deposit gate. If estimate has a REQUESTED deposit, show disabled button with tooltip "Deposit must be paid first". If no deposit or deposit is PAID, allow conversion. After creation, navigate to the new job and invalidate estimate queries.

6. **CustomerDetailPage Jobs tab** — Already wired up and working (links to `/jobs/:id`). The only dependency is that `JobDetailPage` exists at that route. No code changes needed in CustomerDetailPage.

### Data Consistency

7. **Stale data after actions** — When a job is assigned/started/completed, the list page KPI stats change. The invalidation strategy must cover both `['job', id]` and `['jobs']` to keep stats fresh. This is handled in the mutation definitions above.

8. **Technician list caching** — The ScheduleJobDialog fetches technicians. This list rarely changes, so the default 5-minute staleTime is fine. Enable the query only when `open === true` (like AssignLeadDialog).

---

## Appendix: EstimateDetailPage Changes

Add a "Convert to Job" button in the hero card action buttons area:

```typescript
// Conditions
const isApproved = est.status === 'APPROVED';
const hasJob = Boolean(est.job_id); // need to check if backend returns this
const depositBlocked = est.deposit && est.deposit.status === 'REQUESTED';
const canConvert = (user?.role === 'ADMIN' || user?.role === 'DISPATCHER') && isApproved && !hasJob;

// In the action buttons area:
{canConvert && (
  <Button
    onClick={() => createJobMutation.mutate()}
    disabled={depositBlocked || createJobMutation.isPending}
    title={depositBlocked ? 'Deposit must be paid first' : undefined}
  >
    {createJobMutation.isPending
      ? <Loader2 className="mr-2 h-4 w-4 animate-spin" />
      : <Briefcase className="mr-2 h-4 w-4" />
    }
    Convert to Job
  </Button>
)}
{hasJob && (
  <Button variant="outline" onClick={() => navigate(`/jobs/${est.job_id}`)}>
    <Briefcase className="mr-2 h-4 w-4" />
    View Job
  </Button>
)}
```

**Backend note:** Verify that the estimate detail response includes `job` or `job_id` field so the frontend can check if a job already exists. Looking at `jobDetailSelect`, the estimate response already includes job relation via `estimate.job` — but we need to verify the inverse: that `GET /api/estimates/:id` returns the linked job. If not, a small backend tweak is needed to include `job: { select: { id: true, job_number: true, status: true } }` in `estimateDetailSelect`.

---

## Summary

| Metric | Count |
|--------|-------|
| New files | 7 |
| Modified files | 4-5 |
| New components | 4 dialogs + 3 pages |
| TanStack queries | 4 query keys |
| Mutations | 11 total |
| Estimated LOC | ~2,500-3,000 |
| Implementation phases | 6 sequential phases |
