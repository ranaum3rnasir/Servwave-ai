# Scheduler V2 — Design Spec

**Date:** 2026-03-19
**Status:** Draft — pending approval
**Scope:** Full scheduler redesign (visual + functional + bug fixes)
**Benchmark:** Google Calendar UX with FSM dispatch features
**Files affected:** SchedulePage.tsx, TechnicianGridView.tsx, MemberWeekBoard.tsx, schedule-dark.css, usePlanMode.ts, AssignJobDialog.tsx, lead.controller.ts, email.ts, status-badge.tsx, ScheduleSearch.tsx

---

## 1. Color System

All event colors change from transparent-with-left-border to **solid colored pills with white text** (Google Calendar style).

| Element | Color | Hex | Usage |
|---------|-------|-----|-------|
| Scheduled Job | Blue | `#039be5` | Default job event on calendar |
| Urgent Job | Red | `#d93025` | Urgent job event + sidebar badge |
| Walkthrough | Violet | `#7c3aed` | Walkthrough events + sidebar accent |
| Completed | Gray | `#9aa0a6` | Completed jobs/walkthroughs (dimmed, 0.6 opacity) |
| Plan Mode | Amber | `#d97706` | Plan mode background tint, banner, ghost borders |
| Conflict | Red | `#ef4444` | Subtle red left border (4px) + ⚠️ icon (replaces hatch pattern) |
| Today column | Light blue | `rgba(37,99,235,0.04)` | Background tint on today's column |

**Cancelled events are removed from the calendar entirely.** They are never rendered — not dimmed, not hidden behind a toggle. The Open/All toggle is removed.

### Event Pill Styling

```
Standard event:
  background: {status color}
  border-radius: 6px
  padding: 6px 8px
  color: #fff
  box-shadow: 0 1px 3px rgba(0,0,0,0.12)
  cursor: grab

Completed event:
  Same as above but opacity: 0.6
  cursor: default (not draggable)

Ghost event (Plan Mode):
  background: {status color} at 12% opacity
  border: 2px dashed {status color}
  border-radius: 6px
  "DRAFT" label in top-right corner
  cursor: grab
```

### Resize Handle

Visible white pill at bottom of event on hover:
```
Position: absolute bottom, centered
Width: 24px, height: 3px
Background: rgba(255,255,255,0.6)
Border-radius: 2px
Cursor: ns-resize
Hidden when not hovered (opacity transition)
```

---

## 2. Layout & Toolbar

### Toolbar (simplified)

Left to right:
1. **Today button** — `padding: 4px 16px`, outlined, GCal style
2. **‹ › navigation arrows** — larger touch targets
3. **Date label** — `font-size: 18px`, lighter weight (e.g., "March 2026")
4. **Standard / Member View toggle** — two-button segmented control
5. **Plan Mode button** — (Admin/Dispatcher only) prominent, amber when active with pulsing dot
6. **Search bar** — `ScheduleSearch` component, right-aligned, pill-shaped with search icon
7. **Day / Week / Month switcher** — segmented control (Month hidden in Member View)
8. **Settings gear** — dropdown containing: Legend, Staff Filter (All/Technicians/Sales), Keyboard Shortcuts

**Removed from toolbar:**
- Open/All toggle (removed entirely — all non-cancelled events always shown)
- Right sidebar toggle (legend moves into settings gear)
- Inline staff filter dropdown (moves into settings gear)

### Right Sidebar

**Removed.** The legend, keyboard shortcuts, and quick stats move into the settings gear dropdown. This reclaims horizontal space for the calendar.

### Left Sidebar

Width: 240px. Two collapsible sections:

**Section 1: Walkthroughs** (violet accent)
- Header: Footprints icon + "Walkthroughs" + count badge (violet)
- Cards: lead_number, customer name, address
- Click: navigate to Lead detail
- Right-click: "View Lead" + "No Walkthrough Needed"
- **Draggable** (currently NOT — must fix per REQ-01)

**Section 2: Unassigned Jobs** (blue accent)
- Header: Briefcase icon + "Unassigned Jobs" + count badge
- Cards: job_number, customer name, location, urgent badge
- Click: opens AssignJobDialog
- Right-click: "View Job"
- Draggable: already works

Both sections use `cursor: grab` on cards.

---

## 3. Views

### 3.1 Standard Week View (default)

- Time Y-axis (left gutter), day columns (Mon–Sun)
- Current time indicator: red line with red dot at left edge (GCal style)
- Today's date: blue circle around the date number in column header
- Off-hours dimming: slots before 7 AM and after 7 PM get subtle gray background
- Events rendered as solid colored pills
- Drag events to reschedule (vertical = time change, horizontal = day change)
- Resize events from bottom handle to change duration

### 3.2 Standard Day View

- Single day, time Y-axis
- Same interactions as week view
- Wider event pills (full column width)

### 3.3 Standard Month View

- Calendar grid, events as small pills
- "+N more" overflow link for days with many events
- Drag changes date (time preserved)
- Click event opens detail popup (same as week/day)

### 3.4 Member Day View (TechnicianGridView)

