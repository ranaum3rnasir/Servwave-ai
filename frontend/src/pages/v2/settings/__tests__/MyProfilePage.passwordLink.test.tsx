/**
 * My Profile points to Login & Security for the password (password reset spec §4.1, decision §9.1,
 * slice 03).
 *
 * Seams: the routed My Profile page inside the real v2 settings shell, navigating on the real
 * router; and the source tree, so the removed second form and the browser-side password write
 * cannot come back unnoticed.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Routes, Route } from 'react-router-dom';

import { renderWithProviders } from '@/__tests__/helpers';
import { sourceFiles } from '@/__tests__/layout-guards/scan';
import { useAuthStore } from '@/stores/auth.store';
import { useSettingsGuard } from '@/stores/settingsGuard.store';
import { useUpdateMe } from '@/lib/api/users';
import MyProfilePage from '@/pages/v2/settings/MyProfilePage';
import SettingsLayout from '@/pages/v2/settings/SettingsLayout';

vi.mock('@/lib/api/users', () => ({ useUpdateMe: vi.fn() }));
// Self-fetching (usePunches): stubbed so these specs issue no timeclock queries.
vi.mock('@/components/timeclock/MyTimeLog', () => ({ default: () => null, MyTimeLog: () => null }));

const LINK_NAME = 'Change your password in Login & Security';

beforeEach(() => {
  vi.clearAllMocks();
  useSettingsGuard.setState({ isDirty: false, pendingLeave: null });
  vi.mocked(useUpdateMe).mockReturnValue({ mutateAsync: vi.fn() } as unknown as ReturnType<typeof useUpdateMe>);
  const state = {
    user: {
      id: 'u1', email: 'me@test.com', first_name: 'Jane', last_name: 'Tester',
      role: 'TECHNICIAN', organization_id: 'o1', phone: '', phone_ext: '', has_login: true,
    },
    applyUserPatch: vi.fn(),
  };
  vi.mocked(useAuthStore).mockImplementation(((selector: (s: unknown) => unknown) =>
    selector(state)) as unknown as typeof useAuthStore);
});

function renderInShell() {
  const user = userEvent.setup();
  renderWithProviders(
    <Routes>
      <Route path="/settings" element={<SettingsLayout />}>
        <Route path="profile" element={<MyProfilePage />} />
        <Route path="security" element={<p>Login and Security page</p>} />
      </Route>
    </Routes>,
    { initialEntries: ['/settings/profile'] },
  );
  return user;
}

describe('My Profile - one place to change a password', () => {
  it('has no password fields and no change-password form', async () => {
    const { container } = renderWithProviders(<MyProfilePage />);
    await screen.findByDisplayValue('Jane');

    expect(container.querySelectorAll('input[type="password"]')).toHaveLength(0);
    expect(screen.queryByText('Change Password')).toBeNull();
    expect(screen.queryByRole('button', { name: /update password/i })).toBeNull();
    expect(screen.queryByText(/Google users can also set a password/i)).toBeNull();
  });

  it('shows a Password row whose link opens Login & Security', async () => {
    const user = renderInShell();
    await screen.findByDisplayValue('Jane');

    expect(screen.getByText('Password')).toBeInTheDocument();
    const link = screen.getByRole('link', { name: LINK_NAME });
    expect(link).toHaveAttribute('href', '/settings/security');

    await user.click(link);
    expect(await screen.findByText('Login and Security page')).toBeInTheDocument();
  });

  it('asks before leaving unsaved profile edits behind', async () => {
    const user = renderInShell();
    const firstName = await screen.findByDisplayValue('Jane');
    fireEvent.change(firstName, { target: { value: 'Janet' } });
    await waitFor(() => expect(useSettingsGuard.getState().isDirty).toBe(true));

    await user.click(screen.getByRole('link', { name: LINK_NAME }));

    // Held by the unsaved-changes guard, not navigated past it.
    expect(useSettingsGuard.getState().pendingLeave).not.toBeNull();
    expect(screen.queryByText('Login and Security page')).toBeNull();
    expect(screen.getByDisplayValue('Janet')).toBeInTheDocument();
  });
});

describe('the removed password code stays removed', () => {
  const files = sourceFiles();

  it('no screen uses the old My Profile password hook', () => {
    expect(files.filter(([, src]) => /\buseChangeMyPassword\b/.test(src)).map(([f]) => f)).toEqual([]);
  });

  it('no screen changes a password from the browser', () => {
    const offenders = files
      .filter(([, src]) => /\bsignInWithPassword\b|\bupdateUser\s*\(/.test(src))
      .map(([f]) => f);
    expect(offenders).toEqual([]);
  });

  it('the one password form posts to the server endpoint, from Login & Security only', () => {
    const callers = files.filter(([, src]) => src.includes("'/api/users/me/password'")).map(([f]) => f);
    expect(callers).toEqual(['pages/v2/settings/SecurityPage.tsx']);
  });
});
