# Needs-crew corner notch + amber double-booked + job type on card

Branch: `feat/schedule-event-colors` (continues the per-org colours commit 83f1c1ed8)
Date: 2026-09-14
Design canvas: https://claude.ai/code/artifact/c3da6686-44db-4917-9588-6a2ca434bbef (option 01 chosen)

## Decisions (owner, 2026-09-14)
1. **Corner Notch** is the needs-crew signal. The solid red card fill retires.
2. **Double-booked moves to amber.** Red then means exactly one thing on the board.
3. **No count chip** in this pass - stays on the canvas as a follow-up.
4. **Job type** renders on the job card, above the address.

## Assumptions stated
- The needs-crew RULE is unchanged: `eventDangerState` still fires on timed + zero crew. A
  required-headcount field ("needs 2 more") is a separate migration and is NOT in this pass, so the
  on-card words stay "needs crew".
- The notch is a real element (`role="img" aria-label="Needs crew"`), not a pseudo-element, for the
  same reason DoubleBookedMark is: it is testable and it names itself to a screen reader. It is
  absolutely positioned, so it still takes no layout box - the property the design was chosen for.

## Changes
### Shared
- `components/schedule/NeedsCrewMark.tsx` - the one notch element all three renderers mount.
- `styles/schedule-dark.css` - `.schedule-needs-crew-mark` triangle in `rgb(var(--understaffed))`
  with a 1px surface hairline (drop-shadow) so it separates from a red org colour.
- `design-system/tokens.css` - `--understaffed: var(--danger)` alias. The seam the design doc asked
  for: repoint the signal without hunting six renderers.
- Double-booked: `border-danger` -> `border-warning`, `text-danger` -> `text-warning` on the
  DoubleBookedMark icon and the outline, in both renderers and the legend.

### Standard view (`pages/v2/schedule/SchedulePage.tsx`)
- `eventStyleGetter`: DELETE the needs-crew early return (`!bg-danger !text-on-fill !border-0`).
  A needs-crew card now falls through to its type paint. Double-booked branch -> warning tokens.
- `ScheduleEvent`: mount `<NeedsCrewMark />` when `needsCrew`; job type row above the address,
  gated on the same size threshold as the address; words row unchanged.
- All-day pill: the notch at a smaller size (the pill is 22px tall) - still no words (#1734 guard).

### Member boards (`components/schedule/ScheduleCardBody.tsx`)
- `scheduleCardPaintClass`: needs-crew no longer returns `bg-danger text-on-fill`; it returns the
  scheme paint like every other card. Double-booked outline -> warning.
- Text colour branches lose the `needsCrew ? 'text-on-fill'` arms.
- Mount `<NeedsCrewMark />`; job type line above the address row.

### Overflow panel, peek card, editor, legend
- `AllDayOverflow` row: words stay. Legend swatch: a small notch instead of a red square; the
  double-booked swatch goes amber. Peek/editor text pills unchanged (already not fills).

## Tests
- `ScheduleCardBody.test.tsx`: NEW needs-crew case (the gap flagged in the code map) - notch
  present by label, NO `bg-danger`, scheme paint kept, job type rendered above address.
- `MemberWeekBoard.test.tsx` / `TechnicianGridView.test.tsx`: negative `bg-danger` assertions still
  hold; double-booked label assertions unchanged; add positive `getByLabelText(/needs crew/i)`.
- `allDayPillContent.test.tsx`: the pill must still NOT contain the words - unchanged and must stay
  green (the notch has no text content, only an aria-label, so `queryByText` cannot see it).
- `AllDayOverflow.test.tsx`: unchanged.
- Guards: no hex, no palette class, no inline appearance literal.
