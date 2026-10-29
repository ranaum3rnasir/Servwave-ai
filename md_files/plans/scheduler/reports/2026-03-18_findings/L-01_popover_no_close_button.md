# L-01 — Event Click Popup and Slot Popover Have No Close Button

**Category:** L — Interaction Feedback
**Severity:** P1 (Feels Wrong)
**View(s) Affected:** All calendar views
**Viewport(s):** All
**Status:** FIXED (during Day 1, before QA-only mode)

## Steps to Reproduce
1. Navigate to /schedule, Week view
2. Click on any event — popup appears
3. Try to close the popup by clicking X — no X button exists
4. Try clicking outside — popup may not dismiss (race condition with rbc event handlers)
5. Same issue with clicking an empty time slot — "Schedule a Job" popover has no close button

## Expected Behavior
Popovers should have a visible X/close button AND dismiss on outside click.

## Actual Behavior (Before Fix)
- No X button on either popover
- Click-outside handler used `document.addEventListener('click', ...)` with 50ms delay, which lost the race against react-big-calendar's internal event handlers
- User could get stuck with a popover that won't close without pressing Escape

## Evidence
- Screenshot: `D-05_02_after_click.png` — event popup visible, no X button in header
- Screenshot: `event_click_popup_1920x1080.png` — same, no dismiss mechanism visible
- User report: Ran confirmed both popovers cannot be closed

## Fix Applied
1. Added XCircle close button to event click popup header
2. Added XCircle close button to slot popover ("Schedule a Job") header
3. Changed click-outside handler from `click` to `mousedown` (capture phase) to fire before rbc's handlers
4. Increased delay from 50ms to 100ms

## Note
Even with the fix, the outside-click dismiss should be re-verified manually. The `mousedown` capture phase approach may have edge cases where clicking on another event doesn't properly dismiss the first popup before opening the second.
