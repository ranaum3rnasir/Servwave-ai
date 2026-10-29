# D-10 — Sidebar Drag to Calendar: AssignDialog Time Pre-fill Shows UTC Instead of Local

**Category:** D — DnD Core / F — Drop Targets
**Severity:** P1 (Feels Wrong)
**View(s) Affected:** Week, Day (Standard view)
**Viewport(s):** All
**Status:** FIXED (during Day 1, before QA-only mode)

## Steps to Reproduce
1. Navigate to /schedule, Week view
2. Drag an unassigned job from the sidebar to a specific time slot (e.g., 7:00 AM Monday)
3. Observe the Assign Technician dialog times

## Expected Behavior
Dialog should show Scheduled Start: 03/16/2026 07:00 and Scheduled End: 03/16/2026 09:00 (matching the drop position).

## Actual Behavior (Before Fix)
Dialog showed Scheduled Start: 03/16/2026 11:00 and Scheduled End: 03/16/2026 13:00 — a +4 hour offset (EDT = UTC-4).

Root cause: `AssignJobDialog.tsx` line 53 used `defaultStart.slice(0, 16)` to populate the `datetime-local` input. This sliced the ISO string `2026-03-16T11:00:00.000Z` to `2026-03-16T11:00`, displaying UTC hours directly. The `datetime-local` input interprets this as local time, so 11:00 UTC was displayed as 11:00 local instead of being converted to 07:00 EDT.

## Evidence
- User report: Ran dropped at 7 AM, dialog showed 11 AM (screenshot provided in Slack)
- Console: `[handleDropFromOutside] start: 2026-03-16T11:00:00.000Z` — library passes correct UTC
- The library's `closestSlotFromPoint()` correctly calculates the drop slot from cursor position

## Fix Applied
Added `toLocalDatetimeString()` helper in `AssignJobDialog.tsx` that creates a `Date` object (auto-converts to local tz) then formats as `YYYY-MM-DDTHH:MM`:
```js
const toLocalDatetimeString = (iso: string): string => {
  const d = new Date(iso);
  const pad = (n: number) => n.toString().padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
};
```

## Note
This was a pre-existing bug that affected ALL time pre-fills in AssignJobDialog, not just the sidebar drag. Any code path that passes an ISO string as `defaultStart`/`defaultEnd` would have shown UTC times. The fix corrects all paths.
