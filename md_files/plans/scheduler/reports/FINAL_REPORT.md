# Scheduler UI/UX Audit — Final Report for Development Team

**Date:** 2026-03-18
**Audited by:** AI QA Team (Eyes, Robot, Lead) + Manual Testing (Ran, Product Owner)
**Module:** SchedulePage + TechnicianGridView + MemberWeekBoard
**Benchmark:** Google Calendar
**Duration:** 4 days of testing
**Evidence:** 112+ screenshots in `frontend/e2e/screenshots/scheduler-audit/`
**Detailed findings:** 30+ individual reports in `md_files/plans/scheduler/reports/2026-03-18_findings/`

---

## Executive Summary

**The scheduler looks good. The DnD doesn't work.**

The scheduler's visual design — layout, sidebar, card formatting, color coding, responsive behavior — is solid and professional. The By-Tech Grid Day view is particularly strong. But the #1 feature of the module — drag-and-drop rescheduling — is fundamentally broken in the live browser. Events snap back to their original position, data doesn't persist, and behavior is inconsistent between jobs and walkthroughs.

**The root cause is a wrong API endpoint.** The walkthrough reschedule mutation calls `/api/leads/:id/walkthrough` (which ignores `walkthrough_scheduled_at`) instead of `/api/leads/:id/walkthrough/schedule` (which processes it). This single-line URL mistake renders the entire walkthrough DnD non-functional.

---

## Product Requirements (from Product Owner)

### REQ-01: All Objects Must Behave Identically
> "Every object on the schedule and sidebar should behave the same."

Jobs and walkthroughs must have identical DnD behavior: same drag, same drop, same resize, same persistence, in every view and every context.

### REQ-02: Design Decisions
1. **Past events:** CAN be dragged — dev team decides UX (confirmation dialog?)
2. **Cancelled events:** REMOVE from schedule entirely (not just dimmed)
3. **Completed events:** Can be moved in the future — dev team designs the flow. Current lock is temporary.

---

## Critical Findings (Fix First)

### P0-04: Walkthrough DnD Calls WRONG API Endpoint
**THE #1 FINDING.** Root cause of all walkthrough snap-back.

| What | Detail |
|------|--------|
| File | `frontend/src/pages/SchedulePage.tsx` line 953 |
| Bug | Mutation calls `POST /api/leads/:id/walkthrough` |
| Should call | `POST /api/leads/:id/walkthrough/schedule` |
| Effect | walkthrough_scheduled_at is ignored. 200 returned but no data change. Event snaps back. |

**4 fixes needed:**
1. Frontend line 953: Change endpoint URL
2. Frontend line 953: Send all required fields (`walkthrough_assigned_to`, `walkthrough_duration_minutes`, `force: true`)
3. Frontend lines 1043-1044: Pass performer ID + duration from `event.raw`
4. Backend `lead.controller.ts` line 681: Add `WALKTHROUGH_SCHEDULED` to status guard

### P0-02: Sidebar Drag to Calendar Was Broken (FIXED Day 1)
`dragFromOutsideItem` returned object without `start`/`end` and never returned `null`. Fixed during audit.

### P0-01: Completed Events Were Draggable (FIXED Day 1)
`draggableAccessor: () => true` allowed completed/cancelled events to be rescheduled. Fixed during audit.

---

## DnD Findings (Priority Order)

| ID | Severity | Finding | File(s) |
|----|----------|---------|---------|
| P0-04 | P0 | Wrong API endpoint for walkthrough reschedule | SchedulePage.tsx:953 |
| D-09 | P1 | Grid view cards not draggable (drop-only) | TechnicianGridView.tsx |
| F-09 | P1 | Sidebar → Grid drop zones show "blocked" cursor | TechnicianGridView.tsx |
| D-01 | P1 | cursor:pointer instead of cursor:grab on events | SchedulePage.tsx:854, schedule-dark.css |
| D-03 | P1 | No cursor:grabbing during active drag | schedule-dark.css |
| H-13 | P1 | Plan Mode drag on real events fires live API (not ghost) | SchedulePage.tsx:1027 |
| H-17 | P1 | Plan Mode not persistent after refresh (new sessionId each load) | usePlanMode.ts |
| V-04 | P1 | Sidebar "Drop to schedule" preview text too faint | schedule-dark.css |
| REQ-01 gap | P1 | Sidebar walkthroughs not draggable (jobs only) | SchedulePage.tsx:1289 |
| D-06 | P2 | Click popup persists during drag operation | SchedulePage.tsx:1141 |

---

## Visual / UI Findings

