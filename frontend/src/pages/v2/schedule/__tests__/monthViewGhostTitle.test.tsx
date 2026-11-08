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
import { describe, it, expect } from 'vitest';
import { renderWithProviders } from '@/__tests__/helpers';
import { ScheduleEvent } from '@/pages/v2/schedule/SchedulePage';
import type { BoardEvent } from '@/components/schedule/scheduleModel';
import { asWallClock } from '@/lib/schedule-tz';

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
