# Step 6.1 — Scheduling & Calendar: Implementation Plan

> **Branch:** `feature/schedule-calendar`
> **Date:** 2026-03-02
> **Status:** APPROVED — Ready to implement

---

## Context

Step 6B left `SchedulePage.tsx` as a placeholder. Step 6.1 builds the full scheduling experience: a two-pane calendar page where ADMIN/DISPATCHER users can view all jobs and walkthroughs, schedule unassigned jobs by dragging them onto the calendar, and reschedule or reassign existing jobs via drag-and-drop.

---

## Confirmed Decisions

| Topic | Decision |
|-------|----------|
| Default calendar view | **Week** |
| Drag-and-drop | **In scope** — rescheduling + cross-tech reassignment |
| Conflict handling | **Warning + confirm/cancel** (not hard block) |
| Dialog | **Reuse `AssignJobDialog`** — extend with defaultStart/End + conflict warning |
| Drag restrictions | **None** — across days, weeks, techs all allowed |
| Grouped-by-tech view | **Toggle** (prominent); Day/Week/Month available in both modes |
| Grouped view shows | **All staff: Technicians + SALES** (jobs under techs, walkthroughs under SALES) |
| Calendar statuses | **SCHEDULED + IN_PROGRESS jobs + Walkthroughs** |
| Walkthrough duration | **Default 60 min**, stored as `walkthrough_duration_minutes` (new schema field) |
| Conflict warning detail | **Simple** — tech name + conflicting job number |

---

## Architecture Overview

### Data Sources (parallel queries)
1. `GET /api/jobs?scheduled_after=&scheduled_before=&status=SCHEDULED,IN_PROGRESS&limit=200` → job events
2. `GET /api/leads?walkthrough_after=&walkthrough_before=&limit=200` → walkthrough events (new filter)
3. `GET /api/jobs?status=UNASSIGNED&limit=100` → unassigned sidebar
4. `GET /api/users?role=TECHNICIAN` + `GET /api/users?role=SALES` → resource columns (parallel)

### No New Backend Endpoints
Existing `GET /api/jobs` and `POST /api/jobs/:id/assign` are extended, not replaced.

---

## Files to Modify

### Backend
| File | Change |
|------|--------|
| `backend/prisma/schema.prisma` | Add `walkthrough_duration_minutes Int?` to Lead model |
| `backend/src/controllers/job.controller.ts` | Add conflict detection + `force` bypass to `assign()` |
| `backend/src/controllers/lead.controller.ts` | Add `walkthrough_after`/`walkthrough_before` list filters; add `walkthrough_duration_minutes` to schema + handler |
| `backend/src/__tests__/jobs.test.ts` | New conflict detection tests |

### Frontend
| File | Change |
|------|--------|
| `frontend/package.json` | Add `react-big-calendar`, `date-fns`, `date-fns-tz`, `@types/react-big-calendar` |
| `frontend/src/pages/SchedulePage.tsx` | Full rewrite |
| `frontend/src/components/jobs/AssignJobDialog.tsx` | Add `defaultStart?`/`defaultEnd?` props + conflict warning |
| `frontend/src/pages/LeadDetailPage.tsx` | Add Duration select to walkthrough form |

---

## Phase 1 — Backend (~45 min)

### 1.1 Schema: walkthrough duration
**File:** `backend/prisma/schema.prisma`

Add to Lead model:
```prisma
walkthrough_duration_minutes Int?   // null = treat as 60 on frontend
```

Run: `npx prisma migrate dev --name add_walkthrough_duration` from `backend/`

### 1.2 Conflict detection in `assign()`
**File:** `backend/src/controllers/job.controller.ts`

Add `force` to schema:
```typescript
export const assignJobSchema = z.object({
  assigned_to: z.string().uuid(),
  scheduled_start: z.string().datetime({ offset: true }).optional(),
  scheduled_end:   z.string().datetime({ offset: true }).optional(),
  force:           z.boolean().optional(),
});
```

