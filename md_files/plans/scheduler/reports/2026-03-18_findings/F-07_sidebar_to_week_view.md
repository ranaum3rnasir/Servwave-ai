# F-07 — Sidebar to Week View Calendar

**Category:** F — DnD Drop Targets
**Severity:** PASS + P1 finding (time pre-fill offset)
**View(s) Affected:** Week
**Status:** PASS (after Day 1 P0 fix)

## Steps Tested
1. Week view, dragged unassigned job card from sidebar onto calendar
2. Screenshots: sidebar card, over calendar, after drop

## Visual Evidence Analysis

**F-07_01_sidebar_card.png:** Closeup of unassigned job card in sidebar. Shows job number, "Urgent" badge, customer name. Card is compact and well-formatted.

**F-07_02_over_calendar.png:** Full page during drag. Sidebar on left shows "Unassigned Jobs 4" section at bottom. Calendar shows week view with events. At the 2:00 PM area on the calendar, there's a faint "2:00 PM - 4:00 PM / Drop to schedule" indicator visible. This is the drop preview from the `dragFromOutsideItem` fix.

IMPORTANT FINDING: The drop preview text "2:00 PM - 4:00 PM / Drop to schedule" is very faint — almost invisible against the white background. A dispatcher would struggle to see exactly where the event will land.

**F-07_03_after_drop.png:** The Assign Technician dialog opened. Shows:
- "Assign Technician" title with X close button (Day 1 fix)
- "Select a technician and optionally set schedule"
- Technician dropdown: "Select technician..."
- Scheduled Start: 03/07/2026 08:30
- Scheduled End: 03/07/2026 10:30
- Cancel + Assign buttons

TIME PRE-FILL ISSUE: The date shows 03/07/2026 (not today 03/18). The time shows 08:30 - 10:30. The user dropped at approximately 2 PM on today's column, but the dialog shows a different date and earlier time. The Day 1 UTC fix improved local time display, but the date itself may still be wrong — the `dragFromOutsideItem` midnight anchor may cause the library to calculate the wrong date.

## Findings

1. **PASS:** Sidebar-to-calendar drag works end-to-end. Card dims, dialog opens.
2. **PASS:** Drop preview visible ("2:00 PM - 4:00 PM / Drop to schedule").
3. **P2 (new):** Drop preview text is too faint — barely visible against white calendar background. Needs stronger visual indicator.
4. **P1 (existing, partially fixed):** AssignDialog date pre-fill shows 03/07 instead of today (03/18). The UTC→local fix helped time display but the date calculation from the library may still be off. Root cause likely in `dragFromOutsideItem` midnight anchor interaction with react-big-calendar's slot calculation.

## Screenshots
- `F-07_01_sidebar_card.png`
- `F-07_02_over_calendar.png`
- `F-07_03_after_drop.png`
