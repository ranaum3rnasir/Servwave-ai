# D-06 — Click Popup Persists During Drag Operation

**Category:** D — DnD Core
**Severity:** P2 (Polish)
**View(s) Affected:** Week, Day
**Viewport(s):** All
**Status:** OPEN

## Steps to Reproduce
1. Navigate to /schedule, Day view
2. Click and hold on a SCHEDULED event at 11 AM
3. Move cursor 15px down (past dead zone)
4. Continue dragging 120px down
5. Observe: the event detail popup appears AND the drag operates simultaneously

## Expected Behavior (Google Calendar Reference)
Google Calendar does NOT show a detail popup during drag — only the ghost preview. The popup should only appear on a clean click (no movement).

## Actual Behavior
The click popup fires on mousedown (before the drag threshold is reached) and persists throughout the drag operation. The drag DOES work mechanically (event moves, conflict detected), but the popup overlays the calendar during the entire drag, which is visually confusing.

## Evidence
- Screenshot: `D-06_03_drag_initiated.png` — popup appeared after 15px move, showing "JOB-2026-0029 SCHEDULED"
- Screenshot: `D-06_04_mid_drag.png` — popup still visible after 120px further drag
- Screenshot: `D-06_05_after_drop.png` — popup disappeared after drop, event moved to new position

## Impact
Dispatchers see a detail popup floating while trying to drag. It obscures the target drop zone and makes the interaction feel broken even though the drag works.

## Suggested Fix Direction
In `handleSelectEvent` (SchedulePage.tsx), check if a drag is in progress before showing the popup. OR dismiss the popup when `onEventDrop` starts (i.e., when mouse movement exceeds the dead zone threshold). The react-big-calendar DnD addon may expose a `isDragging` state that can be used.
