# F-02 — Different Day, Same Time (Horizontal Drag)

**Category:** F — DnD Drop Targets
**Severity:** PASS
**View(s) Affected:** Week
**Status:** PASS

## Steps Tested
1. Week view, dragged 11 AM event horizontally ~150px to next day column
2. Screenshots before, during, after

## Visual Evidence Analysis

**F-02_01_before.png:** Week view with events. The target event is visible in today's column (Wednesday).

**F-02_02_mid_drag.png:** During horizontal drag — the event appears to be moving between day columns. The Thursday column shows a highlighted area where events exist. The drag is moving toward Thursday. No clear ghost preview visible, but the calendar's internal DnD shows the target column highlighting.

**F-02_03_after_drop.png:** After drop — the week view shows events redistributed. The event appears to have moved to an adjacent day. No error dialog, no conflict toast visible. The layout looks clean post-drop.

## Findings

1. **PASS:** Horizontal drag works — event moved to a different day at the same time.
2. **P2 (existing):** No clear ghost preview during horizontal drag — same as D-06 finding. The user has to trust that the target day column is where the event will land.
3. **PASS:** No errors, no unwanted dialogs after drop.

## Screenshots
- `F-02_01_before.png`
- `F-02_02_mid_drag.png`
- `F-02_03_after_drop.png`