| ID | Severity | Finding | Evidence |
|----|----------|---------|----------|
| V-01 | P1 | Conflict hatch pattern too aggressive — destroys text readability | layout_week_view screenshot |
| V-02 | P1 | Job number truncation on short (1-hour) events | event_urgent_badge_closeup screenshot |
| RAN-01-3a | P1 | Plan Mode not visually distinguishable | planmode_banner_active screenshot |
| N-13-sales | P1 | Sales filter empty state not helpful | N-13_03_sales screenshot |
| V-03 | P2 | Member Grid Week view unusable (28 sub-cells too dense) | layout_member_grid_week screenshot |
| C-09-space | P2 | Whitespace below sidebar cards when section collapsed | C-09_02_wt_collapsed screenshot |
| J-1024-toolbar | P2 | Toolbar wraps to 2 lines at 1024x768 | J_1024x768 screenshot |
| J-1024-text | P2 | Event text illegible at 1024px in week view | J_1024x768 screenshot |
| V-05 | P2 | No search/filter for 61+ sidebar walkthrough items | sidebar_closeup screenshot |
| V-06 | P2 | Resize handle not visible at normal zoom | dnd_resize_handle_hover screenshot |
| V-07 | P2 | Plan Mode active state too subtle | planmode_banner_active screenshot |
| V-08 | P2 | Month view "+33 more" overflow | layout_month_view screenshot |
| V-09 | P2 | Ghost events in Plan Mode too faint | planmode_ghost_event screenshot |
| V-10 | P2 | Tooltip/popup/context menu text too small at full zoom | event_hover_tooltip screenshot |
| H-05-msg | P2 | Error toast says "schedule" instead of "reschedule" | H-05_02 screenshot |

---

## What Works Well

These areas passed testing and should be preserved:

- **Sidebar layout:** 240px width, 6px card gap, compact cards, amber walkthrough accent, urgent badge
- **Sidebar collapse:** Both sections collapse/expand correctly
- **Staff filter:** Technicians/Sales/All switching works in Member View
- **Month button hidden in grouped view:** Correctly removes Month option
- **Slot popover:** "Schedule a Job" appears on empty slot click, dismisses on Escape
- **Overlay stacking:** Tooltip properly dismissed when context menu opens
- **Event click popup:** Shows job/walkthrough details, "View Job" link, X close button (added Day 1)
- **Conflict dialog:** Professional modal with "Cancel" + "Schedule Anyway" buttons
- **Network failure recovery:** Event reverts + error toast on API failure (H-05)
- **Cross-entity conflict detection:** Jobs conflicting with walkthroughs correctly detected (F-03)
- **Responsive:** Layout works at 1920, 1440, 1366, 1024 (sidebar visible at all)
- **By-Tech Grid Day view:** Clean tech columns, readable job cards, professional layout

---

## Fixes Applied During Audit (Already in Codebase)

These were fixed before QA-only mode was activated:

| Fix | File | Lines |
|-----|------|-------|
| `draggableAccessor` blocks completed/cancelled | SchedulePage.tsx | 1636-1641 |
| `resizableAccessor` blocks completed/cancelled | SchedulePage.tsx | 1643-1648 |
| `handleEventDrop` defense-in-depth guard | SchedulePage.tsx | 1013-1014 |
| `handleEventResize` defense-in-depth guard | SchedulePage.tsx | 1055-1056 |
| `dragFromOutsideItem` returns null when not dragging + adds start/end | SchedulePage.tsx | 1631-1639 |
| `AssignJobDialog` UTC→local time conversion | AssignJobDialog.tsx | 49-57 |
| Event click popup X close button | SchedulePage.tsx | ~1840 |
| Slot popover X close button | SchedulePage.tsx | ~2052 |
| Click-outside dismiss handler (mousedown capture phase) | SchedulePage.tsx | ~528 |

---

## Test Infrastructure Notes

1. **Playwright false positives:** `page.mouse` simulation fires `mousedown`/`mousemove`/`mouseup`, NOT HTML5 `dragstart`/`dragover`/`drop`. Tests showed DnD "working" when it was broken in the real browser. All DnD tests should be verified manually.

2. **Test data pollution:** 60+ inactive E2E test technicians accumulated in the DB. Jobs referencing them get "Cannot assign to inactive technician" errors. The seed cleanup needs to fully delete users (not just deactivate).

3. **Screenshot-verify-proceed protocol:** AI agents can read PNG screenshots visually. Every finding includes screenshot evidence. All screenshots are in `frontend/e2e/screenshots/scheduler-audit/`.

---

## Recommended Fix Order

1. **P0-04:** Fix walkthrough mutation endpoint (line 953) + backend status guard
2. **REQ-02 Decision 2:** Remove cancelled events from schedule
3. **D-01/D-03:** cursor:grab + cursor:grabbing (CSS only, quick win)
4. **V-01:** Replace conflict hatch pattern with subtle border + badge
5. **V-02:** Fix job number truncation (priority text layout)
6. **D-09/F-09:** Make grid view cards draggable + fix drop zone acceptance
7. **H-13:** Plan Mode ghost creation for existing event drags
8. **REQ-01:** Make sidebar walkthroughs draggable
9. **H-17:** Fix Plan Mode persistence (use fixed localStorage key)
10. Everything else (P2 polish)

---

## Statistics

| Metric | Count |
|--------|-------|
| Total scenarios in plan | 195 |
| Scenarios tested | ~80 (41%) |
| Screenshots captured | 112+ |
| Finding reports filed | 35+ |
| P0 found | 6 (5 fixed during audit, 1 open — root cause identified) |
| P1 open | 16 |
| P2 open | 18 |
| Product requirements | 2 (REQ-01, REQ-02) |
| Fixes applied during audit | 9 |
| Playwright spec files created | 15 |
| Manual test verifications by PO | 8 |

---

*End of report. All detailed findings, screenshots, and code references are in the reports directory.*
