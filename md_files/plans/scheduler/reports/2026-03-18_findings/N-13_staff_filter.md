# N-13/N-14 — Staff Filter: Technicians / Sales / All

**Category:** N-E — Staff Filter & View Constraints
**Severity:** PASS + P1 finding (Sales filter shows empty state)
**Status:** PARTIAL PASS

## Visual Evidence Analysis

**N-13_01_all.png:** Grid Day view with "All" filter. Shows 3 technician columns: Mike Rodriguez, E2E Tech-slo-mmuw7d3g, Test Technician. Jobs visible on Mike's column (8 AM, 10 AM, 1 PM). Clean layout.

**N-13_02_techs.png:** "Technicians" filter selected. Same 3 columns visible. Dropdown shows "Technicians" text. Looks identical to "All" — because all visible staff ARE technicians in this dataset.

**N-13_03_sales.png:** "Sales" filter selected. Calendar shows "No active staff members found." message in the center. The sidebar remains visible with walkthroughs. No columns rendered.

## Findings

1. **PASS:** Staff filter dropdown is visible and functional in Member View.
2. **PASS:** Technicians filter shows only tech columns.
3. **P1 FINDING:** Sales filter shows "No active staff members found." This is accurate for the current dataset (no active SALES users), but the empty state message could be more helpful. It doesn't tell the dispatcher HOW to add sales users or that no sales users exist. Consider: "No active sales staff. Sales users can be added in Settings → Users."
4. **PASS:** Filter dropdown correctly shows in the toolbar only when Member View is active (not visible in Standard view).

## Screenshots
- `N-13_01_all.png`, `N-13_02_techs.png`, `N-13_03_sales.png`
