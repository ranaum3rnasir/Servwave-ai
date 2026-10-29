# Schedule — Day header double-click fix

**Date:** 2026-06-03
**Module:** Schedule
**File touched:** `frontend/src/pages/SchedulePage.tsx`
**Type:** Bug fix

## Symptom

In **week view**, double-clicking a day header to enlarge/expand that day's
column also caused the "Schedule" popover (the `QuickScheduleCard` with the
Jobs / Walkthroughs tabs and "No unassigned jobs") to open automatically. The
user only wants a double-click to expand the day — the popover should not
appear as a side effect.

## Root cause

The day-header `onClick` had two view-dependent behaviors, and a double-click
fired the single-click handler twice:

1. **click #1** → `DayHeader` `onClick`, week branch → `setCalendarView(Views.DAY)`
   navigates week → day.
2. Re-render into Day view.
3. **click #2** → `DayHeader` `onClick`, now in Day view → falls through to the
   `setAllDaySlotPopover(...)` branch → the Schedule popover opens. *(unwanted)*
4. **dblclick** → wrapper `handleCalendarDoubleClick`, but `calendarView` is now
   `DAY`, so it returns early — meaning the intended column-expand
   (`toggleDayFocus`) never even ran.

So the popover was a side effect of the single-click handler running during the
double-click, and the real expand behavior was being pre-empted by the
navigation on click #1.

## Fix

Single-click / double-click disambiguation on the day header. The single-click
action is **deferred ~250ms** and is **cancelled by the second click**, so a
genuine double-click no longer triggers the single-click action.

In `SchedulePage.tsx`:

1. Added a `dayHeaderClickTimer` ref (with an unmount cleanup effect) next to
   `toggleDayFocus`.
2. Wrapped the `DayHeader` `onClick` body in the deferred-timer pattern:
   - First click schedules the action on a 250ms timer.
   - A second click clears that timer and returns (no single-click action).
   - The wrapper's `onDoubleClick` (`handleCalendarDoubleClick`) then runs while
     still in week view, so `toggleDayFocus` correctly expands the column.

## Resulting behavior (week view)

| Action | Before | After |
|--------|--------|-------|
| Double-click a day header | Navigates to Day view **and** opens the Schedule popover | Expands the day column only (stays in week view); no popover, no navigation |
| Single-click a day header | Navigates to Day view | Navigates to Day view (unchanged, ~250ms later) |

Single-click in non-week views still opens the all-day Schedule popover as
before.

## Tradeoff

A ~250ms delay is added to the single-click drill-in — the standard cost of
distinguishing single vs. double clicks. Acceptable for this interaction.

## Verification

- `npx tsc --noEmit` — clean.
- Verified live in the dev preview via DOM assertions:
  - Double-click → `data-focus-day="3"` set (column expanded), still 7 week
    headers (no navigation), `"No unassigned jobs"` node count = 0 (no popover).
  - Single-click → calendar navigates to Day view (header count → 1).
