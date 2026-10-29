# D-01 — All Calendar Events Use cursor:pointer Instead of cursor:grab

**Category:** D — DnD Core
**Severity:** P1 (Feels Wrong)
**View(s) Affected:** All calendar views (Week, Day, Month)
**Viewport(s):** All
**Status:** OPEN

## Steps to Reproduce
1. Navigate to /schedule
2. Hover over any SCHEDULED job event in Week view
3. Observe the cursor

## Expected Behavior (Google Calendar Reference)
Draggable events show `cursor: grab` (open hand) on hover, signaling "you can move this." Completed/cancelled events show `cursor: default` or `cursor: not-allowed`.

## Actual Behavior
`eventStyleGetter` (SchedulePage.tsx line 854) sets `cursor: 'pointer'` for ALL events uniformly. `schedule-dark.css` has no `.rbc-event` cursor override rules. There is zero visual cursor distinction between draggable and non-draggable events.

## Evidence
- Screenshot: `D-01_01_hover_on_event.png` — hovering over SCHEDULED event, cursor is "pointer"
- Screenshot: `D-01_02_hover_on_completed.png` — hovering over COMPLETED event, also "pointer"
- Console: `[D-01] Cursor on event hover: pointer` and `[D-01] Cursor on completed event: pointer`

## Impact
Every dispatcher hovering over any event gets the same cursor. Breaks the fundamental DnD affordance — users should know BEFORE clicking whether something is draggable. Google Calendar solves this with `cursor: grab` on hover.

## Suggested Fix Direction
In `eventStyleGetter`, set `cursor: 'grab'` for draggable events (SCHEDULED, IN_PROGRESS, walkthroughs) and `cursor: 'default'` for completed/cancelled. Add to `schedule-dark.css`:
```css
.schedule-cal .rbc-addons-dnd-dragged-event { cursor: grabbing; }
```
