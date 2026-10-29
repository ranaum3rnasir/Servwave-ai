# D-09 — TechnicianGridView Cards Are NOT Draggable

**Category:** D — DnD Core
**Severity:** P1 (Feels Wrong)
**View(s) Affected:** By-Tech Grid Day
**Viewport(s):** All
**Status:** OPEN

## Steps to Reproduce
1. Navigate to /schedule
2. Switch to Member View → Day view (TechnicianGridView renders)
3. Try to drag an existing job card within the grid (e.g., move it from 9 AM to 1 PM, or from Tech A to Tech B)

## Expected Behavior (Google Calendar Reference)
In Google Calendar's multi-resource view, you can drag events between resources (people) and time slots freely. Any placed event should be re-draggable.

## Actual Behavior
The `JobCard` component in `TechnicianGridView.tsx` has NO `draggable` attribute and NO `onDragStart` handler. The grid only supports drop targets (via `onDragOver`/`onDrop` on hour-slot divs) for receiving sidebar drags. Events already placed on the grid CANNOT be rearranged.

- You CAN drag from sidebar → grid (assign a new job)
- You CANNOT drag within grid → grid (rearrange an existing job)
- You CANNOT drag grid → different tech column (reassign)

## Evidence
- Screenshot: `D-09_01_grid_day_view.png` — 4 tech columns visible, clean layout, job cards positioned correctly
- Screenshot: `D-09_02_grid_card.png` — closeup of grid card: "9:00 AM - 11:00 AM JOB-2026-0028 Urgent"
- Screenshot: `D-09_03_grid_drag_attempt.png` — after dragging 100px down, card did NOT move
- Screenshot: `D-09_04_after_release.png` — card at original position

## Impact
HIGH. The By-Tech Grid Day view is the most natural view for dispatchers managing multiple technicians. They will instinctively try to drag jobs between tech columns or to different times. Having to switch back to Standard view to rearrange events breaks the workflow.

## Suggested Fix Direction
Add `draggable` + `onDragStart`/`onDragEnd` handlers to `JobCard` in `TechnicianGridView.tsx`. Wire the drop handler to call the existing `onDropJob` callback with the new tech ID + time. Apply the same completed-status guard (check `isCompletedEvent`). The drop zone infrastructure already exists (hour-slot divs with `onDragOver`/`onDrop`) — only the card drag source is missing.
