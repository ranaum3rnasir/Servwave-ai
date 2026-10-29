# Scheduler V2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Redesign the scheduler to look and feel like Google Calendar while fixing all QA-reported bugs and adding reschedule confirmation, quick-schedule, and Plan Mode amber sandbox theme.

**Architecture:** The 2,414-line SchedulePage.tsx gets decomposed — overlay UIs (event popup, context menu, quick-schedule, confirmation dialog, settings gear) are extracted into dedicated components under `components/schedule/`. The CSS is rewritten for GCal-style solid pills. Backend gets a 2-line fix for walkthrough rescheduling. Five work streams run in parallel where possible.

**Tech Stack:** React 18, TypeScript, react-big-calendar + DnD addon, Tailwind CSS, shadcn/ui, TanStack Query, date-fns, Prisma, Express

**Spec:** `md_files/plans/scheduler/scheduler-v2-design-spec.md`

---

## File Structure

### New Files (create)
| File | Responsibility |
|------|---------------|
| `frontend/src/components/schedule/EventDetailPopup.tsx` | Left-click popup: event info + reschedule/reassign actions |
| `frontend/src/components/schedule/RescheduleConfirmDialog.tsx` | Confirmation modal after drag-drop: old→new comparison + email recipients |
| `frontend/src/components/schedule/QuickScheduleCard.tsx` | Empty-slot click/drag: tabbed search card (Jobs \| Walkthroughs) |
| `frontend/src/components/schedule/SettingsGearDropdown.tsx` | Gear icon dropdown: legend, staff filter, keyboard shortcuts |
| `frontend/src/components/schedule/ContextMenu.tsx` | Right-click menu for events (simplified: Open Details + Cancel) |

### Modified Files
| File | Lines | What Changes |
|------|-------|-------------|
| `frontend/src/pages/schedule-dark.css` | 205 | Full rewrite → GCal style (solid pills, grab cursors, resize handles, plan mode amber) |
| `frontend/src/pages/SchedulePage.tsx` | 2414 | Extract overlays to new components, fix walkthrough mutation, remove Open/All toggle, remove right sidebar, add drag confirmation flow, update colors |
| `frontend/src/components/schedule/TechnicianGridView.tsx` | 467 | Make cards draggable, accept sidebar drops, add left-click popup + right-click menu, update colors to violet |
| `frontend/src/components/schedule/MemberWeekBoard.tsx` | 332 | Add left-click popup (currently navigates), add right-click context menu, update colors to violet |
| `frontend/src/hooks/usePlanMode.ts` | 200 | Fix localStorage key persistence (H-17), stable tab-scoped ID |
| `frontend/src/components/jobs/AssignJobDialog.tsx` | 228 | Minor: ensure conflict dialog integrates with new confirmation flow |
| `frontend/src/components/ui/status-badge.tsx` | 45 | Change WALKTHROUGH_SCHEDULED badge from amber to violet |
| `frontend/src/components/schedule/ScheduleSearch.tsx` | 283 | No changes needed — works as-is |
| `backend/src/controllers/lead.controller.ts` | 1116 | 2 lines: add WALKTHROUGH_SCHEDULED to status guard + isReschedule detection |
| `backend/src/__tests__/leads.test.ts` | 2248 | Add tests for walkthrough reschedule from WALKTHROUGH_SCHEDULED status |

---

## Phase 1: Backend Fix (Stream 1)

### Task 1: Fix walkthrough reschedule status guard + email detection

**Files:**
- Modify: `backend/src/controllers/lead.controller.ts:681,767`
- Test: `backend/src/__tests__/leads.test.ts`

- [ ] **Step 1: Write failing test — reschedule from WALKTHROUGH_SCHEDULED**

Add to `leads.test.ts` in the walkthrough scheduling describe block:

```typescript
it('should allow rescheduling a WALKTHROUGH_SCHEDULED lead', async () => {
  prismaMock.lead.findUnique.mockResolvedValue({
    ...mockLead,
    id: 'lead-1',
    status: 'WALKTHROUGH_SCHEDULED',
    walkthrough_scheduled_at: new Date('2026-03-20T10:00:00Z'),
    walkthrough_assigned_to: 'user-tech',
    walkthrough_duration_minutes: 60,
  });
  prismaMock.user.findUnique.mockResolvedValue({
    ...mockUser,
    id: 'user-tech',
    role: 'TECHNICIAN',
    is_active: true,
  });
  prismaMock.lead.update.mockResolvedValue({ ...mockLead, status: 'WALKTHROUGH_SCHEDULED' });
  prismaMock.timelineEvent.create.mockResolvedValue({} as any);

  const res = await request(app)
    .post('/api/leads/lead-1/walkthrough/schedule')
    .set(authHeader())
    .send({
      walkthrough_scheduled_at: '2026-03-21T14:00:00Z',
      walkthrough_assigned_to: 'user-tech',
      walkthrough_duration_minutes: 60,
    });

  expect(res.status).toBe(200);
  // Verify timeline event is WALKTHROUGH_RESCHEDULED (not WALKTHROUGH_SCHEDULED)
  expect(prismaMock.timelineEvent.create).toHaveBeenCalledWith(
    expect.objectContaining({
      data: expect.objectContaining({
        event_type: 'WALKTHROUGH_RESCHEDULED',
      }),
    }),
  );
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && npx vitest run --reporter verbose -- leads.test.ts -t "should allow rescheduling a WALKTHROUGH_SCHEDULED lead"`

Expected: FAIL — status guard rejects WALKTHROUGH_SCHEDULED (400 error)

- [ ] **Step 3: Fix status guard at line 681**

In `backend/src/controllers/lead.controller.ts`, find:
```typescript
if (existing.status !== 'CONTACTED' && existing.status !== 'WALKTHROUGH_COMPLETED') {
```
Replace with:
```typescript
if (existing.status !== 'CONTACTED' && existing.status !== 'WALKTHROUGH_COMPLETED' && existing.status !== 'WALKTHROUGH_SCHEDULED') {
```

- [ ] **Step 4: Fix isReschedule detection at line 767**

Find:
```typescript
const isReschedule = existing.status === 'WALKTHROUGH_COMPLETED';
```
Replace with:
```typescript
const isReschedule = existing.status === 'WALKTHROUGH_COMPLETED' || existing.status === 'WALKTHROUGH_SCHEDULED';
```

- [ ] **Step 5: Run test to verify it passes**

Run: `cd backend && npx vitest run --reporter verbose -- leads.test.ts -t "should allow rescheduling a WALKTHROUGH_SCHEDULED lead"`

Expected: PASS

- [ ] **Step 6: Run full leads test suite**

Run: `cd backend && npx vitest run --reporter verbose -- leads.test.ts`

Expected: All 99+ tests pass (no regressions)

- [ ] **Step 7: Commit**

```bash
cd backend
git add src/controllers/lead.controller.ts src/__tests__/leads.test.ts
git commit -m "fix: allow walkthrough reschedule from WALKTHROUGH_SCHEDULED status"
```

---

