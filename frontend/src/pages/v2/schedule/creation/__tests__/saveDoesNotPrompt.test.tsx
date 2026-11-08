/**
 * A successful save must CLOSE the creation popover, never ask whether to discard it.
 *
 * The bug this pins: `finish()` cleared the dirty flag and then called the same
 * `requestClose` a user dismissal uses. Clearing is a state update, so the `requestClose`
 * the body was holding still closed over `dirty === true` in that tick, took the discard
 * branch, and asked whether to throw away the event it had just created. Pressing Create
 * both created the thing AND prompted.
 *
 * The other half matters just as much and is asserted here too: the dirty guard must still
 * fire for a real dismissal. A fix that simply stopped prompting would pass the first test
 * and silently destroy typed input in the second.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';

import api from '@/lib/axios';

import { ScheduleCreatePopover } from '../scheduleCreatePopover';

vi.mock('@/lib/axios', () => ({
  default: { post: vi.fn(), get: vi.fn(() => Promise.resolve({ data: {} })) },
}));

// The Event tab's participant pickers each fetch; neither is what these tests are about.
vi.mock('@/lib/api/users', () => ({
  useAssignableUsers: () => ({ data: [], isLoading: false }),
}));

const mockedPost = vi.mocked(api.post);

function renderPopover(onOpenChange = vi.fn()) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  render(
    <MemoryRouter>
      <QueryClientProvider client={client}>
        <ScheduleCreatePopover
          open
          onOpenChange={onOpenChange}
          anchor={{ x: 100, y: 100 }}
          tz="America/New_York"
          unassignedJobs={[]}
          unscheduledWalkthroughs={[]}
        />
      </QueryClientProvider>
    </MemoryRouter>,
  );
  return { onOpenChange };
}

/** The Event tab is the cheapest door: a title alone makes the form valid AND dirty. */
async function startAnEvent(user: ReturnType<typeof userEvent.setup>, title = 'Team standup') {
  await user.click(screen.getByRole('tab', { name: 'Event' }));
  await user.type(screen.getByLabelText('Title'), title);
}

describe('the creation popover closes on save and guards on dismissal', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedPost.mockResolvedValue({ data: { id: 'entry-1' } });
  });

  it('creates and closes, without asking whether to discard', async () => {
    const user = userEvent.setup();
    const { onOpenChange } = renderPopover();

    await startAnEvent(user);
    await user.click(screen.getByRole('button', { name: 'Create' }));

    await waitFor(() => expect(mockedPost).toHaveBeenCalledWith('/api/calendar-entries', expect.anything()));
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));

    // The whole point: no prompt about the thing that was just saved.
    expect(screen.queryByText('Discard this draft?')).not.toBeInTheDocument();
  });

  it('still asks before discarding when the user dismisses a dirty form', async () => {
    const user = userEvent.setup();
    const { onOpenChange } = renderPopover();

    await startAnEvent(user, 'Half-typed thing');
    await user.click(screen.getByRole('button', { name: 'Cancel' }));

    expect(await screen.findByText('Discard this draft?')).toBeInTheDocument();
    // Prompting is not closing: the draft is still there until the answer comes back.
    expect(onOpenChange).not.toHaveBeenCalledWith(false);
    expect(mockedPost).not.toHaveBeenCalled();
  });

  it('closes without a prompt when the user dismisses an untouched form', async () => {
    const user = userEvent.setup();
    const { onOpenChange } = renderPopover();

    await user.click(screen.getByRole('button', { name: 'Cancel' }));

    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(screen.queryByText('Discard this draft?')).not.toBeInTheDocument();
  });
});
