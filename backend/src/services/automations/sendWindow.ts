/**
 * sendWindow.ts — pure send-window math for automation runs.
 *
 * BUSINESS_HOURS = 08:00–20:00 in the ORG's IANA timezone (TCPA-quiet-hours
 * shaped: federal rule is 8am–9pm recipient-local; we stop at 20:00 to clear
 * the stricter state floors). A fire time outside the window is DEFERRED to
 * the next 08:00 local — never dropped.
 *
 * No date library: local wall-clock is read via Intl.formatToParts and the
 * local→UTC conversion converges by offset correction (DST-safe; 08:00 always
 * exists — US DST transitions happen at 2–3am).
 */

import { AutomationSendWindow } from '@prisma/client';
import { DEFAULT_TIMEZONE } from '../../lib/timezone';

const WINDOW_START_HOUR = 8; // 08:00 local
const WINDOW_END_HOUR = 20;  // exclusive — 20:00 local is already outside

/**
 * Organization.timezone is free-text and unvalidated, so a garbage value would
 * otherwise throw a RangeError deep in Intl — and because window-shifting runs
 * BEFORE the run row is created, that throw would silently drop the automation.
 * Fall back to the default zone instead. (Mirrors context.ts's fmtDate guard.)
 */
function safeTimeZone(tz: string): string {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return tz;
  } catch {
    return DEFAULT_TIMEZONE;
  }
}

interface WallClock {
  y: number; mo: number; d: number; h: number; mi: number; s: number;
}

function wallClockIn(date: Date, timeZone: string): WallClock {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hour12: false,
  }).formatToParts(date);
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? '0');
  // Intl reports midnight as hour 24 in some engines — normalize.
  const rawHour = get('hour');
  return { y: get('year'), mo: get('month'), d: get('day'), h: rawHour === 24 ? 0 : rawHour, mi: get('minute'), s: get('second') };
}

/** UTC instant for a given local wall-clock time in `timeZone`. */
function utcForLocal(y: number, mo: number, d: number, h: number, timeZone: string): Date {
  const desired = Date.UTC(y, mo - 1, d, h, 0, 0);
  let utc = desired; // first guess: pretend the wall time IS utc
  for (let i = 0; i < 3; i++) {
    const w = wallClockIn(new Date(utc), timeZone);
    const actual = Date.UTC(w.y, w.mo - 1, w.d, w.h, w.mi, w.s);
    const diff = desired - actual;
    if (diff === 0) break;
    utc += diff;
  }
  return new Date(utc);
}

/**
 * Shift `fireAt` into the rule's send window. Inside the window (or ANYTIME)
 * returns the input unchanged; otherwise returns the next 08:00 org-local.
 */
export function shiftIntoWindow(
  fireAt: Date,
  window: AutomationSendWindow,
  timeZoneInput: string,
): Date {
  if (window === 'ANYTIME') return fireAt;

  const timeZone = safeTimeZone(timeZoneInput);
  const w = wallClockIn(fireAt, timeZone);
  if (w.h >= WINDOW_START_HOUR && w.h < WINDOW_END_HOUR) return fireAt;

  if (w.h < WINDOW_START_HOUR) {
    return utcForLocal(w.y, w.mo, w.d, WINDOW_START_HOUR, timeZone);
  }
  // Past 20:00 local — next day 08:00 local. Roll the date via UTC-noon
  // arithmetic on the local calendar date to avoid month-length bookkeeping.
  const next = new Date(Date.UTC(w.y, w.mo - 1, w.d, 12) + 24 * 60 * 60 * 1000);
  return utcForLocal(next.getUTCFullYear(), next.getUTCMonth() + 1, next.getUTCDate(), WINDOW_START_HOUR, timeZone);
}
