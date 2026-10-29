/**
 * The empty-slot popover's clock.
 *
 * This module exists because the v2 fork of the card dropped the `tz` prop the v1 twin
 * takes and fell back to the browser: `new Date(iso); d.setHours(h,m,0,0);
 * d.toISOString()`. `setHours` resolves against the VIEWER, so a Manila dispatcher
 * clicking the 9:00 AM slot on a New York org's board wrote 01:00Z - twelve hours out
 * and on the previous calendar day - and on the lead walkthrough path that value was
 * persisted with no confirming dialog to catch it (MV-TZ-02).
 *
 * The correction lives here rather than inside the card for the same reason #1551's four
 * scheduling fields were pulled into `scheduleTimeValue.ts`: a fix that lives inside one
 * fork is a fix a fork can silently revert, and here the DEAD tree was the correct one
 * while the routed tree leaked. (The v1 twin that held the correct version has since been
 * deleted with the rest of the unrouted v1 schedule page; this module is what outlived
 * it.) `tz` is a REQUIRED parameter on every function below, so a caller that forgets to
 * thread it fails to compile.
 *
 * Every conversion goes through `lib/schedule-tz`, which brands Instant against
 * WallClock; nothing here does its own offset arithmetic.
 */
import { format } from 'date-fns';

import { toWallClock, wallClockToIso } from '@/lib/schedule-tz';

/** An instant, as the 'HH:mm' the ORG calls it. Feeds TimeSelect's zoneless value. */
export function isoToHHmm(iso: string, tz: string): string {
  return format(toWallClock(new Date(iso), tz), 'HH:mm');
}

/**
 * Move `iso` to the org wall-clock time `hhmm`, keeping its org calendar DAY.
 *
 * The day is taken from the instant as the org reads it, not as UTC or the viewer reads
 * it, so a 9:00 PM org slot correctly lands on the next UTC day without moving in the
 * org's own calendar.
 */
export function withTime(iso: string, hhmm: string, tz: string): string {
  const [h = 0, m = 0] = hhmm.split(':').map(Number);
  const wc = toWallClock(new Date(iso), tz);
  wc.setHours(h, m, 0, 0);
  return wallClockToIso(wc, tz);
}

/** U+2013 EN DASH - the range separator, escaped per schedule/glyphs.ts. */
const EN = '\u2013';

/**
 * The popover header's "9:00 AM - 11:00 AM". Rendered on the ORG clock so the popover
 * names the same slot as the calendar row it opened over; the leaking version labelled a
 * 9:00 AM slot "9:00 PM to 11:00 PM" for a Manila viewer before any edit was made.
 */
export function slotTimeLabel(startIso: string, endIso: string, tz: string): string {
  const start = format(toWallClock(new Date(startIso), tz), 'h:mm a');
  const end = format(toWallClock(new Date(endIso), tz), 'h:mm a');
  return `${start} ${EN} ${end}`;
}
