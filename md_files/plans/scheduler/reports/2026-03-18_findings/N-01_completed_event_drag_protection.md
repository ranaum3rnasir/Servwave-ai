# N-01 — Completed Event Drag Protection

**Category:** N-A — Completed/Cancelled Event Protection
**Severity:** P0 (Data Integrity)
**View(s) Affected:** All
**Viewport(s):** All
**Status:** FIXED AND VERIFIED

## Steps to Reproduce
1. Navigate to /schedule
2. Click "All" toggle to show completed events
3. Find a completed event (gray, 0.5 opacity)
4. Try to drag it to a new time

## Expected Behavior
Drag should NOT initiate. Completed events are locked.

## Actual Behavior (Before Fix)
`draggableAccessor: () => true` allowed all events to be dragged. Completed events could be rescheduled, firing the assign mutation on a completed job. Data integrity risk.

## Fix Applied (During Day 1)
- `draggableAccessor` now returns `false` for COMPLETED/CANCELLED/WALKTHROUGH_COMPLETED events
- `resizableAccessor` same guard
- `handleEventDrop` and `handleEventResize` have defense-in-depth early returns
- Ghost events (Plan Mode) remain draggable via `!event.isGhost` check

## Evidence
- Screenshot: `N-01_01_all_view_with_completed.png` — week view in All mode
- Screenshot: `N-01_02_completed_event_closeup.png` — completed event at 0.5 opacity
- Screenshot: `N-01_03_drag_attempt.png` — no drag ghost, no movement after 80px drag
- Screenshot: `N-01_04_after_release.png` — event at original position
- Console: `opacity: 0.5` confirmed

## Verification
PASS. Completed events are fully locked. No drag ghost, no movement, no API call.
