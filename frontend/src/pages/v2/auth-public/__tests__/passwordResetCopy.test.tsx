/**
 * No vendor name on the forgot and reset pages, in any state (CLAUDE.md; password reset spec §5.1,
 * conductor brief §3.7). The email's copy is checked in backend/src/__tests__/password-reset-email.test.ts.
 *
 * Seam: everything a user can read or a screen reader announces - text, placeholders, labels, titles.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import api from '@/lib/axios';
import { renderWithProviders } from '@/__tests__/helpers';
import ForgotPasswordPage from '@/pages/v2/auth-public/ForgotPasswordPage';
import ResetPasswordPage from '@/pages/v2/auth-public/ResetPasswordPage';

const VENDOR = /\b(supabase|gotrue|resend|render|vercel|sentry|ctm|calltrackingmetrics|stripe)\b/i;

/** The page as a user meets it: visible text plus the attributes that are read out or shown. */
function visibleCopy(): string {
  const attrs = Array.from(document.body.querySelectorAll('*')).flatMap((el) =>
    ['placeholder', 'aria-label', 'title', 'alt', 'aria-description'].map((a) => el.getAttribute(a) ?? ''),
  );
  return [document.body.textContent ?? '', ...attrs, document.title].join(' | ');
}

beforeEach(() => {
  vi.clearAllMocks();
  window.history.replaceState(null, '', '/');
});

describe('no vendor name on the password reset pages', () => {
  it('forgot page: form, confirmation and failure', async () => {
    const user = userEvent.setup();
    vi.mocked(api.post).mockResolvedValueOnce({ data: { ok: true } });
    const { unmount } = renderWithProviders(<ForgotPasswordPage />, { initialEntries: ['/forgot-password?email=dana%40example.test'] });
    expect(visibleCopy()).not.toMatch(VENDOR);

    await user.click(screen.getByRole('button', { name: 'Send reset link' }));
    await screen.findByRole('status');
    expect(visibleCopy()).not.toMatch(VENDOR);
    unmount();

    vi.mocked(api.post).mockRejectedValueOnce(new Error('Network Error'));
    renderWithProviders(<ForgotPasswordPage />, { initialEntries: ['/forgot-password?email=dana%40example.test'] });
    await user.click(screen.getByRole('button', { name: 'Send reset link' }));
    await screen.findByRole('alert');
    expect(visibleCopy()).not.toMatch(VENDOR);
  });

  it('reset page: form, a refused password, and the invalid link', async () => {
    const user = userEvent.setup();
    const pw = Math.random().toString(36).slice(2) + 'Aa1!';
    const { unmount } = renderWithProviders(<ResetPasswordPage />, { initialEntries: ['/reset-password?token=t'] });
    expect(visibleCopy()).not.toMatch(VENDOR);

    vi.mocked(api.post).mockRejectedValueOnce({ response: { status: 400, data: { error: "We couldn't update your password. Try again or contact ServWave support." } } });
    await user.type(screen.getByLabelText('New password'), pw);
    await user.type(screen.getByLabelText('Confirm new password'), pw);
    await user.click(screen.getByRole('button', { name: 'Update password' }));
    await screen.findByRole('alert');
    expect(visibleCopy()).not.toMatch(VENDOR);
    unmount();

    renderWithProviders(<ResetPasswordPage />, { initialEntries: ['/reset-password'] });
    expect(screen.getByRole('button', { name: 'Send a new link' })).toBeInTheDocument();
    expect(visibleCopy()).not.toMatch(VENDOR);
  });
});
