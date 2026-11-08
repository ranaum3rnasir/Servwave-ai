/**
 * Slice 07: "Book visit" works on the FIRST click, with the crew dropdown still open.
 *
 * Reported on the job "Add Visit" dialog: a dispatcher picks crew, and while the crew list is
 * still open clicks "Book visit". The first click only closed the list; nothing was booked until
 * a second click. Reproduced in a real browser before this file was written: while the list was
 * open, `<body>` carried `pointer-events: none` and the submit button's centre hit-tested to
 * nothing it owned, so the click never reached it.
 *
 * The default `userEvent` pointer check is what makes jsdom honest about that: it refuses to
 * click an element that has or inherits `pointer-events: none`, exactly as a browser's hit test
 * would. Do NOT set `pointerEventsCheck: 0` here - it dispatches straight onto the button and
 * would pass against the broken picker, testing nothing.
 *
 * Renders the real dialog and the real crew picker; only the network, the roster and the org
 * clock are stubbed.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import api from '@/lib/axios';
import { buildAbility } from '@/lib/ability';
import { renderWithProviders } from '@/__tests__/helpers';

import { VisitScheduleDialog } from '../components/visitScheduleDialog';

const JOB_ID = 'j0000000-0000-0000-0000-000000000007';

vi.mock('@/lib/api/users', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api/users')>()),
  useAssignableUsers: () => ({
    data: [
      { id: 'u-dana', first_name: 'Dana', last_name: 'Ruiz', role: 'TECHNICIAN', department: null },
      { id: 'u-sam', first_name: 'Sam', last_name: 'Okafor', role: 'TECHNICIAN', department: null },
      { id: 'u-toni', first_name: 'Toni', last_name: 'Lee', role: 'TECHNICIAN', department: null },
    ],
    isLoading: false,
  }),
}));

vi.mock('@/lib/schedule-tz', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/schedule-tz')>()),
  useScheduleTimezone: () => 'America/New_York',
}));

vi.mock('@/lib/axios', () => ({
  default: {
    post: vi.fn().mockResolvedValue({ data: {} }),
    patch: vi.fn().mockResolvedValue({ data: {} }),
    get: vi.fn().mockResolvedValue({ data: [] }),
  },
}));

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
global.ResizeObserver = ResizeObserverStub as unknown as typeof ResizeObserver;

const adminAbility = buildAbility([{ action: 'manage', subject: 'all' }]);

function renderDialog() {
  return renderWithProviders(
    <VisitScheduleDialog open onOpenChange={vi.fn()} jobId={JOB_ID} />,
    { ability: adminAbility },
  );
}

async function fillWindow(user: ReturnType<typeof userEvent.setup>) {
  for (const [id, text] of [
    ['job-visit-start-date', '10/05/2026'],
    ['job-visit-start-time', '9:00 AM'],
    ['job-visit-end-date', '10/05/2026'],
    ['job-visit-end-time', '11:00 AM'],
  ] as const) {
    const input = document.getElementById(id) as HTMLInputElement;
    await user.clear(input);
    await user.type(input, text);
    await user.tab();
  }
}

/** Picks one member (the list closes on a pick), then re-opens the list and leaves it OPEN. */
async function pickCrewAndLeaveTheListOpen(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole('combobox', { name: 'Crew' }));
  await user.click(await screen.findByRole('option', { name: /Dana Ruiz/ }));
  await user.click(screen.getByRole('combobox', { name: 'Crew' }));
  expect(await screen.findByRole('option', { name: /Sam Okafor/ })).toBeInTheDocument();
}

const visitPosts = () =>
  vi.mocked(api.post).mock.calls.filter(([url]) => String(url) === `/api/jobs/${JOB_ID}/visits`);

beforeEach(() => {
  vi.clearAllMocks();
});

describe('job "Add Visit" dialog - Book visit with the crew list open', () => {
  it('books the visit on ONE click, carrying the crew just picked', async () => {
    const user = userEvent.setup();
    renderDialog();
    await fillWindow(user);
    // Held before the list opens: an open list may hide the rest of the page from the
    // accessibility tree, and the test is about the click, not about finding the button.
    const bookVisit = screen.getByRole('button', { name: /^book visit$/i });

    await pickCrewAndLeaveTheListOpen(user);
    await user.click(bookVisit);

    await waitFor(() => expect(visitPosts()).toHaveLength(1));
    expect((visitPosts()[0]![1] as { assignee_ids: string[] }).assignee_ids).toEqual(['u-dana']);
  });
});

describe('job "Add Visit" dialog - what the fix must NOT change', () => {
  it('a click on blank space with the crew list open only closes the list', async () => {
    const user = userEvent.setup();
    const onOpenChange = vi.fn();
    renderWithProviders(
      <VisitScheduleDialog open onOpenChange={onOpenChange} jobId={JOB_ID} />,
      { ability: adminAbility },
    );
    await fillWindow(user);
    const title = screen.getByRole('heading', { name: 'Add Visit' });

    await pickCrewAndLeaveTheListOpen(user);
    await user.click(title);

    await waitFor(() => expect(screen.queryByRole('option')).not.toBeInTheDocument());
    expect(visitPosts()).toHaveLength(0);
    expect(onOpenChange).not.toHaveBeenCalled();
    // The pick made before the list was re-opened is kept, and nothing else was added.
    expect(screen.getByRole('button', { name: 'Remove Dana Ruiz' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Remove Sam Okafor/ })).not.toBeInTheDocument();
  });

  it('keyboard only: open the list, pick with the arrows, submit - books with that crew', async () => {
    const user = userEvent.setup();
    renderDialog();
    await fillWindow(user);

    screen.getByRole('combobox', { name: 'Crew' }).focus();
    await user.keyboard('{Enter}');
    await screen.findByRole('option', { name: /Dana Ruiz/ });
    // Second row: the list opens on the first, ArrowDown moves one.
    await user.keyboard('{ArrowDown}{Enter}');
    expect(await screen.findByRole('button', { name: 'Remove Sam Okafor' })).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByRole('option')).not.toBeInTheDocument());

    const bookVisit = screen.getByRole('button', { name: /^book visit$/i });
    for (let i = 0; i < 20 && document.activeElement !== bookVisit; i += 1) await user.tab();
    expect(document.activeElement).toBe(bookVisit);
    await user.keyboard('{Enter}');

    await waitFor(() => expect(visitPosts()).toHaveLength(1));
    expect((visitPosts()[0]![1] as { assignee_ids: string[] }).assignee_ids).toEqual(['u-sam']);
  });
});
