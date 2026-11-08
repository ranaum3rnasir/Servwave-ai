import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithProviders } from '@/__tests__/helpers';
import { NotificationBell } from '../NotificationBell';
import api from '@/lib/axios';

vi.mock('@/lib/notifications/useNotificationRealtime', () => ({
  useNotificationRealtime: vi.fn(),
}));

vi.mock('@/lib/notifications/useInterruptToasts', () => ({
  useInterruptToasts: vi.fn(),
}));

describe('NotificationBell & NotificationPanel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders empty bell with no badge when unread API returns 0 and shows caught-up state when empty', async () => {
    vi.mocked(api.get).mockImplementation(async (url: string) => {
      if (url === '/api/notifications/unread-count') {
        return { data: { unread: 0, unseen: 0 } };
      }
      if (url === '/api/notifications') {
        return { data: { items: [], nextCursor: null } };
      }
      return { data: {} };
    });

    renderWithProviders(<NotificationBell />);

    // Bell button exists and has no unread count badge
    const bellBtn = screen.getByRole('button', { name: /Notifications/i });
    expect(bellBtn).toBeInTheDocument();
    expect(bellBtn.querySelector('.bg-notify')).toBeNull();

    // Click to open popover
    const user = userEvent.setup();
    await user.click(bellBtn);

    // Shows caught up message
    await waitFor(() => {
      expect(screen.getByText(/You're all caught up/i)).toBeInTheDocument();
    });
  });

  it('shows unread count badge on bell when unread notifications exist', async () => {
    vi.mocked(api.get).mockImplementation(async (url: string) => {
      if (url === '/api/notifications/unread-count') {
        return { data: { unread: 5, unseen: 3 } };
      }
      return { data: { items: [], nextCursor: null } };
    });

    renderWithProviders(<NotificationBell />);

    await waitFor(() => {
      expect(screen.getByText('3')).toBeInTheDocument();
    });
  });

  it('shows error message when notifications API query fails', async () => {
    vi.mocked(api.get).mockImplementation(async (url: string) => {
      if (url === '/api/notifications/unread-count') {
        return { data: { unread: 0, unseen: 0 } };
      }
      if (url === '/api/notifications') {
        throw new Error('Network Error');
      }
      return { data: {} };
    });

    renderWithProviders(<NotificationBell />);

    const bellBtn = screen.getByRole('button', { name: /Notifications/i });
    const user = userEvent.setup();
    await user.click(bellBtn);

    await waitFor(() => {
      expect(screen.getByText(/Failed to load notifications/i)).toBeInTheDocument();
    });
  });
});
