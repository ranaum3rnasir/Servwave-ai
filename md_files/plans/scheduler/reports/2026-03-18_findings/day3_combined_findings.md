# Day 3 — Combined Findings

## N-15 — Month Button Hidden in Grouped View: PASS
Console: Standard view → Month visible: true. Member view → Month visible: false.
The Month button correctly hides when switching to Member View and reappears in Standard view.
Screenshots: `N-15_01_standard.png`, `N-15_02_member.png`

## N-05 — Slot Popover (Empty Slot Click): PASS
Screenshot `N-05_01_popover.png` shows the Day view after clicking an empty slot. A "Schedule a Job" popover appeared in the lower-right area of the calendar showing available jobs. The X close button (Day 1 fix) should be present. After pressing Escape, `N-05_02_dismissed.png` shows the popover is gone.
**PASS:** Slot popover appears and can be dismissed.

## N-18 — Overlay Stacking (Tooltip → Context Menu): PASS
`N-18_01_tooltip.png`: Tooltip visible after hovering on event.
`N-18_02_context_menu.png`: After right-click, context menu appeared. The tooltip is no longer visible — correct behavior (tooltip dismissed when context menu opens, as designed in line 559 of SchedulePage.tsx).
**PASS:** No overlay stacking issue between tooltip and context menu.

## G-01 — Resize Handle: PASS (handle exists) + FINDING
`G-01_01_bottom_hover.png`: Hovering at bottom edge of event. Console shows 124 resize handles found on the page (`.rbc-addons-dnd-resize-ns-anchor` elements) — the DnD addon creates one per event.
`G-01_02_resizing.png`: During resize drag, a click popup appeared (same issue as D-06 — popup fires during drag). The event content is visible showing "JOB-2026-0051 SCHEDULED" with customer details.
`G-01_03_after_resize.png`: After resize release. Need to check if the event height changed or snapped back.

**FINDINGS:**
- **P2 (existing D-06):** Click popup fires during resize drag, same as during move drag
- **P1 (likely):** Resize may also snap back like move drag — same persistence issue. Needs manual verification: @Ran try resizing an event and check if the new duration persists after refresh.

## J — Responsive Layouts: PASS with findings
**J_1440x900.png:** Sidebar visible, calendar fills remaining space. Layout clean.
**J_1366x768.png:** Sidebar visible, slightly tighter. Events still readable.
**J_1024x768.png:** Sidebar STILL visible at 1024px (lg breakpoint). The toolbar wraps to 2 lines — "Standard / Member View / Plan Mode" on line 1, "Open / All / Search / Day Week Month" on line 2. This wrapping creates extra vertical height consumption.

**FINDINGS:**
- **PASS:** Sidebar visible at all 3 viewports (all >= lg: 1024px).
- **P2:** At 1024x768, the toolbar wraps to 2 lines. The search input and view toggles move to a second row. This is functional but looks cramped. Consider collapsing the search into an icon at this breakpoint.
- **P2:** At 1024x768, event text in week view cells becomes very small and truncated. "9:0... Walkthr" and "10:0... Walkthr" are barely readable. The conflict hatch pattern is even more problematic at this size.

## N-20 — Off-Hours Dimming: INCONCLUSIVE
`N-20_01_morning.png`: Day view showing early hours. Hard to distinguish off-hours dimming at this zoom level — the entire calendar has events and red hatch patterns that dominate the visual.
`N-20_02_evening.png`: Same issue — the late evening area should show lighter background (#F8FAFC) compared to business hours, but at full-page zoom it's hard to verify the subtle color difference.

**NEEDS MANUAL VERIFICATION:** @Ran — in Day view, scroll to 6 AM area. Is there a visible background color difference between the 6 AM row and the 9 AM row? The off-hours dimming should be subtle but noticeable.
