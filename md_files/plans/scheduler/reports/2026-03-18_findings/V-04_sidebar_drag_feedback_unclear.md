# V-04 — Sidebar-to-Calendar Drag: Insufficient Visual Feedback

**Category:** E — DnD Visual Feedback
**Severity:** P1 (Feels Wrong)
**View(s) Affected:** Week, Day (Standard view)
**Viewport(s):** All
**Status:** PARTIALLY FIXED (dragFromOutsideItem fix added start/end for preview)

## Steps to Reproduce
1. Navigate to /schedule, Week view
2. Drag an unassigned job card from the sidebar toward the calendar
3. Observe the visual feedback during the drag

## Expected Behavior (Google Calendar Reference)
Clear drag ghost following cursor + highlighted drop target slot on the calendar grid showing where the event will land.

## Actual Behavior
- The sidebar card dims correctly (opacity ~0.4, scale-down) — GOOD
- A custom blue pill drag ghost with job number follows the cursor — GOOD
- A "2:30 PM — Drop to schedule" text appears on the time grid — GOOD (after fix)
- BUT: Playwright screenshots show unclear visual state during the drag. The drop zone highlight may not be prominent enough for dispatchers to confidently target a time slot.

## Evidence
- Screenshot: `D-10_02_drag_started.png` — card opacity 0.4 confirmed
- Screenshot: `D-10_03_over_calendar.png` — "2:30 PM — Drop to schedule" visible in faint gray
- Screenshot: `dnd_sidebar_card_mid_drag_1920x1080.png` — full page during sidebar drag, visual state unclear

## Impact
The sidebar-to-calendar drag is the CORE workflow. If visual feedback is insufficient, dispatchers may miss their target time slot or feel uncertain about where the event will land.

## Suggested Fix Direction
1. Make the "Drop to schedule" text bolder and add a background highlight to the target slot
2. Consider adding a semi-transparent event-shaped preview at the target position (like Google Calendar shows)
3. The `handleDragOverFromOutside` in react-big-calendar's EventContainerWrapper renders a preview via `update()` — verify this preview is visible and properly styled in `schedule-dark.css`

## Note
The `dragFromOutsideItem` fix (adding `start`/`end`) was applied during Day 1 to enable the drop preview rendering. This partially addresses the issue. Full evaluation requires manual browser testing.
