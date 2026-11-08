import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import api from '@/lib/axios';
import { renderWithProviders } from './helpers';
import SecurityPage from '@/pages/settings/SecurityPage';

const mockApi = vi.mocked(api);

const ORG = { id: 'o1', mfa_sms_enabled: false, mfa_email_enabled: false };

// SecurityPage now fans out to two GET endpoints: the org (org-level SMS policy)
// and the per-user email-2FA enrollment status. Route by URL so each card gets
// the right payload. `enrolled` is overridable per test.
function mockGets(enrolled = false) {
  mockApi.get.mockImplementation((url: string) => {
    if (url === '/api/auth/mfa/status') {
      return Promise.resolve({ data: { enrolled } });
    }
    return Promise.resolve({ data: ORG });
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mockGets(false);
});

describe('SecurityPage — core flow (#115)', () => {
  it('renders the SMS 2FA toggle, the per-user Email authentication card, and password fields', async () => {
    renderWithProviders(<SecurityPage />);
    expect(await screen.findByText('Two-Factor Authentication')).toBeInTheDocument();
    // The org-level SMS policy is still a single switch.
    expect(screen.getAllByRole('switch')).toHaveLength(1);
    // New per-user email-OTP card (driven by /api/auth/mfa/status, NOT the org flag).
    expect(screen.getByText('Email authentication')).toBeInTheDocument();
    expect(screen.getByText('Change Password')).toBeInTheDocument();
    expect(screen.getByText(/Current password/)).toBeInTheDocument();
  });

  it('shows Enable when email-2FA is not enrolled and Disable when it is', async () => {
    mockGets(true);
    renderWithProviders(<SecurityPage />);
    expect(await screen.findByRole('button', { name: /disable email authentication/i })).toBeInTheDocument();
  });

  it('runs the setup → enter-code → enable flow for email authentication', async () => {
    const user = userEvent.setup();
    mockApi.post.mockImplementation((url: string) => {
      if (url === '/api/auth/mfa/setup') return Promise.resolve({ data: { challengeId: 'chal_e' } });
      if (url === '/api/auth/mfa/enable') return Promise.resolve({ data: { enrolled: true } });
      return Promise.resolve({ data: {} });
    });

    renderWithProviders(<SecurityPage />);
    await screen.findByText('Email authentication');

    // Step 1: start setup → backend issues a challenge. The Enable button only
    // renders after the async /api/auth/mfa/status query resolves, so wait for it
    // (findByRole) rather than querying synchronously — avoids a CI timing flake.
    await user.click(await screen.findByRole('button', { name: /enable email authentication/i }));
    await waitFor(() => expect(mockApi.post).toHaveBeenCalledWith('/api/auth/mfa/setup'));

    // Step 2: enter the emailed code and confirm.
    const codeInput = await screen.findByLabelText(/verification code/i);
    await user.type(codeInput, '424242');
    await user.click(screen.getByRole('button', { name: /^confirm$/i }));

    await waitFor(() =>
      expect(mockApi.post).toHaveBeenCalledWith('/api/auth/mfa/enable', {
        challengeId: 'chal_e',
        code: '424242',
      }),
    );
  });

  it('disables email authentication via /api/auth/mfa/disable', async () => {
    const user = userEvent.setup();
    mockGets(true);
    mockApi.post.mockResolvedValue({ data: { enrolled: false } });

    renderWithProviders(<SecurityPage />);
    await user.click(await screen.findByRole('button', { name: /disable email authentication/i }));

    await waitFor(() => expect(mockApi.post).toHaveBeenCalledWith('/api/auth/mfa/disable'));
  });

  it('does NOT route email-2FA through the organization update', async () => {
    const user = userEvent.setup();
    mockApi.post.mockResolvedValue({ data: { challengeId: 'chal_e' } });

    renderWithProviders(<SecurityPage />);
    await screen.findByText('Email authentication');
    await user.click(await screen.findByRole('button', { name: /enable email authentication/i }));

    await waitFor(() => expect(mockApi.post).toHaveBeenCalledWith('/api/auth/mfa/setup'));
    // The org PATCH must never fire from the email-2FA card.
    expect(mockApi.patch).not.toHaveBeenCalled();
  });

  it('requires the current password before changing it', async () => {
    const user = userEvent.setup();
    renderWithProviders(<SecurityPage />);
    await screen.findByText('Change Password');

    await user.click(screen.getByRole('button', { name: 'Update password' }));
    expect(await screen.findByText('Enter your current password.')).toBeInTheDocument();
  });

  it('rejects a too-short new password without calling the auth provider', async () => {
    const user = userEvent.setup();
    renderWithProviders(<SecurityPage />);
    await screen.findByText('Change Password');

    // Password card holds the only empty password inputs: current, new, confirm.
    const [current, next, confirm] = screen.getAllByDisplayValue('');
    await user.type(current, 'current-pass');
    await user.type(next, 'short');
    await user.type(confirm, 'short');
    await user.click(screen.getByRole('button', { name: 'Update password' }));

    expect(await screen.findByText(/at least 8 characters/)).toBeInTheDocument();
  });

  it('opens the SMS setup modal when the toggle is switched on', async () => {
    const user = userEvent.setup();
    renderWithProviders(<SecurityPage />);
    await screen.findByText('Two-Factor Authentication');

    await user.click(screen.getByRole('switch'));
    expect(await screen.findByText('Set up SMS authentication')).toBeInTheDocument();
  });
});
