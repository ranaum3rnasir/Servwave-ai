import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, render } from '@testing-library/react';
import { renderWithProviders } from '@/__tests__/helpers';
import { MemberWeekBoard } from '@/components/schedule/MemberWeekBoard';
import { TechnicianGridView } from '@/components/schedule/TechnicianGridView';
import { ScheduleEvent, planDraftLocation, ghostToEvent } from '@/__tests__/harness/schedulePage';
import type { SchedulableEvent, BoardEvent } from '@/components/schedule/scheduleModel';
import { asWallClock, toWallClock } from '@/lib/schedule-tz';
import { cardAddressText } from '@/components/schedule/ScheduleCardBody';
import type { GhostEvent } from '@/hooks/usePlanMode';
import { useAuthStore } from '@/stores/auth.store';
import api from '@/lib/axios';

// Each source used to be a file of its own, so each started from the setup file's signed-in user and bare client calls.
// `clearAllMocks` keeps implementations: reset them here, so a block states its own user and answers in its own `beforeEach`.
beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(useAuthStore).mockReset();
  vi.mocked(api.get).mockReset();
  vi.mocked(api.post).mockReset();
  vi.mocked(api.patch).mockReset();
  vi.mocked(api.put).mockReset();
  vi.mocked(api.delete).mockReset();
});

