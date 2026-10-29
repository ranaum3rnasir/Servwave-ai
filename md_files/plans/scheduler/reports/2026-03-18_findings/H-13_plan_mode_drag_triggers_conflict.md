# H-13 — Plan Mode Drag Creates Conflict Dialog Instead of Ghost

**Category:** H — DnD Edge Cases (Plan Mode)
**Severity:** P1 (Feels Wrong)
**View(s) Affected:** Week (Standard view with Plan Mode active)
**Status:** OPEN

## Steps Tested
1. Activated Plan Mode (banner visible, "Planning" button highlighted in blue)
2. Dragged an existing calendar event ~80px down in Week view
3. Expected: ghost event created at new position (dashed border, provisional)
4. Actual: Scheduling Conflict dialog appeared instead

## Visual Evidence Analysis

**H-13_01_plan_mode_active.png:** Plan Mode is active. The toolbar shows "Planning" button highlighted in blue. The banner below says "Plan Mode — 0 unconfirmed changes". The calendar has a dashed blue border (Plan Mode visual indicator). All correct so far.

**H-13_02_ghost_created.png:** FINDING — Instead of creating a ghost event, a "Scheduling Conflict" dialog appeared. The dialog shows "WT LEAD-2026-0185 1:00 PM - 2:00 PM" as conflicting. This means the drag was processed as a REAL move (calling `assignMutation`), not as a Plan Mode ghost creation.

**H-13_03_banner_count.png:** Banner still says "Plan Mode — 0 unconfirmed changes". No ghost was created. The drag was treated as a normal reschedule, not a Plan Mode operation.

## Root Cause Analysis
Looking at `handleEventDrop` (SchedulePage.tsx ~line 1017-1024): the ghost creation only happens when `event.isGhost && event.ghostId` — i.e., when REPOSITIONING an existing ghost. For dragging a REAL event in Plan Mode, the code falls through to the normal `assignMutation.mutate()` path.

The code at line 1027: `if (event.type === 'job') { ... assignMutation.mutate(...) }` fires regardless of whether Plan Mode is active. There's no `if (planMode.isActive)` check for real events being dragged.

## Impact
Plan Mode's purpose is to stage changes without committing. But dragging existing calendar events still fires real API calls, bypassing the staging system entirely. Only sidebar-to-calendar drags create ghosts. This makes Plan Mode inconsistent — some drags are staged, others are live.

## Suggested Fix Direction
In `handleEventDrop`, before the `event.type === 'job'` branch, add a Plan Mode check:
```js
if (planMode.isActive && !event.isGhost) {
  // Create a "moved" ghost instead of calling assignMutation
  planMode.addGhost({
    sourceId: event.id,
    sourceType: event.type,
    isFromSidebar: false,
    isMovedConfirmed: false,
    originalPosition: { start: event.raw.scheduled_start, end: event.raw.scheduled_end, resourceId: event.resourceId },
    start: startDate.toISOString(),
    end: endDate.toISOString(),
    resourceId: ...,
    title: event.title,
    ...
  });
  return;
}
```

## Screenshots
- `H-13_01_plan_mode_active.png`
- `H-13_02_ghost_created.png` (actually shows conflict dialog, not ghost)
- `H-13_03_banner_count.png`
