// The ONE scheduling shape every surface edits: a start day + start time and an end day
// + end time. Before this, the board popover and the drop modal asked for date + start +
// DURATION (no end at all) while the job dialog and the job form asked for a start and an
// end - the same act of scheduling, described two different ways depending on where you
// clicked. There is no duration control anywhere now; the two surfaces that still STORE
// a duration (the board's own save contract, and a walkthrough's
// `walkthrough_duration_minutes`) derive it here from the two ends.
//
// Every field here is ZONELESS WALL CLOCK ('YYYY-MM-DD' / 'HH:mm'), the same contract
// DatePicker/TimeCombobox already speak and the same one `lib/schedule-tz` converts at
// the API seam. All arithmetic below runs in UTC deliberately: it is calendar math on a
// wall clock, so "+2 hours" must stay 2 hours across a DST boundary rather than becoming
// 1 or 3 the way a local-time Date would.

export interface ScheduleTimeValue {
  /** Start day, 'YYYY-MM-DD' ('' when unset). */
  date: string;
  /** Start time, 'HH:mm' 24-hour ('' when unset). */
  startTime: string;
  /** End day, 'YYYY-MM-DD' ('' when unset). Equals `date` for the ordinary same-day case. */
  endDate: string;
  /** End time, 'HH:mm' 24-hour ('' when unset). */
  endTime: string;
}

export const EMPTY_SCHEDULE_TIME: ScheduleTimeValue = {
  date: '',
  startTime: '',
  endDate: '',
  endTime: '',
};

const DAY_MS = 86_400_000;
const DAY_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const TIME_RE = /^(\d{1,2}):(\d{2})$/;

/** Wall-clock day+time as a UTC instant, or null if either half is unset/partial. */
function toStamp(day: string, time: string): number | null {
  const d = DAY_RE.exec(day);
  const t = TIME_RE.exec(time);
  if (!d || !t) return null;
  return Date.UTC(Number(d[1]), Number(d[2]) - 1, Number(d[3]), Number(t[1]), Number(t[2]));
}

function fromStamp(stamp: number): { day: string; time: string } {
  const iso = new Date(stamp).toISOString();
  return { day: iso.slice(0, 10), time: iso.slice(11, 16) };
}

/** Whole days from the start day to the end day; 0 when either is unset. */
function dayOffsetOf(value: ScheduleTimeValue): number {
  const start = toStamp(value.date, '00:00');
  const end = toStamp(value.endDate, '00:00');
  if (start === null || end === null) return 0;
  return Math.round((end - start) / DAY_MS);
}

/** Minutes from start to end, or null when either end is unset or the range is inverted. */
export function durationMinutesOf(value: ScheduleTimeValue): number | null {
  const start = toStamp(value.date, value.startTime);
  const end = toStamp(value.endDate, value.endTime);
  if (start === null || end === null) return null;
  const minutes = Math.round((end - start) / 60_000);
  return minutes > 0 ? minutes : null;
}

/** Moves the END to `minutes` after the start, leaving the start untouched. */
export function withDurationMinutes(value: ScheduleTimeValue, minutes: number): ScheduleTimeValue {
  const start = toStamp(value.date, value.startTime);
  if (start === null || minutes <= 0) return value;
  const { day, time } = fromStamp(start + minutes * 60_000);
  return { ...value, endDate: day, endTime: time };
}

/**
 * Sets the end TIME, keeping whatever day span the value already has. An end time that
 * would land on or before the start rolls forward a day, which is what "8:00 PM to 1:00
 * AM" means to the person typing it - the alternative (a negative duration) is never a
 * thing anyone meant.
 */
export function withEndTime(value: ScheduleTimeValue, endTime: string): ScheduleTimeValue {
  const start = toStamp(value.date, value.startTime);
  if (start === null || !TIME_RE.test(endTime)) return { ...value, endTime };
  const offset = Math.max(dayOffsetOf(value), 0);
  const sameSpan = toStamp(value.date, endTime);
  if (sameSpan === null) return { ...value, endTime };
  const candidate = sameSpan + offset * DAY_MS;
  const stamp = candidate > start ? candidate : candidate + DAY_MS;
  const { day, time } = fromStamp(stamp);
  return { ...value, endDate: day, endTime: time };
}

/** Sets the end DAY outright (multi-day surfaces only); the end time is left alone. */
export function withEndDate(value: ScheduleTimeValue, endDate: string): ScheduleTimeValue {
  return { ...value, endDate };
}

/** Moves the start DAY, dragging the end with it so the duration survives the edit. */
export function withStartDate(value: ScheduleTimeValue, date: string): ScheduleTimeValue {
  const minutes = durationMinutesOf(value);
  const next = { ...value, date };
  if (minutes === null) {
    // No usable range yet (a half-filled form): keep the end on the start day so the
    // two dates cannot silently drift apart.
    return { ...next, endDate: value.endDate === value.date || !value.endDate ? date : value.endDate };
  }
  return withDurationMinutes(next, minutes);
}

