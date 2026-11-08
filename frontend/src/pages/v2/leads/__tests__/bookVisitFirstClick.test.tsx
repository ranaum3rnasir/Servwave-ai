/**
 * Slice 07: the lead "Book Visit" form books on the FIRST click, with the Performers list open.
 *
 * Same defect as the job "Add Visit" dialog (see pages/v2/jobs/__tests__/bookVisitFirstClick):
 * while the shared crew picker's list was open, the page underneath it could not be clicked, so
 * the first click on "Book Visit" only closed the list. Reproduced in a real browser on this form
 * first - the click at the button's centre hit-tested to <html>, with `pointer-events: none` on
 * <body>.
 *
 * Keeps `userEvent`'s default pointer check on purpose: it is what models that hit test in jsdom.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { renderWithProviders } from '@/__tests__/helpers';
import { buildAbility } from '@/lib/ability';
import { useAuthStore } from '@/stores/auth.store';
import api from '@/lib/axios';
import { WalkthroughTabContent } from '../components/walkthroughTab';

const DISPATCHER = { id: 'u-disp', first_name: 'Dana', last_name: 'Dispatch' };
const TECH = { id: 'u-tech', first_name: 'Terry', last_name: 'Tech' };
const TECH_2 = { id: 'u-tech-2', first_name: 'Theo', last_name: 'Two' };

vi.mock('@/lib/api/users', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api/users')>()),
  useAssignableUsers: () => ({
    data: [DISPATCHER, TECH, TECH_2].map((u) => ({ ...u, role: 'TECHNICIAN', department: null })),
  }),
}));

vi.mock('@/lib/schedule-tz', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/schedule-tz')>()),
  useScheduleTimezone: () => 'America/New_York',
}));

vi.mock('@/lib/axios', () => ({
  default: { post: vi.fn().mockResolvedValue({ data: {} }), get: vi.fn().mockResolvedValue({ data: [] }) },
}));

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
global.ResizeObserver = ResizeObserverStub as unknown as typeof ResizeObserver;

const dispatcherAbility = buildAbility([
  { action: 'read', subject: 'Lead' },
  { action: 'schedule_walkthrough', subject: 'Lead' },
  { action: 'assign', subject: 'User' },
]);

/** A live walkthrough, so the tab offers "Book Another Visit" - the lead's Book Visit form. */
const BOOKED = {
  walkthrough_scheduled_at: '2026-09-10T15:00:00.000Z',
  walkthrough_completed_at: null,
  walkthrough_cancelled_at: null,
  walkthrough_duration_minutes: 60,
  walkthrough_notes: '',
  walkthrough_performers: [{ user: TECH_2 }],
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(useAuthStore).mockImplementation((selector: (s: never) => unknown) =>
    selector({
      user: { ...DISPATCHER, email: 'dana@example.test', role: 'DISPATCHER' },
      isAuthenticated: true,
      isLoading: false,
      error: null,
    } as never),
  );
});

const visitPosts = () =>
  vi.mocked(api.post).mock.calls.filter(([url]) => String(url) === '/api/leads/lead-1/visits');

describe('lead "Book Visit" form - Book Visit with the Performers list open', () => {
  it('books the visit on ONE click, carrying the performer just picked', async () => {
    const user = userEvent.setup();
    renderWithProviders(
      <WalkthroughTabContent
        lead={BOOKED}
        leadId="lead-1"
        canPerformWalkthrough={false}
        canScheduleWalkthrough
      />,
      { ability: dispatcherAbility },
    );
    await user.click(screen.getByRole('button', { name: /Book Another Visit/i }));

    const form = screen.getByText('Additional Visit').closest('div')!;
    const [startDate, startTime] = within(form)
      .getAllByRole('textbox')
      .filter((el) => (el as HTMLInputElement).type !== 'hidden');
    await user.type(startDate!, '10/06/2026');
    await user.type(startTime!, '09:00 AM');
    // Leave the time field, as a person does. Without it jsdom returns focus to the time list's
    // own button a tick AFTER the performers list has opened, closing it again - a jsdom timing
    // artefact: in a real browser the same sequence (type a time, click Performers) leaves the
    // list open, measured with Playwright on this form and the job dialog.
    await user.tab();
    // Held before the list opens - see the job-side twin of this file.
    const bookVisit = within(form).getByRole('button', { name: /^Book Visit$/i });

    const performers = within(form).getByRole('combobox', { name: /performers/i });
    await user.click(performers);
    await user.click(await screen.findByRole('option', { name: /Terry Tech/ }));
    await user.click(performers);
    expect(await screen.findByRole('option', { name: /Theo Two/ })).toBeInTheDocument();

    await user.click(bookVisit);

    await waitFor(() => expect(visitPosts()).toHaveLength(1));
    expect((visitPosts()[0]![1] as { assignee_ids: string[] }).assignee_ids).toContain(TECH.id);
  });
});
