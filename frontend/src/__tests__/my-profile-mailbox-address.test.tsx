/// <reference types="@testing-library/jest-dom/vitest" />
/**
 * Roles & Permissions, PRD 10, slice S10.3 - the person's own email address on the ROUTED My Profile screen.
 *
 * Imports `@/pages/v2/settings/MyProfilePage`, what `pages/v2/routes/settings.routes.tsx` mounts at /settings/profile.
 * An active mailbox shows its address with a copy button, a
 * mailbox in "address needed" shows no address, and neither shows while the company lacks the Email plan feature.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithProviders, seedMySwitches } from './helpers';
import { useAuthStore } from '@/stores/auth.store';
import { useUpdateMe } from '@/lib/api/users';
import MyProfilePage from '@/pages/v2/settings/MyProfilePage';

vi.mock('@/pages/v2/settings/settingsBar', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/pages/v2/settings/settingsBar')>()),
  useSettingsBar: () => ({ registerSaver: vi.fn() }),
}));
vi.mock('@/lib/api/users', () => ({ useUpdateMe: vi.fn() }));
vi.mock('@/components/timeclock/MyTimeLog', () => ({ default: () => null, MyTimeLog: () => null }));

let mailbox: { status: string; address: string | null } | null = null;
vi.mock('@/lib/api/communication', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api/communication')>()),
  useMyMailbox: () => ({ data: { mailbox } }),
}));

let emailFeature = true;
vi.mock('@/lib/entitlements', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/entitlements')>()),
  useFeature: (key: string) => (key === 'email' ? emailFeature : true),
}));

const NEEDED_SENTENCE = "You don't have an email address yet. An admin needs to set one before you can send email.";

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  // The address is read only by a person whose Show Email is on (M7, ticket 36). Show Email needs Access Communication.
  seedMySwitches({ show_email: true, access_communication: true }, 'u1');
  emailFeature = true;
  mailbox = null;
  vi.mocked(useUpdateMe).mockReturnValue({ mutateAsync: vi.fn() } as unknown as ReturnType<typeof useUpdateMe>);
  const state = {
    user: {
      id: 'u1', email: 'tech@test.com', first_name: 'Jane', last_name: 'Smith', role: 'TECHNICIAN',
      organization_id: 'o1', phone: '', phone_ext: '', has_login: true,
    },
    applyUserPatch: vi.fn(),
  };
  vi.mocked(useAuthStore).mockImplementation((selector: (s: Record<string, unknown>) => unknown) => selector(state));
});

describe('My Profile: your company email address', () => {
  it('shows the address with a copy button that copies it, apart from the email you sign in with', async () => {
    mailbox = { status: 'active', address: 'jane.smith.acme@mail.example.test' };
    const user = userEvent.setup();
    const writeText = vi.spyOn(navigator.clipboard, 'writeText');
    renderWithProviders(<MyProfilePage />);

    expect(await screen.findByText('jane.smith.acme@mail.example.test')).toBeInTheDocument();
    expect(screen.getByText('Company email address')).toBeInTheDocument();
    // the sign-in email is still its own, read-only field
    expect(screen.getByDisplayValue('tech@test.com')).toBeDisabled();
    await user.click(screen.getByRole('button', { name: 'Copy your email address' }));
    expect(writeText).toHaveBeenCalledWith('jane.smith.acme@mail.example.test');
    await waitFor(() => expect(screen.getByRole('button', { name: 'Copy your email address' })).toHaveTextContent('Copied'));
  });

  it('says there is no address yet for a person in "address needed", with no copy button', async () => {
    mailbox = { status: 'address_needed', address: null };
    renderWithProviders(<MyProfilePage />);
    expect(await screen.findByText(NEEDED_SENTENCE)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Copy your email address' })).not.toBeInTheDocument();
  });

  it('shows nothing about an address for a person with no mailbox', async () => {
    mailbox = null;
    renderWithProviders(<MyProfilePage />);
    await screen.findByText('My Details');
    expect(screen.queryByText('Company email address')).not.toBeInTheDocument();
    expect(screen.queryByText(NEEDED_SENTENCE)).not.toBeInTheDocument();
  });

  it('shows neither to a person whose Show Email is off (the server refuses them the address)', async () => {
    seedMySwitches({ show_email: false }, 'u1');
    for (const box of [{ status: 'active', address: 'jane.smith.acme@mail.example.test' }, { status: 'address_needed', address: null }]) {
      mailbox = box;
      const { unmount } = renderWithProviders(<MyProfilePage />);
      await screen.findByText('My Details');
      expect(screen.queryByText('jane.smith.acme@mail.example.test')).not.toBeInTheDocument();
      expect(screen.queryByText(NEEDED_SENTENCE)).not.toBeInTheDocument();
      unmount();
    }
  });

  it('shows neither while the company lacks the Email plan feature', async () => {
    emailFeature = false;
    for (const box of [{ status: 'active', address: 'jane.smith.acme@mail.example.test' }, { status: 'address_needed', address: null }]) {
      mailbox = box;
      const { unmount } = renderWithProviders(<MyProfilePage />);
      await screen.findByText('My Details');
      expect(screen.queryByText('jane.smith.acme@mail.example.test')).not.toBeInTheDocument();
      expect(screen.queryByText(NEEDED_SENTENCE)).not.toBeInTheDocument();
      unmount();
    }
  });
});
