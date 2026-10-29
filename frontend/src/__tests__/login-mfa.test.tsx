import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import api from '@/lib/axios';
import { renderWithProviders } from './helpers';
import LoginPage from '@/pages/LoginPage';
import { useAuthStore } from '@/stores/auth.store';

const mockApi = vi.mocked(api);

const login = vi.fn();
const verifyMfa = vi.fn();
const loginWithGoogle = vi.fn();

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(useAuthStore).mockImplementation((selector: (s: Record<string, unknown>) => unknown) =>
    selector({
      login,
      verifyMfa,
      loginWithGoogle,
      user: null,
      isAuthenticated: false,
      isLoading: false,
      error: null,
    }),
  );
  // useAuthStore.getState() is read in onSubmit to pick the post-login route.
  (useAuthStore as unknown as { getState: () => unknown }).getState = () => ({
    user: { role: 'ADMIN' },
  });
});

async function submitCredentials() {
  const user = userEvent.setup();
  await user.type(screen.getByLabelText('Email'), 'a@b.com');
  await user.type(screen.getByLabelText('Password'), 'pw123456');
  await user.click(screen.getByRole('button', { name: 'Sign In' }));
  return user;
}

describe('LoginPage — email-OTP MFA step', () => {
  it('shows the 6-digit code step when login returns mfaRequired', async () => {
    login.mockResolvedValue({ mfaRequired: true, challengeId: 'chal_1' });
    renderWithProviders(<LoginPage />, { initialEntries: ['/login'] });

    await submitCredentials();

    expect(await screen.findByLabelText(/verification code/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /verify/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /resend/i })).toBeInTheDocument();
  });

  it('verifies the code and proceeds on success', async () => {
    login.mockResolvedValue({ mfaRequired: true, challengeId: 'chal_1' });
    verifyMfa.mockResolvedValue(undefined);
    renderWithProviders(<LoginPage />, { initialEntries: ['/login'] });

    const user = await submitCredentials();
    const codeInput = await screen.findByLabelText(/verification code/i);
    await user.type(codeInput, '123456');
    await user.click(screen.getByRole('button', { name: /verify/i }));

    await waitFor(() => expect(verifyMfa).toHaveBeenCalledWith('chal_1', '123456'));
  });

  it('shows an inline error when verification fails (401)', async () => {
    login.mockResolvedValue({ mfaRequired: true, challengeId: 'chal_1' });
    verifyMfa.mockRejectedValue(new Error('Invalid or expired code'));
    renderWithProviders(<LoginPage />, { initialEntries: ['/login'] });

    const user = await submitCredentials();
    const codeInput = await screen.findByLabelText(/verification code/i);
    await user.type(codeInput, '000000');
    await user.click(screen.getByRole('button', { name: /verify/i }));

    expect(await screen.findByText(/invalid or expired code/i)).toBeInTheDocument();
  });

  it('resends a code via /api/auth/mfa/resend', async () => {
    login.mockResolvedValue({ mfaRequired: true, challengeId: 'chal_1' });
    mockApi.post.mockResolvedValue({ data: { ok: true } });
    renderWithProviders(<LoginPage />, { initialEntries: ['/login'] });

    const user = await submitCredentials();
    await screen.findByLabelText(/verification code/i);
    await user.click(screen.getByRole('button', { name: /resend/i }));

    await waitFor(() =>
      expect(mockApi.post).toHaveBeenCalledWith('/api/auth/mfa/resend', { challengeId: 'chal_1' }),
    );
  });
});
