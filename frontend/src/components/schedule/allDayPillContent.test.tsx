// What the all-day strip PILL contains.
//
// The strip forces every pill to height: 22px (schedule-dark.css). The full event
// card is ~82px of content - number, time range, crew, address stacked - so a card
// rendered into a pill spills over the day headers and neighbouring pills. Prod hit
// exactly that: cross-midnight jobs started reaching the strip (they are routed there
// by rbc) while ScheduleEvent still gave them the full card, because the strip's
// visibility used occupiesAllDayStrip and the renderer still used isAllDayEvent.
//
// Anything rbc puts in the strip must render as ONE line - and, since the pill was measured
// at 96.3px against a 254px "number EM customer" string, that line is the NUMBER ALONE. The
// customer name lives on the hover preview and in the overflow panel, both of which have room
// for it; on the pill it only ever pushed the number out.
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
// The LIVE component. App.tsx builds its whole route table from v2Routes(), so
// `pages/SchedulePage` - which this file used to import - is unreachable dead code, and
// pinning the fix there is what let prod ship the bug green: the v1 page used
// occupiesAllDayStrip while the v2 fork users actually reach still used isAllDayEvent.
import { ScheduleEvent } from '@/pages/v2/schedule/SchedulePage';
import { type BoardEvent } from './scheduleModel';
import { asWallClock } from '@/lib/schedule-tz';

const job = (start: Date, end: Date, isAllDay = false): BoardEvent => ({
  boardId: 'j1', parentId: 'j1', type: 'job', number: '698715', title: 'Camera System Replacement',
  customer: 'Annette Rubin', crew: [], ownerId: null,
  start: asWallClock(start), end: asWallClock(end),
  raw: {
    is_all_day: isAllDay,
    job_number: '698715',
    status: 'SCHEDULED',
    customer: { first_name: 'Annette', last_name: 'Rubin' },
    service_location: { address_line1: '4620 Delafield Avenue' },
  },
});

describe('all-day strip pill content (one line, never the full card)', () => {
  // The reported job: Aug 9 8:00 PM -> Aug 11 5:00 AM, is_all_day false.
  it('renders a cross-midnight job as the job number alone', () => {
    render(<ScheduleEvent event={job(new Date(2026, 7, 9, 20, 0), new Date(2026, 7, 11, 5, 0))} />);

    expect(screen.getByText(/698715/)).toBeInTheDocument();
    // The customer name is NOT here any more, and that is the point: at 96.3px it rendered as
    // four characters of the number followed by nothing. It is on the hover preview and in the
    // overflow panel instead.
    expect(screen.queryByText(/Annette Rubin/)).not.toBeInTheDocument();
    // The full-card fields must NOT be there - they are what overflowed the 22px pill.
    expect(screen.queryByText(/8:00 PM/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Delafield/)).not.toBeInTheDocument();
  });

  it('still renders a flagged all-day job as a single line', () => {
    render(<ScheduleEvent event={job(new Date(2026, 7, 9, 0, 0), new Date(2026, 7, 10, 0, 0), true)} />);

    expect(screen.getByText(/698715/)).toBeInTheDocument();
    expect(screen.queryByText(/Delafield/)).not.toBeInTheDocument();
  });

  // D13 - the pill is the ONLY thing on screen for an all-day booking, and it drops the
  // time range the timed card uses to tell two trips apart. A job booked five times on one
  // day painted five identical pills; the dispatcher could not tell which one they grabbed.
  it('numbers the trip when the job has more than one visit', () => {
    const e = job(new Date(2026, 7, 9, 0, 0), new Date(2026, 7, 10, 0, 0), true);
    render(<ScheduleEvent event={{ ...e, visitId: 'v2', visitSeq: 2, visitCount: 5 }} />);

    // ABBREVIATED on this surface only - `Visit 2 of 5` is 49.7px of a 96.3px row and the
    // number needs 54.6px, so the sentence and the identity cannot both fit. The panel and the
    // full card keep the sentence.
    expect(screen.getByText('2/5')).toBeInTheDocument();
    expect(screen.queryByText('Visit 2 of 5')).not.toBeInTheDocument();
  });

  it('says nothing about trips on a single-visit job', () => {
    const e = job(new Date(2026, 7, 9, 0, 0), new Date(2026, 7, 10, 0, 0), true);
    render(<ScheduleEvent event={{ ...e, visitId: 'v1', visitSeq: 1, visitCount: 1 }} />);

    expect(screen.queryByText(/Visit \d/)).not.toBeInTheDocument();
    expect(screen.queryByText(/^\d+\/\d+$/)).not.toBeInTheDocument();
  });

  // The regression #1734 shipped: `Visit N of M` and `needs crew` are both shrink-0, so on a
  // ~96px week-view pill the only shrinkable child - the job identity - was squeezed to width
  // 0 and the badge overflowed its own box. Measured on staging at 1280px: label 0px
  // (scrollWidth 184), badge 23.9px past the row's right edge. The badge yields because the
  // pill carries the state another way (the corner notch since 2026-09-14, the red fill before
  // that); the number is the only thing on the pill that is not encoded twice.
  // The badge is 62.5px of a ~90px row and shrink-0, so on EVERY strip pill it is the badge
  // that decides how much of the job number survives - measured on staging, a single-visit
  // crew-less pill rendered `J0` and an ellipsis. The pill keeps its MARK - the needs-crew
  // notch, absolutely positioned so it takes no room from the number - and the words moved to
  // the overflow panel, which has 288px. An earlier version of this dropped the badge only
  // when a trip number was present, which left that pill unhelped and made the pill show either
  // the badge or the trip chip for no reason a reader could see.
  it('never spells out the crew warning, multi-visit', () => {
    const e = job(new Date(2026, 7, 9, 0, 0), new Date(2026, 7, 10, 0, 0), true);
    render(<ScheduleEvent event={{ ...e, crew: [], visitId: 'v2', visitSeq: 2, visitCount: 5 }} />);

    expect(screen.getByText(/698715/)).toBeInTheDocument();
    expect(screen.getByText('2/5')).toBeInTheDocument();
    expect(screen.queryByText(/needs crew/i)).not.toBeInTheDocument();
  });

  it('never spells out the crew warning, single-visit either', () => {
    const e = job(new Date(2026, 7, 9, 0, 0), new Date(2026, 7, 10, 0, 0), true);
    render(<ScheduleEvent event={{ ...e, crew: [], visitId: 'v1', visitSeq: 1, visitCount: 1 }} />);

    // The number is what the pill is FOR, and with the badge gone nothing competes for it.
    expect(screen.getByText(/698715/)).toBeInTheDocument();
    expect(screen.queryByText(/needs crew/i)).not.toBeInTheDocument();
  });

  // The state is not lost when the words go: the notch is on the pill, named as a label (which
  // the text queries above cannot see - that is the point of NeedsCrewMark carrying no text).
  it('carries the needs-crew notch instead of the words', () => {
    const e = job(new Date(2026, 7, 9, 0, 0), new Date(2026, 7, 10, 0, 0), true);
    render(<ScheduleEvent event={{ ...e, crew: [], visitId: 'v1', visitSeq: 1, visitCount: 1 }} />);
    expect(screen.getByRole('img', { name: /needs crew/i })).toBeInTheDocument();
  });

  it('leaves a same-day timed job on the full card', () => {
    render(<ScheduleEvent event={job(new Date(2026, 7, 10, 9, 0), new Date(2026, 7, 10, 11, 0))} />);

    expect(screen.getByText(/9:00 AM/)).toBeInTheDocument();
  });
});