/** Moves the start TIME, dragging the end with it so the duration survives the edit. */
export function withStartTime(value: ScheduleTimeValue, startTime: string): ScheduleTimeValue {
  const minutes = durationMinutesOf(value);
  const next = { ...value, startTime };
  return minutes === null ? next : withDurationMinutes(next, minutes);
}

/**
 * A fully-set range whose end is not after its start. Reachable only by editing the end
 * DATE backwards - an end time before the start on the same day rolls the end date
 * forward instead (`withEndTime`), which the end-date field shows.
 */
export function isInvertedRange(value: ScheduleTimeValue): boolean {
  const start = toStamp(value.date, value.startTime);
  const end = toStamp(value.endDate, value.endTime);
  if (start === null || end === null) return false; // half-filled is not yet wrong
  return end <= start;
}

/** The day after `day` ('YYYY-MM-DD'), as pure calendar arithmetic. Deliberately NOT
 *  `instant + 24h`, which is wrong by an hour on either DST transition. */
export function nextDay(day: string): string {
  const [y, m, d] = day.split('-').map(Number);
  return new Date(Date.UTC(y!, m! - 1, d! + 1)).toISOString().slice(0, 10);
}

/** The day before `day` ('YYYY-MM-DD'), the inverse of `nextDay`. */
export function prevDay(day: string): string {
  const [y, m, d] = day.split('-').map(Number);
  return new Date(Date.UTC(y!, m! - 1, d! - 1)).toISOString().slice(0, 10);
}

/**
 * An all-day range spanning `firstDay`..`lastDay` INCLUSIVE, as the two date fields read: picking
 * Aug 17 - Aug 19 means the range runs through the end of Aug 19. Stored the way every other
 * surface stores a window - an EXCLUSIVE end instant - so `isInvertedRange` still guards it: a
 * single-day all-day range is midnight-to-midnight, never a zero-length one.
 *
 * Shared by every all-day surface (AssignJobDialog, VisitScheduleDialog) precisely so the
 * inclusive/exclusive conversion cannot drift between them - copying this arithmetic per dialog is
 * the #1551 anti-pattern this module exists to prevent.
 */
export function allDayRange(firstDay: string, lastDay: string): ScheduleTimeValue {
  return {
    date: firstDay,
    startTime: '00:00',
    endDate: nextDay(lastDay),
    endTime: '00:00',
  };
}

/**
 * The last day `value` OCCUPIES, which is what an all-day End date field shows. An end at exactly
 * midnight belongs to the previous day - the same convention rbc itself uses when it decides an
 * event crosses a day boundary - so toggling all-day on a timed range keeps its real span instead
 * of collapsing a four-day one to a single day.
 */
export function lastDayOf(value: ScheduleTimeValue): string {
  if (!value.endDate) return value.date;
  return value.endTime === '00:00' ? prevDay(value.endDate) : value.endDate;
}

/** Builds the value from a start wall-clock Date + a duration, for the board surfaces. */
export function scheduleTimeFrom(start: Date, durationMin: number): ScheduleTimeValue {
  const pad = (n: number) => String(n).padStart(2, '0');
  const date = `${start.getFullYear()}-${pad(start.getMonth() + 1)}-${pad(start.getDate())}`;
  const startTime = `${pad(start.getHours())}:${pad(start.getMinutes())}`;
  return withDurationMinutes({ date, startTime, endDate: date, endTime: '' }, durationMin);
}

/** The start half as a plain (zoneless) Date, or null when it is not fully set. */
export function startDateOf(value: ScheduleTimeValue): Date | null {
  const d = DAY_RE.exec(value.date);
  const t = TIME_RE.exec(value.startTime);
  if (!d || !t) return null;
  return new Date(Number(d[1]), Number(d[2]) - 1, Number(d[3]), Number(t[1]), Number(t[2]), 0, 0);
}

/**
 * The span of an ALL-DAY booking, in minutes, counted in whole calendar days.
 *
 * An all-day job has no time of day, so there are no two ends to subtract: the
 * span runs from the start date to the end date INCLUSIVE. One day is 1440
 * minutes, so a single-day booking is 1440 and not 0 - a zero-length booking is
 * not a thing anyone can be scheduled for.
 *
 * Deliberately counted in UTC, like every other function here: this is calendar
 * arithmetic on a wall clock, and a local-time Date would make the day either
 * 1380 or 1500 minutes long across a DST boundary.
 */
export function wholeDaySpanMinutes(value: ScheduleTimeValue): number | null {
  const start = DAY_RE.exec(value.date);
  if (!start) return null;
  const startMs = Date.UTC(Number(start[1]), Number(start[2]) - 1, Number(start[3]));

  const end = DAY_RE.exec(value.endDate);
  // No end date yet, or one before the start: the booking is that single day.
  if (!end) return 1440;
  const endMs = Date.UTC(Number(end[1]), Number(end[2]) - 1, Number(end[3]));
  if (endMs < startMs) return 1440;

  return Math.round((endMs - startMs) / 60_000) + 1440;
}