## Phase 2: CSS & Visual Overhaul (Stream 2)

### Task 2: Rewrite schedule-dark.css for GCal style

**Files:**
- Modify: `frontend/src/pages/schedule-dark.css`

- [ ] **Step 1: Rewrite the entire CSS file**

Replace the full contents of `schedule-dark.css` with GCal-style overrides. Key changes:
- Events: solid background pills with `border-radius: 6px`, white text, `box-shadow: 0 1px 3px rgba(0,0,0,0.12)`
- Cursors: `.rbc-event { cursor: grab }`, `.rbc-addons-dnd-dragged-event { cursor: grabbing }`, body class `.is-dragging { cursor: grabbing !important }`
- Resize handle: always visible on hover, white pill style (`width: 24px; height: 3px; background: rgba(255,255,255,0.6); border-radius: 2px`), larger 8px hit zone
- Grid: lighter borders (`#dadce0`), time labels `color: #70757a; font-size: 10px`
- Day headers: large date numbers (`font-size: 20px; font-weight: 400`), uppercase abbreviations (`font-size: 9px; letter-spacing: 0.5px`)
- Today: blue circle on date number (`.rbc-now`), current time line `#ea4335` with red dot
- Plan Mode: `.schedule-cal.plan-mode-active` class for amber tint background + dashed border
- Selection: `rgba(37,99,235,0.08)` for slot selection
- DnD preview: solid color (not just opacity reduction)
- Conflict: remove old hatch pattern, use border + icon approach
- Transitions: `transition: all 0.15s ease-out` on events for smooth state changes
- Search highlight keyframes (keep existing)
- `@media (prefers-reduced-motion: reduce)` — disable animations

The full CSS should be ~250-300 lines. Reference spec section 9.

- [ ] **Step 2: Verify in browser**

Run dev servers, open `/schedule`, visually verify:
- Events show as solid colored pills
- Cursor changes to grab on hover
- Resize handle visible on event hover
- Grid lines lighter, day headers larger
- Today column has blue tint

- [ ] **Step 3: Commit**

```bash
git add frontend/src/pages/schedule-dark.css
git commit -m "style: rewrite schedule CSS for Google Calendar look"
```

### Task 3: Update color system — walkthrough amber → violet

**Files:**
- Modify: `frontend/src/pages/SchedulePage.tsx` (STATUS_STYLES, LEGEND, sidebar)
- Modify: `frontend/src/components/schedule/TechnicianGridView.tsx`
- Modify: `frontend/src/components/schedule/MemberWeekBoard.tsx`
- Modify: `frontend/src/components/ui/status-badge.tsx`

- [ ] **Step 1: Update SchedulePage.tsx STATUS_STYLES and LEGEND**

In `STATUS_STYLES` constant (~line 131), change walkthrough entries:
```typescript
walkthrough: { background: '#7c3aed', borderRadius: '6px', color: '#fff' },
walkthrough_completed: { background: '#9aa0a6', borderRadius: '6px', color: '#fff' },
```

In `LEGEND` constant (~line 142), update:
```typescript
{ label: 'Walkthrough', color: '#7c3aed', bg: '#7c3aed' },
```

Update all event styling in `eventStyleGetter` to use solid backgrounds (no more `rgba` + `borderLeft` pattern).

In the sidebar walkthrough section (~line 1198-1260), change amber references to violet:
- Header icon: `text-amber-600` → `text-violet-600`
- Badge: `bg-amber-50 text-amber-700` → `bg-violet-50 text-violet-700`
- Card hover: `hover:border-amber-300` → `hover:border-violet-300`
- Lead number: `text-amber-600` → `text-violet-600`

- [ ] **Step 2: Update TechnicianGridView.tsx colors**

Find all amber/walkthrough color references in JobCard component and update to violet equivalents.

- [ ] **Step 3: Update MemberWeekBoard.tsx colors**

Find all amber/walkthrough color references in BoardCard component and update to violet equivalents.

- [ ] **Step 4: Update status-badge.tsx**

Change WALKTHROUGH_SCHEDULED badge from `bg-amber-50 text-amber-700 border-amber-200` to `bg-violet-50 text-violet-700 border-violet-200`.

- [ ] **Step 5: Verify in browser**

Check schedule page, TechnicianGridView, MemberWeekBoard — all walkthrough events should be violet. Sidebar walkthrough section should be violet-accented.

- [ ] **Step 6: Commit**

```bash
git add frontend/src/pages/SchedulePage.tsx frontend/src/components/schedule/TechnicianGridView.tsx frontend/src/components/schedule/MemberWeekBoard.tsx frontend/src/components/ui/status-badge.tsx
git commit -m "style: change walkthrough color from amber to violet"
```

### Task 4: Update event pill styling in eventStyleGetter

**Files:**
- Modify: `frontend/src/pages/SchedulePage.tsx` (eventStyleGetter function, ~line 813-868)

- [ ] **Step 1: Rewrite STATUS_STYLES to solid GCal pills**

Replace the entire STATUS_STYLES constant:
```typescript
const STATUS_STYLES: Record<string, React.CSSProperties> = {
  SCHEDULED:   { background: '#039be5', borderRadius: '6px', color: '#fff' },
  IN_PROGRESS: { background: '#039be5', borderRadius: '6px', color: '#fff' },
  COMPLETED:   { background: '#9aa0a6', borderRadius: '6px', color: '#fff' },
  walkthrough: { background: '#7c3aed', borderRadius: '6px', color: '#fff' },
  walkthrough_completed: { background: '#9aa0a6', borderRadius: '6px', color: '#fff' },
  urgent:      { background: '#d93025', borderRadius: '6px', color: '#fff' },
};
```

- [ ] **Step 2: Update eventStyleGetter to apply solid pill styles**

Rewrite to return:
```typescript
return {
  style: {
    ...style,
    borderRadius: '6px',
    padding: '4px 8px',
    border: 'none',
    boxShadow: '0 1px 3px rgba(0,0,0,0.12)',
    cursor: completed ? 'default' : 'grab',
    ...(completed && { opacity: 0.6 }),
    ...(isHighlighted && {
      boxShadow: '0 0 0 3px rgba(37,99,235,0.5)',
      animation: 'search-highlight 1.5s ease-in-out infinite',
      zIndex: 10,
    }),
  },
};
```

For conflicts, use a subtle red left border + normal styling (no hatch pattern):
```typescript
if (conflictingEventIds.has(event.id)) {
  const baseStyle = event.type === 'walkthrough' ? STATUS_STYLES.walkthrough : STATUS_STYLES.SCHEDULED;
  return {
    style: {
      ...baseStyle,
      borderLeft: '4px solid #ef4444',
      borderRadius: '0 6px 6px 0',
      // ... rest of common styles
    },
  };
}
```

- [ ] **Step 3: Remove CANCELLED from scheduled jobs query**

In the `scheduledJobs` query (~line 632), change:
```typescript
status: ['SCHEDULED', 'IN_PROGRESS', 'COMPLETED', 'CANCELLED'],
```
to:
```typescript
status: ['SCHEDULED', 'IN_PROGRESS', 'COMPLETED'],
```

