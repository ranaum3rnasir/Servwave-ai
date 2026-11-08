import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import AcceptInvitePage from '@/pages/AcceptInvitePage';

const navigate = vi.fn();
vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual<typeof import('react-router-dom')>('react-router-dom');
  return { ...actual, useNavigate: () => navigate, useSearchParams: () => [new URLSearchParams('token=abc'), vi.fn()] };
});

const getInviteInfo = vi.fn();
const acceptInvite = vi.fn();
const recordInviteConsent = vi.fn();
vi.mock('@/lib/api/invite', () => ({
  getInviteInfo: (...a: unknown[]) => getInviteInfo(...a),
  acceptInvite: (...a: unknown[]) => acceptInvite(...a),
  recordInviteConsent: (...a: unknown[]) => recordInviteConsent(...a),
}));

const login = vi.fn();
const loginWithGoogle = vi.fn();
vi.mock('@/stores/auth.store', () => ({
  useAuthStore: Object.assign(
    (selector: (s: unknown) => unknown) => selector({ login, loginWithGoogle, user: { role: 'TECHNICIAN' } }),
    { getState: () => ({ user: { role: 'TECHNICIAN' } }) },
  ),
}));

beforeEach(() => {
  vi.clearAllMocks();
  getInviteInfo.mockResolvedValue({ email: 'jane@test.com', first_name: 'Jane' });
  acceptInvite.mockResolvedValue(undefined);
  recordInviteConsent.mockResolvedValue(undefined);
  login.mockResolvedValue(undefined);
});

function renderPage() {
  return render(<MemoryRouter><AcceptInvitePage /></MemoryRouter>);
}

describe('AcceptInvitePage', () => {
  it('greets the invitee after loading the token', async () => {
    renderPage();
    await waitFor(() => expect(screen.getAllByText(/jane@test.com/i).length).toBeGreaterThan(0));
  });

  it('sets a password then logs in and navigates', async () => {
    renderPage();
    await waitFor(() => expect(getInviteInfo).toHaveBeenCalledWith('abc'));
    await userEvent.type(screen.getByLabelText(/^password$/i), 'sup3rsecret');
    await userEvent.type(screen.getByLabelText(/confirm password/i), 'sup3rsecret');
    await userEvent.click(screen.getByRole('checkbox', { name: /agree to the terms of service and privacy policy/i }));
    await userEvent.click(screen.getByRole('button', { name: /set password & sign in/i }));
    await waitFor(() => expect(acceptInvite).toHaveBeenCalledWith('abc', 'sup3rsecret', true, null));
    await waitFor(() => expect(login).toHaveBeenCalledWith('jane@test.com', 'sup3rsecret'));
    expect(navigate).toHaveBeenCalledWith('/', { replace: true });
  });

  it('shows an error when the token is invalid', async () => {
    getInviteInfo.mockRejectedValue(new Error('invalid'));
    renderPage();
    await waitFor(() => expect(screen.getByText(/invalid or has expired/i)).toBeInTheDocument());
  });

  it('disables Continue with Google until the consent box is ticked', async () => {
    renderPage();
    await waitFor(() => expect(getInviteInfo).toHaveBeenCalledWith('abc'));
    const googleBtn = screen.getByRole('button', { name: /continue with google/i });
    expect(googleBtn).toBeDisabled();
    await userEvent.click(screen.getByRole('checkbox', { name: /agree to the terms of service and privacy policy/i }));
    expect(googleBtn).toBeEnabled();
  });

  it('records consent BEFORE starting Google sign-in', async () => {
    renderPage();
    await waitFor(() => expect(getInviteInfo).toHaveBeenCalledWith('abc'));
    await userEvent.click(screen.getByRole('checkbox', { name: /agree to the terms of service and privacy policy/i }));
    await userEvent.click(screen.getByRole('button', { name: /continue with google/i }));
    await waitFor(() => expect(recordInviteConsent).toHaveBeenCalledWith('abc', null));
    // Pins Google sign-in to the invited email so the browser can't silently
    // authenticate a different logged-in Google account.
    expect(loginWithGoogle).toHaveBeenCalledWith('jane@test.com');
    expect(recordInviteConsent.mock.invocationCallOrder[0]).toBeLessThan(
      loginWithGoogle.mock.invocationCallOrder[0],
    );
  });

  it('does NOT start Google sign-in if recording consent fails', async () => {
    recordInviteConsent.mockRejectedValue(new Error('boom'));
    renderPage();
    await waitFor(() => expect(getInviteInfo).toHaveBeenCalledWith('abc'));
    await userEvent.click(screen.getByRole('checkbox', { name: /agree to the terms of service and privacy policy/i }));
    await userEvent.click(screen.getByRole('button', { name: /continue with google/i }));
    await waitFor(() => expect(recordInviteConsent).toHaveBeenCalled());
    expect(loginWithGoogle).not.toHaveBeenCalled();
  });
});