After technician validation, before Prisma update:
```typescript
if (!force && scheduled_start && scheduled_end) {
  const conflict = await prisma.job.findFirst({
    where: {
      id:             { not: id },
      assigned_to,
      status:         { in: ['SCHEDULED', 'IN_PROGRESS'] },
      scheduled_start: { lt: new Date(scheduled_end) },
      scheduled_end:   { gt: new Date(scheduled_start) },
    },
    select: { job_number: true },
  });
  if (conflict) {
    res.status(409).json({
      error: `This technician already has job ${conflict.job_number} scheduled during that time.`
    });
    return;
  }
}
```

### 1.3 Lead list: walkthrough date filters + duration field
**File:** `backend/src/controllers/lead.controller.ts`

In `list()`, add after existing filters:
```typescript
const walkthroughAfter  = req.query.walkthrough_after  as string | undefined;
const walkthroughBefore = req.query.walkthrough_before as string | undefined;
if (walkthroughAfter || walkthroughBefore) {
  where.walkthrough_scheduled_at = {
    not: null,
    ...(walkthroughAfter  ? { gte: new Date(walkthroughAfter)  } : {}),
    ...(walkthroughBefore ? { lte: new Date(walkthroughBefore) } : {}),
  };
}
```

Add to `walkthroughSchema`:
```typescript
walkthrough_duration_minutes: z.number().int().min(15).max(480).optional().nullable(),
```

Include in `updateWalkthrough` data block and in `leadDetailSelect` + lead list select.

### 1.4 Backend tests
**File:** `backend/src/__tests__/jobs.test.ts`

Add tests for:
- Conflict returns 409 with job number in error message
- `force: true` bypasses conflict check and saves successfully
- No conflict check when times not provided

---

## Phase 2 — AssignJobDialog Enhancement (~30 min)
**File:** `frontend/src/components/jobs/AssignJobDialog.tsx`

### New props
```typescript
interface AssignJobDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  jobId: string;
  currentAssignedTo?: string | null;
  defaultStart?: string;  // ISO string — pre-fills from calendar drop
  defaultEnd?: string;    // ISO string — pre-fills from calendar drop
}
```

Initialize state:
```typescript
useEffect(() => {
  if (defaultStart) setScheduledStart(defaultStart.slice(0, 16)); // datetime-local format
  if (defaultEnd)   setScheduledEnd(defaultEnd.slice(0, 16));
}, [defaultStart, defaultEnd]);
```

### Conflict warning flow
```typescript
const [conflictMessage, setConflictMessage] = useState<string | null>(null);

// In mutation onError:
if ((err as AxiosError).response?.status === 409) {
  setConflictMessage((err as AxiosError<{error:string}>).response!.data.error);
} else {
  // existing error handling
}

// Force mutation (same body + force: true)
const forceMutation = useMutation({ /* same mutationFn + force: true */ });
```

UI below form (when `conflictMessage`):
```tsx
{conflictMessage && (
  <div className="rounded-md border border-yellow-200 bg-yellow-50 p-3 text-sm text-yellow-800">
    ⚠️ {conflictMessage}
    <div className="flex gap-2 mt-2">
      <Button size="sm" variant="outline" onClick={() => setConflictMessage(null)}>Cancel</Button>
      <Button size="sm" onClick={() => forceMutation.mutate()}>Schedule Anyway</Button>
    </div>
  </div>
)}
```

---

## Phase 3 — SchedulePage Full Rewrite (~3.5 hours)
**File:** `frontend/src/pages/SchedulePage.tsx`

### 3.1 Install dependencies
```bash
cd frontend && npm install react-big-calendar date-fns date-fns-tz
npm install --save-dev @types/react-big-calendar
```

### 3.2 Page layout
```
<div class="h-full flex gap-4">
  <!-- Unassigned sidebar: w-72, hidden on mobile -->
  <UnassignedSidebar />
  <!-- Calendar area -->
  <div class="flex-1 flex flex-col gap-3 min-w-0">
    <ScheduleHeader />   <!-- toggle + filter + view switcher -->
    <Card>
      <DnDCalendar style={{ height: 'calc(100vh - 220px)' }} />
    </Card>
  </div>
</div>
```

