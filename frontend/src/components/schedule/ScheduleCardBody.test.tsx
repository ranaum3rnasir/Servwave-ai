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
import { describe, it, expect, vi } from 'vitest';
import { screen } from '@testing-library/react';
import { renderWithProviders } from '@/__tests__/helpers';
import { MemberWeekBoard } from '@/components/schedule/MemberWeekBoard';
import { TechnicianGridView } from '@/components/schedule/TechnicianGridView';
import { ScheduleEvent } from '@/pages/v2/schedule/SchedulePage';
import type { SchedulableEvent } from '@/components/schedule/scheduleModel';
import { asWallClock } from '@/lib/schedule-tz';

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