- [ ] **Step 4: Remove Open/All toggle from toolbar**

Delete the Open/All toggle button group (~lines 1444-1462). Remove `showCompleted` state variable and all references. Remove the `allEventsBase` filter that uses `showCompleted` — always show all non-cancelled events.

- [ ] **Step 5: Remove right sidebar**

Delete the right sidebar section (~lines 1675-1732). Delete `rightSidebarOpen` state. Delete the toggle button in the toolbar.

- [ ] **Step 6: Verify in browser**

- Events are solid colored pills with shadows
- No hatch pattern on conflicts (just red left border + ⚠️ icon)
- No Open/All toggle
- No right sidebar
- Cancelled events not shown

- [ ] **Step 7: Commit**

```bash
git add frontend/src/pages/SchedulePage.tsx
git commit -m "feat: solid GCal pill events, remove cancelled, remove Open/All toggle and right sidebar"
```

---

## Phase 3: Extract Components from SchedulePage (Stream 4)

### Task 5: Extract EventDetailPopup component

**Files:**
- Create: `frontend/src/components/schedule/EventDetailPopup.tsx`
- Modify: `frontend/src/pages/SchedulePage.tsx`

- [ ] **Step 1: Create EventDetailPopup.tsx**

Extract the `selectedEvent` popup JSX (currently ~lines 1800-1900 in SchedulePage) into a dedicated component. Props:

```typescript
interface EventDetailPopupProps {
  event: CalendarEvent;
  x: number;
  y: number;
  onClose: () => void;
  onReschedule: (event: CalendarEvent) => void;
  onReassign: (event: CalendarEvent) => void;
  onNavigate: (url: string) => void;
}
```

Add "Reschedule" and "Reassign" action buttons in the footer alongside "View Job/Lead →".

- [ ] **Step 2: Replace inline JSX in SchedulePage with component**

Replace the `{selectedEvent && ...}` block with:
```tsx
{selectedEvent && (
  <EventDetailPopup
    event={selectedEvent.event}
    x={selectedEvent.x}
    y={selectedEvent.y}
    onClose={() => setSelectedEvent(null)}
    onReschedule={(e) => { setSelectedEvent(null); setAssignDialog({ open: true, jobId: e.id }); }}
    onReassign={(e) => { setSelectedEvent(null); setAssignDialog({ open: true, jobId: e.id }); }}
    onNavigate={(url) => { setSelectedEvent(null); navigate(url); }}
  />
)}
```

- [ ] **Step 3: Verify left-click popup works**

Click on an event → popup shows with info + action buttons. Click "Reschedule" → opens assign dialog. Click X → closes.

- [ ] **Step 4: Commit**

```bash
git add frontend/src/components/schedule/EventDetailPopup.tsx frontend/src/pages/SchedulePage.tsx
git commit -m "refactor: extract EventDetailPopup from SchedulePage"
```

### Task 6: Extract ContextMenu component

**Files:**
- Create: `frontend/src/components/schedule/ContextMenu.tsx`
- Modify: `frontend/src/pages/SchedulePage.tsx`

- [ ] **Step 1: Create ContextMenu.tsx**

Extract the right-click context menu JSX. Simplify to only:
- "Open Details" (navigates to Job/Lead detail page)
- Separator
- "Cancel Job" (jobs only) or "Cancel Walkthrough" (walkthroughs only)

Props:
```typescript
interface ScheduleContextMenuProps {
  event: CalendarEvent;
  x: number;
  y: number;
  onClose: () => void;
  onOpenDetails: (event: CalendarEvent) => void;
  onCancel: (event: CalendarEvent) => void;
}
```

- [ ] **Step 2: Replace inline JSX in SchedulePage**

- [ ] **Step 3: Verify right-click shows simplified menu**

- [ ] **Step 4: Commit**

```bash
git add frontend/src/components/schedule/ContextMenu.tsx frontend/src/pages/SchedulePage.tsx
git commit -m "refactor: extract ContextMenu from SchedulePage, simplify to Open Details + Cancel"
```

### Task 7: Create RescheduleConfirmDialog component

**Files:**
- Create: `frontend/src/components/schedule/RescheduleConfirmDialog.tsx`

- [ ] **Step 1: Create the component**