### 3.3 Header controls (left → right)
1. **Standard / By Technician toggle** — two `Button` components (`default` variant = active, `outline` = inactive). Prominent positioning, top-left.
2. **Staff filter** — `Select` ("All Staff" + each user). In grouped view, filters which resource columns show.
3. **Day | Week | Month** switcher — three outline buttons, right side.

### 3.4 Calendar setup
```typescript
import { Calendar, dateFnsLocalizer } from 'react-big-calendar';
import withDnD from 'react-big-calendar/lib/addons/dragAndDrop';
import { format, parse, startOfWeek, getDay } from 'date-fns';
import { enUS } from 'date-fns/locale';
import 'react-big-calendar/lib/css/react-big-calendar.css';
import 'react-big-calendar/lib/addons/dragAndDrop/styles.css';

const DnDCalendar = withDnD(Calendar);
const localizer = dateFnsLocalizer({ format, parse, startOfWeek, getDay, locales: { 'en-US': enUS } });
```

### 3.5 Data queries
```typescript
const [dateRange, setDateRange] = useState({
  start: startOfWeek(new Date()),
  end:   endOfWeek(new Date()),
});

// Jobs
useQuery({ queryKey: ['schedule-jobs', dateRange], queryFn: () =>
  api.get('/api/jobs', { params: { scheduled_after: dateRange.start.toISOString(),
    scheduled_before: dateRange.end.toISOString(), status: ['SCHEDULED','IN_PROGRESS'], limit: 200 }})
  .then(r => r.data.jobs) });

// Walkthroughs
useQuery({ queryKey: ['schedule-walkthroughs', dateRange], queryFn: () =>
  api.get('/api/leads', { params: { walkthrough_after: dateRange.start.toISOString(),
    walkthrough_before: dateRange.end.toISOString(), limit: 200 }})
  .then(r => r.data.leads) });

// Unassigned sidebar
useQuery({ queryKey: ['schedule-unassigned'], queryFn: () =>
  api.get('/api/jobs', { params: { status: 'UNASSIGNED', limit: 100 }}).then(r => r.data.jobs) });

// Staff (parallel, staleTime: Infinity)
useQuery({ queryKey: ['users', { role: 'TECHNICIAN' }], ... });
useQuery({ queryKey: ['users', { role: 'SALES' }], ... });
```

Update `dateRange` via `onRangeChange` callback from RBC.

### 3.6 Event transformation
**Jobs:**
```typescript
{ id: job.id, title: job.job_number, start: new Date(job.scheduled_start),
  end: new Date(job.scheduled_end), resourceId: job.assigned_user?.id,
  type: 'job', status: job.status, isUrgent: job.is_urgent,
  customerName: `${job.customer.first_name} ${job.customer.last_name}`, raw: job }
```

**Walkthroughs:**
```typescript
const start = new Date(lead.walkthrough_scheduled_at);
const durationMs = (lead.walkthrough_duration_minutes ?? 60) * 60_000;
{ id: `wt-${lead.id}`, title: `Walkthrough — ${customerName}`, start,
  end: new Date(start.getTime() + durationMs),
  resourceId: lead.assigned_user?.id, type: 'walkthrough', raw: lead }
```

### 3.7 Event colors (`eventStyleGetter`)
```typescript
const COLORS = {
  SCHEDULED:   { background: '#EFF6FF', borderLeft: '3px solid #3B82F6', color: '#1D4ED8' },
  IN_PROGRESS: { background: '#EEF2FF', borderLeft: '3px solid #2563EB', color: '#1E40AF' },
  walkthrough: { background: '#FEF3C7', borderLeft: '3px solid #F59E0B', color: '#92400E' },
};
```

### 3.8 Resources (grouped-by-tech mode)
```typescript
const allStaff = [...(technicians ?? []), ...(salesUsers ?? [])];
const resources = allStaff
  .filter(u => !staffFilter || u.id === staffFilter)
  .map(u => ({ id: u.id, title: `${u.first_name} ${u.last_name}` }));
```