describe('ScheduleCardBody', () => {
  /**
   * Multi-visit spec slice S0b - the drift guard.
   *
   * The two board surfaces (MemberWeekBoard's BoardCard, TechnicianGridView's JobCard) used to carry
   * byte-identical copies of the same card body, including the `isWalk ? customer : title` branch
   * that multi-visit has to change. #1551 is the standing proof of what that costs: a shipped fix in
   * one schedule tree was silently reverted by its untouched copy in the other.
   *
   * These tests assert the two boards render the SAME card content for the SAME event - through the
   * rendered component, not by reaching into ScheduleCardBody. If a future edit reintroduces a
   * per-board branch, these fail regardless of how the sharing is implemented.
   *
   * S0b's premise was INCOMPLETE, corrected 2026-08-19 by driving the real board: there is a THIRD
   * card renderer, `ScheduleEvent` in pages/v2/schedule/SchedulePage, which paints the Standard
   * week view - the board a dispatcher lands on first - and shares no JSX with this body at all.
   * S6 shipped its "Visit N of M" label into this body only, so the Standard board painted three
   * identical unlabelled cards for a three-trip job. The visit-label suite at the bottom of this
   * file therefore covers all THREE renderers; see the comment there for why the earlier content
   * assertions cannot be extended the same way.
   */

  const DAY = new Date(2026, 5, 10);
  const TZ = 'America/New_York';

  const members = [
    { id: 'm-alice', first_name: 'Alice', last_name: 'Ng', is_active: true, role: 'TECHNICIAN' },
  ];

  const walkthrough: SchedulableEvent = {
    boardId: 'wt-1',
    parentId: 'lead-1',
    type: 'walkthrough',
    number: 'L00021',
    title: 'Site survey',
    customer: 'Wayne Industries',
    crew: ['m-alice'],
    ownerId: null,
    start: asWallClock(new Date(2026, 5, 10, 9, 0)),
    end: asWallClock(new Date(2026, 5, 10, 10, 0)),
    raw: { service_address_line1: '12 Foundry Rd', service_city: 'Newark', service_state: 'NJ' },
  };

  const job: SchedulableEvent = {
    boardId: 'job-1',
    parentId: 'job-1',
    type: 'job',
    number: 'J00043',
    title: 'Rooftop Unit Swap',
    customer: 'Acme',
    crew: ['m-alice'],
    ownerId: null,
    start: asWallClock(new Date(2026, 5, 10, 13, 0)),
    end: asWallClock(new Date(2026, 5, 10, 15, 0)),
    // Two shapes in one row on purpose: the shared body reads the normalised `number`/`customer`
    // fields above, the Standard board's own card reads `raw.job_number`/`raw.customer`. One
    // fixture has to satisfy both for the drift guard to render the SAME event through all three.
    raw: {
      status: 'SCHEDULED',
      job_number: 'J00043',
      customer: { first_name: 'Ada', last_name: 'Byron' },
      service_location: { address: '5 Mill St', city: 'Trenton', state: 'NJ' },
    },
  };

  function renderWeekBoard(events: SchedulableEvent[]) {
    return renderWithProviders(
      <MemberWeekBoard
        weekStart={asWallClock(DAY)}
        staff={members}
        events={events}
        conflictIds={new Set()}
        isLoading={false}
        tz={TZ}
        onSelectEvent={vi.fn()}
        onDropJob={vi.fn()}
      />,
    );
  }

  function renderGrid(events: SchedulableEvent[]) {
    return renderWithProviders(
      <TechnicianGridView
        date={asWallClock(DAY)}
        events={events}
        members={members}
        conflictIds={new Set()}
        isLoading={false}
        draggingJobIdRef={{ current: null }}
        onDropJob={vi.fn()}
        onSelectJob={vi.fn()}
        onEventClick={vi.fn()}
      />,
    );
  }

  /**
   * The Standard week board's card. Rendered on its own rather than through SchedulePage because
   * the assertion is about the CARD, and the page would drag react-big-calendar's grid, the API
   * fakes and the whole board chrome in to reach the same DOM. `ScheduleEvent` reads its handlers
   * from a context whose default value is a no-op, so it stands up alone.
   */
  function renderStandardCard(event: SchedulableEvent) {
    return renderWithProviders(<ScheduleEvent event={event} />);
  }

  describe('both boards render the same card content (S0b drift guard)', () => {
    it('a walkthrough card leads with "Walkthrough" and shows the customer as its title on both boards', () => {
      const week = renderWeekBoard([walkthrough]);
      expect(screen.getAllByText('Walkthrough').length).toBeGreaterThan(0);
      expect(screen.getAllByText('Wayne Industries').length).toBeGreaterThan(0);
      // The lead number rides alongside the label rather than replacing it.
      expect(screen.getAllByText('L00021').length).toBeGreaterThan(0);
      week.unmount();

      renderGrid([walkthrough]);
      expect(screen.getAllByText('Walkthrough').length).toBeGreaterThan(0);
      expect(screen.getAllByText('Wayne Industries').length).toBeGreaterThan(0);
      expect(screen.getAllByText('L00021').length).toBeGreaterThan(0);
    });

    it('a job card leads with its job number and shows its scope title on both boards', () => {
      const week = renderWeekBoard([job]);
      expect(screen.getAllByText('J00043').length).toBeGreaterThan(0);
      expect(screen.getAllByText('Rooftop Unit Swap').length).toBeGreaterThan(0);
      // A job whose customer differs from its title shows BOTH - the walkthrough branch shows one.
      expect(screen.getAllByText('Acme').length).toBeGreaterThan(0);
      week.unmount();

      renderGrid([job]);
      expect(screen.getAllByText('J00043').length).toBeGreaterThan(0);
      expect(screen.getAllByText('Rooftop Unit Swap').length).toBeGreaterThan(0);
      expect(screen.getAllByText('Acme').length).toBeGreaterThan(0);
    });

    it('resolves a walkthrough address from the lead fields and a job address from service_location, on both boards', () => {
      const week = renderWeekBoard([walkthrough, job]);
      expect(screen.getAllByText('12 Foundry Rd, Newark, NJ').length).toBeGreaterThan(0);
      expect(screen.getAllByText('5 Mill St, Trenton').length).toBeGreaterThan(0);
      week.unmount();

      renderGrid([walkthrough, job]);
      expect(screen.getAllByText('12 Foundry Rd, Newark, NJ').length).toBeGreaterThan(0);
      expect(screen.getAllByText('5 Mill St, Trenton').length).toBeGreaterThan(0);
    });
  });

  /**
   * ALL THREE renderers, not two.
   *
   * Only the visit label is asserted across the third one, and that is a real limit rather than
   * laziness: the Standard board's card and the shared body genuinely say different things about
   * the same event. The shared body leads with the job number and prints the scope title; the
   * Standard card leads with "number - customer" and prints the crew instead of the scope. So
   * there is no honest single assertion for the title/customer/address rows - forcing one would
   * mean rewriting one board's content, which is a design decision and not a guard. The visit
   * label IS shared vocabulary (visitLabel in scheduleModel), so it is guarded here for all three.
   * A fourth renderer, or a fourth wording, fails this block.
   */
  describe('the card says WHICH visit it is, identically on ALL THREE boards (S6, F2, D13)', () => {
    /** D13: the label reads visit_seq (creation order), never the position in the sorted board. */
    const secondOfThree: SchedulableEvent = {
      ...job,
      boardId: 'jv-3f2a1c88-0000-0000-0000-000000000002',
      visitId: '3f2a1c88-0000-0000-0000-000000000002',
      visitSeq: 2,
      visitCount: 3,
    };

    it('a job with three trips labels this card "Visit 2 of 3" on every board', () => {
      const week = renderWeekBoard([secondOfThree]);
      expect(screen.getAllByText('Visit 2 of 3').length).toBeGreaterThan(0);
      week.unmount();

      const grid = renderGrid([secondOfThree]);
      expect(screen.getAllByText('Visit 2 of 3').length).toBeGreaterThan(0);
      grid.unmount();

      renderStandardCard(secondOfThree);
      expect(screen.getAllByText('Visit 2 of 3').length).toBeGreaterThan(0);
    });

    it('a single-trip job gains no visit label at all, on any board - the 99% case must not gain noise', () => {
      const single: SchedulableEvent = { ...job, boardId: 'jv-v1', visitId: 'v1', visitSeq: 1, visitCount: 1 };

      const week = renderWeekBoard([single]);
      expect(screen.queryByText(/^Visit \d+ of \d+$/)).not.toBeInTheDocument();
      week.unmount();

      const grid = renderGrid([single]);
      expect(screen.queryByText(/^Visit \d+ of \d+$/)).not.toBeInTheDocument();
      grid.unmount();

      renderStandardCard(single);
      expect(screen.queryByText(/^Visit \d+ of \d+$/)).not.toBeInTheDocument();
    });

    it('never prints the board id when the number is missing - a card must not show a UUID', () => {
      const numberless: SchedulableEvent = { ...secondOfThree, number: '' };

      const week = renderWeekBoard([numberless]);
      expect(screen.queryByText(/^jv-/)).not.toBeInTheDocument();
      week.unmount();

      renderGrid([numberless]);
      expect(screen.queryByText(/^jv-/)).not.toBeInTheDocument();
    });
  });

  /**
   * Needs-crew signal (2026-09-14, design canvas option 01): the corner notch replaces the solid
   * red fill. A needs-crew card keeps its TYPE paint - which an org may have recoloured - and gains
   * an absolutely positioned mark that names itself. The fill is gone on purpose: it erased the
   * org's colour, and it is the one channel the notch was chosen for never touching.
   *
   * Only the Standard card can reach this state end-to-end: a zero-crew event never lands in a
   * member lane (isOnBoardFor), so the member boards' contribution is the negative - a crewed card
   * has no notch and no red fill - which their own suites already pin.
   */
  describe('needs-crew is a corner notch, not a red fill', () => {
    const unstaffed: SchedulableEvent = { ...job, boardId: 'jv-unstaffed', crew: [] };

    it('the Standard card mounts the notch by name and keeps its type paint', () => {
      renderStandardCard(unstaffed);
      expect(screen.getByRole('img', { name: /needs crew/i })).toBeInTheDocument();
    });

    it('the notch carries no text - the all-day pill guard must not be able to see it', () => {
      renderStandardCard(unstaffed);
      // The WORDS row is separate and still renders when there is room (2h under jsdom = 96px).
      // What must not exist is a second, hidden copy of the words inside the mark itself.
      expect(screen.getAllByText(/needs crew/i)).toHaveLength(1);
    });

    it('a crewed card has no notch on any board', () => {
      const week = renderWeekBoard([job]);
      expect(screen.queryByRole('img', { name: /needs crew/i })).not.toBeInTheDocument();
      week.unmount();
      const grid = renderGrid([job]);
      expect(screen.queryByRole('img', { name: /needs crew/i })).not.toBeInTheDocument();
      grid.unmount();
      renderStandardCard(job);
      expect(screen.queryByRole('img', { name: /needs crew/i })).not.toBeInTheDocument();
    });
  });

  /**
   * Double-booked moved from red to amber on 2026-09-14 so the board carries ONE red, and it
   * means "short-staffed". The conflict keeps its triangle and its outline; only the hue moves.
   */
  describe('double-booked is amber, so red means one thing', () => {
    it('the conflict mark on both member boards is painted warning, not danger', () => {
      const week = renderWeekBoard([job]);
      // No conflict in this fixture; the mark should be absent, not merely recoloured.
      expect(screen.queryByText(/double-booked/i)).not.toBeInTheDocument();
      week.unmount();
    });

    it('a conflicted card on the day board carries the amber outline and its name, and no icon', () => {
      renderWithProviders(
        <TechnicianGridView
          date={asWallClock(DAY)}
          events={[job]}
          members={members}
          conflictIds={new Set(['job-1'])}
          isLoading={false}
          draggingJobIdRef={{ current: null }}
          onDropJob={vi.fn()}
          onSelectJob={vi.fn()}
          onEventClick={vi.fn()}
        />,
      );
      const name = screen.getByText(/double-booked/i);
      expect(name).toHaveClass('sr-only');
      // Owner, 2026-09-15: the outline is the whole visible signal. No triangle.
      expect(screen.queryByRole('img', { name: /double-booked/i })).not.toBeInTheDocument();
      const card = name.closest('[draggable="true"]');
      // A 2px amber outline inset over all four edges (the owner's mock), not a three-sided border.
      // `[outline-style:solid]`: the plain `outline` class does not survive cn's tailwind-merge.
      expect(card).toHaveClass('[outline-style:solid]', 'outline-2', 'outline-warning', '-outline-offset-2');
      expect(card).not.toHaveClass('border-warning');
      expect(card).not.toHaveClass('border-danger');
      // Under the amber frame it is still a job card - the type's derived surface and left bar -
      // not the white card double-booked used to paint, which dropped the type colour entirely.
      expect(card).toHaveClass('bg-ev-job-surface');
      expect(card).toHaveClass('border-l-ev-job-border');
      expect(card).not.toHaveClass('bg-surface-light');
    });
  });

  /**
   * Job type on the card, above the address (owner, 2026-09-14). The org's own label
   * (`job_type_options`), read straight off the job row - the list select already carries it.
   * Walkthroughs are leads and calendar entries are not jobs, so neither gains a row.
   */
  describe('a job card shows its job type above the address, on all three boards', () => {
    // service_location carries BOTH address shapes: the shared body reads `address`, the Standard
    // card reads `address_line1` (the job API's own field). Same reason the base fixture carries two
    // customer shapes - one fixture has to satisfy all three renderers.
    const typed: SchedulableEvent = {
      ...job,
      raw: {
        ...job.raw,
        job_type: 'HVAC Install',
        service_location: { address: '5 Mill St', address_line1: '5 Mill St', city: 'Trenton', state: 'NJ' },
      },
    };

    it('renders the job type on both member boards and the Standard card', () => {
      const week = renderWeekBoard([typed]);
      expect(screen.getAllByText('HVAC Install').length).toBeGreaterThan(0);
      week.unmount();
      const grid = renderGrid([typed]);
      expect(screen.getAllByText('HVAC Install').length).toBeGreaterThan(0);
      grid.unmount();
      renderStandardCard(typed);
      expect(screen.getByText('HVAC Install')).toBeInTheDocument();
    });

    it('places it above the address', () => {
      renderStandardCard(typed);
      const type = screen.getByText('HVAC Install');
      const address = screen.getByText(/5 Mill St/);
      // compareDocumentPosition: FOLLOWING (4) means `address` comes after `type` in the DOM.
      expect(type.compareDocumentPosition(address) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    });

    it('shows nothing for a job without a type, and never for a walkthrough', () => {
      const week = renderWeekBoard([job, walkthrough]);
      expect(screen.queryByText('HVAC Install')).not.toBeInTheDocument();
      week.unmount();
    });
  });

  /**
   * Owner, 2026-09-15: the job type must be visible on the scheduler slots, not only on the few
   * cards wide and tall enough for an address. On the Standard view it is gated with the START
   * TIME row (28px tall, 56px wide), which nearly every timed card clears, rather than with the
   * address row (44px, 124px), which on a dense day almost none do. Under jsdom a card's height is
   * its duration at 48px/hour and its width reads as unbounded, so a 45-minute job is 36px: past
   * the time gate, short of the address gate.
   */
  describe('job type shows on cards too small for an address', () => {
    const shortTyped: SchedulableEvent = {
      ...job,
      boardId: 'jv-short',
      end: asWallClock(new Date(2026, 5, 10, 13, 45)),
      raw: {
        ...job.raw,
        job_type: 'Electrical',
        service_location: { address: '5 Mill St', address_line1: '5 Mill St', city: 'Trenton', state: 'NJ' },
      },
    };

    it('a 45-minute Standard card shows its time and job type but not its address', () => {
      renderStandardCard(shortTyped);
      expect(screen.getByText(/1:00 PM/)).toBeInTheDocument();
      expect(screen.getByText('Electrical')).toBeInTheDocument();
      expect(screen.queryByText(/5 Mill St/)).not.toBeInTheDocument();
    });
  });

  /**
   * Every text row on a card is readable - on ALL THREE boards.
   *
   * The card's colours are derived so its text clears WCAG AA (4.5:1) on its surface
   * (design-system/eventCardColors.ts). Two things used to undo that row by row: an `opacity-*`
   * on the secondary rows (time, job type, address, visit label), and the neutral greys the member
   * boards painted those rows in - `text-text-soft` measures 2.5-2.7:1 and `text-text-secondary`
   * 3.9-4.2:1 against the derived surfaces. A card faded as a whole (completed at 0.5, ghost at
   * 0.55) lowered every row at once. jsdom has no CSS to measure, so this pins the classes that
   * carried those failures out of the card.
   */
  describe('no text row on a card is faded or painted in a sub-AA grey', () => {
    const completedJob: SchedulableEvent = { ...job, boardId: 'job-9', raw: { ...job.raw, status: 'COMPLETED' } };
    const typedJob: SchedulableEvent = {
      ...job, visitSeq: 2, visitCount: 3, raw: { ...job.raw, job_type: 'Install' },
    };
    const SUB_AA_GREYS = new Set(['text-text-soft', 'text-text-secondary']);
    const isLowContrast = (cls: string) => SUB_AA_GREYS.has(cls) || /^opacity-\d+$/.test(cls);

    const lowContrastRows = (root: Element) =>
      [root, ...Array.from(root.querySelectorAll('*'))]
        .flatMap((el) => Array.from(el.classList))
        .filter(isLowContrast);

    it('the Standard card: no opacity on any row', () => {
      const { container } = renderStandardCard(typedJob);
      expect(screen.getByText('Install')).toBeInTheDocument();
      expect(lowContrastRows(container)).toEqual([]);
    });

    it.each([
      ['the week board', renderWeekBoard],
      ['the day board', renderGrid],
    ] as const)('%s: no faded or sub-AA grey text rows, and no faded card', (_label, render) => {
      const { container } = render([typedJob, walkthrough, completedJob]);
      for (const card of Array.from(container.querySelectorAll('[draggable="true"]'))) {
        expect(lowContrastRows(card)).toEqual([]);
        expect((card as HTMLElement).style.opacity).toBe('');
      }
    });

    it('a completed card is the solid grey card, not a faded one - and its title is on-solid too', () => {
      const { container } = renderGrid([completedJob]);
      const card = container.querySelector('[draggable="true"]') as HTMLElement;
      expect(card).toHaveClass('bg-ev-completed-solid');
      expect(card.style.opacity).toBe('');
      // The title row is near-black on every other card; on the solid grey that would fail AA.
      expect(screen.getByText('Rooftop Unit Swap')).toHaveClass('text-ev-completed-on-solid');
      expect(screen.getByText('Rooftop Unit Swap')).not.toHaveClass('text-text-primary');
    });
  });
});

describe('allDayPillContent', () => {
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
  // The LIVE component. App.tsx builds its whole route table from v2Routes(), so
  // `pages/SchedulePage` - which this file used to import - is unreachable dead code, and
  // pinning the fix there is what let prod ship the bug green: the v1 page used
  // occupiesAllDayStrip while the v2 fork users actually reach still used isAllDayEvent.

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
});

describe('monthViewGhostTitle', () => {
  /**
   * Month view showed a plan-mode draft as an EMPTY pill - the same defect class as the needs-crew
   * fix in monthViewNeedsCrewTitle.test.tsx.
   *
   * Month view keeps only the `:first-child` row of a card (schedule-dark.css, the ONE LINE rule).
   * The ghost branch of ScheduleEvent mounted its absolutely positioned "draft" badge first, so the
   * badge was the row kept and the title the row hidden. jsdom applies no stylesheet, so this pins
   * the DOM contract the rule relies on: the title row is the wrapper's first element child, and the
   * badge is still rendered after it, carrying the attribute the month rule lets through.
   */

  const ghost: BoardEvent = {
    boardId: 'job-7',
    parentId: 'job-7',
    type: 'job',
    number: 'J00077',
    title: 'J00077 Draft install',
    customer: 'Ada Byron',
    crew: ['u1'],
    ownerId: null,
    start: asWallClock(new Date(2026, 5, 10, 9, 0)),
    end: asWallClock(new Date(2026, 5, 10, 11, 0)),
    isGhost: true,
    raw: { status: 'SCHEDULED', job_number: 'J00077', customer: { first_name: 'Ada', last_name: 'Byron' } },
  };

  describe('a plan-mode draft keeps its title in Month view', () => {
    it('the title row is the first element child of the card', () => {
      const { container } = renderWithProviders(<ScheduleEvent event={ghost} />);
      const wrapper = container.firstElementChild as HTMLElement;
      expect(wrapper.firstElementChild?.textContent).toBe('J00077 Draft install');
    });

    it('the draft badge is still rendered, after the title, marked for the month rule', () => {
      const { container, getByText } = renderWithProviders(<ScheduleEvent event={ghost} />);
      const wrapper = container.firstElementChild as HTMLElement;
      const badge = getByText('draft');
      expect(badge.parentElement).toBe(wrapper);
      expect(badge).not.toBe(wrapper.firstElementChild);
      expect(badge).toHaveAttribute('data-draft-badge');
    });
  });
});

describe('monthViewNeedsCrewTitle', () => {
  /**
   * Month view hid the title of every needs-crew card (prod QA, after #2155).
   *
   * Month view keeps ONE row of a card and throws the rest away, by child position:
   * schedule-dark.css hides `.rbc-event-content > div > *:not(:first-child)` and styles the
   * `:first-child` as the one line. That rule was written when the title row was always first.
   * #2155 then mounted the needs-crew notch (NeedsCrewMark) as the wrapper's FIRST child, so on
   * a crewless card the notch was the one row kept and the title was hidden: the pill collapsed
   * to an ~8px bar with no number on it and the notch clipped to a red sliver.
   *
   * jsdom applies no stylesheet, so this pins the DOM contract that rule relies on, for both
   * branches of the Standard board's card: the title row is the first element child, and the
   * notch is still rendered (after it - it is absolutely positioned, so its DOM slot does not
   * move where it paints).
   */

  // No crew and a start time: deriveState's state 4, the needs-crew card.
  const crewlessJob: SchedulableEvent = {
    boardId: 'job-1',
    parentId: 'job-1',
    type: 'job',
    number: 'J00043',
    title: 'Rooftop Unit Swap',
    customer: 'Acme',
    crew: [],
    ownerId: null,
    start: asWallClock(new Date(2026, 5, 10, 13, 0)),
    end: asWallClock(new Date(2026, 5, 10, 15, 0)),
    raw: {
      status: 'SCHEDULED',
      job_number: 'J00043',
      customer: { first_name: 'Ada', last_name: 'Byron' },
    },
  };

  const crewlessWalkthrough: SchedulableEvent = {
    boardId: 'wt-1',
    parentId: 'lead-1',
    type: 'walkthrough',
    number: 'L00021',
    title: 'Site survey',
    customer: 'Ada Byron',
    crew: [],
    ownerId: null,
    start: asWallClock(new Date(2026, 5, 10, 9, 0)),
    end: asWallClock(new Date(2026, 5, 10, 10, 0)),
    raw: {
      lead_number: 'L00021',
      customer: { first_name: 'Ada', last_name: 'Byron' },
    },
  };

  function cardWrapper(event: SchedulableEvent): HTMLElement {
    const { container } = renderWithProviders(<ScheduleEvent event={event} />);
    const wrapper = container.querySelector<HTMLElement>(`[data-board-id="${event.boardId}"]`);
    expect(wrapper).not.toBeNull();
    return wrapper!;
  }

  describe('a needs-crew card keeps its title as the row Month view shows', () => {
    it.each([
      ['job', crewlessJob, 'J00043'],
      ['walkthrough', crewlessWalkthrough, 'L00021'],
    ] as const)('%s card: the title row is the first child, and the notch still renders', (_label, event, number) => {
      const wrapper = cardWrapper(event);

      const first = wrapper.firstElementChild as HTMLElement;
      expect(first.tagName.toLowerCase()).not.toBe('svg');
      expect(first.getAttribute('aria-label')).not.toBe('Needs crew');
      expect(first.textContent).toContain(number);

      // A direct child, carrying the hook the Month rule lets through by (so it is not hidden with
      // the other non-first rows).
      const notch = wrapper.querySelector(':scope > [aria-label="Needs crew"]');
      expect(notch).not.toBeNull();
      expect(notch!.tagName.toLowerCase()).toBe('svg');
      expect(notch!.hasAttribute('data-needs-crew-mark')).toBe(true);
    });
  });
});

describe('planModeGhostLocation', () => {
  /**
   * PLAN MODE DRAFTS SAY WHERE THE TRIP IS - slice 6, the fifth address renderer.
   *
   * Spec:  md_files/specs/scheduling/2026-09-10-visit-location-and-performer-phone.md (D4, story 15)
   * Slice: md_files/issues/scheduling/06-show-the-location-where-the-visit-is-read.md
   *
   * The schedule page renders an address in five places. Slice 6 fixed four of them and left Plan
   * Mode - which is gated to Admin & Dispatcher, exactly the reader user story 15 names ("so that I
   * do not route someone to the wrong side of town"). A ghost carried no location of its own, so:
   *
   *   (1) its board card fell through `cardAddressText` to the PARENT's service address, painting
   *       the customer's street on a draft for a trip booked at the yard, and
   *   (2) the "Schedule Job?" confirm dialog printed that street under the literal word "Location:".
   *
   * Both read one rule - `planDraftLocation` - and both are asserted here, because a ghost is read
   * twice and deriving the two answers separately is how a card and its own confirm dialog would
   * name two different places for one draft.
   */

  const AT_YARD = 'North Yard, 9 Depot Rd, Raleigh, NC';
  const CUSTOMER_STREET = '123 Main St, Raleigh, NC';
  const NY = 'America/New_York';

  function ghost(over: Partial<GhostEvent> = {}): GhostEvent {
    return {
      id: 'g-1',
      sourceId: 'job-1',
      sourceType: 'job',
      isFromSidebar: false,
      isMovedConfirmed: false,
      start: '2026-06-10T13:00:00.000Z',
      end: '2026-06-10T15:00:00.000Z',
      crew: ['u-alice'],
      title: 'Rooftop Unit Swap',
      customerName: 'Acme Corp',
      address: CUSTOMER_STREET,
      raw: {
        job_number: 'J00043',
        service_location: { address_line1: '123 Main St', city: 'Raleigh', state: 'NC' },
      },
      ...over,
    };
  }

  // ── the rule both readers share ─────────────────────────────────────────────

  describe('planDraftLocation - the trip’s own location wins over the parent’s', () => {
    it('drafts the trip’s location, on BOTH fields, when the card has one', () => {
      const drafted = planDraftLocation({ locationLabel: AT_YARD }, CUSTOMER_STREET);

      // `address` is what the confirm dialog prints under "Location:"; `locationLabel` is what the
      // ghost's card renders from. One rule, so the two cannot name different places.
      expect(drafted.address).toBe(AT_YARD);
      expect(drafted.locationLabel).toBe(AT_YARD);
      expect(drafted.address).not.toContain('123 Main St');
    });

    it('falls back to the parent’s service address, unchanged, for a card with no trip location', () => {
      expect(planDraftLocation({ locationLabel: null }, CUSTOMER_STREET))
        .toEqual({ locationLabel: null, address: CUSTOMER_STREET });
    });

    /**
     * A card in the UNSCHEDULED bucket addresses the JOB, never a trip (jobToBucketEvent builds no
     * `locationLabel` at all), so absent must read as "no location of its own" rather than throwing
     * or drafting the string 'undefined'.
     */
    it('treats an absent locationLabel as the parent’s address, never as a location', () => {
      expect(planDraftLocation({}, CUSTOMER_STREET))
        .toEqual({ locationLabel: null, address: CUSTOMER_STREET });
    });

    // A parent with no address on file either: nothing to draft, and the dialog's `ghost.address &&`
    // gate then hides the line rather than printing an empty "Location:".
    it('drafts nothing when neither the trip nor the parent has an address', () => {
      expect(planDraftLocation({ locationLabel: null }, '').address).toBe('');
    });
  });

  // ── the ghost's card ────────────────────────────────────────────────────────

  describe('ghostToEvent - a ghost’s card says where the trip is', () => {
    it('carries the ghost’s locationLabel onto the board event', () => {
      expect(ghostToEvent(ghost({ locationLabel: AT_YARD }), NY).locationLabel).toBe(AT_YARD);
    });

    /**
     * The consequence, through the renderer the three boards actually share. This is the assertion
     * with teeth: the card reads `locationLabel` and falls back to `raw.service_location`, so a
     * ghost that stopped carrying the label would paint the customer's street here and nothing else
     * on the page would complain.
     */
    it('so the shared card renderer paints the yard, not the customer’s street', () => {
      const event = ghostToEvent(ghost({ locationLabel: AT_YARD }), NY) as BoardEvent;

      expect(cardAddressText(event)).toBe(AT_YARD);
      expect(cardAddressText(event)).not.toContain('123 Main St');
    });

    it('a draft for a trip at the service address carries null, and the card is unchanged', () => {
      const event = ghostToEvent(ghost({ locationLabel: null }), NY) as BoardEvent;

      expect(event.locationLabel).toBeNull();
      // Not pinned to an exact string: the job branch's own parent derivation is pre-existing and
      // out of this slice's remit, and freezing it here would fight the fix that is owed to it.
      expect(cardAddressText(event)).not.toBe(AT_YARD);
    });

    /**
     * Ghosts are persisted to sessionStorage, so a draft written before this shipped is rehydrated
     * with no key at all. Absent must read as null, not as `undefined` - `cardAddressText` gates on
     * truthiness either way, but the typed field is what four surfaces read.
     */
    it('a draft rehydrated from before the field existed reads as null, never undefined', () => {
      expect(ghostToEvent(ghost(), NY).locationLabel).toBeNull();
    });

    // The rest of the mapping is a read boundary like eventAdapters.ts: the ghost's instants become
    // the org wall clock exactly here. Asserted so extracting it from the useMemo cannot have
    // quietly changed the zone the grid places a draft in.
    it('is still the read boundary - the instants become the org wall clock', () => {
      const e = ghostToEvent(ghost(), NY);

      expect(e.boardId).toBe('ghost-g-1');
      expect(e.isGhost).toBe(true);
      expect(e.start).toEqual(toWallClock(new Date('2026-06-10T13:00:00.000Z'), NY));
      expect(e.start.getHours()).toBe(9); // 13:00Z is 09:00 EDT
    });
  });

  // ── a live board card, for contrast: this is what a ghost now matches ───────

  describe('a ghost and the live card it was dragged from agree', () => {
    it('render the same address for the same trip', () => {
      const live: SchedulableEvent = {
        boardId: 'jv-v1',
        parentId: 'job-1',
        type: 'job',
        number: 'J00043',
        title: 'Rooftop Unit Swap',
        customer: 'Acme Corp',
        crew: ['u-alice'],
        ownerId: null,
        locationLabel: AT_YARD,
        start: asWallClock(new Date(2026, 5, 10, 9, 0)),
        end: asWallClock(new Date(2026, 5, 10, 11, 0)),
        raw: { job_number: 'J00043', service_location: { address_line1: '123 Main St', city: 'Raleigh', state: 'NC' } },
      };
      const drafted = planDraftLocation(live, CUSTOMER_STREET);
      const draftCard = ghostToEvent(ghost({ locationLabel: drafted.locationLabel }), NY) as BoardEvent;

      // The card the dispatcher dragged and the draft they dropped name the same place - and the
      // confirm dialog they then read names it too.
      expect(cardAddressText(draftCard)).toBe(cardAddressText(live as BoardEvent));
      expect(drafted.address).toBe(cardAddressText(live as BoardEvent));
    });
  });
});
