# V-02 — Text Truncation on Short (1-Hour) Events

**Category:** A — Text & Content Overflow
**Severity:** P1 (Feels Wrong)
**View(s) Affected:** Week, Day, Grid Day
**Viewport(s):** All
**Status:** OPEN

## Steps to Reproduce
1. Navigate to /schedule with 1-hour events on the calendar
2. View in Week mode
3. Observe the text inside short event blocks

## Expected Behavior
Job numbers (the primary identifier dispatchers use) should ALWAYS be fully visible. Customer name and address can truncate with ellipsis, but job number must never be cut off.

## Actual Behavior
On 1-hour event blocks, text is cramped and truncated:
- Job number "JOB-2026-" gets cut off (trailing digits missing, no ellipsis)
- Customer name truncated mid-word
- Address truncated mid-word
- When multiple events share a time slot, they stack narrower and truncation worsens

## Evidence
- Screenshot: `event_urgent_badge_closeup.png` — "JOB-2026-" truncated, customer "Badge Cont..." cut off
- Screenshot: `F-01_02_event_before_drag.png` — two overlapping events, both job numbers partially obscured
- User report: Ran confirmed 1-hour events have illegible text

## Impact
Dispatchers rely on job numbers to identify which job is which. If "JOB-2026-0028" displays as "JOB-2026-" they can't distinguish it from "JOB-2026-0029". They'd need to click each event to see the full number — defeating the purpose of the visual calendar.

## Suggested Fix Direction
1. **Priority text layout:** Job number on line 1 (bold, never truncated). Customer name on line 2 (can truncate with ellipsis). Address on line 3 (can truncate or hide on short events).
2. **Minimum event height:** For events < 1 hour, show only the job number and time. Hide customer/address to avoid illegible cramming.
3. **Tooltip for full content:** Already exists (hover tooltip with 350ms delay), but the event block itself should show the job number at minimum.
4. The `ScheduleEvent` custom component (used in `calendarComponents`) controls event rendering.
