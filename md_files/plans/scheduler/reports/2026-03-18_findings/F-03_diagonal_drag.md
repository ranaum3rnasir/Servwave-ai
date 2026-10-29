# F-03 — Diagonal Drag (Different Day + Different Time)

**Category:** F — DnD Drop Targets
**Severity:** PASS (with conflict)
**View(s) Affected:** Week
**Status:** PASS

## Steps Tested
1. Week view, dragged 2 PM event diagonally (right + up) ~150px right, ~100px up
2. Screenshots before, during, after

## Visual Evidence Analysis

**F-03_01_before.png:** 2 PM event visible in today's column.

**F-03_02_mid_drag.png:** During diagonal drag — similar to F-02, the calendar shows the week view with events. The drag is moving toward an earlier time on a different day.

**F-03_03_after_drop.png:** Conflict dialog appeared — "Scheduling Conflict / Schedule conflict detected". Shows "WT LEAD-2026-0183 1:00 PM - 2:00 PM" as conflicting (a walkthrough event). Buttons: Cancel + Schedule Anyway. This confirms the diagonal drop landed at the walkthrough's time slot on a different day.

## Findings

1. **PASS:** Diagonal drag works — both date AND time changed in a single drag operation.
2. **PASS:** Conflict detection correctly identifies the walkthrough event at the target position.
3. **NOTE:** The conflict shows a walkthrough (WT prefix), not a job. Cross-entity conflict detection between jobs and walkthroughs is working.

## Screenshots
- `F-03_01_before.png`
- `F-03_02_mid_drag.png`
- `F-03_03_after_drop.png`