### 3.9 Calendar render
```tsx
<DnDCalendar
  localizer={localizer}
  events={allEvents}
  defaultView="week"
  view={calendarView}       onView={setCalendarView}
  date={currentDate}        onNavigate={setCurrentDate}
  onRangeChange={handleRangeChange}
  resources={isGroupedView ? resources : undefined}
  resourceIdAccessor="resourceId"
  resourceTitleAccessor="title"
  onSelectEvent={handleSelectEvent}
  onEventDrop={handleEventDrop}
  onDropFromOutside={handleDropFromOutside}
  eventPropGetter={eventStyleGetter}
  draggableAccessor={() => true}
  style={{ height: 'calc(100vh - 220px)' }}
/>
```

### 3.10 Drag-and-drop handlers

**`handleEventDrop({ event, start, end, resourceId })`**
- If `event.type === 'job'`:
  - `assigned_to` = grouped view ? `resourceId` : `event.raw.assigned_user.id`
  - Call `POST /api/jobs/:id/assign { assigned_to, scheduled_start: start.toISOString(), scheduled_end: end.toISOString() }`
  - On 409: set `pendingDrop` state + `conflictMessage` → show confirm dialog
  - On confirm: re-fire with `force: true`
  - On success: invalidate `['schedule-jobs', dateRange]`, `['jobs']`, `['job', id]`, `['job-timeline', id]`
- If `event.type === 'walkthrough'`:
  - Call `POST /api/leads/:id/walkthrough { walkthrough_scheduled_at: start.toISOString() }`
  - On success: invalidate `['schedule-walkthroughs', dateRange]`

**`handleDropFromOutside({ start, end, resource })`** (sidebar → calendar)
- Get `draggingJobId` from state (set on sidebar card `onDragStart`)
- Open `AssignJobDialog` with `jobId=draggingJobId`, `defaultStart=start.toISOString()`, `defaultEnd=end.toISOString()`
- If grouped view and `resource` provided: pre-select that technician in the dialog
- On dialog success: invalidate `['schedule-unassigned']`, `['schedule-jobs', dateRange]`

**`handleSelectEvent(event)`**
- `type === 'job'` → `navigate(\`/jobs/${event.id}\`)`
- `type === 'walkthrough'` → no-op for now

### 3.11 Conflict confirm (inline, no separate Dialog component)
```tsx
{conflictMessage && (
  <div className="fixed bottom-6 right-6 z-50 max-w-sm rounded-xl border border-yellow-200 bg-yellow-50 p-4 shadow-lg">
    <p className="text-sm font-medium text-yellow-900">Scheduling Conflict</p>
    <p className="mt-1 text-sm text-yellow-800">{conflictMessage}</p>
    <div className="mt-3 flex gap-2">
      <Button size="sm" variant="outline" onClick={() => setConflictMessage(null)}>Cancel</Button>
      <Button size="sm" onClick={handleForceSchedule}>Schedule Anyway</Button>
    </div>
  </div>
)}
```

### 3.12 Unassigned sidebar
```tsx
<div className="w-72 shrink-0 hidden lg:flex flex-col gap-3">
  <div className="flex items-center justify-between">
    <h2 className="text-sm font-semibold">Unassigned</h2>
    <Badge variant="secondary">{unassignedJobs.length}</Badge>
  </div>
  <div className="overflow-y-auto flex-1 space-y-2">
    {unassignedJobs.length === 0 ? (
      <div className="text-center py-8 text-sm text-text-secondary">
        <CheckCircle2 className="h-8 w-8 mx-auto mb-2 text-green-400" />
        All jobs are assigned
      </div>
    ) : unassignedJobs.map(job => (
      <Card key={job.id} draggable
        onDragStart={() => setDraggingJobId(job.id)}
        onClick={() => openAssignDialog(job.id)}
        className="p-3 cursor-pointer hover:border-primary/40 transition-colors">
        <div className="flex items-center gap-1.5">
          <span className="font-medium text-primary text-sm">{job.job_number}</span>
          {job.is_urgent && <UrgentBadge />}
        </div>
        <p className="text-sm">{job.customer.first_name} {job.customer.last_name}</p>
        {job.service_location && (
          <p className="text-xs text-text-secondary">{job.service_location.city}, {job.service_location.state}</p>
        )}
      </Card>
    ))}
  </div>
</div>
```

