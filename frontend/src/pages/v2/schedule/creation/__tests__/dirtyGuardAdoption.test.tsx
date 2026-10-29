/**
 * Mobile slice 43: the schedule create surface adopts the shared dirty guard.
 *
 * What changes for the user: a viewport resize (the on-screen keyboard opening, a phone turning,
 * a window dragged) never dismisses it - dirty or clean - and a dirty form is still protected on
 * every real way out (Escape here; the close and Cancel buttons are pinned in
 * saveDoesNotPrompt.test.tsx).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';

import { hasUnsavedWork } from '@/ui-kit/lib/unsavedWork';

import { ScheduleCreatePopover } from '../scheduleCreatePopover';

vi.mock('@/lib/axios', () => ({
  default: { post: vi.fn(), get: vi.fn(() => Promise.resolve({ data: {} })) },
}));
vi.mock('@/lib/api/users', () => ({
  useAssignableUsers: () => ({ data: [], isLoading: false }),
}));

function renderPopover(onOpenChange = vi.fn()) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
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

async function typeATitle(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole('tab', { name: 'Event' }));
  await user.type(screen.getByLabelText('Title'), 'Half-typed thing');
}

describe('the creation surface and the shared dirty guard', () => {
  beforeEach(() => vi.clearAllMocks());

  it('a viewport resize does not close or prompt a dirty form', async () => {
    const user = userEvent.setup();
    const { onOpenChange } = renderPopover();
    await typeATitle(user);

    act(() => {
      window.dispatchEvent(new Event('resize'));
    });

    expect(onOpenChange).not.toHaveBeenCalled();
    expect(screen.queryByText('Discard this draft?')).not.toBeInTheDocument();
    expect(screen.getByLabelText('Title')).toHaveValue('Half-typed thing');
  });

  it('a viewport resize does not close a clean form either', () => {
    const { onOpenChange } = renderPopover();
    act(() => {
      window.dispatchEvent(new Event('resize'));
    });
    expect(onOpenChange).not.toHaveBeenCalled();
  });

  it('Escape on a dirty form asks first', async () => {
    const user = userEvent.setup();
    const { onOpenChange } = renderPopover();
    await typeATitle(user);
    await user.keyboard('{Escape}');
    expect(await screen.findByText('Discard this draft?')).toBeInTheDocument();
    expect(onOpenChange).not.toHaveBeenCalled();
  });

  it('raises the shared unsaved-work signal while the form is dirty', async () => {
    const user = userEvent.setup();
    renderPopover();
    expect(hasUnsavedWork()).toBe(false);
    await typeATitle(user);
    expect(hasUnsavedWork()).toBe(true);
  });
});
