# RAN-01 — Manual Testing Results from Product Owner

**Tester:** Ran (manual, live browser)
**Date:** 2026-03-18
**Source:** Slack message in #scheduler-ui-audit

---

## Finding 1: Sidebar drag to Grid tech column — BLOCKED

**Severity:** P1
**Category:** F-09 — Sidebar → Grid tech column

**What Ran reported:** "I can't drag from the sidebar to a specific tech column. The cursor turned to 'blocked'."

**Analysis:** The sidebar cards use HTML5 native `draggable` + `onDragStart`. The TechnicianGridView has drop zone divs with `onDragOver`/`onDrop`. But when dragging from the sidebar to the grid, the browser shows a "blocked" cursor — meaning the grid drop zones are not accepting the drag.

**Likely root cause:** The grid drop zones may not be calling `e.preventDefault()` on `dragOver` (required for HTML5 drop to work), or the `dataTransfer` types don't match between the sidebar card's `dragStart` and the grid's `dragOver`. The standard calendar view (Week/Day) uses react-big-calendar's built-in `onDropFromOutside` which handles this, but the TechnicianGridView has custom drop zone logic.

**Impact:** Dispatchers using the By-Tech Grid Day view (the most natural view for multi-tech management) cannot assign jobs by dragging from the sidebar. They'd need to switch to Standard view first.

**Status:** OPEN — for dev team

---

## Finding 2: AssignDialog date pre-fill — PASS

**Severity:** N/A — PASS
**Category:** F-07b — AssignDialog date verification

**What Ran reported:** "The date looks good, I even tried to have a 'cross-date' job and it was working great."

**Analysis:** The UTC→local timezone fix (`toLocalDatetimeString` helper in AssignJobDialog.tsx) is working correctly in the live browser. Cross-date drag also works.

**Note:** The Playwright screenshots showed wrong dates (03/07 instead of 03/18), but this was a Playwright-specific issue — the automated test's drag positioning landed on a different date column than intended. The real browser behavior is correct per Ran's confirmation.

**Status:** PASS — verified by manual testing

---

## Finding 3: Plan Mode — Multiple Issues

**Severity:** P1 (combined)
**Category:** H-13 — Plan Mode

**What Ran reported:**
1. "The 'planning mode' is not distinguishable, meaning that I can't explicitly tell if I am in planning mode or not."
2. "When I drag and drop the walkthrough/job somewhere else — the job/walkthrough gets back to where it was."
3. "The second issue happens with the live mode as well."
4. "The expected behavior is to have a modal to confirm the re-scheduling."

**Analysis:**

**3a. Plan Mode not visually distinguishable (P1):**
The only indicator is a highlighted "Planning" button in the toolbar and a subtle blue banner below the toolbar. Our visual audit screenshots (planmode_banner_active_1920x1080.png) confirmed this — the banner is too subtle. In a busy dispatcher workflow, they could be in Plan Mode without realizing it.

**Suggested fix:** Add a more prominent visual indicator — e.g., a persistent colored overlay/border on the calendar, or a large header bar with "PLAN MODE — changes are not saved" in a warning color.

**3b. Drag-and-drop reverts in both Plan Mode and Live Mode (P1):**
This confirms our H-13 finding. In Plan Mode, dragging an existing event should create a ghost — but instead the event snaps back. In Live Mode, dragging should reschedule the event — but Ran reports it also snaps back.

The live mode revert could be because:
- The drag triggers a conflict dialog (which the user might miss or not notice)
- The optimistic update reverts after the API call fails (inactive technician issue)
- The event literally doesn't move (drag not working properly in the live browser)

**3c. Expected behavior: confirmation modal for rescheduling:**
Ran expects a confirmation dialog before rescheduling. Currently, the scheduler uses optimistic updates — the event moves immediately and the API fires in the background. If a conflict is detected, the conflict dialog appears. But there's no "Are you sure you want to move this event?" confirmation for non-conflicting moves. This is a design decision — Google Calendar also doesn't confirm non-conflicting drags. But for a dispatcher workflow, a confirmation may be appropriate.

**Status:** OPEN — for dev team. Three sub-issues:
- Plan Mode visual indicator (P1)
- Drag revert behavior (P1 — needs further investigation)
- Reschedule confirmation dialog (P2 — design decision)

---

## Finding 4: Plan Mode not persistent after refresh

**Severity:** P1
**Category:** H-17 — Plan Mode persistence

**What Ran reported:** "No, the plan mode is not active after refresh."

**Analysis:** The `usePlanMode` hook uses `localStorage` to persist ghost events and active state with a session-scoped key (`crypto.randomUUID()`). On page refresh, a NEW session ID is generated, so the old localStorage data is orphaned — the new session doesn't find any ghosts under its key.

This means:
- Accidental F5/refresh loses all Plan Mode state
- If a dispatcher stages 10 changes in Plan Mode, then accidentally refreshes, all ghosts are lost
- The "beforeunload" warning exists in the code but may not fire reliably on all browsers

**Impact:** High for Plan Mode users. Data loss on accidental refresh.

**Suggested fix:** Either use a fixed localStorage key (not session-scoped) so Plan Mode survives refresh, OR persist Plan Mode state to the server (API endpoint).

**Status:** OPEN — for dev team
