/**
 * Mobile slice 42 - what a phone-width Month cell says about its day.
 *
 * At phone width a Month cell is a 44 px tap target that opens the day, not a column of
 * unreadable chips, so the day's events are reduced to a count. This file is the pure part:
 * how many events touch each calendar day, and the sentence a screen reader gets for a cell.
 *
 * Dates are the board's wall-clock dates (see asWallClock), so local-date arithmetic is the
 * right arithmetic here.
 */
import { addDays, format, startOfDay } from 'date-fns';

export interface DatedEvent {
  start: Date;
  end: Date;
}

/** `yyyy-MM-dd` of a wall-clock date: the key a cell looks its count up by. */
export function dayKey(date: Date): string {
  return format(date, 'yyyy-MM-dd');
}

/**
 * Events per calendar day. An event counts once on every day it touches; an event that ends
 * exactly at midnight does not touch the day that begins there (the end is exclusive), and an
 * instant event (end <= start) counts on its own day only.
 */
export function eventsPerDay(events: readonly DatedEvent[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const e of events) {
    let day = startOfDay(e.start);
    do {
      const key = dayKey(day);
      counts.set(key, (counts.get(key) ?? 0) + 1);
      day = addDays(day, 1);
    } while (day.getTime() < e.end.getTime());
  }
  return counts;
}

/** The spoken name of a Month cell: the full date, then how many events it holds. */
export function monthCellLabel(date: Date, count: number): string {
  const when = format(date, 'EEEE, MMMM d');
  if (count <= 0) return `${when}, no events`;
  return `${when}, ${count} ${count === 1 ? 'event' : 'events'}`;
}
