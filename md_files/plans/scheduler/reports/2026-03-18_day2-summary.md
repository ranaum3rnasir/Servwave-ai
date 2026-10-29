# Day 2 Final Summary — 2026-03-18

## Categories Tested
- F — DnD Drop Targets (F-01, F-02, F-03, F-07, F-09, F-10, F-11, F-12, F-13, F-14)
- H — DnD Edge Cases (H-05, H-13/H-14, H-17, H-18)
- L — Context Menu Actions (L-05b, L-05c)
- Manual Testing by Ran (4 items + follow-ups)

## Results

| Metric | Day 2 | Cumulative |
|--------|-------|-----------|
| Scenarios tested | 16 automated + 6 manual | 62/195 (32%) |
| Screenshots captured | 34 | 88 |
| Finding reports filed | 7 new + REQ-01 | 24 total |
| P0 | 1 new (snap-back data issue) | 6 found, 5 fixed, 1 open |
| P1 | 5 new | 16 found, 4 fixed, 12 open |
| P2 | 2 new | 14 open |

## Key Discoveries

1. **REQ-01 (Product Requirement):** "Every object on the scheduler must behave the same." Jobs and walkthroughs must have identical DnD behavior everywhere. This is the governing principle for all future work.

2. **P0-03 (Updated):** Drag-to-reschedule returns 200 but data does NOT persist. After refresh, the walkthrough is at the original position. The save isn't working despite the success response.

3. **H-13:** Plan Mode doesn't create ghosts when dragging existing calendar events. Only sidebar→calendar creates ghosts. Plan Mode is half-implemented.

4. **Grid view is non-functional for DnD:** Can't drag within grid, can't drop from sidebar, walkthroughs can't drag at all.

5. **Plan Mode not persistent:** Refresh loses all staged changes.

## All Open Findings (for Dev Team)

### P0 — Blockers
| ID | Finding |
|----|---------|
| P0-03 / RAN-03 | Drag-to-reschedule: API returns 200 but data doesn't persist. Event at original position after refresh. |

### P1 — Must Fix
| ID | Finding |
|----|---------|
| REQ-01 | All objects must be draggable — sidebar walkthroughs, grid cards, everything |
| D-01 | cursor:pointer instead of cursor:grab on calendar events |
| D-03 | No cursor:grabbing during active drag |
| D-09 | Grid view cards not draggable (jobs and walkthroughs) |
| F-09 | Sidebar → Grid drop zones blocked (cursor shows "not-allowed") |
| V-01 | Conflict hatch pattern too aggressive — destroys text readability |
| V-02 | Job number truncation on short (1-hour) events |
| V-04 | Sidebar drag preview too faint |
| H-13 | Plan Mode drag on real events fires live API instead of ghost |
| H-17/RAN-01 | Plan Mode not persistent after page refresh |
| RAN-01-3a | Plan Mode not visually distinguishable |
| RAN-01-3b | DnD events snap back in both Plan Mode and Live Mode |

### P2 — Polish
| ID | Finding |
|----|---------|
| D-06 | Click popup persists during drag |
| V-03 | Member Grid Week view unusable (too dense) |
| V-05 | Sidebar no search/filter for 61+ items |
| V-06 | Resize handle not visible at normal zoom |
| V-07 | Plan Mode active state too subtle |
| V-08 | Month "+33 more" overflow |
| V-09 | Ghost events too faint |
| V-10 | Tooltip/popup text too small |
| F-07-preview | "Drop to schedule" text too faint |
| H-05-msg | Error toast says "schedule" not "reschedule" |
| RAN-01-3c | No confirmation modal for rescheduling (design decision) |
| sidebar-wt-hint | Add "Click to schedule" hint on walkthrough sidebar cards |