This is a NEW component (not extracted — doesn't exist yet). Shows when dragging an existing event:

Props:
```typescript
interface RescheduleConfirmDialogProps {
  open: boolean;
  event: CalendarEvent;
  oldStart: Date;
  oldEnd: Date;
  newStart: Date;
  newEnd: Date;
  oldTechName?: string;
  newTechName?: string;
  emailRecipients: string[];
  onConfirm: () => void;
  onCancel: () => void;
  isLoading?: boolean;
}
```

Layout per spec section 8.1:
- Header: icon + "Reschedule Job/Walkthrough?" + number
- FROM → TO comparison panel
- Email recipients amber banner
- Cancel + "Confirm & Notify" buttons

Use existing shadcn Dialog component as base. Apply animations from spec section 12.10 (scale-in + stagger).

- [ ] **Step 2: Verify renders correctly in isolation**

Temporarily render with test props to verify layout.

- [ ] **Step 3: Commit**

```bash
git add frontend/src/components/schedule/RescheduleConfirmDialog.tsx
git commit -m "feat: create RescheduleConfirmDialog component"
```

### Task 8: Create QuickScheduleCard component

**Files:**
- Create: `frontend/src/components/schedule/QuickScheduleCard.tsx`

- [ ] **Step 1: Create the component**

Floating card for empty-slot click/drag-select. Per spec section 8.2:

Props:
```typescript
interface QuickScheduleCardProps {
  x: number;
  y: number;
  startTime: string;
  endTime: string;
  unassignedJobs: Record<string, unknown>[];
  unscheduledWalkthroughs: Record<string, unknown>[];
  onSelectJob: (jobId: string) => void;
  onSelectWalkthrough: (leadId: string) => void;
  onClose: () => void;
}
```

Layout:
- Header: "Schedule" + formatted time + X close
- Tab bar: "Jobs" | "Walkthroughs" (use simple state toggle, not shadcn Tabs — keep it lightweight)
- Search input at top
- Results list: filtered by search query, max 5 visible, scrollable
- Click item → calls `onSelectJob`/`onSelectWalkthrough`

- [ ] **Step 2: Verify renders correctly**

- [ ] **Step 3: Commit**

```bash
git add frontend/src/components/schedule/QuickScheduleCard.tsx
git commit -m "feat: create QuickScheduleCard for empty slot click"
```

### Task 9: Create SettingsGearDropdown component

**Files:**
- Create: `frontend/src/components/schedule/SettingsGearDropdown.tsx`

- [ ] **Step 1: Create the component**

Per spec section 8.3. Uses shadcn Popover.

Props:
```typescript
interface SettingsGearDropdownProps {
  roleFilter: string;
  onRoleFilterChange: (value: string) => void;
  isGroupedView: boolean;
}
```

Sections:
1. **Legend** — color swatches: Scheduled (blue), Urgent (red), Walkthrough (violet), Completed (gray), Conflict (red border)
2. **Staff Filter** — radio buttons: All / Technicians / Sales (only shown when `isGroupedView`)
3. **Keyboard Shortcuts** — key → action pairs

- [ ] **Step 2: Wire into SchedulePage toolbar**

Replace right sidebar toggle and inline staff filter dropdown with `<SettingsGearDropdown />`.

- [ ] **Step 3: Verify gear dropdown opens/closes, filter works**

- [ ] **Step 4: Commit**

```bash
git add frontend/src/components/schedule/SettingsGearDropdown.tsx frontend/src/pages/SchedulePage.tsx
git commit -m "feat: create SettingsGearDropdown, move legend + filter from sidebar"
```

---

## Phase 4: Core DnD Fixes (Stream 3)

### Task 10: Fix walkthrough mutation endpoint (P0-04)

**Files:**
- Modify: `frontend/src/pages/SchedulePage.tsx` (~lines 946-979, 1043-1044, 1074-1075)

- [ ] **Step 1: Expand mutation type and fix endpoint URL**

Find the `walkthroughRescheduleMutation` (~line 946). Change:

```typescript
// Type: expand payload
useMutation<
  unknown,
  unknown,
  { leadId: string; newStart: string; performerId: string; durationMinutes: number; force?: boolean },
  { previous?: Record<string, unknown>[] }
>({
  mutationFn: async (payload) => {
    await api.post(`/api/leads/${payload.leadId}/walkthrough/schedule`, {
      walkthrough_scheduled_at: payload.newStart,
      walkthrough_assigned_to: payload.performerId,
      walkthrough_duration_minutes: payload.durationMinutes,
      force: payload.force ?? false,
    });
  },
```

- [ ] **Step 2: Update call sites in handleEventDrop and handleEventResize**

In `handleEventDrop` (~line 1043):
```typescript
} else if (event.type === 'walkthrough') {
  const performer = event.raw.assigned_user as { id: string } | null;
  const duration = (event.raw.walkthrough_duration_minutes as number | null) ?? 60;
  walkthroughRescheduleMutation.mutate({
    leadId: event.raw.id as string,
    newStart: startDate.toISOString(),
    performerId: performer?.id ?? '',
    durationMinutes: duration,
  });
}
```

Same pattern in `handleEventResize` (~line 1074).

- [ ] **Step 3: Verify walkthrough drag persists**

Drag a walkthrough event to a new time. Refresh page. Event should stay at new position.

- [ ] **Step 4: Commit**

```bash
git add frontend/src/pages/SchedulePage.tsx
git commit -m "fix(P0-04): walkthrough DnD uses correct endpoint with full payload"
```

### Task 11: Wire RescheduleConfirmDialog into drag flow

**Files:**
- Modify: `frontend/src/pages/SchedulePage.tsx`

- [ ] **Step 1: Add reschedule confirmation state**

Add state:
```typescript
const [rescheduleConfirm, setRescheduleConfirm] = useState<{
  event: CalendarEvent;
  oldStart: Date;
  oldEnd: Date;
  newStart: Date;
  newEnd: Date;
  newTechId?: string;
} | null>(null);
```

- [ ] **Step 2: Modify handleEventDrop to show confirmation instead of direct mutation**

Instead of immediately calling `assignMutation.mutate(...)`, store the pending action and show the confirmation dialog:

```typescript
// In handleEventDrop, for jobs:
setRescheduleConfirm({
  event,
  oldStart: event.start,
  oldEnd: event.end,
  newStart: startDate,
  newEnd: endDate,
  newTechId: assignedTo,
});
```

**Important: Optimistic position handling.** When the dialog appears, the event visually snaps back to its original position (react-big-calendar re-renders from the `events` array). To keep the event at the new position during the dialog:
1. Temporarily add a local state override: `pendingMove: { eventId, newStart, newEnd, newTechId }`
2. In the `allEvents` memo, if `pendingMove` matches an event, override its `start`/`end`/`resourceId` with the pending values
3. On confirm: fire the mutation (which has its own optimistic update via `onMutate`), clear `pendingMove`
4. On cancel: clear `pendingMove` (event snaps back to original from query data)

- [ ] **Step 3: Render RescheduleConfirmDialog**

Add to the JSX:
```tsx
{rescheduleConfirm && (
  <RescheduleConfirmDialog
    open={true}
    event={rescheduleConfirm.event}
    oldStart={rescheduleConfirm.oldStart}
    oldEnd={rescheduleConfirm.oldEnd}
    newStart={rescheduleConfirm.newStart}
    newEnd={rescheduleConfirm.newEnd}
    oldTechName={/* resolve from allStaff */}
    newTechName={/* resolve from allStaff */}
    emailRecipients={/* build from event data */}
    onConfirm={() => { /* fire mutation, clear state */ }}
    onCancel={() => { setRescheduleConfirm(null); queryClient.invalidateQueries(...); }}
    isLoading={assignMutation.isPending}
  />
)}
```

- [ ] **Step 4: Test drag → confirm → event moves**

- [ ] **Step 5: Test drag → cancel → event reverts**

- [ ] **Step 6: Commit**

```bash
git add frontend/src/pages/SchedulePage.tsx
git commit -m "feat: wire RescheduleConfirmDialog into event drag flow"
```

### Task 12: Make sidebar walkthroughs draggable (REQ-01)

**Files:**
- Modify: `frontend/src/pages/SchedulePage.tsx` (~lines 1220-1260)

- [ ] **Step 1: Add draggable attributes to walkthrough cards**

Mirror the job card drag pattern. On the walkthrough card `<div>`:

```tsx
draggable
onDragStart={(e) => {
  draggingJobIdRef.current = `wt-${lead.id as string}`;
  setDraggingSidebarId(`wt-${lead.id as string}`);
  e.dataTransfer.setData('walkthrough-id', lead.id as string);
  e.dataTransfer.effectAllowed = 'move';
  // Create violet drag ghost
  const ghost = document.createElement('div');
  ghost.textContent = lead.lead_number as string;
  ghost.style.cssText =
    'position:fixed;top:-100px;background:#7c3aed;color:#fff;' +
    'padding:4px 10px;border-radius:4px;font-size:12px;font-weight:600;white-space:nowrap;';
  document.body.appendChild(ghost);
  e.dataTransfer.setDragImage(ghost, ghost.offsetWidth / 2, 12);
  requestAnimationFrame(() => {
    if (document.body.contains(ghost)) document.body.removeChild(ghost);
  });
}}
onDragEnd={() => {
  draggingJobIdRef.current = null;
  setDraggingSidebarId(null);
}}
```

- [ ] **Step 2: Update handleDropFromOutside to handle walkthrough drops**

Check if the dropped ID starts with `wt-` and handle accordingly — open a walkthrough schedule dialog instead of AssignJobDialog.

- [ ] **Step 3: Update dragFromOutsideItem to support walkthrough preview**

The `dragFromOutsideItem` callback should return a preview for walkthrough drags too.

- [ ] **Step 4: Test drag walkthrough from sidebar to calendar**

- [ ] **Step 5: Commit**

```bash
git add frontend/src/pages/SchedulePage.tsx
git commit -m "feat(REQ-01): make sidebar walkthroughs draggable to calendar"
```

### Task 13: Fix TechnicianGridView DnD (D-09, F-09)

**Files:**
- Modify: `frontend/src/components/schedule/TechnicianGridView.tsx`

- [ ] **Step 1: Make JobCard/WalkthroughCard draggable**

Add `draggable` attribute to the card wrapper div in the JobCard component. Add `onDragStart`/`onDragEnd` handlers that set data transfer and visual state.

- [ ] **Step 2: Fix drop zones to accept sidebar external drags**

The hourly drop zones (`onDragOver`, `onDrop`) need to accept both internal card reorder drags AND external sidebar drags. Check `e.dataTransfer.types` for `job-id` or `walkthrough-id`.

- [ ] **Step 3: Add left-click → EventDetailPopup**

Currently `onSelectJob` navigates. Change to open EventDetailPopup instead (pass event data up to SchedulePage via a new callback prop).

- [ ] **Step 4: Add right-click → ContextMenu**

Add `onContextMenu` handler to cards that calls a new `onEventContextMenu` prop.

- [ ] **Step 5: Test grid view DnD + click interactions**

- [ ] **Step 6: Commit**

```bash
git add frontend/src/components/schedule/TechnicianGridView.tsx
git commit -m "fix(D-09,F-09): make grid view cards draggable, accept sidebar drops, add click menus"
```

### Task 14: Fix MemberWeekBoard consistency

**Files:**
- Modify: `frontend/src/components/schedule/MemberWeekBoard.tsx`

- [ ] **Step 1: Add left-click → EventDetailPopup**

Currently the `onSelectEvent` prop navigates to the job detail page. Change to call a new `onEventClick` prop that passes event + click coordinates, so SchedulePage can show the EventDetailPopup.

- [ ] **Step 2: Add right-click → ContextMenu**

Add `onContextMenu` handler to BoardCard that calls `onEventContextMenu` prop.

- [ ] **Step 3: Test Member Week click interactions match Standard view**

- [ ] **Step 4: Commit**

```bash
git add frontend/src/components/schedule/MemberWeekBoard.tsx
git commit -m "fix: MemberWeekBoard left-click popup + right-click context menu for consistency"
```

---

## Phase 5: Plan Mode & Persistence (Stream 5)

### Task 15: Fix Plan Mode localStorage persistence (H-17)

**Files:**
- Modify: `frontend/src/hooks/usePlanMode.ts`

- [ ] **Step 1: Replace SESSION_ID generation with stable tab-scoped key**

Find the current `SESSION_ID` generation (~line 44):
```typescript
const SESSION_ID = crypto.randomUUID();
```

Replace with:
```typescript
function getOrCreateTabId(): string {
  let tabId = sessionStorage.getItem('plan-mode-tab-id');
  if (!tabId) {
    tabId = crypto.randomUUID();
    sessionStorage.setItem('plan-mode-tab-id', tabId);
  }
  return tabId;
}
const TAB_ID = getOrCreateTabId();
const STORAGE_KEY = `plan-mode-${TAB_ID}`;
```

Update all `localStorage.getItem`/`setItem` calls to use `STORAGE_KEY` instead of the session-scoped key.

- [ ] **Step 2: Add cleanup for orphaned entries**

Add cleanup on `beforeunload` (not on module load — that would break multi-tab):
```typescript
// Clean up this tab's localStorage entry when tab closes
window.addEventListener('beforeunload', () => {
  if (!planModeActive) {
    localStorage.removeItem(STORAGE_KEY);
  }
});
```

Also add a timestamp-based staleness check on load — remove entries older than 24 hours:
```typescript
// On load: clean up stale entries (older than 24h) from closed tabs
for (let i = localStorage.length - 1; i >= 0; i--) {
  const key = localStorage.key(i);
  if (key?.startsWith('plan-mode-') && key !== STORAGE_KEY) {
    try {
      const data = JSON.parse(localStorage.getItem(key) ?? '{}');
      if (data.updatedAt && Date.now() - data.updatedAt > 24 * 60 * 60 * 1000) {
        localStorage.removeItem(key);
      }
    } catch { localStorage.removeItem(key); }
  }
}
```

- [ ] **Step 3: Verify ghosts survive page refresh**

Activate Plan Mode → drag a sidebar item → refresh page → ghosts should still be there.

- [ ] **Step 4: Commit**

```bash
git add frontend/src/hooks/usePlanMode.ts
git commit -m "fix(H-17): stable localStorage key for Plan Mode persistence across refresh"
```

### Task 16: Fix Plan Mode existing event drag (H-13)

**Files:**
- Modify: `frontend/src/pages/SchedulePage.tsx` (handleEventDrop, ~line 1006)

- [ ] **Step 1: Add Plan Mode check in handleEventDrop**

At the top of the `handleEventDrop` function, after the completed-event guard, add:

```typescript
// Plan Mode: create ghost instead of live mutation
if (planMode.isActive && !event.isGhost) {
  const customer = event.raw.customer as { first_name: string; last_name: string } | null;
  const location = event.raw.service_location as { address_line1?: string; city?: string; state?: string } | null;
  const customerName = customer ? `${customer.first_name} ${customer.last_name}` : 'Unknown';
  const address = location ? [location.address_line1, location.city, location.state].filter(Boolean).join(', ') : '';
  const techId = isGroupedView && resourceId ? resourceId : (event.raw.assigned_user as { id: string } | null)?.id;

  planMode.addGhost({
    sourceId: event.type === 'job' ? event.id : (event.raw.id as string),
    sourceType: event.type,
    isFromSidebar: false,
    isMovedConfirmed: false,
    start: startDate.toISOString(),
    end: endDate.toISOString(),
    resourceId: techId,
    title: event.title,
    customerName,
    address,
    raw: event.raw,
  });
  return;
}
```

- [ ] **Step 2: Same check in handleEventResize**

Add equivalent Plan Mode guard to `handleEventResize`.

- [ ] **Step 3: Test Plan Mode drag creates ghost, not live mutation**

Activate Plan Mode → drag an existing event → should create ghost at new position, NOT call API.

- [ ] **Step 4: Commit**

```bash
git add frontend/src/pages/SchedulePage.tsx
git commit -m "fix(H-13): Plan Mode creates ghost on existing event drag instead of live API call"
```

### Task 17: Plan Mode amber sandbox visual theme

**Files:**
- Modify: `frontend/src/pages/SchedulePage.tsx` (Plan Mode banner + calendar container)

- [ ] **Step 1: Update Plan Mode banner to amber gradient**

Replace the current blue info banner with the amber gradient banner from spec section 5:

```tsx
{planMode.isActive && (
  <div className="flex items-center justify-between gap-3 px-4 py-2.5 border-b-2 border-amber-500 shrink-0"
       style={{ background: 'linear-gradient(135deg, #78350f, #d97706)' }}>
    <div className="flex items-center gap-2.5 text-white text-sm font-medium">
      <span className="relative flex h-2.5 w-2.5">
        <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-amber-300 opacity-75" />
        <span className="relative inline-flex rounded-full h-2.5 w-2.5 bg-amber-300" />
      </span>
      Plan Mode
      <span className="text-amber-200 font-normal">— {planMode.ghostCount} draft{planMode.ghostCount !== 1 ? 's' : ''}</span>
    </div>
    {/* Discard All + Confirm All buttons in white */}
  </div>
)}
```

- [ ] **Step 2: Add plan-mode-active class to calendar container**

Update the calendar container div to conditionally apply the CSS class:

```tsx
<div className={`flex-1 relative min-h-0 schedule-cal overflow-hidden ${planMode.isActive ? 'plan-mode-active' : ''}`}>
```

The `plan-mode-active` CSS class (from Task 2) applies amber background tint + dashed border.

- [ ] **Step 3: Update Plan Mode toggle button to amber style**

Change the toggle button styling when active:
```tsx
className={`... ${planMode.isActive
  ? 'bg-amber-600 text-white border-amber-600 shadow-sm'
  : 'bg-white text-text-secondary border-border hover:text-text-primary hover:border-amber-400'
}`}
```

- [ ] **Step 4: Verify Plan Mode visual transformation**

Toggle Plan Mode on → banner appears (amber gradient), calendar gets tinted background, button changes. Toggle off → everything reverts smoothly.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/pages/SchedulePage.tsx
git commit -m "feat: Plan Mode amber sandbox theme with gradient banner and background tint"
```

### Task 17b: Ghost context menu + Plan Mode exit behavior (GAP-8, GAP-9)

**Files:**
- Modify: `frontend/src/pages/SchedulePage.tsx`

Ghost right-click menu ("Confirm" / "Remove") already exists in the codebase (~line 2150). Verify it still works with the new ContextMenu extraction. The existing `ghostContextMenu` state + `handleGhostContextMenu` callback are preserved.

Plan Mode exit behavior (warning dialog with Discard/Confirm/Cancel) also already exists (~line 2200). Verify it works with the amber theme. The existing `showExitDialog` state + `beforeunload` handler are preserved.

- [ ] **Step 1: Verify ghost context menu works with new component structure**

Right-click a ghost → "Confirm" and "Remove" options should appear. Confirm → fires API. Remove → deletes ghost.

- [ ] **Step 2: Verify Plan Mode exit dialog works**

Toggle Plan Mode off with active ghosts → warning dialog with 3 options. Test each: Discard & Exit, Confirm All & Exit, Cancel.

- [ ] **Step 3: Add Confirm All error handling (spec section 17)**

Modify `handleConfirmAllGhosts` to continue on failure:
```typescript
const handleConfirmAllGhosts = useCallback(async () => {
  const visible = planMode.getGhostsForView(dateRange.start, dateRange.end);
  let succeeded = 0;
  let failed = 0;
  for (const ghost of visible) {
    try {
      await handleConfirmGhost(ghost.id);
      succeeded++;
    } catch {
      failed++;
    }
  }
  setShowConfirmAllDialog(false);
  if (failed > 0) {
    setErrorToast(`${succeeded} of ${succeeded + failed} scheduled. ${failed} failed — resolve manually.`);
  }
}, [planMode, dateRange, handleConfirmGhost]);
```

- [ ] **Step 4: Commit**

```bash
git add frontend/src/pages/SchedulePage.tsx
git commit -m "feat: verify ghost context menu, exit dialog, add Confirm All error handling"
```

---

## Phase 5b: Walkthrough Drop Handling (completes REQ-01)

### Task 17c: Complete handleDropFromOutside for walkthrough drops (GAP-3)

**Files:**
- Modify: `frontend/src/pages/SchedulePage.tsx` (handleDropFromOutside, ~line 1081)

- [ ] **Step 1: Detect walkthrough drops in handleDropFromOutside**

The current `handleDropFromOutside` only handles job IDs. Add walkthrough detection:

```typescript
const handleDropFromOutside = useCallback(
  ({ start, end, resource }: { start: Date | string; end: Date | string; resource?: string }) => {
    const rawId = draggingJobIdRef.current;
    if (!rawId) return;
    draggingJobIdRef.current = null;

    const startDate = start instanceof Date ? start : new Date(start);
    const endDate = end instanceof Date ? end : new Date(end);

    const isWalkthrough = rawId.startsWith('wt-');
    const actualId = isWalkthrough ? rawId.slice(3) : rawId;

    if (isWalkthrough) {
      const lead = (unscheduledWalkthroughs ?? []).find((l) => (l.id as string) === actualId);
      if (!lead) return;

      if (planMode.isActive) {
        // Create walkthrough ghost
        const customer = lead.customer as { first_name: string; last_name: string } | null;
        const customerName = customer ? `${customer.first_name} ${customer.last_name}` : 'Unknown';
        const addr = [lead.service_address_line1, lead.service_city, lead.service_state].filter(Boolean).join(', ');
        const techId = isGroupedView && resource ? resource : undefined;
        planMode.addGhost({
          sourceId: actualId,
          sourceType: 'walkthrough',
          isFromSidebar: true,
          isMovedConfirmed: false,
          start: startDate.toISOString(),
          end: endDate.toISOString(),
          resourceId: techId,
          title: `Walkthrough — ${customerName}`,
          customerName,
          address: addr,
          raw: lead,
        });
        return;
      }

      // Open walkthrough schedule flow
      // For Member Day view with resource: direct schedule
      // For Standard view: open a schedule dialog
      const techId = isGroupedView && resource ? resource : undefined;
      walkthroughRescheduleMutation.mutate({
        leadId: actualId,
        newStart: startDate.toISOString(),
        performerId: techId ?? '',
        durationMinutes: 60,
      });
      return;
    }

    // ... existing job handling (keep as-is) ...
  },
  [isGroupedView, planMode, unassignedJobs, unscheduledWalkthroughs, walkthroughRescheduleMutation],
);
```

- [ ] **Step 2: Test walkthrough sidebar drag to Standard view**

Drag walkthrough card → drop on calendar → should schedule walkthrough at drop time.

- [ ] **Step 3: Test walkthrough sidebar drag to Member Day view**

Drag walkthrough card → drop on tech column → should schedule with that tech + time.

- [ ] **Step 4: Test walkthrough sidebar drag in Plan Mode**

Plan Mode active → drag walkthrough → ghost created (violet dashed border, DRAFT label).

- [ ] **Step 5: Commit**

```bash
git add frontend/src/pages/SchedulePage.tsx
git commit -m "feat(REQ-01): complete walkthrough drop handling in handleDropFromOutside"
```

---

## Phase 6: Integration & Polish

### Task 18: Wire QuickScheduleCard into empty slot click + drag-select (GAP-1)

**Files:**
- Modify: `frontend/src/pages/SchedulePage.tsx`

- [ ] **Step 1: Replace slotPopover with QuickScheduleCard**

Replace the existing slot popover JSX with the new `QuickScheduleCard` component. Wire `handleSelectSlot` to set state for QuickScheduleCard instead.

- [ ] **Step 2: Wire drag-select time range (spec section 4.4)**

react-big-calendar's `onSelectSlot` already fires for both click AND drag-select (with `start` and `end` representing the range). The existing `handleSelectSlot` captures both. Ensure the `QuickScheduleCard` receives the full range when a drag-select occurs. The `selectable` prop is already set on DnDCalendar.

Test: click-drag across 2 hours of empty slots → QuickScheduleCard appears with "9:00 AM – 11:00 AM" pre-filled.

- [ ] **Step 3: Verify single-click and drag-select both work**

- Single click empty slot → card shows with 30-min default range
- Drag-select across 2 hours → card shows with 2-hour range
- Search works, clicking an item opens assign dialog with time pre-filled

- [ ] **Step 4: Commit**

```bash
git add frontend/src/pages/SchedulePage.tsx
git commit -m "feat: wire QuickScheduleCard into empty slot click + drag-select"
```

### Task 19: Tooltip dismiss during drag (D-06) + cursor feedback

**Files:**
- Modify: `frontend/src/pages/SchedulePage.tsx`

- [ ] **Step 1: Dismiss tooltip when drag starts**

At the top of `handleEventDrop` and `handleEventResize`, add:
```typescript
if (tooltipTimerRef.current) clearTimeout(tooltipTimerRef.current);
setEventTooltip(null);
setSelectedEvent(null);
```

- [ ] **Step 2: Add body cursor class during drag**

In the DnDCalendar's drag callbacks, toggle a class on `document.body`:
```typescript
// On drag start (via onDragStart on DnDCalendar if available, or via CSS)
document.body.classList.add('is-dragging');
// On drag end
document.body.classList.remove('is-dragging');
```

The CSS (from Task 2) handles: `.is-dragging { cursor: grabbing !important; }`

- [ ] **Step 3: Commit**

```bash
git add frontend/src/pages/SchedulePage.tsx
git commit -m "fix(D-06): dismiss tooltip during drag, add grabbing cursor class"
```

### Task 20: Final integration test

- [ ] **Step 1: Run backend tests**

```bash
cd backend && npx vitest run
```

Expected: All tests pass (441+)

- [ ] **Step 2: Run TypeScript check**

```bash
cd frontend && npx tsc --noEmit
```

Expected: No type errors

- [ ] **Step 3: Manual browser verification checklist**

Open `/schedule` and verify each interaction:

| # | Check | Pass? |
|---|-------|-------|
| 1 | Events are solid colored pills (blue/red/violet/gray) | |
| 2 | Walkthrough events are violet (not amber) | |
| 3 | Cancelled events not shown | |
| 4 | No Open/All toggle in toolbar | |
| 5 | No right sidebar | |
| 6 | Settings gear opens legend + shortcuts | |
| 7 | Left-click event → detail popup with actions | |
| 8 | Right-click event → Open Details + Cancel only | |
| 9 | Click empty slot → QuickScheduleCard with search | |
| 10 | Drag job event → RescheduleConfirmDialog | |
| 11 | Drag walkthrough event → same confirm dialog | |
| 12 | Walkthrough drag persists after refresh | |
| 13 | Sidebar walkthrough cards draggable | |
| 14 | Sidebar job cards draggable (still works) | |
| 15 | cursor:grab on event hover | |
| 16 | cursor:grabbing during drag | |
| 17 | Resize handle visible on hover | |
| 18 | Plan Mode → amber theme (banner + background) | |
| 19 | Plan Mode → drag creates ghost (not live API) | |
| 20 | Plan Mode → ghosts survive refresh | |
| 21 | Member Day view → same click behaviors | |
| 22 | Member Week view → same click behaviors | |
| 23 | Grid view cards draggable | |
| 24 | Conflicts show red border + ⚠️ icon (no hatch) | |

- [ ] **Step 4: Commit any final fixes**

```bash
git add -A
git commit -m "chore: scheduler v2 integration polish"
```

### Task 21: Event text truncation fix (V-02) + ScheduleEvent polish

**Files:**
- Modify: `frontend/src/pages/SchedulePage.tsx` (ScheduleEvent component, ~line 168)

- [ ] **Step 1: Update ScheduleEvent text priority**

For short events (1 hour or less), prioritize job number over customer/address. The text hierarchy:
1. Job number (always visible, bold, truncate with ellipsis)
2. Customer name (visible if space permits)
3. Address (visible only on tall events)

Update the job event JSX:
```tsx
<div className="font-semibold truncate text-[11px] flex items-center gap-1 text-white">
  {e.isUrgent && <Zap className="h-2.5 w-2.5 shrink-0 fill-current" />}
  {hasConflict && <AlertTriangle className="h-2.5 w-2.5 shrink-0" />}
  <span className="truncate">{e.raw.job_number as string}</span>
</div>
```

Ensure `overflow: hidden` and `text-overflow: ellipsis` work within the solid pill's fixed height.

- [ ] **Step 2: Verify short (1hr) events show job number without truncation**

- [ ] **Step 3: Commit**

```bash
git add frontend/src/pages/SchedulePage.tsx
git commit -m "fix(V-02): prioritize job number in short event text layout"
```

### Task 22: Animation system (spec section 12)

**Files:**
- Modify: `frontend/src/pages/schedule-dark.css`
- Modify: `frontend/src/pages/SchedulePage.tsx`
- Modify: `frontend/src/components/schedule/EventDetailPopup.tsx`
- Modify: `frontend/src/components/schedule/RescheduleConfirmDialog.tsx`
- Modify: `frontend/src/components/schedule/QuickScheduleCard.tsx`
- Modify: `frontend/src/components/schedule/ContextMenu.tsx`
- Modify: `frontend/src/components/schedule/SettingsGearDropdown.tsx`

This task applies the animation system from spec section 12. Most animations are CSS-only:

- [ ] **Step 1: Add CSS transitions and keyframes**

In `schedule-dark.css`, add:
- Event hover: `transition: filter 0.1s ease-out, box-shadow 0.1s ease-out, transform 0.1s ease-out`
- Drag start lift: `.rbc-addons-dnd-dragged-event { transform: scale(1.03); box-shadow: 0 4px 12px rgba(0,0,0,0.15); }`
- Plan Mode background transition: `transition: background 0.3s ease-in-out, border 0.2s ease-in-out`
- `@media (prefers-reduced-motion: reduce)` — disable all animations except opacity fades

- [ ] **Step 2: Add popup/menu enter/exit animations**

Apply to all floating components (EventDetailPopup, QuickScheduleCard, ContextMenu, SettingsGearDropdown):
```tsx
// Wrapper with CSS animation
<div className="animate-in fade-in-0 zoom-in-95 duration-200" style={{...}}>
```

For dialogs (RescheduleConfirmDialog, conflict modal, Plan Mode exit):
```tsx
// Backdrop
<div className="animate-in fade-in-0 duration-200">
// Dialog
<div className="animate-in fade-in-0 zoom-in-95 slide-in-from-bottom-2 duration-250">
```

- [ ] **Step 3: Add sidebar section collapse animation**

Replace instant show/hide of sidebar sections with height animation:
```tsx
<div className={`overflow-hidden transition-all duration-300 ease-in-out ${
  sectionOpen ? 'max-h-[500px] opacity-100' : 'max-h-0 opacity-0'
}`}>
```

- [ ] **Step 4: Add date navigation slide animation**

When navigating prev/next, use CSS transition on the date label:
```tsx
<span key={dateRangeLabel} className="animate-in fade-in-0 slide-in-from-right-2 duration-200">
  {dateRangeLabel}
</span>
```

- [ ] **Step 5: Add toast slide-in animation**

Error/success toasts enter from bottom-right:
```tsx
<div className="animate-in slide-in-from-bottom-4 fade-in-0 duration-250">
```

- [ ] **Step 6: Verify animations feel smooth and natural**

Test all transitions, ensure no jank. Check `prefers-reduced-motion` disables animations.

- [ ] **Step 7: Commit**

```bash
git add frontend/src/pages/schedule-dark.css frontend/src/pages/SchedulePage.tsx frontend/src/components/schedule/
git commit -m "feat: add animation system (spec section 12) — transitions, popups, sidebar, toasts"
```

### Task 23: Color check — LeadDetailPage + any missed amber refs (GAP-6)

**Files:**
- Check: `frontend/src/pages/LeadDetailPage.tsx`
- Check: Any other files with amber walkthrough references

- [ ] **Step 1: Search for remaining amber walkthrough references**

Run: `grep -rn "amber" frontend/src/ --include="*.tsx" --include="*.ts" | grep -i "walk\|wt\|WT"`

Update any remaining amber → violet references for walkthrough-related UI elements.

- [ ] **Step 2: Commit if changes found**

```bash
git add -A
git commit -m "style: update remaining walkthrough amber references to violet"
```

---

## Deferred Items (P2 — not in this plan)

These items from the spec are explicitly deferred to a future polish pass:

| Item | Spec Ref | Reason |
|------|----------|--------|
| V-04: Sidebar drag feedback too faint | P2 | Minor visual polish |
| V-05: Sidebar search for large lists | P2 | QuickScheduleCard provides search as alternative |
| H-05-msg: Error toast copy "schedule" vs "reschedule" | P2 | Minor copy fix |
| J-1024: Toolbar wraps at 1024px | P2 | Responsive edge case |
| D-10: Sidebar drag time prefill wrong | P2 | Edge case in time calculation |
| C-09-space: Whitespace below collapsed sidebar | P2 | Minor layout fix |
| V-08: Month view overflow handling | P2 | Edge case |
| Completed events movability | Deferred | Spec section 18 — future step |
| Plan Mode keyboard shortcut | Deferred | Nice-to-have |
| Past event drag email prompt | Deferred | Edge case UX decision |

---

## Task Dependency Graph

```
Task 1 (Backend fix) ─────────────────────────────────────────→ Task 10 (P0-04 frontend)
                                                                 ↓
Task 2 (CSS rewrite) ──┐                                   Task 11 (Wire confirm dialog)
Task 3 (Colors) ───────┤                                        ↓
Task 4 (Event styling) ┘──→ All visual changes done        Task 12 (Walkthrough drag)
                                                                 ↓
Task 5 (EventDetailPopup) ──┐                              Task 13 (Grid DnD)
Task 6 (ContextMenu) ───────┤                                   ↓
Task 7 (ConfirmDialog) ─────┤──→ All components built      Task 14 (MemberWeek consistency)
Task 8 (QuickSchedule) ─────┤
Task 9 (SettingsGear) ──────┘

Task 15 (Plan Mode persistence) ──┐
Task 16 (Plan Mode ghost fix) ────┤──→ Plan Mode complete
Task 17 (Plan Mode amber theme) ──┘

Everything ──→ Task 18 (Wire QuickSchedule) → Task 19 (Polish) → Task 20 (Integration test)
```

**Parallel tracks:**
- Tasks 1-4 (backend + visual) can run simultaneously
- Tasks 5-9 (new components) can run simultaneously
- Tasks 15-17b (Plan Mode) can run simultaneously
- Tasks 10-14 + 17c (DnD fixes + walkthrough drops) are sequential, depend on Task 1
- Tasks 18-23 (integration + polish + animations) run last

---

*Plan complete. 23 tasks + deferred items, ~7 phases, targeting the full Scheduler V2 spec.*

---

## Addendum — Header & Navigation Refinements (2026-06-03)

Post-V2 polish to the Schedule header toolbar and calendar navigation, done as
incremental UX tweaks. All changes are in `frontend/src/pages/SchedulePage.tsx`.
Status: ✅ implemented + type-checked + verified in the browser preview.

### Header toolbar — two-row layout
- [x] Split the single crowded toolbar into a `flex-col` with **two rows** to reduce density.
- [x] **Row 1:** date nav (`Today ‹ ›` + range label) on the left · **Standard/Member View toggle + Plan Mode centered** · **Settings gear pinned top-right** (`ml-auto`).
- [x] **Row 2:** **Day/Week/Month switcher** on the left · **"All departments" filter centered** · **Full day/Morning/Afternoon** time-of-day window on the right (`ml-auto`).
- [x] The centered Row 1 cluster uses absolute centering (`absolute left-1/2 -translate-x-1/2`).

### "All departments" gap-centering
- [x] The department filter is centered on the **gap between the Standard/Member toggle and Plan Mode**, not the cluster's bounding-box center (the toggle is ~2× the width of Plan Mode, so the two differ by ~55px and a naive center looked off).
- [x] Implemented with a `useLayoutEffect` that measures the toggle + Plan Mode pills (`headerRow1Ref`, `viewToggleRef`, `planModeRef`) and sets a `deptShift` offset applied via inline `transform: translate(calc(-50% + Npx), -50%)`.
- [x] Recomputes on window resize and when the cluster changes (view switch, Plan Mode toggle, sidebar collapse). Falls back to centering under the toggle when Plan Mode is hidden (non Admin/Dispatcher roles).

### Click-a-day → open that day's schedule
- [x] **Month view:** clicking a day opens that day in **Day view**. Handled two ways — `onDrillDown` (clicking the date number) and a Month-view branch added to `handleSelectSlot` (clicking the cell body). Both `setCurrentDate(day)` + `setCalendarView(Views.DAY)`.
- [x] **Week view:** clicking a day **header** opens that day in **Day view**. Added a `Views.WEEK` branch to the custom `DayHeader` `onClick`; Day view keeps the header click for the all-day-job popover.
- [x] Day/Week empty-slot selection (create-job popover) is unchanged outside Month view.

### Verification
- `npx tsc --noEmit` clean after each change.
- Browser preview: Week-header click confirmed switching to Day view (single column, "Wednesday, June 3, 2026"); department dropdown center measured at the gap midpoint (`diff: 0`).
