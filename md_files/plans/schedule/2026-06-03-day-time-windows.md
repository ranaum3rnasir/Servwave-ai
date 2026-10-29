# Schedule — Time-of-day windows + side-by-side lanes

**Date:** 2026-06-03
**File touched:** `frontend/src/pages/SchedulePage.tsx` (single file, ~40 lines)
**Status:** Done, verified in preview.

## Problem
A typical day has ~20 jobs. The Standard Day view crams the whole day (00:00–23:59)
into the viewport, so jobs are short and same-hour clusters (e.g. five jobs at 10 AM)
are hard to read.

## Solution
Three-way time-of-day window selector in the toolbar (next to Day/Week/Month):

| Preset    | Visible range  | Effect |
|-----------|----------------|--------|
| Full day  | 00:00–23:59 (scroll 6 AM) | unchanged default |
| Morning   | 7:00 AM – 12:00 PM | ~5h band → each hour ~3× taller |
| Afternoon | 12:00 PM – 6:00 PM | 6 PM (not 5) so ~5:30 PM jobs aren't clipped |

Narrowing the calendar's `min`/`max` makes react-big-calendar fit fewer hours into the
same height, so events grow and become legible.

Same-hour clarity: `dayLayoutAlgorithm="no-overlap"` splits concurrent jobs into equal
side-by-side columns (no event covers another).

## Implementation notes
- New state: `timeWindow: 'full' | 'morning' | 'afternoon'` (default `'full'`).
- `calendarMin` / `calendarMax` / `scrollToTime` derived from `timeWindow` via one memo.
- `windowedEvents` memo filters out-of-window timed events before passing to the calendar
  (react-big-calendar otherwise clamps them to the top/bottom edge as slivers). All-day
  events and Month view are exempt from the filter.
- Control is shown only in **Standard view**, **Day/Week** (hidden in Month — no hourly
  grid — and in Member view, which already separates jobs into per-technician columns).
- `dayLayoutAlgorithm="no-overlap"` added to `<DnDCalendar>`.

## Possible follow-ups (not built)
- Carry the window into Member view (custom grid components don't read `min`/`max`).
- Keyboard shortcuts for the window (mirroring 1/2/3 for views).
- Persist last-used window per user.