- One column per technician/sales user
- Time Y-axis (6 AM – 8 PM)
- Sticky header with tech avatars + names
- Events positioned absolutely by time
- **Drag events between columns = reassign to different tech**
- **Drag events vertically = reschedule time**
- Left-click: detail popup (same as Standard view)
- Right-click: context menu (same as Standard view)
- Drop from sidebar: direct assignment to tech + time from position
- Resize: drag bottom edge to change duration

### 3.5 Member Week View (MemberWeekBoard)

- Jira-board style: tech columns with day sections
- Day headers: "Tuesday, Mar 17 — 3 jobs · 6.5 hrs"
- Cards stacked vertically under each day/tech combo
- **Drag cards between tech columns = reassign**
- **Drag cards between day sections = reschedule day (time picker dialog)**
- Left-click: detail popup (same as Standard view — currently navigates, must fix for consistency)
- Right-click: context menu (same as Standard view — currently missing, must add)

### View Consistency Rule

**Every interaction must work identically across all 5 views.** Specifically:
- Left-click → detail popup with info + actions
- Right-click → minimal context menu
- Drag → reschedule/reassign with confirmation
- Sidebar drag → assign with confirmation
- Hover → tooltip after 350ms delay

---

## 4. Interactions

### 4.1 Left-Click on Event

Opens a detail card (floating, positioned near click):

**Content:**
- Header: Job number or "WALKTHROUGH" label + status badge + X close button
- Customer name + company (if any)
- Address (with MapPin icon)
- Time range (with Clock icon)
- Assigned tech / performer (with Wrench icon)
- Phone (with Phone icon)

**Actions (inline buttons at bottom):**
- "Reschedule" button — opens inline date/time picker or AssignJobDialog
- "Reassign" button — opens tech picker
- "View [Job/Lead] →" link — navigates to detail page

**Behavior:**
- Appears on left-click, dismisses on outside click or Escape
- Tooltip (hover) is dismissed immediately when click popup opens
- Only one popup open at a time

### 4.2 Right-Click on Event

Minimal context menu:
- **"Open Details"** — navigates to Job/Lead detail page
- Separator
- **"Cancel Job"** — opens CancelJobDialog (jobs only, not walkthroughs)

For walkthroughs, right-click shows:
- **"Open Lead"** — navigates to Lead detail page
- Separator
- **"Cancel Walkthrough"** — cancels the walkthrough (calls `POST /api/leads/:id/walkthrough/cancel` with reason prompt, sends cancellation email)

No other actions in the right-click menu (reassign, reschedule, etc. are in the left-click popup).

### 4.3 Click on Empty Slot

Quick-schedule floating card appears:

