# C-01/C-09/C-12 — Sidebar Space Utilization

**Category:** C — Sidebar Space Utilization
**Severity:** PASS (with P2 notes)
**View(s) Affected:** All views (sidebar is persistent)
**Status:** PASS

## Visual Evidence Analysis

### C-01 — Sidebar Width and Layout
**C-01_02_sidebar_closeup.png:** Sidebar is 240px wide (confirmed via console: `{"width":240,"height":976}`). This matches Tailwind's `w-60` class. Contains two sections: "Walkthroughs 66" at top and "Unassigned Jobs" below.

**PASS:** Width is appropriate — not too wide (stealing calendar space) or too narrow (truncating content). Cards fit within the sidebar width. No horizontal overflow.

### C-12 — Card Compactness
**C-01_03_job_card_closeup.png:** Unassigned job card shows job number in red (urgent) with lightning bolt icon, "Urgent" badge, customer name, location pin + city/state. The card is very compact — almost too compact. The job number text is partially cut off in this closeup (top of card cropped).

**C-01_04_wt_card_closeup.png:** Walkthrough card shows: "LEAD-2026-0188" in amber/orange link text, "E2E WT-mmwh89jg" customer name, pin icon + "Austin, TX". Clean layout, good hierarchy. The left amber border accent is a nice touch.

**Gap between cards:** 6px (console: `[C-12] Gap between sidebar cards: 6px`). This is compact — appropriate for high-density sidebar.

**PASS:** Cards are compact and well-formatted. 6px gap is efficient.

### C-09 — Section Collapse
**C-09_01_both_open.png:** Full page with both sections open. The walkthrough section scrolls internally.

**C-09_02_wt_collapsed.png:** Walkthroughs section collapsed (chevron points down). Unassigned Jobs section expanded below with 4 job cards visible: JOB-2026-0055, 0054, 0041, 0040. All showing "Urgent" badge, customer name, location. Below the 4 cards there's significant whitespace.

**P2 Finding:** When walkthroughs are collapsed and only 4 job cards exist, there's a large empty area below the cards. The jobs section stretches to fill the remaining space via `flex-1`, but the actual cards only take ~400px of the ~800px available. This whitespace is wasted. Consider either:
- Aligning cards to the top of the section (not stretching the container)
- Showing a helpful empty-state message in the white space ("Drag jobs to the calendar to assign them")

## Screenshots
- `C-01_01_full_layout.png`
- `C-01_02_sidebar_closeup.png`
- `C-01_03_job_card_closeup.png`
- `C-01_04_wt_card_closeup.png`
- `C-09_01_both_open.png`
- `C-09_02_wt_collapsed.png`
