// Pins the react-big-calendar behaviour that occupiesAllDayStrip mirrors.
//
// rbc's TimeGrid sends an event to the all-day strip when it crosses a calendar-day
// boundary, whatever the allDay accessor says, because we never pass showMultiDayTimes.
// Our CSS collapses that strip unless the page says it is occupied - so if this
// assumption ever changes (an rbc upgrade, a showMultiDayTimes prop), the visibility
// predicate in SchedulePage has to change with it. This test is the tripwire.
import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import { Calendar, dateFnsLocalizer, Views } from 'react-big-calendar';
import { format, parse, startOfWeek, getDay } from 'date-fns';
import { enUS } from 'date-fns/locale';
import { occupiesAllDayStrip, type BoardEvent } from './scheduleModel';
import { asWallClock } from '@/lib/schedule-tz';

const localizer = dateFnsLocalizer({
  format, parse, startOfWeek, getDay, locales: { 'en-US': enUS },
});

const boardEvent = (start: Date, end: Date): BoardEvent => ({
  boardId: 'j1', parentId: 'j1', type: 'job', number: '698715', title: 'Camera System Replacement',
  customer: 'Annette Rubin', crew: [], ownerId: null,
  start: asWallClock(start), end: asWallClock(end), raw: { is_all_day: false },
});

const renderWeek = (event: BoardEvent) =>
  render(
    <Calendar
      localizer={localizer}
      events={[event]}
      defaultView={Views.WEEK}
      defaultDate={new Date(2026, 7, 9)}
      startAccessor="start"
      endAccessor="end"
      allDayAccessor={() => false}
    />,
  );

describe('rbc all-day strip routing (the premise occupiesAllDayStrip mirrors)', () => {
  // The reported job: Aug 9 8:00 PM -> Aug 11 5:00 AM, is_all_day false.
  it('puts a cross-midnight timed event in the all-day strip', () => {
    const ev = boardEvent(new Date(2026, 7, 9, 20, 0), new Date(2026, 7, 11, 5, 0));
    const { container } = renderWeek(ev);

    const strip = container.querySelector('.rbc-allday-cell');
    expect(strip?.textContent).toContain('Camera System Replacement');
    // ...and it is NOT in the timed grid, so hiding the strip hides the job entirely.
    expect(container.querySelector('.rbc-time-content')?.textContent).not.toContain('Camera System Replacement');
    // Which is exactly the case our predicate must report as strip-occupying.
    expect(occupiesAllDayStrip(ev)).toBe(true);
  });

  it('leaves a same-day timed event in the timed grid', () => {
    const ev = boardEvent(new Date(2026, 7, 10, 9, 0), new Date(2026, 7, 10, 11, 0));
    const { container } = renderWeek(ev);

    expect(container.querySelector('.rbc-time-content')?.textContent).toContain('Camera System Replacement');
    expect(container.querySelector('.rbc-allday-cell')?.textContent).not.toContain('Camera System Replacement');
    expect(occupiesAllDayStrip(ev)).toBe(false);
  });
});

// Slice 05 (calendar-entries spec §2/§3): "Dave is on vacation Mon-Fri" is ONE row spanning
// five day columns, not five separate rows - the same rendering path a multi-day JOB already
// proved above, now exercised with a calendar entry and asserted on rendered node COUNT rather
// than eyeballed, per the slice's acceptance criteria.
describe('calendar entries on the strip (spec §3)', () => {
  const calendarEntry = (start: Date, end: Date, isAllDay: boolean): BoardEvent => ({
    boardId: 'ce-1', parentId: 'entry-1', type: 'calendar-entry', number: '', title: 'Dave is on vacation',
    customer: '', crew: [], ownerId: null,
    start: asWallClock(start), end: asWallClock(end), isAllDay, raw: { is_all_day: isAllDay },
  });

  const renderWeekWith = (event: BoardEvent) =>
    render(
      <Calendar
        localizer={localizer}
        events={[event]}
        defaultView={Views.WEEK}
        defaultDate={new Date(2026, 7, 9)}
        startAccessor="start"
        endAccessor="end"
        allDayAccessor={(e: object) => Boolean((e as BoardEvent).isAllDay)}
      />,
    );

  it('an all-day single-day entry occupies the strip', () => {
    const ev = calendarEntry(new Date(2026, 7, 10, 0, 0), new Date(2026, 7, 11, 0, 0), true);
    expect(occupiesAllDayStrip(ev)).toBe(true);
  });

  it('a TIMED entry crossing midnight occupies the strip too (rbc routing, not the flag)', () => {
    const ev = calendarEntry(new Date(2026, 7, 10, 20, 0), new Date(2026, 7, 11, 5, 0), false);
    expect(occupiesAllDayStrip(ev)).toBe(true);
  });

  it('a Mon-Fri all-day entry renders as ONE element in the strip, not five', () => {
    // Mon Aug 10 00:00 -> Sat Aug 15 00:00 exclusive = occupies Mon-Fri inclusive.
    const ev = calendarEntry(new Date(2026, 7, 10, 0, 0), new Date(2026, 7, 15, 0, 0), true);
    const { container } = renderWeekWith(ev);

    const strip = container.querySelector('.rbc-allday-cell');
    expect(strip?.textContent).toContain('Dave is on vacation');
    // The proof: ONE rendered event node for the whole span, not one per occupied day.
    const rendered = container.querySelectorAll('.rbc-allday-cell .rbc-event');
    expect(rendered.length).toBe(1);
  });

  it('a timed entry on the same day stays in the time grid with its hours intact', () => {
    const ev = calendarEntry(new Date(2026, 7, 10, 9, 0), new Date(2026, 7, 10, 11, 0), false);
    const { container } = renderWeekWith(ev);

    expect(container.querySelector('.rbc-time-content')?.textContent).toContain('Dave is on vacation');
    expect(container.querySelector('.rbc-allday-cell')?.textContent).not.toContain('Dave is on vacation');
    expect(occupiesAllDayStrip(ev)).toBe(false);
  });
});
