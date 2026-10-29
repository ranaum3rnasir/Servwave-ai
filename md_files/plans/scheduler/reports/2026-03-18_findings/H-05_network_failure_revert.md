# H-05 — Network Failure on Drop: Event Reverts + Error Toast

**Category:** H — DnD Edge Cases
**Severity:** PASS (with P2 note)
**View(s) Affected:** Day, Week
**Status:** PASS

## Steps Tested
1. Day view, blocked `/api/jobs/*/assign` API route
2. Dragged event down ~120px
3. Released

## Visual Evidence Analysis

**H-05_01_before.png:** Event at original position in Day view.

**H-05_02_after_failed_drop.png:** After drop with network blocked. The event appears at its original position (delta: 0px). In the bottom-right corner, a red error toast is visible: "Error — Failed to schedule job. Please try again." with a "Dismiss" button. The error toast has correct styling: red background, error icon, clear message, dismiss button.

**H-05_03_final_state.png:** Same as step 2 — error toast still visible, event at original position.

## Findings

1. **PASS:** Event reverted to original position after network failure (0px delta).
2. **PASS:** Error toast appeared with clear message "Failed to schedule job. Please try again."
3. **PASS:** Toast has a "Dismiss" button.
4. **P2:** The error toast message says "Failed to schedule job" which is slightly wrong — this was a REschedule (moving an existing event), not a new schedule. The message should differentiate. Minor wording issue.
5. **PASS:** No data corruption — the event stayed at its original position, no orphaned state.

## Screenshots
- `H-05_01_before.png`
- `H-05_02_after_failed_drop.png`
- `H-05_03_final_state.png`
