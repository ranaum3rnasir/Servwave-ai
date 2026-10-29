# F-09 — Sidebar to Grid Tech Column: Drop Zones Not Detected by Playwright

**Category:** F — DnD Drop Targets
**Severity:** P2 (Test infrastructure issue — may work in real browser)
**View(s) Affected:** By-Tech Grid Day
**Status:** NEEDS MANUAL VERIFICATION

## Steps Tested
1. Switched to Member View → Day
2. Searched for grid drop zones using `sp.getGridDropZones()` (locator `[data-hour]`)
3. Found 0 drop zones

## Visual Evidence Analysis

**F-09_01_grid_view.png:** The Member Grid Day view renders correctly. Shows 4 technician columns: E2E Tech-seed2-d2f, E2E Tech-seed1-d2f, Mike Rodriguez, E2E Tech-slo-mmuw7d3g, Test Technician. Each column has correctly positioned job cards with time ranges, job numbers, "Urgent" badges, customer names, and addresses. The layout is clean and professional.

**F-09_02_drop_zones.png:** Same view. The Playwright locator `[data-hour]` found 0 elements — meaning the drop zones don't use a `data-hour` attribute. The TechnicianGridView likely uses a different DOM structure for drop targets (class-based instead of data-attribute).

## Findings

1. **PASS (visual):** Grid Day view renders correctly with all expected elements.
2. **P2 (test infra):** The `getGridDropZones()` locator in `schedule.page.ts` targets `[data-hour]` which doesn't match the actual DOM structure. The Playwright POM needs to be updated to find the correct drop zone selectors.
3. **NEEDS MANUAL VERIFICATION:** The sidebar-to-grid drag path cannot be tested by Playwright until the drop zone locator is fixed. Ran should try dragging a sidebar card onto a specific tech column in Grid Day view.

## Suggested Fix (Test Infrastructure Only)
Update `schedule.page.ts` `getGridDropZones()` to use the correct selector. Inspect the TechnicianGridView DOM to find the hour-slot div selectors (likely class-based, e.g., `.h-24` or similar).

## Screenshots
- `F-09_01_grid_view.png`
- `F-09_02_drop_zones.png`
