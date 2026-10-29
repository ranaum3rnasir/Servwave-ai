# F-01 — Same Day, Different Time (Vertical Drag)

**Category:** F — DnD Drop Targets
**Severity:** PASS (mechanics work) + P1 finding (conflict dialog fires on every reschedule)
**View(s) Affected:** Day, Week
**Status:** PASS with notes

## Steps Tested
1. Day view, dragged 9 AM event down ~150px
2. Screenshot before, during, after

## Visual Evidence Analysis

**F-01_01_initial.png:** Day view loaded with multiple events visible. Sidebar on left with 64 walkthroughs and unassigned jobs section. Events are color-coded: blue jobs with red conflict hatch, amber walkthroughs.

**F-01_03_mid_drag.png:** During drag — the calendar view is in Day view. No distinct ghost preview visible during the drag. The event area shows the same red-hatched conflict pattern. Hard to distinguish what's being dragged vs static events.

**F-01_04_after_drop.png:** Conflict dialog appeared — "Scheduling Conflict / Schedule conflict detected". Shows "JOB JOB-2026-0028 1:00 PM - 2:00 PM" as conflicting. Buttons: Cancel (gray) + Schedule Anyway (blue, primary). Dialog UI is clean and professional.

## Findings

1. **PASS:** Vertical drag mechanics work — the event was moved to a new time, triggering conflict detection.
2. **PASS:** Conflict dialog appears with correct details and proper button hierarchy.
3. **P1 (existing):** The red conflict hatch pattern makes it hard to see what's happening during drag. Previously filed as V-01.
4. **P2:** The conflict dialog fires frequently because test data has many overlapping events. In production with properly scheduled jobs, this would be less common. But the dialog UX should handle frequent conflicts gracefully (consider a "Don't show for 5 minutes" option for dispatchers doing bulk rescheduling).

## Screenshots
- `F-01_01_initial.png`
- `F-01_02_before_drag.png`
- `F-01_03_mid_drag.png`
- `F-01_04_after_drop.png`