---

## Phase 4 — LeadDetailPage: Walkthrough Duration (~20 min)
**File:** `frontend/src/pages/LeadDetailPage.tsx`

Add `wtDuration` state (init from `lead.walkthrough_duration_minutes ?? 60`).

Add Duration select after Scheduled input in the edit form:
```tsx
<div>
  <Label className="text-xs text-gray-500">Duration</Label>
  <Select value={String(wtDuration)} onValueChange={v => setWtDuration(Number(v))}>
    <SelectTrigger className="h-8 text-sm"><SelectValue /></SelectTrigger>
    <SelectContent>
      <SelectItem value="30">30 minutes</SelectItem>
      <SelectItem value="60">1 hour</SelectItem>
      <SelectItem value="90">1.5 hours</SelectItem>
      <SelectItem value="120">2 hours</SelectItem>
    </SelectContent>
  </Select>
</div>
```

Include `walkthrough_duration_minutes: wtDuration` in mutation body.

---

## Implementation Order

```
Phase 1: Backend (~45 min)
  1.1  schema.prisma — walkthrough_duration_minutes
  1.2  Prisma migration
  1.3  job.controller.ts — conflict detection + force flag
  1.4  lead.controller.ts — walkthrough_after/before + duration field
  1.5  jobs.test.ts — conflict tests

Phase 2: AssignJobDialog (~30 min)
  2.1  defaultStart/defaultEnd props
  2.2  409 conflict warning + "Schedule Anyway"

Phase 3: SchedulePage (~3.5 hours)
  3.1  Install react-big-calendar + date-fns + date-fns-tz
  3.2  Calendar localizer + DnD wrapper
  3.3  Page layout (sidebar + header + calendar)
  3.4  Data queries + event transformation
  3.5  Standard view (week default)
  3.6  Grouped-by-tech toggle + resource mode
  3.7  Drag-and-drop handlers
  3.8  Conflict confirm toast
  3.9  Event styles + colors
  3.10 Unassigned sidebar

Phase 4: LeadDetailPage (~20 min)
  4.1  Duration select in walkthrough form

Total: ~5 hours
```

---

## API Reference

| Action | Endpoint | Notes |
|--------|----------|-------|
| Load calendar jobs | `GET /api/jobs?status=SCHEDULED,IN_PROGRESS&scheduled_after=&scheduled_before=&limit=200` | Existing |
| Load walkthroughs | `GET /api/leads?walkthrough_after=&walkthrough_before=&limit=200` | **New filter** |
| Unassigned sidebar | `GET /api/jobs?status=UNASSIGNED&limit=100` | Existing |
| Technicians | `GET /api/users?role=TECHNICIAN` | Existing |
| SALES users | `GET /api/users?role=SALES` | Existing |
| Assign/reschedule job | `POST /api/jobs/:id/assign { assigned_to, scheduled_start, scheduled_end, force? }` | **Add force** |
| Reschedule walkthrough | `POST /api/leads/:id/walkthrough { walkthrough_scheduled_at }` | Existing |

---

## Verification Checklist

1. `npx tsc --noEmit` from `frontend/` — zero errors
2. `npm test` from `backend/` — all tests pass including new conflict tests
3. `/schedule` renders Week view with current week
4. Toggle "By Technician" → resource columns appear (techs + SALES)
5. Drag a SCHEDULED job to a new time → event moves, backend updates
6. Drag a SCHEDULED job to another tech's column → reassigned, same time
7. Create scheduling conflict → conflict toast appears → "Schedule Anyway" saves
8. Click unassigned job card → AssignJobDialog opens
9. Drag unassigned job to grouped calendar → auto-assigns to target tech's row
10. Walkthroughs appear in amber under SALES user's column
11. Walkthrough form shows Duration select, value saved and reflected on calendar
