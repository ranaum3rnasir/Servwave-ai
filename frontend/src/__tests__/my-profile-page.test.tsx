import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithProviders } from './helpers';
import { useAuthStore } from '@/stores/auth.store';
import { useUpdateMe, useChangeMyPassword, useSetAvatar, useDeleteAvatar } from '@/lib/api/users';
import MyProfilePage from '@/pages/settings/MyProfilePage';

// ── Mock the settings shell so we don't drag in the whole guarded layout. ──
// MyProfilePage registers its save handler with the shell via
// useSettingsBar().registerSaver; capture it so the test can invoke the same
// path the shell's "Save Changes" button would.
let registeredSave: (() => Promise<void> | void) | null = null;
vi.mock('@/pages/settings/SettingsLayout', () => ({
  useSettingsBar: () => ({
    registerSaver: (fns: { save: () => Promise<void> | void }) => {
      registeredSave = fns.save;
    },
  }),
}));

// ── Mock the self-service hooks. ──
vi.mock('@/lib/api/users', () => ({
  useUpdateMe: vi.fn(),
  useChangeMyPassword: vi.fn(),
  useSetAvatar: vi.fn(),
  useDeleteAvatar: vi.fn(),
}));

// MyTimeLog is self-fetching (usePunches); stub it so these focused
// profile-form tests don't issue timeclock queries.
vi.mock('@/components/timeclock/MyTimeLog', () => ({
  default: () => null,
  MyTimeLog: () => null,
}));

const mockUseUpdateMe = vi.mocked(useUpdateMe);
const mockUseChangeMyPassword = vi.mocked(useChangeMyPassword);
const mockUseSetAvatar = vi.mocked(useSetAvatar);
const mockUseDeleteAvatar = vi.mocked(useDeleteAvatar);
const mockUseAuthStore = vi.mocked(useAuthStore);

// The updated row PATCH /api/users/me returns.
const UPDATED_ROW = {
  id: 'u1',
  email: 'tech@test.com',
  first_name: 'Janet',
  last_name: 'Tester',
  role: 'TECHNICIAN',
  is_active: true,
  has_login: true,
  phone: '5559998888',
  phone_ext: null,
  department_id: null,
  department: null,
  enforce_clock_in_location: false,
  can_approve_clock_overrides: false,
  created_at: '2026-01-01T00:00:00.000Z',
  updated_at: '2026-01-01T00:00:00.000Z',
};

let updateMutate: ReturnType<typeof vi.fn>;
let passwordMutate: ReturnType<typeof vi.fn>;
let applyUserPatch: ReturnType<typeof vi.fn>;

interface MockUser {
  id: string;
  email: string;
  first_name: string;
  last_name: string;
  role: string;
  organization_id: string;
  phone?: string | null;
  phone_ext?: string | null;
  has_login?: boolean;
}

function setUser(user: MockUser) {
  applyUserPatch = vi.fn();
  mockUseAuthStore.mockImplementation((selector: (s: Record<string, unknown>) => unknown) =>
    selector({ user, applyUserPatch }),
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  registeredSave = null;

  updateMutate = vi.fn().mockResolvedValue(UPDATED_ROW);
  passwordMutate = vi.fn().mockResolvedValue({ message: 'Password updated' });

  mockUseUpdateMe.mockReturnValue({ mutateAsync: updateMutate } as unknown as ReturnType<
    typeof useUpdateMe
  >);
  mockUseChangeMyPassword.mockReturnValue({
    mutateAsync: passwordMutate,
    isPending: false,
  } as unknown as ReturnType<typeof useChangeMyPassword>);
  mockUseSetAvatar.mockReturnValue({
    mutateAsync: vi.fn().mockResolvedValue({ avatar_url: null }),
    isPending: false,
  } as unknown as ReturnType<typeof useSetAvatar>);
  mockUseDeleteAvatar.mockReturnValue({
    mutateAsync: vi.fn().mockResolvedValue({ avatar_url: null }),
    isPending: false,
  } as unknown as ReturnType<typeof useDeleteAvatar>);

  setUser({
    id: 'u1',
    email: 'tech@test.com',
    first_name: 'Jane',
    last_name: 'Tester',
    role: 'TECHNICIAN',
    organization_id: 'o1',
    phone: '5551112222',
    phone_ext: '',
    has_login: true,
  });
});

describe('MyProfilePage', () => {
  it('submits changed profile fields via useUpdateMe and refreshes the auth store', async () => {
    const user = userEvent.setup();
    renderWithProviders(<MyProfilePage />);

    // first_name is pre-filled from the store; change it and Save.
    const firstName = screen.getByDisplayValue('Jane');
    await user.clear(firstName);
    await user.type(firstName, 'Janet');

    // Trigger the save the same way the (mocked-away) shell's "Save Changes"
    // button does: by invoking the handler the page registered with the shell.
    expect(registeredSave).toBeTruthy();
    await act(async () => {
      await registeredSave!();
    });

    await vi.waitFor(() => expect(updateMutate).toHaveBeenCalledTimes(1));
    // Only the dirty field is sent.
    expect(updateMutate).toHaveBeenCalledWith({ first_name: 'Janet' });
    // Store refreshed from the returned row so the header reflects the new name.
    await vi.waitFor(() =>
      expect(applyUserPatch).toHaveBeenCalledWith(
        expect.objectContaining({ first_name: 'Janet', last_name: 'Tester' }),
      ),
    );
  });

  it('changes the password via useChangeMyPassword', async () => {
    const user = userEvent.setup();
    const { container } = renderWithProviders(<MyProfilePage />);

    // The Field labels aren't htmlFor-associated, so target the three password
    // inputs by type (current, new, confirm — in DOM order). SECURITY (review #4):
    // the current password is now required and sent to the re-auth-gated endpoint.
    const [currentPw, newPw, confirmPw] = Array.from(
      container.querySelectorAll<HTMLInputElement>('input[type="password"]'),
    );
    expect(currentPw).toBeTruthy();
    expect(newPw).toBeTruthy();
    expect(confirmPw).toBeTruthy();
    await user.type(currentPw, 'oldsecret');
    await user.type(newPw, 'supersecret');
    await user.type(confirmPw, 'supersecret');

    await user.click(screen.getByRole('button', { name: /update password/i }));

    await vi.waitFor(() =>
      expect(passwordMutate).toHaveBeenCalledWith({ currentPassword: 'oldsecret', newPassword: 'supersecret' }),
    );
  });

  it('hides the change-password section when has_login is false', () => {
    setUser({
      id: 'u2',
      email: 'google-only@test.com',
      first_name: 'Greg',
      last_name: 'Oauth',
      role: 'TECHNICIAN',
      organization_id: 'o1',
      phone: null,
      phone_ext: null,
      has_login: false,
    });
    renderWithProviders(<MyProfilePage />);

    expect(screen.getByText('My Details')).toBeInTheDocument();
    expect(screen.queryByText('Change Password')).not.toBeInTheDocument();
  });
});
