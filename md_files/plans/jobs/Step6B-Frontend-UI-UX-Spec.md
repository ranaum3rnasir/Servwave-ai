# Step 6B — Job Management Frontend: UI/UX Specification

## Table of Contents
1. [Color Coding & Status System](#1-color-coding--status-system)
2. [JobsPage (List)](#2-jobspage-list)
3. [JobDetailPage (Detail)](#3-jobdetailpage-detail)
4. [SchedulePage (Calendar)](#4-schedulepage-calendar)
5. [Dialogs](#5-dialogs)
6. [Cross-Entity Updates](#6-cross-entity-updates)
7. [Status-Based Action Matrix](#7-status-based-action-matrix)
8. [Responsive Behavior](#8-responsive-behavior)
9. [Accessibility](#9-accessibility)

---

## 1. Color Coding & Status System

### Job Status Badge Colors (already in `status-badge.tsx`)

| Status | Badge Classes | Calendar Event Color | Hex |
|--------|-------------|---------------------|-----|
| UNASSIGNED | `bg-warning/10 text-warning border-warning/20` | `#F59E0B` (amber-500) | Orange/Amber |
| SCHEDULED | `bg-info/10 text-info border-info/20` | `#3B82F6` (blue-500) | Blue |
| IN_PROGRESS | `bg-primary/10 text-primary border-primary/20` | `#2563EB` (primary) | Royal Blue |
| COMPLETED | `bg-success/10 text-success border-success/20` | `#10B981` (emerald-500) | Green |
| CANCELLED | `bg-gray-100 text-gray-600 border-gray-200` | `#9CA3AF` (gray-400) | Gray |

### Urgent Badge
- Displayed inline with the job number or as a standalone chip
- Classes: `bg-danger/10 text-danger border-danger/20 text-xs font-medium`
- Icon: `AlertTriangle` (size 14) before the word "Urgent"
- Appears in: list table, hero card, calendar events

### Job Type Indicator (Standard vs Urgent)
- **Standard job**: No extra badge (default)
- **Urgent job**: `<Badge variant="outline" className="bg-danger/10 text-danger border-danger/20"><AlertTriangle className="h-3.5 w-3.5 mr-1" /> Urgent</Badge>`

---

## 2. JobsPage (List)

### Component Hierarchy

```
JobsPage
  div.space-y-6
    // Page heading
    div.flex.items-center.gap-3
      h1 "Jobs"
      span.rounded-full (total count pill)

    // KPI Summary Strip
    Card.p-0.overflow-hidden
      div.grid.grid-cols-3.divide-x.lg:grid-cols-5
        KpiCell (icon=ClipboardList, label="Total", value=count)
        KpiCell (icon=AlertCircle, label="Unassigned", value=count)
        KpiCell (icon=Calendar, label="Scheduled", value=count)
        KpiCell (icon=Play, label="In Progress", value=count)
        KpiCell (icon=CheckCircle2, label="Completed", value=count, subtext="this month")

    // DataTable (reuses existing DataTable component)
    DataTable
      filters={FilterDropdown}
      activeFilters={FilterChips}
      headerActions={DateRange + Export + NewUrgentJob button}
      columns=[...]
      onRowClick -> navigate(/jobs/:id)

    // Dialog
    NewUrgentJobDialog (conditionally rendered)
```

### Layout Blueprint

```
+----------------------------------------------------------------------+
| Jobs                                                     [234]        |
+----------------------------------------------------------------------+
| +------------------------------------------------------------------+ |
| | [icon] Total   | [icon] Unassigned | [icon] Scheduled            | |
| |  47             |  8                |  12                          | |
| |                 |                   |                              | |
| |  [icon] In Progress | [icon] Completed (this month)              | |
| |  15                 |  12                                         | |
| +------------------------------------------------------------------+ |
|                                                                      |
| +------------------------------------------------------------------+ |
| | [Search.............]  [Filter v]  [All Time v] [Export] [+Urgent]| |
| |                                                                    | |
| | Filters: [Status: Unassigned, Scheduled x] [Assigned To: Mike x]  | |
| |                                                                    | |
| | Job #    | Customer      | Location         | Status   | Assigned | |
| |----------|---------------|------------------|----------|----------| |
| | JOB-2025 | John Smith    | 123 Main St,     | Unssgnd  | --       | |
| |  -0001   | ACME Corp     | Denver, CO        |          |          | |
| |          |               |                   |          |          | |
| | JOB-2025 | Jane Doe      | 456 Oak Ave,     | Sched    | Mike T.  | |
| |  -0002 ! | [urgent]      | Aurora, CO        |          |          | |
| +------------------------------------------------------------------+ |
```

### DataTable Columns

| Column | Header | Width | Cell Content |
|--------|--------|-------|-------------|
| `job_number` | "Job #" | auto | `<span className="font-medium text-primary">{job_number}</span>` + optional urgent badge inline |
| `customer` | "Customer" | auto | Name (font-medium) + company_name (text-xs text-text-secondary) |
| `service_location` | "Location" | auto | `{address_line1}, {city}, {state}` (text-sm) |
| `status` | "Status" | 120px | `<StatusBadge status={status} />` |
| `assigned_user` | "Assigned To" | auto | Tech name or `<span className="text-text-secondary italic">Unassigned</span>` |
| `scheduled_start` | "Scheduled" | auto | Formatted date or `--` |
| `is_urgent` | "Type" | 80px | Urgent badge or `Standard` text (text-xs text-text-secondary) |
| `created_at` | "Created" | auto | `toLocaleDateString()` |

### KPI Strip Cells

Each cell follows the existing pattern from EstimatesPage:

```tsx
<div className="flex items-center gap-4 p-5">
  <Icon className="h-5 w-5 shrink-0 text-gray-400" />
  <div className="min-w-0">
    <p className="text-xs font-medium uppercase tracking-wide text-text-secondary">{label}</p>
    <p className="text-2xl font-bold tabular-nums text-text-primary">{count}</p>
    {subtext && <p className="text-xs tabular-nums text-text-secondary">{subtext}</p>}
  </div>
</div>
```

Icons for each KPI cell:
- **Total**: `ClipboardList`
- **Unassigned**: `AlertCircle`
- **Scheduled**: `Calendar`
- **In Progress**: `Play`
- **Completed**: `CheckCircle2`

### Filter Dropdown

Same pattern as EstimatesPage. DropdownMenu with sub-menus:

1. **Status** (multi-select): UNASSIGNED, SCHEDULED, IN_PROGRESS, COMPLETED, CANCELLED
2. **Assigned To** (single-select): Fetched from `GET /api/users?role=TECHNICIAN` (or a dedicated technicians endpoint). Shows "All" + list of active technicians.
3. **Type** (single-select): All / Urgent / Standard

### Header Actions

```tsx
<div className="flex items-center gap-2">
  <DropdownMenu> {/* Date Range picker — same as EstimatesPage */}
    <Button variant="outline" size="sm">
      <CalendarDays className="mr-2 h-4 w-4" />
      {dateRange ? DATE_LABELS[dateRange] : 'All Time'}
    </Button>
  </DropdownMenu>
  <Button variant="outline" size="sm" onClick={handleExport}>
    <Download className="mr-2 h-4 w-4" /> Export
  </Button>
  {/* Only for ADMIN, DISPATCHER, TECHNICIAN */}
  <Button onClick={() => setShowNewUrgentDialog(true)}>
    <Plus className="mr-2 h-4 w-4" /> New Urgent Job
  </Button>
</div>
```

Note: The "New Urgent Job" button uses the primary filled style (blue). There is no general "New Job" button on the list page because standard jobs are created from EstimateDetailPage.

### Interactions

| Element | Action | Behavior |
|---------|--------|----------|
| Table row | Click | `navigate(\`/jobs/${job.id}\`)` |
| Table row | Hover | `hover:bg-accent/50` (built into DataTable) |
| "New Urgent Job" | Click | Opens `NewUrgentJobDialog` |
| Export | Click | Downloads CSV with all visible columns |
| Filter chip X | Click | Removes that filter, resets to page 1 |
| "Clear all" | Click | Removes all filters and search |
| Search input | Type | Debounced 300ms, searches job_number, customer name, company |

### Empty States

- **No jobs at all**: Centered illustration area. Text: "No jobs yet". Subtext: "Jobs are created from approved estimates or as urgent jobs." Button: "View Estimates" (secondary link).
- **No results for filters**: Text: "No jobs match your filters." Link: "Clear all filters".

### Loading State

- KPI strip: Skeleton pulses (`h-6 w-12 animate-pulse rounded bg-background-light`)
- Table: Built-in DataTable loading state (shimmer rows)

---

## 3. JobDetailPage (Detail)

### Component Hierarchy

```
JobDetailPage
  div.space-y-4
    // Breadcrumb
    Breadcrumb items={contextAwareBreadcrumbs}

    // Hero Card
    Card.p-4
      div.flex.items-start.justify-between
        // Left: Job info
        div
          div.flex.items-center.gap-3
            h1 (job_number)
            StatusBadge
            {is_urgent && UrgentBadge}
          p.text-sm.text-text-secondary (customer link, estimate link)

        // Right: Action buttons
        div.flex.items-center.gap-2
          {PrimaryActionButton}   // based on status
          DropdownMenu (overflow actions)

      // Context strip (same 3-column grid as EstimateDetailPage)
      div.grid.grid-cols-1.md:grid-cols-3.gap-4.mt-4.border-t.pt-4
        // Col 1: Client Details
        // Col 2: Service Address
        // Col 3: Job Info (created date, assigned tech, schedule)

      // KPI strip
      div.grid.grid-cols-2.lg:grid-cols-4.divide-x.divide-border.mt-4.border-t.pt-4
        KpiCell (icon=Clock, label="Est. Duration", value="2h 30m" or "--")
        KpiCell (icon=Timer, label="Time Since Created", value="3d 5h")
        KpiCell (icon=DollarSign, label="Estimate Total", value="$4,500.00" or "--")
        {is_urgent && KpiCell (icon=Receipt, label="Charges Total", value="$1,200.00")}

    // Tabs Card
    Card.p-0
      Tabs defaultValue="details"
        TabsList (same styling as EstimateDetailPage)
          TabsTrigger "Details"
          TabsTrigger "Charges" + count (urgent only, or always shown)
          TabsTrigger "Notes" + count
          TabsTrigger "Timeline" + count

        TabsContent "details" -> JobDetailsTab
        TabsContent "charges" -> JobChargesTab
        TabsContent "notes" -> JobNotesTab
        TabsContent "timeline" -> JobTimelineTab

    // Dialogs (conditionally rendered)
    ScheduleJobDialog
    CompleteJobDialog
    CancelJobDialog
```

### Layout Blueprint — Hero Card

```
+------------------------------------------------------------------------+
| JOB-2025-0042  [Scheduled]  [! Urgent]              [Start Job] [...]  |
| John Smith — ACME Corp  ·  View Estimate  ·  View Customer             |
|------------------------------------------------------------------------|
| CLIENT DETAILS          | SERVICE ADDRESS        | JOB INFO             |
| John Smith              | 123 Main St            | JOB-2025-0042        |
| ACME Corp               | Denver, CO 80202       | Scheduled             |
| (303) 555-1234          |                        | Assigned: Mike Torres |
| john@acme.com           |                        | Feb 15, 2025 9:00 AM |
|------------------------------------------------------------------------|
| [Clock] Est. Duration | [Timer] Age   | [Dollar] Est. Total | [Chg]   |
|  2h 30m               |  3d 5h        |  $4,500.00          | $0.00   |
+------------------------------------------------------------------------+
```

### Context Strip (3-column)

Identical layout pattern to `EstimateDetailPage` hero card:

**Column 1 — Client Details:**
- `h3.text-xs.font-medium.uppercase.tracking-wide.text-text-secondary` "Client Details"
- Customer name (font-medium), company name (text-text-secondary)
- Phone with `Phone` icon (h-3.5 w-3.5), `formatPhone()`, clickable `tel:` link
- Email with `Mail` icon, clickable `mailto:` link

**Column 2 — Service Address:**
- `h3` "Service Address"
- `MapPin` icon (h-3.5 w-3.5 mt-0.5 shrink-0)
- Full address: line1, line2 (optional), city/state/zip

**Column 3 — Job Info:**
- `h3` "Job Info"
- Job number + StatusBadge inline
- `Assigned: {tech name}` or "Unassigned" (italic, text-text-secondary)
- Schedule: `{date} {time}` or "Not yet scheduled" (italic)
- Created date, by whom (if relevant)
- Urgent reason (if urgent) — shown as `text-danger text-sm`

### KPI Strip Icons

| Cell | Icon | Label | Value Logic |
|------|------|-------|-------------|
| Est. Duration | `Clock` | "Est. Duration" | `{hours}h {minutes}m` from `estimated_duration` (minutes). Show "--" if null. |
| Age | `Timer` | "Time Since Created" | Relative time from `created_at` to now. Format as "Xd Xh" or "X hours" if < 24h. |
| Estimate Total | `DollarSign` | "Estimate Total" | `formatCurrency(estimate.total_amount)`. Show "--" if no linked estimate (urgent job). |
| Charges Total | `Receipt` | "Charges Total" | Sum of `job.charges[].line_total`. Only shown for urgent jobs or when charges exist. |

KPI grid: `grid-cols-2 lg:grid-cols-3` for standard jobs (3 cells), `lg:grid-cols-4` for urgent jobs (4 cells).

### Tabs Design

Tabs use the same style as EstimateDetailPage:

```tsx
<TabsList className="w-full justify-start rounded-none border-b bg-transparent px-4 pt-2">
  <TabsTrigger value="details" className="data-[state=active]:border-primary data-[state=active]:shadow-none border-b-2 border-transparent rounded-none">
    Details
  </TabsTrigger>
  <TabsTrigger value="charges" className="...">
    Charges
    <span className="ml-1.5 text-xs text-text-secondary">({chargesCount})</span>
  </TabsTrigger>
  <TabsTrigger value="notes" className="...">
    Notes
    <span className="ml-1.5 text-xs text-text-secondary">({notesCount})</span>
  </TabsTrigger>
  <TabsTrigger value="timeline" className="...">
    Timeline
    <span className="ml-1.5 text-xs text-text-secondary">({timelineCount})</span>
  </TabsTrigger>
</TabsList>
```

### Tab: Details

Two-column layout (`grid grid-cols-1 lg:grid-cols-2 gap-6`):

**Left column — Job Info:**
- `dl` with `flex justify-between` rows (same as EstimateDetailPage Details tab):
  - Number, Status, Created, Created By
  - Assigned To
  - Scheduled Start / End
  - Started At (if IN_PROGRESS or COMPLETED)
  - Completed At (if COMPLETED)
  - Cancelled At + Reason (if CANCELLED)
  - Completion Notes (if COMPLETED)
- If linked to estimate: "Linked Estimate" row with `{estimate_number}` as a clickable link (`text-primary hover:underline`)

**Right column — Scope Notes:**
- `h3` "Scope Notes"
- `p.text-sm.whitespace-pre-wrap` with scope_notes content
- If empty: italic "No scope notes"
- If urgent: additional section "Urgency Reason" with `p.text-sm.text-danger`

### Tab: Charges (Data-Entry Table)

This tab appears for ALL jobs but is editable only when:
- Job is NOT COMPLETED or CANCELLED
- User has write permissions (ADMIN, DISPATCHER, or assigned TECHNICIAN)

For **standard jobs**, charges show estimate line items as read-only. For **urgent jobs**, charges are editable.

**Read-only view (standard job with estimate):**
- Reuse the same line item display from EstimateDetailPage (image, description, qty, price, total)
- Label at top: "Line Items from Estimate" with link to the estimate

**Editable view (urgent job, or additional charges on any job):**

```
+----------------------------------------------------------------------+
|  # | Description                    | Qty    | Unit Price  | Total   |
|----|--------------------------------|--------|-------------|---------|
|  1 | Emergency drain clearing       |   1.00 |    $250.00  | $250.00 |
|  2 | Parts - PVC coupling 2"        |   3.00 |     $12.50  |  $37.50 |
|                                                    [+ Add Charge]    |
|----------------------------------------------------------------------|
|                                               Subtotal   |  $287.50 |
+----------------------------------------------------------------------+
```

Table structure:
```tsx
<table className="w-full">
  <thead>
    <tr className="border-b text-xs font-medium uppercase tracking-wide text-text-secondary">
      <th className="py-2 pl-4 pr-2 text-left w-10">#</th>
      <th className="py-2 px-2 text-left">Description</th>
      <th className="py-2 px-2 text-right w-20">Qty</th>
      <th className="py-2 px-2 text-right w-28">Unit Price</th>
      <th className="py-2 px-2 text-center w-16">Tax</th>
      <th className="py-2 px-2 text-right w-28">Total</th>
      <th className="py-2 pr-4 w-10"></th> {/* Delete button */}
    </tr>
  </thead>
  <tbody className="divide-y">
    {charges.map(charge => <ChargeRow />)}
  </tbody>
</table>
```

- **Description**: `<Input>` full width
- **Qty**: `<Input type="number" className="text-right tabular-nums" />`
- **Unit Price**: `<Input type="number" className="text-right tabular-nums" />` with $ prefix
- **Tax**: `<Checkbox>` centered
- **Total**: Read-only computed `className="text-right tabular-nums font-medium"`
- **Delete**: `<Button variant="ghost" size="sm"><Trash2 className="h-4 w-4 text-text-secondary hover:text-danger" /></Button>`

"+ Add Charge" button below the table:
```tsx
<Button variant="ghost" size="sm" className="mt-2 text-primary">
  <Plus className="mr-1.5 h-4 w-4" /> Add Charge
</Button>
```

Charges are saved on blur or on explicit save. Each row calls the charges CRUD endpoint independently (or batch on save).

### Tab: Notes

Identical pattern to EstimateDetailPage notes tab:
- Add note: `<Textarea>` + "Add Note" button
- Note list: `border-b pb-3 last:border-0`, creator name, timestamp, content
- Empty: "No notes yet."

### Tab: Timeline

Vertical timeline of events:

```tsx
<div className="space-y-4">
  {events.map(event => (
    <div key={event.id} className="flex gap-3">
      <div className="flex flex-col items-center">
        <div className="h-8 w-8 rounded-full bg-background-light flex items-center justify-center">
          <EventIcon className="h-4 w-4 text-text-secondary" />
        </div>
        <div className="flex-1 w-px bg-border" /> {/* vertical line */}
      </div>
      <div className="pb-4">
        <p className="text-sm font-medium text-text-primary">{event.description}</p>
        <p className="text-xs text-text-secondary">
          {event.creator.first_name} {event.creator.last_name} · {formatDateTime(event.created_at)}
        </p>
      </div>
    </div>
  ))}
</div>
```

Timeline event icons:
- Created: `Plus`
- Assigned: `UserPlus`
- Scheduled: `Calendar`
- Started: `Play`
- Completed: `CheckCircle2`
- Cancelled: `XCircle`
- Note Added: `StickyNote`

### Breadcrumbs (Context-Aware)

Same pattern as EstimateDetailPage. Uses `location.state?.breadcrumbs`.

Default (from Jobs list):
```
Jobs > JOB-2025-0042
```

From Customer detail:
```
Customers > John Smith > JOB-2025-0042
```

From Lead detail:
```
Leads > Lead #xxx > JOB-2025-0042
```

From Estimate detail:
```
Estimates > EST-2025-0015 > JOB-2025-0042
```

### Action Buttons — Hero Card

The hero card right side shows a primary action button and an overflow menu. See Section 7 for the full status/role matrix.

**Primary button** (changes by status):
- UNASSIGNED: "Assign & Schedule" (icon: `CalendarPlus`)
- SCHEDULED: "Start Job" (icon: `Play`)
- IN_PROGRESS: "Complete Job" (icon: `CheckCircle2`)
- COMPLETED: No primary action (just overflow)
- CANCELLED: No primary action

**Overflow menu** (MoreHorizontal icon button):
```tsx
<DropdownMenu>
  <DropdownMenuTrigger asChild>
    <Button variant="outline" size="sm"><MoreHorizontal className="h-4 w-4" /></Button>
  </DropdownMenuTrigger>
  <DropdownMenuContent align="end">
    {/* Conditional items based on status — see matrix */}
    <DropdownMenuItem><Pencil /> Edit</DropdownMenuItem>
    <DropdownMenuItem><UserPlus /> Reassign</DropdownMenuItem>
    <DropdownMenuItem><Calendar /> Reschedule</DropdownMenuItem>
    <DropdownMenuItem className="text-danger"><XCircle /> Cancel Job</DropdownMenuItem>
    <DropdownMenuItem className="text-danger"><Trash2 /> Delete</DropdownMenuItem>
  </DropdownMenuContent>
</DropdownMenu>
```

### Loading State

Same as EstimateDetailPage:
```tsx
<div className="flex items-center justify-center py-12">
  <Loader2 className="h-6 w-6 animate-spin text-text-secondary" />
</div>
```

### Not Found State

```tsx
<div className="text-text-secondary py-12 text-center">Job not found</div>
```

---

## 4. SchedulePage (Calendar)

### Component Hierarchy

```
SchedulePage
  div.space-y-4
    // Page heading + view controls
    div.flex.items-center.justify-between
      h1 "Schedule"
      div.flex.items-center.gap-2
        TechnicianFilter (dropdown)
        ViewSwitcher (Day/Week/Month toggle group)

    // Main content: sidebar + calendar
    div.flex.gap-4
      // Left: Unassigned jobs sidebar
      div.w-72.shrink-0 (hidden on mobile)
        Card
          h3 "Unassigned Jobs" + count badge
          div.space-y-2.overflow-y-auto.max-h-[calc(100vh-250px)]
            UnassignedJobCard (for each job)

      // Right: Calendar
      div.flex-1.min-w-0
        Card.p-4
          BigCalendar
            Toolbar (custom)
            Events (custom event component)

    // Dialog
    ScheduleJobDialog
```

### Layout Blueprint

```
+----------------------------------------------------------------------+
| Schedule                            [All Techs v] [Day|Week|Month]   |
+----------------------------------------------------------------------+
|                                                                      |
| +------------+ +---------------------------------------------------+ |
| | UNASSIGNED | | < February 2025 >                                | |
| | JOBS (8)   | |                                                   | |
| |            | | Mon    Tue    Wed    Thu    Fri    Sat    Sun      | |
| | +--------+ | |  1      2      3      4      5      6      7     | |
| | |JOB-0042| | |       [====] [====]                              | |
| | |Smith   | | |              [====]                              | |
| | |Denver  | | |  8      9     10     11     12     13     14     | |
| | +--------+ | | [===]  [===]                                     | |
| |            | |                                                   | |
| | +--------+ | | 15     16     17     18     19     20     21     | |
| | |JOB-0043| | |                                                   | |
| | |Doe     | | |                                                   | |
| | |Aurora  | | | 22     23     24     25     26     27     28     | |
| | +--------+ | |                                                   | |
| |            | |                                                   | |
| | +--------+ | |                                                   | |
| | |JOB-0044| | |                                                   | |
| | |...     | | |                                                   | |
| | +--------+ | |                                                   | |
| +------------+ +---------------------------------------------------+ |
+----------------------------------------------------------------------+
```

### Unassigned Jobs Sidebar

Each card in the sidebar:

```tsx
<button
  onClick={() => openScheduleDialog(job)}
  className="w-full text-left p-3 rounded-lg border border-border hover:border-primary hover:bg-primary/5 transition-colors"
>
  <div className="flex items-center justify-between mb-1">
    <span className="text-xs font-medium text-primary">{job.job_number}</span>
    {job.is_urgent && (
      <Badge variant="outline" className="bg-danger/10 text-danger border-danger/20 text-[10px]">
        <AlertTriangle className="h-3 w-3 mr-0.5" /> Urgent
      </Badge>
    )}
  </div>
  <p className="text-sm font-medium text-text-primary truncate">
    {customer.first_name} {customer.last_name}
  </p>
  <p className="text-xs text-text-secondary truncate">
    {service_location.city}, {service_location.state}
  </p>
  <p className="text-xs text-text-secondary mt-1">
    Created {formatRelativeDate(job.created_at)}
  </p>
</button>
```

Sidebar header:
```tsx
<div className="p-4 border-b">
  <div className="flex items-center justify-between">
    <h3 className="text-sm font-semibold text-text-primary">Unassigned Jobs</h3>
    <span className="rounded-full bg-warning/10 text-warning px-2 py-0.5 text-xs font-medium">
      {unassignedJobs.length}
    </span>
  </div>
</div>
```

### Calendar Component (`react-big-calendar`)

**Custom Toolbar:**
```tsx
<div className="flex items-center justify-between mb-4">
  <div className="flex items-center gap-2">
    <Button variant="outline" size="sm" onClick={onNavigate.bind(null, 'PREV')}>
      <ChevronLeft className="h-4 w-4" />
    </Button>
    <Button variant="outline" size="sm" onClick={onNavigate.bind(null, 'TODAY')}>
      Today
    </Button>
    <Button variant="outline" size="sm" onClick={onNavigate.bind(null, 'NEXT')}>
      <ChevronRight className="h-4 w-4" />
    </Button>
    <h2 className="text-lg font-semibold text-text-primary ml-2">{label}</h2>
  </div>
</div>
```

Note: The view switcher is in the page header (not in the toolbar) to keep the calendar toolbar minimal.

**View Switcher (in page header):**
```tsx
<div className="flex items-center rounded-lg border border-border bg-white">
  {['day', 'week', 'month'].map(view => (
    <button
      key={view}
      onClick={() => setView(view)}
      className={cn(
        'px-3 py-1.5 text-sm font-medium transition-colors first:rounded-l-lg last:rounded-r-lg',
        currentView === view
          ? 'bg-primary text-white'
          : 'text-text-secondary hover:bg-background-light'
      )}
    >
      {view.charAt(0).toUpperCase() + view.slice(1)}
    </button>
  ))}
</div>
```

**Technician Filter (in page header):**
```tsx
<Select value={selectedTech} onValueChange={setSelectedTech}>
  <SelectTrigger className="w-48">
    <SelectValue placeholder="All Technicians" />
  </SelectTrigger>
  <SelectContent>
    <SelectItem value="all">All Technicians</SelectItem>
    {technicians.map(tech => (
      <SelectItem key={tech.id} value={tech.id}>
        {tech.first_name} {tech.last_name}
      </SelectItem>
    ))}
  </SelectContent>
</Select>
```

**Custom Event Component:**

For Month view (compact):
```tsx
<div
  className={cn(
    'rounded px-1.5 py-0.5 text-xs font-medium truncate cursor-pointer',
    eventColorClass // based on status
  )}
  title={`${job_number} - ${customer_name}`}
>
  {job_number}
</div>
```

For Week/Day view (detailed):
```tsx
<div
  className={cn(
    'rounded-md px-2 py-1 text-xs cursor-pointer border-l-4 bg-white shadow-sm',
    borderColorClass // left border color based on status
  )}
>
  <p className="font-semibold text-text-primary truncate">{job_number}</p>
  <p className="text-text-secondary truncate">{customer_name}</p>
  <p className="text-text-secondary truncate">{tech_name}</p>
</div>
```

Event color classes by status (for month view backgrounds):
```ts
const eventColorMap: Record<string, string> = {
  SCHEDULED: 'bg-info/20 text-info border-info',
  IN_PROGRESS: 'bg-primary/20 text-primary border-primary',
  COMPLETED: 'bg-success/20 text-success border-success',
  CANCELLED: 'bg-gray-100 text-gray-500 border-gray-300',
};
```

Border color classes (for week/day view left border):
```ts
const borderColorMap: Record<string, string> = {
  SCHEDULED: 'border-l-info',
  IN_PROGRESS: 'border-l-primary',
  COMPLETED: 'border-l-success',
  CANCELLED: 'border-l-gray-400',
};
```

### Calendar Interactions

| Element | Action | Behavior |
|---------|--------|----------|
| Calendar event | Click | `navigate(\`/jobs/${job.id}\`)` |
| Unassigned job card | Click | Opens `ScheduleJobDialog` pre-filled with that job |
| Empty time slot | Click | No action for MVP (drag-and-drop deferred to Step 10) |
| Calendar event | Drag | Deferred to Step 10 |
| Today button | Click | Navigate calendar to today's date |
| Prev/Next arrows | Click | Navigate one period (day/week/month) backward/forward |

### Calendar Sizing

The calendar card fills the remaining horizontal space (`flex-1 min-w-0`). The react-big-calendar height is set to fill the viewport minus header/padding:

```tsx
<Calendar
  style={{ height: 'calc(100vh - 200px)' }}
  // ...
/>
```

### Empty States

- **No events in view**: Calendar renders normally with empty cells (react-big-calendar handles this)
- **No unassigned jobs**: Sidebar shows: "All jobs are assigned" with a checkmark icon

---

## 5. Dialogs

### 5.1 NewUrgentJobDialog

**Trigger**: "New Urgent Job" button on JobsPage

**Layout**: `max-w-lg` (wider than CancelEstimateDialog because it has more fields)

**Flow**: Two-step within the same dialog:
1. **Step 1**: Search and select customer (same pattern as NewEstimateDialog)
2. **Step 2**: Pick service location + fill urgency details

```
+--------------------------------------------+
|        [!] Create Urgent Job               |
|        Assign right away to get started    |
|                                            |
|  [Search customer................]          |
|                                            |
|  John Smith (ACME Corp)            >       |
|  Jane Doe                          >       |
|                                            |
|  ── OR ──                                  |
|  [+ Add new client]                        |
+--------------------------------------------+
```

After customer is selected (step 2):

```
+--------------------------------------------+
|        [!] Create Urgent Job               |
|        for John Smith                      |
|                                            |
|  Service Location *                        |
|  [123 Main St, Denver, CO      v]         |
|                                            |
|  Urgency Reason *                          |
|  [No heat in building, pipes may...]      |
|                                            |
|  Scope Notes                               |
|  [Customer reports furnace making...]     |
|                                            |
|  Estimated Duration (minutes)              |
|  [120                          ]           |
|                                            |
|           [Cancel]  [Create Urgent Job]    |
+--------------------------------------------+
```

**Fields:**

| Field | Component | Validation | Required |
|-------|-----------|-----------|----------|
| Customer | Search + select (reuse pattern from NewEstimateDialog) | Must select | Yes |
| Service Location | `<Select>` populated from customer's service_locations | Must select | Yes |
| Urgency Reason | `<Textarea rows={2}>` | Min 1 char | Yes |
| Scope Notes | `<Textarea rows={3}>` | Max 5000 | No |
| Estimated Duration | `<Input type="number">` + "minutes" label | Positive integer | No |

**On success**: Navigate to the new job's detail page (`/jobs/${newJob.id}`).

**Error display**: Same pattern as CancelEstimateDialog (`<p className="text-sm text-danger">`).

### 5.2 ScheduleJobDialog

**Trigger**: "Assign & Schedule" on JobDetailPage, or clicking an unassigned job card on SchedulePage

**Layout**: `max-w-sm`

```
+--------------------------------------------+
|       [Calendar] Schedule Job              |
|       JOB-2025-0042                        |
|                                            |
|  Assign To *                               |
|  [Select technician...         v]          |
|                                            |
|  Date *                                    |
|  [Feb 15, 2025              ]              |
|                                            |
|  Start Time *                              |
|  [09:00 AM                   v]            |
|                                            |
|  End Time *                                |
|  [11:30 AM                   v]            |
|                                            |
|           [Cancel]  [Schedule]             |
+--------------------------------------------+
```

**Fields:**

| Field | Component | Validation | Required |
|-------|-----------|-----------|----------|
| Assign To | `<Select>` with active technicians | Must select | Yes |
| Date | `<Input type="date">` or a date picker | Must be today or future | Yes |
| Start Time | `<Select>` with 30-min increments (7:00 AM - 7:00 PM) | Required | Yes |
| End Time | `<Select>` with 30-min increments | Must be after start | Yes |

**On success**: Close dialog, invalidate queries, show success (toast or inline). Job status changes from UNASSIGNED to SCHEDULED.

**Conflict handling**: If the backend returns 409 (schedule conflict), display: "This technician already has a job scheduled during this time: {conflicting_job_number}" in danger text below the form.

### 5.3 CompleteJobDialog

**Trigger**: "Complete Job" button on JobDetailPage (IN_PROGRESS jobs)

**Layout**: `max-w-sm`

```
+--------------------------------------------+
|       [Check] Complete Job                 |
|       JOB-2025-0042                        |
|                                            |
|  This will mark the job as completed.      |
|                                            |
|  Completion Notes *                        |
|  [Replaced furnace igniter. Tested all...]|
|  [...............................         ]|
|                                            |
|       [Keep Working]  [Complete Job]       |
+--------------------------------------------+
```

**Fields:**

| Field | Component | Validation | Required |
|-------|-----------|-----------|----------|
| Completion Notes | `<Textarea rows={4}>` | Min 1 char, max 5000 | Yes |

**Buttons:**
- "Keep Working" (`variant="outline"`) — closes dialog
- "Complete Job" (`variant="default"`, primary blue) — disabled until notes are non-empty

**On success**: Close dialog, invalidate queries. Job status changes to COMPLETED.

### 5.4 CancelJobDialog

**Trigger**: "Cancel Job" from overflow menu on JobDetailPage

**Layout**: `max-w-sm` (identical pattern to CancelEstimateDialog)

```
+--------------------------------------------+
|       Cancel Job                           |
|       This action cannot be undone.        |
|       Please provide a reason.             |
|                                            |
|  Reason *                                  |
|  [Customer cancelled the project...]      |
|                                            |
|           [Keep Open]  [Cancel Job]        |
+--------------------------------------------+
```

**Fields:**

| Field | Component | Validation | Required |
|-------|-----------|-----------|----------|
| Cancellation Reason | `<Textarea rows={3}>` | Min 1 char | Yes |

**Buttons:**
- "Keep Open" (`variant="outline"`)
- "Cancel Job" (`variant="destructive"`) — red button

**On success**: Close dialog, invalidate queries. Job status changes to CANCELLED.

---

## 6. Cross-Entity Updates

### 6.1 EstimateDetailPage — "Convert to Job" Button

**Location**: Hero card action buttons area, shown as primary button when:
- Estimate status is APPROVED
- Deposit is PAID (or no deposit exists)
- No linked job already exists (`est.job === null`)

**Appearance:**
```tsx
<Button onClick={handleConvertToJob} disabled={convertMutation.isPending}>
  {convertMutation.isPending
    ? <Loader2 className="mr-2 h-4 w-4 animate-spin" />
    : <Briefcase className="mr-2 h-4 w-4" />
  }
  Convert to Job
</Button>
```

When a job already exists (linked via `est.job`):
```tsx
<Button variant="outline" size="sm" onClick={() => navigate(`/jobs/${est.job.id}`, { state: { breadcrumbs: [...] } })}>
  <Briefcase className="mr-2 h-4 w-4" />
  View Job ({est.job.job_number})
</Button>
```

**Behavior**: `POST /api/jobs` with `{ estimate_id: est.id }`. On success, navigate to the new job detail page with breadcrumbs that trace back through the estimate.

### 6.2 CustomerDetailPage — Jobs Tab

Add a "Jobs" tab to the existing tabs on CustomerDetailPage.

**Tab trigger:**
```tsx
<TabsTrigger value="jobs">
  Jobs
  <span className="ml-1.5 text-xs text-text-secondary">({jobsCount})</span>
</TabsTrigger>
```

**Tab content**: A mini table of jobs for this customer:

| Column | Content |
|--------|---------|
| Job # | Link to job detail (text-primary, clickable) |
| Status | StatusBadge |
| Type | "Urgent" badge or "Standard" |
| Assigned To | Tech name or "Unassigned" |
| Scheduled | Date or "--" |
| Created | Date |

Each row is clickable, navigating to `/jobs/{id}` with breadcrumbs: `Customers > {customer name} > {job_number}`.

**Empty state**: "No jobs yet for this customer."

**Tab order** in CustomerDetailPage: Leads, Estimates, Jobs, Invoices, Notes (Jobs inserted after Estimates).

### 6.3 LeadDetailPage — Linked Job Card

On the lead detail page, if the lead has an estimate that has a linked job, show a card/section:

**Location**: In the sidebar or main panel, below existing estimate info.

**Appearance**:
```tsx
{linkedJob && (
  <div className="border-t pt-4 mt-4">
    <h3 className="text-xs font-medium uppercase tracking-wide text-text-secondary mb-2">Linked Job</h3>
    <button
      onClick={() => navigate(`/jobs/${linkedJob.id}`, { state: { breadcrumbs: [...] } })}
      className="w-full text-left p-3 rounded-lg border border-border hover:border-primary hover:bg-primary/5 transition-colors"
    >
      <div className="flex items-center justify-between">
        <span className="text-sm font-medium text-primary">{linkedJob.job_number}</span>
        <StatusBadge status={linkedJob.status} />
      </div>
      <p className="text-xs text-text-secondary mt-1">
        Assigned: {linkedJob.assigned_user?.first_name || 'Unassigned'}
      </p>
    </button>
  </div>
)}
```

---

## 7. Status-Based Action Matrix

### Primary Action Button (Hero Card)

| Job Status | ADMIN | DISPATCHER | TECHNICIAN (assigned) | TECHNICIAN (not assigned) | SALES |
|------------|-------|------------|----------------------|--------------------------|-------|
| UNASSIGNED | Assign & Schedule | Assign & Schedule | -- | -- | -- |
| SCHEDULED | Start Job | Start Job | Start Job | -- | -- |
| IN_PROGRESS | Complete Job | Complete Job | Complete Job | -- | -- |
| COMPLETED | -- | -- | -- | -- | -- |
| CANCELLED | -- | -- | -- | -- | -- |

### Overflow Menu Items

| Action | UNASSIGNED | SCHEDULED | IN_PROGRESS | COMPLETED | CANCELLED |
|--------|-----------|-----------|-------------|-----------|-----------|
| Edit (scope/location) | Admin, Disp | Admin, Disp | -- | -- | -- |
| Assign/Reassign | Admin, Disp | Admin, Disp | -- | -- | -- |
| Reschedule | -- | Admin, Disp | -- | -- | -- |
| Cancel | Admin, Disp | Admin, Disp | Admin, Disp | -- | -- |
| Delete | Admin, Disp | -- | -- | -- | -- |

### Role Visibility Summary

- **ADMIN**: Full access to all actions
- **DISPATCHER**: Same as Admin except no user management
- **TECHNICIAN**: Can only see assigned jobs. Can Start and Complete their own jobs. Can add charges and notes on their jobs. Cannot assign, reassign, cancel, or delete.
- **SALES**: Read-only access to jobs linked to their leads. No action buttons shown. Can view details and add notes.

---

## 8. Responsive Behavior

### Breakpoints Used

| Breakpoint | px | Usage |
|------------|-----|-------|
| `sm` | 640px | Stack form fields |
| `md` | 768px | Hero card context strip: 1-col → 3-col |
| `lg` | 1024px | KPI strip: 3-col → 5-col (list) or 2-col → 4-col (detail); Calendar sidebar visibility |

### JobsPage Responsive

- **KPI strip**: `grid-cols-3 lg:grid-cols-5` — first 3 always visible, last 2 wrap below on small screens
- **DataTable**: Horizontal scroll on narrow screens (built into DataTable component). Consider hiding "Created" and "Location" columns on `< md` via `columnVisibility`.
- **Header actions**: Wrap to second line naturally via `flex-wrap`

### JobDetailPage Responsive

- **Hero card context strip**: `grid-cols-1 md:grid-cols-3` — stacks vertically on mobile
- **KPI strip**: `grid-cols-2 lg:grid-cols-4` — wraps to 2x2 grid on mobile
- **Action buttons**: Primary button + overflow always visible. On small screens, consider moving primary button to full-width below the hero info.
- **Tabs**: Horizontal scroll on narrow screens (built into TabsList)
- **Charges table**: Horizontal scroll wrapper on mobile: `<div className="overflow-x-auto">`

### SchedulePage Responsive

- **< lg**: Hide the unassigned jobs sidebar entirely. Add a collapsible drawer or a button that opens a sheet/drawer with the unassigned jobs list.
- **Calendar**: react-big-calendar handles responsive internally. On mobile, default to Day view instead of Month view.
- **View switcher + tech filter**: Stack vertically on mobile (`flex-col sm:flex-row`).

### Dialogs Responsive

All dialogs use shadcn Dialog which auto-centers and limits max-width. On mobile, dialogs fill the viewport width with margin. No special handling needed.

---

## 9. Accessibility

### Keyboard Navigation

- All action buttons are focusable and activated with Enter/Space
- DataTable rows: focusable via tab, Enter to navigate to detail
- Calendar events: focusable, Enter to navigate
- Unassigned job cards: `<button>` elements, naturally focusable
- Dialogs: focus trap, Escape to close (built into shadcn Dialog)
- DropdownMenu: Arrow keys to navigate, Enter to select (built into Radix)

### Screen Reader Support

- Status badges: The text content ("Unassigned", "Scheduled", etc.) serves as the accessible label
- Urgent badge: Include `aria-label="Urgent job"` on the badge
- KPI cells: Use `aria-label` combining label and value (e.g., `aria-label="Unassigned jobs: 8"`)
- Calendar events: `title` attribute with full job info
- Empty states: Descriptive text is sufficient
- Loading states: `aria-live="polite"` on the loading container

### Color Contrast

All status colors from the design system meet WCAG AA contrast ratios. The info/warning/success/danger tokens were chosen for this purpose. No additional color adjustments needed.

### Focus Management

- After dialog closes: Return focus to the trigger button
- After navigation from dialog (e.g., NewUrgentJobDialog -> job detail): Focus moves to the new page's h1
- After inline actions (e.g., adding a charge row): Focus moves to the new row's first input

---

## Appendix: New Files to Create

| File | Type | Purpose |
|------|------|---------|
| `frontend/src/pages/JobsPage.tsx` | Page | Replace existing placeholder |
| `frontend/src/pages/JobDetailPage.tsx` | Page | New |
| `frontend/src/pages/SchedulePage.tsx` | Page | New (Step 6.1, but routing can be added now) |
| `frontend/src/components/jobs/NewUrgentJobDialog.tsx` | Dialog | New |
| `frontend/src/components/jobs/ScheduleJobDialog.tsx` | Dialog | New |
| `frontend/src/components/jobs/CompleteJobDialog.tsx` | Dialog | New |
| `frontend/src/components/jobs/CancelJobDialog.tsx` | Dialog | New |

### Files to Modify

| File | Change |
|------|--------|
| `frontend/src/App.tsx` | Add `/jobs/:id` and `/schedule` routes |
| `frontend/src/pages/EstimateDetailPage.tsx` | Add "Convert to Job" / "View Job" button |
| `frontend/src/pages/CustomerDetailPage.tsx` | Add Jobs tab |
| `frontend/src/pages/LeadDetailPage.tsx` | Add linked job card |
| `frontend/src/components/layout/nav-config.ts` | Add "Schedule" nav item (CalendarDays icon, ADMIN + DISPATCHER) |

### New Dependencies

| Package | Purpose | Install Command |
|---------|---------|----------------|
| `react-big-calendar` | Calendar view | `npm install react-big-calendar --workspace=frontend` |
| `date-fns` | Date localizer for react-big-calendar | `npm install date-fns --workspace=frontend` |
| `@types/react-big-calendar` | TypeScript types | `npm install -D @types/react-big-calendar --workspace=frontend` |
