# RAN-02 — DnD Detailed Breakdown from Manual Testing

**Tester:** Ran (manual, live browser)
**Date:** 2026-03-18
**Source:** Slack follow-up conversation

---

## Clarification: What Works and What Doesn't

### Standard Calendar View (Week/Day):

| Action | Result | API Call | Status |
|--------|--------|----------|--------|
| Drag walkthrough to new time | Snaps back visually but API succeeds (200) | POST walkthrough/schedule → 200 | P1 — optimistic update reverts despite success |
| Drag job to new time | Snaps back, no dialog | NEEDS VERIFICATION — drag a Mike Rodriguez job | P0 if silent failure, P1 if inactive tech issue |

**KEY INSIGHT from Ran:** "What I sent is for the live calendar view, where an object on the board gets back to its original place after dropping." The 200-status walkthrough call succeeded but the EVENT STILL SNAPPED BACK. This means the optimistic update/revert cycle has a bug — the query invalidation after success may be reverting the visual position before the refetch completes.

### Tech Grid View (Member View → Day):

| Action | Result | API Call | Status |
|--------|--------|----------|--------|
| Drag job card within grid | Can drag but CANNOT DROP — blocked cursor | No API call (nothing in Network tab) | P1 — drop zones reject the drag |
| Drag walkthrough in grid | Cannot even initiate drag | N/A | P1 — walkthrough cards in grid have no `draggable` attribute |
| Drag sidebar job → grid | Blocked cursor (reported earlier) | No API call | P1 — grid drop zones don't accept external drags |

### Sidebar:

| Action | Result | Status |
|--------|--------|--------|
| Drag unassigned job → standard calendar | Works (after Day 1 fix) | PASS |
| Drag unassigned walkthrough | Nothing happens — not draggable | By design — walkthrough cards don't have `draggable` attribute |

---

## Finding 1: WALKTHROUGH DRAG SUCCEEDS (200) BUT EVENT SNAPS BACK

**Severity:** P1 (Feels Wrong — possibly P0)
**Category:** F — Drop Targets

The API call succeeds (status 200) but the calendar event visually returns to its original position. This means either:
1. The optimistic update in `walkthroughRescheduleMutation.onMutate` applies the visual change, then `onSuccess` calls `queryClient.invalidateQueries` which triggers a refetch, and the refetch returns the OLD data before the server has fully committed — causing the event to jump back briefly before the next refetch shows the correct position.
2. The `onMutate` optimistic update doesn't correctly calculate the new position for the walkthrough event in the query cache.

**To investigate:** Check `walkthroughRescheduleMutation` `onMutate` handler — does it update the `walkthrough_scheduled_at` field in the cache correctly? And does the `onSuccess` invalidation cause a flash-back?

---

## Finding 2: GRID VIEW — JOBS CAN DRAG BUT NOT DROP

**Severity:** P1
**Category:** D-09 / F-09

In TechnicianGridView, job cards can be visually picked up (drag initiates) but cannot be dropped on any target. The cursor shows "blocked" over drop zones. Nothing appears in the Network tab.

**Root cause (code analysis from Day 1):** The `JobCard` component in TechnicianGridView has no `draggable` attribute — so what Ran is seeing may be the browser's default text selection drag, not an actual HTML5 drag. The drop zones expect a specific `dataTransfer` format that the text selection drag doesn't provide.

---

## Finding 3: GRID VIEW — WALKTHROUGHS CAN'T DRAG AT ALL

**Severity:** P1
**Category:** D-09

Walkthrough events rendered in the TechnicianGridView cannot be dragged at all. This is expected from the code — the grid only renders `JobCard` components for jobs, and walkthrough events are rendered differently without any drag support.

---

## Finding 4: SIDEBAR WALKTHROUGHS NOT DRAGGABLE

**Severity:** By Design (document, not fix)
**Category:** N/A

Unassigned walkthrough cards in the sidebar don't have `draggable` attribute. They use `onClick` to navigate to `/leads/{id}?tab=walkthrough`. This is intentional — walkthroughs are scheduled via the Lead Detail page walkthrough tab, not by dragging to the calendar.

**Recommendation:** Add a tooltip or visual hint on walkthrough sidebar cards: "Click to schedule walkthrough" — so dispatchers don't try to drag them and think the app is broken.
