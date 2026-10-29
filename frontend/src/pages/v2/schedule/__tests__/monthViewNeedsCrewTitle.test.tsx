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
import { describe, it, expect } from 'vitest';
import { renderWithProviders } from '@/__tests__/helpers';
import { ScheduleEvent } from '@/pages/v2/schedule/SchedulePage';
import type { SchedulableEvent } from '@/components/schedule/scheduleModel';
import { asWallClock } from '@/lib/schedule-tz';

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
