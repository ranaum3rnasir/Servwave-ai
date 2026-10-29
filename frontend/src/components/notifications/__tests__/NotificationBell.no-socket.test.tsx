/// <reference types="@testing-library/jest-dom/vitest" />
// Mobile slice 75 follow-up: the bell never opens a live subscription to the auth provider.
// A failed socket makes the browser print the provider's address in the console (all three
// engines do, and page code cannot suppress it), which the copy rule bans. The bell polls
// instead (see lib/api/__tests__/notifications-poll.test.tsx) and refreshes on window focus.
import { act, render } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import api from '@/lib/axios';
import { supabase } from '@/lib/supabase';
import { useAuthStore } from '@/stores/auth.store';
import { NotificationBell } from '../NotificationBell';

const mockApi = vi.mocked(api);
const UNREAD_URL = '/api/notifications/unread-count';

function mount() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: 5 * 60 * 1000, refetchOnWindowFocus: false } },
  });
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <NotificationBell />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

const unreadCalls = () => mockApi.get.mock.calls.filter(([u]) => u === UNREAD_URL).length;

beforeEach(() => {
  vi.clearAllMocks();
  // A signed-in user WITH an organization: the old subscription only started for one.
  vi.mocked(useAuthStore).mockImplementation(((selector: (s: Record<string, unknown>) => unknown) =>
    selector({ user: { id: 'user-1', organization_id: 'org-1' }, isAuthenticated: true })) as never);
  mockApi.get.mockImplementation(async (url: string) => {
    if (url === UNREAD_URL) return { data: { unseen: 0, needs_action: 0 } };
    return { data: { items: [], nextCursor: null } };
  });
});

describe('NotificationBell with a signed-in user', () => {
  it('opens no channel and applies no realtime token', async () => {
    mount();
    await act(async () => {});
    expect(supabase.channel).not.toHaveBeenCalled();
    expect(supabase.realtime.setAuth).not.toHaveBeenCalled();
  });

  it('refetches the unread count when the window regains focus', async () => {
    mount();
    await act(async () => {});
    const before = unreadCalls();
    expect(before).toBeGreaterThanOrEqual(1);

    await act(async () => {
      window.dispatchEvent(new Event('focus'));
    });
    await act(async () => {});
    expect(unreadCalls(), 'a focus event asks again').toBeGreaterThan(before);
  });
});
