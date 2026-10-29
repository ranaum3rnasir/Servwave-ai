# V-03 — Member Grid Week View Is Essentially Unusable

**Category:** K — Visual Hierarchy & Readability
**Severity:** P2 (Polish — downgraded from P1, Standard Week view is the alternative)
**View(s) Affected:** Member Grid Week (MemberWeekBoard)
**Viewport(s):** 1920x1080
**Status:** OPEN (DEFERRED)

## Steps to Reproduce
1. Navigate to /schedule
2. Switch to Member View → Week view
3. Observe the layout with 4+ technicians

## Expected Behavior
Each technician's week should show readable event cards organized by day.

## Actual Behavior
With 4 technicians x 7 days, the grid creates 28 sub-cells. Each cell is extremely narrow. Event blocks are so compressed that NO text is readable — not job numbers, not customer names, nothing. The conflict-hatched events appear as pure red noise blocks. Day labels within each column consume significant vertical space, reducing the area for events.

## Evidence
- Screenshot: `layout_member_grid_week_1920x1080.png` — entire view, all text illegible

## Impact
Medium. Dispatchers have the Standard Week view as a better alternative for week-level planning. The Member Grid Day view (which IS excellent) handles the per-tech daily view well. The Grid Week view is a "nice to have" that's currently more confusing than helpful.

## Suggested Fix Direction
Two options:
1. **Simplify:** In Grid Week, show only event counts or colored dots per day instead of trying to render full event cards
2. **Improve:** Make tech columns wider with horizontal scroll, so each day sub-cell has enough width for readable cards

This was downgraded to P2 because dispatchers have Standard Week view as a functional alternative.
