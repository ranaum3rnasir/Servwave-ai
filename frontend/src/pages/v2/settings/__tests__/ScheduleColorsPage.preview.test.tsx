/**
 * Settings > Schedule Colors - the live preview.
 *
 * The preview must show what the board will paint for the DRAFT (unsaved) colours: the same
 * paint function, resolved against the draft's derived vars, updating on every swatch click and
 * saving nothing.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { boardEventPaint } from '@/components/schedule/boardEventPaint';
import { buildScheduleEventColorVars } from '@/lib/schedule/useScheduleEventColorVars';

const { mutateAsync, mutate, ORG } = vi.hoisted(() => ({
  mutateAsync: vi.fn(),
  mutate: vi.fn(),
  // ONE object for every render, as react-query hands back: the page re-hydrates when `org` changes.
  ORG: { data: { id: 'org-1', schedule_event_colors: {} } },
}));
vi.mock('@/lib/api/organization', () => ({
  useOrganization: () => ORG,
  useUpdateOrganization: () => ({ mutateAsync, mutate, isPending: false }),
}));

import ScheduleColorsPage from '../ScheduleColorsPage';

const STATES = ['job', 'walkthrough', 'calendar-entry', 'double-booked', 'in-progress', 'completed'];

function preview() {
  return screen.getByTestId('schedule-colors-preview');
}
function card(state: string) {
  const el = preview().querySelector<HTMLElement>(`[data-preview-state="${state}"]`);
  if (!el) throw new Error(`no ${state} sample`);
  return el;
}
const classesOf = (el: HTMLElement) => el.className.split(/\s+/).filter(Boolean);

beforeEach(() => {
  mutateAsync.mockReset();
  mutate.mockReset();
});

describe('Schedule Colors live preview', () => {
  it('renders one sample card per board state, plus the service-plan bucket row', () => {
    render(<ScheduleColorsPage />);
    expect(screen.getByRole('heading', { name: 'Preview' })).toBeInTheDocument();
    expect(screen.getByText('How cards will look on the schedule.')).toBeInTheDocument();
    for (const s of STATES) expect(card(s)).toBeInTheDocument();
    expect(card('service-plan')).toBeInTheDocument();
    expect(within(card('job')).getByText(/J00052/)).toBeInTheDocument();
    expect(within(card('job')).getByText(/Sample Customer/)).toBeInTheDocument();
    expect(within(card('job')).getByText('Installation')).toBeInTheDocument();
  });

  it("paints every sample with the board's own paint, class for class", () => {
    render(<ScheduleColorsPage />);
    const base = { isGhost: false, highlight: {}, canDragCalendarEntry: false, completed: false, inFlight: false, dangerState: null } as const;
    const expected: Record<string, string | undefined> = {
      job: boardEventPaint({ ...base, type: 'job' }).className,
      walkthrough: boardEventPaint({ ...base, type: 'walkthrough' }).className,
      'calendar-entry': boardEventPaint({ ...base, type: 'calendar-entry' }).className,
      'double-booked': boardEventPaint({ ...base, type: 'job', dangerState: 'double-booked' }).className,
      'in-progress': boardEventPaint({ ...base, type: 'job', inFlight: true }).className,
      completed: boardEventPaint({ ...base, type: 'job', completed: true }).className,
    };
    for (const s of STATES) expect(card(s).className).toBe(expected[s]);
  });

  it('the double-booked sample keeps its type surface and gains the amber frame, never the white card', () => {
    render(<ScheduleColorsPage />);
    const cls = classesOf(card('double-booked'));
    expect(cls).toContain('!bg-ev-job-surface');
    // A 2px amber outline over all four edges (was a three-sided border; see boardEventPaint).
    expect(cls).toContain('!outline-warning');
    expect(cls).toContain('!outline-2');
    expect(cls).toContain('!border-l-ev-job-border');
    expect(cls.some((c) => c.includes('bg-surface-light'))).toBe(false);
  });

  it('a swatch click repaints the preview from the draft, without saving', async () => {
    render(<ScheduleColorsPage />);
    const wrapper = preview();
    const before = wrapper.style.getPropertyValue('--ev-job-surface');
    expect(before).toBe(String(buildScheduleEventColorVars({})['--ev-job-surface' as keyof object]));

    const group = screen.getByRole('radiogroup', { name: /job colour/i });
    await userEvent.click(within(group).getByRole('radio', { name: /light sage/i }));

    const after = wrapper.style.getPropertyValue('--ev-job-surface');
    expect(after).not.toBe(before);
    expect(after).toBe(String(buildScheduleEventColorVars({ job: 'sage-500' })['--ev-job-surface' as keyof object]));
    // Only the draft moved: nothing was written to the server, and nothing to the document root.
    expect(mutateAsync).not.toHaveBeenCalled();
    expect(mutate).not.toHaveBeenCalled();
    expect(document.documentElement.style.getPropertyValue('--ev-job-surface')).toBe('');
  });

  it('names the chosen colour next to its type, so the picker reads as a legend', async () => {
    render(<ScheduleColorsPage />);
    const group = screen.getByRole('radiogroup', { name: /walkthrough colour/i });
    await userEvent.click(within(group).getByRole('radio', { name: 'Purple' }));
    expect(screen.getByText('Purple', { selector: '[data-chosen-colour]' })).toBeInTheDocument();
  });
});