**Layout:**
- Header: "Schedule" + time display + X close button
- Two tabs: "Jobs" | "Walkthroughs"
- Search bar at top (type to filter by job#, customer name, lead#)
- Short scrollable list of matching unassigned jobs / unscheduled walkthroughs (max ~5 visible, scroll for more)
- Click a job/walkthrough → opens AssignJobDialog or walkthrough schedule dialog with time pre-filled

**Behavior:**
- Appears at click position
- Dismisses on outside click or Escape
- Does NOT appear if user is actively dragging

### 4.4 Drag-Select Empty Time Range

Dragging across empty slots creates a highlighted time range (blue selection, like GCal). On release, the same quick-schedule card (4.3) appears with the dragged time range pre-filled as start/end.

### 4.5 Drag Existing Event (Reschedule/Reassign)

**Cursor feedback:**
- Hover on event: `cursor: grab`
- During drag: `cursor: grabbing`
- Over invalid zone: `cursor: not-allowed`

**On drop — Confirmation Modal appears:**

```
┌─────────────────────────────────────┐
│ 📅  Reschedule Job?                 │
│     JOB-2026-0015                   │
│                                     │
│  ┌─────────────────────────────┐    │
│  │ FROM              →    TO   │    │
│  │ Mon, Mar 16           Wed,  │    │
│  │ 8:00–10:00 AM        Mar 18 │    │
│  │ Mike Thompson     9:00–11:00│    │
│  │                   Jake R.   │    │
│  └─────────────────────────────┘    │
│                                     │
│  📧 Emails will be sent to:        │
│     • John Smith (customer)         │
│     • Jake Rodriguez (technician)   │
│                                     │
│              [Cancel] [Confirm]     │
└─────────────────────────────────────┘
```

- Shows old date/time/tech → new date/time/tech
- Lists email recipients (customer + new tech + dispatcher)
- "Cancel" reverts event to original position
- "Confirm & Notify" fires API call
- If conflict detected (409): shows conflict dialog with "Schedule Anyway" option

**For walkthroughs:** Same modal but says "Reschedule Walkthrough?" and lists walkthrough-specific email recipients (customer + performer + lead owner).

**Protection rules:**
- Completed events: NOT draggable (`draggableAccessor` returns false)
- Cancelled events: not on calendar at all
- Past events: CAN be dragged (dispatchers may back-fill records)

### 4.6 Drag from Sidebar

**Jobs:**
- Drag job card → drop on calendar
- Standard view: Opens AssignJobDialog with time from drop position
- Member Day: Direct assignment to tech (from column) + time (from Y position), still shows confirmation modal
- Member Week: Assignment to tech (from column) + day (from section), time picker in confirmation

**Walkthroughs (NEW — currently not draggable):**
- Same behavior as jobs
- Drag walkthrough card → drop on calendar
- Opens walkthrough schedule dialog (performer picker + time) or direct assignment in Member Day view
- Must send `walkthrough_assigned_to`, `walkthrough_scheduled_at`, `walkthrough_duration_minutes`

### 4.7 Resize Event

- Drag bottom handle to change duration
- Jobs: updates `scheduled_end` via assign endpoint
- Walkthroughs: updates `walkthrough_duration_minutes` via walkthrough/schedule endpoint
- Minimum duration: 30 minutes
- Completed events: NOT resizable
- Shows brief toast confirmation (no full modal needed for resize — it's a minor change)

### 4.8 Hover Tooltip

- 350ms delay before showing
- Small card: event title, customer, address, time
- Dismisses immediately on mouse leave
- Dismisses when click popup or context menu opens
- Dismisses when drag starts
- `pointer-events: none` (tooltip doesn't capture clicks)

---

## 5. Plan Mode

### Activation

- Toggle button in toolbar (Admin/Dispatcher only)
- Inactive: outlined button with PenLine icon + "Plan Mode" text
- Active: amber gradient button with pulsing dot + "Planning" text

### Visual State Change (Amber Sandbox)

When Plan Mode activates:
- Calendar background transitions to `linear-gradient(180deg, #fffbeb 0%, #fef3c7 100%)`
- Dashed amber border appears around calendar area: `border: 2px dashed #fde68a`
- Sticky banner appears below toolbar:
  ```
  Background: linear-gradient(135deg, #78350f, #d97706)
  Content: [pulsing amber dot] "Plan Mode" — "N drafts"
  Right side: [Discard All] [Confirm All] buttons
  ```
- Smooth CSS transition on activate/deactivate (200ms ease)

### Ghost Events

Created when:
1. Sidebar item dragged to calendar in Plan Mode
2. Existing event dragged to new position in Plan Mode (FIX H-13 — currently fires live API instead)

Ghost appearance:
- Background: status color at 12% opacity
- Border: 2px dashed in status color
- "DRAFT" label: top-right corner, small uppercase text
- Draggable within the calendar (to reposition)

### Ghost Actions (Right-Click)

- **"Confirm"** → opens confirmation dialog (same as section 4.5 but says "Schedule" not "Reschedule") → fires API → ghost becomes real event
- **"Remove"** → deletes ghost, restores sidebar card if it came from sidebar

### Batch Actions

- **"Confirm All"** — confirms all ghosts visible in current date range (sequential API calls)
- **"Discard All"** — removes all ghosts, restores all sidebar cards

### Exit Behavior

- With ghosts present: Warning dialog with 3 options:
  - "Discard & Exit" — removes all ghosts
  - "Confirm All & Exit" — batch confirms then exits
  - "Cancel" — stays in Plan Mode
- Browser `beforeunload` prompt when ghosts exist
- **Persistence (FIX H-17):** Use stable localStorage key per tab (not regenerating sessionId on each load). Key format: `plan-mode-{tab-id}` where tab-id is generated once on first Plan Mode activation and stored in sessionStorage.

### Plan Mode + Existing Events (FIX H-13)

When dragging a CONFIRMED event in Plan Mode:
- Do NOT fire the live API
- Create a ghost at the new position
- Show the original event dimmed at its original position (origin marker)
- On "Confirm": fire reschedule API, remove ghost + origin marker
- On "Remove": remove ghost, restore original event to full opacity

---

## 6. Conflict Detection

### Visual Indicator (FIX V-01)

Replace the current aggressive orange hatch pattern with:
- Subtle **orange-red left border** (4px, `#ef4444`)
- Small **⚠️ AlertTriangle icon** in event card (top-right)
- Tooltip shows conflict details on hover

### Conflict Detection Logic (unchanged)

Client-side: compare all events with same `resourceId` for time overlaps.
Server-side: 409 response with conflict details when assigning/rescheduling.

### Conflict Dialog

When a drop/assign triggers a 409:
```
┌──────────────────────────────────┐
│ ⚠️  Scheduling Conflict          │
│                                  │
│  "Schedule conflict detected."   │
│                                  │
│  ┌────────────────────────────┐  │
│  │ JOB  JOB-2026-0023        │  │
│  │      9:00 – 11:00 AM      │  │
│  └────────────────────────────┘  │
│                                  │
│         [Cancel] [Schedule Anyway]│
└──────────────────────────────────┘
```

"Schedule Anyway" sends `force: true` to the API.

---

## 7. Bug Fixes (from QA Final Report)

### P0 — Critical

| ID | Fix | File | Detail |
|----|-----|------|--------|
| P0-04 | Walkthrough DnD endpoint | SchedulePage.tsx:953 | Change `/api/leads/:id/walkthrough` → `/api/leads/:id/walkthrough/schedule`. Send `walkthrough_assigned_to`, `walkthrough_duration_minutes`, `force: true`. |
| P0-04b | Backend status guard + reschedule detection | lead.controller.ts:681,767 | **Two changes:** (1) Add `WALKTHROUGH_SCHEDULED` to the status guard at line 681 so rescheduling an already-scheduled walkthrough is allowed. (2) Update the `isReschedule` check at line 767 to: `const isReschedule = existing.status === 'WALKTHROUGH_COMPLETED' \|\| existing.status === 'WALKTHROUGH_SCHEDULED';` — this ensures dragging a scheduled walkthrough sends a "Rescheduled" email (not "Scheduled") and creates a `WALKTHROUGH_RESCHEDULED` timeline event. |
| P0-04c | Pass performer + duration + expand TS type | SchedulePage.tsx:949,1043-1044 | (1) Expand the mutation type from `{ leadId: string; newStart: string }` to `{ leadId: string; newStart: string; performerId: string; durationMinutes: number; force?: boolean }`. (2) Extract `walkthrough_assigned_to` and `walkthrough_duration_minutes` from `event.raw` at the call sites (handleEventDrop line 1043, handleEventResize line 1074). |

### P1 — High Priority

| ID | Fix | File | Detail |
|----|-----|------|--------|
| D-01 | cursor:grab on events | schedule-dark.css | `.rbc-event { cursor: grab }` |
| D-03 | cursor:grabbing during drag | schedule-dark.css | `.rbc-addons-dnd-dragged-event { cursor: grabbing }` + body class during drag |
| D-06 | Tooltip persists during drag | SchedulePage.tsx | Clear tooltip + cancel timer when `handleEventDrop`/`handleEventResize` fire |
| D-09 | Grid view cards not draggable | TechnicianGridView.tsx | Add `draggable` attribute + onDragStart/onDragEnd to JobCard component |
| F-09 | Grid view rejects sidebar drops | TechnicianGridView.tsx | Fix drop zone event handlers to accept external drag data |
| V-01 | Conflict hatch pattern | SchedulePage.tsx, schedule-dark.css | Replace hatching with subtle border + icon (see section 6) |
| V-02 | Job # truncation on short events | ScheduleEvent component | Priority text layout: show job# first, truncate customer/address |
| V-06 | Resize handle invisible | schedule-dark.css | Increase handle size, always show on hover with white pill style |
| H-13 | Plan Mode fires live API on drag | SchedulePage.tsx:handleEventDrop | Check `planMode.isActive` — if true, create ghost instead of calling mutation |
| H-17 | Plan Mode lost on refresh | usePlanMode.ts | Use stable tab-scoped key (see section 5) |
| REQ-01 | Sidebar walkthroughs not draggable | SchedulePage.tsx:1220-1260 | Add `draggable`, `onDragStart`, `onDragEnd` to walkthrough cards (mirror job card pattern) |
| — | Member Week left-click inconsistent | MemberWeekBoard.tsx | Change `onSelectEvent` to open detail popup (not navigate) |
| — | Member Week right-click missing | MemberWeekBoard.tsx | Add `onContextMenu` handler to board cards |

### P2 — Polish

| ID | Fix | Detail |
|----|-----|--------|
| V-04 | Sidebar drag feedback too faint | Increase opacity of "Drop to schedule" preview text |
| V-05 | No sidebar search for large lists | Add filter input at top of each sidebar section (stretch goal) |
| H-05-msg | Error toast says "schedule" not "reschedule" | Fix copy in error handler |
| J-1024 | Toolbar wraps at 1024px | Responsive: collapse less-used controls into overflow menu |
| D-10 | Sidebar drag time prefill wrong | Ensure drop position correctly maps to time slot |
| C-09-space | Whitespace below sidebar when collapsed | Remove extra padding when section is collapsed |
| V-08 | Month view "+33 more" overflow | Style overflow popup to match GCal redesign |
| V-09 | Ghost events too faint in Plan Mode | Increase ghost opacity from 0.12 to 0.18 background, ensure DRAFT label is prominent |
| V-10 | Tooltip text too small at full zoom | Increase tooltip font sizes by 1px across the board |
| J-1024-text | Event text illegible at 1024px | Reduce font-size threshold, prioritize job# over customer name at narrow widths |

### Addressed by Visual Redesign (no separate fix needed)

| ID | Finding | How V2 Addresses It |
|----|---------|---------------------|
| RAN-01-3a | Plan Mode not visually distinguishable | Amber sandbox theme (section 5) completely changes the calendar appearance |
| V-07 | Plan Mode active state too subtle | Amber gradient banner + background tint + pulsing dot — unmissable |
| N-13-sales | Sales filter empty state not helpful | Staff filter moves to settings gear dropdown with clear labels (section 8.3) |
| V-03 | Member Grid Week view too dense | Acknowledged — the MemberWeekBoard card-based layout already mitigates this vs. the time-grid approach. No further changes planned for V2. |

---

## 8. New Features

### 8.1 Reschedule Confirmation Modal

**Trigger:** Any drag of an existing scheduled event to a new position/tech.

**Content:**
- Icon + "Reschedule Job?" / "Reschedule Walkthrough?" title
- Job/walkthrough number subtitle
- FROM → TO comparison panel (date, time, assigned tech)
- Email notification banner: amber panel listing recipients
- "Cancel" + "Confirm & Notify" buttons

**Logic:**
1. User drops event at new position
2. Modal appears (event stays at new position optimistically)
3. User clicks "Confirm & Notify" → API call fires
4. If 409 conflict → conflict dialog stacks on top
5. User clicks "Cancel" → event reverts to original position

**Backend:** Job assignment email already sent by `assign` endpoint. Walkthrough reschedule email sent by `scheduleWalkthrough` endpoint. **Backend fix needed (P0-04b):** The `isReschedule` detection at line 767 must also check `WALKTHROUGH_SCHEDULED` status (not just `WALKTHROUGH_COMPLETED`) so that dragging an already-scheduled walkthrough sends the "Rescheduled" email and creates a `WALKTHROUGH_RESCHEDULED` timeline event.

### 8.2 Quick-Schedule Card (Empty Slot Click/Drag)

**Trigger:** Click or drag-select on empty calendar slot.

**Content:**
- Header: "Schedule" + formatted time range + X close
- Tab bar: "Jobs" | "Walkthroughs"
- Search input: placeholder "Search jobs..." / "Search walkthroughs..."
- Results list: max 5 visible, scrollable. Each item shows number + customer + location
- Click item → opens AssignJobDialog (jobs) or walkthrough schedule dialog (walkthroughs) with time pre-filled

**Data source:** Same as sidebar queries — unassigned jobs + unscheduled walkthroughs.

### 8.3 Settings Gear Dropdown

**Trigger:** Click gear icon in toolbar (rightmost position).

**Content panel (dropdown):**
- **Legend section:** Color swatches for all event types
- **Staff Filter:** Radio buttons: All Staff / Technicians / Sales (Member View only)
- **Keyboard Shortcuts:** Key → action pairs

### 8.4 Sidebar Walkthrough Drag (REQ-01 Fix)

Make walkthrough cards in the sidebar draggable, identical to job cards:
- Add `draggable` attribute
- `onDragStart`: set `draggingJobIdRef.current` to lead ID (prefixed to avoid collision)
- Create drag ghost image (violet background with lead number)
- `onDragEnd`: clear drag state
- On drop to calendar: open walkthrough schedule dialog with time + optional tech pre-filled
- In Plan Mode: create ghost event instead

---

## 9. CSS Overhaul (schedule-dark.css)

### Replace Existing Styles

The entire `schedule-dark.css` needs to be rewritten to match Google Calendar:

**Key changes:**
- Event pills: remove `borderLeft` style, use solid `background` + `border-radius: 6px`
- Grid lines: lighter (`#dadce0` instead of `#e2e8f0`)
- Time gutter labels: `color: #70757a`, `font-size: 10px`
- Day headers: larger date numbers (`font-size: 20px`), uppercase day abbreviations (`font-size: 9px`, `letter-spacing: 0.5px`)
- Today indicator: blue circle on date number (`.rbc-now`)
- Current time line: red `#ea4335` with red dot on left edge
- Cursor: `grab` on events, `grabbing` during drag (via `.rbc-addons-dnd-dragged-event`)
- Selection: `background: rgba(37,99,235,0.08)` for slot selection
- Resize handle: always visible on hover, white pill style, larger hit zone
- DnD placeholder: solid color preview (not just opacity reduction)
- Plan Mode: amber tint + dashed border via `.plan-mode-active` class on container

### Plan Mode CSS Classes

```css
.schedule-cal.plan-mode-active {
  background: linear-gradient(180deg, #fffbeb 0%, #fef3c7 100%);
  border: 2px dashed #fde68a;
  border-radius: 8px;
  transition: all 0.2s ease;
}
```

---

## 10. Event Data & Filtering

### Query Changes

**Scheduled jobs query:** Remove `CANCELLED` from status filter. Only fetch `SCHEDULED`, `IN_PROGRESS`, `COMPLETED`.

```typescript
params: {
  status: ['SCHEDULED', 'IN_PROGRESS', 'COMPLETED'],
  scheduled_after: dateRange.start.toISOString(),
  scheduled_before: dateRange.end.toISOString(),
  limit: 500,
}
```

**Event transformation:** Map `IN_PROGRESS` to the same blue color as `SCHEDULED` (no visual distinction on the calendar — the detail popup shows the actual status).

### Walkthrough Mutation Fix (P0-04)

```typescript
// BEFORE (broken):
mutationFn: async (payload) => {
  await api.post(`/api/leads/${payload.leadId}/walkthrough`, {
    walkthrough_scheduled_at: payload.newStart,
  });
}

// AFTER (fixed):
mutationFn: async (payload) => {
  await api.post(`/api/leads/${payload.leadId}/walkthrough/schedule`, {
    walkthrough_scheduled_at: payload.newStart,
    walkthrough_assigned_to: payload.performerId,
    walkthrough_duration_minutes: payload.durationMinutes,
    force: payload.force ?? false,
  });
}
```

---

## 11. Keyboard Shortcuts

| Key | Action |
|-----|--------|
| T | Navigate to today |
| 1 | Day view |
| 2 | Week view |
| 3 | Month view |
| S | Standard view |
| G | Member (grouped) view |
| Escape | Close any popup/menu/dialog |

These remain unchanged but move to the settings gear dropdown for discoverability.

---

## 12. Animations & Motion Design

The scheduler must feel **fluid and alive** — like Google Calendar. Every interaction should have smooth feedback. No janky jumps, no hard cuts, no state changes without visual transitions.

### 12.1 Core Principle: Everything Animates

Nothing should appear, disappear, move, or change state without a transition. The goal is for the user to never wonder "what just happened?" — motion tells the story.

### 12.2 Timing Curves

| Duration | Use Case | Easing |
|----------|----------|--------|
| 100ms | Hover states (background color, scale) | `ease-out` |
| 150ms | Button press feedback, cursor changes | `ease-out` |
| 200ms | Popups appearing/disappearing, Plan Mode background transition | `ease-in-out` |
| 250ms | View transitions (Day → Week → Month) | `ease-in-out` |
| 300ms | Sidebar section collapse/expand | `ease-in-out` |
| 350ms | Modal dialogs (enter with scale + fade) | `cubic-bezier(0.32, 0.72, 0, 1)` — GCal-like spring |

### 12.3 Drag & Drop Animations

**Drag start:**
- Event pill lifts: `scale(1.03)` + `box-shadow` increases (elevation rises from 1px to 8px)
- Source slot shows a ghost placeholder: faint dashed outline at original position (30% opacity of event color)
- Body cursor changes to `grabbing` immediately
- Tooltip dismissed instantly (no fade — just gone)
- Transition: 100ms ease-out

**During drag:**
- Event follows cursor smoothly (no lag — native HTML5 drag for sidebar, react-big-calendar internal for calendar events)
- Time slot under cursor highlights with light blue background pulse (`rgba(37,99,235,0.08)`)
- Time label in gutter updates in real-time as event moves vertically
- In Member View: tech column header highlights when event enters the column

**Drop (successful):**
- Event settles into new slot with a subtle spring animation: slight overshoot then settle (200ms, `cubic-bezier(0.34, 1.56, 0.64, 1)`)
- Source ghost placeholder fades out (150ms)
- Confirmation modal slides in from bottom with backdrop fade (200ms)
- Shadow returns to normal elevation

**Drop (cancelled / reverted):**
- Event springs back to original position (250ms, spring ease with slight bounce)
- Error toast slides in from bottom-right (200ms)

**Drop (conflict 409):**
- Event stays at new position (optimistic)
- Conflict modal appears (200ms scale-up + fade)
- If cancelled: event springs back (250ms)
- If forced: event stays, modal fades out (150ms)

### 12.4 Event Hover & Click

**Hover on event:**
- Background brightens slightly: `filter: brightness(1.05)` (100ms)
- Resize handle fades in at bottom (150ms, opacity 0 → 1)
- Cursor transitions from default → grab

**Click → detail popup:**
- Popup scales in from click point: `scale(0.95) → scale(1)` + `opacity(0) → opacity(1)` (200ms)
- Backdrop: none (popup is floating, not modal)
- Dismiss: scales down + fades out (150ms)

**Right-click → context menu:**
- Menu pops in: `scale(0.92) → scale(1)` + `opacity(0) → opacity(1)` (150ms)
- Dismiss: instant (no animation — context menus feel snappier without exit animation)

### 12.5 Empty Slot Interactions

**Click on empty slot:**
- Quick-schedule card scales in from click point (200ms, same as detail popup)
- Light blue highlight on the clicked time slot (100ms fade-in)

**Drag-select time range:**
- Blue selection rectangle expands smoothly as cursor moves (follows cursor in real-time)
- Selection has a subtle pulse: `rgba(37,99,235,0.08)` → `rgba(37,99,235,0.12)` → `rgba(37,99,235,0.08)` (2s loop)
- On release: quick-schedule card appears (200ms scale-in)

### 12.6 View Transitions

**Day ↔ Week ↔ Month switching:**
- Cross-fade: old view fades out (100ms) while new view fades in (150ms)
- Stagger: column headers animate in left-to-right with 20ms stagger delay
- No jarring layout jump — container size stays stable

**Standard ↔ Member View toggle:**
- Cross-fade transition (200ms)
- Calendar area maintains same height throughout transition

**Date navigation (prev/next):**
- Content slides in direction of navigation:
  - Next: slides left (content exits left, new content enters from right)
  - Previous: slides right
  - Duration: 200ms, ease-in-out
- Date label in toolbar cross-fades (150ms)

### 12.7 Plan Mode Transitions

**Activate Plan Mode:**
- Calendar background color transitions smoothly to amber tint (300ms ease-in-out)
- Dashed border draws in (border width animates from 0 → 2px, 200ms)
- Banner slides down from toolbar (200ms, ease-out)
- Plan Mode button morphs: outline → filled amber + pulsing dot appears (200ms)

**Deactivate Plan Mode:**
- Reverse of activation: amber tint fades, border fades, banner slides up
- All in 200ms, synchronized

**Ghost event creation:**
- Ghost fades in at drop position: `opacity(0) → opacity(1)` + `scale(0.9) → scale(1)` (200ms)
- "DRAFT" label types in (subtle, 150ms fade)
- Sidebar card (if from sidebar): shrinks + fades out (200ms)

**Ghost confirmation:**
- Ghost's dashed border transitions to solid (150ms)
- Ghost's opacity increases to full (150ms)
- "DRAFT" label fades out
- Brief celebratory pulse: `box-shadow` glows then returns to normal (300ms)
- Effectively: ghost morphs into a real event visually before the query refresh replaces it

**Ghost removal:**
- Ghost shrinks + fades: `scale(1) → scale(0.9)` + `opacity(1) → opacity(0)` (200ms)
- If from sidebar: sidebar card fades back in (200ms)

### 12.8 Sidebar Animations

**Section collapse/expand:**
- Content area height animates smoothly (300ms ease-in-out, not instant show/hide)
- Chevron icon rotates 180° (200ms)

**Card drag start:**
- Card scales down slightly: `scale(0.97)` + `opacity(0.4)` (100ms)
- Custom drag image appears at cursor (blue/violet pill with job#/lead#)

**Card removal (after successful drop):**
- Card shrinks + fades out (200ms)
- Remaining cards slide up to fill gap (200ms, staggered by 30ms)

**Empty state appearance:**
- Checkmark + text fades in (200ms) when last card is removed

### 12.9 Tooltip

- Enters: fade in + slight upward slide (150ms, 350ms delay from hover start)
- Exits: instant disappear (no animation — tooltips should vanish cleanly)
- Follows cursor: does NOT animate position (instant repositioning prevents lag feeling)

### 12.10 Modal Dialogs (Confirmation, Conflict, Plan Mode Exit)

**Enter:**
- Backdrop: `opacity(0) → opacity(1)` (200ms)
- Dialog: `scale(0.95) → scale(1)` + `opacity(0) → opacity(1)` (250ms, spring curve)
- Content elements stagger in: icon → title → body → buttons (50ms stagger)

**Exit:**
- Dialog: `scale(1) → scale(0.98)` + `opacity(1) → opacity(0)` (150ms)
- Backdrop: `opacity(1) → opacity(0)` (200ms)

### 12.11 Error & Success Toasts

**Enter:**
- Slide in from bottom-right: `translateY(100%) → translateY(0)` (250ms, ease-out)

**Exit:**
- Slide out: `translateY(0) → translateY(100%)` + fade (200ms)

**Auto-dismiss:** After 5 seconds (with progress bar that depletes, GCal-style)

### 12.12 Search Highlight

When search jumps to an event:
- Calendar navigates to the date (view transition from 12.6)
- Event pulses with blue glow: `box-shadow` animates in and out 3 times over 3 seconds
- Pulse uses `@keyframes`: `0%,100% { box-shadow: 0 0 0 3px rgba(37,99,235,0.5) } 50% { box-shadow: 0 0 0 6px rgba(37,99,235,0.2) }`

### 12.13 Performance Rules

- **Use CSS transitions wherever possible** (not JS animation libraries) — lighter on the main thread
- **`will-change: transform`** on elements that will be animated (events, popups)
- **`transform` and `opacity` only** for most animations (compositor-only, 60fps guaranteed)
- **Never animate `width`, `height`, `top`, `left`** on calendar events — use `transform: translate()` instead
- **Disable animations** during drag operations (event being dragged should NOT have transitions — it must follow the cursor exactly)
- **`prefers-reduced-motion`** media query: reduce all animations to simple fades, disable spring/bounce effects
- **React-big-calendar limitation:** The library controls event positioning internally. Animations on event position changes require intercepting the library's render and applying CSS transitions to the positioned elements via `eventPropGetter` or wrapper components.

---

## 13. Accessibility & Responsive

### Responsive Behavior

- **1920px+:** Full sidebar + calendar + gear dropdown
- **1440px:** Same layout, slightly tighter
- **1366px:** Sidebar visible, toolbar may wrap to 2 lines (acceptable)
- **1024px:** Sidebar hidden (collapsible overlay), calendar full-width
- **<1024px:** Mobile — out of scope for this iteration (Step 7: Technician Mobile)

### Accessibility

- All interactive elements keyboard-reachable
- Escape closes all overlays
- ARIA labels on toolbar buttons
- Color contrast: white text on colored pills meets WCAG AA for all status colors
- Focus indicators on events (`:focus-visible` ring)

---

## 14. What's NOT Changing

These areas passed QA and should be preserved:
- Sidebar collapse/expand mechanics
- Slot popover dismiss behavior (Escape, outside click)
- Cross-entity conflict detection (jobs vs. walkthroughs)
- Search → jump to event with highlight pulse
- Ghost confirm dialog content (Plan Mode)
- Plan Mode exit dialog (Discard/Confirm/Cancel)
- Network failure recovery (optimistic revert + error toast)
- Calendar date range computation logic
- Keyboard shortcuts (keys unchanged, just relocated to settings gear)

---

## 15. Summary of All Changes

### Visual
- [ ] Solid color pill events (replace transparent + left-border)
- [ ] GCal-style toolbar (simplified, settings gear)
- [ ] Violet walkthrough color (replace amber)
- [ ] Amber Plan Mode theme (background tint + banner)
- [ ] GCal-style today indicator (blue circle + red time line)
- [ ] Visible resize handles (white pill on hover)
- [ ] Conflict indicator: subtle border + icon (replace hatch)
- [ ] Remove Open/All toggle
- [ ] Remove right sidebar (move content to settings gear)

### Functional
- [ ] Reschedule confirmation modal (new)
- [ ] Quick-schedule card with search (redesigned empty-slot click)
- [ ] Drag-to-create time range on empty slots (new)
- [ ] Sidebar walkthroughs draggable (REQ-01 fix)
- [ ] Left-click popup with inline actions (redesigned)
- [ ] Right-click simplified to Open Details + Cancel only
- [ ] Consistent interactions across all 5 views

### Bug Fixes
- [ ] P0-04: Walkthrough DnD endpoint fix
- [ ] P0-04b: Backend status guard fix
- [ ] D-01/D-03: Cursor grab/grabbing
- [ ] D-06: Tooltip dismiss during drag
- [ ] D-09: Grid view cards draggable
- [ ] F-09: Grid view accepts sidebar drops
- [ ] V-01: Conflict hatch pattern replaced
- [ ] V-02: Short event text truncation
- [ ] V-06: Resize handle visibility
- [ ] H-13: Plan Mode ghost on existing event drag
- [ ] H-17: Plan Mode persistence fix
- [ ] Member Week: left-click + right-click consistency

---

## 16. Color Change — All Files Requiring Updates

Walkthrough color changes from amber (#F59E0B) to violet (#7c3aed). Every file referencing the old amber walkthrough color must be updated:

| File | What to Change |
|------|---------------|
| `SchedulePage.tsx` (STATUS_STYLES) | `walkthrough` and `walkthrough_completed` entries: amber → violet |
| `SchedulePage.tsx` (LEGEND) | Walkthrough legend entry: amber → violet |
| `SchedulePage.tsx` (sidebar) | Walkthrough section header icon color, badge bg/text |
| `TechnicianGridView.tsx` | JobCard walkthrough color conditions |
| `MemberWeekBoard.tsx` | BoardCard walkthrough color conditions |
| `status-badge.tsx` | `WALKTHROUGH_SCHEDULED` badge: `bg-amber-50 text-amber-700 border-amber-200` → `bg-violet-50 text-violet-700 border-violet-200` |
| `schedule-dark.css` | Any walkthrough-specific CSS (if any) |
| `LeadDetailPage.tsx` | Walkthrough status indicators (if using amber) |

---

## 17. Confirm All — Error Handling

When batch-confirming ghosts via "Confirm All":

1. Ghosts are confirmed sequentially (not parallel — to avoid race conditions on conflict detection)
2. If a ghost fails (e.g., 409 conflict or network error):
   - The failed ghost remains in place (not removed)
   - Processing continues with remaining ghosts
   - After all attempts complete, show a summary toast: "4 of 5 scheduled successfully. 1 conflict — resolve manually."
3. Failed ghosts can be individually right-clicked → "Confirm" (to retry with force) or "Remove"

---

## 18. Deferred Decisions

These items are acknowledged but intentionally deferred to future iterations:

| Item | Decision | Reference |
|------|----------|-----------|
| Completed events movability | Currently locked (not draggable). REQ-02 Decision 3 says "can be moved in future — dev team designs flow." Deferred to Step 10 (Polish). | FINAL_REPORT REQ-02 |
| Sidebar search/filter for large lists | V-05 (P2): No search within sidebar sections for 61+ items. Deferred — quick-schedule card (section 8.2) provides search as an alternative. | FINAL_REPORT V-05 |
| Plan Mode keyboard shortcut | No shortcut assigned for Plan Mode toggle. Can be added later (e.g., "P" key). | — |
| Past event drag confirmation | Past events CAN be dragged per REQ-02. Whether to show a "Send email?" prompt for past-dated events is deferred. Default: `send_email: true` for all drags. | FINAL_REPORT REQ-02 |

---

## 19. Superseded Documentation

This spec supersedes the following sections in older documents:

| Document | Section | What Changes |
|----------|---------|-------------|
| `md_files/plans/walkthrough/walkthrough-spec.md` | Section 7.3 (Event Colors) | Walkthrough amber → violet |
| `md_files/plans/walkthrough/walkthrough-spec.md` | Section 7.6 (Plan Mode) | Plan Mode blue theme → amber theme |
| `md_files/plans/walkthrough/walkthrough-spec.md` | Section 7.4 (Context Menu) | Right-click simplified (this spec section 4.2) |

---

*End of spec. Pending user approval.*
