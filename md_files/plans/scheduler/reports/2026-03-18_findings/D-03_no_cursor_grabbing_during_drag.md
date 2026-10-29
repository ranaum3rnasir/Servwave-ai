# D-03 — No cursor:grabbing During Active Calendar Event Drag

**Category:** D — DnD Core
**Severity:** P1 (Feels Wrong)
**View(s) Affected:** Week, Day
**Viewport(s):** All
**Status:** OPEN

## Steps to Reproduce
1. Navigate to /schedule, Week view
2. Click and hold on a SCHEDULED event, start dragging
3. Observe the cursor during the drag operation

## Expected Behavior (Google Calendar Reference)
During active drag, cursor changes to `grabbing` (closed hand) — reinforcing that you're holding and moving an object.

## Actual Behavior
`schedule-dark.css` has no `.rbc-addons-dnd-dragged-event { cursor: grabbing }` rule. The DnD addon's drag preview only sets `opacity: 0.5`. No cursor change during drag.

Note: The sidebar cards DO have this correct — `cursor-grabbing` class is applied during drag (SchedulePage.tsx line 1317). This inconsistency makes the calendar DnD feel less polished than the sidebar DnD.

## Evidence
- Code analysis: `schedule-dark.css` has no grabbing cursor rules
- Screenshot: `D-06_03_drag_initiated.png` — during drag, no cursor change visible

## Impact
Dispatchers doing 50+ rearrangements per day don't get tactile cursor feedback that they're "holding" an event. Feels less intentional than Google Calendar.

## Suggested Fix Direction
Add to `schedule-dark.css`:
```css
.schedule-cal .rbc-addons-dnd-dragged-event { cursor: grabbing; }
.schedule-cal.rbc-addons-dnd-is-dragging { cursor: grabbing; }
```
