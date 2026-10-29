# P0-03 — Calendar DnD Reschedule Completely Broken in Live Browser

**Category:** D — DnD Core / F — Drop Targets
**Severity:** P0 (Broken — core workflow)
**View(s) Affected:** Week, Day (Standard view)
**Viewport(s):** All
**Status:** OPEN

## Steps to Reproduce
1. Navigate to /schedule in Standard Week or Day view (NOT Plan Mode, NOT Member View)
2. Drag an existing scheduled job event to a different time slot
3. Release the mouse

## Expected Behavior
Event moves to the new time. If there's a conflict, the conflict dialog appears. If no conflict, the event stays at the new position and the API call fires in the background.

## Actual Behavior
The event snaps back to its original position with NO dialog, NO error toast, NO visual feedback. Nothing happens. The drag appears to initiate (the event visually moves during drag) but on mouse release it reverts silently.

## Why Playwright Tests Show This Working (False Positive)
Playwright's `page.mouse.down()/move()/up()` fires `mousedown`/`mousemove`/`mouseup` events. react-big-calendar's DnD addon uses these mouse events internally for calendar event dragging. In a real browser, the addon correctly processes these events.

HOWEVER — Ran's manual testing shows it snapping back. This means either:
1. The `handleEventDrop` handler fires but the mutation fails silently (no error handling for non-409 errors)
2. The `handleEventDrop` doesn't fire at all in the real browser interaction
3. The optimistic update applies but immediately reverts due to a query invalidation race
4. The event's `assigned_to` references an inactive technician, causing the backend to reject with a non-409 error that the frontend doesn't show

## Most Likely Root Cause
The jobs on Ran's calendar are assigned to INACTIVE E2E test technicians (confirmed: all 60+ test techs have `is_active: false`). When `handleEventDrop` fires:
1. It reads `assignedUser.id` from the event's `assigned_user` field
2. Calls `assignMutation.mutate({ jobId, assignedTo: inactiveTechId, start, end })`
3. Backend rejects: "Cannot assign job to an inactive technician"
4. The `onError` handler in `assignMutation` reverts the optimistic update
5. BUT the error toast may not display if it's a non-standard error format

To verify: check the browser Network tab (DevTools) during the drag. Look for a POST to `/api/jobs/:id/assign` and check the response status + body.

## Impact
CRITICAL. This is the #1 workflow of the scheduler: a dispatcher rearranging jobs throughout the day. If every drag silently fails, the scheduler is unusable for rescheduling.

## Investigation Needed
1. Is this caused by inactive test technicians? (Assign the jobs to Mike Rodriguez — the active tech — and retest)
2. If it persists with an active tech, check if `handleEventDrop` fires at all (add console.log)
3. Check the Network tab for failed API calls during drag
4. Check if the `onError` handler in `assignMutation` correctly shows error toasts

## Suggested Fix Direction
Two fixes needed:
1. **Immediate:** Ensure error toasts display for ALL assign mutation failures (not just 409 conflicts). The `onError` handler may be swallowing non-conflict errors.
2. **Root cause:** The test data pollution (inactive techs) needs cleanup. But the silent failure is a bug regardless — the user should ALWAYS see feedback when a drag fails.

## Evidence
- Manual tester report: Ran confirmed option C — event snaps back, no dialog, no error
- Consistent with "Cannot assign to inactive technician" backend error
- Playwright tests show drags working (conflict dialog appearing) because they create fresh active technicians in `beforeAll`

## Relationship to Other Findings
- P0-02 (sidebar drag broken): Same root issue pattern — Playwright false positive due to different event system
- D-10 (sidebar drag time pre-fill): Fixed, but the sidebar drag flow may also hit inactive tech issues
- H-13 (Plan Mode ghost): Related — Plan Mode drags also revert, possibly same inactive tech cause
