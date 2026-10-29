# Scheduler UI/UX Audit — Day 1 Run Summary (2026-03-18)

**Tester:** AI Team (Eyes + Robot + Lead) + Manual (Ran)
**Viewports tested:** 1920x1080 (primary), element closeups
**Views tested:** Standard Week, Day, Month, By-Tech Grid Day, By-Tech Grid Week
**Test data:** Seed helper (4 scheduled jobs, 2 unassigned, 1 walkthrough) + manually created active tech + jobs

## Results

| Category | Scenarios | Pass | Fail/Finding | Skip | P0 | P1 | P2 |
|----------|----------|------|-------------|------|----|----|-----|
| N-A — Completed Event Protection | 4 | 4* | 0 | 0 | 4* | 0 | 0 |
| D — DnD Core | 12 | 6 | 4 | 2 | 0 | 3 | 1 |
| Visual Audit (screenshots) | 20 | 0 | 12 | 0 | 0 | 5 | 7 |
| Manual Testing (Ran) | 4 | 1 | 3 | 0 | 1 | 2 | 0 |
| **Day 1 Total** | **40** | **11** | **19** | **2** | **5** | **10** | **8** |

*N-01 through N-04 were P0 at discovery, fixed and verified same day.

## Fixes Applied (Before QA-Only Mode)

| Fix | Severity | File | Status |
|-----|----------|------|--------|
| `draggableAccessor`/`resizableAccessor` guard | P0 | SchedulePage.tsx | Fixed + Verified |
| `handleEventDrop`/`handleEventResize` status guard | P0 | SchedulePage.tsx | Fixed + Verified |
| `dragFromOutsideItem` null + start/end | P0 | SchedulePage.tsx | Fixed + Verified by Ran |
| `AssignJobDialog` UTC→local time conversion | P1 | AssignJobDialog.tsx | Fixed + Needs re-verify |
| Popover X buttons + click-outside handler | P1 | SchedulePage.tsx | Fixed + Needs re-verify |

## Open Findings (For Dev Team Report)

### P1 — Must Fix

| ID | Finding | File | Evidence |
|----|---------|------|----------|
| D-01 | cursor:pointer instead of cursor:grab on events | SchedulePage.tsx, schedule-dark.css | D-01_01, D-01_02 screenshots |
| D-03 | No cursor:grabbing during active drag | schedule-dark.css | D-06_03 screenshot |
| D-09 | TechnicianGridView cards not draggable | TechnicianGridView.tsx | D-09_01 to D-09_04 screenshots |
| V-01 | Conflict hatch pattern too aggressive, destroys readability | SchedulePage.tsx STATUS_STYLES | layout_week, layout_day, layout_member_grid_week screenshots |
| V-02 | Text truncation on 1-hour events, job numbers cut off | ScheduleEvent component | event_urgent_badge_closeup screenshot + Ran report |
| V-04 | Sidebar drag feedback insufficient | schedule-dark.css, EventContainerWrapper | dnd_sidebar_card_mid_drag screenshot |

### P2 — Polish

| ID | Finding | Evidence |
|----|---------|----------|
| D-06 | Click popup persists during drag | D-06_03, D-06_04 screenshots |
| V-03 | Member Grid Week view unusable (28 sub-cells too dense) | layout_member_grid_week screenshot |
| V-05 | Sidebar no search/filter for 61+ walkthrough items | sidebar_closeup screenshot |
| V-06 | Resize handle not visible at normal zoom | dnd_resize_handle_hover screenshot |
| V-07 | Plan Mode active state too subtle (no banner visible) | planmode_banner_active screenshot |
| V-08 | Month "+33 more" overflow | layout_month_view screenshot |
| V-09 | Ghost events in Plan Mode too faint | planmode_ghost_event screenshot |
| V-10 | Tooltip/popup/context menu text too small | event_hover_tooltip, event_click_popup screenshots |

## Screenshots Captured

**Location:** `frontend/e2e/screenshots/scheduler-audit/`

| Category | Count | Key Files |
|----------|-------|-----------|
| Layout views | 5 | layout_week/day/month/member_grid_day/week |
| Sidebar states | 6 | sidebar_normal/collapsed/closeup/card_closeups |
| Event details | 6 | event_tooltip/popup/context_menu/urgent/walkthrough |
| DnD states | 3 | dnd_event_mid_drag/sidebar_mid_drag/resize_hover |
| Plan Mode | 2 | planmode_banner/ghost |
| D-category steps | 32 | N-01_*, D-01_*, D-02_*, D-05_*, D-06_*, D-08_*, D-09_*, D-10_*, D-11_* |
| **Total** | **54** | |

## Process Notes

1. **Day 1 started with code-only analysis** — agents read code and reported findings without visual evidence. Mid-day correction: added screenshot-verify-proceed protocol.
2. **Screenshot protocol works.** Playwright captures step-by-step screenshots, agents read them visually and report what they see. Caught issues code analysis missed (popup persisting during drag, text truncation severity).
3. **Manual testing by Ran caught 2 critical issues** automated tests couldn't: sidebar drag broken in real browser (Playwright false positive), popover dismiss broken. This validates the need for human-in-the-loop testing.
4. **Test data pollution** from seed cleanup leaving inactive technicians. Jobs referencing inactive techs caused "Cannot assign to inactive technician" errors. Need better seed cleanup or test data isolation.
5. **Process changed to QA-only mode** after initial fixes. All future findings will be documented only, not fixed inline.

## Day 2 Plan

Continue with F-category (drop targets) and H-category (edge cases), using the screenshot-verify-proceed protocol on every scenario. All findings go to report files, no code changes.

**Scenarios remaining:** 155/195
**Categories remaining:** E, F, G, H, I, J, K, L, M, N (B through G)
