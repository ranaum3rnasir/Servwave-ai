# V-01 — Conflict Hatch Pattern Too Visually Aggressive

**Category:** K — Visual Hierarchy & Readability
**Severity:** P1 (Feels Wrong)
**View(s) Affected:** Week, Day, Member Grid Week
**Viewport(s):** All
**Status:** OPEN

## Steps to Reproduce
1. Navigate to /schedule with overlapping events on the same technician
2. View in Week or Day mode
3. Observe the red diagonal stripe pattern on conflicting events

## Expected Behavior (Google Calendar Reference)
Google Calendar uses a subtle side indicator (small colored bar or icon) for overlapping events. The event text remains fully readable.

## Actual Behavior
Conflicting events get a red diagonal hatch pattern that covers the ENTIRE event block background. The stripes are dense and visually noisy — they dominate the visual hierarchy over the actual event content (job number, customer name, time). Text underneath becomes nearly illegible.

## Evidence
- Screenshot: `layout_week_view_1920x1080.png` — Wed/Thu columns show red-hatched events, text barely legible
- Screenshot: `layout_day_view_1920x1080.png` — same hatch pattern in day view, obscures text
- Screenshot: `layout_member_grid_week_1920x1080.png` — hatched events are just red noise blocks with zero readable text

## Impact
HIGHEST IMPACT visual issue. Affects 3 of 5 layout views. When a dispatcher has scheduling conflicts (common during busy days), the very events they need to read become the hardest to read. This is backwards — conflicts should be highlighted but still readable.

## Suggested Fix Direction
Replace the diagonal hatch pattern with a subtler conflict indicator:
1. Orange/amber left border (3-4px, solid) — same as the current walkthrough border pattern
2. Small "Conflict" badge or warning icon in the event corner
3. Keep the event background as its normal status color (blue for scheduled, etc.)
4. The `STATUS_STYLES.conflict` object in `SchedulePage.tsx` controls this styling

This single fix would also improve findings V-02 (text illegibility) and V-03 (member grid week unusable) since those are largely caused by the hatch pattern.
