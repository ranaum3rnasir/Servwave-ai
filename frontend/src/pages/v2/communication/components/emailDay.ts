import { formatInstant, orgDayDiff } from '@/lib/schedule-tz';

const TIME: Intl.DateTimeFormatOptions = { hour: 'numeric', minute: '2-digit' };
const WEEKDAY: Intl.DateTimeFormatOptions = { weekday: 'short' };
const DATE: Intl.DateTimeFormatOptions = { month: 'short', day: 'numeric' };
const DATE_WITH_YEAR: Intl.DateTimeFormatOptions = { month: 'short', day: 'numeric', year: 'numeric' };

/**
 * When a message arrived, the way a mail list says it: today a time, yesterday "Yesterday", the last week a weekday, older a
 * date (with its year once it is not this year's). Read off the message's own instant `ts`, on the company's clock: the stored
 * `at` is a clock time with no day, so mail held for days read as if it had just come in.
 *
 * `withTime` adds the time of day to anything that is not today, for a reader that has room for it ("Sun, 2:00 PM").
 */
export function formatEmailDay(ts: number, tz: string, { withTime = false, now }: { withTime?: boolean; now?: Date } = {}): string {
  const instant = new Date(ts);
  const days = orgDayDiff(instant.toISOString(), tz, now?.toISOString());
  const time = formatInstant(instant, tz, TIME);
  if (days >= 0) return time;
  let day: string;
  if (days === -1) day = 'Yesterday';
  else if (days > -7) day = formatInstant(instant, tz, WEEKDAY);
  else {
    const sameYear = formatInstant(instant, tz, { year: 'numeric' }) === formatInstant(now ?? new Date(), tz, { year: 'numeric' });
    day = formatInstant(instant, tz, sameYear ? DATE : DATE_WITH_YEAR);
  }
  return withTime ? `${day}, ${time}` : day;
}
