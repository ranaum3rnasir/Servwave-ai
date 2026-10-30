/**
 * Roles & Permissions security, ticket 36b (M17), finding F1: Login & Security is every person's own sign-in.
 *
 * The page holds the company's two-step policy (setup, an Admin's alone), and each person's OWN email code and OWN password. A
 * Technician, Dispatcher or Sales person who is not an Admin opens the page, sees the email code and the password, does not see the
 * company's policy card, has no Save bar saver registered, and changes their password through the same request as before. An Admin
 * still sees the policy card. Admin is the flag on the signed-in person (the auth store), never a switch or a role name.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import api from '@/lib/axios';
import { useAuthStore } from '@/stores/auth.store';
import { renderWithProviders } from './helpers';

const registerSaver = vi.fn();
vi.mock('@/pages/v2/settings/settingsBar', async (orig) => ({
  ...(await orig<typeof import('@/pages/v2/settings/settingsBar')>()),
  useSettingsBar: () => ({ registerSaver }),
}));

import SecurityPage from '@/pages/v2/settings/SecurityPage';

const mockApi = vi.mocked(api);

function signedIn(isAdmin: boolean) {
  vi.mocked(useAuthStore).mockImplementation(((selector: (state: Record<string, unknown>) => unknown) =>
    selector({
      user: { id: 'u-1', email: 'person@test.com', first_name: 'Test', last_name: 'Person', role: 'TECHNICIAN', is_admin: isAdmin },
      isAuthenticated: true,
      isLoading: false,
      error: null,
      logout: vi.fn(),
    })) as never);
}

beforeEach(() => {
  vi.clearAllMocks();
  mockApi.get.mockImplementation((url: string) => {
    if (url === '/api/auth/mfa/status') return Promise.resolve({ data: { enrolled: false } });
    if (url === '/api/users/me/password-status') return Promise.resolve({ data: { has_password: true } });
    return Promise.resolve({ data: { id: 'o1', mfa_sms_enabled: false } });
  });
});

describe('Login & Security for a person who is not an Admin', () => {
  it('shows the email code and the password, not the company\'s two-step policy, and registers nothing to save', async () => {
    signedIn(false);
    renderWithProviders(<SecurityPage />);

    expect(await screen.findByText('Email authentication')).toBeInTheDocument();
    expect(await screen.findByText('Change Password')).toBeInTheDocument();
    expect(screen.queryByText('Two-Factor Authentication')).not.toBeInTheDocument();
    expect(screen.queryByRole('switch', { name: 'Require SMS verification at login' })).not.toBeInTheDocument();
    expect(registerSaver).not.toHaveBeenCalled();
  });

  it('changes their own password through the same request as before', async () => {
    signedIn(false);
    const user = userEvent.setup();
    mockApi.post.mockResolvedValue({ data: { message: 'Password updated', other_sessions_signed_out: true, this_device_signed_out: false } });
    renderWithProviders(<SecurityPage />);
    await screen.findByLabelText(/^Current password/);

    const [current, next, confirm] = screen.getAllByDisplayValue('');
    await user.type(current!, 'the-old-one-1');
    await user.type(next!, 'the-new-one-22');
    await user.type(confirm!, 'the-new-one-22');
    await user.click(screen.getByRole('button', { name: 'Update password' }));

    await waitFor(() =>
      expect(mockApi.post).toHaveBeenCalledWith('/api/users/me/password', { current_password: 'the-old-one-1', password: 'the-new-one-22' }),
    );
  });
});

describe('Login & Security for an Admin', () => {
  it('also shows the company\'s two-step policy card, and registers the policy to save', async () => {
    signedIn(true);
    renderWithProviders(<SecurityPage />);

    expect(await screen.findByText('Two-Factor Authentication')).toBeInTheDocument();
    expect(screen.getByRole('switch', { name: 'Require SMS verification at login' })).toBeInTheDocument();
    expect(screen.getByText('Email authentication')).toBeInTheDocument();
    expect(registerSaver).toHaveBeenCalled();
  });
});
