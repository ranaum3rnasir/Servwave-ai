/**
 * Login & Security > Change Password: eye toggles and autofill hints (password reset spec §6,
 * slice 01). The change itself is covered in SecurityPage.changePassword.test.tsx; this file only
 * checks the fields. Typed values are generated per run, never literals.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import api from '@/lib/axios';
import { useAuthStore } from '@/stores/auth.store';
import { renderWithProviders } from '@/__tests__/helpers';
import SecurityPage from '@/pages/v2/settings/SecurityPage';

const typedValue = () => `t-${Math.random().toString(36).slice(2, 14)}`;

const FIELDS = [
  [/^Current password/, 'sec-current-password', 'current-password'],
  [/^New password/, 'sec-new-password', 'new-password'],
  [/^Confirm new password/, 'sec-confirm-password', 'new-password'],
] as const;

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(api.post).mockResolvedValue({ data: { message: 'Password updated' } });
  vi.mocked(api.get).mockImplementation((url: string) =>
    Promise.resolve({ data: url.includes('mfa/status') ? { enrolled: false } : { mfa_sms_enabled: false } }),
  );
  const state = { user: { email: 'me@test.com' } };
  vi.mocked(useAuthStore).mockImplementation(((selector?: (s: unknown) => unknown) =>
    selector ? selector(state) : state) as unknown as typeof useAuthStore);
});

/** The form shows once the page knows the user has a password (a placeholder stands in until then). */
async function renderPage() {
  renderWithProviders(<SecurityPage />);
  await screen.findByLabelText(/^Current password/);
}

describe('Change Password card eye toggles', () => {
  it('gives each field its own eye and the right autocomplete hint', async () => {
    await renderPage();
    for (const [label, id, autocomplete] of FIELDS) {
      const input = screen.getByLabelText(label);
      expect(input).toHaveAttribute('id', id);
      expect(input).toHaveAttribute('type', 'password');
      expect(input).toHaveAttribute('autocomplete', autocomplete);
    }
    const eyes = screen.getAllByRole('button', { name: 'Show password' });
    expect(eyes.map((b) => b.getAttribute('aria-controls'))).toEqual(FIELDS.map(([, id]) => id));
  });

  it('revealing a field does not start a password change', async () => {
    const user = userEvent.setup();
    await renderPage();
    await user.click(screen.getAllByRole('button', { name: 'Show password' })[1] as HTMLElement);
    expect(screen.getByLabelText(/^New password/)).toHaveAttribute('type', 'text');
    expect(api.post).not.toHaveBeenCalled();
  });

  it('every field is hidden again after a successful change', async () => {
    const user = userEvent.setup();
    const next = typedValue();
    await renderPage();
    await user.type(screen.getByLabelText(/^Current password/), typedValue());
    await user.type(screen.getByLabelText(/^New password/), next);
    await user.type(screen.getByLabelText(/^Confirm new password/), next);
    for (const eye of screen.getAllByRole('button', { name: 'Show password' })) await user.click(eye);
    expect(screen.getAllByRole('button', { name: 'Hide password' })).toHaveLength(3);

    await user.click(screen.getByRole('button', { name: 'Update password' }));

    await waitFor(() => expect(api.post).toHaveBeenCalledWith('/api/users/me/password', expect.anything()));
    await waitFor(() => expect(screen.getAllByRole('button', { name: 'Show password' })).toHaveLength(3));
    for (const [label] of FIELDS) {
      expect(screen.getByLabelText(label)).toHaveAttribute('type', 'password');
    }
  });

  it('a failed change leaves the fields as the user set them', async () => {
    const user = userEvent.setup();
    vi.mocked(api.post).mockRejectedValue({ response: { status: 400, data: { error: 'Current password is incorrect.' } } });
    const next = typedValue();
    await renderPage();
    await user.type(screen.getByLabelText(/^Current password/), typedValue());
    await user.type(screen.getByLabelText(/^New password/), next);
    await user.type(screen.getByLabelText(/^Confirm new password/), next);
    await user.click(screen.getAllByRole('button', { name: 'Show password' })[1] as HTMLElement);

    await user.click(screen.getByRole('button', { name: 'Update password' }));

    expect(await screen.findByText('Current password is incorrect.')).toBeInTheDocument();
    expect(screen.getByLabelText(/^New password/)).toHaveAttribute('type', 'text');
  });
});
