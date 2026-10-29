/**
 * The eye toggle on the routed sign-in and accept-invite screens (password reset spec §6, slice 01).
 *
 * The component's own contract lives in ui-kit/components/ui/passwordInput.test.tsx; this file
 * checks each screen wires it up: the eye is there, it never submits, autofill hints are right,
 * the E2E selectors survive, and a revealed password does not follow the user into the
 * email-code step. Typed values are generated per run, never literals.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { renderWithProviders } from '@/__tests__/helpers';
import { useAuthStore } from '@/stores/auth.store';
import { getInviteInfo, acceptInvite } from '@/lib/api/invite';
import LoginPage from '@/pages/v2/auth-public/LoginPage';
import AcceptInvitePage from '@/pages/v2/auth-public/AcceptInvitePage';

vi.mock('@/lib/api/invite', () => ({
  getInviteInfo: vi.fn(),
  acceptInvite: vi.fn(),
  recordInviteConsent: vi.fn(),
}));

const login = vi.fn();
const verifyMfa = vi.fn();
const loginWithGoogle = vi.fn();
const typedValue = () => `t-${Math.random().toString(36).slice(2, 12)}`;

beforeEach(() => {
  vi.clearAllMocks();
  const state = { login, verifyMfa, loginWithGoogle, user: null, isAuthenticated: false, isLoading: false };
  vi.mocked(useAuthStore).mockImplementation(((selector?: (s: unknown) => unknown) =>
    selector ? selector(state) : state) as unknown as typeof useAuthStore);
});

describe('sign-in page eye toggle', () => {
  it('keeps #email, #password and both "Sign In" names, with the eye beside the password', () => {
    renderWithProviders(<LoginPage />, { initialEntries: ['/login'] });
    expect(document.querySelector('#email')).toBeTruthy();
    expect(document.querySelector('#password')).toBe(screen.getByLabelText('Password'));
    expect(screen.getByRole('heading', { name: 'Sign In' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Sign In' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Show password' })).toHaveAttribute('aria-controls', 'password');
    expect(screen.getByLabelText('Password')).toHaveAttribute('autocomplete', 'current-password');
  });

  it('revealing the password shows it and does not sign in', async () => {
    const user = userEvent.setup();
    renderWithProviders(<LoginPage />, { initialEntries: ['/login'] });
    await user.type(screen.getByLabelText('Email'), 'someone@test.com');
    await user.type(screen.getByLabelText('Password'), typedValue());

    await user.click(screen.getByRole('button', { name: 'Show password' }));

    expect(screen.getByLabelText('Password')).toHaveAttribute('type', 'text');
    expect(screen.getByLabelText('Password')).toHaveFocus();
    expect(login).not.toHaveBeenCalled();
  });

  it('a revealed password is not on screen once sign-in moves to the email-code step', async () => {
    const user = userEvent.setup();
    const secret = typedValue();
    login.mockResolvedValue({ mfaRequired: true, challengeId: 'ch-1' });
    renderWithProviders(<LoginPage />, { initialEntries: ['/login'] });
    await user.type(screen.getByLabelText('Email'), 'someone@test.com');
    await user.type(screen.getByLabelText('Password'), secret);
    await user.click(screen.getByRole('button', { name: 'Show password' }));

    await user.click(screen.getByRole('button', { name: 'Sign In' }));

    expect(await screen.findByLabelText('Verification code')).toBeInTheDocument();
    expect(screen.queryByDisplayValue(secret)).toBeNull();
    expect(screen.queryByRole('button', { name: 'Hide password' })).toBeNull();
  });
});

describe('accept-invite page eye toggles', () => {
  async function openInvite() {
    vi.mocked(getInviteInfo).mockResolvedValue({ email: 'invitee@test.com', first_name: 'In', phone: null, phone_ext: null });
    renderWithProviders(<AcceptInvitePage />, { initialEntries: ['/accept-invite?token=tok'] });
    await screen.findByLabelText('Phone number');
  }

  it('gives both password fields their own eye and keeps new-password autofill', async () => {
    await openInvite();
    for (const [label, id] of [['Password', 'password'], ['Confirm password', 'confirm']] as const) {
      const input = screen.getByLabelText(label);
      expect(input).toHaveAttribute('id', id);
      expect(input).toHaveAttribute('type', 'password');
      expect(input).toHaveAttribute('autocomplete', 'new-password');
    }
    const eyes = screen.getAllByRole('button', { name: 'Show password' });
    expect(eyes.map((b) => b.getAttribute('aria-controls'))).toEqual(['password', 'confirm']);
  });

  it('revealing a field does not submit the invitation', async () => {
    const user = userEvent.setup();
    await openInvite();
    await user.click(screen.getAllByRole('button', { name: 'Show password' })[0] as HTMLElement);
    expect(screen.getByLabelText('Password')).toHaveAttribute('type', 'text');
    expect(screen.getByLabelText('Confirm password')).toHaveAttribute('type', 'password');
    await waitFor(() => expect(acceptInvite).not.toHaveBeenCalled());
  });
});
